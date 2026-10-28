"""Privacy-minimized snapshots of the canonical AVA CRM, never raw chat export.

Reads do not create tables, enqueue work or call an LLM. Persisted structured
profile facts and explicitly identified summaries are used as evidence. Missing
or unverified summaries stay missing; a transcript prefix is not a summary.
"""
from __future__ import annotations

import json
import math
import os
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from src.core.onyx_client import redact_onyx_error
from src.core.onyx_db import DEFAULT_DB_PATH, generate_stable_external_id

try:
    _MEMORY_POLICY = json.loads((Path(__file__).resolve().parents[2] / 'whatsapp_crm/src/services/crm-memory-policy.json').read_text())
except (OSError, ValueError):
    _MEMORY_POLICY = {}  # Fail closed for AI memory if its policy is not packaged.
MEMORY_POLICY_VERSION = _MEMORY_POLICY.get('version')
MEMORY_DOMAINS = _MEMORY_POLICY.get('domains', [])
MEMORY_RELEVANCE = {'relevant', 'mixed', 'out_of_scope', 'no_business_facts'}


def _memory_domain(business):
    value = (business or {}).get('businessType')
    return value if value in MEMORY_DOMAINS else 'standard'


def _empty_memory(status):
    return {'summary': None, 'needs': None, 'budget': None, 'intents': [], 'objections': [],
            'dates': [], 'preferences': [], 'next_step_recommendation': None,
            'status': status, 'provenance': 'ai_generated', 'policy_version': MEMORY_POLICY_VERSION,
            'source_complete': False, 'update_pending': True, 'recommendations_executed': False}


