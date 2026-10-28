'use strict';
const {describe, it, assert, createTestDB} = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Store = require('../src/services/ava-workspace.store');
const Workspace = require('../src/services/ava-workspace.service');
const Context = require('../src/services/customer-context.service');
const POLICY = require('../src/services/crm-memory-policy.json');

function fixture() {
    createTestDB(); Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name,businessType) VALUES(1,'One','hotel'),(2,'Two','hotel')");
    DB.run("INSERT INTO ava_users(id,email,displayName) VALUES('owner','owner@example.test','Owner')");
    DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('owner',1,'hotel_owner')");
    DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES(1,'guest','Guest'),(1,'other','Other'),(2,'guest','Foreign')");
    Store.ensureSchema();
    return Identity.actor('owner');
}
function summary(kind, key, date, fields = {}, overrides = {}) {
    const id = `s-${kind}-${key}`;
    DB.run(`INSERT INTO crm_memory_summaries(summaryId,instanceId,chatId,kind,sourceKey,sourceHash,summaryJson,sourceUpdatedAt,generatedAt,model,promptVersion,sourceComplete)
        VALUES(?,1,'guest',?,?,?, ?,?,?,'fixture',?,1)`, [id, kind, key, 'fixture-hash', JSON.stringify({domain: 'hotel', relevance: 'relevant',
        summary: `${kind} ${key}`, needs: `${kind} request`, next_step: `${kind} next`, evidence_ids: [], ...fields}), date,
        overrides.generatedAt || date, overrides.promptVersion || POLICY.version]);
    return id;
}
function event(callId, id, role, content, date, metadata = {}) {
    DB.createConversationEvent({instanceId: 1, chatId: 'guest', callId, eventId: id, role,
        channel: ['draft', 'task'].includes(role) ? 'manager' : 'voice', content, metadata});
    DB.run('UPDATE conversation_events SET createdAt=? WHERE eventId=?', [date, id]);
}
function message(chatId, role, content, businessId = 1) {
    return Number(DB.run("INSERT INTO messages(instanceId,chatId,senderName,role,content) VALUES(?,?,'Fixture',?,?)", [businessId, chatId, role, content]).lastInsertRowid);
}
function code(fn, expected) { assert.throws(fn, error => error.code === expected); }

