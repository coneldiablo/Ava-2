'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test, describe } = require('node:test');
const { secretFile } = require('./main.cjs');
const { peerClient } = require('./peer-client.cjs');

const secret = () => crypto.randomBytes(32).toString('base64url');
const denied = { code: 'AVA_MODULE_ACCESS_DENIED' };

describe('gateway peer security boundaries', () => {
    test('secretFile accepts restrictive 43-character base64url and rejects unsafe files', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-peer-'));
        const file = path.join(dir, 'secret');
        try {
            const value = secret();
            fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
            assert.equal(secretFile(file), value);
            fs.chmodSync(file, 0o660);
            assert.throws(() => secretFile(file));
            fs.chmodSync(file, 0o600);
            fs.writeFileSync(file, 'x'.repeat(257), { mode: 0o600 });
            assert.throws(() => secretFile(file), denied);
            fs.writeFileSync(file, 'not-a-valid-secret', { mode: 0o600 });
            assert.throws(() => secretFile(file), denied);
            const target = path.join(dir, 'target');
            fs.writeFileSync(target, value, { mode: 0o600 });
            fs.unlinkSync(file);
            fs.symlinkSync(target, file);
            assert.throws(() => secretFile(file));
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('peer credentials are read for every request and browser headers are absent', async () => {
        const first = secret(), second = secret(); let current = first; const seen = [];
        const server = http.createServer((req, res) => {
            seen.push(req.headers);
            res.end('{}');
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const client = peerClient({ origin: `http://127.0.0.1:${server.address().port}`, peerSecret: () => current });
            await client('/v1/authorize', {}); current = second; await client('/v1/authorize', {});
            assert.deepEqual(seen.map(headers => headers.authorization), [`Bearer ${first}`, `Bearer ${second}`]);
            assert.equal(seen[0].origin, undefined); assert.equal(seen[0].cookie, undefined);
        } finally { await new Promise(resolve => server.close(resolve)); }
    });

    test('peer rejects oversized, non-200, and redirect responses without leaking secrets', async () => {
        const cases = [
            { status: 200, body: 'x'.repeat(16385) },
            { status: 500, body: 'server secret should not leak' },
            { status: 302, headers: { Location: 'http://127.0.0.1:1/leak' }, body: 'redirect secret' },
        ];
        for (const response of cases) {
            const server = http.createServer((_req, res) => {
                res.writeHead(response.status, response.headers); res.end(response.body);
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            try {
                const client = peerClient({ origin: `http://127.0.0.1:${server.address().port}`, peerSecret: secret });
                await assert.rejects(client('/v1/authorize', {}), error => {
                    assert.equal(error.code, denied.code); assert.equal(String(error).includes(response.body), false); return true;
                });
            } finally { await new Promise(resolve => server.close(resolve)); }
        }
    });

    test('peer timeout is bounded and does not expose the secret', async () => {
        const server = http.createServer(() => {});
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const started = Date.now();
        try {
            const client = peerClient({ origin: `http://127.0.0.1:${server.address().port}`, peerSecret: secret });
            await assert.rejects(client('/v1/authorize', {}), denied);
            assert.ok(Date.now() - started < 3500);
        } finally { await new Promise(resolve => server.close(resolve)); }
    });
});
