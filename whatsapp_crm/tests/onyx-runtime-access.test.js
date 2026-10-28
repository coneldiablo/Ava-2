'use strict';

const { describe, it: register, assert, createTestDB, runAll } = require('./test-helper');
const crypto = require('crypto');
const DB = require('../src/services/database.service');
const Access = require('../src/services/identity/module-access-store');
const Runtime = require('../src/services/identity/onyx-runtime-access');

const uuid = () => crypto.randomUUID();

function it(name, fn) {
    register(name, async () => {
        const previous = process.env.AVA_PROCESS_ROLE;
        createTestDB();
        process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        try { await fn(); }
        finally {
            if (previous === undefined) delete process.env.AVA_PROCESS_ROLE;
            else process.env.AVA_PROCESS_ROLE = previous;
        }
    });
}

function setup(name = 'Runtime hotel') {
    const businessId = DB.run('INSERT INTO instances(name,isActive) VALUES (?,1)', [name]).lastInsertRowid;
    const deploymentId = uuid(), namespace = `ava_${deploymentId.replaceAll('-', '')}`;
    const hostname = `onyx-${businessId}.knowledge.meludtech.tech`;
    DB.run(`INSERT INTO ava_module_deployments(id,businessId,module,hostname,namespace,state,revision,correlationId,createdAt,updatedAt)
        VALUES (?,?, 'onyx',?,?, 'verified',1,?,?,?)`,
    [deploymentId, businessId, hostname, namespace, uuid(), Date.now(), Date.now()]);
    DB.run(`INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,status)
        VALUES (?,?,?,'active')`, [businessId, namespace, `https://${hostname}`]);
    const integration = DB.get('SELECT revision FROM onyx_tenant_links WHERE business_id=?', [businessId]);
    const adapter = Access.configure({
        businessId,
        module: 'onyx',
        publicOrigin: `https://${hostname}`,
        attachmentMode: 'isolated_workspace_ui',
        expectedNativeScope: namespace,
        expectedIntegrationRevision: integration.revision,
    });
    return { businessId, deploymentId, namespace, hostname, adapter };
}

const completeProof = (input, patch = {}) => ({
    ...input,
    ownAccess: true,
    foreignAccessDenied: true,
    sourceKnowledgeVerified: true,
    ...patch,
});

