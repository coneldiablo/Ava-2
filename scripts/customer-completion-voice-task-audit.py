#!/usr/bin/env python3
"""Production READONLY: apply exact local reconciliation rules, emit counts only."""
import json
from pathlib import Path
import subprocess

root=Path(__file__).resolve().parents[1]
source=(root/'whatsapp_crm/src/services/telephony/call-reconciliation.js').read_text()
script='''console.log=()=>{};console.warn=()=>{};console.error=()=>{};
const Module=require('module');
const DB=require('/app/src/services/database.service');
DB.db=require('better-sqlite3')('/app/data/crm_v2.db',{readonly:true,fileMustExist:true});
const m=new Module('/app/src/services/telephony/call-reconciliation.js',module);
m.filename='/app/src/services/telephony/call-reconciliation.js';m.paths=module.paths;
m._compile(SOURCE,m.filename);
const tasks=DB.all("SELECT t.* FROM manager_tasks t WHERE t.callId IS NOT NULL AND t.callId<>'' AND NOT EXISTS (SELECT 1 FROM conversation_events e WHERE e.instanceId=t.instanceId AND e.chatId=t.chatId AND e.callId=t.callId AND e.sourceId='post_call:'||t.callId)");
const reasons={};let withStableCustomer=0,withBusiness=0,withoutChat=0;
for(const t of tasks){
 const plan=m.exports.inspect(Number(t.instanceId),t.callId).find(p=>p.taskId===t.taskId);
 const key=plan?.reason||'invalid_scope';reasons[key]=(reasons[key]||0)+1;
 if(t.customerId&&/^crm_[0-9]+_[0-9]+$/.test(t.customerId))withStableCustomer++;
 if(DB.get('SELECT id FROM instances WHERE id=?',[t.instanceId]))withBusiness++;
 if(!t.chatId)withoutChat++;
}
DB.db.close();process.stdout.write(JSON.stringify({mode:'readonly',taskRows:tasks.length,reasons,withStableCustomer,withBusiness,withoutChat,mutated:false})+'\\n');
'''.replace('SOURCE',json.dumps(source))
raise SystemExit(subprocess.run(['ssh','-i','/Users/developer/.ssh/ava-deploy-ed25519','-o','BatchMode=yes','root@203.0.113.10','docker exec -i whatsapp_crm node -'],input=script,text=True).returncode)