describe('Customer context freshness and complete scoped history', () => {
    it('selects fresh ready call facts ahead of old conversation despite later generation of the old source', () => {
        const actor = fixture();
        summary('conversation', 'old', '2026-10-01T10:00:00Z', {}, {generatedAt: '2026-10-16T10:00:00Z'});
        summary('call', 'fresh', '2026-10-15T10:00:00Z', {summary: 'Fresh call request', needs: 'Suite request', next_step: 'Send offer', evidence_ids: ['call:fresh']});
        event('fresh', 'source', 'manager_note', 'Raw call summary', '2026-10-15T10:00:00Z');
        const view = Workspace.clientWorkspace(actor, 1, 'guest');
        assert.strictEqual(view.memory.summary, 'Fresh call request');
        assert.strictEqual(view.callBrief.request, 'Suite request');
        assert.strictEqual(view.callBrief.nextAction, 'Send offer');
        assert.strictEqual(view.memory.sourceComplete, true);
        assert.strictEqual(view.memory.sources[0].sourceId, 'source');
        assert.strictEqual(view.memory.kind, 'call');
    });

    it('pending conversation and invalid newer policy never hide an older ready call', () => {
        fixture();
        summary('call', 'ready', '2026-10-15T10:00:00Z', {needs: 'Ready request'});
        summary('conversation', 'invalid', '2026-10-16T10:00:00Z', {}, {promptVersion: 'retired-policy'});
        DB.run(`INSERT INTO crm_memory_jobs(jobId,instanceId,chatId,kind,sourceKey,sourceHash,state,nextAttemptAt,createdAt,updatedAt)
            VALUES('pending',1,'guest','conversation','guest','hash','pending',0,0,0)`);
        const view = Context.snapshot(1, 'guest');
        assert.strictEqual(view.callBrief.request, 'Ready request');
        assert.strictEqual(view.memory.status, 'ready');
        assert.strictEqual(view.memory.generationPending, true);
    });

    it('selects the newest ready conversation when it actually follows the call', () => {
        fixture();
        summary('call', 'call', '2026-10-15T09:00:00Z');
        summary('conversation', 'chat', '2026-10-15T10:00:00Z', {needs: 'Updated in chat'});
        assert.strictEqual(Context.snapshot(1, 'guest').callBrief.request, 'Updated in chat');
    });

    it('returns one call with linked task/draft, never their content as call summary', () => {
        fixture();
        event('call', 'note', 'manager_note', 'Call facts', '2026-10-15T09:00:00Z', {summary_provenance: 'provided_summary', duration_seconds: 32});
        event('call', 'task-event', 'task', 'Call client back', '2026-10-15T09:01:00Z');
        event('call', 'draft-event', 'draft', 'Draft hello', '2026-10-15T09:02:00Z');
        DB.createManagerTask({taskId: 'task', instanceId: 1, chatId: 'guest', callId: 'call', summary: 'Call client back'});
        DB.createFollowupDraft({draftId: 'draft', instanceId: 1, chatId: 'guest', callId: 'call', text: 'Draft hello', originalText: 'Draft hello'});
        const {calls, memory} = Context.snapshot(1, 'guest');
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].summary, 'Call facts');
        assert.strictEqual(calls[0].durationSeconds, 32);
        assert.deepStrictEqual(calls[0].relatedEvents.map(row => row.id), ['task-event', 'draft-event']);
        assert.strictEqual(calls[0].tasks[0].taskId, 'task');
        assert.strictEqual(calls[0].drafts[0].draftId, 'draft');
        assert.strictEqual(memory.summary, 'Call facts');
        event('no-summary', 'only-draft', 'draft', 'Never a call summary', '2026-10-15T11:00:00Z');
        const updated = Context.snapshot(1, 'guest');
        assert.strictEqual(updated.calls[0].summary, null);
        assert.strictEqual(updated.memory.summary, 'Call facts');
    });

    it('pages 31 distinct calls independently of their related events and retains current brief', () => {
        const actor = fixture();
        for (let n = 1; n <= 31; n++) {
            const date = new Date(Date.UTC(2026, 8, n, 9)).toISOString();
            event(`call-${String(n).padStart(2, '0')}`, `note-${n}`, 'manager_note', `Call ${n}`, date);
            event(`call-${String(n).padStart(2, '0')}`, `draft-${n}`, 'draft', `Draft ${n}`, date);
        }
        const first = Workspace.clientWorkspace(actor, 1, 'guest');
        assert.strictEqual(first.calls.length, 30);
        assert.strictEqual(first.callPagination.total, 31);
        assert.strictEqual(first.callPagination.hasMore, true);
        const older = Workspace.clientWorkspace(actor, 1, 'guest', {callBefore: first.callPagination.nextCursor});
        assert.strictEqual(older.calls.length, 1);
        assert.strictEqual(older.callPagination.hasMore, false);
        assert.strictEqual(older.calls[0].callId, 'call-01');
        assert.strictEqual(older.callBrief.lastSummary, 'Call 31');
        code(() => Workspace.clientWorkspace(actor, 1, 'other', {callBefore: first.callPagination.nextCursor}), 'WORKSPACE_HISTORY_CURSOR_INVALID');
    });

    it('loads all 110 messages without duplicates while new incoming messages arrive', () => {
        const actor = fixture(), ids = [];
        for (let n = 0; n < 110; n++) ids.push(message('guest', 'user', `Message ${n}`));
        message('other', 'user', 'Other customer'); message('guest', 'user', 'Other business', 2);
        const first = Workspace.clientWorkspace(actor, 1, 'guest');
        assert.strictEqual(first.messages.length, 100);
        assert.deepStrictEqual(first.messagePagination, {...first.messagePagination, hasMore: true, total: 110, limit: 100});
        message('guest', 'user', 'New inbound');
        const previous = Workspace.clientWorkspace(actor, 1, 'guest', {before: first.messagePagination.nextCursor});
        assert.deepStrictEqual([...previous.messages, ...first.messages].map(row => row.id), ids);
        assert.strictEqual(previous.messagePagination.total, 110);
        assert.strictEqual(previous.messagePagination.hasMore, false);
        assert.strictEqual(Workspace.clientWorkspace(actor, 1, 'guest').messagePagination.total, 111);
        code(() => Workspace.clientWorkspace(actor, 1, 'other', {before: first.messagePagination.nextCursor}), 'WORKSPACE_HISTORY_CURSOR_INVALID');
        code(() => Context.messages(2, 'guest', {before: first.messagePagination.nextCursor}), 'WORKSPACE_HISTORY_CURSOR_INVALID');
        code(() => Context.messages(1, 'guest', {before: 'garbage'}), 'WORKSPACE_HISTORY_CURSOR_INVALID');
        code(() => Context.messages(1, 'guest', {messageLimit: 101}), 'WORKSPACE_INPUT_INVALID');
    });

    it('resolves confirmed aliases and rejects foreign evidence or nonexistent tenant/client', () => {
        fixture();
        require('../src/services/client-identity.service').attach(1, 'guest', {kind: 'telegram', value: '99880001'});
        const foreign = message('other', 'assistant', 'Foreign evidence');
        const own = message('guest', 'assistant', 'Own evidence');
        summary('conversation', 'scope', '2026-10-15T10:00:00Z', {evidence_ids: [`message:${foreign}`, `message:${own}`]});
        const view = Context.snapshot(1, 'tg_99880001');
        assert.strictEqual(view.client.chatId, 'guest');
        assert.deepStrictEqual(view.sources.map(row => row.sourceId), [String(own)]);
        assert.strictEqual(Context.snapshot(2, 'guest').memory.summary, null);
        code(() => Context.snapshot(2, 'tg_99880001'), 'WORKSPACE_CLIENT_NOT_FOUND');
        code(() => Context.snapshot(1, 'missing'), 'WORKSPACE_CLIENT_NOT_FOUND');
    });

    it('serves older-history cursors through the real workspace HTTP route', async () => {
        const actor = fixture();
        for (let n = 0; n < 4; n++) message('guest', 'user', `Message ${n}`);
        const express = require('express'), app = express();
        app.use((req, _res, next) => { req.auth = actor; next(); });
        app.use('/api', require('../src/routes/ava-workspace.routes'));
        const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
        const url = `http://127.0.0.1:${server.address().port}/api/businesses/1/workspace/clients/guest`;
        try {
            const response = await fetch(url + '?messageLimit=2');
            assert.strictEqual(response.status, 200);
            const first = await response.json();
            assert.strictEqual(first.messages.length, 2);
            const prior = await fetch(url + '?messageLimit=2&before=' + encodeURIComponent(first.messagePagination.nextCursor));
            assert.strictEqual(prior.status, 200);
            const page = await prior.json();
            assert.strictEqual(page.messages.length, 2);
            assert.strictEqual(page.messagePagination.hasMore, false);
            assert.ok(page.messages.at(-1).id < first.messages[0].id);
            const invalid = await fetch(url + '?before=invalid');
            assert.strictEqual(invalid.status, 400);
            assert.strictEqual((await invalid.json()).code, 'WORKSPACE_HISTORY_CURSOR_INVALID');
        } finally { await new Promise(resolve => server.close(resolve)); }
    });
});
