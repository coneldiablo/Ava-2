#!/usr/bin/env python3
"""Run on production host: aggregates only, no customer text or identifiers."""
import collections
from datetime import datetime, timezone
import json
import re
import subprocess


def docker(*args):
    return subprocess.run(['docker', *args], capture_output=True, text=True, check=True).stdout

report = {'level': 'production_readonly', 'observed_at_utc': datetime.now(timezone.utc).isoformat(), 'customer_acceptance': 'NOT_TESTED'}
info = json.loads(docker('inspect', 'ai_engine'))[0]
report['engine'] = { 'image': info['Image'], 'running': info['State']['Running'], 'restarts': info['RestartCount'] }
logs = subprocess.run(['docker', 'logs', '--since', '24h', '--tail', '30000', 'ai_engine'], capture_output=True, text=True)
lines = re.sub(r'\x1b\[[0-9;]*m', '', logs.stdout + logs.stderr).splitlines()
report['log_window'] = {'hours': 24, 'max_lines': 30000, 'observed_lines': len(lines)}
report['events'] = {name: sum(name in line for line in lines) for name in (
    'Neuro Gemini turn started', 'Neuro Gemini turn timing', 'Neuro Gemini turn cancelled', 'Neuro Gemini turn failed',
    'Neuro Gemini model request', 'Neuro Gemini tool started', 'Neuro Gemini tool completed',
    'AudioSocket connection accepted', 'AudioSocket client closed connection', 'AudioSocket connection error',
    'Call history record saved', 'Call cleanup completed')}
latencies = collections.defaultdict(list)
for line in lines:
    if 'Neuro Gemini turn timing' not in line:
        continue
    for field in ('first_model_text_at_ms', 'first_pcm_at_ms', 'first_audio_emitted_at_ms'):
        match = re.search(r'["\']?' + field + r'["\']?\s*[:=]\s*["\']?([0-9.]+)', line)
        if match:
            latencies[field].append(float(match.group(1)))
