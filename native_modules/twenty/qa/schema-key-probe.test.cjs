'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readJson, readSecret, runProbe, safeFailure, validateQa } = require('./schema-key-probe.cjs');

const D = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const R = '33333333-3333-4333-8333-333333333333';
const M = '44444444-4444-4444-8444-444444444444';
const H = '55555555-5555-4555-8555-555555555555';
const U = '66666666-6666-4666-8666-666666666666';
const K1 = '77777777-7777-4777-8777-777777777777';
const K2 = '88888888-8888-4888-8888-888888888888';
const NOW = Date.now();
const DAY = 86400000;
const context = Object.freeze({ businessId:900011, deploymentId:D, revision:7, nativeScope:W,
  managerRoleId:M, hotelOwnerRoleId:H, ownerUserId:U, hostname:'recipe-qa-900011.crm.meludtech.tech' });
const TOKEN1 = `first.${'a'.repeat(80)}.credential`;
const TOKEN2 = `second.${'b'.repeat(80)}.credential`;
const fenced = () => Object.assign(new Error('must not be exposed'), { code:'AVA_RUNTIME_KEY_FENCED' });

function fixture() {
  const state = {
    token:TOKEN1,
    currentKey:K1,
    generation:4,
    oldRevoked:false,
    stat:{ regular:true, symlink:false, mode:0o100600 },
    calls:[],
  };
  const role = { id:R };
  const key = id => ({ id, workspaceId:W, revokedAt:id === K1 && state.oldRevoked ? new Date(NOW) : null });
  const ops = {
    rotateBeforeMs:7 * DAY,
    readSecret:() => state.token,
    statSecret:() => ({ ...state.stat }),
    schemaReplay:async value => { state.calls.push(['schema', value]); return { ready:true, objectsCreated:0, fieldsCreated:0 }; },
    runtimeReplay:async value => { state.calls.push(['runtime', value]); return { nativeKeyId:K1, roleId:R, expiresAt:new Date(NOW + 30 * DAY) }; },
    verifySignature:async token => {
      state.calls.push(['verify', token === TOKEN1 ? 'first' : token === TOKEN2 ? 'second' : 'unknown']);
      return { type:'API_KEY', jti:token === TOKEN1 ? K1 : K2, sub:W, workspaceId:W };
    },
    validateKey:async (id, workspace) => {
      state.calls.push(['validate', id, workspace]);
      if (id === K1 && state.oldRevoked) throw Object.assign(new Error('native revoked'), { code:'API_KEY_REVOKED' });
      return key(id);
    },
    findKey:async (id, workspace) => { state.calls.push(['find', id, workspace]); return key(id); },
    roleForKey:async (id, workspace) => { state.calls.push(['roleForKey', id, workspace]); return R; },
    getRole:async (id, workspace) => { state.calls.push(['role', id, workspace]); return role; },
    roleSafe:(value, ctx) => value === role && ctx === context,
    getLedger:async id => ({ deploymentId:id, workspaceId:W, revision:7, disabled:false, roleId:R,
      activeKeyId:state.currentKey, activeGeneration:state.generation }),
    rotate:async (value, now) => {
      state.calls.push(['rotate', value, now]);
      state.token = TOKEN2;
      state.currentKey = K2;
      state.generation++;
      state.oldRevoked = true;
      return { nativeKeyId:K2, roleId:R, expiresAt:new Date(now + 30 * DAY) };
    },
    foreignRevision:async (value, now) => { state.calls.push(['foreign', value, now]); throw fenced(); },
  };
  return { ops, state, role };
}

function persisted(overrides = {}) {
  return { businessId:900011, deploymentId:D, revision:7, nativeScope:W, managerRoleId:M,
    hotelOwnerRoleId:H, ownerUserId:U, ...overrides };
}

const env = { AVA_NATIVE_QA:'true', SERVER_URL:'https://recipe-qa-900011.crm.meludtech.tech' };

test('successful native replay and rotation proof returns only safe booleans and ids', async () => {
  const { ops, state } = fixture();
  const result = await runProbe(context, ops);
  assert.equal(result.qa_only, true);
  assert.equal(result.buyer_acceptance, false);
  assert.deepEqual(result.ids, { initial_native_key_id:K1, rotated_native_key_id:K2, runtime_role_id:R });
  assert.ok(Object.values(result.checks).every(Boolean));
  const output = JSON.stringify(result);
  assert.equal(output.includes(TOKEN1), false);
  assert.equal(output.includes(TOKEN2), false);
  assert.equal(output.includes('sha256'), false);
  assert.equal(state.generation, 5);
  assert.equal(state.oldRevoked, true);
  const rotate = state.calls.find(call => call[0] === 'rotate');
  assert.equal(rotate[2], NOW + 23 * DAY + 1);
  assert.deepEqual(state.calls.filter(call => call[0] === 'validate').map(call => call[1]), [K1, K2, K1]);
});

