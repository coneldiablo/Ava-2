'use strict';
// Real AVA Express/SQLite harness. Fixtures exist only at external boundaries.
// Launched by the paired Playwright script; never run against production data.
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const service = name => require(path.join(repo, 'whatsapp_crm/src/services', name));
process.env.NODE_ENV = 'test';
process.env.CHANNEL_CREDENTIALS_MASTER_KEY='11'.repeat(32);
const dataState={loseNextCommit:false,lostCommitResponses:0,providerMode:'normal',providerCalls:[]};
const fixtureDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ava-ui-provider-'));
process.env.AVA_VOICE_CONFIG_PATH = path.join(fixtureDir, 'voice.yaml');
fs.writeFileSync(process.env.AVA_VOICE_CONFIG_PATH, 'default_provider: yandex_realtime\nproviders:\n  yandex_realtime:\n    enabled: true\n    credentials_configured: true\n');
process.on('exit', () => fs.rmSync(fixtureDir, { recursive: true, force: true }));

process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
process.env.AVA_SELF_REGISTRATION_ENABLED = 'true';
process.env.SESSION_SECRET = 'local-integrated-fixture-session-secret-only';
process.env.CRM_SERVICE_API_TOKEN = 'local-fixture-service-token';
process.env.AVA_TELEPHONY_LEGACY_DIDS = '{"74950000001":1}';
process.env.AVA_IMPROVEMENTS_BUSINESSES = '*';
const external = { blocked: [], documentSends: 0, textSends: 0, mailSends: 0, adminCommands: 0, modelCalls: 0 };
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const sourceDigests = Object.fromEntries(['whatsapp_crm/src', 'whatsapp_crm/frontend/dist'].flatMap(root => {
    const visit = dir => fs.readdirSync(path.join(repo, dir), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? visit(dir + '/' + entry.name) : /\.(?:js|cjs|html|css)$/.test(entry.name) ? [dir + '/' + entry.name] : []);
    return visit(root);
}).sort().map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')]));
const campaignState = new Map();
let latestCode = '', application, upstream, staticApplication;
const pinnedFrontend=path.join(fixtureDir,'frontend');fs.cpSync(path.join(repo,'whatsapp_crm/frontend/dist'),pinnedFrontend,{recursive:true});

for (const transport of [http, https]) {
    const original = transport.request;
    transport.request = function (...args) {
        let hostname;
        if (typeof args[0] === 'string' || args[0] instanceof URL) hostname = new URL(args[0]).hostname;
        else hostname = args[0]?.hostname || args[0]?.host;
        if (hostname && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) {
            external.blocked.push(String(hostname));
            throw Object.assign(new Error('External network forbidden in integration harness'), { code: 'FIXTURE_NETWORK_BLOCKED' });
        }
        return original.apply(this, args);
    };
}
const originalFetch = global.fetch;
global.fetch = (input, ...rest) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
        external.blocked.push(url.hostname);
        throw Object.assign(new Error('External network forbidden in integration harness'), { code: 'FIXTURE_NETWORK_BLOCKED' });
    }
    return originalFetch(input, ...rest);
};

