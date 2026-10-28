'use strict';
const fs = require('node:fs');
const { AdapterError } = require('./adapter.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function applyBootstrapContext(env = process.env) {
  if (!env.AVA_BOOTSTRAP_CONTEXT_FILE) return env; // Existing explicitly configured contour.
  let fd;
  try {
    fd = fs.openSync(env.AVA_BOOTSTRAP_CONTEXT_FILE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || stat.mode & 0o077 || ![0, process.getuid()].includes(stat.uid)) throw new Error();
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (value.businessId !== Number(env.AVA_BUSINESS_ID) || value.deploymentId !== env.AVA_DEPLOYMENT_ID
        || value.revision !== Number(env.AVA_DEPLOYMENT_REVISION)) throw new Error();
    const fields = { AVA_NATIVE_SCOPE: 'nativeScope', AVA_NATIVE_OWNER_ROLE_ID: 'hotelOwnerRoleId', AVA_NATIVE_MANAGER_ROLE_ID: 'managerRoleId' };
    for (const [name, field] of Object.entries(fields)) {
      if (!UUID.test(value[field] || '') || (env[name] && env[name] !== value[field])) throw new Error();
    }
    for (const [name, field] of Object.entries(fields)) env[name] = value[field];
    return env;
  } catch (_) { throw new AdapterError('native_bootstrap_context_invalid', 503); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = { applyBootstrapContext };
