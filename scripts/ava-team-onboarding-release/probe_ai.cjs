'use strict';
// Explicitly assigned real-provider probe only. Container must mount a disposable
// online-backup COPY at /probe/crm_v2.db, never any live data directory.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { createRequire } = require('module');
const output = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
process.stderr.write = () => true;
for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = () => {};
const receipt = { generated: false, approved: false, existingBusinessRowsPreserved: false,
    schemaPreserved: false, providerRequests: 0, elapsedMs: 0 };
const started = Date.now();
let db, axios, interceptor;
function requireGate(condition) { if (!condition) throw Error('PROBE_GATE_FAILED'); }
function quoted(name) { return '"' + name.replace(/"/g, '""') + '"'; }
function digestRows(database, table, syntheticId) {
    const columns = database.prepare('PRAGMA table_info(' + quoted(table) + ')').all().map(row => row.name);
    const exclude = syntheticId !== undefined && ['instances', 'assistant_drafts'].includes(table);
    const statement = database.prepare('SELECT * FROM ' + quoted(table)
        + (exclude ? ' WHERE ' + quoted(table === 'instances' ? 'id' : 'businessId') + ' != ?' : '')
        + ' ORDER BY ' + columns.map(quoted).join(','));
    statement.safeIntegers(true);
    const digest = crypto.createHash('sha256');
    let count = 0;
    for (const row of statement.iterate(...(exclude ? [syntheticId] : []))) {
        digest.update(JSON.stringify(row, (_, value) => typeof value === 'bigint' ? { integer: String(value) }
            : Buffer.isBuffer(value) ? { bytes: value.toString('base64') } : value) + '\n');
        count++;
    }
    return { count, hash: digest.digest('hex') };
}
function snapshot(database, syntheticId) {
    const objects = database.prepare('SELECT name,type,tbl_name,sql FROM sqlite_master ORDER BY name').all();
    const rows = {};
    for (const object of objects) {
        if (object.type === 'table' && !object.name.startsWith('sqlite_'))
            rows[object.name] = digestRows(database, object.name, syntheticId);
    }
    return { schema: crypto.createHash('sha256').update(JSON.stringify(objects)).digest('hex'), rows };
}
(async () => {
    requireGate(process.env.AVA_RELEASE_REAL_AI_PROBE === '1');
    requireGate(/^[a-f0-9]{40}$/.test(process.env.AVA_RELEASE_CANDIDATE_COMMIT || ''));
    requireGate(process.env.DB_PATH === '/probe/crm_v2.db' && fs.realpathSync(process.env.DB_PATH) === process.env.DB_PATH);
    const appRoot = process.env.AVA_RELEASE_APP_ROOT || '/app';
    requireGate(path.isAbsolute(appRoot));
    const r = createRequire(path.join(appRoot, 'package.json'));
    const SQLite = r('better-sqlite3');
    db = new SQLite(process.env.DB_PATH, { fileMustExist: true });
    r('sqlite-vec').load(db);
    db.pragma('foreign_keys=ON'); db.pragma('busy_timeout=10000');
    const DB = r('./src/services/database.service'); DB.db = db;
    const config = r('./src/config');
    requireGate(Boolean(config.aiTunnel.apiKey));
    const endpoint = new URL(config.aiTunnel.apiUrl.replace(/\/+$/, '') + '/chat/completions');
    requireGate(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password);
    const Pages = r('./src/services/assistant-public-pages.service');
    const addresses = await require('dns').promises.lookup(endpoint.hostname, { all: true });
    requireGate(addresses.length > 0 && addresses.every(row => Pages.isPublicAddress(row.address)));
    axios = r('axios');
    interceptor = axios.interceptors.request.use(request => {
        requireGate(new URL(request.url).href === endpoint.href && String(request.method).toLowerCase() === 'post');
        requireGate(request.maxRedirects === 0 && ++receipt.providerRequests <= 2);
        // Use direct transport; do not inherit a proxy from an operational env.
        request.proxy = false;
        return request;
    });
    const Drafts = r('./src/services/assistant-draft.service');
    requireGate(Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_drafts'").get()));
    // No initialization, migration, broker, mailer, worker or server entrypoint.
    const before = snapshot(db);
    const syntheticId = Number(db.prepare('SELECT COALESCE(MAX(id),0)+1 AS id FROM instances').get().id);
    requireGate(Number.isSafeInteger(syntheticId) && syntheticId > 0);
    db.prepare('INSERT INTO instances(id,name,businessType,systemPrompt) VALUES (?,?,?,?)')
        .run(syntheticId, 'Synthetic release probe coffee shop', 'coffee_shop', 'Unapproved fixture prompt');
    const draft = await Drafts.generate(syntheticId, { links: [], supplement:
        'Учебная синтетическая кофейня «Пример». Предлагает кофе и выпечку навынос. '
        + 'Цены и часы работы нужно уточнять у сотрудника. Общайтесь вежливо по-русски. '
        + 'Для заказа уточните напиток и пожелания, затем передайте сотруднику для подтверждения. '
        + 'Не подтверждайте оплату, наличие или готовность заказа самостоятельно.' });
    receipt.generated = draft.status === 'draft' && typeof draft.systemPrompt === 'string' && draft.systemPrompt.length > 0;
    requireGate(receipt.generated && db.prepare('SELECT systemPrompt FROM instances WHERE id=?').get(syntheticId).systemPrompt === 'Unapproved fixture prompt');
    const approved = Drafts.approve(syntheticId, { draftId: draft.id, systemPrompt: draft.systemPrompt });
    receipt.approved = approved.draft.status === 'approved'
        && db.prepare('SELECT systemPrompt FROM instances WHERE id=?').get(syntheticId).systemPrompt === draft.systemPrompt;
    requireGate(receipt.approved);
    const after = snapshot(db, syntheticId);
    receipt.schemaPreserved = before.schema === after.schema;
    receipt.existingBusinessRowsPreserved = JSON.stringify(before.rows) === JSON.stringify(after.rows);
    requireGate(receipt.schemaPreserved && receipt.existingBusinessRowsPreserved);
    requireGate(db.pragma('integrity_check').every(row => row.integrity_check === 'ok') && db.pragma('foreign_key_check').length === 0);
    const model = draft.modelReceipt?.actualModel;
    requireGate(typeof model === 'string' && /^[a-zA-Z0-9_./:-]{1,160}$/.test(model));
    receipt.model = model;
})().then(() => {
    receipt.elapsedMs = Date.now() - started;
    output(JSON.stringify(receipt) + '\n');
    process.exitCode = 0;
}).catch(() => {
    receipt.elapsedMs = Date.now() - started;
    output(JSON.stringify(receipt) + '\n');
    process.exitCode = 1;
}).finally(() => {
    if (interceptor !== undefined) axios.interceptors.request.eject(interceptor);
    if (db?.open) db.close();
});