test('QA fence accepts only exact recipe config and persisted bootstrap scope', () => {
  const value = validateQa({ businessId:900011, deploymentId:D, revision:7,
    hostname:'recipe-qa-900011.crm.meludtech.tech' }, persisted(), env);
  assert.deepEqual(value, context);
  assert.equal(Object.isFrozen(value), true);
  const second = validateQa({ businessId:900012, deploymentId:D, revision:7,
    hostname:'recipe-qa-900012.crm.meludtech.tech' }, persisted({ businessId:900012 }),
  { AVA_NATIVE_QA:'true', SERVER_URL:'https://recipe-qa-900012.crm.meludtech.tech' });
  assert.equal(second.businessId, 900012);
});

test('QA fence rejects non-QA flag, business, hostname, or public URL', () => {
  const base = { businessId:900011, deploymentId:D, revision:7, hostname:'recipe-qa-900011.crm.meludtech.tech' };
  const cases = [
    [base, { ...env, AVA_NATIVE_QA:'false' }],
    [{ ...base, businessId:42, hostname:'recipe-qa-42.crm.meludtech.tech' }, { ...env, SERVER_URL:'https://recipe-qa-42.crm.meludtech.tech' }],
    [{ ...base, businessId:900012 }, env],
    [{ ...base, hostname:'customer-900011.crm.meludtech.tech' }, { ...env, SERVER_URL:'https://customer-900011.crm.meludtech.tech' }],
    [base, { ...env, SERVER_URL:'http://127.0.0.1:3000' }],
  ];
  for (const [config, candidateEnv] of cases) assert.throws(() => validateQa(config, persisted(), candidateEnv), { code:'QA_SCOPE_REQUIRED' });
});

test('QA fence rejects mismatched, malformed, or expanded persisted scope', () => {
  const config = { businessId:900011, deploymentId:D, revision:7, hostname:'recipe-qa-900011.crm.meludtech.tech' };
  for (const value of [
    persisted({ businessId:900012 }), persisted({ deploymentId:W }), persisted({ revision:8 }),
    persisted({ nativeScope:'not-a-uuid' }), persisted({ revision:0 }), { ...persisted(), unexpected:true },
  ]) assert.throws(() => validateQa(config, value, env), { code:'QA_CONTEXT_SCOPE_INVALID' });
});

test('schema replay must be ready and create no object or field', async () => {
  for (const replay of [
    { ready:false, objectsCreated:0, fieldsCreated:0 },
    { ready:true, objectsCreated:1, fieldsCreated:0 },
    { ready:true, objectsCreated:0, fieldsCreated:1 },
  ]) {
    const { ops } = fixture();
    ops.schemaReplay = async () => replay;
    await assert.rejects(runProbe(context, ops), { code:'QA_SCHEMA_REPLAY_NOT_IDEMPOTENT' });
  }
});

test('runtime replay must retain both key identity and protected file contents', async () => {
  const changedKey = fixture();
  changedKey.ops.runtimeReplay = async () => ({ nativeKeyId:K2, roleId:R, expiresAt:new Date(NOW + 30 * DAY) });
  await assert.rejects(runProbe(context, changedKey.ops), { code:'QA_RUNTIME_KEY_SCOPE_INVALID' });

  const changedFile = fixture();
  const originalReplay = changedFile.ops.runtimeReplay;
  changedFile.ops.runtimeReplay = async value => { const result = await originalReplay(value); changedFile.state.token = TOKEN2; return result; };
  await assert.rejects(runProbe(context, changedFile.ops), { code:'QA_RUNTIME_REPLAY_NOT_IDEMPOTENT' });
});

test('signature, current API key, ledger, and exact role scope fail closed', async () => {
  const cases = [
    ['QA_RUNTIME_SIGNATURE_INVALID', ops => { ops.verifySignature = async () => ({ type:'ACCESS', jti:K1, sub:W, workspaceId:W }); }],
    ['QA_RUNTIME_KEY_SCOPE_INVALID', ops => { ops.validateKey = async () => ({ id:K1, workspaceId:D, revokedAt:null }); }],
    ['QA_RUNTIME_KEY_SCOPE_INVALID', ops => { ops.getLedger = async () => ({ deploymentId:D, workspaceId:W, revision:8, disabled:false, roleId:R, activeKeyId:K1, activeGeneration:4 }); }],
    ['QA_RUNTIME_ROLE_SCOPE_INVALID', ops => { ops.roleForKey = async () => M; }],
    ['QA_RUNTIME_ROLE_SCOPE_INVALID', ops => { ops.roleSafe = () => false; }],
  ];
  for (const [code, alter] of cases) {
    const { ops } = fixture(); alter(ops);
    await assert.rejects(runProbe(context, ops), { code });
  }
});

