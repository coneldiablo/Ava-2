'use strict';
const crypto = require('crypto');
const http = require('http');
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Provisioning = require('../src/services/provisioning/business-provisioning-store.service');
const Twenty = require('../src/services/twenty/twenty-store.service');
const TwentyService = require('../src/services/twenty/twenty.service');
const Access = require('../src/services/identity/module-access-store');
const RecoveryWorker = require('../src/services/identity/sync-lease-recovery-worker');
const { createServer } = require('../src/services/identity/module-access-broker');

const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';
const UUID_3 = '33333333-3333-4333-8333-333333333333';
const UUID_4 = '44444444-4444-4444-8444-444444444444';
const UUID_5 = '55555555-5555-4555-8555-555555555555';
const RECORD_UUID = '66666666-6666-4666-8666-666666666666';
const CONTAINER_DB = 'a'.repeat(64);
const CONTAINER_NATIVE = 'b'.repeat(64);

const admin = { userId: 'admin-sync-test', platformRole: 'platform_admin' };

function setupBuyer(name, { workspaceId = UUID_1, reset = true } = {}) {
    if (reset) createTestDB();
    process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
    process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';

    const invitation = Identity.createInvitation(admin, { email: `${name}@example.test` });
    const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), `subject-${name}`);
    const business = Provisioning.createBusinessAtomic({ name }, { ownerUserId: user.userId }).instance;

    Twenty.upsertIntegration(business.id, {
        baseUrl: `https://${name}.crm.meludtech.tech`,
        workspaceId,
        enabled: true,
        mode: 'live',
    });

    const adapter = Access.configure({
        businessId: business.id,
        module: 'twenty',
        publicOrigin: `https://${name}.crm.meludtech.tech`,
    });

    return { business, user, adapter, workspaceId };
}

const OBJECT_BY_ENTITY = Object.freeze({
    hotel: 'companies', person: 'people', manager_task: 'tasks', call: 'avaCalls',
    outbound_campaign: 'avaCampaigns', outbound_lead: 'avaCampaignMembers', outbound_attempt: 'avaCallAttempts',
    followup_draft: 'avaFollowUpDrafts', booking_request: 'avaBookingRequests',
});
const peerAuth = adapter => ({ adapterId: adapter.id, peerSecret: adapter.peerSecret });

function preparedClaim(business, adapter, outboxRow, request = {}) {
    const method = request.method || 'POST';
    const objectName = request.objectName || OBJECT_BY_ENTITY[outboxRow.entityType];
    const recordId = request.recordId || null;
    const body = method === 'GET' ? null : (request.body || { avaBusinessId: String(business.id), name: 'Test Task' });
    const prepared = Access.prepareSyncMutation({
        businessId: business.id,
        correlationId: outboxRow.eventId,
        outboxLeaseToken: outboxRow.leaseToken,
        integrationRevision: Twenty.getIntegrationUnsafe(business.id).revision,
        method,
        objectName,
        recordId,
        body,
    });
    assert.strictEqual(prepared.prepared, true);

    return {
        contractVersion: 'ava-sync-lease-v1',
        deploymentId: adapter.deploymentId || adapter.id,
        businessId: business.id,
        nativeScope: adapter.nativeScope,
        revision: adapter.deploymentRevision || adapter.revision,
        nativeKeyId: UUID_3,
        generation: 1,
        roleId: UUID_4,
        correlationId: outboxRow.eventId,
        method,
        path: prepared.path,
        objectName,
        recordId,
        bodyDigest: prepared.bodyDigest,
    };
}

function validClaim(business, adapter, outboxRow, overrides = {}) {
    return { ...preparedClaim(business, adapter, outboxRow), ...overrides };
}

function managedAdapter(business, adapter) {
    const storedAdapter = DB.get('SELECT * FROM ava_module_adapters WHERE id=?', [adapter.id]);
    const adapterHostname = new URL(storedAdapter.publicOrigin).hostname;
    let deployment = DB.get("SELECT * FROM ava_module_deployments WHERE businessId=? AND module='twenty'", [business.id]);
    if (!deployment) {
        const id = crypto.randomUUID();
        DB.run(`INSERT INTO ava_module_deployments(id,businessId,module,hostname,namespace,state,revision,sourceCommit,
            correlationId,createdAt,updatedAt) VALUES (?,?,'twenty',?,?,'verified',1,?,?,?,?)`,
        [id, business.id, adapterHostname,
            `ava_${id.replaceAll('-', '')}`, '6da524b8903ec16a3eeea4b2e4a5fb63dbfc1c58', crypto.randomUUID(), Date.now(), Date.now()]);
        deployment = DB.get('SELECT * FROM ava_module_deployments WHERE id=?', [id]);
    } else {
        DB.run(`UPDATE ava_module_deployments SET state='verified',revision=1,sourceCommit=?,hostname=?,updatedAt=? WHERE id=?`,
        ['6da524b8903ec16a3eeea4b2e4a5fb63dbfc1c58', adapterHostname,
            Date.now(), deployment.id]);
        deployment = DB.get('SELECT * FROM ava_module_deployments WHERE id=?', [deployment.id]);
    }
    DB.run('UPDATE ava_module_adapters SET deploymentId=?,deploymentRevision=? WHERE id=?',
        [deployment.id, deployment.revision, adapter.id]);
    return { ...adapter, deploymentId: deployment.id, deploymentRevision: deployment.revision,
        publicOrigin: storedAdapter.publicOrigin };
}

