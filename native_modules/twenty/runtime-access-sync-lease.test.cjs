'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { REQUIRED_OBJECTS } = require('./crm-bootstrap.cjs');
const {
  CONTRACT,
  createRuntimeAccess,
  createBrokerServiceAuthorization,
  createLocalServiceAuthorization,
} = require('./runtime-access.cjs');

const DB = require('../../whatsapp_crm/src/services/database.service');
const Identity = require('../../whatsapp_crm/src/services/identity/identity-store');
const Provisioning = require('../../whatsapp_crm/src/services/provisioning/business-provisioning-store.service');
const Twenty = require('../../whatsapp_crm/src/services/twenty/twenty-store.service');
const Access = require('../../whatsapp_crm/src/services/identity/module-access-store');
const { createServer } = require('../../whatsapp_crm/src/services/identity/module-access-broker');
const { createTestDB } = require('../../whatsapp_crm/tests/test-helper');

const D = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const R = '33333333-3333-4333-8333-333333333333';
const K = '44444444-4444-4444-8444-444444444444';
const A = '55555555-5555-4555-8555-555555555555';

function setupEnvironment() {
  createTestDB();
  process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
  process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';

  const admin = { userId: 'admin-sync', platformRole: 'platform_admin' };
  const invitation = Identity.createInvitation(admin, { email: 'sync-qa@example.test' });
  const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), 'subject-sync-qa');
  const business = Provisioning.createBusinessAtomic({ name: 'sync-hotel' }, { ownerUserId: user.userId }).instance;

  Twenty.upsertIntegration(business.id, {
    baseUrl: 'https://sync-hotel.crm.meludtech.tech',
    workspaceId: W,
    enabled: true,
    mode: 'live',
  });

  const adapter = Access.configure({
    businessId: business.id,
    module: 'twenty',
    publicOrigin: 'https://sync-hotel.crm.meludtech.tech',
  });

  return { business, user, adapter };
}

function nativeDeps(context, serviceAuth, now = Date.now()) {
  const objects = REQUIRED_OBJECTS.map((name, i) => ({ id: `object-${i}`, nameSingular: name }));
  const role = {
    id: R,
    label: `AVA native runtime ${context.deploymentId}`,
    applicationId: A,
    canUpdateAllSettings: false,
    canAccessAllTools: false,
    canReadAllObjectRecords: false,
    canUpdateAllObjectRecords: false,
    canSoftDeleteAllObjectRecords: false,
    canDestroyAllObjectRecords: false,
    canBeAssignedToUsers: false,
    canBeAssignedToAgents: false,
    canBeAssignedToApiKeys: true,
    rolePermissionFlags: [],
    fieldPermissions: [],
    objectPermissions: objects.map(o => ({
      objectMetadataId: o.id,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    })),
  };

  const row = {
    deploymentId: context.deploymentId,
    workspaceId: context.nativeScope,
    revision: context.revision,
    disabled: false,
    roleId: R,
    activeKeyId: K,
    activeGeneration: 1,
    activeExpiresAt: new Date(now + 86400000),
  };

  return {
    now: () => now,
    ownerFlatApplication: { id: A },
    ledger: { current: async () => ({ ...row }) },
    jwtWrapperService: { verifyJwtToken: async () => ({ type: 'API_KEY', jti: K, sub: context.nativeScope, workspaceId: context.nativeScope }) },
    apiKeyService: { validateApiKey: async () => ({ id: K, workspaceId: context.nativeScope, expiresAt: row.activeExpiresAt, revokedAt: null }) },
    apiKeyRoleService: { getRoleIdForApiKeyId: async () => R },
    roleService: { getRoleById: async () => role },
    flatCache: {
      getOrRecomputeManyOrAllFlatEntityMaps: async () => ({
        flatObjectMetadataMaps: { byUniversalIdentifier: Object.fromEntries(objects.map(v => [v.nameSingular, v])) },
      }),
    },
    serviceAuthorization: serviceAuth,
  };
}