(async () => {
    upstream = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://fixture.invalid');
        let data = ''; for await (const part of req) data += part;
        const body = data ? JSON.parse(data) : {};
        res.setHeader('Content-Type', 'application/json');
        let output;
        const command = url.pathname.match(/\/outbound\/sales-brain\/campaigns\/([^/]+)\/(sync|status)$/);
        if (command) {
            const id = decodeURIComponent(command[1]);
            if (req.method === 'POST') {
                external.adminCommands++;
                const status = command[2] === 'sync' ? body.start ? 'running' : 'draft' : body.status;
                campaignState.set(id, status);
                // Lose the first command ACK; read-only reconciliation can later prove it.
                if (command[2] === 'sync' && body.start && external.adminCommands === 1) { res.statusCode = 503; res.end('{"detail":"fixture lost ACK"}'); return; }
            }
            output = { success: true, sales_brain_campaign_id: id, ava_campaign: { id: 'fixture-engine', business_id: 1, external_source: 'sales_brain', external_id: id, status: campaignState.get(id) || 'draft', source_number_id: null } };
        } else if (/\/calls\/business\/1\/record-one\/transcript$/.test(url.pathname)) output = { success: true, business_id: 1, record_id: 'record-one', call_id: 'call-one', turns: [{ role: 'user', text: 'Пришлите подборку в WhatsApp.' }, { role: 'assistant', text: 'Менеджер проверит предложение.' }] };
        else if (/\/calls\/business\/1$/.test(url.pathname)) output = { business_id: 1, total: 1, total_pages: 1, calls: [{ id: 'record-one', call_id: 'call-one', business_id: 1, caller_number: '79990000001', caller_name: 'Тестовый покупатель', direction: 'inbound', outcome: 'completed', start_time: new Date().toISOString(), duration_seconds: 45 }] };
        else if (/\/calls\/business\/\d+$/.test(url.pathname)) output = { business_id: Number(url.pathname.match(/(\d+)$/)[1]), total: 0, total_pages: 1, calls: [] };
        else if (/\/stats$/.test(url.pathname)) output = { business_id: 1, period_days: Number(url.searchParams.get('days') || 7), total_calls: 1, avg_duration_seconds: 45, total_duration_seconds: 45, outcomes: { completed: 1 }, providers: {}, directions: {}, calls_per_day: [] };
        else { res.statusCode = 404; output = { success: false, code: 'FIXTURE_UPSTREAM_ROUTE_UNKNOWN' }; }
        res.end(JSON.stringify(output));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    process.env.AVA_ADMIN_API_URL = 'http://127.0.0.1:' + upstream.address().port;
    const { createTestDB } = require(path.join(repo, 'whatsapp_crm/tests/test-helper'));
    const DB = service('database.service'); createTestDB(); DB.createBusinessGptTables();
    const Identity = service('identity/identity-store'); Identity.ensureSchema();
    const Auth = service('auth.service'); Auth.config.enabled = true;
    const Logger = require(path.join(repo, 'whatsapp_crm/src/utils/logger'));
    // Keep operational evidence useful without fixture-generated VAPID output.
    Logger.info = () => {}; Logger.success = () => {}; Logger.debug = () => {};
    const Mailer = service('identity/system-mailer.service');
    Mailer.sendVerificationCodeEmail = async ({ code }) => { external.mailSends++; latestCode = code; return { accepted: ['fixture@example.test'] }; };
    Mailer._getTransporter = () => ({ sendMail: async message => { external.mailSends++; return { messageId: 'fixture-mail', accepted: [message.to] }; } });
    const OpenWA = service('openwa.service');
    OpenWA.getState = async () => ({ success: true, data: { stateInstance: 'authorized', rawStatus: 'ready', phone: '79990000001', engineLoaded: true } });
    OpenWA.sendMessage = async () => { external.textSends++; return { success: true, data: { messageId: 'fixture-text-' + external.textSends } }; };
    OpenWA.sendDocument = async () => { external.documentSends++; return { success: true, providerMessageId: 'fixture-pdf-' + external.documentSends, safeToRetry: false }; };
    service('ai.service');
    const axios = require(path.join(repo, 'whatsapp_crm/node_modules/axios')).default;
    const actualAdapter = axios.getAdapter(axios.defaults.adapter);
    axios.defaults.adapter = async request => {
        const url = new URL(request.url);
        if (url.hostname === 'fixture.amocrm.ru' || url.hostname === 'api.avito.ru') {
            const provider=url.hostname==='api.avito.ru'?'avito':'amocrm',method=request.method.toUpperCase(),p=url.pathname;
            dataState.providerCalls.push({provider,method,path:p});let payload={};
            if(dataState.providerMode===provider+'-denied' && method==='GET')throw Object.assign(new Error('controlled access refusal'),{response:{status:403,headers:{}}});
            if(dataState.providerMode===provider+'-unknown' && method==='POST' && (p.endsWith('/notes')||p.endsWith('/messages')))throw Object.assign(new Error('controlled lost write ACK'),{response:{status:408,headers:{}}});
            if(provider==='amocrm'){
                if(p==='/oauth2/access_token')payload={access_token:'controlled-access',refresh_token:'controlled-refresh',expires_in:3600};
                else if(p==='/api/v4/account')payload={id:101,name:'Контрольная CRM',_embedded:{task_types:[{id:1,name:'Звонок'}]}};
                else if(p==='/api/v4/leads/pipelines')payload={_embedded:{pipelines:[{id:11,name:'Контрольная воронка',_embedded:{statuses:[{id:12,name:'Новый'},{id:13,name:'Квалификация'}]}}]}};
                else if(p==='/api/v4/users')payload={_embedded:{users:[{id:21,name:'Контрольный ответственный'}]}};
                else if(p==='/api/v4/contacts/301')payload={id:301,name:'Покупатель amo fixture'};
                else if(p==='/api/v4/contacts')payload={_embedded:{contacts:[{id:301,name:'Покупатель amo fixture'}]}};
                else if(p==='/api/v4/leads')payload={_embedded:{leads:[{id:401,name:'Контрольная сделка',status_id:12,pipeline_id:11,updated_at:100,_embedded:{contacts:[{id:301,is_main:true}]}}]}};
                else if(p==='/api/v4/tasks')payload={_embedded:{tasks:[{id:501,entity_type:'leads',entity_id:401,text:'Задача из контрольной CRM',complete_till:2000000000,is_completed:false}]}};
                else if(p==='/api/v4/webhooks')payload={_embedded:{webhooks:[]}};
                else throw new Error('Unknown controlled amo boundary '+method+' '+p);
            }else{
                if(p==='/token')payload={access_token:'controlled-avito-access',expires_in:3600};
                else if(p==='/core/v1/accounts/self')payload={id:202,name:'Контрольное Авито'};
                else if(p==='/messenger/v2/accounts/202/chats')payload={chats:[{id:'chat-1',context:{value:{title:'Контрольное объявление'}},users:[{id:303,name:'Контрольный покупатель Авито'}]}]};
                else if(p==='/messenger/v2/accounts/202/chats/chat-1')payload={id:'chat-1',users:[{id:303,name:'Контрольный покупатель Авито'}]};
                else if(p==='/messenger/v3/accounts/202/chats/chat-1/messages/')payload={messages:[{id:'fixture-inbound-one',author_id:303,created:1,type:'text',content:{text:'Контрольная история Авито'}}]};
                else if(p==='/messenger/v3/webhook')payload={ok:true};
                else throw new Error('Unknown controlled avito boundary '+method+' '+p);
            }
            return {status:200,statusText:'OK',config:request,headers:{'content-type':'application/json'},data:payload};
        }
        if (url.hostname !== 'api.aitunnel.ru') return actualAdapter(request);
        let payload;
        if (request.method === 'get') payload = url.pathname.startsWith('/public/') ? { 'gpt-oss-120b': { type: 'chat' } } : { data: [{ id: 'gpt-oss-120b' }] };
        else {
            external.modelCalls++;
            const input = typeof request.data === 'string' ? JSON.parse(request.data) : request.data;
            const last = input.messages?.filter(message => message.role === 'user').at(-1)?.content || '';
            let data; try { data = JSON.parse(last); } catch (_) { data = null; }
            const content = data?.facts?.length
                ? JSON.stringify({ status: 'answered', answer: data.facts[0].summary, sourceIds: [data.facts[0].id] })
                : data?.catalog?.length ? JSON.stringify({ offerIds: [data.catalog[0].offerId] })
                : JSON.stringify({ reply: 'Тестовый ответ по данным бизнеса.', action: 'none' });
            payload = { id: 'fixture-completion-' + external.modelCalls, model: input.model, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } };
        }
        return { status: 200, statusText: 'OK', config: request, headers: { 'content-type': 'application/json' }, data: payload };
    };
    const config = require(path.join(repo, 'whatsapp_crm/src/config'));
    Object.assign(config.avaAdmin, { apiUrl: process.env.AVA_ADMIN_API_URL, serviceToken: process.env.CRM_SERVICE_API_TOKEN, timeoutMs: 1000 });
    const Outbound = service('ava-outbound.service'); Outbound.baseUrl = process.env.AVA_ADMIN_API_URL; Outbound.serviceToken = process.env.CRM_SERVICE_API_TOKEN; Outbound.timeoutMs = 1000;
    DB.run(`INSERT INTO instances(id,name,isActive,aiProvider,yandexGptKey,whatsappProvider,openWaSessionId,openWaUrl,sipCallerId,sipTrunkNumber,voiceContextName)
        VALUES(1,'Бизнес Альфа',1,'aitunnel','fixture-key','openwa','fixture-session','http://127.0.0.1:1','74950000001','fixture-trunk','fixture-voice'),
        (2,'Бизнес Бета',1,'aitunnel','fixture-key','openwa','fixture-session-two','http://127.0.0.1:1',NULL,NULL,'fixture-voice-two'),
        (3,'Чужой бизнес',1,'aitunnel','fixture-key','openwa',NULL,NULL,NULL,NULL,NULL)`);
    DB.run("INSERT INTO business_sip_aliases(alias,businessId) VALUES('74950000001',1)");
    for (const [id, role, businessId] of [['owner', 'hotel_owner', 1], ['owner', 'hotel_owner', 2], ['lead', 'sales_lead', 1], ['manager', 'manager', 1], ['observer', 'observer', 1], ['foreign', 'hotel_owner', 3]]) {
        DB.run('INSERT OR IGNORE INTO ava_users(id,subject,email,displayName,businessQuota) VALUES(?,?,?,?,3)', [id, id, id + '@example.test', { owner: 'Владелец', lead: 'Руководитель', manager: 'Менеджер', observer: 'Наблюдатель', foreign: 'Чужой владелец' }[id]]);
        DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [id, businessId, role]);
    }
    DB.run("INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,status,onyx_base_url) VALUES(1,'controlled-ui-tenant','ACTIVE','http://127.0.0.1:1')");
    const Onboarding = service('onboarding-state.service');
    for (const id of [1, 2]) { for (const step of Onboarding.STEPS) Onboarding.confirmStep(Identity.actor('owner'), id, step); Onboarding.complete(Identity.actor('owner'), id); }
    const chatId = '79990000001@c.us';
    await DB.getOrCreateClient(1, chatId, 'Тестовый покупатель');
    DB.run("UPDATE clients SET assigneeUserId='manager' WHERE instanceId=1 AND chatId=?", [chatId]);
    await DB.getOrCreateClient(2, chatId, 'Другой клиент Бета');
    service('client-identity.service').attach(1, chatId, { kind: 'telegram', value: '10001001' });
    await DB.saveMessageWithChannel(1, 'tg_10001001', 'Тестовый покупатель', 'Договорились в звонке: нужен комплект для овец.', 'user', 'telegram', null, 'fixture-telegram-one');
    const Sales = service('sales-brain.service');
    const call = await Sales.postCall({ instanceId: 1, chatId, callId: 'call-one', transcript: [{ role: 'user', content: 'Пришлите подборку электропастухов в WhatsApp, пожалуйста.' }, { role: 'assistant', content: 'Менеджер проверит предложение.' }], followup_text: 'Подготовили предложение по вашему звонку.', generate_followup: true });
    const Catalog = service('ava-autopilot.store'), Autopilot = service('ava-autopilot.service');
    const product = Autopilot.createOffer(Identity.actor('owner'), 1, { name: 'Комплект электропастуха', amountMinor: 125099, currency: 'RUB', active: true }).offer;
    const published = Autopilot.publishCatalog(Identity.actor('owner'), 1, product.id, { revision: product.revision }).offer;
    const Deals = service('customer-deals.store'), Studio = service('customer-studio.service');
    const deal = Deals.create(1, { title: 'Комплект для тестового клиента', clientChatId: chatId }, 'owner');
    Studio.save(Identity.actor('owner'), 1, deal.id, { revision: 0, dealRevision: deal.revision, text: 'Подобрали комплект для хозяйства клиента.', catalogItems: [{ offerId: published.id, offerRevision: published.revision, quantity: 1 }], idempotencyKey: 'fixture-studio' });
    const sessions = Object.fromEntries(['owner', 'lead', 'manager', 'observer', 'foreign'].map(id => [id, 'ava2:' + Identity.createSession(id, 'fixture-' + id)]));
    const app = require(path.join(repo, 'whatsapp_crm/src/app')).app;
    for (const module of ['catalog.store', 'commercial-documents.service', 'whatsapp-response-settings.service', 'whatsapp-attachments.service']) service(module).ensureSchema();
    application = app.listen(0, '127.0.0.1'); await new Promise(resolve => application.once('listening', resolve));
    const express=require(path.join(repo,'whatsapp_crm/node_modules/express'));const frontend=express();
    frontend.use('/api',(req,res)=>{const forwarded=http.request({hostname:'127.0.0.1',port:application.address().port,path:req.originalUrl,method:req.method,headers:req.headers},upstreamResponse=>{if(dataState.loseNextCommit&&req.method==='POST'&&/\/catalog-imports\/[^/]+\/commit$/.test(req.originalUrl)&&upstreamResponse.statusCode===200){dataState.loseNextCommit=false;dataState.lostCommitResponses++;upstreamResponse.resume();res.writeHead(200,{"Content-Type":"application/json","Content-Length":"99999"});res.flushHeaders();res.destroy();return;}res.writeHead(upstreamResponse.statusCode,upstreamResponse.headers);upstreamResponse.pipe(res);});forwarded.on('error',error=>{res.statusCode=502;res.end(error.code||'PROXY_ERROR');});req.pipe(forwarded);});
    frontend.use(express.static(pinnedFrontend));frontend.use((req,res)=>res.sendFile(path.join(pinnedFrontend,'index.html')));execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(fixtureDir,'key.pem'),'-out',path.join(fixtureDir,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1'],{stdio:'ignore'});staticApplication=https.createServer({key:fs.readFileSync(path.join(fixtureDir,'key.pem')),cert:fs.readFileSync(path.join(fixtureDir,'cert.pem'))},frontend).listen(0,'127.0.0.1');await new Promise(resolve=>staticApplication.once('listening',resolve));
    const origin = 'https://127.0.0.1:' + staticApplication.address().port; process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
    const snapshot = () => ({ external,
        teamMembers: DB.all('SELECT userId,businessId,role,enabled FROM ava_business_memberships ORDER BY businessId,userId'),
        teamUsers: DB.all("SELECT id,email,enabled FROM ava_users WHERE email LIKE '%@example.test'"),
        teamInvitations: DB.all('SELECT i.id,u.email,i.businessId,i.role,i.state FROM ava_invitations i JOIN ava_users u ON u.id=i.userId'),
        allTasks: DB.all('SELECT instanceId,taskId,summary,status,priority,assigneeUserId,dueAt FROM manager_tasks'),
        clientAssignments: DB.all('SELECT instanceId,chatId,assigneeUserId FROM clients'), businesses: DB.all('SELECT id,name,systemPrompt FROM instances'),
        imports: DB.all('SELECT businessId,status FROM customer_catalog_imports'),
        catalog: Catalog.publishedOffers(1).map(({ id,name,amountMinor }) => ({ id,name,amountMinor })),
        campaigns: DB.all('SELECT campaignId,status FROM outbound_campaigns'),
        commands: DB.get("SELECT 1 FROM sqlite_master WHERE name='ava_campaign_commands'") ? DB.all('SELECT campaignId,state,action FROM ava_campaign_commands') : [],
        settings: service('whatsapp-response-settings.service').get(1),
        tasks: DB.all('SELECT taskId,status,assigneeUserId FROM manager_tasks WHERE instanceId=1'),
        invoices: DB.get("SELECT 1 FROM sqlite_master WHERE name='customer_commercial_invoice_versions'") ? DB.all('SELECT businessId,dealId,revision FROM customer_commercial_invoice_versions') : [],
        documents: DB.get("SELECT 1 FROM sqlite_master WHERE name='whatsapp_document_deliveries'") ? DB.all('SELECT businessId,status,providerMessageId FROM whatsapp_document_deliveries') : [],
        messageCount: DB.get('SELECT COUNT(*) n FROM messages WHERE instanceId=1').n });
    process.on('message', async message => {
        try {
            if(message.op==='resetExternal'){const S=service('integrations/store');S.schema();for(const table of ['customer_external_exports','customer_external_callbacks','customer_external_progress','customer_external_entities','customer_external_links','customer_external_operations','customer_external_connections'])DB.run('DELETE FROM '+table+' WHERE instanceId=1');dataState.providerMode='normal';dataState.providerCalls=[];process.send({id:message.id,result:true});
            }else if(message.op==='dataSnapshot'){
                const Store=service('integrations/store');Store.schema();
                process.send({id:message.id,result:{external,...dataState,imports:DB.all('SELECT id,businessId,status,receiptJson FROM customer_catalog_imports'),catalog:Catalog.offers(1),connections:['amocrm','avito'].map(p=>Store.status(1,p)),operations:DB.all('SELECT provider,operationKey,status,errorCode FROM customer_external_operations'),tasks:DB.all('SELECT summary,status,source FROM manager_tasks'),clients:DB.all('SELECT instanceId,chatId,senderName FROM clients')}});
            }else if(message.op==='providerMode'){dataState.providerMode=message.mode;process.send({id:message.id,result:true});
            }else if(message.op==='loseNextCommit'){dataState.loseNextCommit=true;process.send({id:message.id,result:true});
            }else if(message.op==='expireImport'){const row=DB.get("SELECT id FROM customer_catalog_imports WHERE status='preview' ORDER BY createdAt DESC LIMIT 1");if(!row)throw new Error('no-preview');DB.run('UPDATE customer_catalog_imports SET expiresAt=0 WHERE id=?',[row.id]);process.send({id:message.id,result:{id:row.id}});
            }else if(message.op==='conflictRollback'){const row=DB.get("SELECT receiptJson FROM customer_catalog_imports WHERE status='committed' ORDER BY createdAt DESC LIMIT 1"),id=JSON.parse(row.receiptJson).changes[0].offerId,current=Catalog.offer(1,id);Catalog.saveOffer(1,{...current,revision:current.revision+1,amountMinor:current.amountMinor+100},current.revision);process.send({id:message.id,result:{offerId:id,revision:current.revision+1}});
            }else if(message.op==='unknownWrite'){
                const Store=service('integrations/store'),p=message.provider;dataState.providerMode=p+'-unknown';
                const link=DB.get('SELECT * FROM customer_external_links WHERE instanceId=1 AND provider=? LIMIT 1',[p]);if(!link)throw new Error('no-controlled-link');
                if(p==='amocrm'){try{await service('integrations/amocrm').syncClient(1,link.chatId,null,{kind:'note',text:'Контрольный unknown',sourceId:'controlled-unknown'});}catch(error){if(error.unknown!==true)throw error;}}
                else{const target=service('avito.service').recipient(1,link.chatId);const result=await service('avito.service').sendMessageDetailed(1,target,'Контрольный unknown',{chatId:link.chatId,idempotencyKey:'controlled-unknown',beforeSend:()=>{}});if(!result.unknown)throw new Error('expected-unknown');}
                dataState.providerMode='normal';process.send({id:message.id,result:Store.status(1,p)});
            }else if(message.op==='ageInvitationDelivery'){const changed=DB.run('UPDATE ava_team_invitation_delivery SET lastAttemptAt=?',[Date.now()-61000]);process.send({id:message.id,result:{changed:changed.changes}}); } else if (message.op === 'teamSeed') {
                const actor=Identity.actor('owner');
                for(let i=0;i<23;i++){let id='controlled-member-'+String(i).padStart(2,'0');
                    if(!DB.get('SELECT id FROM ava_users WHERE id=?',[id])){
                        DB.run('INSERT INTO ava_users(id,subject,email,displayName,businessQuota) VALUES(?,?,?,?,0)',[id,id,id+'@example.test','Контрольный сотрудник '+String(i).padStart(2,'0')]);
                        const invitation=Identity.inviteBusinessMember(actor,1,{email:id+'@example.test',role:'manager'});
                        Identity.acceptInvitation(Identity.actor(id),invitation.token);
                        if(i===0||i===2){const inv2=Identity.inviteBusinessMember(actor,2,{email:id+'@example.test',role:'manager'});Identity.acceptInvitation(Identity.actor(id),inv2.token);}
                    }
                }
                for(let i=0;i<23;i++){let email='controlled-pending-'+String(i).padStart(2,'0')+'@example.test';if(!DB.get('SELECT id FROM ava_users WHERE email=?',[email]))Identity.inviteBusinessMember(actor,1,{email,role:['manager','sales_lead','observer'][i%3]});}
                process.send({id:message.id,result:{members:Identity.listBusinessTeam(actor,1).members.length,invitations:Identity.listBusinessTeam(actor,1).invitations.length}});
            } else if(message.op==='controlledDeparture'){
                const SalesWorkspace=service('sales-workspace.service'),actor=Identity.actor('owner');
                const controlledTarget=message.userId||'controlled-member-00';const controlledChat='controlled-departure-client-'+controlledTarget;await DB.getOrCreateClient(1,controlledChat,'Контрольный клиент удаления');
                SalesWorkspace.assignClient(actor,1,controlledChat,{assigneeUserId:controlledTarget});
                const result=SalesWorkspace.createTask(actor,1,{chatId:controlledChat,summary:'Контрольная задача удаления '+controlledTarget,priority:'normal',assigneeUserId:controlledTarget,dueAt:null});
                process.send({id:message.id,result:{taskId:result.task.taskId,chatId:controlledChat}});
            } else if (message.op === 'snapshot') process.send({ id: message.id, result: snapshot() });
            else if (message.op === 'code') process.send({ id: message.id, result: latestCode });
            else if (message.op === 'close') { staticApplication.close(); application.close(); upstream.close(); DB.db.close(); process.exit(0); }
        } catch (error) { process.send({ id: message.id, error: error.code || error.message }); }
    });
    process.send({ ready: true, origin, sessions, chatId, dealId: deal.id, taskId: call.handoff_task.task_id, sourceHead, sourceDigests,
        builtIndexSha256: crypto.createHash('sha256').update(require('node:fs').readFileSync(path.join(pinnedFrontend,'index.html'))).digest('hex') });
})().catch(error => { process.send?.({ fatal: error.code || error.message, stack: error.stack }); process.exit(1); });
