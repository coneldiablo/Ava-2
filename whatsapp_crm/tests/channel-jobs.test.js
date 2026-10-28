'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Jobs = require('../src/services/channel-jobs.store');

async function fixture() {
    createTestDB();
    const tenant = await DB.createInstance({ name: 'Durable jobs fixture' });
    await DB.getOrCreateClient(tenant.id, 'tg_10001', 'Fixture customer');
    return { instanceId: tenant.id, chatId: 'tg_10001', originChatId: 'tg_10001', channel: 'telegram',
        providerMessageId: '5', text: 'Fixture question', senderName: 'Fixture customer', meta: { telegramChatId: '10001' } };
}

function expire(job) {
    DB.run('UPDATE channel_inbound_jobs SET leaseUntil=? WHERE leaseToken=?', [Date.now() - 1, job.leaseToken]);
}

describe('Durable channel inbound jobs', () => {
    it('atomically writes inbound and job, rolls both back on failure, and repairs legacy replay', async () => {
        const input = await fixture();
        Jobs.ensureSchema();
        const run = DB.run;
        DB.run = function(sql, args) {
            if (sql.startsWith('INSERT INTO channel_inbound_jobs')) throw new Error('synthetic job storage failure');
            return run.call(this, sql, args);
        };
        try { assert.throws(() => Jobs.enqueue(input), /synthetic/); } finally { DB.run = run; }
        assert.strictEqual(DB.get('SELECT COUNT(*) AS count FROM messages').count, 0);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS count FROM channel_inbound_jobs').count, 0);

        const created = Jobs.enqueue(input);
        assert.strictEqual(created.inserted, true);
        assert.strictEqual(Jobs.enqueue(input).inserted, false);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS count FROM messages').count, 1);
        assert.strictEqual(DB.get('SELECT sourceMessageId FROM messages').sourceMessageId, 'tg_10001:5');

        await DB.saveMessageWithChannel(input.instanceId, input.chatId, input.senderName, 'Legacy fixture', 'user', 'telegram', null, '6');
        const repaired = Jobs.recordInbound({ ...input, providerMessageId: '6', text: 'Legacy fixture' });
        assert.strictEqual(repaired.inserted, true);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS count FROM messages').count, 2);
    });

    it('deduplicates by tenant, channel and origin while resolving confirmed canonical identities', async () => {
        const input = await fixture();
        const otherTenant = await DB.createInstance({ name: 'Second durable fixture' });
        await DB.getOrCreateClient(otherTenant.id, input.chatId, 'Other fixture');
        await DB.getOrCreateClient(input.instanceId, 'tg_10002', 'Second fixture');
        Jobs.enqueue(input);
        Jobs.enqueue({ ...input, instanceId: otherTenant.id });
        Jobs.enqueue({ ...input, chatId: 'tg_10002', originChatId: 'tg_10002' });
        require('../src/services/client-identity.service').resolve(input.instanceId, input.chatId);
        DB.run('INSERT INTO client_aliases(instanceId,chatId,kind,value) VALUES(?,?,?,?)',
            [input.instanceId, input.chatId, 'telegram', '10003']);
        const linked = Jobs.enqueue({ ...input, chatId: 'tg_10003', originChatId: 'tg_10003' });
        assert.strictEqual(linked.job.chatId, input.chatId);
        assert.strictEqual(linked.job.originChatId, 'tg_10003');
        assert.strictEqual(Jobs.get({ instanceId: otherTenant.id, id: linked.job.id }), null);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS count FROM channel_inbound_jobs').count, 4);
        const firstDestination = Jobs.claimBatch({ instanceId: input.instanceId, chatId: input.chatId });
        assert.strictEqual(firstDestination.ids.length, 1, 'distinct Telegram contacts must receive distinct replies');
        assert.strictEqual(firstDestination.originChatId, 'tg_10001');
        assert.throws(() => Jobs.enqueue({ ...input, instanceId: 0 }), /TENANT_INVALID/);
        assert.throws(() => Jobs.claim({ chatId: input.chatId }), /TENANT_REQUIRED/);
    });

    it('fences independent database workers, stale tokens and a customer with an active claim', async () => {
        const input = await fixture();
        Jobs.enqueue(input);
        Jobs.enqueue({ ...input, providerMessageId: '6' });
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-channel-jobs-'));
        const filename = path.join(directory, 'jobs.db');
        await DB.db.backup(filename);
        const original = DB.db;
        const first = new Database(filename);
        const second = new Database(filename);
        try {
            DB.db = first;
            const worker1 = Jobs.claim({ instanceId: input.instanceId });
            DB.db = second;
            assert.strictEqual(Jobs.claim({ instanceId: input.instanceId }), null);
            assert.strictEqual(Jobs.prepare({ ...worker1, leaseToken: 'stale' }, { reply: 'Ignored' }), null);
            assert.strictEqual(Jobs.isCurrent(worker1), true);
            assert.strictEqual(Jobs.suppress(worker1, 'HUMAN_TAKEOVER').status, 'suppressed');
            assert.ok(Jobs.claim({ instanceId: input.instanceId }));
        } finally {
            DB.db = original;
            first.close(); second.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('recovers prepared work with its original response and batch, keeping new inbound separate', async () => {
        const input = await fixture();
        Jobs.enqueue(input);
        Jobs.enqueue({ ...input, providerMessageId: '6', text: 'Second fixture question' });
        const job = Jobs.claimBatch({ instanceId: input.instanceId, chatId: input.chatId });
        assert.strictEqual(job.ids.length, 2);
        Jobs.prepare(job, { reply: 'Saved fixture response' }, { revision: 3 });
        Jobs.enqueue({ ...input, providerMessageId: '7', text: 'New fixture question' });
        expire(job);
        assert.strictEqual(Jobs.isCurrent(job), false);
        assert.strictEqual(Jobs.markSending(job), null);
        assert.deepStrictEqual(Jobs.recoverExpiredLeases(), { retry: 2, unknown: 0 });
        const recovered = Jobs.claimBatch({ instanceId: input.instanceId, chatId: input.chatId });
        assert.deepStrictEqual(recovered.ids, job.ids);
        assert.notStrictEqual(recovered.leaseToken, job.leaseToken);
        assert.strictEqual(recovered.batchKey, job.batchKey);
        assert.strictEqual(recovered.response.reply, 'Saved fixture response');
        assert.deepStrictEqual(recovered.guardSnapshot, { revision: 3 });
        assert.strictEqual(Jobs.prepare(job, { reply: 'Old worker' }), null);
        Jobs.retry(recovered, 'WORKSPACE_DIALOGUE_CHANGED', { delayMs: 0 });
        const revised = Jobs.claimBatch({ instanceId: input.instanceId, chatId: input.chatId });
        assert.strictEqual(revised.ids.length, 3, 'dialogue change regroups new inbound with stale work');
        assert.strictEqual(revised.response, null);
        assert.strictEqual(revised.guardSnapshot, null);
    });

    it('turns a crashed send into unknown, blocks later work, and never claims it again', async () => {
        const input = await fixture();
        Jobs.enqueue(input);
        const job = Jobs.claim({ instanceId: input.instanceId });
        assert.strictEqual(Jobs.markSending(job), null, 'response must be durable before sending');
        Jobs.prepare(job, { reply: 'Fixture response' }, { revision: 1 });
        assert.strictEqual(Jobs.markSending(job).status, 'sending');
        assert.strictEqual(Jobs.retry(job, 'NETWORK_TIMEOUT', { delayMs: 0 }), null, 'ambiguous send cannot retry');
        Jobs.enqueue({ ...input, providerMessageId: '6' });
        expire(job);
        assert.deepStrictEqual(Jobs.recoverExpiredLeases(), { retry: 0, unknown: 1 });
        assert.strictEqual(Jobs.get(job).status, 'unknown');
        assert.strictEqual(Jobs.claim({ instanceId: input.instanceId }), null);
        assert.strictEqual(Jobs.enqueue(input).inserted, false);
        assert.strictEqual(Jobs.retry(job, 'NETWORK_TIMEOUT', { delayMs: 0, definiteNoSideEffect: true }), null);
        const lateAck = Jobs.ack(job, { providerMessageId: '99' });
        assert.strictEqual(lateAck.status, 'acknowledged', 'positive late provider evidence resolves original send');
    });

    it('repairs acknowledged batch history after restart once without reentering send', async () => {
        const input = await fixture();
        Jobs.enqueue(input);
        Jobs.enqueue({ ...input, providerMessageId: '6' });
        const job = Jobs.claimBatch({ instanceId: input.instanceId, chatId: input.chatId });
        Jobs.prepare(job, { reply: 'Acknowledged fixture response' });
        Jobs.markSending(job);
        Jobs.ack(job, { providerMessageId: '101' });
        const waiting = Jobs.pending({ instanceId: input.instanceId });
        assert.strictEqual(waiting.length, 1, 'one history repair per batch');
        assert.deepStrictEqual(waiting[0].ids, job.ids);
        assert.strictEqual(waiting[0].batchKey, job.batchKey);
        assert.strictEqual(Jobs.claimBatch({ instanceId: input.instanceId }), null);
        assert.strictEqual(Jobs.markSending(waiting[0]), null);
        const saved = await DB.saveMessageWithChannel(input.instanceId, input.chatId, 'AVA', waiting[0].response.reply,
            'assistant', 'telegram', null, `telegram-reply:${waiting[0].responseKey}`);
        assert.strictEqual(Jobs.complete(waiting[0], { storedMessageId: saved.id }).status, 'completed');
        assert.strictEqual(Jobs.pending({ instanceId: input.instanceId }).length, 0);
        assert.strictEqual(DB.get("SELECT COUNT(*) AS count FROM messages WHERE role='assistant'").count, 1);
        assert.strictEqual(DB.get("SELECT COUNT(*) AS count FROM channel_inbound_jobs WHERE status='completed'").count, 2);
    });

    it('retries only definite failed sends and ends bounded processing failures', async () => {
        const input = await fixture();
        Jobs.enqueue(input);
        let job = Jobs.claim({ instanceId: input.instanceId });
        Jobs.prepare(job, { reply: 'Fixture response' });
        Jobs.markSending(job);
        assert.strictEqual(Jobs.retry(job, 'PROVIDER_RATE_LIMIT', { delayMs: 0, definiteNoSideEffect: true, guardSnapshot: { revision: 7 } }).status, 'retry');
        job = Jobs.claim({ instanceId: input.instanceId });
        assert.strictEqual(job.response.reply, 'Fixture response');
        assert.deepStrictEqual(job.guardSnapshot, { revision: 7 });
        DB.run('UPDATE channel_inbound_jobs SET attempts=maxAttempts WHERE id=?', [job.id]);
        const failed = Jobs.retry(job, new Error('provider secret payload'), { delayMs: 0 });
        assert.strictEqual(failed.status, 'failed');
        assert.strictEqual(failed.lastErrorCode, 'CHANNEL_JOB_PROCESSING_FAILED');
        assert.strictEqual(Jobs.claim({ instanceId: input.instanceId }), null);
    });
});
