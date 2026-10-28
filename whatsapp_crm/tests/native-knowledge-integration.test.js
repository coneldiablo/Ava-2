'use strict';
const crypto = require('node:crypto');
const { describe, it: register, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Access = require('../src/services/identity/module-access-store');
const { prepareIntegration } = require('../../scripts/prepare-onyx-native-integration.cjs');
const { validateReadback } = require('../../scripts/admit-onyx-native-knowledge.cjs');
function it(name, fn) {
    register(name, async () => {
        const old = process.env.AVA_PROCESS_ROLE;
        createTestDB(); process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        try { await fn(); } finally { old === undefined ? delete process.env.AVA_PROCESS_ROLE : process.env.AVA_PROCESS_ROLE = old; }
    });
}
function fixture() {
    const businessId = DB.run("INSERT INTO instances(name,isActive) VALUES('SYNTHETIC native',1)").lastInsertRowid;
    const deploymentId = crypto.randomUUID(), ownerUserId = crypto.randomUUID(), namespace = `ava_${deploymentId.replaceAll('-', '')}`;
    assert.throws(() => Access.getCurrentAdapter(crypto.randomUUID()), { code: 'MODULE_ADAPTER_UNAVAILABLE' });
    DB.run(`INSERT INTO ava_users(id,subject,email) VALUES(?,?,'synthetic@example.test')`, [ownerUserId, `synthetic-${ownerUserId}`]);
    DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [ownerUserId,businessId,'hotel_owner']);
    DB.run(`INSERT INTO ava_module_deployments(id,businessId,module,hostname,namespace,state,revision,correlationId,createdAt,updatedAt)
        VALUES(?,?,'onyx',?,?,'verified',1,?,?,?)`, [deploymentId,businessId,`native-${businessId}.knowledge.meludtech.tech`,namespace,crypto.randomUUID(),Date.now(),Date.now()]);
    DB.run(`INSERT INTO ava_module_enrollments(deploymentId,businessId,module,deploymentRevision,publicOrigin,nativeScope,peerSecretHash,state,createdAt)
        VALUES(?,?,'onyx',1,?,?,?,'prepared',?)`, [deploymentId,businessId,`https://native-${businessId}.knowledge.meludtech.tech`,namespace,'a'.repeat(64),Date.now()]);
    return { db: DB.db, access: Access, businessId, deploymentId, revision: 1, ownerUserId, dryRun: false };
}
describe('generic native knowledge integration (synthetic SQLite fixtures)', () => {
    it('plans without anchor mutation then atomically activates one own isolated adapter with prepared peer hash', () => {
        const input = fixture();
        assert.strictEqual(prepareIntegration({ ...input,dryRun:true }).anchorRequired,true);
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM onyx_tenant_links').n,0);
        const first = prepareIntegration(input), repeated = prepareIntegration(input);
        assert.deepStrictEqual(repeated,first); assert.strictEqual(first.adapterId,input.deploymentId);
        const row = DB.get('SELECT * FROM ava_module_adapters WHERE id=?',[input.deploymentId]);
        assert.strictEqual(row.attachmentModeV2,'isolated_workspace_ui'); assert.strictEqual(row.peerSecretHash,'a'.repeat(64));
        assert.strictEqual(DB.get('SELECT status FROM onyx_tenant_links WHERE business_id=?',[input.businessId]).status,'STAGING');
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM onyx_agent_bindings').n,0);
    });
    it('refuses existing legacy links, a changed owner, foreign enrollment and stale deployment without creating anchors', () => {
        for (const mutate of [
            value => DB.run("INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,status) VALUES(?,'hotel_legacy','https://legacy.test','STAGING')",[value.businessId]),
            value => DB.run('UPDATE ava_users SET enabled=0 WHERE id=?',[value.ownerUserId]),
            () => DB.run("UPDATE ava_module_enrollments SET nativeScope='foreign'"),
            () => DB.run('UPDATE ava_module_deployments SET revision=2'),
        ]) {
            createTestDB(); const input = fixture(); mutate(input);
            const before = DB.all('SELECT * FROM onyx_tenant_links');
            assert.throws(() => prepareIntegration(input), /ONYX_NATIVE_INTEGRATION_FAILED/);
            assert.deepStrictEqual(DB.all('SELECT * FROM onyx_tenant_links'),before);
            assert.strictEqual(DB.get('SELECT count(*) AS n FROM ava_module_adapters').n,0);
        }
    });
    it('does not migrate an existing full adapter or accept browser process activation', () => {
        const input = fixture(); prepareIntegration(input);
        DB.run("UPDATE ava_module_adapters SET attachmentMode='full',attachmentModeV2=NULL");
        assert.throws(() => prepareIntegration(input), { code: 'MODULE_EXISTING_ADAPTER_MIGRATION_REQUIRED' });
        process.env.AVA_PROCESS_ROLE = 'web';
        assert.throws(() => Access.activateDeployment({businessId:input.businessId,deploymentId:input.deploymentId,expectedRevision:1,attachmentMode:'isolated_workspace_ui'}), { code: 'MODULE_WORKER_REQUIRED' });
    });
    it('preserves default full mode and rejects arbitrary attachment modes', () => {
        const input = fixture();
        DB.run(`INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,status) VALUES(?,?,?,'STAGING')`,
            [input.businessId,`ava_${input.deploymentId.replaceAll('-', '')}`,`https://native-${input.businessId}.knowledge.meludtech.tech/api`]);
        const call = {businessId:input.businessId,deploymentId:input.deploymentId,expectedRevision:1};
        assert.throws(() => Access.activateDeployment({...call,attachmentMode:'full'}),{code:'MODULE_ENROLLMENT_INVALID'});
        Access.activateDeployment(call);
        assert.strictEqual(DB.get('SELECT attachmentMode FROM ava_module_adapters').attachmentMode,'full');
    });
    it('readback admission requires every initial revision, source hash, own principal and fresh successful cleanup', () => {
        const request = {adapterId:crypto.randomUUID(),adapterRevision:1,businessId:4,deploymentId:crypto.randomUUID(),deploymentRevision:2,
            integrationRevision:3,nativeScope:'synthetic_namespace',servicePrincipalId:crypto.randomUUID(),subject:'ava-onyx-runtime:4',nativeUserId:crypto.randomUUID()};
        const sources = {'ava:4:knowledge:7':{source_id:'7',revision:1,content_hash:'a'.repeat(32)}};
        const indexedDocuments = {'ava:4:knowledge:7':{onyx_document_id:'ava%3A4%3Aknowledge%3A7',source_id:'7',content_hash:'a'.repeat(32)}};
        const proof = {...request,integrationId:'synthetic-link',peerSecretHash:'a'.repeat(64),revision:2,checkedAt:100000,documents:sources,
            ownAccess:true,foreignAccessDenied:true,sourceKnowledgeVerified:true,cleanupVerified:true,indexReadinessVerified:true,
            indexProbeMethod:'default_document_index_random_acl_v1',indexedDocuments};
        const candidate = {servicePrincipalId:request.servicePrincipalId,integrationId:proof.integrationId,peerSecretHash:proof.peerSecretHash};
        assert.strictEqual(validateReadback(proof,request,candidate,sources,100001),proof);
        for (const patch of [{adapterRevision:2},{integrationRevision:4},{deploymentRevision:3},{businessId:9},{subject:'foreign'},
            {checkedAt:1},{checkedAt:100002},{cleanupVerified:false},{documents:{}},{peerSecretHash:'b'.repeat(64)},{integrationId:'foreign'},
            {indexReadinessVerified:false},{indexProbeMethod:'chunk-info'},{indexedDocuments:{}},
            {indexedDocuments:{'ava:4:knowledge:7':{...indexedDocuments['ava:4:knowledge:7'],content_hash:'b'.repeat(32)}}},
            {indexedDocuments:{'ava:4:knowledge:7':{...indexedDocuments['ava:4:knowledge:7'],onyx_document_id:'ava%3A9%3Aknowledge%3A7'}}}]) {
            assert.throws(() => validateReadback({...proof,...patch},request,candidate,sources,100001), /ONYX_NATIVE_ADMISSION_FAILED/);
        }
    });
});
