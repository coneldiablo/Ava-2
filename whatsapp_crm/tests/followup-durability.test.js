const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Sales = require('../src/services/sales-brain.service');
const Router = require('../src/services/channel-router.service');
const Hotels = require('../src/services/hotel-profile.service');
const Identity = require('../src/services/identity/identity-store');
async function seed() {
    createTestDB();
    const hotel = await Hotels.create({ name: 'Durability fixture' });
    Identity.ensureSchema();
    for (const userId of ['manager-a', 'manager-b']) {
        DB.run('INSERT INTO ava_users(id, email, displayName) VALUES (?, ?, ?)', [userId, `${userId}@example.test`, 'Manager fixture']);
        DB.run('INSERT INTO ava_business_memberships(userId, businessId, role) VALUES (?, ?, ?)', [userId, hotel.id, 'manager']);
    }
    const chatId = '79990009901@c.us';
    await DB.getOrCreateClient(hotel.id, chatId, 'Fixture');
    return { instanceId: hotel.id, chatId, callId: 'durability-call', text: 'Review this draft' };
}
describe('Followup durable actions', () => {
    it('deduplicates timeline event and retains edited text on callback replay', async () => {
        const scope = await seed();
        const first = await Sales.draftWhatsAppFollowup(scope);
        await Sales.editFollowupDraft({ ...scope, draftId: first.draft_id, text: 'Manager saved text' });
        const second = await Sales.draftWhatsAppFollowup(scope);
        assert.strictEqual(second.text, 'Manager saved text');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM conversation_events WHERE callId = ?', [scope.callId]).n, 1);
    });
    it('rejects overlong edits without losing the saved draft', async () => {
        const scope = await seed();
        const draft = await Sales.draftWhatsAppFollowup(scope);
        const edited = await Sales.editFollowupDraft({ ...scope, draftId: draft.draft_id, text: 'x'.repeat(501) });
        assert.strictEqual(edited.error, 'text_too_long');
        assert.strictEqual(DB.getFollowupDraft(scope.instanceId, draft.draft_id).text, scope.text);
    });
    it('replays a partially saved postcall to create its missing draft and task once', async () => {
        const scope = await seed();
        const create = DB.createFollowupDraft;
        DB.createFollowupDraft = () => { throw new Error('Injected persistence failure'); };
        try { await assert.rejects(() => Sales.postCall({ ...scope, summary: 'Customer requested details', generate_followup: true })); }
        finally { DB.createFollowupDraft = create; }
        const completed = await Sales.postCall({ ...scope, summary: 'Customer requested details', generate_followup: true });
        assert.strictEqual(completed.followup_draft.success, true);
        assert.ok(completed.followup_draft.draft.manager_task_id);
        await Sales.postCall({ ...scope, generate_followup: true });
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM followup_drafts WHERE instanceId = ?', [scope.instanceId]).n, 1);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM manager_tasks WHERE instanceId = ?', [scope.instanceId]).n, 1);
    });
    it('links a legacy orphan draft transactionally without changing text or sending', async () => {
        const scope = await seed();
        const draft = await Sales.draftWhatsAppFollowup(scope);
        const claimed = Sales.claimFollowupDraft({ ...scope, draftId: draft.draft_id, actor: 'manager-a' });
        assert.strictEqual(claimed.success, true);
        assert.ok(claimed.draft.manager_task_id);
        assert.strictEqual(claimed.draft.text, scope.text);
        assert.strictEqual(claimed.draft.status, 'draft');
        const again = Sales.claimFollowupDraft({ ...scope, draftId: draft.draft_id, actor: 'manager-a' });
        assert.strictEqual(again.idempotent, true);
        assert.strictEqual(again.draft.manager_task_id, claimed.draft.manager_task_id);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM manager_tasks WHERE instanceId = ?', [scope.instanceId]).n, 1);
        const orphan = DB.createFollowupDraft({ instanceId: scope.instanceId, chatId: 'tg_99999999001', text: 'Keep me' });
        assert.strictEqual(Sales.claimFollowupDraft({ ...scope, draftId: orphan.draftId, actor: 'manager-a' }).error, 'customer_not_found');
        assert.strictEqual(DB.getFollowupDraft(scope.instanceId, orphan.draftId).managerTaskId, null);
    });
    it('claims atomically for one authenticated actor and rejects foreign edit/send', async () => {
        const scope = await seed();
        const result = await Sales.postCall({ ...scope, generate_followup: true, summary: 'Send details after call' });
        const draftId = result.followup_draft.draft_id;
        const unclaimed = await Sales.editFollowupDraft({ ...scope, draftId, actor: 'manager-a' });
        assert.strictEqual(unclaimed.error, 'task_claim_required');
        const claim = Sales.claimFollowupDraft({ ...scope, draftId, actor: 'manager-a' });
        assert.strictEqual(claim.draft.assigneeUserId, 'manager-a');
        assert.strictEqual(Sales.claimFollowupDraft({ ...scope, draftId, actor: 'manager-a' }).idempotent, true);
        assert.strictEqual(Sales.claimFollowupDraft({ ...scope, draftId, actor: 'manager-b' }).error, 'task_assigned_to_another_manager');
        assert.strictEqual(Sales.claimFollowupDraft({ ...scope, instanceId: scope.instanceId + 1, draftId, actor: 'manager-a' }).error, 'BUSINESS_ACCESS_DENIED');
        assert.strictEqual((await Sales.editFollowupDraft({ ...scope, draftId, actor: 'manager-b' })).error, 'task_assigned_to_another_manager');
        assert.strictEqual((await Sales.approveWhatsAppFollowup({ ...scope, draftId, actor: 'manager-b' })).error, 'task_assigned_to_another_manager');
        assert.strictEqual((await Sales.editFollowupDraft({ ...scope, draftId, actor: 'manager-a' })).success, true);
    });
    it('claims once before provider await and keeps unknown ACK pending across retries', async () => {
        const scope = await seed();
        const draft = await Sales.draftWhatsAppFollowup(scope);
        const original = Router.sendMessageDetailed;
        let calls = 0;
        Router.sendMessageDetailed = async () => { calls++; await new Promise(r => setTimeout(r, 5)); return { success: true, pending: true }; };
        try {
            const results = await Promise.all([1, 2].map(() => Sales.approveWhatsAppFollowup({ ...scope, draftId: draft.draft_id })));
            assert.strictEqual(calls, 1);
            assert.ok(results.every(r => !r.sent && r.status === 'pending'));
            const retry = await Sales.approveWhatsAppFollowup({ ...scope, draftId: draft.draft_id });
            assert.strictEqual(retry.status, 'pending');
            assert.strictEqual(calls, 1);
            const edit = await Sales.editFollowupDraft({ ...scope, draftId: draft.draft_id, text: 'Changed' });
            assert.strictEqual(edit.error, 'delivery_pending');
        } finally { Router.sendMessageDetailed = original; }
    });
});
