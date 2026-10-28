'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Identity=require('../src/services/identity/identity-store');
const Workspace=require('../src/services/ava-workspace.service');
const Store=require('../src/services/ava-workspace.store');
const Router=require('../src/services/channel-router.service');
const Gateway=require('../src/services/whatsapp-gateway.service');
const OpenWa=require('../src/services/openwa.service');
describe('Integrated authenticated workspace channel dispatch',()=>{
    it('sends a reserved manager action through actual Router without self-invalidating and records its server action ACK',async()=>{
        createTestDB();Identity.ensureSchema();
        DB.run("INSERT INTO instances(id,name,openWaSessionId) VALUES(1,'Business','fixture-session')");
        DB.run("INSERT INTO ava_users(id,email,displayName) VALUES('manager','manager@example.test','Manager')");
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('manager',1,'manager')");
        DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,'79990000001@c.us','Customer','manager')");
        const env=process.env.AVA_IMPROVEMENTS_BUSINESSES,state=Gateway.getState,send=OpenWa.sendMessage;
        process.env.AVA_IMPROVEMENTS_BUSINESSES='*';let sends=0;
        Gateway.getState=async()=>({success:true,effectiveState:'authorized'});
        OpenWa.sendMessage=async()=>{sends++;return {success:true,data:{idMessage:'exact-provider-ack'}};};
        Router.whatsappStateCache.clear();
        try{
            const auth=Identity.actor('manager'),key='caller-key';
            const result=await Workspace.reply(auth,1,'79990000001@c.us',{text:'Prepared manager reply',idempotencyKey:key});
            assert.strictEqual(result.status,'sent');assert.strictEqual(sends,1);
            const action=DB.get('SELECT * FROM ava_workspace_reply_actions WHERE idempotencyKey=?',[key]);
            assert.ok(action.dispatchStartedAt);assert.strictEqual(action.status,'sent');
            assert.strictEqual(DB.get('SELECT idempotencyKey FROM ava_channel_delivery_evidence').idempotencyKey,action.id);
            assert.strictEqual((await Workspace.reply(auth,1,'79990000001@c.us',{text:'Prepared manager reply',idempotencyKey:key})).status,'sent');
            assert.strictEqual(sends,1);
        }finally{
            Gateway.getState=state;OpenWa.sendMessage=send;Router.whatsappStateCache.clear();
            if(env===undefined)delete process.env.AVA_IMPROVEMENTS_BUSINESSES;else process.env.AVA_IMPROVEMENTS_BUSINESSES=env;
        }
    });
    it('recognizes the previous process incarnation after PID reuse, while current/foreign owners remain fenced',()=>{
        const owner=JSON.parse(Store.replyDispatchOwner());
        assert.strictEqual(Store.abandonedReplyDispatch({dispatchOwnerJson:JSON.stringify(owner)}),false);
        assert.strictEqual(Store.abandonedReplyDispatch({dispatchOwnerJson:JSON.stringify({...owner,processToken:'previous-incarnation'})}),true);
        assert.strictEqual(Store.abandonedReplyDispatch({dispatchOwnerJson:JSON.stringify({...owner,hostname:'another-host',processToken:'previous-incarnation'})}),false);
    });
});
