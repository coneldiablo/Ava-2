const { describe, it, assert, createTestDB } = require('./test-helper');
const { Readable } = require('stream');
const crypto = require('crypto');
const express = require('express');
const DB = require('../src/services/database.service');
const { OnyxLlmGateway } = require('../src/services/onyx-llm-gateway.service');
const createRouter = require('../src/routes/onyx-llm.routes');

const response = () => ({ id: 'completion-test', created: 100, choices: [{ message: { role: 'assistant', content: 'Бассейн работает до 22:00.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }, upstream_internal_key: 'NEVER-RETURN' });

async function setup(transport) {
    createTestDB();
    const a = await DB.createInstance({ name: 'Alpha' });
    const b = await DB.createInstance({ name: 'Beta' });
    const calls = [];
    const gateway = new OnyxLlmGateway({ transport: transport || { request: async (request) => { calls.push(request); return { data: response() }; } },
        resolveProvider: (business) => ({ apiKey: `upstream-secret-${business.id}`, model: `actual-model-${business.id}`, url: 'https://provider.test/v1/chat/completions' }) });
    const issued = gateway.issueToken(a.id);
    return { a, b, gateway, calls, token: issued.token, auth: `Bearer ${issued.token}`, body: { model: issued.model, messages: [{ role: 'user', content: 'Когда работает бассейн?' }] } };
}

async function enabled(fn) {
    const previous = process.env.ONYX_LLM_PROXY_ENABLED;
    process.env.ONYX_LLM_PROXY_ENABLED = 'true';
    try { await fn(); } finally {
        if (previous === undefined) delete process.env.ONYX_LLM_PROXY_ENABLED;
        else process.env.ONYX_LLM_PROXY_ENABLED = previous;
    }
}

describe('Onyx tenant-scoped LLM gateway', () => {
    it('fences deployment credentials by business, revision and verified state', async () => enabled(async () => {
        const s = await setup();
        const deploymentId = crypto.randomUUID();
        DB.run(`INSERT INTO ava_module_deployments(id,businessId,module,hostname,namespace,state,revision,correlationId,createdAt,updatedAt)
            VALUES (?,?,?,?,?,'verified',1,?,?,?)`, [deploymentId, s.a.id, 'onyx',
            'a.knowledge.test', `ava_${deploymentId.replaceAll('-', '')}`, crypto.randomUUID(), Date.now(), Date.now()]);
        const input = { businessId: s.a.id, deploymentId, expectedRevision: 1 };
        const previousRole = process.env.AVA_PROCESS_ROLE;
        try {
            delete process.env.AVA_PROCESS_ROLE;
            assert.throws(() => s.gateway.issueDeploymentToken(input), /ONYX_LLM_WORKER_REQUIRED/);
            process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
            assert.throws(() => s.gateway.issueDeploymentToken({ ...input, businessId: s.b.id }), /ONYX_LLM_DEPLOYMENT_UNAVAILABLE/);
            const first = s.gateway.issueDeploymentToken(input);
            const firstAuth = `Bearer ${first.token}`;
            assert.strictEqual(s.gateway.authenticate(firstAuth).id, s.a.id);
            const replacement = s.gateway.issueDeploymentToken(input);
            assert.throws(() => s.gateway.authenticate(firstAuth), /ONYX_LLM_UNAUTHORIZED/);
            assert.strictEqual(s.gateway.authenticate(`Bearer ${replacement.token}`).id, s.a.id);
            DB.run('UPDATE ava_module_deployments SET revision=revision+1 WHERE id=?', [deploymentId]);
            assert.throws(() => s.gateway.authenticate(`Bearer ${replacement.token}`), /ONYX_LLM_UNAUTHORIZED/);
            assert.throws(() => s.gateway.issueDeploymentToken(input), /ONYX_LLM_DEPLOYMENT_UNAVAILABLE/);
            DB.run("UPDATE ava_module_deployments SET revision=1,state='disabled' WHERE id=?", [deploymentId]);
            assert.throws(() => s.gateway.authenticate(`Bearer ${replacement.token}`), /ONYX_LLM_UNAUTHORIZED/);
        } finally {
            if (previousRole === undefined) delete process.env.AVA_PROCESS_ROLE;
            else process.env.AVA_PROCESS_ROLE = previousRole;
        }
    }));
    it('honors optional GPT-OSS effort without replacing model/provider and preserves explicit session settings', () => enabled(async () => {
        const s = await setup();
        const previous = process.env.ONYX_LLM_OSS_REASONING_EFFORT;
        try {
            process.env.ONYX_LLM_OSS_REASONING_EFFORT = 'low';
            await s.gateway.complete(s.auth, s.body);
            assert.strictEqual(s.calls[0].data.reasoning_effort, undefined); // Non-OSS model unchanged.
            s.gateway.resolveProvider = () => ({ model: 'gpt-oss-120b', apiKey: 'upstream', url: 'https://provider.test/v1/chat/completions' });
            await s.gateway.complete(s.auth, s.body);
            assert.strictEqual(s.calls[1].data.reasoning_effort, 'low');
            assert.strictEqual(s.calls[1].data.model, 'gpt-oss-120b');
            await s.gateway.complete(s.auth, { ...s.body, reasoning_effort: 'high' });
            assert.strictEqual(s.calls[2].data.reasoning_effort, 'high');
            for (const invalid of ['auto', 'none', true, {}, null]) {
                await assert.rejects(s.gateway.complete(s.auth, { ...s.body, reasoning_effort: invalid }), /INVALID_REASONING_EFFORT/);
            }
        } finally {
            if (previous === undefined) delete process.env.ONYX_LLM_OSS_REASONING_EFFORT;
            else process.env.ONYX_LLM_OSS_REASONING_EFFORT = previous;
        }
    }));

    it('uses server credentials, pins model/business, masks response and persists only metadata', () => enabled(async () => {
        const s = await setup();
        const result = await s.gateway.complete(s.auth, { ...s.body, max_tokens: 8192 });
        assert.strictEqual(result.result.choices[0].message.content, 'Бассейн работает до 22:00.');
        assert.strictEqual(result.result.model, s.body.model);
        assert.strictEqual(result.result.upstream_internal_key, undefined);
        assert.strictEqual(s.calls[0].headers.Authorization, `Bearer upstream-secret-${s.a.id}`);
        assert.strictEqual(s.calls[0].data.model, `actual-model-${s.a.id}`);
        assert.strictEqual(s.calls[0].data.max_tokens, 4096);
        assert.strictEqual(s.calls[0].data.store, false);
        assert.strictEqual(s.calls[0].maxRedirects, 0);
        const audit = DB.get('SELECT * FROM onyx_llm_requests');
        assert.strictEqual(audit.status, 'DONE');
        assert.strictEqual(audit.business_id, s.a.id);
        assert.strictEqual(audit.prompt_tokens, 20);
        assert.ok(!JSON.stringify(audit).includes('бассейн'));
        assert.ok(!JSON.stringify(DB.all('SELECT * FROM onyx_llm_credentials')).includes(s.token));
    }));

    it('rejects tenant/model overrides, disabled businesses, revoked and unrelated tokens', () => enabled(async () => {
        const s = await setup();
        for (const body of [{ ...s.body, business_id: s.b.id }, { ...s.body, model: `ava-hotel-${s.b.id}` }, { ...s.body, api_key: 'override' }, { ...s.body, base_url: 'https://attacker.test' }]) {
            await assert.rejects(s.gateway.complete(s.auth, body), /ONYX_LLM_(INVALID_REQUEST|MODEL_SCOPE_MISMATCH)/);
        }
        for (const auth of ['', 'Bearer service-token', `Bearer ${'x'.repeat(43)}`]) assert.throws(() => s.gateway.authenticate(auth), /UNAUTHORIZED/);
        s.gateway.issueToken(s.a.id);
        assert.throws(() => s.gateway.authenticate(s.auth), /UNAUTHORIZED/);
        const next = s.gateway.issueToken(s.a.id);
        DB.run('UPDATE instances SET isActive=0 WHERE id=?', [s.a.id]);
        assert.throws(() => s.gateway.authenticate(`Bearer ${next.token}`), /BUSINESS_UNAVAILABLE/);
        assert.strictEqual(s.calls.length, 0);
    }));

    it('is disabled by default and rejects malformed/oversized/non-text requests', () => enabled(async () => {
        const s = await setup();
        process.env.ONYX_LLM_PROXY_ENABLED = 'false';
        assert.throws(() => s.gateway.authenticate(s.auth), /DISABLED/);
        process.env.ONYX_LLM_PROXY_ENABLED = 'true';
        for (const invalid of [{ temperature: NaN }, { stream: 'false' }, { max_tokens: -1 }, { max_tokens: true },
            { max_tokens: 10, max_completion_tokens: 10 }, { messages: [] },
            { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://169.254.169.254' } }] }] },
            { messages: [{ role: 'user', content: 'x'.repeat(600000) }] }, { tools: [{ type: 'web_search' }] }]) {
            await assert.rejects(s.gateway.complete(s.auth, { ...s.body, ...invalid }), /ONYX_LLM_/);
        }
        assert.strictEqual(s.calls.length, 0);
    }));

    it('enforces persistent concurrency/minute budgets and releases expired leases', () => enabled(async () => {
        const s = await setup();
        let now = 1000000;
        s.gateway.now = () => now;
        const first = s.gateway.reserve(s.a.id);
        s.gateway.reserve(s.a.id);
        const fresh = new OnyxLlmGateway({ now: () => now });
        assert.throws(() => fresh.reserve(s.a.id), /CONCURRENCY_LIMIT/);
        assert.ok(fresh.reserve(s.b.id));
        s.gateway.finish(first);
        assert.ok(fresh.reserve(s.a.id));
        now += 66000;
        assert.ok(fresh.reserve(s.a.id));
        DB.run("UPDATE onyx_llm_requests SET status='DONE'");
        for (let i = 0; i < 59; i += 1) s.gateway.finish(s.gateway.reserve(s.a.id));
        assert.throws(() => fresh.reserve(s.a.id), /RATE_LIMIT/);
    }));

    it('queues a parallel search burst while preserving two active provider requests per business', () => enabled(async () => {
        const { setTimeout: delay } = require('timers/promises');
        let active = 0, maximum = 0;
        const s = await setup({ request: async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            await delay(80);
            active -= 1;
            return { data: response() };
        } });
        const results = await Promise.all(Array.from({ length: 4 }, () => s.gateway.complete(s.auth, s.body)));
        assert.strictEqual(results.length, 4);
        assert.strictEqual(maximum, 2);
        assert.strictEqual(DB.get("SELECT COUNT(*) count FROM onyx_llm_requests WHERE status='DONE'").count, 4);
        assert.strictEqual(s.gateway.admissionQueue.size, 0);
    }));

    it('bounds wait time and queue size without reserving budget or calling the provider', () => enabled(async () => {
        const s = await setup();
        s.gateway.reserve(s.a.id);
        s.gateway.reserve(s.a.id);
        s.gateway.admissionWaitMs = 30;
        const results = await Promise.allSettled(Array.from({ length: 5 }, () => s.gateway.complete(s.auth, s.body)));
        assert.strictEqual(results.filter((item) => item.reason?.code === 'ONYX_LLM_QUEUE_FULL').length, 1);
        assert.strictEqual(results.filter((item) => item.reason?.code === 'ONYX_LLM_CONCURRENCY_LIMIT').length, 4);
        assert.strictEqual(s.calls.length, 0);
        assert.strictEqual(DB.get('SELECT COUNT(*) count FROM onyx_llm_requests').count, 2);
        assert.strictEqual(s.gateway.admissionQueue.size, 0);
    }));

    it('cancels waiting work and rechecks token revocation without touching another business', () => enabled(async () => {
        const s = await setup();
        s.gateway.reserve(s.a.id);
        s.gateway.reserve(s.a.id);
        const controller = new AbortController();
        const pending = s.gateway.complete(s.auth, s.body, { signal: controller.signal });
        controller.abort();
        await assert.rejects(pending, /ONYX_LLM_CANCELED/);
        assert.strictEqual(s.gateway.admissionQueue.size, 0);
        const revoked = s.gateway.complete(s.auth, s.body);
        s.gateway.issueToken(s.a.id);
        await assert.rejects(revoked, /ONYX_LLM_UNAUTHORIZED/);
        const other = s.gateway.issueToken(s.b.id);
        const result = await s.gateway.complete(`Bearer ${other.token}`, { ...s.body, model: other.model });
        assert.strictEqual(result.result.model, other.model);
        assert.strictEqual(s.calls.length, 1);
        assert.strictEqual(s.calls[0].data.model, `actual-model-${s.b.id}`);
        assert.strictEqual(s.gateway.admissionQueue.size, 0);
    }));

    it('rechecks disable/provider configuration after waiting and releases a failed reservation', () => enabled(async () => {
        const s = await setup();
        const first = s.gateway.reserve(s.a.id);
        s.gateway.reserve(s.a.id);
        const pending = s.gateway.complete(s.auth, s.body);
        DB.run('UPDATE instances SET isActive=0 WHERE id=?', [s.a.id]);
        await assert.rejects(pending, /ONYX_LLM_BUSINESS_UNAVAILABLE/);
        DB.run('UPDATE instances SET isActive=1 WHERE id=?', [s.a.id]);
        const configured = s.gateway.complete(s.auth, s.body);
        s.gateway.resolveProvider = () => { throw new Error('secret-provider-failure'); };
        s.gateway.finish(first);
        await assert.rejects(configured, (error) => error.code === 'ONYX_LLM_UPSTREAM_ERROR' && !error.message.includes('secret'));
        assert.strictEqual(DB.get("SELECT COUNT(*) count FROM onyx_llm_requests WHERE status='FAILED'").count, 1);
        assert.strictEqual(s.calls.length, 0);
    }));

    it('does not queue exhausted rate budgets or already canceled requests', () => enabled(async () => {
        const s = await setup();
        for (let i = 0; i < 60; i += 1) s.gateway.finish(s.gateway.reserve(s.a.id));
        await assert.rejects(s.gateway.complete(s.auth, s.body), /ONYX_LLM_RATE_LIMIT/);
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(s.gateway.complete(s.auth, s.body, { signal: controller.signal }), /ONYX_LLM_CANCELED/);
        assert.strictEqual(s.gateway.admissionQueue.size, 0);
        assert.strictEqual(s.calls.length, 0);
    }));

    it('streams UTF-8 and tool calls without executing them or exposing upstream metadata', () => enabled(async () => {
        const events = [
            { id: 'chunk', choices: [{ delta: { role: 'assistant', content: 'Бассейн' }, finish_reason: null }] },
            { id: 'chunk', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'search', arguments: '{"query":"бассейн"}' } }] }, finish_reason: 'tool_calls' }] },
            { id: 'chunk', choices: [], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } },
        ];
        const raw = Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + 'data: [DONE]\n\n');
        const s = await setup({ request: async () => ({ data: Readable.from(Array.from(raw, (byte) => Buffer.from([byte]))) }) });
        const chunks = [];
        const result = await s.gateway.complete(s.auth, { ...s.body, stream: true }, { onChunk: async (chunk) => chunks.push(chunk) });
        assert.strictEqual(result.streamed, true);
        assert.strictEqual(chunks[0].choices[0].delta.content, 'Бассейн');
        assert.strictEqual(chunks[1].choices[0].delta.tool_calls[0].function.name, 'search');
        assert.strictEqual(DB.get('SELECT completion_tokens FROM onyx_llm_requests').completion_tokens, 20);
    }));

    it('marks incomplete streams failed and never reflects provider errors or credentials', () => enabled(async () => {
        const upstreamError = Object.assign(new Error('Bearer upstream-secret PASSWORD=secret'), { response: { status: 401, data: { secret: 'provider-secret' } } });
        const s = await setup({ request: async () => { throw upstreamError; } });
        await assert.rejects(s.gateway.complete(s.auth, s.body), (error) => error.message === 'ONYX_LLM_UPSTREAM_AUTH' && !JSON.stringify(error).includes('provider-secret'));
        assert.strictEqual(DB.get('SELECT status FROM onyx_llm_requests').status, 'FAILED');
        s.gateway.transport = { request: async () => ({ data: Readable.from(['data: {"id":"x","choices":[{"delta":{"content":"partial"}}]}\n\n']) }) };
        await assert.rejects(s.gateway.complete(s.auth, { ...s.body, stream: true }, { onChunk: async () => {} }), /INCOMPLETE_STREAM/);
        assert.strictEqual(DB.get("SELECT COUNT(*) count FROM onyx_llm_requests WHERE status='FAILED'").count, 2);
    }));

    it('propagates cancellation to transport and closes its persistent lease', () => enabled(async () => {
        let started;
        const start = new Promise((resolve) => { started = resolve; });
        const s = await setup({ request: ({ signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' })), { once: true });
            started();
        }) });
        const controller = new AbortController();
        const pending = s.gateway.complete(s.auth, s.body, { signal: controller.signal });
        await start;
        controller.abort();
        await assert.rejects(pending, /ONYX_LLM_CANCELED/);
        assert.deepStrictEqual(DB.get('SELECT status,error_code FROM onyx_llm_requests'), { status: 'FAILED', error_code: 'ONYX_LLM_CANCELED' });
    }));

    it('shares concurrency enforcement between independent SQLite connections', async () => {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const Sqlite = require('better-sqlite3');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onyx-llm-budget-'));
        const a = new Sqlite(path.join(dir, 'test.db'));
        const b = new Sqlite(path.join(dir, 'test.db'));
        const adapter = (db) => ({ db, get: (sql, args = []) => db.prepare(sql).get(...args), run: (sql, args = []) => db.prepare(sql).run(...args) });
        try {
            a.exec('CREATE TABLE instances(id INTEGER PRIMARY KEY,isActive INTEGER); INSERT INTO instances VALUES(1,1)');
            const first = new OnyxLlmGateway({ db: adapter(a) });
            const second = new OnyxLlmGateway({ db: adapter(b) });
            first.ensureSchema();
            const id = first.reserve(1);
            second.reserve(1);
            assert.throws(() => first.reserve(1), /CONCURRENCY_LIMIT/);
            second.finish(id);
            assert.ok(first.reserve(1));
        } finally { a.close(); b.close(); fs.rmSync(dir, { recursive: true }); }
    });

    it('serves authenticated real HTTP completions/models and SSE, not browser sessions', () => enabled(async () => {
        const s = await setup();
        const app = express();
        app.use(express.json());
        app.use('/api/integrations', createRouter(s.gateway));
        const server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}/api/integrations/onyx/llm/v1`;
        try {
            assert.strictEqual((await fetch(`${base}/models`)).status, 401);
            const models = await (await fetch(`${base}/models`, { headers: { authorization: s.auth } })).json();
            assert.deepStrictEqual(models.data.map((model) => model.id), [s.body.model]);
            const result = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: s.auth, 'Content-Type': 'application/json' }, body: JSON.stringify(s.body) });
            assert.strictEqual(result.status, 200);
            assert.ok(result.headers.get('x-request-id'));
            assert.strictEqual((await result.json()).choices[0].message.content, 'Бассейн работает до 22:00.');
            s.gateway.transport = { request: async () => ({ data: Readable.from(['data: {"id":"x","choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n']) }) };
            const streamed = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: s.auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...s.body, stream: true }) });
            assert.ok(streamed.headers.get('content-type').includes('text/event-stream'));
            assert.ok((await streamed.text()).endsWith('data: [DONE]\n\n'));
        } finally { await new Promise((resolve) => server.close(resolve)); }
    }));
});
