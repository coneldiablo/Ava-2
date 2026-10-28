'use strict';
const http = require('node:http');
const https = require('node:https');
const { deny } = require('./store.cjs');

function peerClient({ origin, peerSecret, adapterId }) {
    const base = new URL(origin);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
        || base.pathname !== '/' || base.search || base.hash) throw deny();
    return (path, body) => new Promise((resolve, reject) => {
        if (!/^\/v1\/[a-z/-]+$/.test(path)) return reject(deny());
        let secret;
        try { secret = peerSecret(); } catch (_) { return reject(deny()); }
        if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return reject(deny());
        const data = Buffer.from(JSON.stringify(body));
        const transport = base.protocol === 'https:' ? https : http;
        const req = transport.request(new URL(path, base), { method: 'POST', timeout: 3000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length,
                Authorization: `Bearer ${secret}`, ...(adapterId ? { 'X-AVA-Adapter-ID': adapterId } : {}) } }, res => {
            let size = 0; const chunks = [];
            res.on('data', chunk => {
                size += chunk.length;
                if (size > 16384) { res.destroy(); reject(deny()); }
                else chunks.push(chunk);
            });
            res.on('error', () => reject(deny()));
            res.on('end', () => {
                // Redirects are never followed with peer credentials.
                if (res.statusCode !== 200) return reject(deny());
                try {
                    const value = JSON.parse(Buffer.concat(chunks));
                    if (!value || typeof value !== 'object' || Array.isArray(value)) throw deny();
                    resolve(value);
                } catch (_) { reject(deny()); }
            });
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => reject(deny()));
        req.end(data);
    });
}
module.exports = { peerClient };
