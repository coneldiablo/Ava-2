'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { describe, it, assert } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identities = require('../src/services/client-identity.service');
const Access = require('../src/services/identity/identity-store');
const SalesBrain = require('../src/services/sales-brain.service');
const MemoryStore = require('../src/services/crm-memory-store.service');
const Memory = require('../src/services/crm-memory.service');
const AI = require('../src/services/ai.service');
const Analytics = require('../src/services/ava-analytics.service');

function openTemporaryDatabase() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-acceptance-chain-'));
    const file = path.join(directory, 'acceptance.sqlite');
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    DB.db = db;
    DB.createTables();
    DB.ensureColumns();
    DB.migrateRagSchema();
    DB.createSalesBrainTables();
    DB.createPmsTables();
    DB.createTwentyTables();
    DB.createOnyxTables();
    DB.createProvisioningTables();
    DB.createBusinessGptTables();
    Access.ensureSchema();
    return { db, directory, file };
}

function addOwner(userId, businessId) {
    DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)', [userId, `${userId}@example.test`, userId]);
    DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [userId, businessId, 'hotel_owner']);
}

describe('AVA confirmed-contact to call, message, task, memory, and report chain', () => {
    it('keeps linked channel activity and idempotent post-call work on the canonical tenant client', async () => {
        const previousDb = DB.db;
        const { db, directory, file } = openTemporaryDatabase();
        const aiGenerate = AI.generatePlainText;
        const resolveProvider = AI._resolveProviderConfig;
        let memoryRequest = null;
        try {
            const business = await DB.createInstance({ name: 'Acceptance hotel', businessType: 'hotel' });
            const foreignBusiness = await DB.createInstance({ name: 'Foreign hotel', businessType: 'hotel' });
            const canonicalChat = '79990000111@c.us';
            const telegramChat = 'tg_123456';
            const alternateWhatsApp = '79990000222@s.whatsapp.net';
            const alternatePhone = '+79990000333';
            const callId = 'acceptance-chain-call-1';

            const canonical = await DB.getOrCreateClient(business.id, canonicalChat, 'Acceptance guest');
            await DB.getOrCreateClient(business.id, telegramChat, 'Telegram guest card');
            Identities.attach(business.id, canonicalChat, {
                kind: 'telegram', value: '123456', mergeChatId: telegramChat, confirmMerge: true,
            });
            Identities.attach(business.id, canonicalChat, { kind: 'whatsapp', value: alternateWhatsApp });
            Identities.attach(business.id, canonicalChat, { kind: 'phone', value: alternatePhone });

            const aliases = Identities.list(business.id, canonicalChat).aliases;
            assert.equal(Identities.resolve(business.id, telegramChat), canonicalChat);
            assert.equal(Identities.resolve(business.id, alternateWhatsApp), canonicalChat);
            assert.equal(Identities.resolve(business.id, alternatePhone), canonicalChat);
            assert.ok(aliases.some((alias) => alias.kind === 'telegram' && alias.value === '123456'));
            assert.ok(aliases.some((alias) => alias.kind === 'whatsapp' && alias.value === '79990000222@c.us'));
            assert.ok(aliases.some((alias) => alias.kind === 'phone' && alias.value === '+79990000333'));

            const foreign = await DB.getOrCreateClient(foreignBusiness.id, canonicalChat, 'Foreign guest');
            Identities.attach(foreignBusiness.id, canonicalChat, { kind: 'phone', value: alternatePhone });
            addOwner('chain-owner', business.id);
            addOwner('foreign-owner', foreignBusiness.id);

            const transcript = [
                { role: 'user', text: 'Нужен тихий номер на октябрь, позовите администратора для уточнения.' },
                { role: 'assistant', text: 'Здравствуйте! Подскажите, какие даты вам удобны? Передам вопрос администратору и уточню детали.' },
            ];
            const postCall = await SalesBrain.postCall({
                instanceId: business.id,
                callId,
                phone: alternatePhone,
                callerName: 'Acceptance guest',
                transcript,
                durationSec: 74,
            });

            assert.equal(postCall.success, true);
            assert.equal(postCall.resolved.chatId, canonicalChat);
            const callEvent = DB.getConversationEventById(postCall.crm_note.event_id);
            assert.equal(callEvent.instanceId, business.id);
            assert.equal(callEvent.chatId, canonicalChat);
            assert.equal(callEvent.callId, callId);

            const task = DB.getManagerTaskByCall(business.id, callId);
            assert.ok(task, 'guest request for an administrator creates a manager task');
            assert.equal(task.chatId, canonicalChat);
            assert.equal(task.customerId, `crm_${business.id}_${canonical.id}`);
            const taskEvent = DB.getConversationEventById(task.conversationEventId);
            assert.ok(taskEvent);
            assert.equal(taskEvent.instanceId, business.id);
            assert.equal(taskEvent.chatId, canonicalChat);
            assert.equal(taskEvent.callId, callId);
            assert.equal(taskEvent.content, task.summary);
            assert.match(task.summary, /администратор/i);

            const inbound = await DB.saveMessageWithChannel(
                business.id, telegramChat, 'Acceptance guest', 'Можно уточнить свободные даты?', 'user', 'telegram', null, 'tg-msg-1'
            );
            const outgoing = await DB.saveMessageWithChannel(
                business.id, alternateWhatsApp, 'Менеджер', 'Здравствуйте! Подскажите, какие даты вам удобны?', 'assistant', 'whatsapp', null, 'wa-msg-1'
            );
            assert.equal(inbound.inserted, true);
            assert.equal(outgoing.inserted, true);
            assert.equal(DB.get('SELECT chatId FROM messages WHERE instanceId=? AND id=?', [business.id, inbound.id]).chatId, canonicalChat);
            assert.equal(DB.get('SELECT chatId FROM messages WHERE instanceId=? AND id=?', [business.id, outgoing.id]).chatId, canonicalChat);

            const job = DB.get("SELECT * FROM crm_memory_jobs WHERE instanceId=? AND kind='call' AND sourceKey=?", [business.id, callId]);
            assert.ok(job, 'post-call writes the call-memory job');
            assert.equal(job.chatId, canonicalChat);
            assert.equal(JSON.parse(job.payloadJson).text.includes('тихий номер'), true);
            assert.equal(DB.get("SELECT chatId FROM ava_call_transcript_sources WHERE businessId=? AND sourceId=?", [business.id, callEvent.eventId]).chatId, canonicalChat);

            const retry = await SalesBrain.postCall({
                instanceId: business.id,
                callId,
                phone: alternatePhone,
                callerName: 'Acceptance guest',
                transcript,
                durationSec: 74,
            });
            assert.equal(retry.idempotent, true);
            assert.equal(DB.get("SELECT COUNT(*) AS n FROM conversation_events WHERE instanceId=? AND callId=? AND role='manager_note'", [business.id, callId]).n, 1);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM manager_tasks WHERE instanceId=? AND callId=?', [business.id, callId]).n, 1);
            assert.equal(DB.get("SELECT COUNT(*) AS n FROM crm_memory_jobs WHERE instanceId=? AND kind='call' AND sourceKey=?", [business.id, callId]).n, 1);

            AI.generatePlainText = async (messages, instance) => {
                memoryRequest = { instanceId: instance.id, input: JSON.parse(messages.at(-1).content) };
                return JSON.stringify({
                    relevance: 'relevant',
                    summary: 'Гость ищет тихий номер на октябрь и просит уточнить даты.',
                    needs: 'Тихий номер',
                    budget: null,
                    interests: ['размещение'],
                    objections: [],
                    dates: ['октябрь'],
                    preferences: ['тишина'],
                    next_step: 'Уточнить доступные даты',
                    evidence_ids: [`call:${callId}`],
                });
            };
            AI._resolveProviderConfig = () => ({ model: 'acceptance-stub' });
            assert.equal(await Memory.processOne(), true);
            AI.generatePlainText = aiGenerate;
            AI._resolveProviderConfig = resolveProvider;
            assert.equal(memoryRequest.instanceId, business.id);
            assert.equal(memoryRequest.input.business_domain, 'hotel');
            assert.deepEqual(memoryRequest.input.messages.map((message) => message.id), [`call:${callId}`]);
            assert.match(memoryRequest.input.messages[0].text, /тихий номер/);
            const callMemory = MemoryStore.latest(business.id, telegramChat, 'call');
            assert.equal(callMemory.status, 'ai_summary');
            assert.match(callMemory.summary, /тихий номер/);
            assert.equal(MemoryStore.latest(foreignBusiness.id, canonicalChat, 'call'), null);
            assert.equal(DB.get('SELECT chatId FROM crm_memory_summaries WHERE instanceId=? AND kind=\'call\' AND sourceKey=?', [business.id, callId]).chatId, canonicalChat);

            const report = Analytics.report(Access.actor('chain-owner'), business.id);
            assert.equal(report.quality.checkedCalls, 1);
            assert.equal(report.quality.checkedMessages, 1);
            assert.equal(report.quality.cases[0].result, 'met');
            assert.ok(report.quality.cases[0].evidence.some((item) => item.type === 'call' && item.sourceId === callEvent.eventId));
            assert.ok(report.quality.cases[0].evidence.some((item) => item.type === 'message' && item.sourceId === String(outgoing.id)));
            assert.ok(!JSON.stringify(report).includes('Foreign guest'));

            const foreignReport = Analytics.report(Access.actor('foreign-owner'), foreignBusiness.id);
            assert.equal(foreignReport.quality.checkedCalls, 0);
            assert.equal(foreignReport.quality.checkedMessages, 0);
            assert.equal(DB.getManagerTask(foreignBusiness.id, task.taskId), null);
            assert.equal(DB.getConversationEventById(callEvent.eventId).instanceId, business.id);
            assert.equal((await DB.getClient(business.id, canonicalChat)).id, canonical.id);
            assert.equal((await DB.getClient(foreignBusiness.id, canonicalChat)).id, foreign.id);
        } finally {
            AI.generatePlainText = aiGenerate;
            AI._resolveProviderConfig = resolveProvider;
            if (DB.db === db) DB.db = previousDb;
            db.close();
            for (const suffix of ['', '-wal', '-shm']) {
                const candidate = file + suffix;
                if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
            }
            fs.rmdirSync(directory);
        }
    });
});