def _object(raw):
    try:
        value = json.loads(raw) if isinstance(raw, str) and len(raw) <= 128 * 1024 else raw
    except (ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _text(value, limit=300):
    if not isinstance(value, str) or not value.strip():
        return None
    # These legacy "facts" actually contained verbatim message/transcript excerpts.
    if re.match(r'^\s*(?:последн(?:ий чат|ее сообщение|ий звонок)|last (?:message|chat|call)|transcript)\s*:', value, re.I):
        return None
    value = redact_onyx_error(value[:8000], limit=8000)
    value = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[REDACTED_EMAIL]', value)
    value = re.sub(r'(?<!\w)(?:\+\d[\d ()-]{7,}\d|[78]\s*\(\d{3}\)[\d -]{6,}\d|\d{10,15})(?!\w)', '[REDACTED_PHONE]', value)
    return re.sub(r'\s+', ' ', value).strip()[:limit]


def _texts(value, limit=8, item_limit=160):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            value = [value]
    if not isinstance(value, list):
        return []
    result = []
    for item in value[:50]:
        text = _text(item, item_limit)
        if text and text not in result:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def _phone(value):
    value = str(value or '')
    if '@' in value:
        if not value.endswith(('@c.us', '@s.whatsapp.net')):
            return None  # Groups, opaque LIDs and usernames are not phone numbers.
        value = value.split('@', 1)[0]
    if not re.fullmatch(r'\+?[\d ()-]+', value):
        return None
    value = re.sub(r'\D', '', value)
    if len(value) == 11 and value.startswith('8'):
        value = '7' + value[1:]
    return value if re.fullmatch(r'[1-9][0-9]{7,14}', value) else None


def _date(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except (ValueError, TypeError):
        return None


class CustomerContextManager:
    def __init__(self, db_path=None, *, now=None):
        self.db_path = db_path or os.getenv('DB_PATH') or DEFAULT_DB_PATH
        self.now = now or (lambda: datetime.now(timezone.utc))

    def _connect(self):
        conn = sqlite3.connect(Path(self.db_path).resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA query_only=ON')
        return conn

    @staticmethod
    def _columns(conn, table):
        # Table names are internal constants, never user/model arguments.
        return {row[1] for row in conn.execute(f'PRAGMA table_info({table})')}

    @staticmethod
    def _valid_scope(business_id, customer_id=None):
        return (type(business_id) is int and business_id > 0
                and (customer_id is None or type(customer_id) is int and customer_id > 0))

    def _business(self, conn, business_id):
        if not self._valid_scope(business_id):
            return None
        cols = self._columns(conn, 'instances')
        fields = ['id'] + [field for field in ('hotelTimezone','businessType') if field in cols]
        row = conn.execute(f"SELECT {','.join(fields)} FROM instances WHERE id=? AND isActive=1", (business_id,)).fetchone()
        return dict(row) if row else None

    def get_customer_context(self, business_id, customer_id):
        if not self._valid_scope(business_id, customer_id):
            return None
        with closing(self._connect()) as conn:
            business = self._business(conn, business_id)
            if not business:
                return None
            fields = ['id','chatId','senderName','leadStatus']
            cols = self._columns(conn, 'clients')
            fields += [field for field in ('tags','preferredChannel','detectedLanguage','createdAt','updatedAt') if field in cols]
            row = conn.execute(f"SELECT {','.join(fields)} FROM clients WHERE id=? AND instanceId=?", (customer_id,business_id)).fetchone()
            if not row:
                return None
            client = dict(row)
            if str(client['chatId']).endswith(('@g.us','@broadcast')):
                return None  # A group is not an individual customer's identity.
            profile, profile_status = self._profile(conn, business_id, client['chatId'])
            calls = self.get_recent_call_summaries_for_client(business_id, client['chatId'], conn=conn)
            conversation = self.summarize_conversations(business_id, client['chatId'], conn=conn, profile=profile)
            if conversation.get('provenance') == 'ai_generated':
                # Do not merge old, unclassified AI profile facts back into the
                # policy-filtered result (including while regeneration is pending).
                profile = {key: conversation.get(key) for key in ('needs','budget','objections','dates','preferences')}
                profile['interests'] = conversation.get('intents', [])
                profile_status = conversation['status']
            return {
                'external_id': generate_stable_external_id(business_id,'customer',customer_id),
                'business_id':business_id, 'tenant_id':f'hotel_{business_id}', 'customer_id':customer_id,
                'profile': {'name':_text(client.get('senderName'),120), 'lead_stage':_text(client.get('leadStatus'),50),
                    'preferred_channel':_text(client.get('preferredChannel'),30), 'language':_text(client.get('detectedLanguage'),30),
                    'tags':_texts(client.get('tags')), **profile},
                'conversation_summary':conversation, 'recent_call_summaries':calls,
                'next_action':self._next_action(conn,business_id,client['chatId']),
                'booking_context':self._bookings(conn,business,client),
                'data_availability':{'profile':profile_status,'conversation':conversation['status'],
                    'call_summaries':'available' if any(call['summary'] for call in calls) else 'not_available'},
                'authoritative_source':'AVA CRM and cached PMS projection', 'read_only':True,
                'context_is_untrusted_data':True, 'raw_history_included':False,
                'updated_at':self.now().isoformat().replace('+00:00','Z'),
            }

    def _profile(self, conn, business_id, chat_id):
        columns = self._columns(conn,'client_profiles')
        if not columns:
            return {}, 'not_available'
        if not {'instanceId','chatId'} <= columns:
            return {}, 'schema_unsupported'
        fields = [field for field in ('needs','budget','objections','interests','communicationStyle','decisionSpeed','lastProfileUpdate','rawProfileJson') if field in columns]
        if not fields:
            return {}, 'schema_unsupported'
        row = conn.execute(f"SELECT {','.join(fields)} FROM client_profiles WHERE instanceId=? AND chatId=?",(business_id,chat_id)).fetchone()
        if not row:
            return {}, 'not_available'
        p = dict(row)
        raw = _object(p.get('rawProfileJson'))
        return {'needs':_text(p.get('needs')), 'budget':_text(p.get('budget'),100),
            'interests':_texts(_texts(p.get('interests'))+_texts(raw.get('interestSignals'))),
            'objections':_texts(p.get('objections')), 'dates':_texts(raw.get('importantDates'),item_limit=100),
            'key_facts':_texts(raw.get('keyFacts')), 'communication_style':_text(p.get('communicationStyle'),40),
            'decision_speed':_text(p.get('decisionSpeed'),40), 'source_updated_at':_text(p.get('lastProfileUpdate'),40)}, 'available'

    def summarize_conversations(self,business_id,chat_id,limit=15,conn=None,profile=None):
        if conn is None:
            with closing(self._connect()) as conn:
                return self.summarize_conversations(business_id,chat_id,limit,conn,profile)
        profile = profile if profile is not None else self._profile(conn,business_id,chat_id)[0]
        columns = self._columns(conn,'messages')
        counts = {'message_count':0,'last_message_at':None}
        if {'instanceId','chatId','timestamp'} <= columns:
            row = conn.execute('SELECT COUNT(*) AS message_count,MAX(timestamp) AS last_message_at FROM messages WHERE instanceId=? AND chatId=?',(business_id,chat_id)).fetchone()
            counts = dict(row)
        generated = self._generated_summary(conn,business_id,chat_id)
        if generated:
            return {**counts, **generated, 'raw_messages_read':False}
        parts = [f"Потребность: {profile['needs']}" if profile.get('needs') else None,
                 f"Бюджет: {profile['budget']}" if profile.get('budget') else None]
        for key,label in [('interests','Интересы'),('dates','Даты'),('objections','Возражения')]:
            if profile.get(key):
                parts.append(label+': '+ '; '.join(profile[key][:3]))
        if profile.get('key_facts'):
            parts.append('Известные факты: '+ '; '.join(profile['key_facts'][:3]))
        return {**counts, 'summary':'. '.join(part for part in parts if part)[:1500] or None,
            'intents':profile.get('interests',[]),'status':'profile_facts' if any(parts) else 'not_available',
            'provenance':'structured_crm_profile','raw_messages_read':False}

    def _generated_summary(self,conn,business_id,chat_id):
        required={'instanceId','chatId','kind','summaryId','summaryJson','sourceHash','sourceUpdatedAt','generatedAt','sourceComplete'}
        if not required <= self._columns(conn,'crm_memory_summaries'):
            return None
        policy_field = 'promptVersion' if 'promptVersion' in self._columns(conn,'crm_memory_summaries') else 'NULL AS promptVersion'
        row=conn.execute(f'''SELECT summaryId,summaryJson,sourceHash,sourceUpdatedAt,generatedAt,sourceComplete,{policy_field}
            FROM crm_memory_summaries WHERE instanceId=? AND chatId=? AND kind='conversation'
            ORDER BY generatedAt DESC LIMIT 1''',(business_id,chat_id)).fetchone()
        if not row:
            if {'instanceId','chatId','kind'} <= self._columns(conn,'crm_memory_jobs'):
                pending = conn.execute("SELECT 1 FROM crm_memory_jobs WHERE instanceId=? AND chatId=? AND kind='conversation' LIMIT 1",(business_id,chat_id)).fetchone()
                if pending:
                    return _empty_memory('generation_pending')
            return None
        value=_object(row['summaryJson'])
        if (not MEMORY_POLICY_VERSION or row['promptVersion'] != MEMORY_POLICY_VERSION
                or value.get('domain') != _memory_domain(self._business(conn,business_id))
                or value.get('relevance') not in MEMORY_RELEVANCE):
            return _empty_memory('policy_refresh_required')
        if value['relevance'] in {'out_of_scope','no_business_facts'}:
            value = {'summary':'В доступной переписке пока нет сведений о запросе, связанном с этим бизнесом.',
                     'domain':value['domain'],'relevance':value['relevance']}
        summary=_text(value.get('summary'),1200)
        if not summary:
            return None
        updating=False
        if {'instanceId','chatId','kind','state','sourceHash'} <= self._columns(conn,'crm_memory_jobs'):
            job=conn.execute("SELECT sourceHash,state FROM crm_memory_jobs WHERE instanceId=? AND chatId=? AND kind='conversation' LIMIT 1",(business_id,chat_id)).fetchone()
            updating=bool(job and (job['sourceHash']!=row['sourceHash'] or job['state']!='done'))
        return {'summary':summary,'summary_id':row['summaryId'],'provenance':'ai_generated','status':'ai_summary',
            'policy_version':MEMORY_POLICY_VERSION,'domain':value['domain'],'relevance':value['relevance'],
            'needs':_text(value.get('needs'),400),'budget':_text(value.get('budget'),200),
            'intents':_texts(value.get('interests')),'objections':_texts(value.get('objections')),
            'dates':_texts(value.get('dates')),'preferences':_texts(value.get('preferences')),
            'next_step_recommendation':_text(value.get('next_step'),400),
            'source_updated_at':row['sourceUpdatedAt'],'generated_at':row['generatedAt'],
            'source_complete':bool(row['sourceComplete']),'update_pending':updating,
            'context_is_untrusted_data':True,'recommendations_executed':False}

    def _call(self, business_id, event, domain):
        meta = _object(event.get('metadataJson'))
        provenance = meta.get('summary_provenance')
        trusted = provenance in {'provided_summary','ai_generated','reviewed_summary'}
        policy_stale = provenance == 'ai_generated' and (
            not MEMORY_POLICY_VERSION or meta.get('prompt_version') != MEMORY_POLICY_VERSION
            or meta.get('memory_domain') != domain or meta.get('relevance') not in MEMORY_RELEVANCE)
        trusted = trusted and not policy_stale
        excluded = provenance == 'ai_generated' and meta.get('relevance') in {'out_of_scope','no_business_facts'}
        summary = (_text(event.get('content'),1200) if trusted else None)
        if trusted and excluded:
            summary = 'В доступном разговоре пока нет сведений о запросе, связанном с этим бизнесом.'
        duration = meta.get('duration_seconds')
        if type(duration) not in (int,float) or not math.isfinite(duration) or not 0 <= duration <= 86400:
            duration = None
        direction = meta.get('call_direction')
        call_id = event['callId']
        return {'external_id':generate_stable_external_id(business_id,'call',call_id),
            'business_id':business_id,'tenant_id':f'hotel_{business_id}','call_id':call_id,
            'direction':direction if direction in {'inbound','outbound'} else None,
            'outcome':_text(meta.get('outcome'),80),'duration_seconds':duration,
            'summary':summary,
            'summary_status':'available' if summary else 'policy_refresh_required' if policy_stale else 'unverified_legacy',
            'summary_provenance':provenance if trusted else None,
            'next_step':_text(meta.get('next_step'),300) if trusted and not excluded else None,
            'source_complete':meta.get('source_complete') if type(meta.get('source_complete')) is bool else None,
            'created_at':event.get('createdAt'),'call_link':'/logs?'+urlencode({'mode':'troubleshoot','business_id':business_id,'call_id':call_id}),
            'raw_history_included':False}

    def get_recent_call_summaries_for_client(self,business_id,chat_id,limit=3,conn=None):
        if conn is None:
            with closing(self._connect()) as conn:
                if not self._business(conn,business_id):
                    return []
                return self.get_recent_call_summaries_for_client(business_id,chat_id,limit,conn)
        if not self._columns(conn,'conversation_events'):
            return []
        rows = conn.execute('''SELECT callId,content,metadataJson,createdAt FROM conversation_events
            WHERE instanceId=? AND chatId=? AND callId IS NOT NULL AND role IN ('summary','manager_note')
            ORDER BY createdAt DESC,eventId DESC LIMIT 100''',(business_id,chat_id)).fetchall()
        calls = {}
        domain = _memory_domain(self._business(conn,business_id))
        for row in rows:
            event = dict(row)
            candidate = self._call(business_id,event,domain)
            old = calls.get(event['callId'])
            if not old or not old['summary'] and candidate['summary']:
                calls[event['callId']] = candidate
        return list(calls.values())[:max(1,min(int(limit),20))]

    def get_single_call_summary(self,business_id,call_id):
        if not self._valid_scope(business_id) or not isinstance(call_id,str) or not 1 <= len(call_id) <= 200:
            return None
        with closing(self._connect()) as conn:
            if not self._business(conn,business_id) or not self._columns(conn,'conversation_events'):
                return None
            rows = conn.execute('''SELECT callId,content,metadataJson,createdAt FROM conversation_events
                WHERE instanceId=? AND callId=? AND role IN ('summary','manager_note')
                ORDER BY createdAt DESC,eventId DESC LIMIT 20''',(business_id,call_id)).fetchall()
            domain = _memory_domain(self._business(conn,business_id))
            values = [self._call(business_id,dict(row),domain) for row in rows]
            return next((value for value in values if value['summary']),values[0] if values else None)

    def _next_action(self,conn,business_id,chat_id):
        if not self._columns(conn,'ml_decisions'):
            return None
        rows = conn.execute('''SELECT decisionId,outputJson,createdAt FROM ml_decisions
            WHERE instanceId=? AND chatId=? AND taskType IN ('post_call','next_action')
            ORDER BY createdAt DESC,decisionId DESC LIMIT 10''',(business_id,chat_id)).fetchall()
        for row in rows:
            action = _object(_object(row['outputJson']).get('next_action'))
            if action.get('action_type') in {'send_reply','create_task','ask_question','handoff','draft_followup','schedule_call','wait'}:
                return {'action_type':action['action_type'],'message':_text(action.get('message'),300),
                    'priority':action.get('priority') if action.get('priority') in {'low','normal','high'} else None,
                    'decision_id':row['decisionId'],'created_at':row['createdAt'],'executed':False}
        return None

    def _bookings(self,conn,business,client):
        result = {'provider':'bnovo','status':'not_connected','upcoming_bookings':[],
            'has_active_booking':None,'stale':True,'live_availability_confirmed':False}
        if not self._columns(conn,'pms_integrations') or not self._columns(conn,'pms_bookings'):
            return result
        integration = conn.execute('''SELECT enabled,externalHotelId,lastSyncAt FROM pms_integrations
            WHERE businessId=? AND provider='bnovo' ''',(business['id'],)).fetchone()
        if not integration or not integration['enabled'] or not integration['externalHotelId']:
            return result
        phones = {_phone(client['chatId'])} - {None}
        if self._columns(conn,'customer_identity_links'):
            rows = conn.execute('''SELECT normalizedPhone FROM customer_identity_links WHERE instanceId=?
                AND chatId=? AND customerId=? AND linkType='phone' AND confidence IN ('exact','manual')''',
                (business['id'],client['chatId'],f"crm_{business['id']}_{client['id']}")).fetchall()
            phones |= {_phone(row['normalizedPhone']) for row in rows} - {None}
        if not phones:
            return {**result,'status':'verified_phone_required'}
        try:
            zone = ZoneInfo(business.get('hotelTimezone') or 'UTC')
        except ZoneInfoNotFoundError:
            return {**result,'status':'invalid_hotel_timezone'}
        now = self.now()
        today = now.astimezone(zone).date().isoformat()
        placeholders = ','.join('?' for _ in phones)
        rows = conn.execute(f'''SELECT externalBookingId,bookingNumber,statusName,statusCode,arrivalAt,departureAt,
            roomTypeName,tariffName,amount,currency,sourceTimestamp FROM pms_bookings WHERE businessId=?
            AND provider='bnovo' AND externalHotelId=? AND normalizedPhone IN ({placeholders})
            AND substr(departureAt,1,10)>=? ORDER BY arrivalAt ASC LIMIT 20''',
            (business['id'],integration['externalHotelId'],*sorted(phones),today)).fetchall()
        for row in rows:
            status = row['statusName'] or row['statusCode']
            if re.search(r'cancel|отмен|аннул|no.?show|не.?заезд',str(status),re.I):
                continue
            timestamp = _date(row['sourceTimestamp'])
            stale = timestamp is None or not 0 <= (now-timestamp).total_seconds() <= 900
            result['upcoming_bookings'].append({'booking_id':row['externalBookingId'],'booking_number':row['bookingNumber'],
                'status':_text(status,80),'arrival':row['arrivalAt'],'departure':row['departureAt'],
                'category':_text(row['roomTypeName'],120),'tariff':_text(row['tariffName'],120),
                'amount':row['amount'] if type(row['amount']) in (int,float) and math.isfinite(row['amount']) else None,
                'currency':_text(row['currency'],10),'source_timestamp':row['sourceTimestamp'],'stale':stale})
            if len(result['upcoming_bookings']) == 5:
                break
        sync = _date(integration['lastSyncAt'])
        result.update(status='cached_projection',source_timestamp=integration['lastSyncAt'],
            stale=sync is None or not 0 <= (now-sync).total_seconds() <= 900 or any(item['stale'] for item in result['upcoming_bookings']))
        # A cache can show known bookings; it cannot prove that no other active booking exists.
        return result
