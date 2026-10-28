'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const ClientIdentity = require('../src/services/client-identity.service');

function initialize(connection) {
    DB.db = connection;
    connection.pragma('foreign_keys = ON');
    DB.createTables();
    DB.ensureColumns();
    DB.createSalesBrainTables();
}

function legacySalesSchema() {
    DB.db.exec(`DROP INDEX idx_clients_assignee;
        DROP INDEX idx_manager_tasks_assignee;
        ALTER TABLE clients DROP COLUMN assigneeUserId;
        ALTER TABLE manager_tasks DROP COLUMN assigneeUserId;
        ALTER TABLE manager_tasks DROP COLUMN dueAt;
        ALTER TABLE manager_tasks DROP COLUMN createdByUserId;
        DROP TABLE sales_workspace_schema_migrations;`);
}

function migrationIdentityFixture() {
    // Only isolated membership source rows; migration must not infer identity
    // when these tables are absent, nor import a label from a display name.
    DB.db.exec(`CREATE TABLE ava_users (id TEXT PRIMARY KEY, displayName TEXT, enabled INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE ava_business_memberships (
            userId TEXT NOT NULL, businessId INTEGER NOT NULL, role TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(userId,businessId));`);
}

async function pair() {
    createTestDB();
    const business = await DB.createInstance({ name: 'Assignment fixture' });
    const target = await DB.getOrCreateClient(business.id, '79990000111@c.us', 'Canonical fixture');
    const source = await DB.getOrCreateClient(business.id, 'tg_123456', 'Merged fixture');
    return { business, target, source };
}

function attachPair({ business, target, source }) {
    return ClientIdentity.attach(business.id, target.chatId, {
        kind: 'telegram', value: '123456', confirmMerge: true, mergeChatId: source.chatId,
    });
}

function assertUnmerged({ business, target, source }) {
    assert.ok(DB.get('SELECT id FROM clients WHERE instanceId=? AND chatId=?', [business.id, source.chatId]));
    assert.strictEqual(ClientIdentity.canonical(business.id, source.chatId), source.chatId);
    assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM client_merge_archive').n, 0);
    assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM client_aliases').n, 0);
    assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM client_redirects').n, 0);
    assert.ok(DB.get('SELECT id FROM clients WHERE instanceId=? AND chatId=?', [business.id, target.chatId]));
}

