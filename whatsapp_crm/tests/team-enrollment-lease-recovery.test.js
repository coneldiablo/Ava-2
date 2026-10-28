'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const { KeycloakAdmin } = require('../src/services/identity/keycloak-admin');
const { recover, StoppedWorkerInspector } = require('../src/services/identity/team-enrollment-lease-recovery');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const workerId = 'a'.repeat(64), lease = 'L'.repeat(43);
const leaseDigest = crypto.createHash('sha256').update(lease).digest('hex');
const scope = extra => ({ invitationId: 'invite', leaseDigest, workerContainerId: workerId, providerQuiescent: true, ...extra });
async function environment(fn) {
    const env = { AVA_PROCESS_ROLE: 'provisioning-worker', AVA_OIDC_ISSUER: 'https://identity.example.test/realms/ava', AVA_IDENTITY_ADMIN_ORIGIN: undefined };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    createTestDB(); Identity.ensureSchema();
    const now = Date.now();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Fixture business')");
    DB.run("INSERT INTO ava_users(id,email,enabled) VALUES ('staff','staff@example.test',0)");
    DB.run("INSERT INTO ava_invitations(id,tokenHash,userId,businessId,role,expiresAt,state,leaseToken,leasedUntil,createdBy,acceptanceMode) VALUES ('invite',?,'staff',1,'manager',?,'redeeming',?,?,'fixture','team')", ['b'.repeat(64), now + 3600000, lease, now - 2000]);
    DB.run("INSERT INTO ava_team_email_verifications(id,invitationId,invitationTokenHash,email,passwordEncrypted,codeHash,resendAfterMs,expiresAtMs,createdAtMs,verifiedAtMs) VALUES ('proof','invite',?,'staff@example.test','encrypted-fixture','fixture',?,?,?,?)", ['b'.repeat(64), now - 1000, now + 900000, now - 120000, now - 100000]);
    try { await fn(); } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
function docker({ patch = {}, siblings = [], onGet = () => {} } = {}) {
    const now = Date.now(), calls = [];
    const labels = { 'com.docker.compose.project': 'fixture', 'com.docker.compose.service': 'provisioning_worker' };
    const value = { Id: workerId, RestartCount: 0, Config: { Labels: labels }, State: {
        Running: false, Restarting: false, Paused: false, Dead: false, Status: 'exited',
        StartedAt: new Date(now - 120000).toISOString(), FinishedAt: new Date(now - 1000).toISOString(), ...patch,
    } };
    const inspector = new StoppedWorkerInspector({ get: async apiPath => {
        calls.push(apiPath); onGet(apiPath, value, calls.length);
        if (apiPath.includes('?all=')) return [{ Id: workerId, Labels: labels, State: 'exited' }, ...siblings];
        return value;
    } });
    return { inspector, value, calls };
}
function provider({ absent = true, patch = {}, emailConflict = false, sessions = [], onRequest = () => {} } = {}) {
    const calls = [];
    const native = { id: 'native-staff', username: 'ava-staff', email: 'staff@example.test', enabled: false,
        attributes: { avaUserId: ['staff'] }, ...patch };
    const admin = new KeycloakAdmin({ request: async request => {
        calls.push(request); onRequest(request, native);
        if (request.url.endsWith('/token')) return { data: { access_token: 'fixture', expires_in: 300 } };
        if (request.method !== 'GET') throw new Error('unexpected account mutation');
        if (request.url.endsWith('/sessions')) return { data: sessions };
        if (request.url.includes('/users?email') && emailConflict) return { data: [{ ...native, id: 'foreign' }] };
        if (request.url.includes('/users?')) return { data: absent ? [] : [native] };
        return { data: native };
    } });
    return { admin, native, calls };
}
async function run(extra = {}, dependencies = {}) {
    const stopped = dependencies.stopped || docker(), native = dependencies.native || provider();
    const result = await recover(scope({ inspector: stopped.inspector, admin: native.admin, ...extra }));
    return { result, stopped, native };
}
describe('Explicit stopped-worker staff enrollment lease recovery', () => {
    it('defaults to read-only dry run and apply clears exact expired redeeming lease with native absent', () => environment(async () => {
        const dry = await run();
        assert.strictEqual(dry.result.status, 'recovery_required'); assert.strictEqual(dry.result.changed, false);
        assert.strictEqual(DB.get('SELECT leaseToken FROM ava_invitations').leaseToken, lease);
        const applied = await run({ apply: true });
        assert.strictEqual(applied.result.status, 'recovered'); assert.strictEqual(applied.result.state, 'pending');
        assert.deepStrictEqual(DB.get('SELECT state,leaseToken,leasedUntil FROM ava_invitations'), { state: 'pending', leaseToken: null, leasedUntil: null });
        assert.strictEqual(DB.get('SELECT enabled,subject FROM ava_users').enabled, 0);
        assert.ok(applied.native.calls.every(call => call.method === 'GET' || call.url.endsWith('/token')));
        assert.strictEqual(applied.stopped.calls.length, 6);
        for (const apiPath of applied.stopped.calls.filter(item => item.includes('?'))) {
            const filters = JSON.parse(new URL(apiPath, 'http://docker').searchParams.get('filters'));
            assert.deepStrictEqual(filters, { label: ['com.docker.compose.service=provisioning_worker'] });
        }
        await assert.rejects(run({ apply: true }), { code: 'TEAM_LEASE_LOCAL_CONFLICT' });
    }));
    it('allows only exact disabled native account with no sessions and preserves revoked invitation', () => environment(async () => {
        DB.run("UPDATE ava_invitations SET state='revoked'");
        const native = provider({ absent: false });
        const result = await run({ apply: true }, { native });
        assert.strictEqual(result.result.state, 'revoked'); assert.strictEqual(result.result.nativeState, 'disabled_no_sessions');
        assert.ok(native.calls.some(call => call.url.endsWith('/sessions')));
        assert.ok(native.calls.every(call => call.method === 'GET' || call.url.endsWith('/token')));
    }));
    it('successful dry run works against readonly query_only SQLite with unchanged file', () => environment(async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-lease-readonly-'));
        const dbPath = path.join(directory, 'fixture.db'), original = DB.db;
        await original.backup(dbPath);
        const before = fs.readFileSync(dbPath);
        try {
            DB.db = new Database(dbPath, { readonly: true, fileMustExist: true }); DB.db.pragma('query_only=ON');
            const dry = await run(); assert.strictEqual(dry.result.status, 'recovery_required');
            assert.strictEqual(DB.get('SELECT leaseToken FROM ava_invitations').leaseToken, lease);
            assert.deepStrictEqual(fs.readFileSync(dbPath), before);
        } finally { DB.db.close(); DB.db = original; fs.rmSync(directory, { recursive: true, force: true }); }
    }));
    for (const [label, sql] of [
        ['unexpired lease', 'UPDATE ava_invitations SET leasedUntil=leasedUntil+3600000'],
        ['enabled local user', 'UPDATE ava_users SET enabled=1'],
        ['subject already bound', "UPDATE ava_users SET subject='native-staff'"],
        ['non-team invitation', "UPDATE ava_invitations SET acceptanceMode='legacy'"],
        ['non-staff role', "UPDATE ava_invitations SET role='hotel_owner'"],
        ['inactive business', 'UPDATE instances SET isActive=0'],
        ['active membership', "INSERT INTO ava_business_memberships(userId,businessId,role) VALUES ('staff',1,'manager')"],
        ['active session', "INSERT INTO ava_sessions(tokenHash,userId,expiresAt) VALUES ('session','staff',9999999999999)"],
        ['pending revocation', "INSERT INTO ava_identity_outbox(id,userId,action,nextAttemptAt) VALUES ('job','staff','revoke_sessions',0)"],
        ['other lease', "INSERT INTO ava_invitations(id,tokenHash,userId,businessId,role,expiresAt,leaseToken,createdBy,acceptanceMode) VALUES ('other','other-hash','staff',1,'manager',9999999999999,'other-lease','fixture','team')"],
        ['consumed enrollment', "INSERT INTO ava_invitations(id,tokenHash,userId,businessId,role,expiresAt,state,createdBy,acceptanceMode) VALUES ('other','other-hash','staff',1,'manager',9999999999999,'consumed','fixture','team')"],
        ['completed proof', 'UPDATE ava_team_email_verifications SET completedAtMs=verifiedAtMs'],
        ['duplicate email', "INSERT INTO ava_users(id,email,enabled) VALUES ('duplicate','STAFF@example.test',0)"],
    ]) it(`keeps barrier for ${label}`, () => environment(async () => {
        DB.run(sql); const stopped = docker(), native = provider();
        await assert.rejects(run({ apply: true }, { stopped, native }), { code: 'TEAM_LEASE_LOCAL_CONFLICT' });
        assert.strictEqual(DB.get("SELECT leaseToken FROM ava_invitations WHERE id='invite'").leaseToken, lease);
        assert.strictEqual(stopped.calls.length + native.calls.length, 0);
    }));
    for (const patch of [{ Running: true }, { Restarting: true }, { Paused: true }, { Dead: true },
        { Status: 'created' }, { FinishedAt: '0001-01-01T00:00:00Z' }, { FinishedAt: new Date(Date.now() + 3600000).toISOString() },
        { FinishedAt: new Date(Date.now() - 120000).toISOString() }]) it(`refuses inadequate worker stop evidence ${Object.keys(patch)[0]}`, () => environment(async () => {
        await assert.rejects(run({ apply: true }, { stopped: docker({ patch }) }), { code: 'TEAM_LEASE_WORKER_NOT_STOPPED' });
        assert.strictEqual(DB.get('SELECT leaseToken FROM ava_invitations').leaseToken, lease);
    }));
    for (const state of ['running', 'restarting', 'exited']) it(`refuses cross-project replacement worker even when ${state}`, () => environment(async () => {
        const stopped = docker({ siblings: [{ Id: 'c'.repeat(64), State: state,
            Labels: { 'com.docker.compose.project': 'other-project', 'com.docker.compose.service': 'provisioning_worker' } }] });
        await assert.rejects(run({ apply: true }, { stopped }), { code: 'TEAM_LEASE_WORKER_SET_CONFLICT' });
        assert.strictEqual(DB.get('SELECT leaseToken FROM ava_invitations').leaseToken, lease);
    }));
    it('refuses worker change between inspections and final worker restart', () => environment(async () => {
        const changed = docker({ onGet: (_, value, count) => { if (count === 4) value.State.FinishedAt = new Date(Date.now() - 100).toISOString(); } });
        await assert.rejects(run({ apply: true }, { stopped: changed }), { code: 'TEAM_LEASE_WORKER_CHANGED' });
        const restarted = docker({ onGet: (_, value, count) => { if (count === 6) value.State.Running = true; } });
        await assert.rejects(run({ apply: true }, { stopped: restarted }), { code: 'TEAM_LEASE_WORKER_NOT_STOPPED' });
        assert.strictEqual(DB.get('SELECT leaseToken FROM ava_invitations').leaseToken, lease);
    }));
    for (const nativeOptions of [{ absent: false, patch: { enabled: true } }, { absent: false, patch: { username: 'foreign' } },
        { absent: false, patch: { email: 'foreign@example.test' } }, { absent: false, patch: { attributes: { avaUserId: ['foreign'] } } },
        { absent: false, sessions: [{ id: 'session' }] }, { emailConflict: true }]) it(`refuses ambiguous or active native account ${JSON.stringify(Object.keys(nativeOptions))}`, () => environment(async () => {
        const native = provider(nativeOptions);
        await assert.rejects(run({ apply: true }, { native }), { code: 'TEAM_LEASE_NATIVE_CONFLICT' });
        assert.strictEqual(DB.get('SELECT leaseToken FROM ava_invitations').leaseToken, lease);
        assert.ok(native.calls.every(call => call.method === 'GET' || call.url.endsWith('/token')));
    }));
    it('rechecks DB state after auth await and inside final transaction before CAS', () => environment(async () => {
        const native = provider({ onRequest: request => { if (request.url.endsWith('/token')) DB.run("UPDATE ava_users SET enabled=1 WHERE id='staff'"); } });
        await assert.rejects(run({ apply: true }, { native }), { code: 'TEAM_LEASE_LOCAL_CONFLICT' });
        assert.strictEqual(native.calls.length, 1);
        DB.run('UPDATE ava_users SET enabled=0');
        const stopped = docker({ onGet: (_, __, count) => { if (count === 6) DB.run("UPDATE ava_invitations SET leaseToken=? WHERE id='invite'", ['N'.repeat(43)]); } });
        await assert.rejects(run({ apply: true }, { stopped }), { code: 'TEAM_LEASE_LOCAL_CONFLICT' });
        assert.strictEqual(DB.get('SELECT leaseToken FROM ava_invitations').leaseToken, 'N'.repeat(43));
    }));
    it('detects invitation/proof drift and provider failure without clearing barrier', () => environment(async () => {
        const drift = provider({ onRequest: request => { if (request.url.includes('/users?email')) DB.run("UPDATE ava_team_email_verifications SET email='changed@example.test'"); } });
        await assert.rejects(run({ apply: true }, { native: drift }), { code: 'TEAM_LEASE_LOCAL_CHANGED' });
        const offline = provider({ onRequest: request => { if (!request.url.endsWith('/token')) throw new Error('private provider detail'); } });
        await assert.rejects(run({ apply: true }, { native: offline }), { code: 'IDENTITY_PROVIDER_UNAVAILABLE' });
        assert.strictEqual(DB.get('SELECT leaseToken FROM ava_invitations').leaseToken, lease);
    }));
    it('requires exact digest/full worker ID, explicit provider quiescence and worker role', () => environment(async () => {
        for (const override of [{ providerQuiescent: false }, { workerContainerId: workerId.slice(0, 12) }, { leaseDigest: lease }]) {
            await assert.rejects(run(override), { code: 'TEAM_LEASE_SCOPE_REQUIRED' });
        }
        await assert.rejects(run({ leaseDigest: 'd'.repeat(64) }), { code: 'TEAM_LEASE_LOCAL_CONFLICT' });
        process.env.AVA_PROCESS_ROLE = 'crm'; await assert.rejects(run(), { code: 'IDENTITY_WORKER_REQUIRED' });
    }));
    it('actual CLI succeeds in default readonly dry-run using synthetic Docker/native transport and preserves database bytes', () => environment(async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-lease-cli-success-'));
        const dbPath = path.join(directory, 'fixture.db'), receiptPath = path.join(directory, 'receipt.json');
        const preloadPath = path.join(directory, 'synthetic-transport.cjs');
        await DB.db.backup(dbPath); const before = fs.readFileSync(dbPath);
        const stopped = docker().value;
        // Run the actual unmodified CLI entry point/readonly connection. The
        // preload changes only external transports: no Docker socket/provider
        // is contacted and all authority/transaction/receipt code remains real.
        fs.writeFileSync(preloadPath, `
            const http = require('http');
            const { EventEmitter } = require('events');
            const { PassThrough } = require('stream');
            const stopped = ${JSON.stringify(stopped)};
            http.get = (options, callback) => {
                if (options.socketPath !== '/var/run/docker.sock') throw new Error('unexpected socket');
                const request = new EventEmitter(); request.destroy = () => {};
                process.nextTick(() => {
                    const response = new PassThrough(); response.statusCode = 200; callback(response);
                    const payload = options.path.includes('?all=') ? [{ Id: stopped.Id, State: 'exited', Labels: stopped.Config.Labels }] : stopped;
                    response.end(JSON.stringify(payload));
                });
                return request;
            };
            const admin = require(${JSON.stringify(path.resolve(__dirname, '../src/services/identity/keycloak-admin.js'))});
            admin.request = async request => {
                if (request.url.endsWith('/token')) return { data: { access_token: 'synthetic-private-token', expires_in: 300 } };
                if (request.method !== 'GET' || !request.url.includes('/users?')) throw new Error('unexpected native mutation');
                return { data: [] };
            };
        `);
        try {
            const child = spawnSync(process.execPath, ['--require', preloadPath, path.resolve(__dirname, '../scripts/team-enrollment-lease-recovery.js'),
                '--invitation-id', 'invite', '--lease-digest', leaseDigest, '--worker-container-id', workerId,
                '--provider-quiescent', '--receipt', receiptPath], { encoding: 'utf8', env: { ...process.env,
                DOTENV_CONFIG_QUIET: 'true', AVA_PROCESS_ROLE: 'provisioning-worker', DB_PATH: dbPath,
                AVA_OIDC_ISSUER: 'https://identity.example.test/realms/ava', AVA_IDENTITY_ADMIN_ORIGIN: '' } });
            assert.strictEqual(child.status, 0, child.stderr);
            const receipt = JSON.parse(child.stdout);
            assert.strictEqual(receipt.status, 'recovery_required'); assert.strictEqual(receipt.mode, 'dry_run');
            assert.strictEqual(receipt.changed, false); assert.strictEqual(receipt.workerStoppedVerified, true);
            assert.strictEqual(receipt.nativeState, 'absent'); assert.strictEqual(fs.statSync(receiptPath).mode & 0o777, 0o600);
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(receiptPath, 'utf8')), receipt);
            assert.deepStrictEqual(fs.readFileSync(dbPath), before);
            assert.ok(![lease, leaseDigest, workerId, 'staff@example.test', 'synthetic-private-token'].some(value => (child.stdout + child.stderr).includes(value)));
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }));
    it('CLI keeps failure receipt private/redacted and does not initialize the DB', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-lease-cli-'));
        const dbPath = path.join(directory, 'fixture.db'), receiptPath = path.join(directory, 'receipt.json');
        const db = new Database(dbPath); db.exec('CREATE TABLE sentinel(value TEXT)'); db.close();
        const before = fs.readFileSync(dbPath);
        try {
            const child = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/team-enrollment-lease-recovery.js'),
                '--invitation-id', 'private-invite', '--lease-digest', leaseDigest, '--worker-container-id', workerId,
                '--provider-quiescent', '--receipt', receiptPath],
            { env: { ...process.env, AVA_PROCESS_ROLE: 'provisioning-worker', DB_PATH: dbPath }, encoding: 'utf8' });
            assert.strictEqual(child.status, 1);
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
            assert.deepStrictEqual(JSON.parse(child.stdout), receipt); assert.strictEqual(receipt.mode, 'dry_run');
            assert.strictEqual(fs.statSync(receiptPath).mode & 0o777, 0o600);
            assert.ok(![lease, leaseDigest, workerId, 'private-invite', 'staff@example.test'].some(value => (child.stdout + child.stderr + JSON.stringify(receipt)).includes(value)));
            assert.deepStrictEqual(fs.readFileSync(dbPath), before);
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
});
