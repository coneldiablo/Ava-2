'use strict';
const {describe, it, assert, createTestDB} = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Store = require('../src/services/ava-workspace.store');
const Attention = require('../src/services/ava-attention.service');
const Flags = require('../src/services/ava-improvements-flags.service');
const express = require('express');

function setup() {
    createTestDB(); Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES(1,'One'),(2,'Two')");
    for (const [id, role, business] of [['owner', 'hotel_owner', 1], ['lead', 'sales_lead', 1], ['one', 'manager', 1], ['two', 'manager', 1], ['observer', 'observer', 1], ['foreign', 'manager', 2]]) {
        DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)', [id, id + '@test.example', 'Same name']);
        DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [id, business, role]);
    }
    DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,'guest','Guest','one'),(1,'second','Second','two'),(1,'queue','Queue',NULL),(2,'guest','Foreign','foreign')");
    Store.ensureSchema();
    return Object.fromEntries(['owner', 'lead', 'one', 'two', 'observer', 'foreign'].map(id => [id, Identity.actor(id)]));
}
function enabled(fn) {
    const old = process.env.AVA_IMPROVEMENTS_BUSINESSES;
    process.env.AVA_IMPROVEMENTS_BUSINESSES = '*';
    try { return fn(); } finally { if (old === undefined) delete process.env.AVA_IMPROVEMENTS_BUSINESSES; else process.env.AVA_IMPROVEMENTS_BUSINESSES = old; }
}
async function enabledAsync(fn) {
    const old = process.env.AVA_IMPROVEMENTS_BUSINESSES;
    process.env.AVA_IMPROVEMENTS_BUSINESSES = '*';
    try { return await fn(); } finally { if (old === undefined) delete process.env.AVA_IMPROVEMENTS_BUSINESSES; else process.env.AVA_IMPROVEMENTS_BUSINESSES = old; }
}
function at(value, fn) { const original = Date.now; Date.now = () => Date.parse(value); try { return fn(); } finally { Date.now = original; } }
function message(chat, role, timestamp, business = 1) {
    return Number(DB.run('INSERT INTO messages(instanceId,chatId,senderName,role,content,timestamp,channel) VALUES(?,?,?,?,?,?,?)', [business, chat, 'Guest', role, 'Actual message', timestamp, 'whatsapp']).lastInsertRowid);
}
function policy(data) {
    require('../src/services/ava-autopilot.store').ensureSchema();
    DB.run('INSERT INTO ava_autopilot_policies(businessId,revision,payloadJson,ownerUserId,updatedAt) VALUES(?,?,?,?,?)', [1, 1, JSON.stringify(data), 'owner', new Date().toISOString()]);
}
function action(chat, status, id, date = '2026-10-05T06:00:00Z') {
    DB.run('INSERT INTO ava_workspace_reply_actions(id,businessId,chatId,userId,idempotencyKey,textHash,controlRevision,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [id, 1, chat, 'one', id, 'hash', 1, status, date, date]);
}
function types(result) { return result.items.map(item => item.type); }

describe('AVA attention live scope, deadlines and deduplication', () => {
    it('is off by default and requires live account/capability before flags', () => {
        const auth = setup(), previous = process.env.AVA_IMPROVEMENTS_BUSINESSES;
        delete process.env.AVA_IMPROVEMENTS_BUSINESSES;
        try {
            assert.throws(() => Attention.list(auth.owner, 1), error => error.code === 'WORKSPACE_FEATURE_DISABLED');
            assert.throws(() => Attention.list(auth.foreign, 1), error => error.code === 'BUSINESS_ACCESS_DENIED');
            assert.throws(() => Attention.list(null, 1), error => error.code === 'ACCOUNT_NOT_ACTIVE');
        } finally { if (previous !== undefined) process.env.AVA_IMPROVEMENTS_BUSINESSES = previous; }
        enabled(() => { Flags.update(auth.owner, 1, {revision: 0, flags: {attention: false}}); assert.throws(() => Attention.list(auth.owner, 1), error => error.code === 'WORKSPACE_FEATURE_DISABLED'); });
    });
    it('counts the first unanswered inbound in working minutes and clears it after a real answer', () => enabled(() => {
        const auth = setup(); policy({timezone: 'Europe/Moscow', workHours: {start: '09:00', end: '18:00'}, workDays: [1,2,3,4,5], responseDeadlineMinutes: 30});
        const id = message('guest', 'user', '2026-10-02T14:50:00Z');
        message('guest', 'user', '2026-10-05T06:05:00Z');
        at('2026-10-05T06:11:00Z', () => {
            const soon = Attention.list(auth.one, 1).items.find(item => item.type === 'response_soon');
            assert.strictEqual(soon.id, 'response:' + id); assert.strictEqual(soon.dueAt, '2026-10-05T06:20:00.000Z');
        });
        at('2026-10-05T06:21:00Z', () => {
            assert.ok(types(Attention.list(auth.one, 1)).includes('response_overdue'));
            message('guest', 'manager', '2026-10-05T06:21:00Z');
            assert.ok(!types(Attention.list(auth.one, 1)).some(type => type.startsWith('response_')));
        });
    }));
    it('does not create approaching SLA alerts outside working hours or from future/invalid timestamps', () => enabled(() => {
        const auth = setup(); policy({timezone: 'Europe/Moscow', workHours: {start: '09:00', end: '18:00'}, workDays: [1,2,3,4,5], responseDeadlineMinutes: 30});
        message('guest', 'user', '2026-10-02T14:35:00Z');
        at('2026-10-03T12:00:00Z', () => assert.ok(!types(Attention.list(auth.one, 1)).includes('response_soon')));
        DB.run("DELETE FROM messages WHERE chatId='guest'"); message('guest', 'user', '2040-01-01T00:00:00Z');
        assert.ok(!types(Attention.list(auth.one, 1)).some(type => type.startsWith('response_')));
    }));
    it('filters completed tasks/promises, scopes ownership and never resets explicit deadlines after answering', () => enabled(() => {
        const auth = setup();
        const p = Store.createPromise({businessId: 1, chatId: 'guest', summary: 'Send confirmed quote', dueAt: '2026-10-05T06:15:00Z'});
        const done = Store.createPromise({businessId: 1, chatId: 'guest', summary: 'Done promise', dueAt: '2000-01-01T00:00:00Z'});
        DB.run("UPDATE ava_client_promises SET status='done' WHERE id=?", [done.id]);
        DB.createManagerTask({instanceId: 1, chatId: 'guest', summary: 'Call back', dueAt: '2026-10-05T05:50:00Z', assigneeUserId: 'one'});
        const finished = DB.createManagerTask({instanceId: 1, chatId: 'guest', summary: 'Finished', dueAt: '2000-01-01T00:00:00Z', assigneeUserId: 'one'});
        DB.run("UPDATE manager_tasks SET status='done' WHERE taskId=?", [finished.taskId]);
        DB.createManagerTask({instanceId: 1, chatId: 'second', summary: 'Other manager task', dueAt: '2000-01-01T00:00:00Z', assigneeUserId: 'two'});
        message('guest', 'assistant', '2026-10-05T06:00:00Z');
        at('2026-10-05T06:00:00Z', () => {
            const result = Attention.list(auth.one, 1);
            assert.ok(result.items.some(item => item.id === 'promise:' + p.id && item.type === 'promise_soon'));
            assert.strictEqual(result.items.filter(item => item.type === 'task_overdue').length, 1);
            assert.ok(!JSON.stringify(result).includes('Other manager task'));
            assert.ok(Attention.list(auth.owner, 1).items.some(item => item.chatId === 'second'));
        });
    }));
    it('uses exact live memberships and per-user snoozes without leaking another business', () => enabled(() => {
        const auth = setup(); message('guest', 'user', '2000-01-01T00:00:00Z'); message('guest', 'user', '2000-01-01T00:00:00Z', 2);
        DB.run('INSERT INTO ava_workspace_snoozes(businessId,userId,chatId,until) VALUES(?,?,?,?)', [1, 'one', 'guest', '2040-01-01T00:00:00Z']);
        assert.ok(!Attention.list(auth.one, 1).items.some(item => item.chatId === 'guest'));
        assert.ok(Attention.list(auth.owner, 1).items.some(item => item.chatId === 'guest'));
        DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE businessId=1 AND userId='one'");
        assert.throws(() => Attention.list(auth.one, 1), error => error.code === 'BUSINESS_ACCESS_DENIED');
        assert.ok(Attention.list(auth.two, 1).items.some(item => item.chatId === 'guest' && item.type === 'unassigned'));
        assert.ok(Attention.list(auth.observer, 1).items.every(item => item.chatId !== 'foreign'));
    }));
    it('deduplicates unknown sends and suppresses historical failures after a successful retry', () => enabled(() => {
        const auth = setup();
        const control = Store.getControl(1, 'guest'); Store.beginAiSend({businessId: 1, chatId: 'guest', revision: control.revision, sendId: 'unknown-send'});
        Store.endAiSend({businessId: 1, chatId: 'guest', sendId: 'unknown-send', status: 'unknown'});
        action('guest', 'unknown', 'unknown-action'); action('second', 'failed', 'failed-action');
        let result = Attention.list(auth.owner, 1);
        assert.strictEqual(result.items.filter(item => item.type === 'send_unknown').length, 1);
        assert.strictEqual(result.items[0].type, 'send_unknown'); assert.ok(types(result).includes('send_failed'));
        action('second', 'sent', 'retry', '2026-10-05T06:01:00Z');
        result = Attention.list(auth.owner, 1); assert.ok(!types(result).includes('send_failed'));
        assert.strictEqual(Attention.list(auth.owner, 1).items[0].id, result.items[0].id);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_workspace_reply_actions').n, 3);
    }));
    it('bounds and orders results, excludes resolved queue clients and validates limit input', () => enabled(() => {
        const auth = setup();
        DB.run("INSERT INTO clients(instanceId,chatId,senderName,leadStatus) VALUES(1,'resolved','Resolved','won')");
        for (let n = 0; n < 110; n++) DB.run('INSERT INTO clients(instanceId,chatId,senderName) VALUES(?,?,?)', [1, 'q' + n, 'Guest']);
        const result = Attention.list(auth.owner, 1, {limit: 3});
        assert.strictEqual(result.items.length, 3); assert.strictEqual(result.counts.total, 111); assert.strictEqual(result.counts.returned, 3); assert.strictEqual(result.truncated, true);
        assert.strictEqual(new Set(result.items.map(item => item.id)).size, 3);
        for (const limit of [0, 101, 'a', [], {}, 1.1]) assert.throws(() => Attention.list(auth.owner, 1, {limit}), error => error.code === 'WORKSPACE_INPUT_INVALID');
        assert.ok(result.items.every(item => item.href.startsWith('/today?client=') && Object.hasOwn(item, 'dueAt')));
    }));
    it('includes genuine legacy follow-up delivery failures and deduplicates their unknown fence', () => enabled(() => {
        const auth = setup();
        DB.createFollowupDraft({instanceId: 1, chatId: 'guest', draftId: 'legacy-failed', status: 'approved', metadata: {delivery_status: 'failed'}});
        DB.createFollowupDraft({instanceId: 1, chatId: 'second', draftId: 'legacy-unknown', status: 'approved', metadata: {delivery_status: 'pending'}});
        action('guest', 'failed', 'failed-action');
        let result = Attention.list(auth.owner, 1);
        assert.strictEqual(result.items.filter(item => item.type === 'send_failed').length, 1);
        assert.strictEqual(result.items.filter(item => item.type === 'send_unknown').length, 1);
        DB.run("UPDATE followup_drafts SET status='sent',metadataJson='{\"delivery_status\":\"sent\"}' WHERE draftId='legacy-unknown'");
        result = Attention.list(auth.owner, 1); assert.ok(!types(result).includes('send_unknown'));
    }));
    it('surfaces crash-left sending after a minute without expiring or mutating the fence', () => enabled(() => {
        const auth = setup(); action('guest', 'sending', 'stale-sending', '2026-10-05T06:00:00Z');
        const control = Store.getControl(1, 'guest'); Store.beginAiSend({businessId: 1, chatId: 'guest', revision: control.revision, sendId: 'stale-sending'});
        DB.run("UPDATE ava_conversation_control SET updatedAt='2026-10-05T06:00:00Z' WHERE businessId=1 AND chatId='guest'");
        at('2026-10-05T06:00:30Z', () => assert.ok(!types(Attention.list(auth.one, 1)).includes('send_unknown')));
        at('2026-10-05T06:01:00Z', () => assert.strictEqual(types(Attention.list(auth.one, 1)).filter(type => type === 'send_unknown').length, 1));
        assert.strictEqual(Store.getControl(1, 'guest').sendStatus, 'sending');
        assert.strictEqual(DB.get("SELECT status FROM ava_workspace_reply_actions WHERE id='stale-sending'").status, 'sending');
    }));
    it('filters hidden clients before source caps so another manager cannot exhaust personal alerts', () => enabled(() => {
        const auth = setup();
        DB.db.transaction(() => {
            for (let n = 0; n < 2001; n++) {
                const chat = 'hidden-' + n;
                DB.run('INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(?,?,?,?)', [1, chat, 'Hidden', 'two']);
                DB.run('INSERT INTO ava_conversation_control(businessId,chatId,activeSendId,activeSendStatus,updatedAt) VALUES(?,?,?,?,?)', [1, chat, chat, 'unknown', '2000-01-01T00:00:00Z']);
                action(chat, 'failed', chat, '2000-01-01T00:00:00Z');
            }
        }).immediate();
        action('guest', 'failed', 'own-visible', '2026-10-05T06:00:00Z');
        const result = Attention.list(auth.one, 1);
        assert.ok(result.items.some(item => item.chatId === 'guest' && item.type === 'send_failed'));
        assert.ok(!result.items.some(item => item.chatId.startsWith('hidden-')));
        assert.strictEqual(result.truncated, false);
    }));
    it('excludes more than 2000 personal snoozes before every source cap', () => enabled(() => {
        const auth = setup();
        DB.db.transaction(() => {
            for (let n = 0; n < 2001; n++) {
                const chat = 'snoozed-' + n, stamp = '2000-01-01T00:00:00Z';
                DB.run('INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(?,?,?,?)', [1, chat, 'Snoozed', 'one']);
                DB.run('INSERT INTO ava_workspace_snoozes(businessId,userId,chatId,until) VALUES(?,?,?,?)', [1, 'one', chat, '2040-01-01T00:00:00Z']);
                DB.run('INSERT INTO ava_conversation_control(businessId,chatId,activeSendId,activeSendStatus,updatedAt) VALUES(?,?,?,?,?)', [1, chat, chat, 'unknown', stamp]);
                action(chat, 'failed', chat, stamp);
                DB.run('INSERT INTO manager_tasks(taskId,instanceId,chatId,summary,assigneeUserId,dueAt) VALUES(?,?,?,?,?,?)', [chat, 1, chat, 'Snoozed task', 'one', stamp]);
                DB.run('INSERT INTO ava_client_promises(id,businessId,chatId,summary,dueAt,assigneeUserId,sourceType,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)',
                    [chat, 1, chat, 'Snoozed promise', stamp, 'one', 'manual', stamp, stamp]);
                DB.run('INSERT INTO followup_drafts(draftId,instanceId,chatId,status,metadataJson,updatedAt) VALUES(?,?,?,?,?,?)',
                    [chat, 1, chat, 'approved', '{"delivery_status":"failed"}', stamp]);
                message(chat, 'user', stamp);
            }
        }).immediate();
        action('guest', 'failed', 'visible-after-snoozes', '2026-10-05T06:00:00Z');
        const result = Attention.list(auth.one, 1);
        assert.ok(result.items.some(item => item.chatId === 'guest' && item.type === 'send_failed'));
        assert.ok(!result.items.some(item => item.chatId.startsWith('snoozed-')));
        assert.strictEqual(result.counts.total, 2);
        assert.strictEqual(result.truncated, false);
        assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM ava_workspace_snoozes WHERE userId='one'").n, 2001);
    }));
    it('uses the optional availability helper only for configured routing during working time', () => enabled(() => {
        const auth = setup(); policy({routing: {enabled: true, memberIds: ['one','two']}});
        const Module = require('module'), original = Module._resolveFilename;
        const fakePath = '/ava-attention-availability-fixture.js'; let result = {configured: true, isWorkingTime: true, eligibleUserIds: []};
        Module._resolveFilename = function(request, parent, ...rest) {
            if ((request === './ava-availability.service' || request === fakePath) && parent?.filename.endsWith('ava-attention.service.js')) return fakePath;
            return original.call(this, request, parent, ...rest);
        };
        require.cache[fakePath] = {id: fakePath, filename: fakePath, loaded: true, exports: {routingAvailability(businessId, {now}) {
            assert.strictEqual(businessId, 1); assert.ok(now instanceof Date); return result;
        }}};
        try {
            assert.ok(types(Attention.list(auth.one, 1)).includes('no_available_member'));
            assert.ok(!types(Attention.list(auth.one, 1)).includes('unassigned'));
            result = {...result, isWorkingTime: false}; assert.ok(types(Attention.list(auth.one, 1)).includes('unassigned'));
            result = {...result, isWorkingTime: true, eligibleUserIds: ['one']}; assert.ok(!types(Attention.list(auth.one, 1)).includes('no_available_member'));
            result = {...result, configured: false, eligibleUserIds: []}; assert.ok(!types(Attention.list(auth.one, 1)).includes('no_available_member'));
            result = {...result, configured: true}; Flags.update(auth.owner, 1, {revision: 0, flags: {shifts: false}});
            assert.ok(!types(Attention.list(auth.one, 1)).includes('no_available_member'));
        } finally { Module._resolveFilename = original; delete require.cache[fakePath]; }
    }));
    it('serves HTTP with exact live auth, feature gate, scope rejection and no-store header', async () => enabledAsync(async () => {
        const auth = setup(), app = express(); let current = auth.one;
        app.use(express.json()); app.use((req, _res, next) => { req.auth = current; next(); }); app.use('/api', require('../src/routes/ava-attention.routes'));
        const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
        const url = 'http://127.0.0.1:' + server.address().port + '/api/businesses/1/workspace/attention';
        try {
            let response = await fetch(url); assert.strictEqual(response.status, 200); assert.strictEqual(response.headers.get('cache-control'), 'no-store');
            assert.strictEqual((await response.json()).businessId, 1);
            response = await fetch(url + '?businessId=2'); assert.strictEqual(response.status, 403); assert.strictEqual((await response.json()).code, 'BUSINESS_SCOPE_MISMATCH');
            current = auth.foreign; assert.strictEqual((await fetch(url)).status, 403);
            current = null; assert.strictEqual((await fetch(url)).status, 403);
            current = auth.owner; Flags.update(auth.owner, 1, {revision: 0, flags: {attention: false}}); assert.strictEqual((await fetch(url)).status, 409);
        } finally { await new Promise(resolve => server.close(resolve)); }
    }));
});