function recoveryProof(claim, overrides = {}) {
    const deployment = DB.get('SELECT * FROM ava_module_deployments WHERE id=?', [claim.deploymentId]);
    const stop = Date.now();
    const containers = [
        { service: 'database', containerId: CONTAINER_DB, beforeRunning: true, beforeRestarting: false,
            beforePid: 111, beforeStartedAt: stop - 1000, stoppedRunning: false, stoppedRestarting: false, stoppedPid: 0,
            afterRunning: true, afterRestarting: false, afterPid: 111, afterStartedAt: stop + 10, health: 'healthy' },
        { service: 'native', containerId: CONTAINER_NATIVE, beforeRunning: false, beforeRestarting: false,
            beforePid: 0, beforeStartedAt: null, stoppedRunning: false, stoppedRestarting: false, stoppedPid: 0,
            afterRunning: true, afterRestarting: false, afterPid: 222, afterStartedAt: stop + 20, health: 'healthy' },
    ];
    return {
        ...Object.fromEntries(Object.entries(claim).filter(([key]) => key !== 'recoveryToken')),
        namespace: deployment.namespace,
        sourceCommit: deployment.sourceCommit,
        project: deployment.namespace,
        stopObservedAt: stop,
        ownedContainerIds: [CONTAINER_DB, CONTAINER_NATIVE].sort(),
        stoppedContainerIds: [CONTAINER_DB, CONTAINER_NATIVE].sort(),
        containers,
        database: { containerId: CONTAINER_DB, postmasterStartedAt: stop + 10,
            recoveryCompletedAt: stop + 30, readyAt: stop + 40 },
        native: { containerId: CONTAINER_NATIVE, readyAt: stop + 40 },
        completedAt: stop + 50,
        ...overrides,
    };
}