report['stage_latency_ms'] = {k: {'n': len(v), 'p50': sorted(v)[len(v)//2], 'p95': sorted(v)[min(len(v)-1,int(len(v)*.95))], 'max': max(v)} for k,v in latencies.items()}
report['fixed_failure_codes'] = dict(collections.Counter(m.group(1) for line in lines if 'Neuro Gemini turn failed' in line
    for m in [re.search(r'error_code["\']?\s*[:=]\s*["\']?([a-z_]{1,64})', line)] if m))
report['stats'] = docker('stats', '--no-stream', '--format', '{{json .}}', 'ai_engine', 'whatsapp_crm', 'admin_ui', 'whatsapp_crm_openwa').splitlines()
db_probe = '''import sqlite3,json
c=sqlite3.connect("file:/app/data/call_history.db?mode=ro",uri=True)
r={}
r["total"]=c.execute("select count(*) from call_records").fetchone()[0]
r["last24h"]=c.execute("select count(*) from call_records where datetime(start_time)>=datetime('now','-24 hours')").fetchone()[0]
rows=c.execute("select outcome,duration_seconds,total_turns,avg_turn_latency_ms,max_turn_latency_ms,conversation_history,tool_calls,error_message from call_records order by start_time desc limit 30").fetchall()
r["sample_size"]=len(rows)
r["last24h_outcomes"]={str(x[0]) if x[0] in ('completed','abandoned','error') else 'other':x[1] for x in c.execute("select outcome,count(*) from call_records where datetime(start_time)>=datetime('now','-24 hours') group by outcome")}
r["error_categories"]={}
for x in rows:
 if not x[7]:continue
 text=str(x[7]).lower()
 key=next((v for v in ('timeout','quota','rate_limit','auth','disconnect','startup','speech','provider','connection','cancel') if v in text),'unclassified')
 r["error_categories"][key]=r["error_categories"].get(key,0)+1
r["outcomes"]={}
r["with_history"]=sum(bool(x[5] and x[5] not in ('[]','null','{}')) for x in rows)
r["with_tools"]=sum(bool(x[6] and x[6] not in ('[]','null','{}')) for x in rows)
r["with_error"]=sum(bool(x[7]) for x in rows)
for x in rows:
 k=x[0] if x[0] in ('completed','failed','transferred','abandoned','timeout','error','hangup','unknown','cancelled','answered','no_answer','busy') else 'other_or_null'
 r["outcomes"][k]=r["outcomes"].get(k,0)+1
for i,name in [(1,'duration_seconds'),(2,'turns'),(3,'avg_turn_latency_ms'),(4,'max_turn_latency_ms')]:
 v=sorted(float(x[i]) for x in rows if x[i] is not None)
 r[name]={"n":len(v),"p50":v[len(v)//2] if v else None,"p95":v[min(len(v)-1,int(len(v)*.95))] if v else None,"max":max(v) if v else None}
print(json.dumps(r))'''
report['recent_history'] = json.loads(docker('exec', 'ai_engine', 'python', '-c', db_probe))
crm_probe = """const d=require('better-sqlite3')('/app/data/crm_v2.db',{readonly:true,fileMustExist:true});
const r={};
const events=d.prepare("SELECT eventId,instanceId,chatId,callId,content FROM conversation_events WHERE sourceId LIKE 'post_call:%' ORDER BY createdAt DESC LIMIT 30").all();
r.sample_size=events.length;r.with_summary=events.filter(e=>Boolean(e.content)).length;
r.with_client=0;r.with_task=0;r.with_followup=0;r.with_post_call_decision=0;r.tasks_without_matching_event=0;
for(const e of events){
 r.with_client+=Number(Boolean(d.prepare('SELECT 1 FROM clients WHERE instanceId=? AND chatId=?').get(e.instanceId,e.chatId)));
 r.with_task+=Number(Boolean(d.prepare('SELECT 1 FROM manager_tasks WHERE instanceId=? AND chatId=? AND callId=?').get(e.instanceId,e.chatId,e.callId)));
 r.with_followup+=Number(Boolean(d.prepare('SELECT 1 FROM followup_drafts WHERE instanceId=? AND chatId=? AND callId=?').get(e.instanceId,e.chatId,e.callId)));
 r.with_post_call_decision+=Number(Boolean(d.prepare("SELECT 1 FROM ml_decisions WHERE instanceId=? AND chatId=? AND taskType='post_call' AND json_valid(outputJson) AND json_extract(outputJson,'$.note.event_id')=?").get(e.instanceId,e.chatId,e.eventId)));
}
r.tasks_without_matching_event=d.prepare("SELECT count(*) n FROM manager_tasks t WHERE t.callId IS NOT NULL AND t.callId<>'' AND NOT EXISTS (SELECT 1 FROM conversation_events e WHERE e.instanceId=t.instanceId AND e.chatId=t.chatId AND e.callId=t.callId AND e.sourceId='post_call:'||t.callId)").get().n;
r.unmatched_task_breakdown=d.prepare("SELECT count(*) total, sum(CASE WHEN EXISTS(SELECT 1 FROM clients c WHERE c.instanceId=t.instanceId AND c.chatId=t.chatId) THEN 1 ELSE 0 END) with_client, sum(CASE WHEN EXISTS(SELECT 1 FROM conversation_events e WHERE e.instanceId=t.instanceId AND e.chatId=t.chatId AND e.callId=t.callId) THEN 1 ELSE 0 END) with_any_call_event, sum(CASE WHEN EXISTS(SELECT 1 FROM conversation_events e WHERE e.instanceId=t.instanceId AND e.chatId=t.chatId AND e.eventId=t.conversationEventId) THEN 1 ELSE 0 END) with_explicit_event, sum(CASE WHEN datetime(t.createdAt)>=datetime('now','-24 hours') THEN 1 ELSE 0 END) last24h FROM manager_tasks t WHERE t.callId IS NOT NULL AND t.callId<>'' AND NOT EXISTS (SELECT 1 FROM conversation_events e WHERE e.instanceId=t.instanceId AND e.chatId=t.chatId AND e.callId=t.callId AND e.sourceId='post_call:'||t.callId)").get();
console.log(JSON.stringify(r));"""
try:
    report['crm_post_call_sample'] = json.loads(docker('exec', 'whatsapp_crm', 'node', '-e', crm_probe))
except Exception as exc:
    report['crm_post_call_probe_failure'] = type(exc).__name__
print(json.dumps(report))