function prepare(business, adapter, row, { method = 'POST', objectName, recordId = null, body = null }) {
  return Access.prepareSyncMutation({
    businessId: business.id,
    correlationId: row.eventId,
    outboxLeaseToken: row.leaseToken,
    integrationRevision: Twenty.getIntegrationUnsafe(business.id).revision,
    method,
    objectName,
    recordId,
    body,
  });
}

test('createLocalServiceAuthorization validates contract and delegates to store', async () => {
  assert.throws(() => createLocalServiceAuthorization({}), { code: 'AVA_RUNTIME_ACCESS_BROKER_CONTRACT_MISSING' });
  assert.throws(() => createLocalServiceAuthorization(Access), { code: 'AVA_RUNTIME_ACCESS_SCOPE_INVALID' });
  const auth = createLocalServiceAuthorization(Access, { adapterId: D, peerSecret: 'x'.repeat(43) });
  assert.equal(auth.contractVersion, CONTRACT);
  assert.equal(typeof auth.acquire, 'function');
  assert.equal(typeof auth.release, 'function');
  assert.equal(typeof auth.readback, 'function');
});

test('createRuntimeAccess with createLocalServiceAuthorization authorizes and completes on finish', async () => {
  const { business, adapter } = setupEnvironment();
  Twenty.enqueue(business.id, 'call', 'conversation_events', 'call-1');
  const [outboxRow] = Twenty.leaseOutbox(10, 60);
  assert.ok(outboxRow);

  const context = {
    deploymentId: adapter.id,
    nativeScope: W,
    businessId: business.id,
    revision: adapter.revision,
  };

  const localAuth = createLocalServiceAuthorization(Access, { adapterId: adapter.id, peerSecret: adapter.peerSecret });
  const deps = nativeDeps(context, localAuth);
  const runtime = createRuntimeAccess(context, deps);

  const req = {
    method: 'POST',
    url: '/rest/avaCalls',
    headers: {
      authorization: 'Bearer native.signed.key',
      'content-type': 'application/json',
      'x-correlation-id': outboxRow.eventId,
    },
    body: { avaBusinessId: String(business.id), avaCallDuration: 120 },
  };
  prepare(business, adapter, outboxRow, { method: 'POST', objectName: 'avaCalls', body: req.body });

  const grant = await runtime.authorize(req);
  assert.equal(grant.lease.authorized, true);
  assert.equal(grant.lease.contractVersion, CONTRACT);
  assert.equal(grant.lease.objectName, 'avaCalls');
  assert.equal(grant.lease.correlationId, outboxRow.eventId);

  const stored = Access.getSyncLease(grant.lease.leaseId);
  assert.equal(stored.status, 'active');
  const readback = await localAuth.readback(grant.lease.leaseId);
  assert.equal(readback.bodyDigest, grant.claim.bodyDigest);

  await grant.release('completed');
  const finished = Access.getSyncLease(grant.lease.leaseId);
  assert.equal(finished.status, 'completed');
});

