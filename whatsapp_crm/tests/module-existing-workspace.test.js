'use strict';

const crypto = require('crypto');
const { describe, it: register, assert, createTestDB, runAll } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Provisioning = require('../src/services/provisioning/business-provisioning-store.service');
const Twenty = require('../src/services/twenty/twenty-store.service');
const Access = require('../src/services/identity/module-access-store');

const admin = { userId: 'existing-workspace-test-operator', platformRole: 'platform_admin' };

function it(name, run) {
    register(name, async () => {
        const previous = process.env.AVA_PROCESS_ROLE;
        createTestDB();
        process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        try { await run(); } finally {
            if (previous === undefined) delete process.env.AVA_PROCESS_ROLE;
            else process.env.AVA_PROCESS_ROLE = previous;
        }
    });
}

function setup(name = 'existing-workspace') {
    const invitation = Identity.createInvitation(admin, { email: `${name}@example.test` });
    const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), `subject-${name}`);
    const business = Provisioning.createBusinessAtomic({ name }, { ownerUserId: user.userId }).instance;
    Twenty.upsertIntegration(business.id, {
        baseUrl: `https://${name}.crm.meludtech.tech`,
        workspaceId: crypto.randomUUID(),
        enabled: true,
        mode: 'live',
    });
    const integration = Twenty.getIntegrationUnsafe(business.id);
    const input = {
        businessId: business.id,
        module: 'twenty',
        publicOrigin: `https://${name}.crm.meludtech.tech`,
        attachmentMode: 'existing_workspace_ui',
        expectedNativeScope: integration.workspaceId,
        expectedIntegrationRevision: integration.revision,
    };
    return { user, business, integration, input };
}

function prepareInput(value, outbox) {
    return {
        businessId: value.business.id,
        correlationId: outbox.eventId,
        outboxLeaseToken: outbox.leaseToken,
        integrationRevision: Twenty.getIntegrationUnsafe(value.business.id).revision,
        method: 'POST',
        objectName: 'tasks',
        recordId: null,
        body: { avaBusinessId: String(value.business.id), title: 'Existing workspace task' },
    };
}

function setupIsolatedOnyx(name = 'isolated-onyx') {
    const invitation = Identity.createInvitation(admin, { email: `${name}@example.test` });
    const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), `subject-${name}`);
    const business = Provisioning.createBusinessAtomic({ name }, { ownerUserId: user.userId }).instance;
    DB.run("INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,status) VALUES (?,?,?,'STAGING')",
        [business.id, `legacy-${business.id}`, `https://legacy-${business.id}.knowledge.meludtech.tech`]);
    const integration = DB.get('SELECT * FROM onyx_tenant_links WHERE business_id=?', [business.id]);
    const deploymentId = crypto.randomUUID();
    const namespace = `ava_${deploymentId.replaceAll('-', '')}`;
    const hostname = `${name}-${business.id}.knowledge.meludtech.tech`;
    DB.run(`INSERT INTO ava_module_deployments
        (id,businessId,module,hostname,namespace,state,revision,sourceCommit,correlationId,createdAt,updatedAt)
        VALUES (?,?,'onyx',?,?,'verified',3,?,?,?,?)`,
        [deploymentId, business.id, hostname, namespace, 'a1b9e02eb65cc114c65381cbef5e555e1753ed0a', crypto.randomUUID(), Date.now(), Date.now()]);
    return {
        user, business, integration, deploymentId, namespace, hostname,
        input: { businessId: business.id, module: 'onyx', publicOrigin: `https://${hostname}`,
            attachmentMode: 'isolated_workspace_ui', expectedNativeScope: namespace,
            expectedIntegrationRevision: integration.revision },
    };
}

