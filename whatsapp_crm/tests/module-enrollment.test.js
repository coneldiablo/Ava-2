'use strict';
const { describe, it: register, assert, createTestDB, runAll } = require('./test-helper');
const DB = require('../src/services/database.service');
const Access = require('../src/services/identity/module-access-store');
const Identity = require('../src/services/identity/identity-store');
const crypto = require('crypto');
const uuid = () => crypto.randomUUID();
const hash = () => 'a'.repeat(64);

function it(name, fn) {
  register(name, async () => { const previous = process.env.AVA_PROCESS_ROLE; createTestDB(); process.env.AVA_PROCESS_ROLE = 'provisioning-worker'; try { await fn(); } finally { if (previous === undefined) delete process.env.AVA_PROCESS_ROLE; else process.env.AVA_PROCESS_ROLE = previous; } });
}
function setup(module = 'twenty') {
  const businessId = DB.run('INSERT INTO instances(name,isActive) VALUES (?,1)', ['Enrollment hotel']).lastInsertRowid;
  const deploymentId = uuid(), leaseToken = uuid(), nativeScope = module === 'twenty' ? uuid() : 'ava_' + deploymentId.replaceAll('-', '');
  const hostname = `north-${businessId}.${module === 'twenty' ? 'crm' : 'knowledge'}.meludtech.tech`;
  const sourceCommit = module === 'twenty' ? '6da524b8903ec16a3eeea4b2e4a5fb63dbfc1c58' : 'a1b9e02eb65cc114c65381cbef5e555e1753ed0a';
  DB.run(`INSERT INTO ava_module_deployments(id,businessId,module,hostname,namespace,state,revision,sourceCommit,leaseToken,leasedUntil,correlationId,createdAt,updatedAt)
    VALUES (?,?,?,?,?,'provisioning',1,?,?,?, ?,?,?)`, [deploymentId,businessId,module,hostname,'ava_'+deploymentId.replaceAll('-',''),sourceCommit,leaseToken,Date.now()+60000,uuid(),Date.now(),Date.now()]);
  if (module === 'twenty') DB.run(`INSERT INTO twenty_workspace_links(id,businessId,workspaceId,baseUrl,apiKeyEncrypted,enabled,revision) VALUES (?,?,?,?,?,1,1)`, [uuid(),businessId,nativeScope,'https://twenty.example','x']);
  else DB.run("INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,status) VALUES (?,?,?,'STAGING')", [businessId,nativeScope,'https://' + hostname]);
  return { businessId, deploymentId, leaseToken, nativeScope, hostname, module, sourceCommit };
}
function receipt(s, override = {}) { return { deploymentId:s.deploymentId,businessId:s.businessId,module:s.module,revision:1,hostname:s.hostname,namespace:'ava_'+s.deploymentId.replaceAll('-',''),sourceCommit:s.sourceCommit,adapterId:s.deploymentId,nativeScope:s.nativeScope,peerSecretHash:hash(),...override }; }
const wire = s => ({ deploymentId: s.deploymentId, businessId: s.businessId, revision: 1, leaseToken: s.leaseToken });
const activation = s => ({ deploymentId: s.deploymentId, businessId: s.businessId, expectedRevision: 1 });
function buyer(s) {
  const invitation = Identity.createInvitation({ userId: 'test-operator', platformRole: 'platform_admin' },
    { email: `${s.businessId}@example.test`, businessId: s.businessId, role: 'hotel_owner' });
  const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), `subject-${s.businessId}`);
  return { user, sessionToken: Identity.createSession(user.subject, uuid()) };
}