test('rotation must change key and file, validate new active key, and revoke old key', async () => {
  const sameKey = fixture();
  sameKey.ops.rotate = async () => ({ nativeKeyId:K1, roleId:R, expiresAt:new Date(NOW + 60 * DAY) });
  await assert.rejects(runProbe(context, sameKey.ops), { code:'QA_ROTATION_NOT_PROVEN' });

  const sameFile = fixture();
  sameFile.ops.rotate = async () => { sameFile.state.currentKey=K2; sameFile.state.generation++; sameFile.state.oldRevoked=true; return { nativeKeyId:K2, roleId:R, expiresAt:new Date(NOW + 60 * DAY) }; };
  await assert.rejects(runProbe(context, sameFile.ops), { code:'QA_ROTATION_NOT_PROVEN' });

  const inactiveNew = fixture();
  const validate = inactiveNew.ops.validateKey;
  inactiveNew.ops.validateKey = async (id, workspace) => id === K2 ? ({ id, workspaceId:workspace, revokedAt:new Date() }) : validate(id, workspace);
  await assert.rejects(runProbe(context, inactiveNew.ops), { code:'QA_ROTATION_READBACK_INVALID' });

  const oldActive = fixture();
  oldActive.ops.findKey = async id => ({ id, workspaceId:W, revokedAt:null });
  await assert.rejects(runProbe(context, oldActive.ops), { code:'QA_ROTATION_READBACK_INVALID' });

  const nativeStillAcceptsOld = fixture();
  nativeStillAcceptsOld.ops.validateKey = async (id, workspace) => ({ id, workspaceId:workspace, revokedAt:id === K1 && nativeStillAcceptsOld.state.oldRevoked ? new Date() : null });
  await assert.rejects(runProbe(context, nativeStillAcceptsOld.ops), { code:'QA_ROTATION_READBACK_INVALID' });
});

test('rotation uses only a future virtual clock inside the threshold', async () => {
  for (const expiresAt of [new Date(NOW + 7 * DAY), new Date('invalid')]) {
    const { ops } = fixture();
    ops.runtimeReplay = async () => ({ nativeKeyId:K1, roleId:R, expiresAt });
    await assert.rejects(runProbe(context, ops), { code:'QA_ROTATION_CLOCK_INVALID' });
  }
});

test('foreign revision must be refused and cannot mutate active generation or file', async () => {
  const accepted = fixture();
  accepted.ops.foreignRevision = async () => undefined;
  await assert.rejects(runProbe(context, accepted.ops), { code:'QA_FOREIGN_REVISION_ACCEPTED' });

  const mutated = fixture();
  mutated.ops.foreignRevision = async () => { mutated.state.token=TOKEN1; mutated.state.generation++; throw fenced(); };
  await assert.rejects(runProbe(context, mutated.ops), { code:'QA_FOREIGN_REVISION_MUTATED' });
});

test('secret file must remain a regular 0600 non-symlink before and after rotation', async () => {
  for (const stat of [
    { regular:true, symlink:false, mode:0o100644 },
    { regular:false, symlink:false, mode:0o100600 },
    { regular:true, symlink:true, mode:0o100600 },
  ]) {
    const { ops, state } = fixture(); state.stat = stat;
    await assert.rejects(runProbe(context, ops), { code:'QA_RUNTIME_FILE_UNSAFE' });
  }
  const after = fixture();
  const rotate = after.ops.rotate;
  after.ops.rotate = async (...args) => { const result=await rotate(...args); after.state.stat.mode=0o100644; return result; };
  await assert.rejects(runProbe(context, after.ops), { code:'QA_ROTATION_NOT_PROVEN' });
});

test('real file readers reject symlinks, unsafe mode, bad JSON, and token delimiters', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-schema-key-probe-'));
  try {
    const json = path.join(directory, 'bootstrap.json');
    fs.writeFileSync(json, JSON.stringify(persisted()), { mode:0o600 });
    assert.deepEqual(readJson(json), persisted());
    fs.writeFileSync(json, '{', { mode:0o600 });
    assert.throws(() => readJson(json), { code:'QA_CONTEXT_INVALID' });
    fs.writeFileSync(json, JSON.stringify(persisted()), { mode:0o600 });
    fs.chmodSync(json, 0o644);
    assert.throws(() => readJson(json), { code:'QA_CONTEXT_INVALID' });

    const secret = path.join(directory, 'runtime.key');
    fs.writeFileSync(secret, TOKEN1, { mode:0o600 });
    assert.equal(readSecret(secret), TOKEN1);
    fs.chmodSync(secret, 0o644);
    assert.throws(() => readSecret(secret), { code:'QA_RUNTIME_FILE_UNSAFE' });
    fs.chmodSync(secret, 0o600);
    fs.writeFileSync(secret, `${TOKEN1}\n`, { mode:0o600 });
    assert.throws(() => readSecret(secret), { code:'QA_RUNTIME_FILE_UNSAFE' });
    const link = path.join(directory, 'runtime-link.key');
    fs.symlinkSync(secret, link);
    assert.throws(() => readSecret(link), { code:'QA_RUNTIME_FILE_UNSAFE' });
  } finally {
    fs.rmSync(directory, { recursive:true, force:true });
  }
});

test('failure output never includes exception messages, stack, token, or credential digest', () => {
  const error = Object.assign(new Error(`${TOKEN1} sha256=secret`), { code:'not safe', stack:`${TOKEN2}\nprivate` });
  assert.equal(safeFailure(error), 'QA_SCHEMA_KEY_FAILED\n');
  assert.equal(safeFailure(fenced()), 'AVA_RUNTIME_KEY_FENCED\n');
});
