'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const WA=require('../src/services/whatsapp.service');
const Product=require('../src/services/channel-product-context.service');

describe('Authenticated HTTP product ingress',()=>{
 it('retains cards and quoted products through real mounted routes with tenant-scoped authentication',async()=>{
  createTestDB();
  const express=require('express'),crypto=require('crypto'),Connection=require('../src/services/whatsapp-connection.service');
  const keys=['OPENWA_WEBHOOK_MASTER_KEY','GREEN_API_WEBHOOK_MASTER_KEY'];
  const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  for(const key of keys)process.env[key]='http-product-fixture-master-32-chars';
  const originalEnqueue=WA._enqueueJob;WA._enqueueJob=()=>{};
  let server;
  try{
   const a=await DB.createInstance({name:'Product HTTP A'}),b=await DB.createInstance({name:'Product HTTP B'});
   await DB.updateInstance(a.id,{openWaSessionId:'product-http-a',greenApiInstance:'product-green-a'});
   await DB.updateInstance(b.id,{openWaSessionId:'product-http-b'});
   const chat='79990000001@c.us';
   for(const business of [a,b]){await DB.getOrCreateClient(business.id,chat,'Fixture');DB.run('UPDATE clients SET lastMessageTime=CURRENT_TIMESTAMP WHERE instanceId=?',[business.id]);}
   const app=express();app.use(express.json({verify:(req,_res,raw)=>{req.rawBody=Buffer.from(raw);}}));
   app.use('/api',require('../src/routes/api.routes'));
   server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
   const url=`http://127.0.0.1:${server.address().port}/api`;
   const post=(path,body,headers={})=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
   const instance=await DB.getInstance(a.id);
   const sign=body=>'sha256='+crypto.createHmac('sha256',Connection.signingSecret(instance)).update(JSON.stringify(body)).digest('hex');
   const card={sessionId:'product-http-a',event:'message.received',data:{id:'http-card',from:chat,type:'unknown',product:{productId:'sku-a',title:'Комплект A'}}};
   assert.strictEqual((await post('/webhook/openwa',card)).status,401);
   assert.strictEqual(DB.get('SELECT COUNT(*) n FROM messages').n,0);
   assert.strictEqual((await post('/webhook/openwa',card,{'x-openwa-signature':sign(card)})).status,200);
   assert.strictEqual(Product.snapshot(a.id,chat).entry.productId,'sku-a');
   assert.strictEqual(Product.snapshot(b.id,chat).entry,null);
   const crossed={...card,sessionId:'product-http-b'};
   assert.strictEqual((await post('/webhook/openwa',crossed,{'x-openwa-signature':sign(crossed)})).status,401);
   const quote={...card,data:{id:'http-quote',from:chat,type:'text',body:'Сколько?',quotedMessage:{id:'earlier',product:{productId:'sku-b',title:'Комплект B'}}}};
   assert.strictEqual((await post('/webhook',quote,{'x-openwa-signature':sign(quote)})).status,200);
   assert.strictEqual(Product.snapshot(a.id,chat).entry.productId,'sku-b');
   const green={instanceData:{idInstance:'product-green-a'},typeWebhook:'incomingMessageReceived',idMessage:'green-http-card',senderData:{chatId:chat},messageData:{typeMessage:'productMessage',productMessage:{productId:'sku-c',title:'Комплект C'}}};
   assert.strictEqual((await post('/webhook/green-api',green,{Authorization:'Bearer '+Connection.greenWebhookToken(instance)})).status,200);
   assert.strictEqual(Product.snapshot(a.id,chat,{channel:'whatsapp',accountId:'green_api:product-green-a'}).entry.productId,'sku-c');
   assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE instanceId=? AND role='user'",[a.id]).n,3);
  }finally{
   WA._enqueueJob=originalEnqueue;WA.batcher.clearAll();
   if(server)await new Promise(resolve=>server.close(resolve));
   for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
  }
 });
});
