const { describe, it, assert, createTestDB } = require('./test-helper');
const { startRuntime } = require('../provisioning-worker');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Revocations = require('../src/services/identity/revocation-worker');
const Provisioning = require('../src/services/provisioning/business-provisioning-store.service');

describe('A07 identity-only provisioning worker mode', () => {
    it('serves identity RPC and Keycloak revocation without loading other workers', async () => {
        const calls = [];
        const scheduled = [];
        const broker = { activeEnrollments: 0, close: () => calls.push('broker.close') };
        const runtime = await startRuntime({
            env: {
                AVA_PROVISIONING_JOBS_ENABLED: 'false',
                // Defense against a stale production setting: identity-only
                // mode must ignore recovery even if its old flag remains true.
                AVA_TWENTY_SYNC_RECOVERY_ENABLED: 'true',
            },
            db: {
                init: async () => calls.push('db.init'),
                db: { close: () => calls.push('db.close') },
            },
            identityStore: { ensureSchema: () => calls.push('identity.schema') },
            identityBrokerService: { start: () => { calls.push('broker.start'); return broker; } },
            loadPasswordRecoveryWorker: () => ({processOne: async () => { calls.push('password-recovery'); }}),
            loadRegistrationStore: () => ({ensureSchema: () => { calls.push('registration.cleanup'); }}),
            loadProvisioningWorker: () => { throw new Error('business worker loaded'); },
            loadRevocationWorker: () => ({ processOne: async options => calls.push(`revocation:${options?.keycloakOnly === true}`) }),
            loadRecoveryWorker: () => { throw new Error('recovery worker loaded'); },
            schedule: (callback, delay) => {
                const timer = { callback, delay };
                scheduled.push(timer);
                return timer;
            },
            cancel: timer => calls.push(`timer.cancel:${timer.delay}`),
        });

        assert.strictEqual(runtime.provisioningJobsEnabled, false);
        assert.deepStrictEqual(calls, ['db.init', 'identity.schema', 'broker.start']);
        assert.deepStrictEqual(scheduled.map(timer => timer.delay), [3000]);
        await scheduled[0].callback();
        assert.ok(calls.includes('revocation:true'));
        assert.ok(calls.includes('password-recovery'));
        assert.ok(calls.includes('registration.cleanup'));
        await runtime.shutdown();
        assert.ok(calls.includes('broker.close'));
        assert.ok(calls.includes('timer.cancel:3000'));
        assert.ok(calls.includes('db.close'));
    });

    it('fails closed when identity-only mode cannot bind its private broker', async () => {
        let closed = false;
        await assert.rejects(startRuntime({
            env: { AVA_PROVISIONING_JOBS_ENABLED: 'false' },
            db: { init: async () => {}, db: { close: () => { closed = true; } } },
            identityStore: { ensureSchema: () => {} },
            identityBrokerService: { start: () => null },
            loadPasswordRecoveryWorker: () => ({processOne: async () => { calls.push('password-recovery'); }}),
            loadRegistrationStore: () => ({ensureSchema: () => { calls.push('registration.cleanup'); }}),
            loadProvisioningWorker: () => { throw new Error('business worker loaded'); },
            loadRevocationWorker: () => { throw new Error('revocation worker loaded'); },
            loadRecoveryWorker: () => { throw new Error('recovery worker loaded'); },
            schedule: () => { throw new Error('background timer scheduled'); },
        }), /IDENTITY_BROKER_REQUIRED/);
        assert.strictEqual(closed, true);
    });

    it('Keycloak-only revocation completes without invoking native module cleanup', async () => {
        const previousRole = process.env.AVA_PROCESS_ROLE;
        process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        try {
            createTestDB();
            const platform = { userId: 'identity-only-operator', platformRole: 'platform_admin' };
            const invitation = Identity.createInvitation(platform, { email: 'pilot-owner@example.test' });
            const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), 'pilot-native-owner');
            const business = Provisioning.createBusinessAtomic({ name: 'Existing pilot business' }, { ownerUserId: user.userId }).instance;
            DB.run("INSERT INTO twenty_workspace_links(businessId,workspaceId,baseUrl,apiKeyEncrypted,enabled) VALUES (?,?,'https://legacy.example.test','fixture',1)",
                [business.id, 'legacy-workspace']);
            Identity.revokeUser(platform, user.userId);
            const nativeCalls = [];
            let moduleCalls = 0;
            const admin = { call: async (method, path, body) => {
                nativeCalls.push([method, path, body]);
                if (path.endsWith('/sessions')) return [];
                return { id: 'pilot-native-owner', attributes: { avaUserId: [user.userId] } };
            } };

            assert.strictEqual(await Revocations.processOne({
                admin,
                keycloakOnly: true,
                revokeModules: async () => { moduleCalls++; return true; },
            }), true);
            const outbox = DB.get('SELECT state,keycloakRevoked,lastErrorCode FROM ava_identity_outbox');
            assert.deepStrictEqual(outbox, { state: 'done', keycloakRevoked: 1, lastErrorCode: null });
            assert.strictEqual(moduleCalls, 0);
            assert.ok(nativeCalls.some(([method, path]) => method === 'PUT' && path === '/users/pilot-native-owner'));
            assert.ok(nativeCalls.some(([method, path]) => method === 'POST' && path === '/users/pilot-native-owner/logout'));
            assert.ok(nativeCalls.some(([method, path]) => method === 'GET' && path === '/users/pilot-native-owner/sessions'));
        } finally {
            if (previousRole === undefined) delete process.env.AVA_PROCESS_ROLE;
            else process.env.AVA_PROCESS_ROLE = previousRole;
        }
    });

    it('preserves the existing background-worker behavior when the flag is unset', async () => {
        const calls = [];
        const scheduled = [];
        const poller = { ref: () => calls.push('poller.ref') };
        const worker = {
            _pollerTimer: poller,
            _isProcessing: false,
            startBackgroundPoller: delay => calls.push(`poller.start:${delay}`),
            stopBackgroundPoller: () => calls.push('poller.stop'),
        };
        const runtime = await startRuntime({
            env: {},
            db: {
                init: async () => calls.push('db.init'),
                db: { close: () => calls.push('db.close') },
            },
            identityStore: { ensureSchema: () => calls.push('identity.schema') },
            identityBrokerService: { start: () => ({ activeEnrollments: 0, close: () => calls.push('broker.close') }) },
            loadPasswordRecoveryWorker: () => ({processOne: async () => { calls.push('password-recovery'); }}),
            loadRegistrationStore: () => ({ensureSchema: () => { calls.push('registration.cleanup'); }}),
            loadProvisioningWorker: () => { calls.push('poller.load'); return worker; },
            loadRevocationWorker: () => { calls.push('revocation.load'); return { processOne: async () => {} }; },
            loadRecoveryWorker: () => { throw new Error('disabled recovery worker loaded'); },
            schedule: (callback, delay) => {
                const timer = { callback, delay };
                scheduled.push(timer);
                return timer;
            },
            cancel: timer => calls.push(`timer.cancel:${timer.delay}`),
        });

        assert.strictEqual(runtime.provisioningJobsEnabled, true);
        assert.deepStrictEqual(scheduled.map(timer => timer.delay), [3000]);
        assert.ok(calls.includes('revocation.load'));
        assert.ok(calls.includes('poller.load'));
        assert.ok(calls.includes('poller.start:3000'));
        assert.ok(calls.includes('poller.ref'));
        await runtime.shutdown();
        assert.ok(calls.includes('poller.stop'));
        assert.ok(calls.includes('timer.cancel:3000'));
        assert.ok(calls.includes('broker.close'));
        assert.ok(calls.includes('db.close'));
    });
});
describe('Independent telephony timer',()=>{
    for(const enabled of [false,true]) it(`preserves identity and avoids duplicate telephony timer with provisioning=${enabled}`,async()=>{
        const events=[],timers=[];
        const runtime=await startRuntime({env:{AVA_PROVISIONING_JOBS_ENABLED:String(enabled),AVA_TELEPHONY_WORKER_ENABLED:'true'},
            db:{init:async()=>{},db:{close:()=>events.push('db.close')}},identityStore:{ensureSchema:()=>{}},
            identityBrokerService:{start:()=>({activeEnrollments:0,close:()=>events.push('broker.close')})},
            loadRevocationWorker:()=>({processOne:async()=>events.push('identity')}),
            loadPasswordRecoveryWorker:()=>({processOne:async()=>events.push('password')}),loadRegistrationStore:()=>({ensureSchema:()=>{}}),
            loadRecoveryWorker:()=>{throw new Error('foreign recovery queue');},
            loadProvisioningWorker:()=>{assert.ok(enabled);return {_pollerTimer:{ref:()=>{}},startBackgroundPoller:()=>events.push('provisioning'),stopBackgroundPoller:()=>{}};},
            loadTelephonyWorker:()=>{assert.ok(!enabled);return {processOne:async()=>events.push('telephony')};},
            schedule:callback=>{const timer={callback};timers.push(timer);return timer;},cancel:timer=>events.push(timers.indexOf(timer))});
        assert.strictEqual(timers.length,enabled?1:2);
        for(const timer of timers) await timer.callback();
        assert.ok(events.includes('identity'));assert.ok(events.includes('password'));
        assert.strictEqual(events.includes('telephony'),!enabled);
        await runtime.shutdown();assert.ok(events.includes('broker.close'));assert.ok(events.includes('db.close'));
        if(!enabled) assert.ok(events.includes(1));
    });
    it('telephony timer rejects overlap and shutdown waits for in-flight work',async()=>{
        let resolveCall,ran=0,closed=false;const timers=[];
        const runtime=await startRuntime({env:{AVA_PROVISIONING_JOBS_ENABLED:'false',AVA_TELEPHONY_WORKER_ENABLED:'true'},
            db:{init:async()=>{},db:{close:()=>{closed=true;}}},identityStore:{ensureSchema:()=>{}},
            identityBrokerService:{start:()=>({close:()=>{},activeEnrollments:0})},
            loadRevocationWorker:()=>({processOne:async()=>{}}),loadPasswordRecoveryWorker:()=>({processOne:async()=>{}}),loadRegistrationStore:()=>({ensureSchema:()=>{}}),
            loadProvisioningWorker:()=>{throw new Error('foreign queue');},
            loadTelephonyWorker:()=>({processOne:async()=>{ran++;await new Promise(resolve=>{resolveCall=resolve;});}}),
            schedule:callback=>{timers.push(callback);return callback;},cancel:()=>{}});
        const running=timers[1]();await timers[1]();assert.strictEqual(ran,1);
        const shutdown=runtime.shutdown();assert.strictEqual(closed,false);resolveCall();await running;await shutdown;assert.strictEqual(closed,true);
    });
});
