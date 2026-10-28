'use strict';
process.env.DOTENV_CONFIG_QUIET = 'true';
// Controlled two-runtime fixture. Every document and recipient is synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(process.argv[2] || process.env.LUD_REPO || '.');
const checkoutRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
assert.equal(checkoutRevision.status, 0);
const productChanges = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', 'whatsapp_crm/src', 'src/core'], { cwd: repo, encoding: 'utf8' });
assert.equal(productChanges.status, 0);
const { createRequire } = require('node:module');
const req = createRequire(path.join(repo, 'whatsapp_crm/package.json'));
const root = path.join(repo, 'whatsapp_crm');
const service = name => req(path.join(root, 'src/services', name));
const SQLite = req('better-sqlite3');
const axios = req('axios');
const DB = service('database.service');
const RAG = service('rag.service');
const Native = service('customer-native-knowledge.service');
const Onyx = service('onyx-knowledge.service');
const WA = service('whatsapp.service');
const OpenWA = service('openwa.service');
const AI = service('ai.service');
const PMS = service('pms/pms-intent.service');
const Logger = req(path.join(root, 'src/utils/logger'));
const config = req(path.join(root, 'src/config'));
const { createTestDB } = req(path.join(root, 'tests/test-helper'));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-lud-fixture-'));
const dbPath = path.join(sandbox, 'fixture.db');
const evidence = [];
let providerMode = 'normal';
let trace = [];
const original = { post: axios.post, ai: AI.getResponse, pms: PMS.handle, state: OpenWA.getState, send: OpenWA.sendMessage };
const originalsLogger = {};
for (const k of ['info','warn','error','debug','success']) { originalsLogger[k] = Logger[k]; Logger[k] = () => {}; }
const sent = [];
function bridge(body, mode = providerMode) {
    const result = spawnSync(process.env.LUD_PYTHON || 'python3', [path.join(__dirname, 'lud-runtime-bridge.py')], {
        input: JSON.stringify({ ...body, repo, db: dbPath, mode }), encoding: 'utf8', timeout: 15000,
        env: { ...process.env, DB_PATH: dbPath },
    });
    assert.equal(result.status, 0, `bridge failed: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    trace = output.trace;
    return output.result;
}
async function check(name, fn) { await fn(); evidence.push({ requirement: name, status: 'PASS' }); }
async function main() {
    const initial = createTestDB();
    await initial.backup(dbPath);
    initial.close();
    DB.db = new SQLite(dbPath);
    DB.db.exec(`CREATE TABLE lud_fixture_index(external_id TEXT PRIMARY KEY,business_id INTEGER,document_set TEXT,content_hash TEXT,content TEXT);`);
    RAG.embeddingsInitialized = true; RAG.embeddingsAvailable = false; RAG.vectorSearchAvailable = false;
    config.rag.hydeEnabled = false; config.cohere.rerankingEnabled = false; config.rag.minConfidence = 0.05;
    process.env.CRM_SERVICE_API_TOKEN = 'synthetic-fixture-token';
    process.env.AVA_ADMIN_API_URL = 'http://runtime.fixture.invalid';
    axios.post = async (url, body) => {
        assert.equal(url, 'http://runtime.fixture.invalid/api/internal/onyx/knowledge');
        return { data: bridge(body) };
    };
    AI.getResponse = async () => { throw Object.assign(new Error('Generic model must not replace scoped answer'), { code: 'FIXTURE_UNEXPECTED_MODEL' }); };
    PMS.handle = async () => ({ handled: false });
    OpenWA.getState = async () => ({ success: true, data: { stateInstance: 'authorized', rawStatus: 'ready', engineLoaded: true } });
    OpenWA.sendMessage = async (_url, _key, session, chat, text) => {
        sent.push({ session, chat, text });
        return { success: true, data: { idMessage: `synthetic-ack-${sent.length}` } };
    };
    const a = await DB.createInstance({ name: 'Synthetic Alpha', isActive: 1 });
    const b = await DB.createInstance({ name: 'Synthetic Beta', isActive: 1 });
    const c = await DB.createInstance({ name: 'Synthetic Empty', isActive: 1 });
    for (const business of [a,b,c]) {
        await DB.updateInstance(business.id, { whatsappProvider: 'openwa', openWaSessionId: `fixture-session-${business.id}` });
        DB.run("INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,cc_pair_id,status) VALUES(?,?,?,?,'ACTIVE_LIVE')", [business.id, `hotel_${business.id}`, 'http://fixture.invalid/api', business.id]);
        DB.run("INSERT INTO onyx_agent_bindings(business_id,role,onyx_base_url,persona_id,document_set_id,document_set_name,model_configuration_id,search_tool_id) VALUES(?,'sales',?,?,?,?,1,1)", [business.id, 'http://fixture.invalid/api', business.id, business.id, `fixture-set-${business.id}`]);
    }
    const upload = async (business, time) => {
        const doc = await RAG.processDocument(business.id, Buffer.from(`Правила синтетического отеля. Заезд после ${time}. Выезд до 12:00. Информация для посетителей гостиницы.`, 'utf8'), 'rules.txt', 'text/plain');
        assert.equal(doc.success, true);
        const autoQueued = DB.get("SELECT COUNT(*) AS n FROM onyx_sync_outbox WHERE business_id=? AND source_id=? AND operation='UPSERT' AND status IN ('PENDING','RETRY','PROCESSING')", [business.id, doc.kbId]).n > 0;
        if (process.argv.includes('--require-auto-sync')) assert.ok(autoQueued, 'Upload must enqueue native sync without manual action');
        if (!autoQueued) Native.enqueue(business.id, doc.kbId);
        return doc.kbId;
    };
    const docA = await upload(a, '14:17');
    const docB = await upload(b, '18:43');
    const chat = 'synthetic-guest@c.us';
    await check('real Node enqueue → Python client/worker ingest failure → expired lease recovery → dynamic index and links', async () => {
        assert.equal(DB.get('SELECT COUNT(*) AS n FROM lud_fixture_index').n, 0);
        const failed = bridge({ action: 'sync' }, 'ingest-error');
        assert.deepEqual(failed.completed, [false, false]);
        assert.equal(DB.get("SELECT COUNT(*) AS n FROM onyx_sync_outbox WHERE status='RETRY' AND attempts=1").n, 2);
        DB.run("UPDATE onyx_sync_outbox SET next_attempt_at='2000-01-01 00:00:00' WHERE status='RETRY'");
        assert.equal(bridge({ action: 'lease' }).leased, 2);
        DB.run("UPDATE onyx_sync_outbox SET leased_until='2000-01-01 00:00:00' WHERE status='PROCESSING'");
        const recovered = bridge({ action: 'sync' });
        assert.deepEqual(recovered.completed, [true, true]);
        assert.equal(DB.get('SELECT COUNT(*) AS n FROM lud_fixture_index').n, 2);
        assert.equal(DB.get('SELECT COUNT(*) AS n FROM onyx_document_links').n, 2);
        assert.equal(DB.get("SELECT COUNT(*) AS n FROM onyx_sync_outbox WHERE status='COMPLETED'").n, 2);
    });
    await check('actual local upload, chunk persistence and own-business retrieval', async () => {
        const ar = await RAG.buildConversationContext(a.id, null, 'Когда заезд?');
        const br = await RAG.buildConversationContext(b.id, null, 'Когда заезд?');
        assert.ok(ar.context.includes('14:17') && !ar.context.includes('18:43'));
        assert.ok(br.context.includes('18:43') && !br.context.includes('14:17'));
    });
    await check('real Node WhatsApp → real Python runtime/runner → scoped fixture index → gateway ACK → SQLite assistant', async () => {
        for (const [business, time] of [[a,'14:17'],[b,'18:43']]) {
            await DB.saveMessage(business.id, chat, 'Synthetic Guest', 'Когда заезд?', 'user', null, `fixture-inbound-${business.id}`);
            await WA._processBatch(business.id, chat, { text: 'Когда заезд?' }, { isStale: () => false });
            const messages = await DB.getMessages(business.id, chat);
            assert.equal(messages.filter(m => m.role === 'assistant').length, 1);
            assert.ok(messages.find(m => m.role === 'assistant').content.includes(time));
            assert.equal(sent.at(-1).session, `fixture-session-${business.id}`);
            assert.ok(trace.includes('end-incognito-session'));
        }
        assert.equal(sent.length, 2);
    });
    const question = business_id => ({ business_id, question: 'Когда заезд?', channel: 'whatsapp', correlation_id: 'fixture-request' });
    await check('foreign citations, stale hashes, no citations and provider errors fail closed', async () => {
        for (const mode of ['foreign','stale','uncited','error']) {
            providerMode = mode;
            assert.equal(await Onyx.answer({ businessId: a.id, question: 'Когда заезд?', channel: 'whatsapp', chatId: chat }), null);
            assert.ok(trace.includes('end-incognito-session'));
        }
        providerMode = 'normal';
    });
    await check('empty/indexing source never returns verified business fact', async () => {
        const empty = bridge(question(c.id));
        assert.equal(empty.handled, false);
        DB.run("UPDATE onyx_tenant_links SET status='STAGING' WHERE business_id=?", [a.id]);
        assert.equal(bridge(question(a.id)).handled, false);
        assert.deepEqual(trace, []);
        DB.run("UPDATE onyx_tenant_links SET status='ACTIVE_LIVE' WHERE business_id=?", [a.id]);
    });
    await check('cancelled runner stops turn before deleting private session', async () => {
        assert.equal(bridge(question(a.id), 'cancel').cancelled, true);
        assert.deepEqual(trace.slice(-2), ['stop-chat-session','end-incognito-session']);
    });
    await check('current DB edit rejects old indexed source, revised index restores cited fact', async () => {
        const chunk = DB.getDocumentChunks(a.id, docA)[0];
        DB.updateChunkContent(a.id, chunk.id, chunk.text.replace('14:17', '16:29'), null);
        assert.equal(bridge(question(a.id)).handled, false);
        Native.enqueue(a.id, docA);
        assert.deepEqual(bridge({ action: 'sync' }).completed, [true]);
        const current = bridge(question(a.id));
        assert.equal(current.handled, true); assert.ok(current.answer.includes('16:29'));
        assert.equal(current.citations[0].source_id, docA);
    });
    await check('foreign document deletion rejected; local deletion fences stale index', async () => {
        assert.throws(() => Native.remove(a.id, docB), { code: 'DOCUMENT_NOT_FOUND' });
        assert.equal(Native.remove(a.id, docA).deleted, 1);
        assert.equal(bridge(question(a.id)).handled, false);
        assert.deepEqual(bridge({ action: 'sync' }).completed, [true]);
        assert.equal(DB.get('SELECT COUNT(*) AS n FROM lud_fixture_index WHERE business_id=?', [a.id]).n, 0);
        assert.equal(DB.get('SELECT COUNT(*) AS n FROM onyx_document_links WHERE business_id=?', [a.id]).n, 0);
        assert.equal(bridge(question(b.id)).handled, true);
    });
    console.log(JSON.stringify({ mode: 'controlled-runtime-fixture', repo, revision: checkoutRevision.stdout.trim(), productWorkingTreeDirty: Boolean(productChanges.stdout.trim()), requireAutoSync: process.argv.includes('--require-auto-sync'), evidence,
        limitations: ['Native index/LLM/provider are controlled synthetic transports.', 'Tenant/agent configuration is synthetic; document links are created by the real sync worker.', 'Baseline explicitly enqueues sync; --require-auto-sync enforces automatic upload enqueue on recovery candidates.', 'No live delivery or browser acceptance claimed.'] }, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
    axios.post = original.post; AI.getResponse = original.ai; PMS.handle = original.pms;
    OpenWA.getState = original.state; OpenWA.sendMessage = original.send;
    Object.assign(Logger, originalsLogger);
    if (DB.db?.open) DB.db.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
    setTimeout(() => process.exit(process.exitCode || 0), 25);
});
