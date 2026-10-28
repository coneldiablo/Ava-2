const { describe, it, assert } = require('./test-helper');
const { TwentyNativeProvisioning } = require('../src/services/twenty/twenty-native-provisioning');
const { listMetadata, createdMetadata } = require('../src/services/twenty/twenty-metadata');
const { TwentyProvisionerService } = require('../src/services/twenty/twenty-provisioner.service');

// Stateful transport contract fixture, NOT a live Twenty acceptance test.
// Operations, arguments and response envelopes are from the installed
// v2.37.0 resolvers/controllers (documented in the handoff report).
function fixture(overrides = {}) {
    const state = { calls: [], available: [], keys: [], hooks: [], active: false, creates: 0, keyCreates: 0, loggedOut: 0 };
    const ws = { id: 'native-workspace-7', workspaceUrls: { subdomainUrl: 'https://hotel-7.crm.example.test' }, loginToken: 'fixture-login' };
    const tokens = token => ({ accessOrWorkspaceAgnosticToken: { token }, refreshToken: { token: `refresh-${token}` } });
    const transport = { request: async request => {
        const { query, variables } = request.data;
        const op = query.match(/(?:mutation|query)\s+(\w+)/)[1];
        state.calls.push({ op, url: request.url });
        assert.strictEqual(request.maxRedirects, 0);
        assert.ok(request.headers.Origin.startsWith('https://'));
        if (overrides[op]) return overrides[op](request, state, ws);
        let data;
        switch (op) {
        case 'AvaProvisionSignIn':
            assert.strictEqual(variables.email, 'service@example.test');
            data = { signIn: { tokens: tokens('fixture-owner'), availableWorkspaces: { availableWorkspacesForSignIn: state.available } } }; break;
        case 'AvaProvisionCreate':
            assert.strictEqual(request.headers.Authorization, 'Bearer fixture-owner');
            assert.deepStrictEqual(variables.input, { displayName: 'Hotel', subdomain: 'hotel-7' });
            state.creates++; state.available.push(ws);
            data = { signUpInNewWorkspace: { workspace: ws, loginToken: { token: 'fixture-login' } } }; break;
        case 'AvaProvisionEnter':
            assert.strictEqual(variables.origin, 'https://hotel-7.crm.example.test');
            assert.strictEqual(request.headers.Authorization, undefined);
            data = { getAuthTokensFromLoginToken: { tokens: tokens('fixture-workspace') } }; break;
        case 'AvaProvisionWorkspace':
            data = { currentWorkspace: { id: ws.id, subdomain: 'hotel-7', activationStatus: state.active ? 'ACTIVE' : 'PENDING_CREATION' } }; break;
        case 'AvaProvisionActivate':
            assert.ok(query.includes('activateWorkspace(data:{})'));
            state.active = true; data = { activateWorkspace: { id: ws.id } }; break;
        case 'AvaProvisionMember': data = { currentUser: { id: 'native-owner', email: 'service@example.test' } }; break;
        case 'AvaProvisionKeys': data = { apiKeys: state.keys, getApiKeyRoles: [{ id: 'native-workspace-role', label: 'AVA Integration' }] }; break;
        case 'AvaProvisionKey': {
            assert.strictEqual(variables.input.roleId, 'native-workspace-role');
            const key = { id: 'native-api-key', ...variables.input, role: { id: variables.input.roleId } };
            state.keyCreates++; state.keys.push(key); data = { createApiKey: key }; break;
        }
        case 'AvaProvisionKeyToken':
            assert.strictEqual(variables.id, 'native-api-key');
            data = { generateApiKeyToken: { token: 'fixture-workspace-only-api-key' } }; break;
        case 'AvaVerifyRuntimeScope':
            assert.strictEqual(request.headers.Authorization, 'Bearer fixture-workspace-only-api-key');
            data = { currentWorkspace: { id: ws.id, subdomain: 'hotel-7' } }; break;
        case 'AvaProvisionWebhooks': data = { webhooks: state.hooks }; break;
        case 'AvaProvisionWebhook': data = { webhook: state.hooks.find(h => h.id === variables.id) || null }; break;
        case 'AvaProvisionWebhookCreate': state.hooks.push(variables.input); data = { createWebhook: { id: variables.input.id } }; break;
        case 'AvaProvisionSignOut': state.loggedOut++; data = { signOut: true }; break;
        default: throw new Error(`Unexpected fixture operation ${op}`);
        }
        return { data: { data } };
    }};
    const checkpoints = [];
    const adapter = new TwentyNativeProvisioning({ baseUrl: 'https://app.crm.example.test', email: 'service@example.test',
        password: 'fixture-password', transport, onCheckpoint: cp => {
            checkpoints.push(cp); adapter.checkpoint = { ...adapter.checkpoint, ...cp };
        } });
    return { adapter, state, ws, checkpoints };
}