test('response close keeps the lease barrier while a delayed native handler can still write', async () => {
  const { business, adapter } = setupEnvironment();
  Twenty.enqueue(business.id, 'call', 'conversation_events', 'call-2');
  const [outboxRow] = Twenty.leaseOutbox(10, 60);

  const context = {
    deploymentId: adapter.id,
    nativeScope: W,
    businessId: business.id,
    revision: adapter.revision,
  };

  const localAuth = createLocalServiceAuthorization(Access, { adapterId: adapter.id, peerSecret: adapter.peerSecret });
  const deps = nativeDeps(context, localAuth);
  const guard = createRuntimeAccess(context, deps).middleware();

  const req = {
    method: 'POST',
    url: '/rest/avaCalls',
    headers: {
      authorization: 'Bearer native.signed.key',
      'content-type': 'application/json',
      'x-correlation-id': outboxRow.eventId,
    },
    body: { avaBusinessId: String(business.id), callStatus: 'in_progress' },
  };
  prepare(business, adapter, outboxRow, { method: 'POST', objectName: 'avaCalls', body: req.body });

  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableFinished = false;
  res.status = function () { return this; };
  res.set = function () { return this; };
  res.json = function () { return this; };

  let handlerStarted = false;
  let handlerFinished = false;
  let finishHandler;
  const handlerDone = new Promise(resolve => { finishHandler = resolve; });
  await guard(req, res, () => {
    handlerStarted = true;
    setTimeout(() => {
      // Models a native DB handler that continues after its client socket is
      // gone. A close event is therefore not transaction-death proof.
      handlerFinished = true;
      finishHandler();
    }, 25);
  });
  assert.equal(handlerStarted, true);

  // Client aborts / socket closes before finishing
  res.emit('close');
  await new Promise(resolve => setImmediate(resolve));

  const outbox = DB.get('SELECT * FROM twenty_sync_outbox WHERE eventId=?', [outboxRow.eventId]);
  assert.equal(outbox.status, 'FAILED');
  assert.equal(outbox.lastErrorCode, 'TWENTY_SYNC_ABANDONED');
  const lease = DB.get('SELECT * FROM ava_sync_leases WHERE correlationId=?', [outboxRow.eventId]);
  assert.equal(lease.status, 'active');
  assert.equal(lease.outcome, 'abandoned_pending_death');
  assert.equal(handlerFinished, false);

  assert.equal(Twenty.retryFailed(business.id, outboxRow.eventId), true);
  const [retried] = Twenty.leaseOutbox(10, 60);
  assert.equal(retried.eventId, outboxRow.eventId);
  assert.throws(() => prepare(business, adapter, retried, {
    method: 'POST', objectName: 'avaCalls', body: req.body,
  }), { code: 'MODULE_SYNC_LEASE_CONCURRENT' });

  await handlerDone;
  assert.equal(handlerFinished, true);
  assert.equal(Access.getSyncLease(lease.leaseId).status, 'active');
});

test('createBrokerServiceAuthorization connects over HTTP and operates end-to-end', async () => {
  const { business, adapter } = setupEnvironment();
  Twenty.enqueue(business.id, 'manager_task', 'manager_tasks', 'task-broker');
  const [outboxRow] = Twenty.leaseOutbox(10, 60);

  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  try {
    const brokerAuth = createBrokerServiceAuthorization({
      origin,
      adapterId: adapter.id,
      peerSecret: adapter.peerSecret,
    });
    assert.equal(brokerAuth.contractVersion, CONTRACT);

    const context = {
      deploymentId: adapter.id,
      nativeScope: W,
      businessId: business.id,
      revision: adapter.revision,
    };

    const deps = nativeDeps(context, brokerAuth);
    const runtime = createRuntimeAccess(context, deps);

    const req = {
      method: 'POST',
      url: '/rest/tasks',
      headers: {
        authorization: 'Bearer native.signed.key',
        'content-type': 'application/json',
        'x-correlation-id': outboxRow.eventId,
      },
      body: { avaBusinessId: String(business.id), title: 'Broker Task' },
    };
    prepare(business, adapter, outboxRow, { method: 'POST', objectName: 'tasks', body: req.body });

    const grant = await runtime.authorize(req);
    assert.equal(grant.lease.authorized, true);
    assert.equal(grant.lease.contractVersion, CONTRACT);
    assert.equal(grant.lease.objectName, 'tasks');
    assert.equal(grant.lease.correlationId, outboxRow.eventId);
    const readback = await brokerAuth.readback(grant.lease.leaseId);
    assert.equal(readback.bodyDigest, grant.claim.bodyDigest);

    await grant.release('completed');
    const stored = Access.getSyncLease(grant.lease.leaseId);
    assert.equal(stored.status, 'completed');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
