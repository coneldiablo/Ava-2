'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { snapshot, vectorProof } = require('./migration_probe.cjs');
const appRoot = path.resolve(process.env.AVA_APP_ROOT || path.join(__dirname, '../../whatsapp_crm'));
const appRequire = createRequire(path.join(appRoot, 'package.json'));
const SQLite = appRequire('better-sqlite3'), vec = appRequire('sqlite-vec');
const probe = path.join(__dirname, 'migration_probe.cjs');
const marker = 'SYNTHETIC_PRIVATE_PROMPT_MUST_NOT_APPEAR';

function fixture(t, { legacy = true, twentyLinked = false } = {}) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ava-migration-gate-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'copy.db');
    const env = { ...process.env, DB_PATH: file, AVA_APP_ROOT: appRoot, EMBEDDINGS_DIMENSIONS: '3' };
    const initialized = spawnSync(process.execPath, ['-e', `
        for (const key of ['log','info','warn','error','debug']) console[key]=()=>{};
        const DB=require(${JSON.stringify(path.join(appRoot, 'src/services/database.service'))});
        DB.init().then(()=>{DB.db.close();return DB.init();}).then(()=>DB.db.close()).catch(()=>process.exit(1));
    `], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(initialized.status, 0, 'real source fixture initialization failed');
    const db = new SQLite(file); vec.load(db);
    db.prepare("INSERT INTO instances(id,name,businessType,voiceAiProvider,voiceName,systemPrompt) VALUES(1,'Synthetic','hotel','google_live','LegacyVoice',?)").run(marker);
    db.exec("INSERT INTO knowledge_base(id,instanceId,filename,originalName) VALUES(1,1,'synthetic.txt','synthetic.txt')");
    db.prepare("INSERT INTO kb_chunks(id,kbId,chunkIndex,text,searchText) VALUES(1,1,0,?,?)").run(marker, marker.toLowerCase());
    db.prepare('INSERT INTO kb_chunks_vec(rowid,instanceId,embedding,chunkId,kbId,originalName) VALUES(?,?,?,?,?,?)')
        .run(9n, 1n, new Float32Array([0.125, 0.5, 1]), 1n, 1n, marker);
    db.exec('CREATE TABLE private_payloads(id INTEGER PRIMARY KEY, secret TEXT, bytes BLOB, big INTEGER, extra REAL, voiceModel TEXT)');
    db.prepare('INSERT INTO private_payloads VALUES(?,?,?,?,?,?)').run(1n, marker, Buffer.from([0, 255, 17, 0]), 9007199254740993n, 1.125, 'unrelated');
    if (twentyLinked) db.prepare('INSERT INTO twenty_workspace_links(businessId,baseUrl,workspaceId,apiKeyEncrypted,enabled) VALUES(?,?,?,?,1)')
        .run(1n, 'https://synthetic.invalid', 'synthetic-workspace', 'synthetic-credential');
    if (legacy) { db.exec('ALTER TABLE instances DROP COLUMN voiceSettings'); db.exec('ALTER TABLE instances DROP COLUMN voiceModel'); }
    db.close();
    return { directory, file, env };
}
function invoke(fixtureValue, mode, root = appRoot) {
    const result = spawnSync(process.execPath, [probe, mode], {
        env: { ...fixtureValue.env, AVA_APP_ROOT: root }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.stderr, '', 'CLI must suppress source stderr');
    assert.ok(!result.stdout.includes(marker), 'private rows must not escape');
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'CLI must produce one JSON receipt');
    return { status: result.status, receipt: JSON.parse(lines[0]) };
}
function fakeApp(fixtureValue, body) {
    const root = path.join(fixtureValue.directory, 'old-image');
    fs.mkdirSync(path.join(root, 'src/services'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.symlinkSync(path.join(appRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(root, 'src/services/database.service.js'), `
        const SQLite=require('better-sqlite3'), vec=require('sqlite-vec');
        module.exports={async init(){this.db=new SQLite(process.env.DB_PATH);vec.load(this.db);
        console.log(${JSON.stringify(marker)});console.error(${JSON.stringify(marker)});${body}}};
    `);
    return root;
}

test('real candidate DB.init only adds the two voice columns and retains vector physical rows', t => {
    const value = fixture(t);
    const beforeDb = new SQLite(value.file); vec.load(beforeDb);
    const before = snapshot(beforeDb), vector = vectorProof(before); beforeDb.close();
    assert.equal(vector.logicalRows, 1);
    assert.ok(vector.physicalTables >= 4);
    assert.ok(vector.physicalRows > 0);
    const { status, receipt } = invoke(value, 'migrate');
    if (status !== 0) {
        const diagnosticDb = new SQLite(value.file); vec.load(diagnosticDb);
        const after = snapshot(diagnosticDb, before); diagnosticDb.close();
        const changed = before.objects.filter(old => JSON.stringify(old) !== JSON.stringify(after.objects.find(next => next.type === old.type && next.name === old.name))).map(old => old.name);
        const changedDataTables = Object.entries(before.tables).filter(([name, table]) => table.count !== after.tables[name]?.count || table.digest !== after.tables[name]?.digest).map(([name]) => name);
        assert.equal(status, 0, JSON.stringify({ receipt, changedObjects: changed, objectCounts: [before.objects.length, after.objects.length], changedDataTables }));
    }
    assert.equal(receipt.existingRowsPreserved, true);
    assert.equal(receipt.exactDataFence, true);
    assert.deepEqual(receipt.addedColumns, ['voiceModel', 'voiceSettings']);
    assert.equal(receipt.vectors.logicalRows, 1);
    assert.equal(receipt.vectors.physicalDigest, vector.physicalDigest);
    assert.ok(receipt.derivedFtsIndexesRebuilt >= 1);
    const upgraded = new SQLite(value.file); vec.load(upgraded);
    assert.equal(upgraded.prepare('SELECT voiceSettings FROM instances').get().voiceSettings, '{}');
    assert.equal(upgraded.prepare('SELECT voiceName FROM instances').get().voiceName, 'LegacyVoice');
    assert.equal(upgraded.prepare('SELECT embedding FROM kb_chunks_vec').get().embedding.length, 12);
    upgraded.close();
    const replayBeforeDb = new SQLite(value.file); vec.load(replayBeforeDb); const replayBefore = snapshot(replayBeforeDb); replayBeforeDb.close();
    const replay = invoke(value, 'migrate');
    if (replay.status !== 0) {
        const afterDb = new SQLite(value.file); vec.load(afterDb); const after = snapshot(afterDb, replayBefore); afterDb.close();
        assert.equal(replay.status, 0, JSON.stringify({ receipt: replay.receipt, oldCount: replayBefore.objects.length, newCount: after.objects.length,
            changed: replayBefore.objects.filter(old => JSON.stringify(old) !== JSON.stringify(after.objects.find(next => old.name === next.name && old.type === next.type))).map(old => old.name),
            added: after.objects.filter(next => !replayBefore.objects.some(old => old.name === next.name && old.type === next.type)).map(next => next.name), columns: Object.entries(replayBefore.tables).filter(([name, table]) => JSON.stringify(table.columns)!==JSON.stringify(after.tables[name].columns)).map(([name])=>name), kinds: Object.entries(replayBefore.tables).filter(([name, table])=>table.kind!==after.tables[name].kind).map(([name])=>name), meta:[replayBefore.metadata,after.metadata] }));
    }
    assert.deepEqual(replay.receipt.addedColumns, []);
});

test('compat calls old image init/read and preserves every upgraded column and row', t => {
    const value = fixture(t, { legacy: false });
    const root = fakeApp(value, "if(this.db.prepare('SELECT voiceSettings,voiceModel FROM instances').get().voiceModel!==null)throw Error('bad')");
    const result = invoke(value, 'compat', root);
    assert.equal(result.status, 0, JSON.stringify(result.receipt));
    assert.equal(result.receipt.existingRowsPreserved, true);
    assert.deepEqual(result.receipt.addedColumns, []);
});

test('migrate fails if an existing prompt, integer, BLOB or row identity changes', t => {
    for (const mutation of [
        "UPDATE instances SET systemPrompt='corrupted'",
        'UPDATE private_payloads SET big=9007199254740992',
        "UPDATE private_payloads SET bytes=x'00ff1101'",
        'UPDATE private_payloads SET id=2',
    ]) {
        const value = fixture(t, { legacy: false });
        const result = invoke(value, 'migrate', fakeApp(value, `this.db.exec(${JSON.stringify(mutation)});`));
        assert.equal(result.status, 1);
        assert.equal(result.receipt.code, 'MIGRATION_EXISTING_DATA_CHANGED');
    }
});

test('migrate hashes physical vector storage and detects changed vector contents', t => {
    const value = fixture(t, { legacy: false });
    const root = fakeApp(value, "this.db.exec('DELETE FROM kb_chunks_vec WHERE rowid=9');this.db.prepare('INSERT INTO kb_chunks_vec(rowid,instanceId,embedding,chunkId,kbId,originalName) VALUES(?,?,?,?,?,?)').run(9n,1n,new Float32Array([0.25,0.5,1]),1n,1n,'changed');");
    const result = invoke(value, 'migrate', root);
    assert.equal(result.status, 1);
    assert.equal(result.receipt.code, 'MIGRATION_EXISTING_DATA_CHANGED');
});

test('migrate rejects extra columns, changed defaults, dropped indexes and new tables', t => {
    for (const mutation of [
        'ALTER TABLE instances ADD COLUMN unrelated TEXT',
        'ALTER TABLE instances DROP COLUMN voiceSettings; ALTER TABLE instances ADD COLUMN voiceSettings TEXT',
        'DROP INDEX idx_kb_chunks_kbId',
        'CREATE TABLE unexpected(id INTEGER)',
    ]) {
        const value = fixture(t, { legacy: false });
        const result = invoke(value, 'migrate', fakeApp(value, `this.db.exec(${JSON.stringify(mutation)});`));
        assert.equal(result.status, 1);
        assert.ok(['MIGRATION_SCHEMA_CHANGED', 'MIGRATION_VOICE_COLUMNS_INVALID'].includes(result.receipt.code));
    }
});

test('apply validates init/new columns without rejecting legitimate business writes', t => {
    const value = fixture(t, { legacy: false });
    const root = fakeApp(value, "this.db.exec(\"UPDATE instances SET name='legitimate update'\");");
    const result = invoke(value, 'apply', root);
    assert.equal(result.status, 0, JSON.stringify(result.receipt));
    assert.equal(result.receipt.exactDataFence, false);
    assert.equal(Object.hasOwn(result.receipt, 'existingRowsPreserved'), false);
    assert.equal(Object.hasOwn(result.receipt, 'existingDataDigest'), false);
});

test('compat fails if old init rewrites upgraded data', t => {
    const value = fixture(t, { legacy: false });
    const result = invoke(value, 'compat', fakeApp(value, "this.db.exec(\"UPDATE instances SET voiceName='erased'\");"));
    assert.equal(result.status, 1);
    assert.equal(result.receipt.code, 'MIGRATION_EXISTING_DATA_CHANGED');
});

test('FTS rebuild allowance never exempts changed logical text or rowids', t => {
    for (const mutation of ["UPDATE kb_chunks_fts SET searchText='changed'", 'UPDATE kb_chunks_fts SET rowid=2']) {
        const value = fixture(t, { legacy: false });
        const result = invoke(value, 'compat', fakeApp(value, `this.db.exec(${JSON.stringify(mutation)});`));
        assert.equal(result.status, 1);
        assert.equal(result.receipt.code, 'MIGRATION_EXISTING_DATA_CHANGED');
    }
});

test('offline guard rejects networking and job timers without unsafe stdout', t => {
    for (const activity of ["await fetch('https://example.invalid')", 'setInterval(()=>{},1)']) {
        const value = fixture(t, { legacy: false });
        const result = invoke(value, 'apply', fakeApp(value, activity));
        assert.equal(result.status, 1);
        assert.equal(result.receipt.code, 'MIGRATION_OFFLINE_ACTIVITY_DENIED');
    }
});

test('missing DB_PATH, relative paths, symlinks and invalid modes fail closed', t => {
    const value = fixture(t);
    for (const [mode, dbPath] of [['apply', 'relative.db'], ['apply', ''], ['invalid', value.file], ['apply', path.join(value.directory, 'missing.db')]]) {
        const result = invoke({ ...value, env: { ...value.env, DB_PATH: dbPath } }, mode);
        assert.equal(result.status, 1);
        assert.equal(result.receipt.ok, false);
    }
    const alias = path.join(value.directory, 'symlink.db'); fs.symlinkSync(value.file, alias);
    assert.equal(invoke({ ...value, env: { ...value.env, DB_PATH: alias } }, 'apply').receipt.code, 'MIGRATION_INPUT_INVALID');
});

test('inaccessible application source fails explicitly before touching the database', t => {
    const value = fixture(t, { legacy: false });
    const root = fakeApp(value, "this.db.exec(\"UPDATE instances SET name='must not run'\");");
    const source = path.join(root, 'src/services/database.service.js');
    fs.chmodSync(source, 0);
    const before = fs.readFileSync(value.file);
    let result;
    if (process.getuid?.() === 0) {
        // Root bypasses mode bits. Execute the helper as an unprivileged UID.
        fs.chmodSync(value.directory, 0o755); fs.chmodSync(value.file, 0o644);
        const child = spawnSync(process.execPath, [probe, 'apply'], { uid: 65534, gid: 65534,
            env: { ...value.env, AVA_APP_ROOT: root }, encoding: 'utf8', timeout: 30000 });
        assert.equal(child.stderr, '');
        result = { status: child.status, receipt: JSON.parse(child.stdout) };
    } else result = invoke(value, 'apply', root);
    assert.equal(result.status, 1);
    assert.deepEqual(result.receipt, { ok: false, mode: 'apply', code: 'MIGRATION_APP_SOURCE_UNREADABLE', stage: 'APP_SOURCE' });
    assert.deepEqual(fs.readFileSync(value.file), before);
    fs.chmodSync(source, 0o600);
});

test('missing application source fails explicitly without initializing storage', t => {
    const value = fixture(t, { legacy: false });
    const root = fakeApp(value, '');
    fs.unlinkSync(path.join(root, 'src/services/database.service.js'));
    const before = fs.readFileSync(value.file);
    const result = invoke(value, 'migrate', root);
    assert.equal(result.status, 1);
    assert.deepEqual(result.receipt, { ok: false, mode: 'migrate', code: 'MIGRATION_APP_SOURCE_MISSING', stage: 'APP_SOURCE' });
    assert.deepEqual(fs.readFileSync(value.file), before);
});

test('an unsolicited Twenty outbox insertion fails with safe table/count diagnostics', t => {
    const value = fixture(t, { legacy: false });
    const root = fakeApp(value, `this.db.exec("INSERT INTO twenty_sync_outbox(eventId,businessId,entityType,sourceTable,sourceId,operation,payloadJson,status,nextAttemptAt) VALUES('synthetic-probe',1,'hotel','instances','1','upsert','{}','PENDING',CURRENT_TIMESTAMP)");`);
    const result = invoke(value, 'migrate', root);
    assert.equal(result.status, 1);
    assert.deepEqual(result.receipt, { ok: false, mode: 'migrate', code: 'MIGRATION_EXISTING_DATA_CHANGED',
        stage: 'ROW_DIGEST', table: 'twenty_sync_outbox', beforeCount: 0, afterCount: 1 });
});

test('real DB.init voice migration does not dispatch an enabled existing Twenty business', t => {
    const value = fixture(t, { twentyLinked: true });
    const before = new SQLite(value.file).prepare('SELECT count(*) AS n FROM twenty_sync_outbox').get().n;
    const result = invoke(value, 'migrate');
    assert.equal(result.status, 0, JSON.stringify(result.receipt));
    assert.equal(result.receipt.existingRowsPreserved, true);
    const db = new SQLite(value.file);
    assert.equal(db.prepare('SELECT count(*) AS n FROM twenty_sync_outbox').get().n, before);
    assert.equal(db.prepare('SELECT voiceSettings FROM instances').get().voiceSettings, '{}');
    db.close();
});