describe('explicit existing Twenty workspace UI attachment', () => {
    it('is worker-only, pinned to the live Twenty link, and cannot create a principal without real readback', async () => {
        const value = setup();
        assert.throws(() => Access.configure({ ...value.input, expectedNativeScope: 'other-workspace' }),
            { code: 'MODULE_EXISTING_WORKSPACE_UI_INVALID' });
        assert.throws(() => Access.configure({ ...value.input, expectedIntegrationRevision: value.integration.revision + 1 }),
            { code: 'MODULE_EXISTING_WORKSPACE_UI_INVALID' });
        assert.throws(() => Access.configure({ ...value.input, module: 'onyx' }),
            { code: 'MODULE_INTEGRATION_UNAVAILABLE' });

        const adapter = Access.configure(value.input);
        assert.strictEqual(adapter.attachmentMode, 'existing_workspace_ui');
        assert.deepStrictEqual(DB.get('SELECT attachmentMode,deploymentId,deploymentRevision FROM ava_module_adapters WHERE id=?', [adapter.id]),
            { attachmentMode: 'existing_workspace_ui', deploymentId: null, deploymentRevision: null });

        await assert.rejects(Access.verifyPrincipal({
            adapterId: adapter.id,
            userId: value.user.userId,
            nativeUserId: 'existing-workspace-user',
            readback: async input => ({ ...input, ownAccess: true }),
        }), { code: 'MODULE_NATIVE_PROOF_INCOMPLETE' });
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM ava_module_principals').n, 0);

        process.env.AVA_PROCESS_ROLE = 'web';
        assert.throws(() => Access.configure(value.input), { code: 'MODULE_WORKER_REQUIRED' });
    });

    it('returns an explicit legacy-runtime result only while the explicit UI attachment is current and enabled', () => {
        const value = setup('legacy-runtime');
        const adapter = Access.configure(value.input);
        Twenty.enqueue(value.business.id, 'manager_task', 'manager_tasks', 'existing-workspace-task');
        const [outbox] = Twenty.leaseOutbox(1, 60);
        const input = prepareInput(value, outbox);

        assert.deepStrictEqual(Access.prepareSyncMutation(input), {
            prepared: false,
            reason: 'MODULE_EXISTING_WORKSPACE_UI_LEGACY_RUNTIME',
        });
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM ava_sync_mutations').n, 0);
        assert.throws(() => Access.acquireSyncLease({
            contractVersion: 'ava-sync-lease-v1',
            deploymentId: adapter.id,
            businessId: value.business.id,
            nativeScope: adapter.nativeScope,
            revision: adapter.revision,
            nativeKeyId: crypto.randomUUID(),
            generation: 1,
            roleId: crypto.randomUUID(),
            correlationId: outbox.eventId,
            method: 'POST',
            path: '/rest/tasks',
            objectName: 'tasks',
            recordId: null,
            bodyDigest: 'a'.repeat(64),
        }, { adapterId: adapter.id, peerSecret: adapter.peerSecret }),
            { code: 'MODULE_EXISTING_WORKSPACE_UI_ONLY' });

        Access.disable(adapter.id);
        assert.throws(() => Access.prepareSyncMutation(input), { code: 'MODULE_ADAPTER_UNAVAILABLE' });
    });

    it('does not auto-fallback or permit mode changes during reconfiguration', () => {
        const value = setup('mode-fence');
        const full = Access.configure({
            businessId: value.business.id,
            module: 'twenty',
            publicOrigin: value.input.publicOrigin,
        });
        assert.strictEqual(full.attachmentMode, 'full');
        assert.throws(() => Access.configure(value.input), { code: 'MODULE_ATTACHMENT_MODE_MIGRATION_REQUIRED' });

        createTestDB();
        process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        const ui = setup('mode-fence-ui');
        Access.configure(ui.input);
        assert.throws(() => Access.configure({
            businessId: ui.business.id,
            module: 'twenty',
            publicOrigin: ui.input.publicOrigin,
        }), { code: 'MODULE_ATTACHMENT_MODE_MIGRATION_REQUIRED' });

        const deploymentId = crypto.randomUUID();
        DB.run(`INSERT INTO ava_module_deployments(id,businessId,module,hostname,namespace,state,revision,correlationId,createdAt,updatedAt)
            VALUES (?,?,'twenty',? ,?,'verified',1,?,?,?)`, [deploymentId, ui.business.id,
            `mode-fence-ui.crm.meludtech.tech`, `ava_${deploymentId.replaceAll('-', '')}`, crypto.randomUUID(), Date.now(), Date.now()]);
        assert.throws(() => Access.configure(ui.input), { code: 'MODULE_EXISTING_WORKSPACE_UI_INVALID' });
    });
});

