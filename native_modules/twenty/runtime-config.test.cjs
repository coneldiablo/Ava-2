'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');
const { applyBootstrapContext } = require('./runtime-config.cjs');

const ids = {
  nativeScope: '11111111-1111-4111-8111-111111111111',
  hotelOwnerRoleId: '22222222-2222-4222-8222-222222222222',
  managerRoleId: '33333333-3333-4333-8333-333333333333',
};
const baseEnv = file => ({ AVA_BOOTSTRAP_CONTEXT_FILE: file, AVA_BUSINESS_ID: '731',
  AVA_DEPLOYMENT_ID: '44444444-4444-4444-8444-444444444444', AVA_DEPLOYMENT_REVISION: '7' });
const context = () => ({ businessId: 731, deploymentId: '44444444-4444-4444-8444-444444444444', revision: 7, ...ids });
function fixture(setup = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-runtime-'));
  const file = path.join(dir, 'bootstrap.json');
  fs.writeFileSync(file, JSON.stringify(context()), { mode: 0o600 });
  setup(file, dir);
  return { dir, file };
}
function rejects(env) { assert.throws(() => applyBootstrapContext(env), error => error.code === 'native_bootstrap_context_invalid'); }

describe('runtime bootstrap context safety', () => {
  test('legacy contour without context file is unchanged', () => {
    const env = { AVA_BUSINESS_ID: '731' };
    assert.strictEqual(applyBootstrapContext(env), env);
  });

  test('valid context applies exact scoped IDs to environment', () => {
    const { dir, file } = fixture();
    try { const env = baseEnv(file); assert.strictEqual(applyBootstrapContext(env), env); assert.deepEqual(env, { ...baseEnv(file), ...{
      AVA_NATIVE_SCOPE: ids.nativeScope, AVA_NATIVE_OWNER_ROLE_ID: ids.hotelOwnerRoleId, AVA_NATIVE_MANAGER_ROLE_ID: ids.managerRoleId,
    }}); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('rejects wrong scope, malformed IDs, conflicting env, unsafe mode, and symlink', () => {
    const mutations = [
      c => { c.businessId = 732; }, c => { c.revision = 8; }, c => { c.deploymentId = '55555555-5555-4555-8555-555555555555'; },
      c => { c.nativeScope = 'not-an-id'; }, c => { c.hotelOwnerRoleId = 'not-an-id'; }, c => { c.managerRoleId = 'not-an-id'; },
    ];
    for (const mutate of mutations) { const { dir, file } = fixture(() => {}); try {
      const value = context(); mutate(value); fs.writeFileSync(file, JSON.stringify(value)); rejects(baseEnv(file));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
    for (const mode of [0o640, 0o600]) { const { dir, file } = fixture(); try { fs.chmodSync(file, mode); if (mode !== 0o600) rejects(baseEnv(file)); } finally { fs.rmSync(dir, { recursive: true, force: true }); } }
    const { dir, file } = fixture((real, root) => { fs.renameSync(real, real + '.real'); fs.symlinkSync(real + '.real', real); });
    try { rejects(baseEnv(file)); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('conflicting preconfigured role is all-or-nothing', () => {
    const { dir, file } = fixture();
    try { const env = { ...baseEnv(file), AVA_NATIVE_SCOPE: ids.nativeScope, AVA_NATIVE_OWNER_ROLE_ID: '99999999-9999-4999-8999-999999999999' };
      const before = { ...env }; rejects(env); assert.deepEqual(env, before); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
