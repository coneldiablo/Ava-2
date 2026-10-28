'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Sales = require('../src/services/sales-brain.service');
const Identity = require('../src/services/identity/identity-store');
const Workspace = require('../src/services/sales-workspace.service');
const Router = require('../src/services/channel-router.service');
const Hotels = require('../src/services/hotel-profile.service');

async function seed({ assigneeUserId = null, legacyAssignee = null } = {}) {
    createTestDB();
    const hotel = await Hotels.create({ name: 'Exact assignment fixture' });
    const other = await Hotels.create({ name: 'Foreign assignment fixture' });
    Identity.ensureSchema();
    for (const [userId, role, businessId] of [
        ['manager-a', 'manager', hotel.id], ['manager-b', 'manager', hotel.id],
        ['lead-a', 'sales_lead', hotel.id], ['owner-a', 'hotel_owner', hotel.id],
        ['observer-a', 'observer', hotel.id], ['foreign-a', 'manager', other.id],
    ]) {
        DB.run('INSERT INTO ava_users(id, email, displayName) VALUES (?, ?, ?)', [userId, `${userId}@example.test`, 'Same visible name']);
        DB.run('INSERT INTO ava_business_memberships(userId, businessId, role) VALUES (?, ?, ?)', [userId, businessId, role]);
    }
    const chatId = '79990009901@c.us';
    await DB.getOrCreateClient(hotel.id, chatId, 'Fixture customer');
    const task = DB.createManagerTask({ instanceId: hotel.id, chatId, summary: 'Review follow-up',
        callId: 'exact-assignment-call', assignee: legacyAssignee, assigneeUserId });
    const draft = DB.createFollowupDraft({ instanceId: hotel.id, chatId, callId: task.callId,
        managerTaskId: task.taskId, originalText: 'Durable original', text: 'Durable original', status: 'draft' });
    return { instanceId: hotel.id, otherBusinessId: other.id, chatId, taskId: task.taskId, draftId: draft.draftId };
}
function actorInput(scope, userId, extra = {}) { return { ...scope, actor: { userId }, ...extra }; }
function stubProvider(result = { success: true, channel: 'whatsapp' }) {
    const previous = Router.sendMessageDetailed;
    let calls = 0;
    Router.sendMessageDetailed = async () => { calls++; return result; };
    return { calls: () => calls, restore: () => { Router.sendMessageDetailed = previous; } };
}