describe('explicit isolated Onyx workspace UI attachment', () => {
    it('binds the verified deployment namespace while retaining the legacy integration identity', () => {
        const value = setupIsolatedOnyx();
        const adapter = Access.configure(value.input);
        assert.strictEqual(adapter.attachmentMode, 'isolated_workspace_ui');
        assert.strictEqual(adapter.nativeScope, value.namespace);
        assert.strictEqual(adapter.deploymentId, value.deploymentId);
        assert.deepStrictEqual(DB.get('SELECT id,revision,onyx_tenant_id,status FROM onyx_tenant_links WHERE business_id=?', [value.business.id]),
            { id: value.integration.id, revision: value.integration.revision, onyx_tenant_id: value.integration.onyx_tenant_id, status: 'STAGING' });
        assert.strictEqual(adapter.attachmentMode, 'isolated_workspace_ui');
        assert.deepStrictEqual(DB.get('SELECT integrationId,integrationRevision,deploymentId,deploymentRevision,attachmentMode,attachmentModeV2,nativeScope FROM ava_module_adapters WHERE id=?', [adapter.id]),
            { integrationId: String(value.integration.id), integrationRevision: value.integration.revision,
                deploymentId: value.deploymentId, deploymentRevision: 3, attachmentMode: 'existing_workspace_ui', attachmentModeV2: 'isolated_workspace_ui', nativeScope: value.namespace });
    });

    it('requires the exact verified deployment, namespace, and live integration revision', () => {
        const value = setupIsolatedOnyx('isolated-fences');
        const other = setupIsolatedOnyx('isolated-other');
        assert.throws(() => Access.configure({ ...value.input, businessId: other.business.id }),
            { code: 'MODULE_ISOLATED_WORKSPACE_UI_INVALID' });
        assert.throws(() => Access.configure({ ...value.input, expectedNativeScope: 'ava_foreign' }),
            { code: 'MODULE_ISOLATED_WORKSPACE_UI_INVALID' });
        assert.throws(() => Access.configure({ ...value.input, expectedIntegrationRevision: value.integration.revision + 1 }),
            { code: 'MODULE_ISOLATED_WORKSPACE_UI_INVALID' });
        DB.run("UPDATE ava_module_deployments SET state='provisioning' WHERE id=?", [value.deploymentId]);
        assert.throws(() => Access.configure(value.input), { code: 'MODULE_ISOLATED_WORKSPACE_UI_INVALID' });
        DB.run("UPDATE ava_module_deployments SET state='verified' WHERE id=?", [value.deploymentId]);
        DB.run('UPDATE onyx_tenant_links SET revision=revision+1 WHERE business_id=?', [value.business.id]);
        assert.throws(() => Access.configure(value.input), { code: 'MODULE_ISOLATED_WORKSPACE_UI_INVALID' });
    });

    it('is UI-only, rejects sync, and disables on adapter revision fence', () => {
        const value = setupIsolatedOnyx('isolated-ui-only');
        const adapter = Access.configure(value.input);
        assert.throws(() => Access.acquireSyncLease({
            contractVersion: 'ava-sync-lease-v1', deploymentId: adapter.id, businessId: value.business.id,
            nativeScope: value.namespace, revision: adapter.revision, nativeKeyId: crypto.randomUUID(),
            generation: 1, roleId: crypto.randomUUID(), correlationId: crypto.randomUUID(), method: 'GET',
            path: '/rest/people', objectName: 'people', recordId: null, bodyDigest: 'a'.repeat(64),
        }, { adapterId: adapter.id, peerSecret: adapter.peerSecret }), { code: 'MODULE_EXISTING_WORKSPACE_UI_ONLY' });
        Access.disable(adapter.id);
        const sessionToken = Identity.createSession(value.user.subject, crypto.randomUUID());
        const onyx = Access.list({ sessionToken, businessId: value.business.id }).find(item => item.module === 'onyx');
        assert.strictEqual(onyx.state, 'awaiting_setup');
        assert.strictEqual(onyx.error_code, 'MODULE_ADAPTER_UNAVAILABLE');
    });
});

if (require.main === module) runAll().then(ok => { if (!ok) process.exitCode = 1; });
