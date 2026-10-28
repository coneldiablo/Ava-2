'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { test, describe } = require('node:test');

function loadInitializer() {
  const original = Module._load;
  const bootstrap = require.resolve('./bootstrap.cjs');
  delete require.cache[require.resolve('./initializer.cjs')];
  Module._load = function(request, parent, isMain) {
    if (Module._resolveFilename(request, parent, isMain) === bootstrap) return { configFrom() {} };
    return original.apply(this, arguments);
  };
  try { return require('./initializer.cjs'); } finally { Module._load = original; }
}
const { initialize } = loadInitializer();
const expectFailure = (run, pattern) => assert.throws(run, error => pattern.test(error.message));

describe('Twenty native initializer safety', () => {
  test('runs exactly the fixed three commands without credentials in argv or output', () => {
    const calls = []; const secret = 'initializer-secret-value';
    initialize({ run: (file, args, options) => { calls.push({ file, args, options }); return { status: 0, stdout: Buffer.from(secret), stderr: Buffer.from('') }; } });
    assert.deepEqual(calls.map(call => call.args), [
      ['dist/database/scripts/setup-db.js'],
      ['dist/command/command', 'run-instance-commands', '--force', '--include-slow'],
      ['dist/ava-native/bootstrap.cjs'],
    ]);
    for (const call of calls) { assert.equal(call.args.includes(secret), false); assert.equal(call.options.stdio[1], 'pipe'); assert.equal(call.options.stdio[2], 'pipe'); }
  });

  test('converts each failed stage to a stable stage error and discards malicious stderr', () => {
    for (const stage of [0, 1]) {
      const calls = [];
      expectFailure(() => initialize({ run: (...args) => { calls.push(args); return { status: calls.length === stage + 1 ? 1 : 0, stderr: 'DROP TABLE; Bearer top-secret' }; } }),
        new RegExp(`^AVA_INITIALIZER_STAGE_${stage + 1}_FAILED$`));
      assert.equal(calls.length, stage + 1);
    }
    let count = 0;
    expectFailure(() => initialize({ run: () => ({ status: ++count === 3 ? 1 : 0, stderr: 'AVA_NATIVE_BOOTSTRAP_FAILED:type=ENOENT code=ENOENT\nsecret' }) }),
      /^AVA_INITIALIZER_STAGE_3_FAILED:ENOENT$/);
    count = 0;
    expectFailure(() => initialize({ run: () => ({ status: ++count === 3 ? 1 : 0, stderr: 'AVA_NATIVE_BOOTSTRAP_FAILED:type=ENOENT code=../../secret' }) }),
      /^AVA_INITIALIZER_STAGE_3_FAILED$/);
  });

  test('treats spawn errors and output overflow as failed stages without leaking details', () => {
    expectFailure(() => initialize({ run: () => ({ error: new Error('ENOENT /private/token'), status: null, stderr: '' }) }), /^AVA_INITIALIZER_STAGE_1_FAILED$/);
    expectFailure(() => initialize({ run: (_file, _args, options) => { assert.equal(options.maxBuffer, 2 * 1024 * 1024); return { status: 1, stderr: 'x'.repeat(options.maxBuffer + 1) }; } }), /^AVA_INITIALIZER_STAGE_1_FAILED$/);
  });
});