describe('Native Twenty v2.37.0 provisioning contract', () => {
    it('never issues an administrator role as the runtime integration key', async () => {
        const { adapter, state } = fixture();
        adapter.roleLabel = 'Admin';
        await assert.rejects(adapter.issueWorkspaceApiKey({ workspaceId: 'unallocated', businessId: 7 }), { code: 'TWENTY_RESTRICTED_RUNTIME_ROLE_REQUIRED' });
        assert.strictEqual(state.calls.length, 0);
    });
    it('uses native onboarding, activation, dedicated key, scope readback and session cleanup', async () => {
        const { adapter, state } = fixture();
        assert.strictEqual(await adapter.findWorkspace({ slug: 'hotel-7' }), null);
        const workspace = await adapter.createWorkspace({ name: 'Hotel', slug: 'hotel-7' });
        assert.strictEqual(workspace.activationStatus, 'ACTIVE');
        const membership = await adapter.configureMembership({ workspaceId: workspace.id });
        assert.strictEqual(membership.configured, true);
        assert.strictEqual(membership.customerAccessVerified, false);
        const key = await adapter.issueWorkspaceApiKey({ workspaceId: workspace.id, businessId: 7 });
        assert.strictEqual(key.apiKey, 'fixture-workspace-only-api-key');
        await adapter.issueWorkspaceApiKey({ workspaceId: workspace.id, businessId: 7 });
        assert.strictEqual(state.keyCreates, 1);
        assert.strictEqual(state.creates, 1);
        await adapter.close();
        assert.strictEqual(state.loggedOut, 2);
        assert.strictEqual(adapter.ownerToken, null);
    });

    it('reconciles pending native workspace after a lost create response', async () => {
        const { adapter, state, ws } = fixture();
        state.available.push(ws);
        const found = await adapter.findWorkspace({ slug: 'hotel-7' });
        assert.strictEqual(found.id, ws.id);
        assert.strictEqual(found.activationStatus, 'ACTIVE');
        assert.strictEqual(state.creates, 0);
        await adapter.close();
    });

    it('will not send a login token to a foreign workspace URL', async () => {
        const { adapter, state } = fixture({ AvaProvisionCreate: () => ({ data: { data: {
            signUpInNewWorkspace: { workspace: { id: 'foreign', workspaceUrls: { subdomainUrl: 'https://attacker.example.test' } },
                loginToken: { token: 'must-not-leak' } }
        } } }) });
        await assert.rejects(adapter.createWorkspace({ name: 'Hotel', slug: 'hotel-7' }), { code: 'TWENTY_NATIVE_WORKSPACE_URL_INVALID' });
        assert.ok(!state.calls.some(call => call.url.includes('attacker') || call.op === 'AvaProvisionEnter'));
        await adapter.close();
    });

    it('rejects wrong workspace IDs and a runtime key scoped to a different hotel', async () => {
        const { adapter, state, ws } = fixture({ AvaVerifyRuntimeScope: () => ({ data: { data: { currentWorkspace: { id: 'other', subdomain: 'hotel-8' } } } }) });
        state.available.push(ws);
        await assert.rejects(adapter.findWorkspace({ slug: 'hotel-7', workspaceId: 'other' }), { code: 'TWENTY_WORKSPACE_NOT_VERIFIED' });
        await adapter.findWorkspace({ slug: 'hotel-7' });
        await assert.rejects(adapter.issueWorkspaceApiKey({ workspaceId: ws.id, businessId: 7 }), { code: 'TWENTY_RUNTIME_KEY_INVALID' });
        await adapter.close();
    });

    it('does not blindly repeat key creation after an uncertain result', async () => {
        const { adapter, state, ws } = fixture();
        state.available.push(ws);
        await adapter.findWorkspace({ slug: 'hotel-7' });
        adapter.checkpoint.nativeKeyCreateRequested = true;
        await assert.rejects(adapter.issueWorkspaceApiKey({ workspaceId: ws.id, businessId: 7 }), { code: 'TWENTY_KEY_RECONCILIATION_REQUIRED' });
        assert.strictEqual(state.keyCreates, 0);
        await adapter.close();
    });

    it('stops at lease loss and never exposes native errors or Axios secrets', async () => {
        const { adapter, state } = fixture();
        adapter.assertLease = () => { throw Object.assign(new Error('Lease lost'), { code: 'PROVISIONING_LEASE_LOST' }); };
        await assert.rejects(adapter.login(), { code: 'PROVISIONING_LEASE_LOST' });
        assert.strictEqual(state.calls.length, 0);
        const unsafe = fixture({ AvaProvisionSignIn: () => { throw { message: 'password=unsafe', response: { status: 403 }, config: { token: 'unsafe' } }; } });
        await assert.rejects(unsafe.adapter.login(), error => error.code === 'TWENTY_NATIVE_FORBIDDEN' && !JSON.stringify(error).includes('unsafe'));
    });

    it('creates one native signed webhook and validates its readback without claiming delivery', async () => {
        const { adapter, state, ws, checkpoints } = fixture();
        state.available.push(ws);
        await adapter.findWorkspace({ slug: 'hotel-7' });
        const input = { workspaceId: ws.id, webhook: { webhook_url: 'https://ava.example.test/api/integrations/twenty/webhooks/fixture-opaque' }, secret: 'fixture-webhook-secret' };
        const result = await adapter.configureWebhook(input);
        assert.strictEqual(result.verified, true);
        assert.strictEqual(result.deliveryVerified, false);
        await adapter.configureWebhook(input);
        assert.strictEqual(state.hooks.length, 1);
        assert.ok(!JSON.stringify(checkpoints).includes('fixture-webhook-secret'));
        state.hooks[0].secret = 'wrong';
        await assert.rejects(adapter.configureWebhook(input), { code: 'TWENTY_WEBHOOK_NOT_VERIFIED' });
        await adapter.close();
    });

    it('reads direct and legacy metadata envelopes with native starting_after pagination', async () => {
        const calls = [];
        const client = { request: async (_, __, options) => {
            calls.push(options.params);
            return calls.length === 1 ? { data: { fields: [{ id: 'first' }] }, pageInfo: { hasNextPage: true, endCursor: 'native-cursor' } }
                : { data: [{ id: 'second' }], pageInfo: { hasNextPage: false } };
        } };
        assert.deepStrictEqual((await listMetadata(client, 'fields')).map(row => row.id), ['first', 'second']);
        assert.strictEqual(calls[1].starting_after, 'native-cursor');
        assert.strictEqual(createdMetadata({ data: { createOneObject: { id: 'native-object' } } }, 'Object').id, 'native-object');
        await assert.rejects(listMetadata({ request: async () => ({ data: { unknown: [] } }) }, 'fields'), { code: 'TWENTY_METADATA_CONTRACT_INVALID' });
    });

    it('rejects a successful metadata POST without a matching final readback', async () => {
        const manifest = { standard_object_fields: { companies: ['avaBusinessId'] }, field_definitions: { avaBusinessId: { type: 'TEXT' } } };
        const p = new TwentyProvisionerService({ clientFactory: () => ({ request: async (method, path) => {
            if (path.endsWith('/objects')) return { data: { objects: [{ id: 'native-object', namePlural: 'companies' }] } };
            if (method === 'GET') return { data: { fields: [] } };
            return { data: { createOneField: { id: 'native-field' } } };
        } }) });
        await assert.rejects(p.applySchemaManifest('https://crm.example.test', 'fixture-key', manifest), { code: 'TWENTY_SCHEMA_NOT_VERIFIED' });
    });
});