describe('Durable sales assignment migration and canonical merge', () => {
    it('adds nullable assignment fields to an old schema without modifying legacy rows or timestamps', async () => {
        createTestDB();
        const business = await DB.createInstance({ name: 'Legacy fixture' });
        await DB.getOrCreateClient(business.id, 'tg_45678', 'Legacy client');
        legacySalesSchema();
        DB.run(`INSERT INTO manager_tasks(taskId,instanceId,chatId,summary,assignee,createdAt,updatedAt)
            VALUES ('legacy',?,'tg_45678','Legacy work','Legacy name','2020-01-01 00:00:00','2020-01-02 00:00:00')`, [business.id]);
        DB.createSalesBrainTables();
        DB.createSalesBrainTables();
        const row = DB.getManagerTask(business.id, 'legacy');
        assert.strictEqual(row.assignee, 'Legacy name');
        assert.strictEqual(row.assigneeUserId, null);
        assert.strictEqual(row.dueAt, null);
        assert.strictEqual(row.createdByUserId, null);
        assert.strictEqual(row.createdAt, '2020-01-01 00:00:00');
        assert.strictEqual(row.updatedAt, '2020-01-02 00:00:00');
        assert.strictEqual(DB.get('SELECT assigneeUserId FROM clients WHERE instanceId=?', [business.id]).assigneeUserId, null);
        for (const [table, names] of [['clients', ['assigneeUserId']], ['manager_tasks', ['assigneeUserId', 'dueAt', 'createdByUserId']]]) {
            const columns = DB.all(`PRAGMA table_info(${table})`);
            for (const name of names) {
                const field = columns.find(column => column.name === name);
                assert.strictEqual(field.type, 'TEXT');
                assert.strictEqual(field.notnull, 0);
                assert.strictEqual(field.dflt_value, null);
            }
        }
        assert.strictEqual(DB.db.pragma('integrity_check', { simple: true }), 'ok');
        assert.deepStrictEqual(DB.db.pragma('foreign_key_check'), []);
    });

    it('backfills only exact enabled user IDs in active same-business sales memberships once', async () => {
        createTestDB();
        const business = await DB.createInstance({ name: 'Backfill fixture' });
        const foreign = await DB.createInstance({ name: 'Foreign fixture' });
        migrationIdentityFixture();
        const cases = [
            ['manager-id', 'manager', 1, 1, business.id, 'manager-id'],
            ['lead-id', 'sales_lead', 1, 1, business.id, 'lead-id'],
            ['owner-id', 'hotel_owner', 1, 1, business.id, 'owner-id'],
            ['observer-id', 'observer', 1, 1, business.id, null],
            ['revoked-id', 'manager', 1, 0, business.id, null],
            ['disabled-id', 'manager', 0, 1, business.id, null],
            ['foreign-id', 'manager', 1, 1, foreign.id, null],
        ];
        for (const [userId, role, userEnabled, membershipEnabled, scope] of cases) {
            DB.run('INSERT INTO ava_users(id,displayName,enabled) VALUES (?,?,?)', [userId, 'Shared display name', userEnabled]);
            DB.run('INSERT INTO ava_business_memberships(userId,businessId,role,enabled) VALUES (?,?,?,?)', [userId, scope, role, membershipEnabled]);
            DB.createManagerTask({ instanceId: business.id, taskId: userId, summary: 'Legacy', assignee: userId });
        }
        for (const label of ['Shared display name', 'unrecognised', 'manager-id ', '00111']) {
            DB.createManagerTask({ instanceId: business.id, taskId: label, summary: 'Legacy label', assignee: label });
        }
        DB.createManagerTask({ instanceId: business.id, taskId: 'explicit-new', summary: 'Existing stable assignment',
            assignee: 'manager-id', assigneeUserId: 'owner-id' });
        DB.createSalesWorkspaceTables();
        DB.createSalesWorkspaceTables();
        for (const [userId, , , , , expected] of cases) {
            assert.strictEqual(DB.getManagerTask(business.id, userId).assigneeUserId, expected);
        }
        for (const label of ['Shared display name', 'unrecognised', 'manager-id ', '00111']) {
            assert.strictEqual(DB.getManagerTask(business.id, label).assigneeUserId, null);
        }
        assert.strictEqual(DB.getManagerTask(business.id, 'explicit-new').assigneeUserId, 'owner-id');
        DB.updateManagerTask(business.id, 'manager-id', { assigneeUserId: null });
        DB.createSalesWorkspaceTables();
        assert.strictEqual(DB.getManagerTask(business.id, 'manager-id').assigneeUserId, null);
        assert.strictEqual(DB.getManagerTask(business.id, 'manager-id').assignee, 'manager-id');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM sales_workspace_schema_migrations').n, 1);
    });

    it('does not backfill inactive businesses and can defer until identity schema exists', async () => {
        createTestDB();
        const business = await DB.createInstance({ name: 'Deferred fixture' });
        DB.createManagerTask({ instanceId: business.id, taskId: 'deferred', summary: 'Legacy', assignee: 'manager-id' });
        DB.createSalesWorkspaceTables();
        assert.strictEqual(DB.getManagerTask(business.id, 'deferred').assigneeUserId, null);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM sales_workspace_schema_migrations').n, 0);
        migrationIdentityFixture();
        DB.run("INSERT INTO ava_users(id) VALUES ('manager-id')");
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES ('manager-id',?,'manager')", [business.id]);
        DB.run('UPDATE instances SET isActive=0 WHERE id=?', [business.id]);
        DB.createSalesWorkspaceTables();
        assert.strictEqual(DB.getManagerTask(business.id, 'deferred').assigneeUserId, null);
    });

    it('saves exact due dates and user IDs across an actual process restart without resurrecting released legacy ownership', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-assignment-restart-'));
        const databasePath = path.join(directory, 'isolated.sqlite');
        const previous = DB.db;
        try {
            initialize(new Database(databasePath));
            const business = await DB.createInstance({ name: 'Restart fixture' });
            await DB.getOrCreateClient(business.id, 'tg_45678', 'Restart client');
            migrationIdentityFixture();
            DB.run("INSERT INTO ava_users(id) VALUES ('manager-id')");
            DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES ('manager-id',?,'manager')", [business.id]);
            DB.createManagerTask({ instanceId: business.id, taskId: 'restart', chatId: 'tg_45678', summary: 'Durable work',
                assignee: 'manager-id', assigneeUserId: 'manager-id', dueAt: '2026-10-03T10:15:00.000Z', createdByUserId: 'creator-id' });
            DB.createManagerTask({ instanceId: business.id, taskId: 'released', summary: 'Released work', assignee: 'manager-id' });
            DB.createSalesWorkspaceTables();
            DB.updateManagerTask(business.id, 'released', { assigneeUserId: null });
            DB.updateManagerTask(business.id, 'restart', { dueAt: '2026-10-04T11:30:00.000Z' });
            DB.run("UPDATE clients SET assigneeUserId='manager-id' WHERE instanceId=? AND chatId='tg_45678'", [business.id]);
            DB.db.close();
            const code = `const assert=require('node:assert/strict'); const Database=require('better-sqlite3');
                const DB=require('./src/services/database.service'); DB.db=new Database(process.argv[1]);
                DB.createSalesBrainTables(); DB.createSalesWorkspaceTables();
                const task=DB.getManagerTask(Number(process.argv[2]),'restart');
                assert.equal(task.assigneeUserId,'manager-id'); assert.equal(task.createdByUserId,'creator-id');
                assert.equal(task.dueAt,'2026-10-04T11:30:00.000Z');
                assert.equal(DB.getManagerTask(Number(process.argv[2]),'released').assigneeUserId,null);
                assert.equal(DB.get('SELECT assigneeUserId FROM clients WHERE instanceId=?',[Number(process.argv[2])]).assigneeUserId,'manager-id');
                assert.equal(DB.db.pragma('integrity_check',{simple:true}),'ok'); DB.db.close();`;
            execFileSync(process.execPath, ['-e', code, databasePath, String(business.id)], {
                cwd: path.resolve(__dirname, '..'), env: { ...process.env, DB_PATH: databasePath }, stdio: 'pipe',
            });
        } finally {
            if (DB.db?.open) DB.db.close();
            DB.db = previous;
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('creates and updates explicit assignment fields without changing legacy close semantics or tenant scope', async () => {
        createTestDB();
        const business = await DB.createInstance({ name: 'Task fixture' });
        const foreign = await DB.createInstance({ name: 'Other task fixture' });
        const task = DB.createManagerTask({ instanceId: business.id, taskId: 'manual', summary: 'Manual task',
            assignee: 'Legacy label', assigneeUserId: 'user-id', dueAt: '2026-10-04T00:00:00.000Z', createdByUserId: 'creator-id' });
        assert.strictEqual(task.assigneeUserId, 'user-id');
        assert.strictEqual(task.createdByUserId, 'creator-id');
        assert.strictEqual(task.closedAt, null);
        assert.strictEqual(DB.updateManagerTask(foreign.id, 'manual', { assigneeUserId: 'foreign-id' }), null);
        assert.strictEqual(DB.createManagerTask({ instanceId: foreign.id, taskId: 'manual', summary: 'Collision' }), undefined);
        const done = DB.updateManagerTask(business.id, 'manual', { status: 'done', assigneeUserId: null, dueAt: null });
        assert.ok(done.closedAt);
        assert.strictEqual(done.assignee, 'Legacy label');
        assert.strictEqual(done.assigneeUserId, null);
        assert.strictEqual(done.dueAt, null);
        assert.strictEqual(done.createdByUserId, 'creator-id');
        assert.strictEqual(DB.updateManagerTask(business.id, 'manual', { resolutionNote: 'Reviewed' }).closedAt, done.closedAt);
        const reopened = DB.updateManagerTask(business.id, 'manual', { status: 'new', assigneeUserId: 'other-id', createdByUserId: 'editor-id' });
        assert.strictEqual(reopened.closedAt, null);
        assert.strictEqual(reopened.assigneeUserId, 'other-id');
        assert.strictEqual(reopened.createdByUserId, 'editor-id');
    });

    it('retains a single canonical assignment and exact task/draft references, ownership and due timestamps on merge', async () => {
        const fixture = await pair();
        const { business, target, source } = fixture;
        const foreign = await DB.createInstance({ name: 'Foreign merge fixture' });
        await DB.getOrCreateClient(foreign.id, source.chatId, 'Foreign card');
        DB.run("UPDATE clients SET assigneeUserId='source-owner' WHERE instanceId=? AND chatId=?", [business.id, source.chatId]);
        const task = DB.createManagerTask({ instanceId: business.id, taskId: 'merged-task', chatId: source.chatId,
            customerId: `crm_${business.id}_${source.id}`, summary: 'Assigned task', assigneeUserId: 'task-owner',
            createdByUserId: 'creator-id', dueAt: '2026-10-04T11:30:00.000Z' });
        DB.createFollowupDraft({ instanceId: business.id, draftId: 'merged-draft', chatId: source.chatId,
            customerId: `crm_${business.id}_${source.id}`, managerTaskId: task.taskId, text: 'Durable draft' });
        attachPair(fixture);
        assert.strictEqual(DB.get('SELECT assigneeUserId FROM clients WHERE instanceId=? AND chatId=?',
            [business.id, target.chatId]).assigneeUserId, 'source-owner');
        const mergedTask = DB.getManagerTask(business.id, task.taskId);
        assert.strictEqual(mergedTask.chatId, target.chatId);
        assert.strictEqual(mergedTask.customerId, `crm_${business.id}_${target.id}`);
        assert.strictEqual(mergedTask.assigneeUserId, 'task-owner');
        assert.strictEqual(mergedTask.createdByUserId, 'creator-id');
        assert.strictEqual(mergedTask.dueAt, '2026-10-04T11:30:00.000Z');
        const draft = DB.getFollowupDraft(business.id, 'merged-draft');
        assert.strictEqual(draft.chatId, target.chatId);
        assert.strictEqual(draft.customerId, mergedTask.customerId);
        assert.strictEqual(draft.managerTaskId, task.taskId);
        assert.strictEqual(draft.text, 'Durable draft');
        assert.strictEqual(DB.get('SELECT chatId,assigneeUserId FROM clients WHERE instanceId=?', [foreign.id]).chatId, source.chatId);
        assert.strictEqual(DB.get('SELECT assigneeUserId FROM clients WHERE instanceId=?', [foreign.id]).assigneeUserId, null);
        assert.deepStrictEqual(DB.db.pragma('foreign_key_check'), []);
    });

    it('retains the target assignment when source is unassigned or has the same exact user ID', async () => {
        for (const sourceOwner of [null, 'same-user']) {
            const fixture = await pair();
            DB.run("UPDATE clients SET assigneeUserId='same-user' WHERE instanceId=? AND chatId=?", [fixture.business.id, fixture.target.chatId]);
            DB.run('UPDATE clients SET assigneeUserId=? WHERE instanceId=? AND chatId=?', [sourceOwner, fixture.business.id, fixture.source.chatId]);
            attachPair(fixture);
            assert.strictEqual(DB.get('SELECT assigneeUserId FROM clients WHERE instanceId=?', [fixture.business.id]).assigneeUserId, 'same-user');
        }
    });

    it('fails conflicting canonical ownership atomically before moving any client/task/draft rows', async () => {
        const fixture = await pair();
        const { business, target, source } = fixture;
        DB.run("UPDATE clients SET assigneeUserId='target-owner' WHERE instanceId=? AND chatId=?", [business.id, target.chatId]);
        DB.run("UPDATE clients SET assigneeUserId='source-owner' WHERE instanceId=? AND chatId=?", [business.id, source.chatId]);
        DB.createManagerTask({ instanceId: business.id, taskId: 'conflict-task', chatId: source.chatId, summary: 'Retain' });
        DB.createFollowupDraft({ instanceId: business.id, draftId: 'conflict-draft', chatId: source.chatId, text: 'Retain' });
        assert.throws(() => attachPair(fixture), error => error.code === 'ASSIGNMENT_MERGE_CONFLICT' && error.statusCode === 409);
        assertUnmerged(fixture);
        assert.strictEqual(DB.getManagerTask(business.id, 'conflict-task').chatId, source.chatId);
        assert.strictEqual(DB.getFollowupDraft(business.id, 'conflict-draft').chatId, source.chatId);
        assert.deepStrictEqual(DB.all('SELECT assigneeUserId FROM clients WHERE instanceId=? ORDER BY id', [business.id])
            .map(row => row.assigneeUserId), ['target-owner', 'source-owner']);
    });

    it('blocks merge for sending and unknown delivery in either card, including drafts linked solely through tasks', async () => {
        const states = [
            { status: 'sending' }, { status: 'pending' }, { status: 'unknown-pending' },
            { metadata: { delivery_status: 'pending' } }, { metadata: { delivery_status: 'unknown' } },
            { metadata: { delivery_status: 'unknown_pending' } },
        ];
        for (const state of states) {
            for (const side of ['target', 'source']) {
                const fixture = await pair();
                const { business } = fixture;
                DB.createManagerTask({ instanceId: business.id, taskId: 'pending-task', chatId: fixture[side].chatId, summary: 'Await acknowledgement' });
                DB.createFollowupDraft({ instanceId: business.id, draftId: 'pending-draft', managerTaskId: 'pending-task', text: 'Await acknowledgement', ...state });
                assert.throws(() => attachPair(fixture), error => error.code === 'FOLLOWUP_DELIVERY_PENDING' && error.statusCode === 409);
                assertUnmerged(fixture);
                assert.strictEqual(DB.getFollowupDraft(business.id, 'pending-draft').managerTaskId, 'pending-task');
            }
        }
    });

    it('blocks task-only drafts with unknown or unconfirmed provider acknowledgements in either merge card', async () => {
        for (const providerStatus of ['unknown', 'unconfirmed']) {
            for (const side of ['target', 'source']) {
                const fixture = await pair();
                const { business } = fixture;
                DB.createManagerTask({ instanceId: business.id, taskId: 'provider-task', chatId: fixture[side].chatId,
                    summary: 'Await provider acknowledgement' });
                DB.createFollowupDraft({ instanceId: business.id, draftId: 'provider-draft', managerTaskId: 'provider-task',
                    text: 'Unknown provider delivery', metadata: { provider_status: providerStatus } });
                assert.throws(() => attachPair(fixture), error => error.code === 'FOLLOWUP_DELIVERY_PENDING' && error.statusCode === 409);
                assertUnmerged(fixture);
                assert.strictEqual(DB.getManagerTask(business.id, 'provider-task').chatId, fixture[side].chatId);
                assert.strictEqual(JSON.parse(DB.getFollowupDraft(business.id, 'provider-draft').metadataJson).provider_status, providerStatus);
            }
        }
    });

    it('fails closed and rolls back merge when task-only draft metadata is malformed or not an object', async () => {
        for (const rawMetadata of ['{malformed', '', 'null', '[]', '"pending"']) {
            const fixture = await pair();
            const { business, source } = fixture;
            DB.createManagerTask({ instanceId: business.id, taskId: 'corrupt-task', chatId: source.chatId, summary: 'Unknown acknowledgement' });
            DB.createFollowupDraft({ instanceId: business.id, draftId: 'corrupt-draft', managerTaskId: 'corrupt-task', text: 'Preserve refs' });
            DB.run('UPDATE followup_drafts SET metadataJson=? WHERE instanceId=? AND draftId=?', [rawMetadata, business.id, 'corrupt-draft']);
            assert.throws(() => attachPair(fixture), error => error.code === 'FOLLOWUP_DELIVERY_PENDING' && error.statusCode === 409);
            assertUnmerged(fixture);
            assert.strictEqual(DB.getManagerTask(business.id, 'corrupt-task').chatId, source.chatId);
            assert.strictEqual(DB.getFollowupDraft(business.id, 'corrupt-draft').metadataJson, rawMetadata);
        }
    });

    it('permits merge after actual delivery reconciliation and keeps sent/provider acknowledgement fields', async () => {
        const fixture = await pair();
        DB.createFollowupDraft({ instanceId: fixture.business.id, draftId: 'ack-draft', chatId: fixture.source.chatId,
            text: 'Acknowledged fixture', status: 'sent', metadata: { delivery_status: 'sent', provider_message_id: 'fixture-ack' } });
        DB.updateFollowupDraft(fixture.business.id, 'ack-draft', { sentAt: '2026-10-02T10:00:00.000Z' });
        attachPair(fixture);
        const draft = DB.getFollowupDraft(fixture.business.id, 'ack-draft');
        assert.strictEqual(draft.status, 'sent');
        assert.strictEqual(draft.sentAt, '2026-10-02T10:00:00.000Z');
        assert.strictEqual(JSON.parse(draft.metadataJson).provider_message_id, 'fixture-ack');
    });
});
