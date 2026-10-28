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
process.env.CHANNEL_CREDENTIALS_MASTER_KEY = 'a'.repeat(64);
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
let latestCode = '', application, upstream;
const mode={send:'success',modelDelay:0,modelFail:0};
const pinnedFrontend=path.join(fixtureDir,'frontend');fs.cpSync(process.env.AVA_UI_DIST||path.join(repo,'whatsapp_crm/frontend/dist'),pinnedFrontend,{recursive:true});
for(const key of Object.keys(sourceDigests))if(key.startsWith('whatsapp_crm/frontend/dist/'))delete sourceDigests[key];
for(const file of fs.readdirSync(pinnedFrontend,{recursive:true}).filter(file=>fs.statSync(path.join(pinnedFrontend,file)).isFile())) sourceDigests['pinned-frontend/'+file]=crypto.createHash('sha256').update(fs.readFileSync(path.join(pinnedFrontend,file))).digest('hex');
for(const file of ['whatsapp_crm/frontend/src/amoCatalogApi.ts','whatsapp_crm/frontend/src/components/AmoCatalogImport.tsx','whatsapp_crm/frontend/src/components/AmoCatalogImport.css','whatsapp_crm/frontend/src/pages/Autopilot.tsx','whatsapp_crm/frontend/src/components/ExternalIntegrationPanel.tsx','whatsapp_crm/frontend/src/pages/Simulator.tsx','whatsapp_crm/frontend/src/pages/TodayWorkspace.tsx','whatsapp_crm/frontend/src/hooks/useTodayPresence.ts','whatsapp_crm/frontend/src/hooks/useWorkspaceFeatures.ts','whatsapp_crm/frontend/src/hooks/useReleaseFlags.ts','whatsapp_crm/frontend/src/components/ReleaseControls.tsx','whatsapp_crm/frontend/src/components/WorkspaceFeatureControls.tsx'])sourceDigests[file]=crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,file))).digest('hex');

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
    Mailer._getTransporter = () => ({ sendMail: async () => { external.mailSends++; return { messageId: 'fixture-mail', accepted: ['fixture@example.test'] }; } });
    const OpenWA = service('openwa.service');
    OpenWA.getState = async () => ({ success: true, data: { stateInstance: 'authorized', rawStatus: 'ready', phone: '79990000001', engineLoaded: true } });
    OpenWA.sendMessage = async () => { external.textSends++; if(mode.send==='unknown') throw new Error('Fixture provider ACK lost after dispatch'); return { success: true, data: { messageId: 'fixture-text-' + external.textSends } }; };
    OpenWA.sendDocument = async () => { external.documentSends++; return { success: true, providerMessageId: 'fixture-pdf-' + external.documentSends, safeToRetry: false }; };
    service('ai.service');
    const axios = require(path.join(repo, 'whatsapp_crm/node_modules/axios')).default;
    const actualAdapter = axios.getAdapter(axios.defaults.adapter);
    axios.defaults.adapter = async request => {
        const url = new URL(request.url);
        if (url.hostname === 'catalog-fixture.amocrm.ru') {
            external.amoReads=(external.amoReads||0)+1;
            if(request.method.toLowerCase()!=='get')throw new Error('amo provider writes forbidden');
            if(mode.amoFail){mode.amoFail--;throw Object.assign(new Error('fixture amo timeout'),{code:'ETIMEDOUT'});}
            const envelope=(key,rows)=>({_embedded:{[key]:rows}});
            const data=url.pathname==='/api/v4/account'?{id:91001,name:'amoCRM fixture'}:
              url.pathname==='/api/v4/catalogs'?envelope('catalogs',[{id:71,type:'products',name:'Товары хозяйства'}]):
              url.pathname.endsWith('/custom_fields')?envelope('custom_fields',[{id:11,code:'PRICE',type:'numeric'},{id:12,code:'UNIT'},{id:13,code:'SKU'}]):
              url.pathname.endsWith('/elements')?envelope('elements',[{id:501,catalog_id:71,account_id:91001,name:'Катушка из amoCRM',updated_at:1792334400,custom_fields_values:[{field_id:11,values:[{value:mode.amoPrice||'2499.90'}]},{field_id:12,values:[{value:'штука'}]},{field_id:13,values:[{value:'AMO-501'}]}]}]):null;
            if(!data)throw new Error('unexpected amo fixture path '+url.pathname);
            return {status:200,statusText:'OK',config:request,headers:{'content-type':'application/json'},data};
        }
        if (url.hostname !== 'api.aitunnel.ru') return actualAdapter(request);
        let payload;
        if (request.method === 'get') payload = url.pathname.startsWith('/public/') ? { 'gpt-oss-120b': { type: 'chat' } } : { data: [{ id: 'gpt-oss-120b' }] };
        else {
            external.modelCalls++;
            if(mode.modelDelay) await new Promise(resolve=>setTimeout(resolve,mode.modelDelay));
            if(mode.modelFail>0){mode.modelFail--;throw new Error('Fixture model unavailable');}
            const input = typeof request.data === 'string' ? JSON.parse(request.data) : request.data;
            const last = input.messages?.filter(message => message.role === 'user').at(-1)?.content || '';
            let data; try { data = JSON.parse(last); } catch (_) { data = null; }
            const offerRef=data?.records?.find(record=>record.ref.startsWith('offer:'))?.ref;
            const copilot=data?.intent&&Array.isArray(data.records)?JSON.stringify(mode.copilotInvalid?{text:'Подсказка',sourceIds:['missing-source']} : data.intent==='offer'?{text:'Предлагаем вариант по каталогу: [[price:'+offerRef.slice(6)+']].',sourceIds:[offerRef],offerId:offerRef.slice(6)}:{text:data.intent==='next_action'?'Уточнить потребности клиента':'Предлагаю уточнить детали запроса.',sourceIds:[data.records[0].ref]}):null;
            const content = copilot || (data?.facts?.length
                ? JSON.stringify({ status: 'answered', answer: data.facts[0].summary, sourceIds: [data.facts[0].id] })
                : data?.catalog?.length ? JSON.stringify({ offerIds: [data.catalog[0].offerId] })
                : JSON.stringify({ reply: 'Тестовый ответ по данным бизнеса.', action: 'none' }));
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
    const AmoStore=service('integrations/store');
    AmoStore.save(1,'amocrm',{domain:'catalog-fixture.amocrm.ru'},{accessToken:'fixture-only-token',expiresAt:Date.now()+3600000});
    AmoStore.patch(1,'amocrm',{status:'connected',accountId:'91001',accountName:'Каталог тестового хозяйства'});
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
    await DB.saveMessageWithChannel(1,chatId,'Менеджер','Добрый день, проверим условия. Запрещено обещать наличие без проверки.','assistant','whatsapp',null,'residual-quality-source');
    for(const name of ['ava-analytics.service','ava-availability.service','assistant-draft.service'])service(name).ensureSchema();
    const app = require(path.join(repo, 'whatsapp_crm/src/app')).app;
    const express=require(path.join(repo,'whatsapp_crm/node_modules/express'));
    const frontend=express();frontend.use((req,res,next)=>req.path.startsWith('/api/')?app(req,res,next):next());frontend.use(express.static(pinnedFrontend));frontend.use((req,res)=>res.sendFile(path.join(pinnedFrontend,'index.html')));
    for (const module of ['catalog.store', 'commercial-documents.service', 'whatsapp-response-settings.service', 'whatsapp-attachments.service']) service(module).ensureSchema();
    if (process.env.AVA_UI_HTTPS === '1') {
        execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(fixtureDir,'key.pem'),'-out',path.join(fixtureDir,'cert.pem'),'-days','1','-subj','/CN=localhost'], { stdio: 'ignore' });
        application = https.createServer({ key: fs.readFileSync(path.join(fixtureDir,'key.pem')), cert: fs.readFileSync(path.join(fixtureDir,'cert.pem')) }, frontend).listen(0, '127.0.0.1');
    } else application = frontend.listen(0, '127.0.0.1'); await new Promise(resolve => application.once('listening', resolve));
    const origin = (process.env.AVA_UI_HTTPS === '1' ? 'https://127.0.0.1:' : 'http://127.0.0.1:') + application.address().port; process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
    const snapshot = () => ({ external,mode,
        promises:DB.all('SELECT * FROM ava_client_promises'),snoozes:DB.all('SELECT * FROM ava_workspace_snoozes'),quotes:DB.all('SELECT * FROM ava_quotes').map(r=>({...r,payload:JSON.parse(r.payloadJson)})),criteria:DB.all('SELECT * FROM ava_quality_criteria'),availability:DB.all('SELECT * FROM ava_member_availability'),assistantDrafts:DB.all('SELECT * FROM assistant_drafts'),
        actions:DB.all('SELECT id,chatId,userId,status,text,idempotencyKey,messageId FROM ava_workspace_reply_actions'),
        resolutions:DB.all('SELECT * FROM ava_workspace_reply_resolutions'),controls:DB.all('SELECT * FROM ava_conversation_control'),
        aliases:DB.all('SELECT * FROM client_aliases'),redirects:DB.all('SELECT * FROM client_redirects'),
        clients:DB.all('SELECT instanceId,chatId,senderName,assigneeUserId FROM clients'),messages:DB.all('SELECT instanceId,chatId,role,content FROM messages'),
        studio:DB.all('SELECT businessId,dealId,revision,payloadJson FROM customer_studio_material_versions'), businesses: DB.all('SELECT id,name,systemPrompt FROM instances'),
        imports: DB.all('SELECT businessId,status FROM customer_catalog_imports'),
        catalog: Catalog.publishedOffers(1).map(({ id,name,amountMinor }) => ({ id,name,amountMinor })),
        campaigns: DB.all('SELECT campaignId,status FROM outbound_campaigns'),
        commands: DB.get("SELECT 1 FROM sqlite_master WHERE name='ava_campaign_commands'") ? DB.all('SELECT campaignId,state,action FROM ava_campaign_commands') : [],
        settings: service('whatsapp-response-settings.service').get(1),
        tasks: DB.all('SELECT taskId,status,summary,assigneeUserId FROM manager_tasks WHERE instanceId=1'),
        invoices: DB.get("SELECT 1 FROM sqlite_master WHERE name='customer_commercial_invoice_versions'") ? DB.all('SELECT businessId,dealId,revision FROM customer_commercial_invoice_versions') : [],
        documents: DB.get("SELECT 1 FROM sqlite_master WHERE name='whatsapp_document_deliveries'") ? DB.all('SELECT businessId,status,providerMessageId FROM whatsapp_document_deliveries') : [],
        messageCount: DB.get('SELECT COUNT(*) n FROM messages WHERE instanceId=1').n });
    process.on('message', async message => {
        try {
            if (message.op === 'snapshot') process.send({ id: message.id, result: snapshot() });
            else if(message.op==='mode'){Object.assign(mode,message.value);process.send({id:message.id,result:mode});}
            else if(message.op==='clients'){
                for(const [id,name] of message.rows){await DB.getOrCreateClient(1,id,name);DB.run("UPDATE clients SET assigneeUserId='manager' WHERE instanceId=1 AND chatId=?",[id]);if(!DB.get('SELECT 1 FROM messages WHERE instanceId=1 AND chatId=?',[id]))await DB.saveMessageWithChannel(1,id,name,'История контакта '+id,'user','whatsapp',null,'fixture-history-'+id);}
                process.send({id:message.id,result:true});
            }
            else if(message.op==='incoming'){await DB.saveMessageWithChannel(1,chatId,'Тестовый покупатель','Новый вопрос: уточните условия для хозяйства.','user','whatsapp',null,'residual-incoming-'+Date.now());process.send({id:message.id,result:true});}
            else if(message.op==='recipient'){
                DB.run('UPDATE customer_deals SET clientChatId=?,revision=revision+1 WHERE id=? AND instanceId=1',[message.chatId,deal.id]);process.send({id:message.id,result:true});
            }
            else if(message.op==='evidence'){
                const action=DB.get("SELECT * FROM ava_workspace_reply_actions WHERE status='unknown' ORDER BY createdAt DESC LIMIT 1");
                const mid=Number(DB.run("INSERT INTO messages(instanceId,chatId,senderName,role,content,channel) VALUES(1,?,'Fixture channel','assistant',?,'whatsapp')",[action.chatId,action.text]).lastInsertRowid);
                service('ava-workspace.store').recordReplyAcknowledgement({businessId:1,chatId:action.chatId,actionId:action.id,messageId:mid,providerMessageId:'fixture-durable-'+mid});
                process.send({id:message.id,result:{actionId:action.id,messageId:mid}});
            }
            else if (message.op === 'code') process.send({ id: message.id, result: latestCode });
            else if (message.op === 'close') { application.close(); upstream.close(); DB.db.close(); process.exit(0); }
        } catch (error) { process.send({ id: message.id, error: error.code || error.message }); }
    });
    process.send({ ready: true, origin, sessions, chatId, dealId: deal.id, taskId: call.handoff_task.task_id, sourceHead, sourceDigests,
        builtIndexSha256: crypto.createHash('sha256').update(require('node:fs').readFileSync(path.join(pinnedFrontend,'index.html'))).digest('hex') });
})().catch(error => { process.send?.({ fatal: error.code || error.message, stack: error.stack }); process.exit(1); });
