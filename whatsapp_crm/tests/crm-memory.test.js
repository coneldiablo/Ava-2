const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Store = require('../src/services/crm-memory-store.service');
const { CrmMemoryStore } = Store;
const Memory = require('../src/services/crm-memory.service');
const { CrmMemoryService } = Memory;
const AI = require('../src/services/ai.service');
const SalesBrain = require('../src/services/sales-brain.service');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const POLICY = require('../src/services/crm-memory-policy.json');

async function setup() {
    createTestDB();
    const business = await DB.createInstance({ name: 'Memory hotel', businessType: 'hotel' });
    const chat = '79990008811@c.us';
    await DB.getOrCreateClient(business.id, chat, 'Guest');
    return { business, chat };
}
async function messages(business, chat) {
    await DB.saveMessage(business.id, chat, 'Guest', 'Нужен тихий номер с 10 по 15 сентября.', 'user');
    await DB.saveMessage(business.id, chat, 'Bot', 'Уточните число гостей, пожалуйста.', 'assistant');
}
function output(ids) {
    return {
        relevance: 'relevant',
        summary: 'Гость подбирает тихое размещение на сентябрь и ещё не уточнил состав гостей.',
        needs: 'Тихий номер',
        budget: null,
        interests: ['проживание'],
        objections: [],
        dates: ['10–15 сентября'],
        preferences: ['тишина'],
        next_step: 'Уточнить число гостей',
        evidence_ids: ids,
    };
}

function enableMemoryForTest(businessId) {
    const saved = Object.fromEntries(['CRM_MEMORY_ENABLED', 'CRM_MEMORY_SCOPE', 'CRM_MEMORY_BUSINESS_IDS']
        .map((key) => [key, process.env[key]]));
    process.env.CRM_MEMORY_ENABLED = 'true';
    process.env.CRM_MEMORY_SCOPE = 'allowlist';
    process.env.CRM_MEMORY_BUSINESS_IDS = String(businessId);
    return () => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    };
}

