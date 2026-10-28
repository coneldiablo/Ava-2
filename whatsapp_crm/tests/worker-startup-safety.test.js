'use strict';
const http = require('http');
const { execFile } = require('child_process');
const path = require('path');
const { describe, it, assert } = require('./test-helper');
const { startRuntime, startupDiagnostic } = require('../provisioning-worker');
const Broker = require('../src/services/identity/identity-broker');

async function environment(fn) {
    const keys = ['AVA_PROCESS_ROLE', 'AVA_IDENTITY_BROKER_TOKEN'];
    const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
    process.env.AVA_IDENTITY_BROKER_TOKEN = 'synthetic-worker-startup-token-at-least-32';
    try { await fn(); } finally {
        for (const key of keys) if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
}
async function listening(server) {
    if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    return server.address().port;
}
function options(overrides = {}) {
    return { env: { AVA_PROVISIONING_JOBS_ENABLED: 'false' },
        db: { init: async () => {}, db: { close: () => {} } },
        identityStore: { ensureSchema: () => {} },
        identityBrokerService: { start: config => Broker.start({ ...config, port: 0, host: '127.0.0.1' }) },
        loadRevocationWorker: () => ({ processOne: async () => {} }),
        loadPasswordRecoveryWorker: () => ({ processOne: async () => {} }),
        loadRegistrationStore: () => ({ ensureSchema: () => {} }),
        schedule: () => ({}), cancel: () => {}, ...overrides };
}

describe('Worker startup lifecycle and safe readiness (local HTTP, synthetic loaders)', () => {
    it('broker rejects readiness and enrollment until explicitly initialized, then reports exact readiness', () => environment(async () => {
        let enrollments = 0;
        const broker = Broker.start({ port: 0, host: '127.0.0.1', ready: false,
            admin: { redeem: async () => { enrollments++; return { success: true }; } } });
        const port = await listening(broker), url = `http://127.0.0.1:${port}`;
        try {
            let response = await fetch(url + '/__ava_release_readiness__');
            assert.strictEqual(response.status, 503);
            assert.deepStrictEqual(await response.json(), { ready: false });
            response = await fetch(url + '/invitations/redeem', { method: 'POST',
                headers: { Authorization: `Bearer ${process.env.AVA_IDENTITY_BROKER_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: 'synthetic', password: 'synthetic-password' }) });
            assert.strictEqual(response.status, 503);
            assert.strictEqual(enrollments, 0);
            broker.setReady(true);
            response = await fetch(url + '/__ava_release_readiness__');
            assert.strictEqual(response.status, 200);
            assert.deepStrictEqual(await response.json(), { ready: true });
        } finally { await new Promise(resolve => broker.close(resolve)); }
    }));
    it('loader failure after real broker bind closes the socket and DB and preserves original error/phase', () => environment(async () => {
        let broker, closed = 0;
        const original = Object.assign(new Error('private synthetic startup config'), { code: 'MODULE_NOT_FOUND' });
        await assert.rejects(startRuntime(options({
            db: { init: async () => {}, db: { close: () => { closed++; } } },
            identityBrokerService: { start: config => (broker = Broker.start({ ...config, port: 0, host: '127.0.0.1' })) },
            loadRegistrationStore: () => { assert.strictEqual(broker.runtimeReady, false); throw original; },
        })), error => error === original && error.workerStartupStage === 'LOAD_REGISTRATION');
        assert.strictEqual(broker.listening, false);
        assert.strictEqual(broker.runtimeReady, false);
        assert.strictEqual(closed, 1);
    }));
    it('a DB initialization failure closes its partial connection before any broker binds', () => environment(async () => {
        let closed = false, bound = false;
        const original = Object.assign(new Error('synthetic private database detail'), { code: 'SQLITE_BUSY' });
        await assert.rejects(startRuntime(options({
            db: { init: async () => { throw original; }, db: { close: () => { closed = true; } } },
            identityBrokerService: { start: () => { bound = true; } },
        })), error => error === original && error.workerStartupStage === 'DB_INIT');
        assert.strictEqual(closed, true);
        assert.strictEqual(bound, false);
    }));
    it('a child process exits nonzero after a post-bind loader failure instead of surviving on the broker socket', async () => {
        const script = `
            const { startRuntime, startupDiagnostic } = require('./provisioning-worker');
            const broker = require('./src/services/identity/identity-broker');
            startRuntime({ env: { AVA_PROVISIONING_JOBS_ENABLED: 'false' },
                db: { init: async () => {}, db: { close: () => {} } },
                identityStore: { ensureSchema: () => {} },
                identityBrokerService: { start: config => broker.start({ ...config, port: 0, host: '127.0.0.1' }) },
                loadRevocationWorker: () => ({}), loadPasswordRecoveryWorker: () => ({}),
                loadRegistrationStore: () => { throw Object.assign(new Error('private-child-fixture'), { code: 'MODULE_NOT_FOUND' }); }
            }).then(() => { process.exitCode = 2; }, error => {
                console.log(JSON.stringify(startupDiagnostic(error))); process.exitCode = 1;
            });`;
        const result = await new Promise(resolve => execFile(process.execPath, ['-e', script], {
            cwd: path.resolve(__dirname, '..'), timeout: 4000,
            env: { ...process.env, NODE_ENV: 'test', AVA_PROCESS_ROLE: 'provisioning-worker',
                AVA_IDENTITY_BROKER_TOKEN: 'synthetic-child-worker-token-at-least-32' },
        }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
        assert.strictEqual(result.error?.code, 1);
        assert.strictEqual(result.error?.killed, false);
        const diagnostic = JSON.parse(result.stdout.trim().split('\n').at(-1));
        assert.strictEqual(diagnostic.phase, 'LOAD_REGISTRATION');
        assert.strictEqual(diagnostic.code, 'MODULE_NOT_FOUND');
        assert.ok(!(result.stdout + result.stderr).includes('private-child-fixture'));
    });
    it('later sync timer failure cancels an allocated identity timer and closes broker/DB', () => environment(async () => {
        let broker, closed = false, timers = 0;
        const allocated = {}, cancelled = [];
        await assert.rejects(startRuntime(options({
            env: { AVA_TWENTY_SYNC_RECOVERY_ENABLED: 'true' },
            db: { init: async () => {}, db: { close: () => { closed = true; } } },
            identityBrokerService: { start: config => (broker = Broker.start({ ...config, port: 0, host: '127.0.0.1' })) },
            loadRecoveryWorker: () => ({ processOne: async () => {} }),
            schedule: () => { if (++timers === 2) throw new Error('synthetic timer failure'); return allocated; },
            cancel: timer => cancelled.push(timer),
        })), error => error.workerStartupStage === 'SYNC_RECOVERY_TIMER');
        assert.deepStrictEqual(cancelled, [allocated]);
        assert.strictEqual(broker.listening, false);
        assert.strictEqual(closed, true);
    }));
    it('poller init failure stops partial poller and releases timer/broker/DB despite cleanup errors', () => environment(async () => {
        let broker, closed = false, stopped = false, cancelled = false;
        const original = new Error('synthetic poller failure');
        await assert.rejects(startRuntime(options({
            env: {}, db: { init: async () => {}, db: { close: () => { closed = true; } } },
            identityBrokerService: { start: config => (broker = Broker.start({ ...config, port: 0, host: '127.0.0.1' })) },
            loadProvisioningWorker: () => ({ startBackgroundPoller: () => { throw original; },
                stopBackgroundPoller: () => { stopped = true; throw new Error('secondary cleanup failure'); } }),
            cancel: () => { cancelled = true; throw new Error('secondary timer failure'); },
        })), error => error === original && error.workerStartupStage === 'PROVISIONING_POLLER');
        assert.ok(stopped && cancelled && closed);
        assert.strictEqual(broker.listening, false);
    }));
    it('captures asynchronous bind failure, closes DB and leaves the pre-existing server intact', () => environment(async () => {
        const occupied = http.createServer((_request, response) => response.end('synthetic-existing-server')).listen(0, '127.0.0.1');
        const port = await listening(occupied);
        let closed = false;
        try {
            await assert.rejects(startRuntime(options({
                db: { init: async () => {}, db: { close: () => { closed = true; } } },
                identityBrokerService: { start: config => Broker.start({ ...config, port, host: '127.0.0.1' }) },
            })), error => error.code === 'EADDRINUSE' && error.workerStartupStage === 'BROKER_BIND');
            assert.strictEqual(closed, true);
            assert.strictEqual(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'synthetic-existing-server');
        } finally { await new Promise(resolve => occupied.close(resolve)); }
    }));
    it('marks runtime ready only after timers initialize and withdraws readiness on shutdown', () => environment(async () => {
        let broker, closed = false;
        const runtime = await startRuntime(options({
            db: { init: async () => {}, db: { close: () => { closed = true; } } },
            identityBrokerService: { start: config => (broker = Broker.start({ ...config, port: 0, host: '127.0.0.1' })) },
            schedule: () => { assert.strictEqual(broker.runtimeReady, false); return {}; },
        }));
        const response = await fetch(`http://127.0.0.1:${broker.address().port}/__ava_release_readiness__`);
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(await response.json(), { ready: true });
        await runtime.shutdown();
        assert.strictEqual(broker.runtimeReady, false);
        assert.strictEqual(closed, true);
    }));
    it('diagnostic exposes only bounded phase, allowlisted code and repository source location', () => {
        const error = { code: 'SQLITE_BUSY', workerStartupStage: 'DB_INIT',
            message: 'password=private-fixture SECRET=private-fixture',
            stack: 'Error: password=private-fixture\n    at DatabaseService.init (/app/src/services/database.service.js:113:19)\n    at /private/config.json:1:1' };
        assert.deepStrictEqual(startupDiagnostic(error), { event: 'PROVISIONING_WORKER_START_FAILED',
            phase: 'DB_INIT', code: 'SQLITE_BUSY', source: { path: 'src/services/database.service.js', line: 113 } });
        assert.ok(!JSON.stringify(startupDiagnostic(error)).includes('private-fixture'));
        assert.deepStrictEqual(startupDiagnostic({ code: 'SECRET=private-fixture', workerStartupStage: 'password=private-fixture',
            stack: 'Error: secret at /private/config.json:1:1' }), { event: 'PROVISIONING_WORKER_START_FAILED', phase: 'BOOTSTRAP', code: 'WORKER_STARTUP_FAILED' });
    });
    it('a partial request body cannot dispatch enrollment after shutdown closes the DB', () => environment(async () => {
        let broker, closed = false, enrollments = 0;
        const runtime = await startRuntime(options({
            db: { init: async () => {}, db: { close: () => { closed = true; } } },
            identityBrokerService: { start: config => (broker = Broker.start({ ...config, port: 0, host: '127.0.0.1',
                admin: { redeem: async () => { enrollments++; return { success: true }; } } })) },
        }));
        const admitted = new Promise(resolve => broker.once('request', resolve));
        let request;
        const response = new Promise((resolve, reject) => {
            request = http.request({ host: '127.0.0.1', port: broker.address().port, path: '/invitations/redeem', method: 'POST',
                headers: { Authorization: `Bearer ${process.env.AVA_IDENTITY_BROKER_TOKEN}`, 'Content-Type': 'application/json' } }, reply => {
                let body = ''; reply.on('data', chunk => { body += chunk; });
                reply.on('end', () => resolve({ status: reply.statusCode, body: JSON.parse(body) }));
            });
            request.once('error', reject);
            request.write('{"token":');
        });
        await admitted;
        await runtime.shutdown();
        assert.strictEqual(closed, true);
        assert.strictEqual(broker.activeEnrollments, 0);
        request.end('"synthetic","password":"synthetic-password"}');
        const result = await response;
        assert.strictEqual(result.status, 503);
        assert.strictEqual(result.body.error, 'IDENTITY_BROKER_NOT_READY');
        assert.strictEqual(enrollments, 0);
    }));
});
