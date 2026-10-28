'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const axios=require('axios');
const DB=require('../src/services/database.service');
const Identities=require('../src/services/client-identity.service');
const Calls=require('../src/services/client-call-history.service');
const config=require('../src/config');
describe('Confirmed client external calls',()=>{
 it('rejects another tenant before querying external history and rechecks membership after read',async()=>{
  const Identity=require('../src/services/identity/identity-store');
  const Auth=require('../src/services/auth.service');
  const router=require('../src/routes/customer-calls.routes');
  const handler=router.stack.find(layer=>layer.route?.path==='/clients/:instanceId/:chatId/calls').route.stack[0].handle;
  const authorize=Identity.authorizeCapability,page=Calls.page,getSession=Auth.getSession;Auth.getSession=req=>req.auth;let reads=0,allow=true;
  Identity.authorizeCapability=(_auth,id)=>{if(id!==7||!allow)throw Object.assign(new Error('denied'),{statusCode:403});};
  Calls.page=async()=>{reads++;return{calls:[],sourceComplete:true,nextPage:null};};
  const request=async(id)=>{const res={code:200,status(n){this.code=n;return this;},json(value){this.body=value;return this;}};await handler({params:{instanceId:String(id),chatId:'fixture'},query:{},auth:{userId:'manager'}},res);return res;};
  try {
   assert.equal((await request(8)).code,403);assert.equal(reads,0);
   assert.equal((await request(7)).code,200);assert.equal(reads,1);
   Calls.page=async()=>{allow=false;return{calls:[{id:'private'}]};};
   const revoked=await request(7);assert.equal(revoked.code,403);assert.equal(revoked.body.calls,undefined);
  }finally{Identity.authorizeCapability=authorize;Calls.page=page;Auth.getSession=getSession;}
 });

 it('selects both exact confirmed phone aliases in one business and rejects foreign API rows',async()=>{
  createTestDB();const own=await DB.createInstance({name:'Own'}),other=await DB.createInstance({name:'Other'});
  const chat='79990000111@c.us';await DB.getOrCreateClient(own.id,chat,'Caller');
  Identities.attach(own.id,chat,{kind:'phone',value:'+79990000222'});
  Identities.attach(own.id,chat,{kind:'whatsapp',value:'79990000333@c.us'});
  const previous={...config.avaAdmin},get=axios.get;Object.assign(config.avaAdmin,{apiUrl:'http://fixture-admin',serviceToken:'fixture-token',timeoutMs:100});
  let requests=[];
  axios.get=async(url,options)=>{requests.push(options.params.page);assert.equal(url,`http://fixture-admin/api/internal/calls/business/${own.id}`);return{data:{business_id:own.id,total_pages:2,calls:options.params.page===1?[
   {id:'one',business_id:own.id,caller_number:'+7 (999) 000-01-11',direction:'inbound'},
   {id:'two',business_id:own.id,called_number:'79990000222',direction:'outbound'},
   {id:'suffix',business_id:own.id,caller_number:'+19990000111',direction:'inbound'},
   {id:'name',business_id:own.id,caller_number:'+79990000999',caller_name:'Caller',direction:'inbound'},
  ]:[{id:'three',business_id:own.id,caller_number:'+79990000333',direction:'inbound'}]}};};
  try {
   const selected=await Calls.page(own.id,chat);assert.equal(selected.calls.length,3);assert.equal(selected.sourceComplete,true);assert.equal(selected.nextPage,null);assert.deepEqual(requests,[1,2]);
   assert.ok(selected.calls.every(row=>!row.caller_number&&!row.called_number&&!row.call_id));
   axios.get=async()=>({data:{total_pages:1,calls:[{id:'foreign',business_id:other.id,caller_number:'+79990000111',direction:'inbound'}]}});
   await assert.rejects(()=>Calls.page(own.id,chat),/CALL_HISTORY_SCOPE_MISMATCH/);
   await assert.rejects(()=>Calls.page(other.id,chat),/CLIENT_NOT_FOUND/);
   axios.get=async(_url,options)=>({data:{business_id:own.id,total_pages:5,calls:[]}});
   const partial=await Calls.page(own.id,chat);assert.equal(partial.sourceComplete,false);assert.equal(partial.nextPage,4);
  }finally{axios.get=get;Object.assign(config.avaAdmin,previous);}
 });
});
