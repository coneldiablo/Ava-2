'use strict';
// Fixed native initialization steps. Input and database scope are verified by
// bootstrap before any child process; credentials are never command arguments.
const { spawnSync } = require('node:child_process');
const { configFrom } = require('./bootstrap.cjs');
const ROOT = '/app/packages/twenty-server';
function initialize({ run = spawnSync } = {}) {
  configFrom();
  const commands = [
    ['dist/database/scripts/setup-db.js'],
    ['dist/command/command', 'run-instance-commands', '--force', '--include-slow'],
    ['dist/ava-native/bootstrap.cjs'],
  ];
  for (let index = 0; index < commands.length; index++) {
    const result = run(process.execPath, commands[index], { cwd: ROOT, env: { ...process.env,
      NODE_OPTIONS: '--max-old-space-size=768', AVA_NATIVE_ADAPTER_ENABLED: 'false' },
      // Native tooling may print SQL or configuration on failure. Fail with a
      // stage code rather than retain or relay its raw output.
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024, timeout: 150000 });
    if (result.error || result.status !== 0) {
      // Only our constrained diagnostic line may leave the subprocess. Raw
      // SQL/config/error messages are never retained or forwarded.
      const code = index === 2 && String(result.stderr || '').match(/^AVA_NATIVE_BOOTSTRAP_FAILED:type=[A-Za-z0-9]{1,41} code=([A-Z0-9_]{1,64})$/m)?.[1];
      throw new Error(`AVA_INITIALIZER_STAGE_${index + 1}_FAILED${code ? ':' + code : ''}`);
    }
  }
}
if (require.main === module) {
  try { initialize(); }
  catch (error) {
    const code = /^AVA_INITIALIZER_STAGE_[1-3]_FAILED(?::[A-Z0-9_]{1,64})?$/.test(error.message) ? error.message : 'AVA_INITIALIZER_CONFIG_INVALID';
    process.stderr.write(code + '\n'); process.exitCode = 1;
  }
}
module.exports = { initialize };
