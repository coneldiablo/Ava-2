'use strict';
// Unit coverage for the local Unix-socket peer only; it is not a native deployment acceptance test.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { describe, it: register } = require('./test-helper');
const ModuleDeploymentClient = require('../src/services/provisioning/module-deployment-client');

function it(name, fn) {
    register(name, async () => {
        const previous = process.env.AVA_PROCESS_ROLE;
        process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        try { await fn(); } finally {
            if (previous === undefined) delete process.env.AVA_PROCESS_ROLE;
            else process.env.AVA_PROCESS_ROLE = previous;
        }
    });
}
function listen(server, socketPath) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
    });
}
function close(server, sockets) {
    for (const socket of sockets) socket.destroy();
    return new Promise(resolve => server.close(() => resolve()));
}
async function withPeer(handler, run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-module-peer-'));
    const socketPath = path.join(directory, 'peer.sock');
    const sockets = new Set();
    const server = http.createServer(handler);
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    try {
        await listen(server, socketPath);
        await run(socketPath);
    } finally {
        await close(server, sockets);
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
function body(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); } });
        request.on('error', reject);
    });
}
function errorCode(promise, code, retryable) {
    return assert.rejects(promise, error => error && error.code === code && error.retryable === retryable);
}

describe('module deployment Unix peer client', () => {
    it('requires the provisioning worker role', async () => {
        const previous = process.env.AVA_PROCESS_ROLE;
        delete process.env.AVA_PROCESS_ROLE;
        try {
            await errorCode(new ModuleDeploymentClient('/tmp/ava-unused.sock').capacity(), 'DEPLOYMENT_WORKER_REQUIRED', false);
        } finally {
            if (previous === undefined) delete process.env.AVA_PROCESS_ROLE;
            else process.env.AVA_PROCESS_ROLE = previous;
        }
    });
    it('sends exactly the scoped deployment fields without credentials', async () => {
        const input = { businessId: 17, deploymentId: '2d4466e8-70b5-4f95-aad4-04aec1cab8f2', leaseToken: '25f2ef17-2b91-4416-a54e-967a67e7c2de', revision: 4 };
        await withPeer(async (request, response) => {
            assert.strictEqual(request.method, 'POST'); assert.strictEqual(request.url, '/v1/provision');
            assert.deepStrictEqual(await body(request), input);
            for (const header of ['authorization', 'cookie', 'x-api-key', 'proxy-authorization']) assert.strictEqual(request.headers[header], undefined);
            response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ accepted: true }));
        }, async socketPath => {
            const value = await new ModuleDeploymentClient(socketPath).provision(input);
            assert.deepStrictEqual(value, { accepted: true });
        });
    });
    it('sends the exact one-use sync recovery claim only to the worker Unix peer', async () => {
        const input = {
            contractVersion: 'ava-sync-recovery-v1', recoveryId: '11111111-1111-4111-8111-111111111111',
            recoveryToken: '22222222-2222-4222-8222-222222222222', leaseId: '33333333-3333-4333-8333-333333333333',
            deploymentId: '44444444-4444-4444-8444-444444444444', businessId: 17, leaseRevision: 3,
            deploymentRevision: 3, adapterRevision: 7, integrationRevision: 9,
            correlationId: '55555555-5555-4555-8555-555555555555', outboxEventId: 'twout_55555555-5555-4555-8555-555555555555',
        };
        await withPeer(async (request, response) => {
            assert.strictEqual(request.url, '/v1/sync-recovery');
            assert.deepStrictEqual(await body(request), input);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ contractVersion: 'ava-sync-recovery-v1' }));
        }, async socketPath => {
            assert.deepStrictEqual(await new ModuleDeploymentClient(socketPath).syncRecovery(input),
                { contractVersion: 'ava-sync-recovery-v1' });
            await errorCode(new ModuleDeploymentClient(socketPath).syncRecovery({ ...input, service: 'database' }),
                'DEPLOYMENT_REQUEST_INVALID', false);
        });
    });
    it('preserves only allowlisted helper recovery errors', async () => {
        await withPeer((request, response) => {
            response.writeHead(409); response.end(JSON.stringify({ error_code: 'SYNC_RECOVERY_BINDING_CHANGED' }));
        }, async socketPath => {
            const input = {
                contractVersion: 'ava-sync-recovery-v1', recoveryId: '11111111-1111-4111-8111-111111111111',
                recoveryToken: '22222222-2222-4222-8222-222222222222', leaseId: '33333333-3333-4333-8333-333333333333',
                deploymentId: '44444444-4444-4444-8444-444444444444', businessId: 1, leaseRevision: 1,
                deploymentRevision: 1, adapterRevision: 1, integrationRevision: 1,
                correlationId: '55555555-5555-4555-8555-555555555555', outboxEventId: '55555555-5555-4555-8555-555555555555',
            };
            await errorCode(new ModuleDeploymentClient(socketPath).syncRecovery(input), 'SYNC_RECOVERY_BINDING_CHANGED', false);
        });
    });
    it('maps busy and unknown conflict codes without reflecting peer data', async () => {
        await withPeer((request, response) => { response.writeHead(409); response.end(JSON.stringify({ error_code: 'DEPLOYMENT_HELPER_BUSY' })); }, async socketPath => {
            await errorCode(new ModuleDeploymentClient(socketPath).capacity(), 'DEPLOYMENT_HELPER_BUSY', true);
        });
        await withPeer((request, response) => { response.writeHead(409); response.end(JSON.stringify({ error_code: 'TOP_SECRET_DB_PASSWORD' })); }, async socketPath => {
            await assert.rejects(new ModuleDeploymentClient(socketPath).capacity(), error =>
                error && error.code === 'DEPLOYMENT_HELPER_FAILED' && error.retryable === false && !error.message.includes('TOP_SECRET'));
        });
    });
    it('does not follow redirects', async () => {
        let calls = 0;
        await withPeer((request, response) => { calls += 1; response.writeHead(302, { location: '/v1/verify' }); response.end(JSON.stringify({})); }, async socketPath => {
            await errorCode(new ModuleDeploymentClient(socketPath).capacity(), 'DEPLOYMENT_HELPER_FAILED', false);
            assert.strictEqual(calls, 1);
        });
    });
    it('rejects oversized and aborted peer responses', async () => {
        await withPeer((request, response) => { response.writeHead(200); response.end(Buffer.alloc((64 * 1024) + 1)); }, async socketPath => {
            await errorCode(new ModuleDeploymentClient(socketPath).capacity(), 'DEPLOYMENT_HELPER_RESPONSE_TOO_LARGE', false);
        });
        await withPeer((request, response) => {
            response.writeHead(200, { 'content-length': '100' }); response.write('{');
            setTimeout(() => response.destroy(), 5);
        }, async socketPath => {
            await errorCode(new ModuleDeploymentClient(socketPath).capacity(), 'DEPLOYMENT_HELPER_UNAVAILABLE', true);
        });
    });
    it('uses an absolute timeout despite continuous partial response chunks', async () => {
        let interval;
        try {
            await withPeer((request, response) => {
                response.writeHead(200, { 'content-type': 'application/json' });
                interval = setInterval(() => response.write(' '), 100);
                response.on('close', () => clearInterval(interval));
            }, async socketPath => {
                const started = Date.now();
                await errorCode(new ModuleDeploymentClient(socketPath, { timeoutMs: 1000 }).capacity(), 'DEPLOYMENT_HELPER_TIMEOUT', true);
                const elapsed = Date.now() - started;
                assert.ok(elapsed >= 900 && elapsed < 1800, `expected an absolute timeout, got ${elapsed}ms`);
            });
        } finally { clearInterval(interval); }
    });
});
