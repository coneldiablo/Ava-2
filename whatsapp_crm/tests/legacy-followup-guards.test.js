'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const FollowUp=require('../src/services/followup.service');
const Router=require('../src/services/channel-router.service');
const Workspace=require('../src/services/ava-workspace.store');
const Canonical=require('../src/services/client-identity.service');
const Gateway=require('../src/services/whatsapp-gateway.service');
const OpenWA=require('../src/services/openwa.service');
const Logger=require('../src/utils/logger');
async function fixture(fn) {
    const undo=[];
    const patch=(object,key,value)=>{const old=object[key];undo.push(()=>object[key]=old);object[key]=value;};
    for(const key of ['info','warn','error'])patch(Logger,key,()=>{});
    createTestDB();Router.whatsappStateCache.clear();
    const instance=await DB.createInstance({name:'Legacy followup fixture',openWaSessionId:'fixture-session'});
    await DB.updateInstance(instance.id,{isActive:1,followUpEnabled:1,followUpDelay:48,followUpText:'Fixture reminder',openWaSessionId:'fixture-session'});
    const client=await DB.getOrCreateClient(instance.id,'customer','Fixture');
    Canonical.attach(instance.id,client.chatId,{kind:'whatsapp',value:'79990000001@c.us'});
    DB.run("UPDATE clients SET lastMessageTime=datetime('now','-3 days') WHERE instanceId=? AND chatId=?",[instance.id,client.chatId]);
    let sends=0;
    patch(Gateway,'getState',async()=>({success:true,effectiveState:'authorized'}));
    patch(OpenWA,'sendMessage',async(_url,_key,_session,recipient)=>{sends++;assert.strictEqual(recipient,'79990000001@c.us');return {success:true,data:{idMessage:'fixture-ack-'+sends}};});
    const send=()=>FollowUp._sendFollowUp(instance,client,'Fixture reminder');
    try {await fn({instance,client,send,patch,sends:()=>sends});}
    finally {Router.whatsappStateCache.clear();for(const restore of undo.reverse())restore();}
}

