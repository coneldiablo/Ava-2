"""Canonical CRM schema, not invented clientId/profileJson/call_records fields."""
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from src.core.onyx_customer_context import CustomerContextManager, MEMORY_POLICY_VERSION

NOW = datetime(2026,9,7,0,0,tzinfo=timezone.utc)


@pytest.fixture
def customer_context_db(tmp_path):
    path = str(tmp_path/'context.db')
    with sqlite3.connect(path) as conn:
        conn.executescript('''
            CREATE TABLE instances(id INTEGER PRIMARY KEY,name TEXT,isActive INTEGER,hotelTimezone TEXT);
            CREATE TABLE clients(id INTEGER PRIMARY KEY,instanceId INTEGER,chatId TEXT,senderName TEXT,leadStatus TEXT,tags TEXT,
                preferredChannel TEXT,detectedLanguage TEXT,createdAt TEXT,updatedAt TEXT,lastMessage TEXT);
            CREATE TABLE client_profiles(id INTEGER PRIMARY KEY,instanceId INTEGER,chatId TEXT,needs TEXT,budget TEXT,objections TEXT,
                interests TEXT,communicationStyle TEXT,decisionSpeed TEXT,lastProfileUpdate TEXT,rawProfileJson TEXT);
            CREATE TABLE messages(id INTEGER PRIMARY KEY,instanceId INTEGER,chatId TEXT,senderName TEXT,content TEXT,role TEXT,timestamp TEXT);
            CREATE TABLE conversation_events(eventId TEXT PRIMARY KEY,instanceId INTEGER,chatId TEXT,role TEXT,content TEXT,callId TEXT,metadataJson TEXT,createdAt TEXT);
            CREATE TABLE ml_decisions(decisionId TEXT PRIMARY KEY,instanceId INTEGER,chatId TEXT,taskType TEXT,outputJson TEXT,createdAt TEXT);
            CREATE TABLE customer_identity_links(instanceId INTEGER,customerId TEXT,chatId TEXT,normalizedPhone TEXT,linkType TEXT,confidence TEXT);
            CREATE TABLE pms_integrations(businessId INTEGER,provider TEXT,enabled INTEGER,externalHotelId TEXT,lastSyncAt TEXT);
            CREATE TABLE pms_bookings(businessId INTEGER,provider TEXT,externalHotelId TEXT,externalBookingId TEXT,bookingNumber TEXT,
                normalizedPhone TEXT,normalizedEmail TEXT,statusName TEXT,statusCode TEXT,arrivalAt TEXT,departureAt TEXT,roomTypeName TEXT,
                tariffName TEXT,amount REAL,currency TEXT,sourceTimestamp TEXT,rawSafeJson TEXT);
            INSERT INTO instances VALUES(1,'Alpha',1,'Europe/Moscow'),(2,'Beta',1,'UTC');
        ''')
        for business,customer,name in [(1,101,'Елена Alpha'),(2,202,'Елена Beta')]:
            chat = '79991112233@c.us'
            conn.execute('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?,?,?)',(customer,business,chat,name,'qualified','["vip","family"]','whatsapp','ru','2026-09-01','2026-09-07','RAW_LAST_MESSAGE_SECRET'))
            raw = {'importantDates':['10–15 сентября'],'keyFacts':[f'{name}: семья с ребенком','Последний чат: RAW_CHAT_SECRET'],
                   'lastCallSummary':'RAW_LEGACY_TRANSCRIPT','unknownSecret':'IGNORED_RAW_JSON_SECRET','interestSignals':['трансфер']}
            conn.execute('INSERT INTO client_profiles VALUES(?,?,?,?,?,?,?,?,?,?,?)',(business,business,chat,'Семейный отдых','50000','["стоимость дополнительного места"]',json.dumps(['люкс' if business==1 else 'стандарт']),'formal','medium','2026-09-07',json.dumps(raw)))
            conn.execute('INSERT INTO messages VALUES(?,?,?,?,?,?,?)',(business,business,chat,name,'RAW_MESSAGE_SECRET','user','2026-09-06T22:00:00Z'))
            meta={'summary_provenance':'provided_summary','call_direction':'inbound','outcome':'interested','duration_seconds':145,'next_step':'Подготовить предложение'}
            conn.execute('INSERT INTO conversation_events VALUES(?,?,?,?,?,?,?,?)',(f'event-{business}',business,chat,'manager_note',f'Гость {name} уточнил условия семейного отдыха.',f'call-{business}',json.dumps(meta),'2026-09-06T23:00:00Z'))
            conn.execute('INSERT INTO ml_decisions VALUES(?,?,?,?,?,?)',(f'decision-{business}',business,chat,'post_call',json.dumps({'next_action':{'action_type':'draft_followup','priority':'high','message':'Подготовить предложение'},'transcript':'RAW_DECISION_SECRET'}),'2026-09-06T23:01:00Z'))
            conn.execute('INSERT INTO pms_integrations VALUES(?,?,?,?,?)',(business,'bnovo',1,f'hotel-{business}','2026-09-06T23:59:00Z'))
            conn.execute('INSERT INTO pms_bookings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(business,'bnovo',f'hotel-{business}',f'booking-{business}',f'B-{business}','79991112233','PRIVATE_EMAIL@example.test','Подтверждена','confirmed','2026-09-10','2026-09-15','Люкс' if business==1 else 'Стандарт','Завтрак',50000,'RUB','2026-09-06T23:59:00Z','RAW_BOOKING_SECRET'))
        conn.execute('INSERT INTO conversation_events VALUES(?,?,?,?,?,?,?,?)',('legacy',1,'79991112233@c.us','manager_note','RAW_LEGACY_TRANSCRIPT','call-legacy','{}','2026-09-06T23:02:00Z'))
    return path


def manager(path):
    return CustomerContextManager(path,now=lambda:NOW)


def add_generated_memory(path):
    with sqlite3.connect(path) as conn:
        conn.executescript('''
            CREATE TABLE crm_memory_summaries(summaryId TEXT,instanceId INTEGER,chatId TEXT,kind TEXT,
                summaryJson TEXT,sourceHash TEXT,sourceUpdatedAt TEXT,generatedAt TEXT,sourceComplete INTEGER,promptVersion TEXT);
            CREATE TABLE crm_memory_jobs(instanceId INTEGER,chatId TEXT,kind TEXT,state TEXT,sourceHash TEXT);
        ''')
        for business in (1,2):
            value={'domain':'standard','relevance':'relevant','summary':f'Краткая память гостя только отеля {business}.','needs':f'Потребность {business}',
                'budget':None,'interests':['тихий номер'],'objections':[],'dates':['10 сентября'],
                'preferences':['вид на сад'],'next_step':'Уточнить число гостей','evidence_ids':['message:1'],
                'raw_messages':'RAW_MUST_NOT_EXPORT'}
            conn.execute('INSERT INTO crm_memory_summaries VALUES(?,?,?,?,?,?,?,?,?,?)',
                (f'summary-{business}',business,'79991112233@c.us','conversation',json.dumps(value),f'hash-{business}',
                 '2026-09-06T23:00:00Z','2026-09-06T23:01:00Z',0,MEMORY_POLICY_VERSION))
        conn.execute('INSERT INTO crm_memory_jobs VALUES(?,?,?,?,?)',(1,'79991112233@c.us','conversation','pending','new-hash'))


def test_generated_summary_uses_only_current_customer_and_marks_pending_updates(customer_context_db):
    add_generated_memory(customer_context_db)
    result=manager(customer_context_db).get_customer_context(1,101)
    memory=result['conversation_summary']
    assert memory['status']=='ai_summary'
    assert memory['provenance']=='ai_generated'
    assert memory['needs']=='Потребность 1'
    assert memory['source_complete'] is False
    assert memory['update_pending'] is True
    assert memory['recommendations_executed'] is False
    assert memory['raw_messages_read'] is False
    assert 'RAW_MUST_NOT_EXPORT' not in json.dumps(result)
    assert 'Потребность 2' not in json.dumps(result,ensure_ascii=False)
    assert result['profile']['needs']=='Потребность 1'
    assert result['profile']['budget'] is None


@pytest.mark.parametrize('mutation', ['version','domain','classification','first_generation'])
def test_ai_memory_refresh_never_falls_back_to_old_personal_facts(customer_context_db,mutation):
    add_generated_memory(customer_context_db)
    with sqlite3.connect(customer_context_db) as conn:
        conn.execute("UPDATE client_profiles SET needs='OLD_PERSONAL_NEEDS',budget='OLD_PERSONAL_BUDGET' WHERE instanceId=1")
        if mutation=='version':
            conn.execute("UPDATE crm_memory_summaries SET promptVersion='crm-memory-v1' WHERE instanceId=1")
        elif mutation=='domain':
            conn.execute('ALTER TABLE instances ADD COLUMN businessType TEXT')
            conn.execute("UPDATE instances SET businessType='hotel' WHERE id=1")
        elif mutation=='classification':
            conn.execute("UPDATE crm_memory_summaries SET summaryJson=? WHERE instanceId=1",(json.dumps({'summary':'OLD_PERSONAL_SUMMARY','domain':'standard'}),))
        else:
            conn.execute('DELETE FROM crm_memory_summaries WHERE instanceId=1')
    result=manager(customer_context_db).get_customer_context(1,101)
    assert result['conversation_summary']['status']==('generation_pending' if mutation=='first_generation' else 'policy_refresh_required')
    assert result['conversation_summary']['summary'] is None
    assert 'OLD_PERSONAL' not in json.dumps(result)


def test_out_of_scope_dto_strips_accidentally_stored_personal_fields(customer_context_db):
    add_generated_memory(customer_context_db)
    with sqlite3.connect(customer_context_db) as conn:
        value={'domain':'standard','relevance':'out_of_scope','summary':'PRIVATE_PERSONAL_SUMMARY',
               'needs':'PRIVATE_PERSONAL_NEEDS','next_step':'PRIVATE_PERSONAL_TASK','interests':['PRIVATE_PERSONAL_PROJECT']}
        conn.execute('UPDATE crm_memory_summaries SET summaryJson=? WHERE instanceId=1',(json.dumps(value),))
    result=manager(customer_context_db).get_customer_context(1,101)
    assert result['conversation_summary']['relevance']=='out_of_scope'
    assert result['conversation_summary']['next_step_recommendation'] is None
    assert result['profile']['interests']==[]
    assert 'PRIVATE_PERSONAL' not in json.dumps(result)


@pytest.mark.parametrize('version,domain,relevance,expected', [
    ('crm-memory-v1','standard','relevant','policy_refresh_required'),
    (MEMORY_POLICY_VERSION,'hotel','relevant','policy_refresh_required'),
    (MEMORY_POLICY_VERSION,'standard','out_of_scope','available'),
    (MEMORY_POLICY_VERSION,'standard','relevant','available'),
])
def test_call_ai_memory_checks_policy_and_never_leaks_suppressed_next_step(customer_context_db,version,domain,relevance,expected):
    with sqlite3.connect(customer_context_db) as conn:
        meta={'summary_provenance':'ai_generated','prompt_version':version,'memory_domain':domain,
              'relevance':relevance,'next_step':'PRIVATE_PERSONAL_TASK'}
        conn.execute('INSERT INTO conversation_events VALUES(?,?,?,?,?,?,?,?)',
            ('ai-call',1,'79991112233@c.us','summary','PRIVATE_PERSONAL_SUMMARY','ai-call',json.dumps(meta),'2026-09-07'))
    result=manager(customer_context_db).get_single_call_summary(1,'ai-call')
    assert result['summary_status']==expected
    if expected=='policy_refresh_required' or relevance=='out_of_scope':
        assert result['next_step'] is None
        assert 'PRIVATE_PERSONAL' not in json.dumps(result)
    else:
        assert result['summary']=='PRIVATE_PERSONAL_SUMMARY'


def test_context_contains_real_profile_calls_bookings_next_step_without_raw_data(customer_context_db):
    path = customer_context_db
    before = Path(path).read_bytes()
    ctx = manager(path).get_customer_context(1,101)
    assert Path(path).read_bytes() == before, 'Read path must not migrate or write DB'
    assert ctx['external_id']=='ava:1:customer:101'
    assert ctx['profile']['name']=='Елена Alpha'
    assert ctx['profile']['budget']=='50000'
    assert ctx['profile']['dates']==['10–15 сентября']
    assert ctx['profile']['interests']==['люкс','трансфер']
    assert ctx['conversation_summary']['message_count']==1
    assert ctx['conversation_summary']['provenance']=='structured_crm_profile'
    assert ctx['conversation_summary']['raw_messages_read'] is False
    calls=ctx['recent_call_summaries']
    assert calls[0]['call_id']=='call-legacy' and calls[0]['summary'] is None
    assert calls[1]['summary']=='Гость Елена Alpha уточнил условия семейного отдыха.'
    assert calls[1]['duration_seconds']==145 and calls[1]['direction']=='inbound'
    assert ctx['next_action']['action_type']=='draft_followup' and ctx['next_action']['executed'] is False
    assert ctx['booking_context']['upcoming_bookings'][0]['booking_number']=='B-1'
    assert ctx['booking_context']['stale'] is False
    assert ctx['booking_context']['live_availability_confirmed'] is False
    serialized=json.dumps(ctx,ensure_ascii=False)
    for forbidden in ['RAW_','IGNORED_','79991112233','PRIVATE_EMAIL','@c.us','chat_id','customer_phone']:
        assert forbidden not in serialized


def test_same_phone_two_hotels_has_distinct_memory_and_pms(customer_context_db):
    m=manager(customer_context_db)
    one,two=m.get_customer_context(1,101),m.get_customer_context(2,202)
    assert 'Елена Beta' not in json.dumps(one,ensure_ascii=False)
    assert 'Елена Alpha' not in json.dumps(two,ensure_ascii=False)
    assert two['profile']['interests'][0]=='стандарт'
    assert two['booking_context']['upcoming_bookings'][0]['booking_number']=='B-2'
    assert m.get_customer_context(1,202) is None and m.get_customer_context(2,101) is None
    assert m.get_single_call_summary(2,'call-1') is None


def test_disabled_and_invalid_scope_denied(customer_context_db):
    m=manager(customer_context_db)
    for business,customer in [(True,101),(1,True),(0,101),('1',101),(1,-1)]:
        assert m.get_customer_context(business,customer) is None
    with sqlite3.connect(customer_context_db) as c:
        c.execute('UPDATE instances SET isActive=0 WHERE id=1')
    assert m.get_customer_context(1,101) is None
    assert m.get_single_call_summary(1,'call-1') is None


def test_no_fabricated_summary_or_call_outcome_for_legacy_events(customer_context_db):
    m=manager(customer_context_db)
    old=m.get_single_call_summary(1,'call-legacy')
    assert old['summary'] is None and old['outcome'] is None and old['next_step'] is None
    assert old['summary_status']=='unverified_legacy'
    assert old['duration_seconds'] is None
    assert m.get_single_call_summary(1,'does-not-exist') is None


def test_profile_missing_does_not_infer_room_interest_from_raw_message(customer_context_db):
    with sqlite3.connect(customer_context_db) as c:
        c.execute('DELETE FROM client_profiles WHERE instanceId=1')
    ctx=manager(customer_context_db).get_customer_context(1,101)
    assert ctx['data_availability']['profile']=='not_available'
    assert ctx['conversation_summary']['summary'] is None
    assert ctx['conversation_summary']['intents']==[]
    assert ctx['conversation_summary']['message_count']==1


def test_stale_or_reconnected_pms_never_confirms_bookings(customer_context_db):
    with sqlite3.connect(customer_context_db) as c:
        c.execute("UPDATE pms_bookings SET sourceTimestamp='2026-08-01' WHERE businessId=1")
    ctx=manager(customer_context_db).get_customer_context(1,101)['booking_context']
    assert ctx['stale'] is True and ctx['upcoming_bookings'][0]['stale'] is True
    assert ctx['has_active_booking'] is None
    with sqlite3.connect(customer_context_db) as c:
        c.execute("UPDATE pms_integrations SET externalHotelId='new-hotel' WHERE businessId=1")
    assert manager(customer_context_db).get_customer_context(1,101)['booking_context']['upcoming_bookings']==[]


@pytest.mark.parametrize('chat',['12345@lid','sip:101@example.test','7999'])
def test_opaque_identity_cannot_trigger_unfiltered_pms_lookup(customer_context_db,chat):
    with sqlite3.connect(customer_context_db) as c:
        c.execute('UPDATE clients SET chatId=? WHERE id=101',(chat,))
    bookings=manager(customer_context_db).get_customer_context(1,101)['booking_context']
    assert bookings['upcoming_bookings']==[] and bookings['status']=='verified_phone_required'


def test_group_is_not_exported_as_one_customer(customer_context_db):
    with sqlite3.connect(customer_context_db) as c:
        c.execute("UPDATE clients SET chatId='123456789012@g.us' WHERE id=101")
    assert manager(customer_context_db).get_customer_context(1,101) is None


def test_only_exact_tenant_and_customer_bound_phone_alias_is_used(customer_context_db):
    with sqlite3.connect(customer_context_db) as c:
        c.execute("UPDATE clients SET chatId='opaque@lid' WHERE id=101")
        c.execute("INSERT INTO customer_identity_links VALUES(1,'crm_1_101','opaque@lid','79991112233','phone','weak')")
    assert manager(customer_context_db).get_customer_context(1,101)['booking_context']['upcoming_bookings']==[]
    with sqlite3.connect(customer_context_db) as c:
        c.execute("UPDATE customer_identity_links SET confidence='manual'")
    assert len(manager(customer_context_db).get_customer_context(1,101)['booking_context']['upcoming_bookings'])==1


def test_redacts_secrets_and_contact_details_in_structured_fields(customer_context_db,monkeypatch):
    monkeypatch.setenv('CURRENT_TEST_API_KEY','known-environment-secret')
    with sqlite3.connect(customer_context_db) as c:
        c.execute('UPDATE client_profiles SET needs=? WHERE instanceId=1',('Трансфер Bearer abc12345 пароль password=unsafe123 https://user:pass@example.test token=badtoken known-environment-secret guest@example.test +79000000000',))
    text=json.dumps(manager(customer_context_db).get_customer_context(1,101),ensure_ascii=False)
    for secret in ['abc12345','unsafe123','user:pass','badtoken','known-environment-secret','guest@example.test','+79000000000']:
        assert secret not in text
    assert 'Трансфер' in text


def test_canceled_bookings_excluded_and_hotel_local_date_used(customer_context_db):
    with sqlite3.connect(customer_context_db) as c:
        c.execute("UPDATE pms_bookings SET statusName='Отменена' WHERE businessId=1")
    assert manager(customer_context_db).get_customer_context(1,101)['booking_context']['upcoming_bookings']==[]
    with sqlite3.connect(customer_context_db) as c:
        c.execute("UPDATE pms_bookings SET statusName='Подтверждена',departureAt='2026-09-06' WHERE businessId=1")
    m=CustomerContextManager(customer_context_db,now=lambda:datetime(2026,9,6,22,30,tzinfo=timezone.utc))
    assert m.get_customer_context(1,101)['booking_context']['upcoming_bookings']==[]
