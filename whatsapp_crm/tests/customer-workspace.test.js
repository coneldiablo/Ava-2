const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Identity=require('../src/services/identity/identity-store');
const Access=require('../src/services/identity/customer-access');

function fixture(role='hotel_owner') {
    createTestDB(); Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Own hotel'),(2,'Foreign hotel')");
    DB.run("INSERT INTO clients(instanceId,chatId,senderName,leadStatus) VALUES (1,'same-phone','Own guest','new'),(2,'same-phone','Foreign guest','new')");
    const invitation=Identity.createInvitation({platformRole:'platform_admin'}, {email:'customer@example.test',businessId:1,role});
    const actor = Identity.completeInvitation(Identity.claimInvitation(invitation.token),'customer-test-subject');
    if (role === 'manager') DB.run("UPDATE clients SET assigneeUserId=? WHERE instanceId=1 AND chatId='same-phone'", [actor.userId]);
    return actor;
}

describe('Customer workspace operational access',()=>{
    it('lets only the owning hotel replace or disconnect its WhatsApp binding',async()=>{
        const user=fixture('hotel_owner');
        const Auth=require('../src/services/auth.service');
        const Connection=require('../src/services/whatsapp-connection.service');
        const OpenWa=require('../src/services/openwa.service');
        const app=require('../src/app').app;
        const oldEnabled=Auth.config.enabled,oldCustomer=process.env.AVA_CUSTOMER_ACCESS_ENABLED,oldOrigin=process.env.WHATSAPP_CRM_PUBLIC_URL;
        const originalReplace=Connection.replaceConnection;
        const originalLogout=OpenWa.logout;
        Auth.config.enabled=true;process.env.AVA_CUSTOMER_ACCESS_ENABLED='true';
        await DB.updateInstance(1,{openWaSessionId:'current-binding'});
        const token=Identity.createSession(user.subject,'qa-wa-owner-session');
        const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
        const origin=`http://127.0.0.1:${server.address().port}`;process.env.WHATSAPP_CRM_PUBLIC_URL=origin;
        const headers={Cookie:`crm_session=ava2:${token}`,Origin:origin,'Content-Type':'application/json'};
        let replacements=0;
        let logouts=0;
        Connection.replaceConnection=async(businessId,expected)=>{
            replacements++;assert.strictEqual(businessId,'1');assert.strictEqual(expected,'current-binding');
            return {success:true,type:'pending',session_id:'new-binding'};
        };
        OpenWa.logout=async(_url,_key,sessionId)=>{
            logouts++;assert.strictEqual(sessionId,'current-binding');return {success:true};
        };
        const request=(businessId,body)=>fetch(`${origin}/api/openwa/replace/${businessId}`,{method:'POST',headers,body:JSON.stringify(body)});
        const logout=businessId=>fetch(`${origin}/api/openwa/logout/${businessId}`,{method:'POST',headers});
        try {
            const instanceList=await fetch(`${origin}/api/instances`,{headers});
            assert.strictEqual(instanceList.status,200);
            assert.strictEqual((await instanceList.json()).instances.find(item=>item.id===1).openWaSessionId,'current-binding');
            assert.strictEqual((await request(1,{expected_session_id:'current-binding'})).status,400);
            assert.strictEqual((await request(2,{confirm:true,expected_session_id:'current-binding'})).status,403);
            assert.strictEqual(replacements,0);
            const result=await request(1,{confirm:true,expected_session_id:'current-binding'});
            assert.strictEqual(result.status,200);assert.strictEqual((await result.json()).session_id,'new-binding');
            assert.strictEqual(replacements,1);
            assert.strictEqual((await logout(2)).status,403);
            assert.strictEqual(logouts,0);
            const disconnected=await logout(1);
            assert.strictEqual(disconnected.status,200);assert.strictEqual((await disconnected.json()).success,true);
            assert.strictEqual(logouts,1);
            OpenWa.logout=async()=>({success:false,error:'Bearer should-not-leak'});
            const rejected=await logout(1);
            assert.strictEqual(rejected.status,503);
            assert.strictEqual((await rejected.json()).error,'WHATSAPP_DISCONNECT_UNAVAILABLE');
            OpenWa.logout=async()=>{throw new Error('Bearer should-not-leak');};
            const unavailable=await logout(1);
            assert.strictEqual(unavailable.status,503);
            const unavailableBody=await unavailable.json();
            assert.strictEqual(unavailableBody.error,'WHATSAPP_DISCONNECT_UNAVAILABLE');
            assert.ok(!JSON.stringify(unavailableBody).includes('should-not-leak'));
        } finally {
            Connection.replaceConnection=originalReplace;OpenWa.logout=originalLogout;Auth.config.enabled=oldEnabled;
            if(oldCustomer===undefined)delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;else process.env.AVA_CUSTOMER_ACCESS_ENABLED=oldCustomer;
            if(oldOrigin===undefined)delete process.env.WHATSAPP_CRM_PUBLIC_URL;else process.env.WHATSAPP_CRM_PUBLIC_URL=oldOrigin;
            await new Promise(resolve=>server.close(resolve));
        }
    });
    it('owner and manager can operate their pipeline without gaining admin, deletion or foreign scope',()=>{
        const before=process.env.WHATSAPP_CRM_PUBLIC_URL;
        process.env.WHATSAPP_CRM_PUBLIC_URL='https://ava.example.test';
        try {
            for(const role of ['hotel_owner','manager']) {
                const actor=fixture(role);
                const call=(method,path,params,body={},headers={origin:'https://ava.example.test'})=>{
                    let passed=false,status=200;
                    const req={auth:actor,params,body,headers,query:{}};
                    Access.forRoute(method,path)(req,{status(code){status=code;return this;},json(){}},()=>{passed=true;});
                    return {passed,status,body:req.body};
                };
                for(const [method,path] of [
                    ['put','/clients/:instanceId/:chatId/status'],['put','/clients/:instanceId/:chatId/tags'],
                    ['post','/clients/:instanceId/:chatId/send-message'],['post','/ai/summary/:instanceId/:chatId'],
                    ['post','/ai/next-step/:instanceId/:chatId'],['get','/clients/:instanceId/:chatId/status-history'],
                ]) {
                    assert.ok(call(method,path,{instanceId:'1',chatId:'same-phone'}).passed,`${role} ${path}`);
                    assert.strictEqual(call(method,path,{instanceId:'2',chatId:'same-phone'}).status,403);
                }
                assert.strictEqual(call('put','/clients/:instanceId/:chatId/status',{instanceId:'1',chatId:'same-phone'},{businessId:2}).status,403);
                assert.strictEqual(call('put','/clients/:instanceId/:chatId/status',{instanceId:'1',chatId:'unknown'}).status,404);
                assert.strictEqual(call('post','/clients/:instanceId/:chatId/send-message',{instanceId:'1',chatId:'same-phone'},{text:'Hello'},{}).status,403);
                assert.strictEqual(call('post','/clients/:instanceId/:chatId/send-message',{instanceId:'1',chatId:'same-phone'},{text:'Hello'},{origin:'https://evil.example'}).status,403);
                assert.deepStrictEqual(call('post','/clients/:instanceId/:chatId/send-message',{instanceId:'1',chatId:'same-phone'}, {text:'Hello',channel:'email',apiKey:'forged'}).body,{text:'Hello'});
                assert.strictEqual(call('delete','/clients/:instanceId/:chatId',{instanceId:'1',chatId:'same-phone'}).status,403);
                assert.strictEqual(call('post','/admin/anything',{}).status,403);
            }
        } finally {if(before===undefined)delete process.env.WHATSAPP_CRM_PUBLIC_URL;else process.env.WHATSAPP_CRM_PUBLIC_URL=before;}
    });

    it('AI inbox suggestions use only the selected business conversation',async()=>{
        const user=fixture('manager');
        const Auth=require('../src/services/auth.service');
        const AI=require('../src/services/ai.service');
        const app=require('../src/app').app;
        const oldEnabled=Auth.config.enabled,oldCustomer=process.env.AVA_CUSTOMER_ACCESS_ENABLED,oldOrigin=process.env.WHATSAPP_CRM_PUBLIC_URL;
        const oldSummary=AI.getSummary,oldNextStep=AI.getNextStep;
        Auth.config.enabled=true;process.env.AVA_CUSTOMER_ACCESS_ENABLED='true';
        DB.run("INSERT INTO messages(instanceId,chatId,senderName,content,role) VALUES (1,'same-phone','Guest','Own hotel dates','user'),(2,'same-phone','Guest','Foreign hotel price','user')");
        const token=Identity.createSession(user.subject,'qa-ai-inbox-session');
        const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
        const origin=`http://127.0.0.1:${server.address().port}`;process.env.WHATSAPP_CRM_PUBLIC_URL=origin;
        const headers={Cookie:`crm_session=ava2:${token}`,Origin:origin};
        let calls=0;
        AI.getSummary=async(messages,instance)=>{calls++;assert.strictEqual(Number(instance.id),1);assert.deepStrictEqual(messages.map(message=>message.content),['Own hotel dates']);return 'Own hotel summary';};
        AI.getNextStep=async(messages,_status,instance)=>{calls++;assert.strictEqual(Number(instance.id),1);assert.deepStrictEqual(messages.map(message=>message.content),['Own hotel dates']);return 'Ask for dates';};
        const request=(businessId,action)=>fetch(`${origin}/api/ai/${action}/${businessId}/same-phone`,{method:'POST',headers});
        try {
            const summary=await request(1,'summary');
            assert.strictEqual(summary.status,200);assert.strictEqual((await summary.json()).summary,'Own hotel summary');
            const next=await request(1,'next-step');
            assert.strictEqual(next.status,200);assert.strictEqual((await next.json()).nextStep,'Ask for dates');
            AI.getSummary=async()=>{throw new Error('Bearer should-not-leak');};
            const unavailable=await request(1,'summary');
            assert.strictEqual(unavailable.status,503);
            const unavailableBody=await unavailable.json();
            assert.strictEqual(unavailableBody.error,'AI_SUMMARY_UNAVAILABLE');
            assert.ok(!JSON.stringify(unavailableBody).includes('should-not-leak'));
            assert.strictEqual((await request(2,'summary')).status,403);
            assert.strictEqual((await request(2,'next-step')).status,403);
            assert.strictEqual(calls,2);
        } finally {
            AI.getSummary=oldSummary;AI.getNextStep=oldNextStep;Auth.config.enabled=oldEnabled;
            if(oldCustomer===undefined)delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;else process.env.AVA_CUSTOMER_ACCESS_ENABLED=oldCustomer;
            if(oldOrigin===undefined)delete process.env.WHATSAPP_CRM_PUBLIC_URL;else process.env.WHATSAPP_CRM_PUBLIC_URL=oldOrigin;
            await new Promise(resolve=>server.close(resolve));
        }
    });

    it('does not turn AI-provider failures into apparently successful suggestions',async()=>{
        const AI=require('../src/services/ai.service');
        const oldCall=AI._callProviderPlain;
        AI._callProviderPlain=async()=>{throw new Error('Bearer should-not-leak');};
        try {
            const messages=[{role:'user',content:'Нужен номер на завтра'}];
            await assert.rejects(AI.getSummary(messages,{}),/AI_SUMMARY_UNAVAILABLE/);
            await assert.rejects(AI.getNextStep(messages,'new',{}),/AI_NEXT_STEP_UNAVAILABLE/);
        } finally {AI._callProviderPlain=oldCall;}
    });

    it('real customer cookie can save a stage and tags through the app, read them back, and cannot touch another hotel',async()=>{
        const user=fixture('manager');
        const Auth=require('../src/services/auth.service');
        const app=require('../src/app').app;
        const Channel=require('../src/services/channel-router.service');
        const oldEnabled=Auth.config.enabled,oldCustomer=process.env.AVA_CUSTOMER_ACCESS_ENABLED,oldOrigin=process.env.WHATSAPP_CRM_PUBLIC_URL;
        const originalSend=Channel.sendMessage;
        Auth.config.enabled=true;process.env.AVA_CUSTOMER_ACCESS_ENABLED='true';
        const token=Identity.createSession(user.subject,'qa-native-session');
        DB.run("INSERT INTO messages(instanceId,chatId,senderName,content,role,aiThought) VALUES (1,'same-phone','AVA','Guest-safe answer','assistant','Internal prompt and tool trace')");
        const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
        const origin=`http://127.0.0.1:${server.address().port}`;process.env.WHATSAPP_CRM_PUBLIC_URL=origin;
        const headers={Cookie:`crm_session=ava2:${token}`,Origin:origin,'Content-Type':'application/json'};
        let sends=0;
        // External message delivery is deliberately a fixture, not a live WA acceptance claim.
        Channel.sendMessage=async(instanceId,chatId,text,channel)=>{sends++;assert.strictEqual(Number(instanceId),1);assert.strictEqual(chatId,'same-phone');assert.strictEqual(text,'Fixture only');assert.strictEqual(channel,null);return true;};
        try {
            const read=await fetch(`${origin}/api/clients/1`,{headers});assert.strictEqual(read.status,200);
            const guests=(await read.json()).clients;assert.strictEqual(guests.length,1);assert.strictEqual(guests[0].senderName,'Own guest');
            const conversation=await fetch(`${origin}/api/messages/1/same-phone`,{headers});assert.strictEqual(conversation.status,200);
            const customerMessage=(await conversation.json()).messages[0];
            assert.strictEqual(customerMessage.content,'Guest-safe answer');
            assert.strictEqual(Object.hasOwn(customerMessage,'aiThought'),false);
            const status=await fetch(`${origin}/api/clients/1/same-phone/status`,{method:'PUT',headers,body:JSON.stringify({status:'qualified'})});assert.strictEqual(status.status,200);
            const tags=await fetch(`${origin}/api/clients/1/same-phone/tags`,{method:'PUT',headers,body:JSON.stringify({tags:['pilot']})});assert.strictEqual(tags.status,200);
            const after=(await (await fetch(`${origin}/api/clients/1`,{headers})).json()).clients[0];
            assert.strictEqual(after.leadStatus,'qualified');assert.deepStrictEqual(JSON.parse(after.tags),['pilot']);
            assert.strictEqual(DB.get('SELECT leadStatus FROM clients WHERE instanceId=2').leadStatus,'new');
            assert.strictEqual((await fetch(`${origin}/api/clients/1/same-phone/status-history`,{headers})).status,200);
            const modules=await fetch(`${origin}/api/businesses/1/modules`,{headers});assert.strictEqual(modules.status,200);
            assert.ok((await modules.json()).modules.every(item=>item.state==='awaiting_setup'&&!item.allowed_actions.includes('open')));
            assert.strictEqual((await fetch(`${origin}/api/clients/2`,{headers})).status,403);
            assert.strictEqual((await fetch(`${origin}/api/clients/2/same-phone/status`,{method:'PUT',headers,body:JSON.stringify({status:'qualified'})})).status,403);
            const send=await fetch(`${origin}/api/clients/1/same-phone/send-message`,{method:'POST',headers,body:JSON.stringify({text:'Fixture only',channel:'email'})});assert.strictEqual(send.status,200);assert.strictEqual(sends,1);
            const foreign=await fetch(`${origin}/api/clients/2/same-phone/send-message`,{method:'POST',headers,body:JSON.stringify({text:'Fixture only'})});assert.strictEqual(foreign.status,403);assert.strictEqual(sends,1);
            Identity.revokeSession(token);
            assert.strictEqual((await fetch(`${origin}/api/clients/1`,{headers})).status,401);
        } finally {
            Channel.sendMessage=originalSend;Auth.config.enabled=oldEnabled;
            if(oldCustomer===undefined)delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;else process.env.AVA_CUSTOMER_ACCESS_ENABLED=oldCustomer;
            if(oldOrigin===undefined)delete process.env.WHATSAPP_CRM_PUBLIC_URL;else process.env.WHATSAPP_CRM_PUBLIC_URL=oldOrigin;
            await new Promise(resolve=>server.close(resolve));
        }
    });
});