describe('Exact sales assignments and durable follow-up authorization', () => {
    it('keeps legacy labels visible without granting rights, while exposing the exact assignment separately', async () => {
        const scope = await seed({ legacyAssignee: 'manager-a' });
        assert.strictEqual(Sales.followupDraftView(DB.getFollowupDraft(scope.instanceId, scope.draftId)).assignee, 'manager-a');
        assert.strictEqual((await Sales.editFollowupDraft(actorInput(scope, 'manager-a', { text: 'Denied legacy authority' }))).error, 'task_claim_required');
        assert.strictEqual((await Sales.rejectFollowupDraft(actorInput(scope, 'manager-a'))).error, 'task_claim_required');
        const claim = Sales.claimFollowupDraft(actorInput(scope, 'manager-a'));
        assert.strictEqual(claim.success, true);
        assert.strictEqual(claim.draft.assigneeUserId, 'manager-a');
        const own = await Sales.editFollowupDraft(actorInput(scope, 'manager-a', { text: 'Saved exact actor', editedBy: 'Forged name' }));
        assert.strictEqual(own.draft.edited_by, 'manager-a');
        assert.strictEqual(own.draft.assignee_user_id, 'manager-a');
    });

    it('resolves only active exact assignees for task creation and inherits canonical customer assignment', async () => {
        const scope = await seed();
        DB.run('UPDATE clients SET assigneeUserId=? WHERE instanceId=? AND chatId=?', ['manager-b', scope.instanceId, scope.chatId]);
        const inherited = await Sales.createManagerTask({ instanceId: scope.instanceId, chatId: scope.chatId, callId: 'inherit-canonical', manager_id: 'Same visible name' });
        assert.strictEqual(inherited.task.assigneeUserId, 'manager-b');
        assert.strictEqual(inherited.task.assignee, 'Same visible name');
        const explicit = await Sales.createManagerTask({ instanceId: scope.instanceId, chatId: scope.chatId, callId: 'explicit-exact', assigneeUserId: 'manager-a' });
        assert.strictEqual(explicit.task.assigneeUserId, 'manager-a');
        for (const assigneeUserId of ['Same visible name', 'foreign-a', 'observer-a']) {
            assert.strictEqual(Sales.managerTaskAssigneeUserId(scope.instanceId, { assigneeUserId }), null);
        }
        DB.run('UPDATE ava_business_memberships SET enabled=0 WHERE userId=?', ['manager-b']);
        const revoked = await Sales.createManagerTask({ instanceId: scope.instanceId, chatId: scope.chatId, callId: 'inactive-canonical' });
        assert.strictEqual(revoked.task.assigneeUserId, null);
    });

    it('post-call persists canonical assignment and repeated callbacks never overwrite a claimed task', async () => {
        const scope = await seed();
        DB.run('UPDATE clients SET assigneeUserId=? WHERE instanceId=? AND chatId=?', ['manager-b', scope.instanceId, scope.chatId]);
        const payload = { instanceId: scope.instanceId, chatId: scope.chatId, callId: 'canonical-postcall',
            summary: 'Fixture summary', generate_followup: true };
        const first = await Sales.postCall(payload);
        assert.strictEqual(first.handoff_task.assigneeUserId, 'manager-b');
        assert.strictEqual(first.followup_draft.draft.assigneeUserId, 'manager-b');
        Workspace.updateTask({ userId: 'lead-a' }, scope.instanceId, first.handoff_task.task_id, { assigneeUserId: 'manager-a' });
        const replay = await Sales.postCall(payload);
        assert.strictEqual(replay.idempotent, true);
        assert.strictEqual(DB.getManagerTask(scope.instanceId, first.handoff_task.task_id).assigneeUserId, 'manager-a');
        assert.strictEqual(DB.getManagerTasks(scope.instanceId, { callId: payload.callId }).length, 1);
    });

    it('inherits the latest canonical assignment when it changes during post-call awaits', async () => {
        for (const currentAssignee of ['manager-a', null]) {
            const scope = await seed();
            DB.run('UPDATE clients SET assigneeUserId=? WHERE instanceId=? AND chatId=?', ['manager-b', scope.instanceId, scope.chatId]);
            const nextAction = Sales.nextAction;
            Sales.nextAction = async () => {
                DB.run('UPDATE clients SET assigneeUserId=? WHERE instanceId=? AND chatId=?', [currentAssignee, scope.instanceId, scope.chatId]);
                return { next_action: { action_type: 'draft_followup' } };
            };
            try {
                const result = await Sales.postCall({ instanceId: scope.instanceId, chatId: scope.chatId,
                    callId: 'assignment-changed-during-postcall', summary: 'Fixture summary', generate_followup: true,
                    manager_id: 'Same visible name' });
                assert.strictEqual(result.handoff_task.assigneeUserId, currentAssignee);
                assert.strictEqual(result.followup_draft.draft.assigneeUserId, currentAssignee);
                assert.strictEqual(DB.getManagerTask(scope.instanceId, result.handoff_task.task_id).assigneeUserId, currentAssignee);
            } finally { Sales.nextAction = nextAction; }
        }
    });

    it('claims atomically for exactly one active manager and refuses another manager despite equal display names', async () => {
        const scope = await seed();
        const results = await Promise.all(['manager-a', 'manager-b'].map(userId => Promise.resolve().then(() => Sales.claimFollowupDraft(actorInput(scope, userId)))));
        assert.strictEqual(results.filter(r => r.success).length, 1);
        assert.strictEqual(results.filter(r => r.error === 'task_assigned_to_another_manager').length, 1);
        const task = DB.getManagerTask(scope.instanceId, scope.taskId);
        const winner = task.assigneeUserId, loser = winner === 'manager-a' ? 'manager-b' : 'manager-a';
        assert.strictEqual(Sales.claimFollowupDraft(actorInput(scope, winner)).idempotent, true);
        assert.strictEqual((await Sales.editFollowupDraft(actorInput(scope, loser, { text: 'No takeover' }))).error, 'task_assigned_to_another_manager');
        assert.strictEqual((await Sales.rejectFollowupDraft(actorInput(scope, loser))).error, 'task_assigned_to_another_manager');
    });

    it('fails closed for absent authorization API, unknown users, observers, wrong business and revoked stale actors', async () => {
        const scope = await seed({ assigneeUserId: 'manager-a' });
        const stale = Identity.actor('manager-a');
        const authorize = Identity.authorizeCapability;
        try {
            Identity.authorizeCapability = undefined;
            assert.strictEqual((await Sales.editFollowupDraft(actorInput(scope, 'manager-a', { text: 'Blocked' }))).error, 'identity_authorization_unavailable');
            assert.strictEqual(Sales.claimFollowupDraft(actorInput(scope, 'manager-a')).error, 'identity_authorization_unavailable');
        } finally { Identity.authorizeCapability = authorize; }
        assert.strictEqual((await Sales.editFollowupDraft(actorInput(scope, 'Same visible name', { text: 'Blocked' }))).error, 'ACCOUNT_NOT_ACTIVE');
        for (const action of ['editFollowupDraft', 'rejectFollowupDraft', 'approveWhatsAppFollowup']) {
            assert.strictEqual((await Sales[action](actorInput(scope, 'observer-a', { text: 'Blocked' }))).error, 'CAPABILITY_DENIED');
        }
        assert.strictEqual(Sales.claimFollowupDraft(actorInput(scope, 'observer-a')).error, 'CAPABILITY_DENIED');
        assert.strictEqual(Sales.claimFollowupDraft(actorInput(scope, 'manager-a', { instanceId: scope.otherBusinessId })).error, 'BUSINESS_ACCESS_DENIED');
        DB.run('UPDATE ava_business_memberships SET enabled=0 WHERE userId=?', ['manager-a']);
        assert.strictEqual((await Sales.editFollowupDraft({ ...scope, actor: stale, text: 'Stale cookie' })).error, 'BUSINESS_ACCESS_DENIED');
        assert.strictEqual(Sales.claimFollowupDraft({ ...scope, actor: stale }).error, 'BUSINESS_ACCESS_DENIED');
    });

    it('denies unauthorized ad-hoc sends before any task, draft or identity-link mutation', async () => {
        const scope = await seed();
        const count = table => DB.get(`SELECT COUNT(*) AS n FROM ${table}`).n;
        const before = ['followup_drafts', 'manager_tasks', 'customer_identity_links'].map(count);
        const denied = await Sales.sendWhatsAppFollowup({ instanceId: scope.instanceId, chatId: scope.chatId,
            text: 'Unauthorized ad-hoc text', actor: { userId: 'observer-a' }, confirmed: true });
        assert.strictEqual(denied.error, 'CAPABILITY_DENIED');
        assert.deepStrictEqual(['followup_drafts', 'manager_tasks', 'customer_identity_links'].map(count), before);
    });

    it('owner and sales lead may work another assignee while demotion applies to an already authenticated actor', async () => {
        const scope = await seed({ assigneeUserId: 'manager-a' });
        assert.strictEqual((await Sales.editFollowupDraft(actorInput(scope, 'lead-a', { text: 'Lead saved' }))).success, true);
        const stale = Identity.actor('lead-a');
        DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId=?", ['lead-a']);
        assert.strictEqual((await Sales.rejectFollowupDraft({ ...scope, actor: stale })).error, 'CAPABILITY_DENIED');
        const provider = stubProvider();
        try {
            const sent = await Sales.approveWhatsAppFollowup(actorInput(scope, 'owner-a', { approvedBy: 'Forged name' }));
            assert.strictEqual(sent.sent, true);
            assert.strictEqual(sent.draft.approved_by, 'owner-a');
            assert.strictEqual(provider.calls(), 1);
        } finally { provider.restore(); }
    });

    it('rolls back legacy orphan linkage when canonical customer is assigned to another manager', async () => {
        const scope = await seed();
        DB.run('UPDATE clients SET assigneeUserId=? WHERE instanceId=? AND chatId=?', ['manager-b', scope.instanceId, scope.chatId]);
        const orphan = DB.createFollowupDraft({ instanceId: scope.instanceId, chatId: scope.chatId, text: 'Keep orphan durable' });
        const before = DB.get('SELECT COUNT(*) AS n FROM manager_tasks').n;
        const claimed = Sales.claimFollowupDraft({ ...actorInput(scope, 'manager-a'), draftId: orphan.draftId });
        assert.strictEqual(claimed.error, 'task_assigned_to_another_manager');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM manager_tasks').n, before);
        assert.strictEqual(DB.getFollowupDraft(scope.instanceId, orphan.draftId).managerTaskId, null);
        assert.strictEqual(DB.getFollowupDraft(scope.instanceId, orphan.draftId).text, 'Keep orphan durable');
    });

    it('refuses claims on closed tasks and sent or rejected drafts', async () => {
        const scope = await seed();
        DB.updateManagerTask(scope.instanceId, scope.taskId, { status: 'done' });
        assert.strictEqual(Sales.claimFollowupDraft(actorInput(scope, 'manager-a')).error, 'task_closed');
        assert.strictEqual(DB.getManagerTask(scope.instanceId, scope.taskId).assigneeUserId, null);
        for (const status of ['sent', 'rejected']) {
            DB.updateFollowupDraft(scope.instanceId, scope.draftId, { status });
            assert.strictEqual(Sales.claimFollowupDraft(actorInput(scope, 'manager-a')).error, 'draft_closed');
        }
    });

    it('never edits, rejects, approves or claims any unresolved provider state', async () => {
        const scope = await seed({ assigneeUserId: 'manager-a' });
        const provider = stubProvider();
        try {
            for (const delivery_status of ['pending', 'sending', 'unknown', 'unknown_pending', 'unknown-pending', 'unconfirmed']) {
                DB.updateFollowupDraft(scope.instanceId, scope.draftId, { status: 'approved', approvedBy: 'original-approver', metadata: { delivery_status } });
                assert.strictEqual((await Sales.editFollowupDraft(actorInput(scope, 'manager-a', { text: 'Never change' }))).error, 'delivery_pending');
                assert.strictEqual((await Sales.rejectFollowupDraft(actorInput(scope, 'owner-a'))).error, 'delivery_pending');
                assert.strictEqual((await Sales.approveWhatsAppFollowup(actorInput(scope, 'owner-a', { text: 'Never change' }))).error, 'delivery_pending');
                assert.strictEqual(Sales.claimFollowupDraft(actorInput(scope, 'manager-a')).error, 'delivery_pending');
                const draft = DB.getFollowupDraft(scope.instanceId, scope.draftId);
                assert.strictEqual(draft.text, 'Durable original');
                assert.strictEqual(draft.approvedBy, 'original-approver');
                assert.strictEqual(draft.sentAt, null);
            }
            assert.strictEqual(provider.calls(), 0);
        } finally { provider.restore(); }
    });

    it('provider success with unknown acknowledgment remains pending and cannot resend', async () => {
        for (const status of ['unknown', 'unknown_pending', 'unknown-pending', 'sending']) {
            const scope = await seed({ assigneeUserId: 'manager-a' });
            const provider = stubProvider({ success: true, status });
            try {
                const result = await Sales.approveWhatsAppFollowup(actorInput(scope, 'manager-a'));
                assert.strictEqual(result.sent, false);
                assert.strictEqual(result.status, 'pending');
                const saved = DB.getFollowupDraft(scope.instanceId, scope.draftId);
                assert.strictEqual(saved.status, 'approved');
                assert.strictEqual(saved.sentAt, null);
                assert.strictEqual(JSON.parse(saved.metadataJson).delivery_status, 'pending');
                assert.strictEqual((await Sales.approveWhatsAppFollowup(actorInput(scope, 'manager-a'))).error, 'delivery_pending');
                assert.strictEqual(provider.calls(), 1);
            } finally { provider.restore(); }
        }
    });

    it('completion leaves unresolved message unsent, and pending task reassignment remains denied', async () => {
        const scope = await seed({ assigneeUserId: 'manager-a' });
        DB.updateFollowupDraft(scope.instanceId, scope.draftId, { status: 'approved', metadata: { delivery_status: 'unknown-pending' } });
        const completed = await Sales.updateManagerTask(actorInput(scope, 'manager-a', { status: 'done' }));
        assert.strictEqual(completed.success, true);
        const reassigned = await Sales.updateManagerTask(actorInput(scope, 'lead-a', { assigneeUserId: 'manager-b' }));
        assert.strictEqual(reassigned.error, 'SALES_DELIVERY_PENDING');
        const draft = DB.getFollowupDraft(scope.instanceId, scope.draftId);
        assert.strictEqual(draft.status, 'approved');
        assert.strictEqual(draft.sentAt, null);
    });

    it('blocks reconciliation-required assignments and invalid delivery metadata even for owners', async () => {
        const scope = await seed({ assigneeUserId: 'manager-a' });
        DB.updateFollowupDraft(scope.instanceId, scope.draftId, { metadata: { assignment_reconciliation_required: true } });
        assert.strictEqual((await Sales.approveWhatsAppFollowup(actorInput(scope, 'owner-a'))).error, 'assignment_reconciliation_required');
        DB.run('UPDATE followup_drafts SET metadataJson=? WHERE instanceId=? AND draftId=?', ['invalid-json', scope.instanceId, scope.draftId]);
        assert.strictEqual((await Sales.rejectFollowupDraft(actorInput(scope, 'owner-a'))).error, 'delivery_pending');
    });

    it('rechecks revoked membership after asynchronous policy lookup before invoking the provider', async () => {
        const scope = await seed({ assigneeUserId: 'manager-a' });
        const policy = Sales.followupApprovalPolicy, provider = stubProvider();
        Sales.followupApprovalPolicy = async function(instanceId) {
            DB.run('UPDATE ava_business_memberships SET enabled=0 WHERE userId=?', ['manager-a']);
            return policy.call(this, instanceId);
        };
        try {
            const result = await Sales.approveWhatsAppFollowup(actorInput(scope, 'manager-a'));
            assert.strictEqual(result.error, 'BUSINESS_ACCESS_DENIED');
            assert.strictEqual(provider.calls(), 0);
            assert.strictEqual(DB.getFollowupDraft(scope.instanceId, scope.draftId).sentAt, null);
        } finally { Sales.followupApprovalPolicy = policy; provider.restore(); }
    });

    it('never sends text whose approval or target changes during asynchronous policy lookup', async () => {
        const scope = await seed({ assigneeUserId: 'manager-a' });
        const policy = Sales.followupApprovalPolicy, provider = stubProvider();
        Sales.followupApprovalPolicy = async function(instanceId) {
            DB.updateFollowupDraft(instanceId, scope.draftId, { text: 'Changed during await', status: 'draft', approvedBy: null, approvedAt: null });
            return policy.call(this, instanceId);
        };
        try {
            const result = await Sales.approveWhatsAppFollowup(actorInput(scope, 'manager-a'));
            assert.strictEqual(result.error, 'draft_changed_retry_required');
            assert.strictEqual(provider.calls(), 0);
            assert.strictEqual(DB.getFollowupDraft(scope.instanceId, scope.draftId).text, 'Changed during await');
        } finally { Sales.followupApprovalPolicy = policy; provider.restore(); }
    });
});
