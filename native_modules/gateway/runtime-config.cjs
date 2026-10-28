'use strict';
const fs = require('node:fs');
const { deny } = require('./store.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The native initializer publishes an identity-only manifest in its own volume.
// No bootstrap/DB credential is mounted in the gateway. The configured path is
// fixed so it cannot be used to read an arbitrary secret or another contour.
function applyNativeScope(config) {
    if (!config.nativeScopeFile) return config;
    if (config.module !== 'twenty' || config.nativeScopeFile !== '/run/ava-bootstrap/bootstrap.json') throw deny();
    let fd;
    try {
        fd = fs.openSync(config.nativeScopeFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 4096 || stat.mode & 0o077 || ![0, process.getuid()].includes(stat.uid)) throw deny();
        const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (value.businessId !== config.businessId || value.deploymentId !== config.deploymentId
            || value.revision !== config.revision || !UUID.test(value.nativeScope || '')
            || (config.nativeScope && config.nativeScope !== value.nativeScope)) throw deny();
        return { ...config, nativeScope: value.nativeScope };
    } catch (_) { throw deny(); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = { applyNativeScope };
