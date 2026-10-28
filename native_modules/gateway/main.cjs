'use strict';
const fs = require('node:fs');
const { GatewayStore, deny } = require('./store.cjs');
const { peerClient } = require('./peer-client.cjs');
const { createGateway } = require('./server.cjs');
const { applyNativeScope } = require('./runtime-config.cjs');

// Credentials are mounted as files, never command arguments or env values.
// Peer files are re-read on each call to allow atomic credential replacement.
function secretFile(filename) {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o037) || stat.size > 256) throw deny();
        const value = fs.readFileSync(fd, 'utf8').trim();
        if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw deny();
        return value;
    } finally { fs.closeSync(fd); }
}
function start() {
    process.umask(0o077);
    const config = applyNativeScope(JSON.parse(fs.readFileSync('/run/ava/gateway.json', 'utf8')));
    if (config.runtimeEnabled !== undefined && typeof config.runtimeEnabled !== 'boolean') throw deny();
    const secretRoot = '/run/ava/secrets';
    const store = new GatewayStore({ ...config, filename: '/var/lib/ava-gateway/sessions.sqlite',
        encryptionKey: Buffer.from(secretFile(`${secretRoot}/encryption-key`), 'base64url') });
    const broker = peerClient({ origin: config.brokerOrigin, adapterId: config.adapterId,
        peerSecret: () => secretFile(`${secretRoot}/broker-peer`) });
    const native = peerClient({ origin: config.nativeOrigin,
        peerSecret: () => secretFile(`${secretRoot}/native-peer`) });
    const gateway = createGateway({ config, store, broker, native,
        nativePeerSecret: () => secretFile(`${secretRoot}/native-peer`),
        ...(config.runtimeEnabled === true ? { runtimePeerSecret: () => {
            const value = secretFile(`${secretRoot}/runtime-peer`);
            if (value === secretFile(`${secretRoot}/broker-peer`) || value === secretFile(`${secretRoot}/native-peer`)) throw deny();
            return value;
        } } : {}) });
    let running = false;
    const timer = setInterval(async () => {
        if (running) return;
        running = true;
        try { for (let i = 0; i < 16; i++) if (!await gateway.cleanupOnce()) break; }
        catch (_) { /* durable broker queue will retry; never print credentials or responses */ }
        finally { running = false; }
    }, 1000);
    timer.unref();
    gateway.server.listen(4080, '0.0.0.0');
    // No public reverse-proxy route targets this port. Compose may publish it
    // only on loopback for the host-network AVA engine after native admission.
    if (gateway.runtimeServer) gateway.runtimeServer.listen(4081, '0.0.0.0');
    const stop = () => { clearInterval(timer);
        const listeners = [gateway.server, gateway.runtimeServer].filter(Boolean);
        let remaining = listeners.length;
        for (const listener of listeners) listener.close(() => { if (--remaining === 0) { store.close(); process.exit(0); } });
        setTimeout(() => process.exit(0), 10000).unref(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    return gateway;
}
if (require.main === module) {
    try { start(); } catch (_) { process.stderr.write('AVA_GATEWAY_START_FAILED\n'); process.exitCode = 1; }
}
module.exports = { secretFile, start };
