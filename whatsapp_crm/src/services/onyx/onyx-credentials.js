const crypto = require('crypto');
const DB = require('../database.service');

function fail(code) { return Object.assign(new Error(code), { code, retryable: false }); }
function key() {
    const raw = String(process.env.ONYX_CREDENTIALS_MASTER_KEY || '').trim();
    const value = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (value.length !== 32) throw fail('ONYX_CREDENTIALS_MASTER_KEY_REQUIRED');
    return value;
}
function aad(businessId, ref) { return Buffer.from(`ava:onyx:${businessId}:${ref}:v2`); }
function seal(token, businessId, ref) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    cipher.setAAD(aad(businessId, ref));
    const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return ['v2', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}
function open(value, businessId, ref) {
    try {
        const [version, iv, tag, body] = String(value).split('.');
        if (version !== 'v2') throw fail('ONYX_CREDENTIALS_INVALID');
        const cipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
        cipher.setAAD(aad(businessId, ref));
        cipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([cipher.update(Buffer.from(body, 'base64url')), cipher.final()]).toString('utf8');
    } catch (_) { throw fail('ONYX_CREDENTIALS_INVALID'); }
}
function ensureSchema() {
    DB.run(`CREATE TABLE IF NOT EXISTS onyx_tenant_credentials (
        env_ref TEXT PRIMARY KEY, token TEXT NOT NULL DEFAULT '', business_id INTEGER NOT NULL,
        token_encrypted TEXT, enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    const cols = new Set(DB.all('PRAGMA table_info(onyx_tenant_credentials)').map(row => row.name));
    for (const [name, type] of [['token_encrypted', 'TEXT'], ['enabled', 'INTEGER NOT NULL DEFAULT 1'], ['revision', 'INTEGER NOT NULL DEFAULT 1']]) {
        if (!cols.has(name)) DB.run(`ALTER TABLE onyx_tenant_credentials ADD COLUMN ${name} ${type}`);
    }
    // Legacy generated strings were never native keys. Revoke them and erase
    // plaintext, not silently promote them into valid managed credentials.
    DB.run(`UPDATE onyx_tenant_credentials SET token='', enabled=0, revision=revision+1
        WHERE token LIKE 'sk-onyx-tenant-%'`);
    for (const row of DB.all("SELECT * FROM onyx_tenant_credentials WHERE token != ''")) {
        const encrypted = seal(row.token, row.business_id, row.env_ref);
        DB.run("UPDATE onyx_tenant_credentials SET token='', token_encrypted=?, revision=revision+1 WHERE env_ref=? AND business_id=?",
            [encrypted, row.env_ref, row.business_id]);
    }
}
function save(businessId, token, ref = `ONYX_API_KEY_HOTEL_${businessId}`) {
    ensureSchema();
    if (!Number.isSafeInteger(businessId) || businessId < 1 || ref !== `ONYX_API_KEY_HOTEL_${businessId}` ||
        !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [businessId])) throw fail('ONYX_CREDENTIAL_SCOPE_INVALID');
    if (typeof token !== 'string' || !token.trim() || token.startsWith('sk-onyx-tenant-')) throw fail('ONYX_NATIVE_CREDENTIAL_REQUIRED');
    const encrypted = seal(token, businessId, ref);
    DB.run(`INSERT INTO onyx_tenant_credentials(env_ref,business_id,token,token_encrypted,enabled)
        VALUES (?,?,'',?,1) ON CONFLICT(env_ref) DO UPDATE SET token='', token_encrypted=excluded.token_encrypted,
        enabled=1, revision=revision+1 WHERE business_id=excluded.business_id`, [ref,businessId,encrypted]);
    const row = DB.get('SELECT business_id FROM onyx_tenant_credentials WHERE env_ref=?', [ref]);
    if (row?.business_id !== businessId) throw fail('ONYX_CREDENTIAL_SCOPE_INVALID');
    delete process.env[ref];
    return ref;
}
function resolve(businessId, ref = `ONYX_API_KEY_HOTEL_${businessId}`) {
    ensureSchema();
    const row = DB.get('SELECT * FROM onyx_tenant_credentials WHERE env_ref=?', [ref]);
    if (!row) return null;
    if (row.business_id !== businessId || !row.enabled || !row.token_encrypted
        || !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [businessId])) throw fail('ONYX_CREDENTIAL_UNAVAILABLE');
    return open(row.token_encrypted, businessId, ref);
}
function revoke(businessId) {
    ensureSchema();
    DB.run("UPDATE onyx_tenant_credentials SET enabled=0, token='', token_encrypted=NULL, revision=revision+1 WHERE business_id=?", [businessId]);
    delete process.env[`ONYX_API_KEY_HOTEL_${businessId}`];
}
module.exports = { ensureSchema, save, resolve, revoke, seal, open };
