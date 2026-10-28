'use strict';
const {describe, it, assert, createTestDB} = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Store = require('../src/services/ava-workspace.store');
const Wait = require('../src/services/customer-wait.service');
const Workspace = require('../src/services/ava-workspace.service');
const Attention = require('../src/services/ava-attention.service');

function setup() {
    createTestDB(); Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES(1,'One'),(2,'Two')");
    DB.run("INSERT INTO ava_users(id,email,displayName) VALUES('owner','owner@example.test','Owner')");
    DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('owner',1,'hotel_owner')");
    DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,'guest','Guest','owner'),(1,'other','Other','owner'),(2,'guest','Foreign',NULL)");
    Store.ensureSchema();
    return Identity.actor('owner');
}
function message(businessId, chatId, role, timestamp) {
    return Number(DB.run('INSERT INTO messages(instanceId,chatId,senderName,role,content,timestamp) VALUES(?,?,?,?,?,?)', [businessId, chatId, 'Guest', role, 'Persisted message', timestamp]).lastInsertRowid);
}
const everyDay = {timezone:'Europe/Moscow', workHours:{start:'00:00',end:'00:00'}, workDays:[1,2,3,4,5,6,7], responseDeadlineMinutes:30};

describe('Shared first unanswered customer waiting clock', () => {
    it('keeps first inbound until a real outgoing and starts a new cycle after answering', () => {
        setup();
        const first = message(1, 'guest', 'user', '2026-10-15 07:00:00');
        message(1, 'guest', 'user', '2026-10-15T07:59:00Z');
        message(1, 'guest', 'system', '2026-10-15T08:00:00Z');
        message(1, 'other', 'manager', '2026-10-15T08:00:00Z');
        message(2, 'guest', 'assistant', '2026-10-15T08:00:00Z');
        assert.strictEqual(Wait.firstUnanswered(1, 'guest').id, first);
        assert.strictEqual(Wait.state(Wait.firstUnanswered(1, 'guest'), Date.parse('2026-10-15T08:00:00Z'), everyDay).overdue, true);
        message(1, 'guest', 'human', '2026-10-15T08:00:00Z');
        assert.strictEqual(Wait.firstUnanswered(1, 'guest'), null);
        const next = message(1, 'guest', 'user', '2026-10-15T08:00:00Z');
        assert.strictEqual(Wait.firstUnanswered(1, 'guest').id, next);
        assert.strictEqual(Wait.state(Wait.firstUnanswered(1, 'guest'), Date.parse('2026-10-15T08:01:00Z'), everyDay).overdue, false);
    });
    it('restricts business and chat selection, including an empty authorized set and tied timestamps', () => {
        setup();
        const first = message(1, 'guest', 'user', '2026-10-15T07:00:00Z');
        message(1, 'guest', 'user', '2026-10-15T07:00:00Z');
        message(1, 'other', 'user', '2026-10-15T07:00:00Z');
        const foreign = message(2, 'guest', 'user', '2026-10-15T07:00:00Z');
        assert.deepStrictEqual(Wait.unanswered(1, {chatIds:['guest','guest']}).map(row => row.id), [first]);
        assert.deepStrictEqual(Wait.unanswered(1, {chatIds:[]}), []);
        assert.deepStrictEqual(Wait.unanswered(2).map(row => row.id), [foreign]);
        assert.strictEqual(Wait.firstUnanswered(1, 'missing'), null);
        for (const scope of [0, -1, 'bad']) assert.throws(() => Wait.unanswered(scope), error => error.code === 'WORKSPACE_INPUT_INVALID');
    });
    it('counts weekends and overnight work consistently and never alerts for future/invalid sources', () => {
        const weekdays = {...everyDay, workHours:{start:'09:00',end:'18:00'}, workDays:[1,2,3,4,5]};
        const inbound = {timestamp:'2026-10-02T14:50:00Z'}, now = Date.parse('2026-10-05T06:11:00Z');
        const wait = Wait.state(inbound, now, weekdays);
        assert.strictEqual(wait.elapsedMinutes, 21); assert.strictEqual(wait.overdue, false); assert.strictEqual(wait.approaching, true);
        assert.strictEqual(Wait.responseDeadline(wait.startedAt, now, weekdays, wait.elapsedMinutes), '2026-10-05T06:20:00.000Z');
        assert.strictEqual(Wait.state(inbound, Date.parse('2026-10-05T06:21:00Z'), weekdays).overdue, true);
        assert.strictEqual(Wait.state({timestamp:'2026-10-02T14:35:00Z'}, Date.parse('2026-10-03T12:00:00Z'), weekdays).approaching, false);
        const overnight = {...everyDay, workHours:{start:'22:00',end:'02:00'}};
        assert.strictEqual(Wait.state({timestamp:'2026-10-04T22:45:00Z'}, Date.parse('2026-10-05T19:16:00Z'), overnight).overdue, true);
        for (const timestamp of ['invalid','2040-01-01T00:00:00Z']) {
            const inactive = Wait.state({timestamp}, now, everyDay);
            assert.strictEqual(inactive.overdue, false); assert.strictEqual(inactive.approaching, false);
        }
    });
    it('agrees between workspace and attention on repeated inbound, then clears both after answering', () => {
        const auth = setup(), previousFlag = process.env.AVA_IMPROVEMENTS_BUSINESSES, previousNow = Date.now;
        process.env.AVA_IMPROVEMENTS_BUSINESSES = '*'; Date.now = () => Date.parse('2026-10-15T08:00:00Z');
        try {
            const first = message(1, 'guest', 'user', '2026-10-15T07:00:00Z');
            message(1, 'guest', 'user', '2026-10-15T07:59:00Z');
            const reason = Workspace.workspace(auth, 1).items.find(row => row.chatId === 'guest').reasons.find(row => row.code === 'response_overdue');
            assert.ok(reason); assert.strictEqual(reason.sourceId, String(first));
            assert.ok(Attention.list(auth, 1).items.some(row => row.id === 'response:' + first && row.type === 'response_overdue'));
            message(1, 'guest', 'manager', '2026-10-15T08:00:00Z');
            assert.ok(!Workspace.workspace(auth, 1).items.find(row => row.chatId === 'guest').reasons.some(row => row.code === 'response_overdue'));
            assert.ok(!Attention.list(auth, 1).items.some(row => row.type.startsWith('response_')));
        } finally {
            Date.now = previousNow;
            if (previousFlag === undefined) delete process.env.AVA_IMPROVEMENTS_BUSINESSES; else process.env.AVA_IMPROVEMENTS_BUSINESSES = previousFlag;
        }
    });
});
