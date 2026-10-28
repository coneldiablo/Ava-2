'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const SmartTriggers = require('../src/services/smart-triggers.service');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fixture(type, conditions = '{}') {
    createTestDB();
    DB.run("INSERT INTO instances(id, name, isActive, smartTriggersEnabled) VALUES (1, 'One', 1, 1), (2, 'Two', 1, 1)");
    DB.run("INSERT INTO clients(id, instanceId, chatId, senderName, leadStatus) VALUES (10, 1, 'chat', 'One', 'new'), (20, 2, 'chat', 'Two', 'new')");
    DB.run(`INSERT INTO smart_triggers(id, instanceId, name, triggerType, conditions, actionType, actionData, cooldownMinutes)
        VALUES (100, 1, 'Test', ?, ?, 'send_message', '{"message":"Hi"}', 0)`, [type, conditions]);
    return { instance: DB.get('SELECT * FROM instances WHERE id = 1'), trigger: DB.get('SELECT * FROM smart_triggers WHERE id = 100') };
}

describe('Polled smart-trigger occurrences', () => {
    it('fences historical events when upgrading a database with existing rules', async () => {
        const { instance, trigger } = fixture('status_change', '{"targetStatus":"qualified"}');
        DB.run("INSERT INTO lead_status_history(instanceId,chatId,toStatus,createdAt) VALUES (1,'chat','qualified',datetime('now','-5 minutes'))");
        DB.run("INSERT INTO trigger_log(instanceId,chatId,triggerId,triggerType,actionType) VALUES (1,'chat',100,'status_change','send_message')");
        DB.db.exec('DROP TABLE trigger_occurrence_meta; DROP TABLE trigger_occurrences');
        DB.createTables(); // additive migration over an existing business and rule
        assert.ok(Date.parse(await DB.getTriggerOccurrenceFence()) > Date.now() - 10_000);
        let sends = 0;
        SmartTriggers._channelRouter = { sendMessage: async () => { sends++; return true; } };
        await SmartTriggers._processTrigger(instance, trigger);
        assert.strictEqual(sends, 0);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM trigger_occurrences').n, 0);
    });

    it('fires one status event once with zero cooldown, but distinct events separately', async () => {
        const { instance, trigger } = fixture('status_change', '{"targetStatus":"qualified"}');
        DB.run("UPDATE smart_triggers SET createdAt = datetime('now', '-10 minutes') WHERE id = 100");
        trigger.createdAt = DB.get('SELECT createdAt FROM smart_triggers WHERE id = 100').createdAt;
        DB.run("INSERT INTO lead_status_history(instanceId,chatId,toStatus,createdAt) VALUES (1,'chat','qualified',datetime('now','-5 minutes'))");
        let sends = 0;
        SmartTriggers._channelRouter = { sendMessage: async () => { sends++; return true; } };
        await SmartTriggers._processTrigger(instance, trigger);
        await SmartTriggers._processTrigger(instance, trigger);
        assert.strictEqual(sends, 1);
        DB.run("INSERT INTO lead_status_history(instanceId,chatId,toStatus) VALUES (1,'chat','qualified')");
        await SmartTriggers._processTrigger(instance, trigger);
        assert.strictEqual(sends, 2);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM trigger_log').n, 2);
    });

    it('retries a failed send without marking completion and scopes claims by tenant', async () => {
        const { instance, trigger } = fixture('new_lead');
        let attempts = 0;
        SmartTriggers._channelRouter = { sendMessage: async () => ++attempts > 1 };
        await SmartTriggers._processTrigger(instance, trigger);
        assert.strictEqual(DB.get('SELECT state FROM trigger_occurrences').state, 'pending');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM trigger_log').n, 0);
        await SmartTriggers._processTrigger(instance, trigger);
        await SmartTriggers._processTrigger(instance, trigger);
        assert.strictEqual(attempts, 2);
        assert.strictEqual(DB.get('SELECT state FROM trigger_occurrences').state, 'completed');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM trigger_log').n, 1);
        assert.strictEqual(await DB.claimTriggerOccurrence(2, 100, 'chat', 'lead:10'), null);
    });

    it('keeps schedule and outage-window events stable over repeated polls', async () => {
        const now = new Date();
        const due = new Date(now.getTime() - 2 * 3600000);
        const { instance, trigger } = fixture('time_based', JSON.stringify({ hour: due.getHours(), days: [due.getDay()] }));
        DB.run("UPDATE clients SET createdAt = datetime('now', '-2 days') WHERE instanceId = 1");
        DB.run("UPDATE smart_triggers SET createdAt = datetime('now', '-2 days') WHERE id = 100");
        trigger.createdAt = DB.get('SELECT createdAt FROM smart_triggers WHERE id = 100').createdAt;
        let sends = 0;
        SmartTriggers._channelRouter = { sendMessage: async () => { sends++; return true; } };
        await SmartTriggers._processTrigger(instance, trigger);
        await SmartTriggers._processTrigger(instance, trigger);
        assert.strictEqual(sends, 1);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM trigger_occurrences').n, 1);
    });

    it('closes cooldown and max-execution suppressions instead of sending them late', async () => {
        const { instance, trigger } = fixture('status_change', '{"targetStatus":"qualified"}');
        trigger.cooldownMinutes = 60;
        let sends = 0;
        SmartTriggers._channelRouter = { sendMessage: async () => { sends++; return true; } };
        DB.run("INSERT INTO lead_status_history(instanceId,chatId,toStatus) VALUES (1,'chat','qualified')");
        await SmartTriggers._processTrigger(instance, trigger);
        DB.run("INSERT INTO lead_status_history(instanceId,chatId,toStatus) VALUES (1,'chat','qualified')");
        await SmartTriggers._processTrigger(instance, trigger);
        assert.strictEqual(sends, 1);
        assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM trigger_occurrences WHERE state = 'suppressed'").n, 1);
        DB.run("UPDATE trigger_log SET createdAt = datetime('now', '-2 hours')");
        await SmartTriggers._processTrigger(instance, trigger);
        assert.strictEqual(sends, 1);

        trigger.cooldownMinutes = 0;
        trigger.maxExecutions = 1;
        DB.run("INSERT INTO lead_status_history(instanceId,chatId,toStatus) VALUES (1,'chat','qualified')");
        await SmartTriggers._processTrigger(instance, trigger);
        assert.strictEqual(sends, 1);
        assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM trigger_occurrences WHERE state = 'suppressed'").n, 2);
    });

    it('does not replay an event suppressed while the business is disabled', async () => {
        const { instance, trigger } = fixture('new_lead');
        const client = DB.get("SELECT * FROM clients WHERE instanceId=1 AND chatId='chat'");
        let sends = 0;
        SmartTriggers._channelRouter = { sendMessage: async () => { sends++; return true; } };
        DB.run('UPDATE instances SET smartTriggersEnabled=0 WHERE id=1');
        await SmartTriggers._runOccurrence(instance, client, trigger, { message: 'Hi' }, 'lead:10');
        assert.strictEqual(DB.get('SELECT state FROM trigger_occurrences').state, 'suppressed');
        DB.run('UPDATE instances SET smartTriggersEnabled=1 WHERE id=1');
        await SmartTriggers._runOccurrence(instance, client, trigger, { message: 'Hi' }, 'lead:10');
        assert.strictEqual(sends, 0);
    });

    it('does not replay events or schedule slots from before trigger creation', async () => {
        let { instance, trigger } = fixture('status_change', '{"targetStatus":"qualified"}');
        DB.run("INSERT INTO lead_status_history(instanceId,chatId,toStatus,createdAt) VALUES (1,'chat','qualified',datetime('now','-5 minutes'))");
        let sends = 0;
        SmartTriggers._channelRouter = { sendMessage: async () => { sends++; return true; } };
        await SmartTriggers._processTrigger(instance, trigger);
        assert.strictEqual(sends, 0);

        ({ instance, trigger } = fixture('new_lead'));
        DB.run("UPDATE clients SET createdAt = datetime('now', '-5 minutes') WHERE instanceId = 1");
        await SmartTriggers._processTrigger(instance, trigger);
        assert.strictEqual(sends, 0);

        const due = new Date(Date.now() - 2 * 3600000);
        ({ instance, trigger } = fixture('time_based', JSON.stringify({ hour: due.getHours(), days: [due.getDay()] })));
        DB.run("UPDATE clients SET createdAt = datetime('now', '-2 days') WHERE instanceId = 1");
        await SmartTriggers._processTrigger(instance, trigger);
        assert.strictEqual(sends, 0);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM trigger_occurrences').n, 0);
    });

    it('does not reacquire a live lease and permits a stale lease to recover', async () => {
        fixture('new_lead');
        const first = await DB.claimTriggerOccurrence(1, 100, 'chat', 'lead:10');
        assert.ok(first);
        assert.strictEqual(await DB.claimTriggerOccurrence(1, 100, 'chat', 'lead:10'), null);
        DB.run("UPDATE trigger_occurrences SET leaseExpiresAt = '2000-01-01T00:00:00.000Z'");
        const second = await DB.claimTriggerOccurrence(1, 100, 'chat', 'lead:10');
        assert.ok(second && second !== first);
        await DB.finishTriggerOccurrence(1, 100, 'chat', 'lead:10', first, true);
        assert.strictEqual(DB.get('SELECT state FROM trigger_occurrences').state, 'leased');
        await DB.finishTriggerOccurrence(1, 100, 'chat', 'lead:10', second, true);
        assert.strictEqual(await DB.claimTriggerOccurrence(1, 100, 'chat', 'lead:10'), null);
    });

    it('retains completed claims across database reopen', async () => {
        const source = createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'One')");
        DB.run("INSERT INTO smart_triggers(id,instanceId,name,triggerType,actionType) VALUES (100,1,'Test','new_lead','send_message')");
        const token = await DB.claimTriggerOccurrence(1, 100, 'chat', 'lead:10');
        await DB.finishTriggerOccurrence(1, 100, 'chat', 'lead:10', token, true);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-occurrence-'));
        const file = path.join(dir, 'db.sqlite');
        try {
            await source.backup(file);
            source.close();
            DB.db = new Database(file);
            DB.db.pragma('foreign_keys = ON');
            assert.strictEqual(await DB.claimTriggerOccurrence(1, 100, 'chat', 'lead:10'), null);
            assert.strictEqual(DB.get('SELECT state FROM trigger_occurrences').state, 'completed');
        } finally {
            DB.db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