describe('module enrollment worker boundary', () => {
  it('denies non-worker callers and malformed receipt extras/raw secrets', () => { const s=setup(), wire={deploymentId:s.deploymentId,businessId:s.businessId,revision:1,leaseToken:s.leaseToken}, r=receipt(s); const old=process.env.AVA_PROCESS_ROLE; delete process.env.AVA_PROCESS_ROLE; assert.throws(()=>Access.prepareDeployment(wire,r),{code:'MODULE_WORKER_REQUIRED'}); process.env.AVA_PROCESS_ROLE=old; assert.throws(()=>Access.prepareDeployment(wire,{...r,extra:'x'}),{code:'MODULE_ENROLLMENT_INVALID'}); assert.throws(()=>Access.prepareDeployment(wire,{...r,peerSecretHash:'raw-secret'}),{code:'MODULE_ENROLLMENT_INVALID'}); });
  it('prepares hash-only enrollment and idempotently replays without adapter or grant', () => { const s=setup(), wire={deploymentId:s.deploymentId,businessId:s.businessId,revision:1,leaseToken:s.leaseToken}; const a=Access.prepareDeployment(wire,receipt(s)), b=Access.prepareDeployment(wire,receipt(s)); assert.deepStrictEqual(a,b); assert.strictEqual(DB.get('SELECT peerSecretHash FROM ava_module_enrollments').peerSecretHash,hash()); assert.strictEqual(DB.get('SELECT count(*) n FROM ava_module_adapters').n,0); });
  it('fails closed for changed receipt, wrong scope, and lost lease', () => { const s=setup(), wire={deploymentId:s.deploymentId,businessId:s.businessId,revision:1,leaseToken:s.leaseToken}; Access.prepareDeployment(wire,receipt(s)); assert.throws(()=>Access.prepareDeployment(wire,receipt(s,{peerSecretHash:'b'.repeat(64)})),{code:'MODULE_ENROLLMENT_CHANGED'}); assert.throws(()=>Access.prepareDeployment(wire,receipt(s,{nativeScope:uuid()})),{code:'MODULE_ENROLLMENT_CHANGED'}); DB.run('UPDATE ava_module_deployments SET leasedUntil=?',[Date.now()-1]); assert.throws(()=>Access.prepareDeployment(wire,receipt(s)),{code:'MODULE_ENROLLMENT_LEASE_LOST'}); });
  it('activation requires verified deployment and exact live integration scope', () => { const s=setup(), wire={deploymentId:s.deploymentId,businessId:s.businessId,revision:1,leaseToken:s.leaseToken}; Access.prepareDeployment(wire,receipt(s)); assert.throws(()=>Access.activateDeployment({deploymentId:s.deploymentId,businessId:s.businessId,expectedRevision:1}),{code:'MODULE_DEPLOYMENT_NOT_VERIFIED'}); DB.run("UPDATE ava_module_deployments SET state='verified'"); const out=Access.activateDeployment({deploymentId:s.deploymentId,businessId:s.businessId,expectedRevision:1}); assert.deepStrictEqual(out,{id:s.deploymentId,revision:1,businessId:s.businessId,module:'twenty'}); });
  it('activation replay is stable and disabled adapter cannot be reactivated', () => { const s=setup(), wire={deploymentId:s.deploymentId,businessId:s.businessId,revision:1,leaseToken:s.leaseToken}; Access.prepareDeployment(wire,receipt(s)); DB.run("UPDATE ava_module_deployments SET state='verified'"); const input={deploymentId:s.deploymentId,businessId:s.businessId,expectedRevision:1}; const first=Access.activateDeployment(input), again=Access.activateDeployment(input); assert.deepStrictEqual(again,first); Access.disable(first.id); assert.throws(()=>Access.activateDeployment(input),{code:'MODULE_ENROLLMENT_CHANGED'}); });

  it('wrong tenant, revision, revoked business and changed lease cannot prepare', () => {
    const s = setup(), other = setup();
    for (const patch of [{ businessId: other.businessId }, { revision: 2 }, { leaseToken: uuid() }]) {
      assert.throws(() => Access.prepareDeployment({ ...wire(s), ...patch }, receipt(s)), { code: 'MODULE_ENROLLMENT_LEASE_LOST' });
    }
    DB.run('UPDATE instances SET isActive=0 WHERE id=?', [s.businessId]);
    assert.throws(() => Access.prepareDeployment(wire(s), receipt(s)), { code: 'MODULE_ENROLLMENT_LEASE_LOST' });
    assert.strictEqual(DB.get('SELECT count(*) n FROM ava_module_enrollments').n, 0);
  });

  it('prepared enrollment cannot issue a buyer grant or authorize an arbitrary handle', () => {
    const s = setup(), customer = buyer(s);
    Access.prepareDeployment(wire(s), receipt(s));
    assert.throws(() => Access.issue({ ...customer, adapterId: s.deploymentId, codeChallenge: 'c'.repeat(43) }), { code: 'MODULE_ADAPTER_UNAVAILABLE' });
    assert.throws(() => Access.authorize({ adapterId: s.deploymentId, peerSecret: 'x'.repeat(43), sessionHandle: 's'.repeat(43) }), { code: 'MODULE_ADAPTER_UNAVAILABLE' });
    assert.strictEqual(DB.get('SELECT count(*) n FROM ava_module_grants').n, 0);
    assert.strictEqual(DB.get('SELECT count(*) n FROM ava_module_sessions').n, 0);
  });

  it('activation does not adopt a missing or foreign integration', () => {
    const s = setup(); Access.prepareDeployment(wire(s), receipt(s));
    DB.run("UPDATE ava_module_deployments SET state='verified' WHERE id=?", [s.deploymentId]);
    DB.run('UPDATE twenty_workspace_links SET workspaceId=? WHERE businessId=?', [uuid(), s.businessId]);
    assert.throws(() => Access.activateDeployment(activation(s)), { code: 'MODULE_ENROLLMENT_CHANGED' });
    DB.run('DELETE FROM twenty_workspace_links WHERE businessId=?', [s.businessId]);
    assert.throws(() => Access.activateDeployment(activation(s)), { code: 'MODULE_INTEGRATION_UNAVAILABLE' });
    assert.strictEqual(DB.get('SELECT count(*) n FROM ava_module_adapters').n, 0);
  });

  it('activation replay preserves verified principal and fails after integration rotation', async () => {
    const s = setup(), customer = buyer(s); Access.prepareDeployment(wire(s), receipt(s));
    DB.run("UPDATE ava_module_deployments SET state='verified' WHERE id=?", [s.deploymentId]);
    Access.activateDeployment(activation(s));
    // Native contract fixture only. Real native evidence is recorded separately.
    await Access.verifyPrincipal({ adapterId: s.deploymentId, userId: customer.user.userId, nativeUserId: uuid(),
      readback: async input => ({ ...input, ownAccess: true, foreignAccessDenied: true, platformAdminDenied: true, sessionGuardVerified: true }) });
    const principal = DB.get('SELECT * FROM ava_module_principals WHERE adapterId=?', [s.deploymentId]);
    Access.activateDeployment(activation(s));
    assert.deepStrictEqual(DB.get('SELECT * FROM ava_module_principals WHERE adapterId=?', [s.deploymentId]), principal);
    DB.run('UPDATE twenty_workspace_links SET revision=revision+1 WHERE businessId=?', [s.businessId]);
    assert.throws(() => Access.activateDeployment(activation(s)), { code: 'MODULE_ENROLLMENT_CHANGED' });
    assert.strictEqual(DB.get('SELECT revision FROM ava_module_adapters WHERE id=?', [s.deploymentId]).revision, 1);
  });

  it('existing legacy adapter is preserved, never implicitly migrated into a new deployment', () => {
    const s = setup(); Access.prepareDeployment(wire(s), receipt(s));
    DB.run("UPDATE ava_module_deployments SET state='verified' WHERE id=?", [s.deploymentId]);
    const previous = Access.configure({ businessId: s.businessId, module: s.module, publicOrigin: 'https://' + s.hostname });
    assert.throws(() => Access.activateDeployment(activation(s)), { code: 'MODULE_EXISTING_ADAPTER_MIGRATION_REQUIRED' });
    assert.strictEqual(DB.get('SELECT id FROM ava_module_adapters WHERE businessId=?', [s.businessId]).id, previous.id);
  });

  it('Onyx uses its exact namespace while live tools remain separately STAGING', () => {
    const s = setup('onyx');
    assert.throws(() => Access.prepareDeployment(wire(s), receipt(s, { nativeScope: uuid() })), { code: 'MODULE_ENROLLMENT_INVALID' });
    Access.prepareDeployment(wire(s), receipt(s));
    DB.run("UPDATE ava_module_deployments SET state='verified' WHERE id=?", [s.deploymentId]);
    assert.strictEqual(Access.activateDeployment(activation(s)).module, 'onyx');
    assert.strictEqual(DB.get('SELECT status FROM onyx_tenant_links WHERE business_id=?', [s.businessId]).status, 'STAGING');
  });
});

if (require.main === module) runAll().then(ok => { if (!ok) process.exitCode = 1; });