describe('Twenty CRM sync lease contract (ava-sync-lease-v1)', () => {
    it('mints exact sync lease when outbox row is leased with matching entity mapping', async () => {
        const { business, adapter } = setupBuyer('lease-ok');
        Twenty.enqueue(business.id, 'manager_task', 'manager_tasks', 'task-1');
        const [outboxRow] = Twenty.leaseOutbox(10, 60);
        assert.ok(outboxRow, 'outbox row must be leased');
        assert.strictEqual(outboxRow.status, 'LEASED');

        const claim = validClaim(business, adapter, outboxRow);
        const now = Date.now();
        const lease = Access.acquireSyncLease(claim, peerAuth(adapter));

        assert.strictEqual(lease.authorized, true);
        assert.strictEqual(lease.contractVersion, 'ava-sync-lease-v1');
        assert.strictEqual(typeof lease.leaseId, 'string');
        assert.match(lease.leaseId, /^[0-9a-f-]{36}$/);
        assert.ok(lease.expiresAt > now + 5000 && lease.expiresAt <= now + 60000);
        assert.strictEqual(lease.businessId, business.id);
        assert.strictEqual(lease.nativeScope, adapter.nativeScope);
        assert.strictEqual(lease.correlationId, outboxRow.eventId);
        assert.strictEqual(lease.method, 'POST');
        assert.strictEqual(lease.path, '/rest/tasks');
        assert.strictEqual(lease.objectName, 'tasks');
        assert.strictEqual(lease.recordId, null);
        assert.strictEqual(lease.bodyDigest, claim.bodyDigest);

        const stored = Access.getSyncLease(lease.leaseId);
        assert.ok(stored);
        assert.strictEqual(stored.status, 'active');
        assert.strictEqual(stored.correlationId, outboxRow.eventId);
    });

    it('rejects claim with invalid contract version, unallowed object, or malformed fields', async () => {
        const { business, adapter } = setupBuyer('lease-invalid');
        Twenty.enqueue(business.id, 'manager_task', 'manager_tasks', 'task-2');
        const [outboxRow] = Twenty.leaseOutbox(10, 60);

        assert.throws(() => {
            Access.acquireSyncLease(validClaim(business, adapter, outboxRow, { contractVersion: 'invalid-contract' }), peerAuth(adapter));
        }, { code: 'MODULE_CONTRACT_INVALID' });

        assert.throws(() => {
            Access.acquireSyncLease(validClaim(business, adapter, outboxRow, { objectName: 'forbiddenObject' }), peerAuth(adapter));
        }, { code: 'MODULE_CLAIM_INVALID' });

        assert.throws(() => {
            Access.acquireSyncLease(validClaim(business, adapter, outboxRow, { method: 'DELETE' }), peerAuth(adapter));
        }, { code: 'MODULE_CLAIM_INVALID' });

        assert.throws(() => {
            Access.acquireSyncLease(validClaim(business, adapter, outboxRow, { method: 'POST', recordId: RECORD_UUID }), peerAuth(adapter));
        }, { code: 'MODULE_CLAIM_INVALID' });

        assert.throws(() => {
            Access.acquireSyncLease(validClaim(business, adapter, outboxRow, { method: 'PATCH', recordId: null }), peerAuth(adapter));
        }, { code: 'MODULE_CLAIM_INVALID' });

        assert.throws(() => {
            Access.acquireSyncLease(validClaim(business, adapter, outboxRow, { bodyDigest: 'not-a-sha256-hex' }), peerAuth(adapter));
        }, { code: 'MODULE_CLAIM_INVALID' });
    });

    it('rejects when outbox row is missing, expired, unleased, or mapped to wrong object', async () => {
        const { business, adapter } = setupBuyer('lease-fenced');
        Twenty.enqueue(business.id, 'manager_task', 'manager_tasks', 'task-3');

        // Outbox is PENDING, not LEASED
        const pendingOutbox = DB.get('SELECT * FROM twenty_sync_outbox WHERE businessId=?', [business.id]);
        assert.strictEqual(pendingOutbox.status, 'PENDING');

        assert.throws(() => {
            Access.acquireSyncLease({ ...preparedClaim(business, adapter, { ...pendingOutbox, status: 'LEASED', leaseToken: UUID_5 }), correlationId: pendingOutbox.eventId }, peerAuth(adapter));
        }, { code: 'MODULE_SYNC_LEASE_FENCED' });

        // Lease the outbox row
        const [leasedRow] = Twenty.leaseOutbox(10, 60);

        // Mismatched correlationId (not in outbox)
        assert.throws(() => {
            Access.acquireSyncLease(validClaim(business, adapter, leasedRow, { correlationId: UUID_5 }), peerAuth(adapter));
        }, { code: 'MODULE_SYNC_LEASE_DENIED' });

        // Wrong entity mapping: outbox is manager_task (tasks), but claim asks for people
        assert.throws(() => {
            Access.acquireSyncLease(validClaim(business, adapter, leasedRow, {
                objectName: 'people',
                path: '/rest/people',
            }), peerAuth(adapter));
        }, { code: 'MODULE_SYNC_LEASE_DENIED' });

        // Expired outbox lease
        const expiringClaim = validClaim(business, adapter, leasedRow);
        DB.run("UPDATE twenty_sync_outbox SET leasedUntil=datetime('now','-1 second') WHERE eventId=?", [leasedRow.eventId]);
        assert.throws(() => {
            Access.acquireSyncLease(expiringClaim, peerAuth(adapter));
        }, { code: 'MODULE_SYNC_LEASE_EXPIRED' });
    });

    it('enforces tenant isolation: rejects foreign business and cross-tenant record link collision', async () => {
        const first = setupBuyer('tenant-first');
        const second = setupBuyer('tenant-second', { workspaceId: UUID_2, reset: false });

        Twenty.enqueue(first.business.id, 'person', 'clients', 'client-1');
        const [firstRow] = Twenty.leaseOutbox(10, 60);

        // Second business tries to claim first business outbox event
        assert.throws(() => {
            Access.acquireSyncLease(validClaim(first.business, first.adapter, firstRow), peerAuth(second.adapter));
        }, { code: 'MODULE_SCOPE_MISMATCH' });

        // A record linked to another source row in the same native workspace
        // cannot be rebound by changing only the request URL.
        Twenty.upsertRecordLink({
            businessId: first.business.id,
            entityType: 'person',
            sourceTable: 'clients',
            sourceId: 'client-999',
            twentyObject: 'people',
            twentyRecordId: RECORD_UUID,
        });

        assert.throws(() => {
            Access.prepareSyncMutation({ businessId: first.business.id, correlationId: firstRow.eventId,
                outboxLeaseToken: firstRow.leaseToken, integrationRevision: Twenty.getIntegrationUnsafe(first.business.id).revision,
                method: 'PATCH', objectName: 'people', recordId: RECORD_UUID,
                body: { avaBusinessId: String(first.business.id), name: 'Wrong target' } });
        }, { code: 'MODULE_SCOPE_MISMATCH' });
    });

    it('requires the owning peer and a byte-semantic match to the server-prepared mutation', async () => {
        const first = setupBuyer('lease-owner');
        const second = setupBuyer('lease-foreign', { workspaceId: UUID_2, reset: false });
        Twenty.enqueue(first.business.id, 'manager_task', 'manager_tasks', 'task-owned');
        const [row] = Twenty.leaseOutbox(10, 60);
        const claim = preparedClaim(first.business, first.adapter, row, {
            body: { avaBusinessId: String(first.business.id), nested: { b: 2, a: 1 } },
        });

        assert.throws(() => Access.acquireSyncLease(claim), { code: 'MODULE_PEER_DENIED' });
        assert.throws(() => Access.acquireSyncLease({ ...claim, bodyDigest: '0'.repeat(64) }, peerAuth(first.adapter)),
            { code: 'MODULE_SYNC_LEASE_DENIED' });
        assert.throws(() => Access.acquireSyncLease({ ...claim, path: '/rest/companies' }, peerAuth(first.adapter)),
            { code: 'MODULE_SYNC_LEASE_DENIED' });

        const lease = Access.acquireSyncLease(claim, peerAuth(first.adapter));
        assert.throws(() => Access.releaseSyncLease({ contractVersion: 'ava-sync-lease-v1', leaseId: lease.leaseId,
            outcome: 'completed' }, peerAuth(second.adapter)), { code: 'MODULE_PEER_DENIED' });

        const readback = Access.getSyncReadback(lease.leaseId, peerAuth(first.adapter));
        assert.strictEqual(readback.contractVersion, 'ava-sync-lease-v1');
        assert.strictEqual(readback.bodyDigest, claim.bodyDigest);
        assert.deepStrictEqual(readback.body, { avaBusinessId: String(first.business.id), nested: { a: 1, b: 2 } });
        assert.strictEqual(Object.hasOwn(readback, 'outboxLeaseToken'), false);
        assert.strictEqual(Object.hasOwn(readback, 'peerSecret'), false);
        assert.throws(() => Access.getSyncReadback(lease.leaseId, peerAuth(second.adapter)), { code: 'MODULE_SCOPE_MISMATCH' });
        Access.releaseSyncLease({ contractVersion: 'ava-sync-lease-v1', leaseId: lease.leaseId,
            outcome: 'completed' }, peerAuth(first.adapter));
    });

    it('guards against concurrent active mutation leases on the same correlationId', async () => {
        const { business, adapter } = setupBuyer('lease-concurrent');
        Twenty.enqueue(business.id, 'manager_task', 'manager_tasks', 'task-c');
        const [outboxRow] = Twenty.leaseOutbox(10, 60);

        const claim = validClaim(business, adapter, outboxRow);
        const lease1 = Access.acquireSyncLease(claim, peerAuth(adapter));
        assert.ok(lease1.leaseId);

        assert.throws(() => {
            Access.acquireSyncLease(claim, peerAuth(adapter));
        }, { code: 'MODULE_SYNC_LEASE_CONCURRENT' });

        // Release first lease, then second attempt succeeds
        Access.releaseSyncLease({
            contractVersion: 'ava-sync-lease-v1',
            leaseId: lease1.leaseId,
            outcome: 'completed',
        }, peerAuth(adapter));

        const lease2 = Access.acquireSyncLease(claim, peerAuth(adapter));
        assert.ok(lease2.leaseId);
        assert.notStrictEqual(lease1.leaseId, lease2.leaseId);
    });

    it('does not treat lease expiry as proof that an in-flight native write stopped', async () => {
        const { business, adapter } = setupBuyer('lease-expired-barrier');
        Twenty.enqueue(business.id, 'manager_task', 'manager_tasks', 'task-stale');
        const [outboxRow] = Twenty.leaseOutbox(10, 60);
        const claim = validClaim(business, adapter, outboxRow);
        const lease = Access.acquireSyncLease(claim, peerAuth(adapter));
        DB.run('UPDATE ava_sync_leases SET expiresAt=? WHERE leaseId=?', [Date.now() - 1, lease.leaseId]);

        assert.throws(() => Access.acquireSyncLease(claim, peerAuth(adapter)), { code: 'MODULE_SYNC_LEASE_CONCURRENT' });
        assert.throws(() => Access.prepareSyncMutation({ businessId: business.id, correlationId: outboxRow.eventId,
            outboxLeaseToken: outboxRow.leaseToken, integrationRevision: Twenty.getIntegrationUnsafe(business.id).revision,
            method: 'POST', objectName: 'tasks', recordId: null,
            body: { avaBusinessId: String(business.id), title: 'Replacement' } }),
        { code: 'MODULE_SYNC_LEASE_CONCURRENT' });
        Access.releaseSyncLease({ contractVersion: 'ava-sync-lease-v1', leaseId: lease.leaseId,
            outcome: 'fenced' }, peerAuth(adapter));
    });

    it('producer replaces the immutable binding for lost-response POST, exact GET, PATCH, and final readback', async () => {
        const { business } = setupBuyer('lease-producer');
        DB.run(`INSERT INTO manager_tasks(taskId,instanceId,summary,reason)
            VALUES ('task-producer',?,'Call the guest','booking_request')`, [business.id]);
        const [row] = Twenty.leaseOutbox(10, 60);
        const calls = [];
        let remote = null;
        const originalClient = TwentyService._client;
        const originalPrepare = Access.prepareSyncMutation;
        let concurrentHandoff = true;
        let prepareAttempts = 0;
        Access.prepareSyncMutation = (...args) => {
            prepareAttempts += 1;
            if (concurrentHandoff) {
                concurrentHandoff = false;
                throw Object.assign(new Error('prior response release is still committing'), {
                    code: 'MODULE_SYNC_LEASE_CONCURRENT',
                });
            }
            return originalPrepare(...args);
        };
        const assertBinding = (method, objectName, recordId, body) => {
            const binding = DB.get('SELECT * FROM ava_sync_mutations WHERE correlationId=?', [row.eventId]);
            assert.strictEqual(binding.method, method);
            assert.strictEqual(binding.objectName, objectName);
            assert.strictEqual(binding.recordId, recordId || null);
            assert.strictEqual(binding.path, method === 'POST' ? `/rest/${objectName}` : `/rest/${objectName}/${recordId}`);
            assert.strictEqual(binding.bodyDigest, body ? crypto.createHash('sha256').update(Access.canonicalSyncBody(body)).digest('hex') : null);
            calls.push([method, binding.path]);
        };
        TwentyService._client = () => ({
            createRecord: async (objectName, body) => {
                assertBinding('POST', objectName, null, body);
                remote = { ...body };
                throw Object.assign(new Error('lost response after commit'), { statusCode: 409, code: 'TWENTY_DUPLICATE_RECORD' });
            },
            getRecord: async (objectName, recordId) => {
                assertBinding('GET', objectName, recordId, null);
                return { ...remote, id: recordId };
            },
            updateRecord: async (objectName, recordId, body) => {
                assertBinding('PATCH', objectName, recordId, body);
                remote = { ...body, id: recordId };
                return remote;
            },
        });
        try {
            await TwentyService._syncOutboxRow(row);
            assert.deepStrictEqual(calls.map(item => item[0]), ['POST', 'GET', 'PATCH', 'GET']);
            assert.strictEqual(prepareAttempts, 5);
            assert.strictEqual(DB.get('SELECT status FROM twenty_sync_outbox WHERE eventId=?', [row.eventId]).status, 'DONE');
        } finally {
            TwentyService._client = originalClient;
            Access.prepareSyncMutation = originalPrepare;
        }
    });

    it('fails the outbox but retains the active barrier when a peer disconnects', async () => {
        const { business, adapter } = setupBuyer('lease-abandon');
        Twenty.enqueue(business.id, 'manager_task', 'manager_tasks', 'task-ab');
        const [outboxRow] = Twenty.leaseOutbox(10, 60);

        const claim = validClaim(business, adapter, outboxRow);
        const lease = Access.acquireSyncLease(claim, peerAuth(adapter));

        const res = Access.releaseSyncLease({
            contractVersion: 'ava-sync-lease-v1',
            leaseId: lease.leaseId,
            outcome: 'abandoned',
        }, peerAuth(adapter));
        assert.deepStrictEqual(res, { released: false, leaseId: lease.leaseId, outcome: 'abandoned', barrierActive: true });
        assert.strictEqual(Access.getSyncLease(lease.leaseId).status, 'active');
        assert.strictEqual(Access.getSyncLease(lease.leaseId).outcome, 'abandoned_pending_death');

        const updatedOutbox = DB.get('SELECT * FROM twenty_sync_outbox WHERE (eventId=? OR eventId=?)',
            [outboxRow.eventId, 'twout_' + outboxRow.eventId]);
        assert.strictEqual(updatedOutbox.status, 'FAILED');
        assert.strictEqual(updatedOutbox.lastErrorCode, 'TWENTY_SYNC_ABANDONED');

        assert.strictEqual(Twenty.retryFailed(business.id, outboxRow.eventId), true);
        const [retried] = Twenty.leaseOutbox(10, 60);
        assert.strictEqual(retried.eventId, outboxRow.eventId);
        assert.throws(() => Access.prepareSyncMutation({
            businessId: business.id,
            correlationId: retried.eventId,
            outboxLeaseToken: retried.leaseToken,
            integrationRevision: Twenty.getIntegrationUnsafe(business.id).revision,
            method: 'POST',
            objectName: 'tasks',
            recordId: null,
            body: { avaBusinessId: String(business.id), title: 'Unsafe retry' },
        }), { code: 'MODULE_SYNC_LEASE_CONCURRENT' });
    });

    it('leases one exact worker-only recovery claim and safely reclaims a lost response', async () => {
        const setup = setupBuyer('lease-recovery-claim');
        setup.adapter = managedAdapter(setup.business, setup.adapter);
        Twenty.enqueue(setup.business.id, 'manager_task', 'manager_tasks', 'task-recovery-claim');
        const [outboxRow] = Twenty.leaseOutbox(10, 60);
        const lease = Access.acquireSyncLease(validClaim(setup.business, setup.adapter, outboxRow), peerAuth(setup.adapter));
        Access.releaseSyncLease({ contractVersion: 'ava-sync-lease-v1', leaseId: lease.leaseId, outcome: 'abandoned' },
            peerAuth(setup.adapter));
        // Exercise the real retry race: recovery must revoke this new outbox
        // owner before asking the helper to stop the deployment.
        assert.strictEqual(Twenty.retryFailed(setup.business.id, outboxRow.eventId), true);
        const [retried] = Twenty.leaseOutbox(10, 60);
        assert.ok(retried.leaseToken);

        const previousRole = process.env.AVA_PROCESS_ROLE;
        delete process.env.AVA_PROCESS_ROLE;
        assert.throws(() => Access.leaseSyncRecovery(), { code: 'MODULE_WORKER_REQUIRED' });
        process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        try {
            const claim = Access.leaseSyncRecovery();
            assert.deepStrictEqual(Object.keys(claim).sort(), ['adapterRevision','businessId','contractVersion','correlationId',
                'deploymentId','deploymentRevision','integrationRevision','leaseId','leaseRevision','outboxEventId',
                'recoveryId','recoveryToken'].sort());
            assert.strictEqual(claim.contractVersion, 'ava-sync-recovery-v1');
            assert.strictEqual(claim.leaseId, lease.leaseId);
            assert.strictEqual(claim.outboxEventId, outboxRow.eventId);
            assert.strictEqual(Access.leaseSyncRecovery(), null, 'a live recovery claim is exclusive');
            const persisted = DB.get('SELECT * FROM ava_sync_lease_recoveries WHERE recoveryId=?', [claim.recoveryId]);
            assert.notStrictEqual(persisted.tokenHash, claim.recoveryToken);
            assert.strictEqual(persisted.tokenHash, crypto.createHash('sha256').update(claim.recoveryToken).digest('hex'));
            assert.strictEqual(DB.get('SELECT leaseToken FROM twenty_sync_outbox WHERE eventId=?', [outboxRow.eventId]).leaseToken, null);
            assert.strictEqual(Object.hasOwn(Access.getSyncRecovery(claim.recoveryId), 'tokenHash'), false);
            assert.throws(() => Access.finishSyncRecoveryAttempt({ ...claim, recoveryToken: crypto.randomUUID() },
                { code: 'DEPLOYMENT_HELPER_TIMEOUT', retryable: true }), { code: 'MODULE_SYNC_RECOVERY_CLAIM_LOST' });

            const failed = Access.finishSyncRecoveryAttempt(claim, { code: 'DEPLOYMENT_HELPER_TIMEOUT', retryable: true });
            assert.deepStrictEqual(failed, { recoveryId: claim.recoveryId, state: 'pending', barrierActive: true });
            DB.run('UPDATE ava_sync_lease_recoveries SET nextAttemptAt=? WHERE recoveryId=?', [Date.now() - 1, claim.recoveryId]);
            const replacement = Access.leaseSyncRecovery();
            assert.strictEqual(replacement.recoveryId, claim.recoveryId);
            assert.notStrictEqual(replacement.recoveryToken, claim.recoveryToken);
            assert.strictEqual(Access.getSyncLease(lease.leaseId).status, 'active');
        } finally {
            if (previousRole === undefined) process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
            else process.env.AVA_PROCESS_ROLE = previousRole;
        }
    });

    it('accepts exact whole-contour proof once, fences the old lease, and blocks retry pending readback', async () => {
        const setup = setupBuyer('lease-recovery-proof');
        setup.adapter = managedAdapter(setup.business, setup.adapter);
        Twenty.enqueue(setup.business.id, 'manager_task', 'manager_tasks', 'task-recovery-proof');
        const [outboxRow] = Twenty.leaseOutbox(10, 60);
        const originalClaim = validClaim(setup.business, setup.adapter, outboxRow);
        const lease = Access.acquireSyncLease(originalClaim, peerAuth(setup.adapter));
        Access.releaseSyncLease({ contractVersion: 'ava-sync-lease-v1', leaseId: lease.leaseId, outcome: 'abandoned' },
            peerAuth(setup.adapter));
        const claim = Access.leaseSyncRecovery();
        const result = Access.acceptSyncRecoveryProof(claim, recoveryProof(claim));
        assert.deepStrictEqual(result, { recovered: true, recoveryId: claim.recoveryId, leaseId: lease.leaseId,
            state: 'readback_required', retryAllowed: false });
        const storedLease = Access.getSyncLease(lease.leaseId);
        assert.strictEqual(storedLease.status, 'fenced');
        assert.strictEqual(storedLease.outcome, 'process_death_proven');
        const recovery = Access.getSyncRecovery(claim.recoveryId);
        assert.strictEqual(recovery.state, 'readback_required');
        assert.match(recovery.proofDigest, /^[0-9a-f]{64}$/);
        assert.throws(() => Access.acceptSyncRecoveryProof(claim, recoveryProof(claim)),
            { code: 'MODULE_SYNC_RECOVERY_CLAIM_LOST' });
        assert.throws(() => Access.acquireSyncLease(originalClaim, peerAuth(setup.adapter)),
            { code: 'MODULE_SYNC_RECOVERY_READBACK_REQUIRED' });

        assert.strictEqual(Twenty.retryFailed(setup.business.id, outboxRow.eventId), true);
        const [retried] = Twenty.leaseOutbox(10, 60);
        assert.throws(() => Access.prepareSyncMutation({
            businessId: setup.business.id, correlationId: retried.eventId, outboxLeaseToken: retried.leaseToken,
            integrationRevision: Twenty.getIntegrationUnsafe(setup.business.id).revision,
            method: 'POST', objectName: 'tasks', recordId: null,
            body: { avaBusinessId: String(setup.business.id), title: 'Readback must happen first' },
        }), { code: 'MODULE_SYNC_RECOVERY_READBACK_REQUIRED' });
    });

    it('serializes concurrent recovery workers around the one SQLite claim', async () => {
        const setup = setupBuyer('lease-recovery-concurrent');
        setup.adapter = managedAdapter(setup.business, setup.adapter);
        Twenty.enqueue(setup.business.id, 'manager_task', 'manager_tasks', 'task-recovery-concurrent');
        const [outboxRow] = Twenty.leaseOutbox(10, 60);
        const lease = Access.acquireSyncLease(validClaim(setup.business, setup.adapter, outboxRow), peerAuth(setup.adapter));
        Access.releaseSyncLease({ contractVersion: 'ava-sync-lease-v1', leaseId: lease.leaseId, outcome: 'abandoned' },
            peerAuth(setup.adapter));
        const previous = process.env.AVA_TWENTY_SYNC_RECOVERY_ENABLED;
        process.env.AVA_TWENTY_SYNC_RECOVERY_ENABLED = 'true';
        let releaseHelper;
        const helperGate = new Promise(resolve => { releaseHelper = resolve; });
        let helperClaim;
        try {
            const first = RecoveryWorker.processOne({ store: Access, client: { syncRecovery: async claim => {
                helperClaim = claim;
                await helperGate;
                return recoveryProof(claim);
            } } });
            await new Promise(resolve => setImmediate(resolve));
            const second = await RecoveryWorker.processOne({ store: Access,
                client: { syncRecovery: async () => { throw new Error('second helper must not run'); } } });
            assert.deepStrictEqual(second, { processed: false, reason: 'MODULE_SYNC_RECOVERY_NOT_DUE' });
            assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM ava_sync_lease_recoveries WHERE state='leased'").n, 1);
            releaseHelper();
            const completed = await first;
            assert.strictEqual(completed.result.recoveryId, helperClaim.recoveryId);
            assert.strictEqual(completed.result.state, 'readback_required');
        } finally {
            releaseHelper?.();
            if (previous === undefined) delete process.env.AVA_TWENTY_SYNC_RECOVERY_ENABLED;
            else process.env.AVA_TWENTY_SYNC_RECOVERY_ENABLED = previous;
        }
    });

    it('bounds repeated lost worker claims without ever expiring the sync barrier', async () => {
        const setup = setupBuyer('lease-recovery-exhausted');
        setup.adapter = managedAdapter(setup.business, setup.adapter);
        Twenty.enqueue(setup.business.id, 'manager_task', 'manager_tasks', 'task-recovery-exhausted');
        const [outboxRow] = Twenty.leaseOutbox(10, 60);
        const lease = Access.acquireSyncLease(validClaim(setup.business, setup.adapter, outboxRow), peerAuth(setup.adapter));
        Access.releaseSyncLease({ contractVersion: 'ava-sync-lease-v1', leaseId: lease.leaseId, outcome: 'abandoned' },
            peerAuth(setup.adapter));
        let claim = Access.leaseSyncRecovery();
        for (let attempt = 2; attempt <= 8; attempt += 1) {
            DB.run('UPDATE ava_sync_lease_recoveries SET leasedUntil=? WHERE recoveryId=?', [Date.now() - 1, claim.recoveryId]);
            claim = Access.leaseSyncRecovery();
            assert.ok(claim, `attempt ${attempt} should receive the bounded replacement claim`);
        }
        DB.run('UPDATE ava_sync_lease_recoveries SET leasedUntil=? WHERE recoveryId=?', [Date.now() - 1, claim.recoveryId]);
        assert.strictEqual(Access.leaseSyncRecovery(), null);
        const recovery = Access.getSyncRecovery(claim.recoveryId);
        assert.strictEqual(recovery.attempts, 8);
        assert.strictEqual(recovery.state, 'blocked');
        assert.strictEqual(recovery.lastErrorCode, 'MODULE_SYNC_RECOVERY_ATTEMPTS_EXHAUSTED');
        assert.strictEqual(Access.getSyncLease(lease.leaseId).status, 'active');
    });

    it('persists an invalid oldest deployment as blocked and continues to the next tenant', async () => {
        const first = setupBuyer('lease-recovery-starved');
        first.adapter = managedAdapter(first.business, first.adapter);
        Twenty.enqueue(first.business.id, 'manager_task', 'manager_tasks', 'task-recovery-starved');
        let [row] = Twenty.leaseOutbox(10, 60);
        const firstLease = Access.acquireSyncLease(validClaim(first.business, first.adapter, row), peerAuth(first.adapter));
        Access.releaseSyncLease({ contractVersion: 'ava-sync-lease-v1', leaseId: firstLease.leaseId, outcome: 'abandoned' },
            peerAuth(first.adapter));
        DB.run("UPDATE ava_module_deployments SET state='disabled' WHERE id=?", [first.adapter.deploymentId]);

        const second = setupBuyer('lease-recovery-progress', { workspaceId: UUID_2, reset: false });
        second.adapter = managedAdapter(second.business, second.adapter);
        Twenty.enqueue(second.business.id, 'manager_task', 'manager_tasks', 'task-recovery-progress');
        [row] = Twenty.leaseOutbox(10, 60);
        const secondLease = Access.acquireSyncLease(validClaim(second.business, second.adapter, row), peerAuth(second.adapter));
        Access.releaseSyncLease({ contractVersion: 'ava-sync-lease-v1', leaseId: secondLease.leaseId, outcome: 'abandoned' },
            peerAuth(second.adapter));

        const claim = Access.leaseSyncRecovery();
        assert.strictEqual(claim.leaseId, secondLease.leaseId);
        const blocked = DB.get('SELECT * FROM ava_sync_lease_recoveries WHERE leaseId=?', [firstLease.leaseId]);
        assert.strictEqual(blocked.state, 'blocked');
        assert.strictEqual(blocked.lastErrorCode, 'MODULE_SYNC_RECOVERY_DEPLOYMENT_NOT_VERIFIED');
        assert.strictEqual(Access.getSyncLease(firstLease.leaseId).status, 'active');
    });

    it('keeps the barrier active and durably blocks malformed proof or a disabled adapter', async () => {
        const setup = setupBuyer('lease-recovery-blocked');
        setup.adapter = managedAdapter(setup.business, setup.adapter);
        Twenty.enqueue(setup.business.id, 'manager_task', 'manager_tasks', 'task-recovery-blocked');
        const [outboxRow] = Twenty.leaseOutbox(10, 60);
        const lease = Access.acquireSyncLease(validClaim(setup.business, setup.adapter, outboxRow), peerAuth(setup.adapter));
        Access.releaseSyncLease({ contractVersion: 'ava-sync-lease-v1', leaseId: lease.leaseId, outcome: 'abandoned' },
            peerAuth(setup.adapter));
        const claim = Access.leaseSyncRecovery();
        const bad = recoveryProof(claim);
        bad.stoppedContainerIds = [CONTAINER_DB];
        assert.throws(() => Access.acceptSyncRecoveryProof(claim, bad), { code: 'MODULE_SYNC_RECOVERY_PROOF_INVALID' });
        const blocked = Access.finishSyncRecoveryAttempt(claim,
            { code: 'MODULE_SYNC_RECOVERY_PROOF_INVALID', retryable: false });
        assert.strictEqual(blocked.state, 'blocked');
        assert.strictEqual(Access.getSyncLease(lease.leaseId).status, 'active');
        assert.strictEqual(Access.leaseSyncRecovery(), null);

        const second = setupBuyer('lease-recovery-disabled', { reset: true });
        second.adapter = managedAdapter(second.business, second.adapter);
        Twenty.enqueue(second.business.id, 'manager_task', 'manager_tasks', 'task-recovery-disabled');
        const [secondOutbox] = Twenty.leaseOutbox(10, 60);
        const secondLease = Access.acquireSyncLease(validClaim(second.business, second.adapter, secondOutbox), peerAuth(second.adapter));
        Access.releaseSyncLease({ contractVersion: 'ava-sync-lease-v1', leaseId: secondLease.leaseId, outcome: 'abandoned' },
            peerAuth(second.adapter));
        Access.disable(second.adapter.id);
        assert.strictEqual(Access.leaseSyncRecovery(), null);
        const disabled = DB.get('SELECT * FROM ava_sync_lease_recoveries WHERE leaseId=?', [secondLease.leaseId]);
        assert.strictEqual(disabled.state, 'blocked');
        assert.strictEqual(disabled.lastErrorCode, 'MODULE_SYNC_RECOVERY_ADAPTER_DISABLED');
        assert.strictEqual(Access.getSyncLease(secondLease.leaseId).status, 'active');
    });

    it('closes issuance on disable but retains the live barrier until the old peer reports fencing', async () => {
        const { business, adapter } = setupBuyer('lease-disable');
        Twenty.enqueue(business.id, 'manager_task', 'manager_tasks', 'task-dis');
        const [outboxRow] = Twenty.leaseOutbox(10, 60);

        const claim = validClaim(business, adapter, outboxRow);
        const lease = Access.acquireSyncLease(claim, peerAuth(adapter));

        Access.disable(adapter.id);

        const storedLease = Access.getSyncLease(lease.leaseId);
        assert.strictEqual(storedLease.status, 'active');
        assert.strictEqual(storedLease.outcome, 'disable_pending');
        assert.throws(() => Access.acquireSyncLease(claim, peerAuth(adapter)), { code: 'MODULE_ADAPTER_UNAVAILABLE' });
        assert.throws(() => Access.prepareSyncMutation({
            businessId: business.id,
            correlationId: outboxRow.eventId,
            outboxLeaseToken: outboxRow.leaseToken,
            integrationRevision: Twenty.getIntegrationUnsafe(business.id).revision,
            method: 'POST',
            objectName: 'tasks',
            recordId: null,
            body: { avaBusinessId: String(business.id), title: 'Must stay fenced' },
        }), { code: 'MODULE_ADAPTER_UNAVAILABLE' });

        let updatedOutbox = DB.get('SELECT * FROM twenty_sync_outbox WHERE (eventId=? OR eventId=?)',
            [outboxRow.eventId, 'twout_' + outboxRow.eventId]);
        assert.strictEqual(updatedOutbox.status, 'LEASED');

        Access.releaseSyncLease({ contractVersion: 'ava-sync-lease-v1', leaseId: lease.leaseId, outcome: 'fenced' }, peerAuth(adapter));
        assert.strictEqual(Access.getSyncLease(lease.leaseId).status, 'fenced');
        updatedOutbox = DB.get('SELECT * FROM twenty_sync_outbox WHERE (eventId=? OR eventId=?)',
            [outboxRow.eventId, 'twout_' + outboxRow.eventId]);
        assert.strictEqual(updatedOutbox.status, 'FAILED');
        assert.strictEqual(updatedOutbox.lastErrorCode, 'TWENTY_SYNC_FENCED');
    });

    it('supports acquire and release over broker HTTP server with peer authentication', async () => {
        const { business, adapter } = setupBuyer('lease-http');
        Twenty.enqueue(business.id, 'manager_task', 'manager_tasks', 'task-http');
        const [outboxRow] = Twenty.leaseOutbox(10, 60);

        const server = createServer();
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;

        try {
            const claim = validClaim(business, adapter, outboxRow);

            const httpCall = (path, body, headers = {}) => new Promise((resolve, reject) => {
                const data = JSON.stringify(body);
                const req = http.request({
                    host: '127.0.0.1',
                    port,
                    path,
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'content-length': Buffer.byteLength(data),
                        'x-ava-adapter-id': adapter.id,
                        'authorization': `Bearer ${adapter.peerSecret}`,
                        ...headers,
                    },
                }, res => {
                    let text = '';
                    res.on('data', c => text += c);
                    res.on('end', () => {
                        let json = null;
                        try { json = JSON.parse(text); } catch (_) {}
                        resolve({ status: res.statusCode, json });
                    });
                });
                req.on('error', reject);
                req.end(data);
            });

            // Browser requests forbidden
            const browserAttempt = await httpCall('/v1/sync-lease/acquire', claim, {
                origin: 'https://evil.invalid',
            });
            assert.strictEqual(browserAttempt.status, 403);
            assert.strictEqual(browserAttempt.json?.error_code, 'MODULE_PEER_DENIED');

            // Recovery is deliberately absent from the native peer broker. It
            // exists only on the root helper Unix socket used by the worker.
            const recoveryAttempt = await httpCall('/v1/sync-recovery', { contractVersion: 'ava-sync-recovery-v1' });
            assert.strictEqual(recoveryAttempt.status, 404);
            assert.strictEqual(recoveryAttempt.json?.error_code, 'MODULE_ROUTE_NOT_FOUND');

            // Peer authenticated acquire
            const acquireRes = await httpCall('/v1/sync-lease/acquire', claim);
            assert.strictEqual(acquireRes.status, 200);
            assert.strictEqual(acquireRes.json.authorized, true);
            assert.strictEqual(acquireRes.json.contractVersion, 'ava-sync-lease-v1');
            assert.ok(acquireRes.json.leaseId);

            const readbackRes = await httpCall('/v1/sync-readback', {
                contractVersion: 'ava-sync-lease-v1',
                leaseId: acquireRes.json.leaseId,
            });
            assert.strictEqual(readbackRes.status, 200);
            assert.strictEqual(readbackRes.json.bodyDigest, claim.bodyDigest);
            assert.deepStrictEqual(readbackRes.json.body, { avaBusinessId: String(business.id), name: 'Test Task' });

            const ambiguousRelease = await httpCall('/v1/sync-lease/release', {
                contractVersion: 'ava-sync-lease-v1', leaseId: acquireRes.json.leaseId,
                outcome: 'completed', ignored: true,
            });
            assert.strictEqual(ambiguousRelease.status, 400);
            assert.strictEqual(ambiguousRelease.json.error_code, 'MODULE_BODY_INVALID');

            // Peer authenticated release
            const releaseRes = await httpCall('/v1/sync-lease/release', {
                contractVersion: 'ava-sync-lease-v1',
                leaseId: acquireRes.json.leaseId,
                outcome: 'completed',
            });
            assert.strictEqual(releaseRes.status, 200);
            assert.strictEqual(releaseRes.json.released, true);
            assert.strictEqual(releaseRes.json.outcome, 'completed');
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
});
