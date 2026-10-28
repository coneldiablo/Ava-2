'use strict';
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const deny = () => Object.assign(new Error('AVA_MODULE_ACCESS_DENIED'), { code: 'AVA_MODULE_ACCESS_DENIED' });

class GatewayStore {
    constructor({ filename, encryptionKey, deploymentId, businessId, module }) {
        if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32
            || !/^[0-9a-f-]{36}$/.test(deploymentId) || !Number.isSafeInteger(businessId) || businessId < 1
            || !['twenty', 'onyx'].includes(module)) throw deny();
        this.key = encryptionKey;
        this.businessId = businessId;
        this.module = module;
        this.scope = `${businessId}:${module}:${deploymentId}`;
        this.db = new Database(filename);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');
        this.db.exec(`CREATE TABLE IF NOT EXISTS ava_gateway_owner (id INTEGER PRIMARY KEY CHECK(id=1), scope TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ava_gateway_flows (
                stateHash TEXT PRIMARY KEY, cookieHash TEXT NOT NULL, verifier TEXT NOT NULL, expiresAt INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS ava_gateway_sessions (
                tokenHash TEXT PRIMARY KEY, bindingId TEXT NOT NULL UNIQUE, brokerHandle TEXT NOT NULL,
                nativeCookie TEXT NOT NULL, nativeSessionId TEXT NOT NULL, principalJson TEXT NOT NULL,
                expiresAt INTEGER NOT NULL, revokedAt INTEGER);
            CREATE INDEX IF NOT EXISTS ava_gateway_sessions_expiry ON ava_gateway_sessions(expiresAt);`);
        try { this.db.transaction(() => {
            this.db.prepare('INSERT OR IGNORE INTO ava_gateway_owner VALUES (1,?)').run(this.scope);
            if (this.db.prepare('SELECT scope FROM ava_gateway_owner WHERE id=1').get().scope !== this.scope) throw deny();
        }).immediate(); } catch (error) { this.db.close(); throw error; }
    }
    seal(value, row, field) {
        const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from(`ava:gateway:v1:${this.scope}:${row}:${field}`));
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
    }
    open(value, row, field) {
        try {
            const parts = value.split('.').map(part => Buffer.from(part, 'base64url'));
            if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16) throw deny();
            const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, parts[0]);
            decipher.setAAD(Buffer.from(`ava:gateway:v1:${this.scope}:${row}:${field}`));
            decipher.setAuthTag(parts[1]);
            return Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString('utf8');
        } catch (_) { throw deny(); }
    }
    beginFlow() {
        const state = token(), cookie = token(), verifier = token(), stateHash = hash(state);
        this.db.transaction(() => {
            this.db.prepare('DELETE FROM ava_gateway_flows WHERE expiresAt<=?').run(Date.now());
            // Bound unauthenticated flow allocation on a single deployment.
            if (this.db.prepare('SELECT count(*) AS n FROM ava_gateway_flows').get().n >= 256) throw deny();
            this.db.prepare('INSERT INTO ava_gateway_flows VALUES (?,?,?,?)').run(stateHash, hash(cookie),
                this.seal(verifier, stateHash, 'verifier'), Date.now() + 60000);
        }).immediate();
        return { state, cookie, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
    }
    consumeFlow(state, cookie) {
        if (!tokenPattern.test(state || '') || !tokenPattern.test(cookie || '')) throw deny();
        return this.db.transaction(() => {
            const row = this.db.prepare('SELECT * FROM ava_gateway_flows WHERE stateHash=? AND expiresAt>?').get(hash(state), Date.now());
            if (!row || !crypto.timingSafeEqual(Buffer.from(row.cookieHash), Buffer.from(hash(cookie)))) throw deny();
            const verifier = this.open(row.verifier, row.stateHash, 'verifier');
            this.db.prepare('DELETE FROM ava_gateway_flows WHERE stateHash=?').run(row.stateHash);
            return verifier;
        }).immediate();
    }
    saveSession({ grant, nativeCookie, nativeSessionId }) {
        if (grant.businessId !== this.businessId || grant.module !== this.module
            || !['hotel_owner','manager'].includes(grant.role) || !Number.isSafeInteger(grant.revision)
            || typeof grant.subject !== 'string' || grant.subject.length > 256
            || typeof grant.nativeScope !== 'string' || grant.nativeScope.length > 128
            || !/^[0-9a-f-]{36}$/.test(grant.userId || '') || !/^[A-Za-z0-9_-]{1,128}$/.test(grant.nativeUserId || '')
            || !tokenPattern.test(grant.sessionHandle || '') || !/^[0-9a-f-]{36}$/.test(grant.bindingId || '')
            || typeof nativeCookie !== 'string' || !/^[A-Za-z0-9_-]+=[A-Za-z0-9._~-]+$/.test(nativeCookie)
            || typeof nativeSessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(nativeSessionId)
            || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now()
            || grant.expiresAt > Date.now() + 3600000) throw deny();
        const value = token(), tokenHash = hash(value);
        const { sessionHandle, correlation_id, ...principal } = grant;
        this.db.prepare('INSERT INTO ava_gateway_sessions VALUES (?,?,?,?,?,?,?,NULL)').run(tokenHash,
            grant.bindingId, this.seal(sessionHandle, grant.bindingId, 'broker'),
            this.seal(nativeCookie, grant.bindingId, 'native'), nativeSessionId,
            JSON.stringify(principal), grant.expiresAt);
        return value;
    }
    session(value) {
        if (!tokenPattern.test(value || '')) throw deny();
        const row = this.db.prepare('SELECT * FROM ava_gateway_sessions WHERE tokenHash=? AND revokedAt IS NULL AND expiresAt>?').get(hash(value), Date.now());
        if (!row) throw deny();
        return { ...JSON.parse(row.principalJson),
            sessionHandle: this.open(row.brokerHandle, row.bindingId, 'broker'),
            nativeCookie: this.open(row.nativeCookie, row.bindingId, 'native'), nativeSessionId: row.nativeSessionId };
    }
    revoke(bindingId) {
        this.db.prepare('UPDATE ava_gateway_sessions SET revokedAt=COALESCE(revokedAt,?) WHERE bindingId=?').run(Date.now(), bindingId);
    }
    close() { this.db.close(); }
}
module.exports = { GatewayStore, tokenPattern, deny };