describe('isolated Onyx runtime machine access', () => {
    it('matches the pinned Python native UUIDv5 identity contract', async () => {
        const fixture = setup();
        const deploymentId = '11111111-1111-4111-8111-111111111111';
        const nativeScope = `ava_${deploymentId.replaceAll('-', '')}`;
        DB.run('UPDATE ava_module_deployments SET id=?,namespace=? WHERE id=?', [deploymentId, nativeScope, fixture.deploymentId]);
        DB.run('UPDATE ava_module_adapters SET deploymentId=?,nativeScope=? WHERE id=?', [deploymentId, nativeScope, fixture.adapter.id]);
        const candidate = Runtime.candidate({ adapterId: fixture.adapter.id });
        assert.strictEqual(candidate.servicePrincipalId, '42017c6c-c5a2-5499-b6dd-51f8a3e18218');
        assert.strictEqual(candidate.nativeUserId, '90d78852-0fbc-53e1-ac41-5d9829ed04e5');
        assert.deepStrictEqual(Runtime.candidate({ adapterId: fixture.adapter.id }), candidate);
        const value = await Runtime.admit({adapterId: fixture.adapter.id, readback: async input => completeProof(input)});
        assert.deepStrictEqual(value, candidate);
    });
    it('admits only a server-defined per-business principal and returns no credential', async () => {
        const fixture = setup();
        let nativeRequest;
        const admitted = await Runtime.admit({
            adapterId: fixture.adapter.id,
            readback: async input => { nativeRequest = input; return completeProof(input); },
        });
        assert.strictEqual(nativeRequest.businessId, fixture.businessId);
        assert.strictEqual(nativeRequest.nativeScope, fixture.namespace);
        assert.strictEqual(nativeRequest.subject, `ava-onyx-runtime:${fixture.businessId}`);
        assert.match(nativeRequest.servicePrincipalId, /^[0-9a-f-]{36}$/);
        assert.match(nativeRequest.nativeUserId, /^[0-9a-f-]{36}$/);

        const repeated = await Runtime.admit({ adapterId: fixture.adapter.id, readback: async input => completeProof(input) });
        assert.deepStrictEqual(repeated, admitted);
        const authorized = Runtime.authorize({ adapterId: fixture.adapter.id, peerSecret: fixture.adapter.peerSecret });
        assert.deepStrictEqual(authorized, admitted);
        assert.deepStrictEqual(Object.keys(authorized).sort(),
            ['businessId', 'nativeScope', 'nativeUserId', 'servicePrincipalId', 'subject']);
        assert.strictEqual(JSON.stringify(authorized).includes(fixture.adapter.peerSecret), false);
    });

    it('rejects a foreign peer and never accepts a caller-supplied business identity', async () => {
        const own = setup('Own runtime hotel'), foreign = setup('Foreign runtime hotel');
        await Runtime.admit({ adapterId: own.adapter.id, readback: async input => completeProof(input) });
        assert.throws(() => Runtime.authorize({ adapterId: own.adapter.id, peerSecret: foreign.adapter.peerSecret }),
            { code: 'MODULE_PEER_DENIED' });
        assert.throws(() => Runtime.authorize({ adapterId: own.adapter.id, peerSecret: own.adapter.peerSecret, businessId: foreign.businessId }),
            { code: 'ONYX_RUNTIME_AUTHORIZATION_INVALID' });
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM ava_onyx_runtime_principals WHERE businessId=?', [foreign.businessId]).n, 0);
    });

    it('requires the provisioning worker for admission and revocation', async () => {
        const fixture = setup();
        const previous = process.env.AVA_PROCESS_ROLE;
        delete process.env.AVA_PROCESS_ROLE;
        try {
            await assert.rejects(Runtime.admit({ adapterId: fixture.adapter.id, readback: async input => completeProof(input) }),
                { code: 'ONYX_RUNTIME_WORKER_REQUIRED' });
            assert.throws(() => Runtime.candidate({ adapterId: fixture.adapter.id }), { code: 'ONYX_RUNTIME_WORKER_REQUIRED' });
            assert.throws(() => Runtime.revoke({ adapterId: fixture.adapter.id }), { code: 'ONYX_RUNTIME_WORKER_REQUIRED' });
        } finally { process.env.AVA_PROCESS_ROLE = previous; }
    });

    it('denies immediately after disable or explicit revocation without an authorization cache', async () => {
        const fixture = setup();
        await Runtime.admit({ adapterId: fixture.adapter.id, readback: async input => completeProof(input) });
        assert.deepStrictEqual(Runtime.revoke({ adapterId: fixture.adapter.id }), { revoked: true });
        assert.throws(() => Runtime.authorize({ adapterId: fixture.adapter.id, peerSecret: fixture.adapter.peerSecret }),
            { code: 'ONYX_RUNTIME_NOT_ADMITTED' });
        await Runtime.admit({ adapterId: fixture.adapter.id, readback: async input => completeProof(input) });
        DB.run('UPDATE ava_module_adapters SET revision=revision+1 WHERE id=?', [fixture.adapter.id]);
        assert.throws(() => Runtime.authorize({ adapterId: fixture.adapter.id, peerSecret: fixture.adapter.peerSecret }),
            { code: 'ONYX_RUNTIME_NOT_ADMITTED' });
        DB.run('UPDATE ava_module_adapters SET enabled=0 WHERE id=?', [fixture.adapter.id]);
        assert.throws(() => Runtime.authorize({ adapterId: fixture.adapter.id, peerSecret: fixture.adapter.peerSecret }),
            { code: 'MODULE_ADAPTER_UNAVAILABLE' });
    });

    it('rejects incomplete knowledge proof and rechecks revisions after asynchronous readback', async () => {
        const fixture = setup();
        await assert.rejects(Runtime.admit({
            adapterId: fixture.adapter.id,
            readback: input => completeProof(input),
        }), { code: 'ONYX_RUNTIME_READBACK_REQUIRED' });
        for (const patch of [
            { ownAccess: false },
            { foreignAccessDenied: false },
            { sourceKnowledgeVerified: false },
        ]) {
            await assert.rejects(Runtime.admit({
                adapterId: fixture.adapter.id,
                readback: async input => completeProof(input, patch),
            }), { code: 'ONYX_RUNTIME_PROOF_INCOMPLETE' });
        }
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM ava_onyx_runtime_principals').n, 0);

        await assert.rejects(Runtime.admit({
            adapterId: fixture.adapter.id,
            readback: async input => {
                DB.run('UPDATE ava_module_deployments SET revision=revision+1 WHERE id=?', [fixture.deploymentId]);
                return completeProof(input);
            },
        }));
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM ava_onyx_runtime_principals').n, 0);
    });
});

if (require.main === module) runAll().then(ok => { if (!ok) process.exitCode = 1; });
