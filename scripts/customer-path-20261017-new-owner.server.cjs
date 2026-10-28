'use strict';
// Empty real SQLite + real product routes/stores. Fixtures only replace external providers.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),https=require('node:https'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const repo=path.resolve(__dirname,'..'),service=name=>require(path.join(repo,'whatsapp_crm/src/services',name));
Object.assign(process.env,{NODE_ENV:'test',AVA_PROCESS_ROLE:'provisioning-worker',AVA_CUSTOMER_ACCESS_ENABLED:'true',AVA_SELF_REGISTRATION_ENABLED:'true',SESSION_SECRET:'new-owner-local-fixture-session-secret-only',AVA_IDENTITY_BROKER_TOKEN:'new-owner-local-fixture-broker-secret-only',AVA_OIDC_CLIENT_ID:'ava-web',CRM_SERVICE_API_TOKEN:'local-fixture-service-token'});
const external={blocked:[],mailAccepted:0,identityWrites:0,provisionedModules:0,recoveryEmails:0,passwordResets:0,oidcGrants:0};
for(const transport of [http,https]){const original=transport.request;transport.request=function(...args){const v=args[0],host=typeof v==='string'||v instanceof URL?new URL(v).hostname:v?.hostname||v?.host;if(host&&!['127.0.0.1','localhost','::1','[::1]'].includes(host)){external.blocked.push(host);throw Error('EXTERNAL_NETWORK_FORBIDDEN');}return original.apply(this,args);};}
const originalFetch=global.fetch;global.fetch=(input,...rest)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!['127.0.0.1','localhost','::1','[::1]'].includes(url.hostname)){external.blocked.push(url.hostname);throw Error('EXTERNAL_NETWORK_FORBIDDEN');}return originalFetch(input,...rest);};
let appServer,idpServer,broker,worker,tick,DB,temp,publicOrigin,issuer,latestCode='',recoveryLink='';const native=[],authFlows=new Map(),codes=new Map(),recoveries=new Map();
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const page=(title,form)=>`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body><h1>${title}</h1>${form}</body></html>`;
const readBody=async req=>{let body='';for await(const chunk of req)body+=chunk;return new URLSearchParams(body);};
const redirect=(res,location)=>{res.writeHead(302,{Location:location});res.end();};
(async()=>{
 temp=fs.mkdtempSync(path.join(os.tmpdir(),'ava-new-owner-'));execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-keyout',path.join(temp,'key.pem'),'-out',path.join(temp,'cert.pem')],{stdio:'ignore'});
 const tls={key:fs.readFileSync(path.join(temp,'key.pem')),cert:fs.readFileSync(path.join(temp,'cert.pem'))};
 DB=service('database.service');require(path.join(repo,'whatsapp_crm/tests/test-helper')).createTestDB();DB.createBusinessGptTables();const Identity=service('identity/identity-store');Identity.ensureSchema();
 const Logger=require(path.join(repo,'whatsapp_crm/src/utils/logger'));Logger.info=()=>{};Logger.debug=()=>{};Logger.success=()=>{};
 service('identity/system-mailer.service')._transporter={sendMail:async message=>{external.mailAccepted++;latestCode=String(message.subject).match(/\d{6}/)?.[0]||'';return{accepted:[message.to],rejected:[],messageId:'fixture-otp'};}};
 const {KeycloakAdmin}=service('identity/keycloak-admin');const admin=new KeycloakAdmin({request:async request=>{
  const url=new URL(request.url),p=url.pathname.replace('/admin/realms/ava',''),data=request.data;
  if(url.pathname.endsWith('/protocol/openid-connect/token'))return{data:{access_token:'fixture-admin-token',expires_in:300}};
  if(request.method==='GET'&&p==='/users')return{data:structuredClone(native.filter(user=>url.searchParams.has('username')?user.username===url.searchParams.get('username'):user.email.toLowerCase()===url.searchParams.get('email')?.toLowerCase()))};
  if(request.method==='POST'&&p==='/users'){external.identityWrites++;native.push({id:'fixture-native-'+(native.length+1),...structuredClone(data)});return{data:null};}
  const user=native.find(user=>p.startsWith('/users/'+user.id));if(!user)throw Error('UNEXPECTED_NATIVE_PATH');
  if(request.method==='GET'&&p.endsWith('/sessions'))return{data:[]};if(request.method==='GET')return{data:structuredClone(user)};
  external.identityWrites++;
  if(p.endsWith('/execute-actions-email')){if(JSON.stringify(data)!=='["UPDATE_PASSWORD"]')throw Error('UNEXPECTED_RECOVERY_ACTION');const token=crypto.randomUUID();recoveries.set(token,user.id);recoveryLink=issuer+'/recover?token='+token;external.recoveryEmails++;}
  else if(p.endsWith('/reset-password'))user.password=data.value;
  else if(request.method==='PUT')Object.assign(user,structuredClone(data));return{data:null};
 }});
 idpServer=https.createServer(tls,async(req,res)=>{try{
  const url=new URL(req.url,issuer||'https://127.0.0.1');
  if(url.pathname==='/realms/ava/auth'){
   if(url.searchParams.get('redirect_uri')!==publicOrigin+'/api/auth/sso/callback'||url.searchParams.get('code_challenge_method')!=='S256')throw Error('INVALID_AUTHORIZE_REQUEST');
   const flow=crypto.randomUUID();authFlows.set(flow,Object.fromEntries(url.searchParams));res.setHeader('Content-Type','text/html;charset=utf-8');res.end(page('Тестовый провайдер входа',`<form method="post" action="/signin?flow=${flow}"><label>Почта тестового IdP<input name="email" type="email" required></label><label>Пароль тестового IdP<input name="password" type="password" required></label><button>Войти у провайдера</button></form>`));return;
  }
  if(url.pathname==='/signin'&&req.method==='POST'){
   const flow=authFlows.get(url.searchParams.get('flow')),body=await readBody(req),user=native.find(user=>user.email===body.get('email')&&user.password===body.get('password')&&user.enabled);
   if(!flow||!user){res.statusCode=401;res.end(page('Вход не подтверждён','Неверная почта или пароль тестового провайдера.'));return;}
   const code=crypto.randomUUID();codes.set(code,{...flow,sub:user.id});authFlows.delete(url.searchParams.get('flow'));return redirect(res,flow.redirect_uri+'?state='+encodeURIComponent(flow.state)+'&code='+code);
  }
  if(url.pathname==='/realms/ava/recover'){
   const token=url.searchParams.get('token');if(!recoveries.has(token)){res.statusCode=400;res.end('Ссылка недействительна');return;}
   res.setHeader('Content-Type','text/html;charset=utf-8');res.end(page('Новый пароль у тестового провайдера',`<form method="post" action="/reset?token=${escape(token)}"><label>Новый пароль IdP<input name="password" type="password" minlength="12" required></label><button>Сохранить новый пароль</button></form>`));return;
  }
  if(url.pathname==='/reset'&&req.method==='POST'){
   const token=url.searchParams.get('token'),subject=recoveries.get(token),body=await readBody(req),user=native.find(u=>u.id===subject);if(!user||String(body.get('password')).length<12){res.statusCode=400;res.end('Некорректный пароль');return;}
   recoveries.delete(token);user.password=body.get('password');external.passwordResets++;return redirect(res,publicOrigin+'/api/auth/sso/start');
  }
  res.statusCode=404;res.end('Unknown fixture IdP route');
 }catch(e){res.statusCode=500;res.end('Fixture IdP failure');process.send?.({event:'idp_error',code:e.message});}});
 await new Promise(resolve=>idpServer.listen(0,'127.0.0.1',resolve));issuer='https://127.0.0.1:'+idpServer.address().port+'/realms/ava';process.env.AVA_OIDC_ISSUER=issuer;
 const oidc=await import(require.resolve('openid-client',{paths:[path.join(repo,'whatsapp_crm')]})),jose=await import(require.resolve('jose',{paths:[path.join(repo,'whatsapp_crm')]}));
 const pair=await jose.generateKeyPair('RS256'),jwk={...await jose.exportJWK(pair.publicKey),kid:'new-owner-fixture',alg:'RS256',use:'sig'};
 const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
 const idpFetch=async(input,options)=>{
  const url=new URL(String(input));if(url.origin!==new URL(issuer).origin)throw Error('UNEXPECTED_OIDC_HOST');
  if(url.pathname.endsWith('/.well-known/openid-configuration'))return json({issuer,authorization_endpoint:issuer+'/auth',token_endpoint:issuer+'/token',jwks_uri:issuer+'/certs',end_session_endpoint:issuer+'/logout',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256']});
  if(url.pathname.endsWith('/certs'))return json({keys:[jwk]});
  if(!url.pathname.endsWith('/token'))throw Error('UNEXPECTED_OIDC_PATH');
  const body=new URLSearchParams(options.body),flow=codes.get(body.get('code'));
  if(!flow||body.get('redirect_uri')!==flow.redirect_uri||crypto.createHash('sha256').update(body.get('code_verifier')).digest('base64url')!==flow.code_challenge)throw Error('PKCE_NOT_CONFIRMED');codes.delete(body.get('code'));external.oidcGrants++;
  const token=await new jose.SignJWT({nonce:flow.nonce,sid:'fixture-session-'+external.oidcGrants}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(issuer).setSubject(flow.sub).setAudience('ava-web').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  return json({access_token:'fixture-access',token_type:'Bearer',expires_in:300,id_token:token});
 };
 service('identity/oidc.service').load=async()=>({...oidc,discovery:(server,client,metadata,auth,options)=>oidc.discovery(server,client,metadata,auth,{...options,[oidc.customFetch]:idpFetch})});
 broker=service('identity/identity-broker').start({port:0,host:'127.0.0.1',admin});await new Promise(resolve=>broker.once('listening',resolve));
 const axios=require(path.join(repo,'whatsapp_crm/node_modules/axios')).default,originalPost=axios.post.bind(axios);axios.post=(url,...args)=>originalPost(url==='http://provisioning_worker:3900/invitations/redeem'?'http://127.0.0.1:'+broker.address().port+'/invitations/redeem':url,...args);
 const {BusinessProvisioningWorker}=service('provisioning/business-provisioning-worker.service');worker=new BusinessProvisioningWorker();worker._executeJob=async job=>{external.provisionedModules++;return{status:'DONE',stage:'fixture_native_ready',checkpoint:{provider:'local_external_fixture',businessId:job.businessId}};};
 const Auth=service('auth.service');Auth.config.enabled=true;
 const Onboarding=service('onboarding-state.service');Onboarding.ensureSchema();service('identity/self-registration.service').ensureSchema({cleanup:false});service('identity/password-recovery.service').ensureSchema();
 process.env.WHATSAPP_CRM_PUBLIC_URL='https://127.0.0.1:1';
 const app=require(path.join(repo,'whatsapp_crm/src/app')).app;appServer=https.createServer(tls,app);await new Promise(resolve=>appServer.listen(0,'127.0.0.1',resolve));publicOrigin='https://127.0.0.1:'+appServer.address().port;process.env.WHATSAPP_CRM_PUBLIC_URL=publicOrigin;
 const runWorkers=async()=>{await worker.processQueue();await service('identity/password-recovery.service').processOne({admin});};let running=false;tick=setInterval(async()=>{if(running)return;running=true;try{await runWorkers();}catch(e){process.send?.({event:'worker_error',code:e.code||e.message});}finally{running=false;}},100);
 const snapshot=()=>({external,users:DB.all('SELECT id,subject,email,enabled FROM ava_users'),businesses:DB.all('SELECT id,name,isActive,systemPrompt,hotelTone,voiceGreetingTemplate FROM instances'),memberships:DB.all('SELECT userId,businessId,role FROM ava_business_memberships'),onboarding:DB.all('SELECT businessId,confirmedSteps,completedAt FROM ava_business_onboarding'),registrations:DB.all('SELECT state,businessId,userId,length(passwordEncrypted) AS retainedPasswordBytes FROM ava_self_registrations'),jobs:DB.all('SELECT businessId,module,status FROM business_provisioning_jobs'),recoveryJobs:DB.all('SELECT state,attempts,lastErrorCode FROM ava_password_recovery_jobs'),native:native.map(u=>({id:u.id,enabled:u.enabled,emailVerified:u.emailVerified,hasPassword:!!u.password})),sessions:DB.get('SELECT COUNT(*) n FROM ava_sessions').n});
 const sourceHead=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();const sourceFiles=['whatsapp_crm/src/services/identity/self-registration.service.js','whatsapp_crm/src/services/identity/oidc.service.js','whatsapp_crm/src/services/identity/identity-store.js','whatsapp_crm/src/services/identity/keycloak-admin.js','whatsapp_crm/src/services/identity/password-recovery.service.js','whatsapp_crm/src/services/provisioning/business-provisioning-store.service.js','whatsapp_crm/src/services/onboarding-state.service.js','whatsapp_crm/src/routes/identity.routes.js','whatsapp_crm/frontend/dist/index.html'];const hashes=Object.fromEntries(sourceFiles.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,file))).digest('hex')]));
 process.on('message',async message=>{try{let result;if(message.op==='snapshot')result=snapshot();else if(message.op==='code')result=latestCode;else if(message.op==='recovery-link')result=recoveryLink;else if(message.op==='drain'){await runWorkers();result=true;}else if(message.op==='close'){clearInterval(tick);appServer.close();idpServer.close();broker.close();DB.db.close();fs.rmSync(temp,{recursive:true,force:true});process.exit(0);}process.send({id:message.id,result});}catch(e){process.send({id:message.id,error:e.code||e.message});}});
 process.send({ready:true,origin:publicOrigin,idpOrigin:new URL(issuer).origin,sourceHead,hashes,initial:snapshot()});
})().catch(e=>{process.send?.({fatal:e.code||e.message,stack:e.stack});if(temp)fs.rmSync(temp,{recursive:true,force:true});process.exit(1);});
