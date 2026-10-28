'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { installAttachedWorkspaceScope } = require('./install.cjs');

const scope = '72600089-b4b4-4db3-a8b9-362f07033467';
const other = '11111111-1111-4111-8111-111111111111';
const origin = 'https://alleya-resort-1.crm.meludtech.tech';
const config = { nativeScope: scope, origin };
class WorkspaceDomainsService {}
class WorkspaceService {}
class DataSource {}

function fixture({ workspace = { id: scope, activationStatus: 'ACTIVE' } } = {}) {
  const domains = {
    async getWorkspaceByOriginOrDefaultWorkspace(value) { return { id: `stock:${value}` }; },
    async resolveWorkspaceAndPublicDomain(value) { return { workspace: { id: `stock:${value}` }, publicDomain: { id: 'stock' }, isIsolatedOrigin: false }; },
    getWorkspaceUrls(value) { return { subdomainUrl: `https://${value.id}.crm.meludtech.tech` }; },
  };
  const calls = [];
  const workspaceService = {
    async findOneWorkspaceById(id) { calls.push(id); return { id, displayName: 'private' }; },
  };
  // Model the real pinned resolver: its registered callback can be captured
  // before the attach hook, but it dynamically invokes the service singleton.
  const resolver = {
    async getPublicWorkspaceDataById(id) {
      return workspaceService.findOneWorkspaceById(id);
    },
  };
  const lookups = [];
  const workspaceRepo = {
    async findOne(query) {
      lookups.push(query);
      return query?.where?.id === scope ? workspace : null;
    },
  };
  const injected = { WorkspaceDomainsService, WorkspaceService, DataSource, workspaceRepo, domains, workspaceService };
  return { domains, resolver, workspaceService, calls, lookups, injected };
}

test('attached resolver is disabled unless the explicit existing-workspace process flag is true', async () => {
  const f = fixture();
  assert.equal(installAttachedWorkspaceScope({}, '/unused', config, {}, f.injected), false);
  assert.equal((await f.domains.getWorkspaceByOriginOrDefaultWorkspace('https://untrusted.example')).id, 'stock:https://untrusted.example');
  assert.deepEqual(f.domains.getWorkspaceUrls({ id: other }), { subdomainUrl: `https://${other}.crm.meludtech.tech` });
});

test('attached resolver accepts only the configured origin and immutable active scope without domain mutation', async () => {
  const f = fixture();
  assert.equal(installAttachedWorkspaceScope({}, '/unused', config, { AVA_NATIVE_ATTACH_EXISTING_WORKSPACE: 'true' }, f.injected), true);
  assert.equal((await f.domains.getWorkspaceByOriginOrDefaultWorkspace(origin)).id, scope);
  assert.deepEqual(f.lookups[0], { where: { id: scope }, relations: ['workspaceSSOIdentityProviders'] });
  assert.deepEqual(await f.domains.resolveWorkspaceAndPublicDomain(origin), { workspace: { id: scope, activationStatus: 'ACTIVE' }, publicDomain: null, isIsolatedOrigin: true });
  assert.deepEqual(f.domains.getWorkspaceUrls({ id: scope }), { customUrl: origin, subdomainUrl: origin });
  await assert.rejects(f.domains.getWorkspaceByOriginOrDefaultWorkspace('https://ava-hotels.crm.meludtech.tech'), { code: 'native_workspace_origin_invalid' });
  assert.throws(() => f.domains.getWorkspaceUrls({ id: other }), { code: 'native_workspace_scope_invalid' });
  await assert.rejects(f.domains.resolveWorkspaceAndPublicDomain(origin + '/'), { code: 'native_workspace_origin_invalid' });
});

test('captured public resolver callback cannot disclose another workspace after the service hook', async () => {
  const f = fixture();
  const capturedResolverCallback = f.resolver.getPublicWorkspaceDataById.bind(f.resolver);
  installAttachedWorkspaceScope({}, '/unused', config, { AVA_NATIVE_ATTACH_EXISTING_WORKSPACE: 'true' }, f.injected);
  assert.deepEqual(await capturedResolverCallback(scope), { id: scope, displayName: 'private' });
  await assert.rejects(capturedResolverCallback(other), { code: 'native_workspace_scope_invalid' });
  assert.deepEqual(f.calls, [scope]);
});

test('attached origin lookup fails closed when the immutable scope is inactive', async () => {
  const inactive = fixture({ workspace: { id: scope, activationStatus: 'PENDING_CREATION' } });
  installAttachedWorkspaceScope({}, '/unused', config, { AVA_NATIVE_ATTACH_EXISTING_WORKSPACE: 'true' }, inactive.injected);
  await assert.rejects(inactive.domains.getWorkspaceByOriginOrDefaultWorkspace(origin), { code: 'native_workspace_not_active' });
  await assert.rejects(inactive.resolver.getPublicWorkspaceDataById(scope), { code: 'native_workspace_not_active' });
});
