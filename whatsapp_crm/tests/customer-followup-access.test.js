'use strict';
const {describe,it,assert}=require('./test-helper');
const Access=require('../src/services/identity/customer-access');
const Identity=require('../src/services/identity/identity-store');
const DB=require('../src/services/database.service');
function invoke(method,path,{business=7,origin='https://ava.example.test',body={instanceId:7,text:'Проект',channel:'telegram',recipient:'123',chatId:'foreign'}}={}) {
 let allowed=false,result;
 const req={auth:{userId:'manager'},params:{instanceId:business,chatId:'call-card',draftId:'draft-a'},body,query:{},headers:{origin},get:()=> 'ava.example.test',protocol:'https'};
 const res={status(code){this.code=code;return this},json(value){result={code:this.code,value};}};
 Access.forRoute(method,path)(req,res,()=>{allowed=true;});
 return {allowed,result,body:req.body};
}
describe('Followup customer access',()=>{
 it('allows scoped manager draft edit and strips identity overrides; rejects tenant/origin/foreign drafts',()=>{
  const authorize=Identity.authorizeCapability,getDraft=DB.getFollowupDraft,previous=process.env.WHATSAPP_CRM_PUBLIC_URL;
  process.env.WHATSAPP_CRM_PUBLIC_URL='https://ava.example.test';
  Identity.authorizeCapability=(_auth,id)=>{if(Number(id)!==7) throw Object.assign(new Error('BUSINESS_ACCESS_DENIED'),{statusCode:403});};
  DB.getFollowupDraft=(id,draft)=> Number(id)===7&&draft==='draft-a'?{instanceId:7}:null;
  try {
   const path='/sales-brain/followup-drafts/:draftId';
   const valid=invoke('patch',path);assert.equal(valid.allowed,true);assert.equal(valid.body.chatId,undefined);assert.equal(valid.body.text,'Проект');
   assert.equal(invoke('patch',path,{origin:'https://evil.example'}).allowed,false);
   assert.equal(invoke('patch',path,{body:{instanceId:8,text:'foreign'}}).allowed,false);
   assert.equal(invoke('patch',path,{body:{instanceId:7,businessId:8}}).allowed,false);
   DB.getFollowupDraft=()=>null;assert.equal(invoke('post',path+'/send').allowed,false);
  } finally {Identity.authorizeCapability=authorize;DB.getFollowupDraft=getDraft;if(previous===undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;else process.env.WHATSAPP_CRM_PUBLIC_URL=previous;}
 });
});