describe('Durable CRM memory', () => {
    it('covers newly active businesses for conversation and call memory with isolated current settings', async () => {
        const savedEnv = Object.fromEntries(['CRM_MEMORY_ENABLED', 'CRM_MEMORY_SCOPE', 'CRM_MEMORY_BUSINESS_IDS'].map((key) => [key, process.env[key]]));
        const originalGenerate = AI.generatePlainText, originalResolve = AI._resolveProviderConfig;
        try {
            process.env.CRM_MEMORY_ENABLED = 'true';
            process.env.CRM_MEMORY_SCOPE = 'all_active';
            process.env.CRM_MEMORY_BUSINESS_IDS = '1'; // Legacy rollout must not restrict all_active.
            const { business, chat } = await setup();
            const coffee = await DB.createInstance({ name: 'New coffee', businessType: 'coffee_shop' });
            const inactive = await DB.createInstance({ name: 'Inactive' });
            DB.run('UPDATE instances SET isActive=0 WHERE id=?', [inactive.id]);
            await DB.getOrCreateClient(coffee.id, chat, 'Coffee guest');
            await messages(business, chat);
            await messages(coffee, chat);
            Store.enqueueCall({ instanceId: business.id, chatId: chat, callId: 'coverage-call' },
                { text: 'Клиент уточняет условия размещения.', identityConfidence: 'exact' });
            Store.enqueueCall({ instanceId: coffee.id, chatId: chat, callId: 'coverage-call' },
                { text: 'Клиент уточняет заказ кофе.', identityConfidence: 'exact' });
            DB.run('UPDATE crm_memory_jobs SET nextAttemptAt=0');
            const seen = [];
            AI._resolveProviderConfig = (instance) => ({ model: `business-${instance.id}` });
            AI.generatePlainText = async (prompt, instance) => {
                const source = JSON.parse(prompt[1].content);
                seen.push([instance.id, source.business_domain]);
                assert.strictEqual(source.business_domain, instance.businessType);
                return JSON.stringify(output([source.messages[0].id]));
            };
            const worker = new CrmMemoryService();
            for (let i = 0; i < 4; i++) assert.strictEqual(await worker.processOne(), true);
            assert.deepStrictEqual(Store.enabledBusinessIds(), [business.id, coffee.id]);
            assert.strictEqual(seen.length, 4);
            for (const id of [business.id, coffee.id]) {
                assert.strictEqual(Store.latest(id, chat, 'conversation').status, 'ai_summary');
                assert.strictEqual(Store.latest(id, chat, 'call').domain, id === coffee.id ? 'coffee_shop' : 'hotel');
                assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM crm_memory_summaries WHERE instanceId=?', [id]).n, 2);
            }
            assert.strictEqual(Store.latest(inactive.id, chat), null);
        } finally {
            AI.generatePlainText = originalGenerate; AI._resolveProviderConfig = originalResolve;
            for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        }
    });

    it('keeps allowlist fail-closed and reports overdue unserved jobs without customer data', async () => {
        const savedEnv = Object.fromEntries(['CRM_MEMORY_ENABLED', 'CRM_MEMORY_SCOPE', 'CRM_MEMORY_BUSINESS_IDS'].map((key) => [key, process.env[key]]));
        try {
            const { business, chat } = await setup();
            await messages(business, chat);
            process.env.CRM_MEMORY_ENABLED = 'true';
            process.env.CRM_MEMORY_SCOPE = 'allowlist';
            process.env.CRM_MEMORY_BUSINESS_IDS = String(business.id + 1);
            DB.run('UPDATE crm_memory_jobs SET createdAt=0,nextAttemptAt=0');
            assert.strictEqual(await new CrmMemoryService().processOne({ businessIds: [business.id] }), false);
            assert.strictEqual(DB.get('SELECT attempts FROM crm_memory_jobs').attempts, 0);
            const coverage = Store.coverage();
            assert.strictEqual(coverage.uncovered_jobs, 1);
            assert.strictEqual(coverage.overdue_unattempted_jobs, 1);
            assert.strictEqual(Store.diagnostics(business.id).overdue_unattempted_jobs, 1);
            assert.ok(!JSON.stringify(coverage).includes(chat));
            process.env.CRM_MEMORY_BUSINESS_IDS = 'bad';
            assert.throws(() => Store.enabledBusinessIds());
            process.env.CRM_MEMORY_SCOPE = 'unknown';
            assert.throws(() => Store.enabledBusinessIds());
            process.env.CRM_MEMORY_SCOPE = 'all_active';
            process.env.CRM_MEMORY_ENABLED = 'false';
            assert.deepStrictEqual(Store.enabledBusinessIds(), []);
            assert.strictEqual(await new CrmMemoryService().processOne(), false);
            assert.strictEqual(DB.get('SELECT attempts FROM crm_memory_jobs').attempts, 0);
            DB.run("UPDATE crm_memory_jobs SET state='dead_letter'");
            assert.strictEqual(Store.latest(business.id, chat).status, 'generation_failed');
            assert.strictEqual(Store.latest(business.id, chat).update_pending, false);
        } finally {
            for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        }
    });

    it('strips off-topic facts and recommendations even when the model includes them', () => {
        const source = {
            domain: 'hotel',
            messages: [{ id: 'message:1', role: 'user', text: 'Посторонний личный разговор.' }],
        };
        for (const relevance of ['out_of_scope', 'no_business_facts']) {
            const result = Memory.validate(
                JSON.stringify({
                    ...output(['message:1']),
                    relevance,
                    evidence_ids: [],
                    summary: 'PERSONAL_PRIVATE_SUMMARY',
                    needs: 'PERSONAL_PRIVATE_NEEDS',
                    preferences: ['PERSONAL_PRIVATE_PREFERENCE'],
                    next_step: 'PERSONAL_PRIVATE_TASK',
                }),
                source
            );
            assert.ok(!JSON.stringify(result).includes('PERSONAL_PRIVATE'));
            assert.strictEqual(result.next_step, null);
            assert.strictEqual(result.domain, 'hotel');
            assert.deepStrictEqual(result.interests, []);
        }
        const relevant = Memory.validate(
            JSON.stringify({ ...output(['message:1']), relevance: 'mixed' }),
            source
        );
        assert.strictEqual(relevant.needs, 'Тихий номер');
        assert.throws(() => Memory.validate(JSON.stringify(output([])), source));
        assert.throws(() =>
            Memory.validate(JSON.stringify({ ...output(['message:1']), domain: 'standard' }), source)
        );
        assert.throws(() =>
            Memory.validate(JSON.stringify({ ...output(['message:1']), relevance: 'unknown' }), source)
        );
    });

    it('invalidates old/domain-changed summaries without raw profile or message fallback', async () => {
        const { business, chat } = await setup();
        await messages(business, chat);
        const due = DB.get('SELECT nextAttemptAt FROM crm_memory_jobs').nextAttemptAt;
        const job = Store.lease(due);
        Store.finish(job, output(['message:1']), Store.source(job), 'test', due + 1);
        DB.run("UPDATE crm_memory_summaries SET promptVersion='crm-memory-v1',summaryJson=?", [
            JSON.stringify({
                ...output(['message:1']),
                summary: 'OLD_PERSONAL_SUMMARY',
                needs: 'OLD_PERSONAL_NEEDS',
            }),
        ]);
        DB.run('UPDATE messages SET content=?', ['OLD_PERSONAL_MESSAGE']);
        assert.strictEqual(Store.latest(business.id, chat).status, 'policy_refresh_required');
        const summary = await SalesBrain.customerSummary({ instanceId: business.id, chatId: chat });
        assert.ok(!summary.summary_for_voice.includes('OLD_PERSONAL'));
        assert.deepStrictEqual(summary.memory.key_facts, []);
        DB.run("UPDATE crm_memory_jobs SET sourceHash='legacy-hash'");
        assert.strictEqual(Store.refreshPolicyJobs(business.id).enqueued, 1);
        assert.strictEqual(Store.refreshPolicyJobs(business.id).enqueued, 0);
        const refreshed = DB.get('SELECT * FROM crm_memory_jobs');
        assert.strictEqual(JSON.parse(refreshed.payloadJson).policyVersion, POLICY.version);
        const running = Store.lease(refreshed.nextAttemptAt);
        const source = Store.source(running);
        DB.run("UPDATE instances SET businessType='coffee_shop' WHERE id=?", [business.id]);
        assert.strictEqual(
            Store.finish(running, output(['message:1']), source, 'test', refreshed.nextAttemptAt + 1),
            false
        );
        Store.refreshPolicyJob(running);
        assert.strictEqual(
            JSON.parse(DB.get('SELECT payloadJson FROM crm_memory_jobs').payloadJson).domain,
            'coffee_shop'
        );
        assert.strictEqual(Store.current(running, refreshed.nextAttemptAt + 1), undefined);
    });

    it('upgrades retained call sources but never regenerates completed calls from a replay', async () => {
        const { business, chat } = await setup();
        await SalesBrain.postCall({
            instanceId: business.id,
            chatId: chat,
            call_id: 'legacy-policy-call',
            transcript: 'Гость просит уточнить наличие тихого номера.',
        });
        const initial = DB.get('SELECT * FROM crm_memory_jobs');
        const payload = JSON.parse(initial.payloadJson);
        payload.policyVersion = 'crm-memory-v1';
        delete payload.domain;
        DB.run("UPDATE crm_memory_jobs SET payloadJson=?,sourceHash='old-source'", [JSON.stringify(payload)]);
        const old = Store.lease();
        assert.throws(
            () => Store.source(old),
            (error) => error.code === 'MEMORY_POLICY_CHANGED'
        );
        assert.strictEqual(Store.refreshPolicyJob(old).changed, true);
        const upgraded = DB.get('SELECT * FROM crm_memory_jobs');
        assert.strictEqual(JSON.parse(upgraded.payloadJson).text, payload.text);
        assert.strictEqual(upgraded.leaseToken, null);
        assert.strictEqual(
            Store.finish(
                old,
                output(['call:legacy-policy-call']),
                { domain: 'hotel', policyVersion: POLICY.version },
                'test'
            ),
            false
        );
        const lease = Store.lease();
        Store.finish(lease, output(['call:legacy-policy-call']), Store.source(lease), 'test');
        assert.strictEqual(Store.refreshPolicyJob(lease), null);
        await SalesBrain.postCall({
            instanceId: business.id,
            chatId: chat,
            call_id: 'legacy-policy-call',
            transcript: 'NEW_TEXT_MUST_NOT_REPLACE_THE_CALL',
        });
        assert.strictEqual(DB.get('SELECT payloadJson FROM crm_memory_jobs').payloadJson, null);
        assert.strictEqual(DB.get('SELECT sourceHash FROM crm_memory_jobs').sourceHash, upgraded.sourceHash);
    });

    it('paginates policy refresh without repeatedly counting already-current jobs', async () => {
        const { business, chat } = await setup();
        await messages(business, chat);
        const otherChat = '79990001234@c.us';
        await DB.getOrCreateClient(business.id, otherChat, 'Second guest');
        await messages(business, otherChat);
        DB.run("UPDATE crm_memory_jobs SET sourceHash='v1'");
        const first = Store.backfill(business.id, 1, { dryRun: false });
        assert.strictEqual(first.enqueued, 1);
        assert.ok(first.next_cursor);
        const second = Store.backfill(business.id, 1, { dryRun: false, afterCustomerId: first.next_cursor });
        assert.strictEqual(second.enqueued, 1);
        assert.strictEqual(second.next_cursor, null);
        assert.strictEqual(Store.backfill(business.id, 50, { dryRun: false }).enqueued, 0);
        assert.strictEqual(Store.backfill(business.id + 1, 50, { dryRun: false }).candidates, 0);
    });

    it('keeps repeated call IDs and phones separate across businesses', async () => {
        const { business, chat } = await setup();
        const other = await DB.createInstance({ name: 'Second call hotel' });
        await DB.getOrCreateClient(other.id, chat, 'Other guest');
        for (const instanceId of [business.id, other.id]) {
            await SalesBrain.postCall({
                instanceId,
                chatId: chat,
                call_id: 'same-provider-call-id',
                transcript: `Гость отеля ${instanceId} уточняет возможность позднего заезда.`,
                tool_runs: [{ name: 'get_hotel_info', status: 'ok' }],
            });
        }
        assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM crm_memory_jobs WHERE kind='call'").n, 2);
        assert.deepStrictEqual(
            DB.all("SELECT instanceId FROM ml_decisions WHERE taskType='post_call' ORDER BY instanceId").map(
                (row) => row.instanceId
            ),
            [business.id, other.id]
        );
        assert.strictEqual(
            DB.get("SELECT COUNT(*) AS n FROM tool_runs WHERE toolName='get_hotel_info'").n,
            2
        );
    });

    it('protects memory admin endpoints and keeps backfill dry-run and retry tenant-scoped', async () => {
        const { business, chat } = await setup();
        await messages(business, chat);
        DB.run('DELETE FROM crm_memory_jobs');
        const express = require('express');
        const { AuthService } = require('../src/services/auth.service');
        const app = express();
        const auth = new AuthService({ enabled: true });
        app.use(express.json());
        app.use('/api/ml', auth.requireServiceToken.bind(auth), require('../src/routes/ml.routes'));
        const old = process.env.CRM_SERVICE_API_TOKEN;
        process.env.CRM_SERVICE_API_TOKEN = 'memory-test-service-token';
        const server = await new Promise((resolve) => {
            const value = app.listen(0, '127.0.0.1', () => resolve(value));
        });
        const base = `http://127.0.0.1:${server.address().port}/api/ml/memory`;
        const headers = {
            Authorization: 'Bearer memory-test-service-token',
            'Content-Type': 'application/json',
        };
        try {
            assert.strictEqual((await fetch(`${base}/status?business_id=${business.id}`)).status, 401);
            const dry = await fetch(`${base}/backfill`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ business_id: business.id }),
            });
            assert.strictEqual((await dry.json()).dry_run, true);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM crm_memory_jobs').n, 0);
            const invalid = await fetch(`${base}/backfill`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ business_id: true, dry_run: false }),
            });
            assert.strictEqual(invalid.status, 400);
            const actual = await fetch(`${base}/backfill`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ business_id: business.id, dry_run: false }),
            });
            assert.strictEqual((await actual.json()).enqueued, 1);
            const job = DB.get('SELECT jobId FROM crm_memory_jobs');
            DB.run("UPDATE crm_memory_jobs SET state='dead_letter'");
            const foreign = await fetch(`${base}/retry`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ business_id: business.id + 1, job_id: job.jobId }),
            });
            assert.strictEqual((await foreign.json()).retried, false);
            const status = await fetch(`${base}/status?business_id=${business.id}`, { headers });
            const body = JSON.stringify(await status.json());
            assert.ok(!body.includes('payloadJson') && !body.includes('chatId'));
        } finally {
            await new Promise((resolve) => server.close(resolve));
            if (old === undefined) delete process.env.CRM_SERVICE_API_TOKEN;
            else process.env.CRM_SERVICE_API_TOKEN = old;
        }
    });

    it('enqueues atomically with messages, debounces and never copies raw WhatsApp history into jobs', async () => {
        const { business, chat } = await setup();
        await messages(business, chat);
        const initial = DB.get('SELECT * FROM crm_memory_jobs');
        assert.strictEqual(initial.kind, 'conversation');
        assert.ok(!initial.payloadJson.includes('Нужен'));
        assert.strictEqual(Store.lease(initial.nextAttemptAt - 1), null);
        await DB.saveMessage(business.id, chat, 'Guest', 'Двое взрослых', 'user');
        const updated = DB.get('SELECT * FROM crm_memory_jobs');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM crm_memory_jobs').n, 1);
        assert.notStrictEqual(initial.sourceHash, updated.sourceHash);
        assert.strictEqual(JSON.parse(updated.payloadJson).count, 3);
        const before = DB.get('SELECT COUNT(*) AS n FROM messages').n;
        const original = Store.enqueueConversation;
        Store.enqueueConversation = () => {
            throw new Error('simulated transaction failure');
        };
        try {
            await assert.rejects(() => DB.saveMessage(business.id, chat, 'Guest', 'must rollback', 'user'));
        } finally {
            Store.enqueueConversation = original;
        }
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM messages').n, before);
    });

    it('leases once across two SQLite connections and fences expired or foreign workers', async () => {
        const { business, chat } = await setup();
        await messages(business, chat);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-memory-test-'));
        const file = path.join(dir, 'crm.db');
        await DB.db.backup(file);
        const connections = [new Database(file), new Database(file)];
        const stores = connections.map(
            (db) =>
                new CrmMemoryStore({
                    db,
                    get: (sql, p = []) => db.prepare(sql).get(...p),
                    run: (sql, p = []) => db.prepare(sql).run(...p),
                    all: (sql, p = []) => db.prepare(sql).all(...p),
                })
        );
        try {
            const due = DB.get('SELECT nextAttemptAt FROM crm_memory_jobs').nextAttemptAt;
            const first = stores[0].lease(due, 1000);
            assert.ok(first);
            assert.strictEqual(stores[1].lease(due), null);
            const second = stores[1].lease(due + 1001);
            assert.ok(second);
            assert.notStrictEqual(first.leaseToken, second.leaseToken);
            assert.strictEqual(
                stores[0].finish(first, output(['message:1']), { complete: true }, 'test', due + 1002),
                false
            );
            assert.strictEqual(
                stores[1].finish(
                    { ...second, instanceId: 999 },
                    output(['message:1']),
                    { complete: true },
                    'test',
                    due + 1002
                ),
                false
            );
            assert.strictEqual(
                stores[1].finish(second, output(['message:1']), stores[1].source(second), 'test', due + 1002),
                true
            );
        } finally {
            connections.forEach((db) => db.close());
            fs.rmSync(dir, { recursive: true });
        }
    });

    it('retries with finite backoff, redacts errors and eventually enters dead letter', async () => {
        const { business, chat } = await setup();
        await messages(business, chat);
        let now = DB.get('SELECT nextAttemptAt FROM crm_memory_jobs').nextAttemptAt;
        for (const [index, delay] of [5000, 15000, 60000, 300000, 1800000, 7200000, 0].entries()) {
            const job = Store.lease(now);
            assert.strictEqual(job.attempts, index + 1);
            Store.fail(
                job,
                Object.assign(new Error('Bearer secret123 password=hidden https://u:pw@example.test'), {
                    code: 'AI_ERROR',
                }),
                now
            );
            const row = DB.get('SELECT * FROM crm_memory_jobs');
            assert.strictEqual(row.nextAttemptAt, now + delay);
            assert.ok(
                !row.lastErrorMessage.includes('secret123') &&
                    !row.lastErrorMessage.includes('hidden') &&
                    !row.lastErrorMessage.includes('u:pw')
            );
            assert.strictEqual(row.state, index === 6 ? 'dead_letter' : 'pending');
            now += delay;
        }
        assert.strictEqual(Store.lease(now + 999999), null);
        const diagnostic = JSON.stringify(Store.diagnostics(business.id));
        assert.ok(!diagnostic.includes('payloadJson') && !diagnostic.includes('password'));
        const failed = DB.get('SELECT jobId FROM crm_memory_jobs');
        assert.strictEqual(Store.retryJob(business.id + 1, failed.jobId, now), false);
        assert.strictEqual(Store.retryJob(business.id, failed.jobId, now), true);
        assert.strictEqual(Store.lease(now).attempts, 1);
    });

    it('bounds source input, rejects groups and separates identical phones in two businesses', async () => {
        const { business, chat } = await setup();
        const other = await DB.createInstance({ name: 'Other hotel' });
        await DB.getOrCreateClient(other.id, chat, 'Other guest');
        await messages(other, chat);
        for (let i = 0; i < 55; i++)
            await DB.saveMessage(business.id, chat, 'Guest', `own message ${i}`, 'user');
        await DB.getOrCreateClient(business.id, '12345@g.us', 'Group');
        await messages(business, '12345@g.us');
        assert.strictEqual(Store.scope(business.id, '12345@g.us'), null);
        const row = DB.get('SELECT * FROM crm_memory_jobs WHERE instanceId=?', [business.id]);
        const source = Store.source(row);
        assert.strictEqual(source.complete, false);
        assert.strictEqual(source.messages.length, 50);
        assert.ok(source.messages.every((message) => message.text.startsWith('own message')));
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM crm_memory_jobs').n, 2);
        assert.strictEqual(Store.lease(Date.now() + 31000, 120000, []), null);
        assert.strictEqual(Store.lease(Date.now() + 31000, 120000, [other.id]).instanceId, other.id);
    });

    it('validates evidence, rejects verbatim/foreign/extra fields and strips private values', () => {
        const source = {
            domain: 'hotel',
            messages: [{ id: 'message:1', role: 'user', text: 'Исходная реплика гостя без дополнительных данных.' }],
        };
        const valid = output(['message:1']);
        assert.ok(Memory.validate(JSON.stringify(valid), source).summary);
        assert.throws(() => Memory.validate(JSON.stringify(valid), {
            ...source, messages: [{ ...source.messages[0], role: 'assistant' }],
        }));
        for (const data of [
            { ...valid, evidence_ids: ['message:999'] },
            { ...valid, summary: source.messages[0].text },
            { ...valid, send_whatsapp: true },
            { ...valid, budget: 50000 },
        ])
            assert.throws(() => Memory.validate(JSON.stringify(data), source));
        const safe = Memory.validate(
            JSON.stringify({
                ...valid,
                summary: 'Гость оставил контакт guest@example.test +7 (999) 123-45-67, token=hidden.',
            }),
            source
        );
        assert.ok(
            !safe.summary.includes('guest@example.test') &&
                !safe.summary.includes('123-45-67') &&
                !safe.summary.includes('hidden')
        );
    });

    it('generates persisted chat memory without sending messages or changing CRM stage', async () => {
        const { business, chat } = await setup();
        await messages(business, chat);
        DB.run('UPDATE crm_memory_jobs SET nextAttemptAt=0');
        const originalGenerate = AI.generatePlainText,
            originalResolve = AI._resolveProviderConfig;
        const restorePolicy = enableMemoryForTest(business.id);
        AI._resolveProviderConfig = () => ({ model: 'test-model' });
        AI.generatePlainText = async (prompt, instance) => {
            assert.strictEqual(instance.id, business.id);
            const source = JSON.parse(prompt[1].content);
            assert.ok(!prompt[0].content.includes(chat));
            return JSON.stringify(output([source.messages[0].id]));
        };
        try {
            assert.strictEqual(await new CrmMemoryService().processOne(), true);
        } finally {
            AI.generatePlainText = originalGenerate;
            AI._resolveProviderConfig = originalResolve;
            restorePolicy();
        }
        const row = DB.get('SELECT * FROM crm_memory_jobs');
        assert.strictEqual(row.state, 'done');
        assert.strictEqual(row.payloadJson, null);
        const latest = Store.latest(business.id, chat);
        assert.strictEqual(latest.provenance, 'ai_generated');
        assert.strictEqual(latest.needs, 'Тихий номер');
        assert.strictEqual(
            DB.get('SELECT leadStatus FROM clients WHERE instanceId=?', [business.id]).leadStatus,
            'new'
        );
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM messages').n, 2);
        assert.strictEqual(Store.latest(business.id + 1, chat), null);
    });

    it('discards a late result when a new message or tenant disable invalidates its lease', async () => {
        const { business, chat } = await setup();
        await messages(business, chat);
        DB.run('UPDATE crm_memory_jobs SET nextAttemptAt=0');
        const originalGenerate = AI.generatePlainText,
            originalResolve = AI._resolveProviderConfig;
        const restorePolicy = enableMemoryForTest(business.id);
        let generationCalls = 0;
        AI._resolveProviderConfig = () => ({ model: 'test-model' });
        AI.generatePlainText = async (prompt) => {
            generationCalls++;
            await DB.saveMessage(business.id, chat, 'Guest', 'Обновление: теперь трое гостей.', 'user');
            return JSON.stringify(output([JSON.parse(prompt[1].content).messages[0].id]));
        };
        try {
            assert.strictEqual(await new CrmMemoryService().processOne(), false);
            assert.strictEqual(generationCalls, 1);
        } finally {
            AI.generatePlainText = originalGenerate;
            AI._resolveProviderConfig = originalResolve;
            restorePolicy();
        }
        assert.strictEqual(Store.latest(business.id, chat).status, 'generation_pending');
        assert.strictEqual(DB.get('SELECT state FROM crm_memory_jobs').state, 'pending');
        const job = Store.lease(Date.now() + 31000);
        DB.run('UPDATE instances SET isActive=0 WHERE id=?', [business.id]);
        assert.strictEqual(
            Store.finish(job, output(['message:1']), { complete: true }, 'test', Date.now() + 31001),
            false
        );
    });

    it('atomically queues post-call data and exports only generated call summaries', async () => {
        const { business, chat } = await setup();
        await SalesBrain.postCall({
            instanceId: business.id,
            chatId: chat,
            call_id: 'call-memory',
            caller_number: '+79990008811',
            transcript: 'Клиент: Нужен тихий номер на сентябрь. Ассистент: Уточните даты.',
            direction: 'inbound',
        });
        const job = DB.get('SELECT * FROM crm_memory_jobs WHERE kind=?', ['call']);
        assert.ok(job);
        assert.strictEqual(JSON.parse(job.payloadJson).sourceComplete, true);
        await SalesBrain.postCall({
            instanceId: business.id,
            chatId: chat,
            call_id: 'call-memory',
            transcript: 'Changed replay cannot replace accepted source',
        });
        assert.strictEqual(DB.get('SELECT sourceHash FROM crm_memory_jobs').sourceHash, job.sourceHash);
        const lease = Store.lease();
        const source = Store.source(lease);
        assert.strictEqual(Store.finish(lease, output(['call:call-memory']), source, 'test-model'), true);
        const event = DB.get("SELECT * FROM conversation_events WHERE role='summary'");
        assert.strictEqual(event.instanceId, business.id);
        assert.strictEqual(event.callId, 'call-memory');
        assert.strictEqual(JSON.parse(event.metadataJson).summary_provenance, 'ai_generated');
        assert.ok(!event.content.includes('Клиент:'));
        assert.strictEqual(DB.get('SELECT payloadJson FROM crm_memory_jobs').payloadJson, null);
    });

    it('does not assign call memory from a fuzzy match or from an opaque LID treated as a phone', async () => {
        const { business } = await setup();
        const lid = '79990009999@lid';
        await DB.getOrCreateClient(business.id, lid, 'LID guest');
        const event = DB.createConversationEvent({
            instanceId: business.id,
            chatId: lid,
            callId: 'lid-call',
            content: 'note',
        });
        assert.strictEqual(
            Store.enqueueCall(event, { text: 'Enough text for a call source', identityConfidence: 'weak' }),
            null
        );
        assert.strictEqual(
            Store.enqueueCall(event, {
                text: 'Enough text for a call source',
                identityConfidence: 'exact',
                phone: '+79990009999',
            }),
            null
        );
        const resolved = await SalesBrain.resolveCustomer({
            instanceId: business.id,
            phone: '+79990009999',
            name: 'LID guest',
        });
        assert.strictEqual(resolved.found, false);
        const suffix = await SalesBrain.resolveCustomer({ instanceId: business.id, phone: '90008811' });
        assert.strictEqual(suffix.found, false);
        const group = await DB.getOrCreateClient(business.id, '79990009999@g.us', 'Group');
        assert.strictEqual(
            (await SalesBrain.resolveCustomer({ instanceId: business.id, chatId: group.chatId })).found,
            false
        );
    });
});
