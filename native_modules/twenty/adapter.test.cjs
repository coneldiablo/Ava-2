'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { configFromEnv } = require('./adapter.cjs');

const ids = { deployment: '11111111-1111-4111-8111-111111111111', scope: '22222222-2222-4222-8222-222222222222', owner: '33333333-3333-4333-8333-333333333333', manager: '44444444-4444-4444-8444-444444444444' };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-twenty-config-'));
  const write = (name, value) => { const file = path.join(root, name); fs.writeFileSync(file, value, { mode: 0o600 }); return file; };
  const gateway = write('gateway', crypto.randomBytes(32).toString('base64url'));
  const worker = write('worker', crypto.randomBytes(32).toString('base64url'));
  const session = write('session', crypto.randomBytes(32).toString('base64'));
  return { root, env: { AVA_BUSINESS_ID: '1', AVA_DEPLOYMENT_ID: ids.deployment, AVA_NATIVE_SCOPE: ids.scope, AVA_DEPLOYMENT_REVISION: '1', AVA_NATIVE_OWNER_ROLE_ID: ids.owner, AVA_NATIVE_MANAGER_ROLE_ID: ids.manager, AVA_NATIVE_GATEWAY_SECRET_FILE: gateway, AVA_NATIVE_WORKER_SECRET_FILE: worker, AVA_NATIVE_SESSION_KEY_FILE: session, SERVER_URL: 'https://alleya-resort-1.crm.meludtech.tech' } };
}

test('existing-workspace native process requires same guarded frontend origin and multi-workspace mode', () => {
  const f = fixture();
  try {
    const attached = { ...f.env, AVA_NATIVE_ATTACH_EXISTING_WORKSPACE: 'true', IS_MULTIWORKSPACE_ENABLED: 'true', FRONTEND_URL: f.env.SERVER_URL };
    assert.equal(configFromEnv(attached).origin, f.env.SERVER_URL);
    for (const change of [
      { IS_MULTIWORKSPACE_ENABLED: 'false' },
      { FRONTEND_URL: 'https://crm.meludtech.tech' },
      { FRONTEND_URL: 'http://alleya-resort-1.crm.meludtech.tech' },
    ]) assert.throws(() => configFromEnv({ ...attached, ...change }), { code: 'native_attach_frontend_origin_invalid' });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
