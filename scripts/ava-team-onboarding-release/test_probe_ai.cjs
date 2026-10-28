'use strict';
// Run the exact probe against a synthetic SQLite copy and an axios adapter;
// no real DNS, network, credential, provider or production database is used.
const assert = require('assert'), fs = require('fs'), os = require('os');
const path = require('path'), vm = require('vm'), { createRequire } = require('module');
const app = process.env.AVA_RELEASE_APP_ROOT;
assert.ok(app && path.isAbsolute(app));
process.env.AITUNNEL_API_KEY = 'synthetic-probe-key';
process.env.AITUNNEL_API_URL = 'https://provider.example.test/v1';
process.env.AITUNNEL_MODEL = 'fixture-model';
const source = fs.readFileSync(path.join(__dirname, 'probe_ai.cjs'), 'utf8');
const r = createRequire(path.join(app, 'package.json'));
const originalConsole = Object.fromEntries(['log','info','warn','error','debug'].map(name => [name,console[name]]));
for (const name of Object.keys(originalConsole)) console[name] = () => {};
const SQLite = r('better-sqlite3'), axios = r('axios');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-probe-test-'));
const savedAdapter = axios.defaults.adapter;
async function run({ gate = '1', copyPath = '/probe/crm_v2.db', tamper = false } = {}) {
    const database = r('./tests/test-helper').createTestDB();
    r('./src/services/assistant-draft.service').ensureSchema();
    database.prepare('INSERT INTO instances(id,name,businessType,systemPrompt) VALUES (1,?,?,?)')
        .run('Existing fixture business', 'hotel', 'Existing fixture prompt');
    const filename = path.join(dir, 'copy-' + Math.random() + '.db');
    await database.backup(filename); database.close();
    let calls = 0, stdout = '';
    axios.defaults.adapter = async request => {
        calls++;
        const body = JSON.parse(request.data);
        assert.strictEqual(body.model, 'fixture-model');
        assert.strictEqual(JSON.stringify(body).includes('Existing fixture prompt'), false);
        assert.strictEqual(JSON.stringify(body).includes('Existing fixture business'), false);
        assert.strictEqual(JSON.stringify(body).includes('synthetic-probe-key'), false);
        assert.strictEqual(request.proxy, false);
        if (tamper) r('./src/services/database.service').db.prepare("UPDATE instances SET name='Tampered' WHERE id=1").run();
        return { data: { choices: [{ finish_reason: 'stop', message: { content:
            JSON.stringify({ systemPrompt: 'Учебная кофейня предлагает кофе и выпечку. Передайте заказ сотруднику.' }) } }] }, status: 200, headers: {}, config: request };
    };
    const simulatedProcess = { env: { AVA_RELEASE_REAL_AI_PROBE: gate,
        AVA_RELEASE_CANDIDATE_COMMIT: 'a'.repeat(40), DB_PATH: copyPath, AVA_RELEASE_APP_ROOT: app },
        stdout: { write: value => { stdout += value; } }, stderr: { write() {} }, exitCode: 0 };
    const wrappedRequire = name => {
        if (name === 'better-sqlite3') return function(filenameInput, options) {
            assert.strictEqual(filenameInput, '/probe/crm_v2.db');
            return new SQLite(filename, options);
        };
        return r(name);
    };
    await vm.runInNewContext(source, { process: simulatedProcess, console: {}, Buffer, URL,
        require: name => name === 'module' ? { createRequire: () => wrappedRequire }
            : name === 'fs' ? { ...fs, realpathSync: value => value }
                : name === 'dns' ? { promises: { lookup: async () => [{ address: '8.8.8.8', family: 4 }] } } : require(name) });
    return { result: JSON.parse(stdout), code: simulatedProcess.exitCode, calls };
}
(async () => {
    const valid = await run();
    assert.strictEqual(valid.code, 0); assert.strictEqual(valid.calls, 1);
    assert.strictEqual(valid.result.generated, true); assert.strictEqual(valid.result.approved, true);
    assert.strictEqual(valid.result.existingBusinessRowsPreserved, true); assert.strictEqual(valid.result.schemaPreserved, true);
    assert.strictEqual(valid.result.model, 'fixture-model');
    const corrupt = await run({ tamper: true });
    assert.strictEqual(corrupt.code, 1); assert.strictEqual(corrupt.result.existingBusinessRowsPreserved, false);
    for (const args of [{ gate: '' }, { gate: '0' }, { copyPath: '/live/crm_v2.db' }]) {
        const denied = await run(args); assert.strictEqual(denied.code, 1); assert.strictEqual(denied.calls, 0);
    }
    process.stdout.write('AI probe: 5 synthetic cases passed; no network/providers/production DB\n');
})().catch(error => { process.stderr.write('AI probe synthetic check failed: ' + error.code + '\n'); process.exitCode = 1; })
    .finally(() => { axios.defaults.adapter = savedAdapter; Object.assign(console, originalConsole); fs.rmSync(dir, { recursive: true, force: true }); });