describe('Legacy scheduled followup shared channel guards',()=>{
    it('uses the canonical linked recipient, stores one history row, and scopes completion to its tenant',async()=>fixture(async({instance,client,send,sends})=>{
        const other=await DB.createInstance({name:'Other fixture'});await DB.getOrCreateClient(other.id,client.chatId,'Other');
        await send();await send();
        assert.strictEqual(sends(),1);
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='assistant'").n,1);
        assert.strictEqual(DB.get('SELECT messageType FROM messages').messageType,'followup');
        assert.ok(DB.get('SELECT followUpSentAt FROM clients WHERE instanceId=? AND chatId=?',[instance.id,client.chatId]).followUpSentAt);
        assert.strictEqual(DB.get('SELECT followUpSentAt FROM clients WHERE instanceId=? AND chatId=?',[other.id,client.chatId]).followUpSentAt,null);
        assert.strictEqual(Workspace.getControl(instance.id,client.chatId).sendInProgress,undefined);
    }));
    it('blocks existing human takeover and revalidates takeover after awaited gateway preparation',async()=>fixture(async({instance,client,send,sends,patch})=>{
        Workspace.setControl({businessId:instance.id,chatId:client.chatId,mode:'human'});await send();
        assert.strictEqual(sends(),0);
        Workspace.setControl({businessId:instance.id,chatId:client.chatId,mode:'ai'});
        patch(Gateway,'getState',async()=>{Workspace.setControl({businessId:instance.id,chatId:client.chatId,mode:'human'});return {success:true,effectiveState:'authorized'};});
        await send();assert.strictEqual(sends(),0);
        assert.strictEqual(DB.get('SELECT state FROM legacy_followup_actions').state,'failed');
        assert.strictEqual(Workspace.getControl(instance.id,client.chatId).sendInProgress,undefined);
    }));
    it('cancels a stale reminder when a new inbound arrives before dispatch',async()=>fixture(async({instance,client,send,sends,patch})=>{
        patch(Gateway,'getState',async()=>{await DB.saveMessage(instance.id,client.chatId,'Fixture','New question','user');return {success:true,effectiveState:'authorized'};});
        await send();assert.strictEqual(sends(),0);
        assert.strictEqual(DB.get('SELECT state FROM legacy_followup_actions').state,'failed');
    }));
    it('does not bypass a newly activated policy or a disabled legacy followup setting',async()=>{
        for(const change of ['policy','disabled'])await fixture(async({instance,send,sends,patch})=>{
            patch(Gateway,'getState',async()=>{
                if(change==='policy')DB.run('INSERT INTO ava_autopilot_policies(businessId,revision,payloadJson,ownerUserId,updatedAt) VALUES(?,1,?,?,?)',
                    [instance.id,JSON.stringify({activated:true,enabled:false}),'fixture-owner',new Date().toISOString()]);
                else DB.run('UPDATE instances SET followUpEnabled=0 WHERE id=?',[instance.id]);
                return {success:true,effectiveState:'authorized'};
            });
            await send();assert.strictEqual(sends(),0);
            assert.strictEqual(DB.get('SELECT state FROM legacy_followup_actions').state,'failed');
        });
    });
    it('keeps an ambiguous send durable and fenced across restart and repeated scheduling',async()=>fixture(async({instance,client,send,patch})=>{
        let attempts=0;patch(OpenWA,'sendMessage',async()=>{attempts++;return {success:false,safeToRetry:false,code:'WHATSAPP_SEND_ACK_UNKNOWN'};});
        await send();await send();FollowUp._running=false;
        DB.run('UPDATE legacy_followup_actions SET leaseUntil=0');await FollowUp._checkInstance(await DB.getInstance(instance.id));
        assert.strictEqual(attempts,1);assert.strictEqual(DB.get('SELECT state FROM legacy_followup_actions').state,'unknown');
        assert.strictEqual(Workspace.getControl(instance.id,client.chatId).sendStatus,'unknown');
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='assistant'").n,0);
    }));
    it('repairs a crash after provider ACK without another dispatch or duplicate history',async()=>fixture(async({instance,client,send,sends,patch})=>{
        const complete=FollowUp._complete;patch(FollowUp,'_complete',()=>{throw new Error('fixture crash after ACK');});
        await send();assert.strictEqual(sends(),1);
        assert.strictEqual(DB.get('SELECT state FROM legacy_followup_actions').state,'unknown');
        patch(FollowUp,'_complete',complete);await FollowUp._checkInstance(await DB.getInstance(instance.id));await send();
        assert.strictEqual(sends(),1);assert.strictEqual(DB.get('SELECT state FROM legacy_followup_actions').state,'sent');
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='assistant'").n,1);
        assert.ok(DB.get('SELECT followUpSentAt FROM clients WHERE instanceId=? AND chatId=?',[instance.id,client.chatId]).followUpSentAt);
        assert.strictEqual(Workspace.getControl(instance.id,client.chatId).sendInProgress,undefined);
    }));
    it('serializes two independent schedulers before provider work and retries only definite no-send',async()=>fixture(async({send,sends,patch})=>{
        await Promise.all([send(),send()]);assert.strictEqual(sends(),1);
    }));
    it('retries a proven-unsent failure with the same durable action',async()=>fixture(async({send,patch})=>{
        let attempts=0;patch(OpenWA,'sendMessage',async()=>{attempts++;return attempts===1 ? {success:false,safeToRetry:true,code:'FIXTURE_NOT_SENT'} : {success:true,data:{idMessage:'retry-ack'}};});
        await send();const first=DB.get('SELECT * FROM legacy_followup_actions');
        assert.strictEqual(first.state,'failed');DB.run('UPDATE legacy_followup_actions SET nextAt=0');
        await send();const last=DB.get('SELECT * FROM legacy_followup_actions');
        assert.strictEqual(attempts,2);assert.strictEqual(last.id,first.id);assert.strictEqual(last.state,'sent');
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='assistant'").n,1);
    }));
});
