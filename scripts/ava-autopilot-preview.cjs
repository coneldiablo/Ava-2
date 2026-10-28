'use strict';
// Loopback-only UI fixture. Real scoped routers and SQLite; synthetic identity/provider.
const path = require('path');
const express = require('../whatsapp_crm/node_modules/express');
const { createTestDB } = require('../whatsapp_crm/tests/test-helper');
const DB = require('../whatsapp_crm/src/services/database.service');
const Identity = require('../whatsapp_crm/src/services/identity/identity-store');
const Workspace = require('../whatsapp_crm/src/services/ava-workspace.store');
const Deals = require('../whatsapp_crm/src/services/customer-deals.store');
const Auto = require('../whatsapp_crm/src/services/ava-autopilot.service');
const Channel = require('../whatsapp_crm/src/services/channel-router.service');
const Sales = require('../whatsapp_crm/src/services/sales-workspace.service');
createTestDB(); Identity.ensureSchema(); DB.createSalesWorkspaceTables(); Workspace.ensureSchema();
DB.run("INSERT INTO instances(id,name,isActive) VALUES(1,'AVA · Демонстрация',1),(2,'Второй бизнес',1)");
for (const [id, name, role, businesses] of [['owner','Магомед','hotel_owner',[1,2]],['manager','Анна','manager',[1]],['reader','Наблюдатель','observer',[1]]]) {
 DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)',[id,id+'@example.test',name]);
 for (const b of businesses) DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)',[id,b,role]);
}
const clients=[['79990000001@c.us','Александра Миронова','manager'],['79990000002@c.us','Дмитрий Волков','owner'],['79990000003@c.us','Елена Соколова',null]];
for (const [chat,name,assignee] of clients) {
 DB.run('INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,?,?,?)',[chat,name,assignee]);
 require('../whatsapp_crm/src/services/client-identity.service').attach(1,chat,{kind:'phone',value:'+'+chat.split('@')[0]});
}
DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(2,'79990000004@c.us','Клиент второго бизнеса','owner')");
const now = new Date().toISOString();
function msg(chat,role,text) { return Number(DB.run('INSERT INTO messages(instanceId,chatId,senderName,role,content,timestamp,channel) VALUES(1,?,?,?,?,?,?)',[chat,role==='user'?'Клиент':'Анна',role,text,now,'whatsapp']).lastInsertRowid); }
const source=msg(clients[0][0],'user','Здравствуйте! Хочу подобрать обслуживание для небольшой команды. Можно поговорить с менеджером?');
msg(clients[0][0],'assistant','Здравствуйте, Александра! Уже выяснили: команда из 8 человек, нужен запуск на следующей неделе. Пришлю предложение завтра.');
msg(clients[1][0],'user','Жду смету и условия доставки.');
msg(clients[2][0],'user','Сколько стоит обслуживание?');
Workspace.setControl({businessId:1,chatId:clients[0][0],mode:'human',reason:'Клиент попросил менеджера'});
Workspace.createPromise({businessId:1,chatId:clients[0][0],summary:'Отправить предложение',dueAt:new Date(Date.now()-3600000).toISOString(),assigneeUserId:'manager',sourceType:'message',sourceId:String(source),sourceText:'Обсудили запуск на следующей неделе'});
DB.createManagerTask({instanceId:1,chatId:clients[0][0],summary:'Согласовать вариант обслуживания',assigneeUserId:'manager',dueAt:new Date(Date.now()+3600000).toISOString()});
DB.createConversationEvent({instanceId:1,chatId:clients[0][0],callId:'fixture-call',eventId:'fixture-call-source',channel:'voice',content:'Клиенту нужен запуск для 8 сотрудников на следующей неделе',metadata:{duration_seconds:52}});
Workspace.recordCallTranscript({businessId:1,chatId:clients[0][0],sourceId:'fixture-call-source',text:'user: Нас восемь человек.\nassistant: Подскажите, когда нужен запуск?\nuser: На следующей неделе.',timestamp:now});
const d=Deals.create(1,{title:'Обслуживание команды',clientChatId:clients[0][0],amount:24000,currency:'RUB'},'owner');
Deals.update(1,d.id,{revision:d.revision,stage:'qualified'},'owner');
const closed=Deals.create(1,{title:'Подключение',clientChatId:clients[1][0]},'owner');Deals.update(1,closed.id,{revision:closed.revision,stage:'won'},'owner');
const owner=Identity.actor('owner');
const offer=Auto.createOffer(owner,1,{name:'Обслуживание команды',description:'Запуск, настройка и поддержка',amountMinor:2400000,currency:'RUB',terms:'Оплата после согласования. Без индивидуальных скидок.',active:true}).offer;
Auto.publishCatalog(owner,1,offer.id,{revision:offer.revision});
Auto.updatePolicy(owner,1,{revision:0,enabled:true,scenarioIds:['qualification','proposal','complaint','missed_call','awaiting_reply','returning_customer'],allowedActions:['reply','quote','qualify','update_fields','handoff'],routing:{enabled:true,memberIds:['manager','owner']}});
Channel.sendMessageDetailed=async (businessId,chatId,text,_channel,context)=>{context.beforeSend?.();await DB.saveMessageWithChannel(businessId,chatId,'Менеджер',text,'assistant','whatsapp');return {success:true,provider_message_id:'fixture-'+Date.now()};};
require('../whatsapp_crm/src/services/whatsapp-gateway.service').sendMessage=async()=>({success:true,data:{idMessage:'fixture-auto-'+Date.now()}});
const app=express();app.use(express.json());
app.use((req,_res,next)=>{const user=/ava_preview_role=(manager|reader)/.exec(req.headers.cookie||'')?.[1]||'owner';req.auth=Identity.actor(user);next();});
app.get('/api/auth/me',(req,res)=>res.json({authenticated:true,userId:req.auth.userId,login:'preview',displayName:req.auth.displayName,role:'customer',memberships:req.auth.memberships,canCreateBusiness:false}));
app.get('/api/instances',(req,res)=>res.json({success:true,instances:DB.all('SELECT id,name,isActive FROM instances').filter(b=>req.auth.memberships.some(m=>m.businessId===b.id))}));
app.use('/api',require('../whatsapp_crm/src/services/identity/customer-role-boundary'));
for (const name of ['ava-release-flags','ava-workspace','ava-autopilot','ava-analytics','customer-deals','sales-workspace','customer-team']) app.use('/api',require('../whatsapp_crm/src/routes/'+name+'.routes'));
app.use('/api',(req,res)=>res.status(404).json({success:false,error:'PREVIEW_ROUTE_NOT_INCLUDED'}));
const dist=path.resolve(__dirname,'../whatsapp_crm/frontend/dist');app.use(express.static(dist));app.get('*',(_req,res)=>res.sendFile(path.join(dist,'index.html')));
const port=Number(process.env.AVA_PREVIEW_PORT||4177);process.env.WHATSAPP_CRM_PUBLIC_URL='http://127.0.0.1:'+port;
app.listen(port,'127.0.0.1',()=>console.log('AVA isolated fixture: '+process.env.WHATSAPP_CRM_PUBLIC_URL));
