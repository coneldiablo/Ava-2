'use strict';
const crypto = require('crypto');
const DB = require('../database.service');
const initialized = new WeakSet();
const { capabilitiesForRole, roleOptions, teamRoles } = require('./role-policy');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const failure = (code, statusCode = 403) => Object.assign(new Error(code), { code, statusCode });

function ensureSchema() {
    if (!DB.db) throw failure('IDENTITY_STORAGE_UNAVAILABLE', 503);
    if (initialized.has(DB.db)) return;
    DB.db.exec(`
        CREATE TABLE IF NOT EXISTS ava_users (
            id TEXT PRIMARY KEY, subject TEXT UNIQUE, email TEXT NOT NULL,
            displayName TEXT NOT NULL DEFAULT '', platformRole TEXT NOT NULL DEFAULT 'customer'
                CHECK(platformRole IN ('customer','platform_admin')),
            businessQuota INTEGER NOT NULL DEFAULT 0 CHECK(businessQuota >= 0),
            enabled INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS ava_business_memberships (
            userId TEXT NOT NULL REFERENCES ava_users(id), businessId INTEGER NOT NULL REFERENCES instances(id),
            role TEXT NOT NULL CHECK(role IN ('hotel_owner','sales_lead','manager','observer')),
            enabled INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(userId,businessId)
        );
        CREATE TABLE IF NOT EXISTS ava_invitations (
            id TEXT PRIMARY KEY, tokenHash TEXT NOT NULL UNIQUE, userId TEXT NOT NULL REFERENCES ava_users(id),
            businessId INTEGER REFERENCES instances(id), role TEXT NOT NULL CHECK(role IN ('hotel_owner','sales_lead','manager','observer')),
            expiresAt INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
                CHECK(state IN ('pending','redeeming','consumed','revoked')),
            leaseToken TEXT, leasedUntil INTEGER, createdBy TEXT NOT NULL,
            createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS ava_owner_invitation_links (
            id TEXT PRIMARY KEY, tokenHash TEXT NOT NULL UNIQUE,
            label TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active'
                CHECK(state IN ('active','revoked')),
            createdBy TEXT NOT NULL, createdAtMs INTEGER NOT NULL,
            revokedAtMs INTEGER
        );
        CREATE TABLE IF NOT EXISTS ava_owner_invitation_uses (
            id TEXT PRIMARY KEY,
            linkId TEXT NOT NULL REFERENCES ava_owner_invitation_links(id),
            invitationId TEXT NOT NULL UNIQUE REFERENCES ava_invitations(id),
            userId TEXT NOT NULL REFERENCES ava_users(id),
            state TEXT NOT NULL DEFAULT 'pending'
                CHECK(state IN ('pending','completed','failed')),
            createdAtMs INTEGER NOT NULL, finishedAtMs INTEGER
        );
        CREATE INDEX IF NOT EXISTS ava_owner_invitation_uses_link_time
            ON ava_owner_invitation_uses(linkId,createdAtMs);
        CREATE TABLE IF NOT EXISTS ava_sessions (
            tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES ava_users(id),
            nativeSid TEXT, expiresAt INTEGER NOT NULL, revokedAt INTEGER,
            createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS ava_identity_outbox (
            id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES ava_users(id),
            action TEXT NOT NULL CHECK(action IN ('revoke_sessions','revoke_memberships')),
            state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
            nextAttemptAt INTEGER NOT NULL, lastErrorCode TEXT,
            createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS ava_sessions_user ON ava_sessions(userId,expiresAt);
        CREATE TABLE IF NOT EXISTS ava_logout_receipts (jtiHash TEXT PRIMARY KEY,expiresAt INTEGER NOT NULL);
    `);
    migrateRoleChecks();
    // Serialize additive column discovery with the ALTER to avoid two runtime
    // processes both deciding the same migration column is absent.
    DB.db.transaction(() => {
        const inviteColumns = new Set(DB.all('PRAGMA table_info(ava_invitations)').map(item => item.name));
        if (!inviteColumns.has('acceptanceMode')) DB.db.exec("ALTER TABLE ava_invitations ADD COLUMN acceptanceMode TEXT NOT NULL DEFAULT 'legacy' CHECK(acceptanceMode IN ('legacy','team'))");
        DB.db.exec(`CREATE TABLE IF NOT EXISTS ava_team_audit (
            id TEXT PRIMARY KEY,businessId INTEGER NOT NULL REFERENCES instances(id),
            actorUserId TEXT NOT NULL,action TEXT NOT NULL,targetUserId TEXT,invitationId TEXT,
            previousRole TEXT,role TEXT,createdAtMs INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS ava_team_audit_business ON ava_team_audit(businessId,createdAtMs);
            CREATE TABLE IF NOT EXISTS ava_team_invitation_delivery (
                invitationId TEXT PRIMARY KEY REFERENCES ava_invitations(id),tokenHash TEXT NOT NULL,
                attemptId TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL,
                lastAttemptAt INTEGER NOT NULL,errorCode TEXT);
            CREATE TABLE IF NOT EXISTS ava_team_email_verifications (
                id TEXT PRIMARY KEY,invitationId TEXT NOT NULL REFERENCES ava_invitations(id),
                invitationTokenHash TEXT NOT NULL,email TEXT NOT NULL,passwordEncrypted TEXT NOT NULL,
                codeHash TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,resendCount INTEGER NOT NULL DEFAULT 0,
                resendAfterMs INTEGER NOT NULL,expiresAtMs INTEGER NOT NULL,verifiedAtMs INTEGER,completedAtMs INTEGER,
                createdAtMs INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS ava_team_verifications_invitation ON ava_team_email_verifications(invitationId,createdAtMs);`);
        const columns = new Set(DB.all('PRAGMA table_info(ava_identity_outbox)').map(item => item.name));
        for (const [name, type] of [['leaseToken','TEXT'], ['leasedUntil','INTEGER'], ['keycloakRevoked','INTEGER NOT NULL DEFAULT 0']]) {
            if (!columns.has(name)) DB.db.exec(`ALTER TABLE ava_identity_outbox ADD COLUMN ${name} ${type}`);
        }
    }).immediate();
    initialized.add(DB.db);
}

// Rebuild the CHECK only, retaining extra drift columns, all rows, indexes and triggers.
// FK toggling is outside the transaction; integrity is checked before the atomic commit.
function migrateRoleChecks() {
    const tables = ['ava_business_memberships','ava_invitations'].map(name => ({name,
        sql: DB.get("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [name])?.sql}))
        .filter(table => table.sql && !table.sql.includes("'sales_lead'"));
    if (!tables.length) return;
    if (DB.db.inTransaction) throw failure('IDENTITY_MIGRATION_REQUIRES_TRANSACTION_BOUNDARY', 503);
    const foreignKeys = DB.db.pragma('foreign_keys', { simple: true });
    DB.db.pragma('foreign_keys = OFF');
    try {
        DB.db.transaction(() => {
            for (const {name} of tables) {
                // Another runtime may have migrated while this connection
                // waited for the writer lock. Read fresh DDL under that lock.
                const sql = DB.get("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",[name])?.sql;
                if (sql?.includes("'sales_lead'")) continue;
                const indexes = DB.all("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL", [name]);
                const temp = `${name}_roles_v2`;
                const ddl = sql.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`\[]?\w+["`\]]?/i, `CREATE TABLE ${temp}`)
                    .replace(/CHECK\s*\(\s*role\s+IN\s*\(\s*'hotel_owner'\s*,\s*'manager'\s*\)\s*\)/i,
                        "CHECK(role IN ('hotel_owner','sales_lead','manager','observer'))");
                if (!ddl.includes("'sales_lead'")) throw failure('IDENTITY_ROLE_MIGRATION_UNSUPPORTED', 503);
                DB.db.exec(ddl);
                const columns = DB.all(`PRAGMA table_info(${name})`).map(row => `"${row.name.replace(/"/g,'""')}"`).join(',');
                DB.db.exec(`INSERT INTO ${temp} (${columns}) SELECT ${columns} FROM ${name}; DROP TABLE ${name}; ALTER TABLE ${temp} RENAME TO ${name};`);
                for (const index of indexes) DB.db.exec(index.sql);
            }
            if (DB.all('PRAGMA foreign_key_check').length) throw failure('IDENTITY_MIGRATION_INTEGRITY_FAILED', 503);
        }).immediate();
    } finally { DB.db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`); }
}

function actor(userId) {
    ensureSchema();
    const user = DB.get('SELECT * FROM ava_users WHERE id=? AND enabled=1', [userId]);
    if (!user) throw failure('ACCOUNT_NOT_ACTIVE');
    const memberships = DB.all(`SELECT m.businessId,m.role FROM ava_business_memberships m
        JOIN instances i ON i.id=m.businessId WHERE m.userId=? AND m.enabled=1 AND i.isActive=1`, [userId]);
    return { userId, login: user.email, email: user.email, displayName: user.displayName, subject: user.subject, platformRole: user.platformRole,
        businessQuota: user.businessQuota, canCreateBusiness: user.platformRole==='platform_admin' || user.businessQuota>DB.get("SELECT COUNT(*) AS n FROM ava_business_memberships WHERE userId=? AND role='hotel_owner'",[userId]).n, memberships: memberships.map(item => ({...item,capabilities:capabilitiesForRole(item.role)})) };
}

function requirePlatformAdmin(current) {
    ensureSchema();
    if (current?.userId && DB.get('SELECT id FROM ava_users WHERE id=?', [current.userId])
        && actor(current.userId).platformRole !== 'platform_admin') throw failure('PLATFORM_ADMIN_REQUIRED');
    if (current?.platformRole !== 'platform_admin') throw failure('PLATFORM_ADMIN_REQUIRED');
}

function authorizeCapability(current, businessId, capability) {
    ensureSchema();
    const id = Number(businessId);
    if (!Number.isSafeInteger(id) || id < 1) throw failure('BUSINESS_SCOPE_REQUIRED', 400);
    if (current?.platformRole === 'platform_admin') {
        requirePlatformAdmin(current);
        if (!DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [id])) throw failure('BUSINESS_NOT_FOUND', 404);
        if (!capabilitiesForRole('hotel_owner').includes(capability)) throw failure('CAPABILITY_DENIED');
        return id;
    }
    const verified = actor(current?.userId);
    const membership = verified.memberships.find(item => item.businessId === id);
    if (!membership) throw failure('BUSINESS_ACCESS_DENIED');
    if (!membership.capabilities.includes(capability)) throw failure('CAPABILITY_DENIED');
    return id;
}

function authorizeBusiness(current, businessId, { owner = false } = {}) {
    try { return authorizeCapability(current, businessId, owner ? 'business.manage' : 'business.read'); }
    catch(error) { if (error.code==='CAPABILITY_DENIED') throw failure('BUSINESS_ACCESS_DENIED');throw error; }
}

function createInvitation(current, { email, businessId = null, role = 'hotel_owner', displayName = '' }) {
    ensureSchema();
    requirePlatformAdmin(current);
    const address = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254
        || !['hotel_owner',...teamRoles].includes(role)) throw failure('INVITATION_INVALID', 400);
    const scope = businessId == null ? null : authorizeBusiness(current, businessId);
    if (scope !== null && !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [scope])) throw failure('BUSINESS_NOT_FOUND', 404);
    if (scope === null && role !== 'hotel_owner') throw failure('INVITATION_BUSINESS_REQUIRED', 400);
    return DB.db.transaction(() => insertInvitation(current, { address, scope, role, displayName })).immediate();
}

function insertInvitation(current, { address, scope, role, displayName }) {
    // Email is invitation metadata, never proof to join an existing identity.
    if (DB.get('SELECT id FROM ava_users WHERE email=?', [address])) throw failure('ACCOUNT_ALREADY_EXISTS', 409);
    const userId = crypto.randomUUID(), invitationId = crypto.randomUUID(), token = random();
    const expiresAt = Date.now() + 86400000;
    DB.run('INSERT INTO ava_users(id,email,displayName,businessQuota,enabled) VALUES (?,?,?,?,0)',
        [userId, address, String(displayName).slice(0, 120), scope === null ? 1 : 0]);
    DB.run('INSERT INTO ava_invitations(id,tokenHash,userId,businessId,role,expiresAt,createdBy) VALUES (?,?,?,?,?,?,?)',
        [invitationId, hash(token), userId, scope, role, expiresAt, current.userId || 'break-glass']);
    return { invitationId, token, expiresInSeconds: 86400, expiresAt };
}

// A reusable owner link is a bearer capability to create a NEW customer only.
// Its token is returned once and is never stored or returned by the list API.
function createOwnerInvitationLink(current, { label } = {}) {
    ensureSchema();
    requirePlatformAdmin(current);
    const name = String(label || '').trim();
    if (!name || name.length > 80) throw failure('INVITATION_INVALID', 400);
    return DB.db.transaction(() => {
        const active = DB.get("SELECT COUNT(*) AS n FROM ava_owner_invitation_links WHERE state='active'").n;
        if (active >= 20) throw failure('OWNER_INVITATION_LIMIT', 409);
        const id = crypto.randomUUID(), token = random(), createdAtMs = Date.now();
        DB.run('INSERT INTO ava_owner_invitation_links(id,tokenHash,label,createdBy,createdAtMs) VALUES (?,?,?,?,?)',
            [id, hash(token), name, current.userId || 'break-glass', createdAtMs]);
        return { id, token, label: name, createdAtMs };
    }).immediate();
}

function listOwnerInvitationLinks(current) {
    ensureSchema();
    requirePlatformAdmin(current);
    reconcileOwnerInvitationUses();
    return DB.all(`SELECT l.id,l.label,l.state,l.createdBy,l.createdAtMs,l.revokedAtMs,
        COUNT(CASE WHEN u.state='completed' THEN 1 END) AS useCount
        FROM ava_owner_invitation_links l LEFT JOIN ava_owner_invitation_uses u ON u.linkId=l.id
        GROUP BY l.id ORDER BY l.createdAtMs DESC`);
}

function reconcileOwnerInvitationUses() {
    DB.db.transaction(() => {
        // The CRM may die after the worker commits but before its HTTP reply.
        // Audit from the durable child invitation rather than that reply.
        DB.run(`UPDATE ava_owner_invitation_uses SET state='completed',finishedAtMs=COALESCE(finishedAtMs,?)
            WHERE state!='completed' AND invitationId IN (
                SELECT i.id FROM ava_invitations i JOIN ava_users u ON u.id=i.userId
                WHERE i.state='consumed' AND u.enabled=1 AND u.subject IS NOT NULL)`, [Date.now()]);
        DB.run(`UPDATE ava_owner_invitation_uses SET state='failed',finishedAtMs=COALESCE(finishedAtMs,?)
            WHERE state='pending' AND invitationId IN (
                SELECT id FROM ava_invitations WHERE state='revoked' OR expiresAt<=?)`, [Date.now(), Date.now()]);
    }).immediate();
}

function revokeOwnerInvitationLink(current, id) {
    ensureSchema();
    requirePlatformAdmin(current);
    return DB.db.transaction(() => {
        const changed = DB.run("UPDATE ava_owner_invitation_links SET state='revoked',revokedAtMs=? WHERE id=? AND state='active'", [Date.now(), id]);
        if (changed.changes !== 1) throw failure('INVITATION_INVALID', 404);
        DB.run(`UPDATE ava_invitations SET state='revoked',leaseToken=NULL,leasedUntil=NULL
            WHERE id IN (SELECT invitationId FROM ava_owner_invitation_uses WHERE linkId=?) AND state IN ('pending','redeeming')`, [id]);
        DB.run(`UPDATE ava_owner_invitation_uses SET state='failed',finishedAtMs=?
            WHERE linkId=? AND state='pending'`, [Date.now(), id]);
    }).immediate();
}

function validOwnerLink(token) {
    ensureSchema();
    if (!/^[\w-]{43}$/.test(String(token || ''))) throw failure('INVITATION_INVALID', 400);
    const link = DB.get("SELECT id FROM ava_owner_invitation_links WHERE tokenHash=? AND state='active'", [hash(token)]);
    if (!link) throw failure('INVITATION_INVALID', 400);
    return link;
}

function beginOwnerInvitationUse(token, { email, displayName = '' } = {}) {
    ensureSchema();
    const address = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254
        || typeof displayName !== 'string' || displayName.length > 120) throw failure('INVITATION_INVALID', 400);
    return DB.db.transaction(() => {
        const link = validOwnerLink(token);
        const now = Date.now();
        // The window is per link and shared by all app/worker processes. It limits
        // account creation bursts without imposing a lifetime use limit.
        const recent = DB.get('SELECT COUNT(*) AS n FROM ava_owner_invitation_uses WHERE linkId=? AND createdAtMs>?',
            [link.id, now - 3600000]).n;
        if (recent >= 20) throw failure('IDENTITY_RATE_LIMITED', 429);
        const daily = DB.get('SELECT COUNT(*) AS n FROM ava_owner_invitation_uses WHERE linkId=? AND createdAtMs>?',
            [link.id, now - 86400000]).n;
        if (daily >= 50) throw failure('IDENTITY_RATE_LIMITED', 429);
        const matches = DB.all('SELECT * FROM ava_users WHERE lower(email)=? LIMIT 2', [address]);
        if (matches.length > 1) throw failure('ACCOUNT_ALREADY_EXISTS', 409);
        const existing = matches[0];
        let userId;
        if (existing) {
            const previous = DB.get(`SELECT u.* FROM ava_owner_invitation_uses u
                WHERE u.userId=? AND u.linkId=? ORDER BY u.createdAtMs DESC LIMIT 1`, [existing.id, link.id]);
            if (!previous || existing.enabled || previous.state === 'completed') throw failure('ACCOUNT_ALREADY_EXISTS', 409);
            if (previous.state === 'pending' && now - previous.createdAtMs < 120000) throw failure('INVITATION_IN_PROGRESS', 409);
            if (DB.get("SELECT id FROM ava_identity_outbox WHERE userId=? AND state!='done' LIMIT 1", [existing.id])) {
                throw failure('PREVIOUS_ACCESS_REVOCATION_PENDING', 409);
            }
            DB.run("UPDATE ava_invitations SET state='revoked',leaseToken=NULL,leasedUntil=NULL WHERE id=? AND state IN ('pending','redeeming')", [previous.invitationId]);
            DB.run("UPDATE ava_owner_invitation_uses SET state='failed',finishedAtMs=? WHERE id=? AND state='pending'", [now, previous.id]);
            userId = existing.id;
        } else {
            userId = crypto.randomUUID();
            DB.run('INSERT INTO ava_users(id,email,displayName,businessQuota,enabled) VALUES (?,?,?,?,0)',
                [userId, address, displayName.trim(), 1]);
        }
        const invitationId = crypto.randomUUID(), childToken = random(), useId = crypto.randomUUID();
        DB.run('INSERT INTO ava_invitations(id,tokenHash,userId,businessId,role,expiresAt,createdBy) VALUES (?,?,?,?,?,?,?)',
            [invitationId, hash(childToken), userId, null, 'hotel_owner', now + 120000, `owner-link:${link.id}`]);
        DB.run('INSERT INTO ava_owner_invitation_uses(id,linkId,invitationId,userId,createdAtMs) VALUES (?,?,?,?,?)',
            [useId, link.id, invitationId, userId, now]);
        return { invitationId, childToken, userId };
    }).immediate();
}

function failOwnerInvitationUse(invitationId) {
    ensureSchema();
    return finishOwnerInvitationUse(invitationId, true);
}

function finishOwnerInvitationUse(invitationId, abort = false) {
    ensureSchema();
    return DB.db.transaction(() => {
        const row = DB.get(`SELECT i.state AS invitationState,u.userId FROM ava_owner_invitation_uses u
            JOIN ava_invitations i ON i.id=u.invitationId WHERE u.invitationId=?`, [invitationId]);
        if (!row) throw failure('INVITATION_INVALID', 400);
        const user = DB.get('SELECT enabled,subject FROM ava_users WHERE id=?', [row.userId]);
        if (row.invitationState === 'consumed' && user?.enabled === 1 && user.subject) {
            DB.run("UPDATE ava_owner_invitation_uses SET state='completed',finishedAtMs=COALESCE(finishedAtMs,?) WHERE invitationId=?", [Date.now(), invitationId]);
            return true;
        }
        if (!abort) return false;
        DB.run("UPDATE ava_invitations SET state='revoked',leaseToken=NULL,leasedUntil=NULL WHERE id=? AND state IN ('pending','redeeming')", [invitationId]);
        DB.run("UPDATE ava_owner_invitation_uses SET state='failed',finishedAtMs=? WHERE invitationId=? AND state='pending'", [Date.now(), invitationId]);
        return false;
    }).immediate();
}

function activeOwnerUse(invitationId) {
    const use = DB.get(`SELECT l.state AS linkState,u.state AS useState FROM ava_owner_invitation_uses u
        JOIN ava_owner_invitation_links l ON l.id=u.linkId WHERE u.invitationId=?`, [invitationId]);
    if (use && (use.linkState !== 'active' || use.useState !== 'pending')) throw failure('INVITATION_LEASE_LOST', 409);
}

function auditTeam(current, businessId, action, {userId=null,invitationId=null,previousRole=null,role=null}={}) {
    DB.run('INSERT INTO ava_team_audit VALUES (?,?,?,?,?,?,?,?,?)',
        [crypto.randomUUID(),businessId,current.userId || 'break-glass',action,userId,invitationId,previousRole,role,Date.now()]);
}

function listBusinessTeam(current, businessId) {
    ensureSchema();
    const scope = authorizeCapability(current, businessId, 'team.read');
    const members = DB.all(`SELECT u.id AS userId,u.email,u.displayName,m.role,m.createdAt
        FROM ava_business_memberships m JOIN ava_users u ON u.id=m.userId
        WHERE m.businessId=? AND m.enabled=1 AND u.enabled=1
        ORDER BY CASE m.role WHEN 'hotel_owner' THEN 0 ELSE 1 END,u.email`, [scope])
        .map(member => ({...member,capabilities:capabilitiesForRole(member.role)}));
    const owner = current.platformRole === 'platform_admin' || members.some(m => m.userId===current.userId && m.role==='hotel_owner');
    const invitations = owner ? DB.all(`SELECT i.id,u.email,u.displayName,i.role,i.expiresAt,i.createdAt,
        CASE WHEN i.expiresAt<=? THEN 'expired' ELSE i.state END AS state
        FROM ava_invitations i JOIN ava_users u ON u.id=i.userId
        WHERE i.businessId=? AND i.state IN ('pending','redeeming') ORDER BY i.createdAt DESC`, [Date.now(),scope]).map(invitation=>({...invitation,delivery:require('./team-invitation-delivery').status(invitation.id)})) : [];
    const capabilities = current.platformRole === 'platform_admin' ? capabilitiesForRole('hotel_owner')
        : actor(current.userId).memberships.find(m=>m.businessId===scope).capabilities;
    return {members,invitations,roleOptions:roleOptions(),capabilities,currentUserId:current.userId || null};
}

function inviteBusinessMember(current, businessId, {email,displayName='',role='manager'}={}) {
    ensureSchema();
    const address = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length>254 || typeof displayName!=='string'
        || displayName.length>120 || !teamRoles.includes(role)) throw failure('INVITATION_INVALID',400);
    return DB.db.transaction(() => {
        const scope = authorizeCapability(current,businessId,'team.manage');
        const matches = DB.all('SELECT * FROM ava_users WHERE lower(email)=? LIMIT 2',[address]);
        if (matches.length>1) throw failure('ACCOUNT_ALREADY_EXISTS',409);
        let user = matches[0];
        if (user && !user.enabled && user.subject) throw failure('ACCOUNT_NOT_ACTIVE',409);
        if (user && DB.get('SELECT userId FROM ava_business_memberships WHERE userId=? AND businessId=? AND enabled=1',[user.id,scope])) throw failure('ACCOUNT_ALREADY_MEMBER',409);
        if (user && DB.get("SELECT id FROM ava_invitations WHERE userId=? AND businessId=? AND state IN ('pending','redeeming') AND expiresAt>?",[user.id,scope,Date.now()])) throw failure('ACCOUNT_ALREADY_EXISTS',409);
        if (!user) {
            user={id:crypto.randomUUID()};
            DB.run('INSERT INTO ava_users(id,email,displayName,businessQuota,enabled) VALUES (?,?,?,0,0)',[user.id,address,displayName.trim()]);
        }
        const invitationId=crypto.randomUUID(),token=random(),expiresAt=Date.now()+86400000;
        DB.run("INSERT INTO ava_invitations(id,tokenHash,userId,businessId,role,expiresAt,createdBy,acceptanceMode) VALUES (?,?,?,?,?,?,?,'team')",
            [invitationId,hash(token),user.id,scope,role,expiresAt,current.userId || 'break-glass']);
        auditTeam(current,scope,'invite',{userId:user.id,invitationId,role});
        return {invitationId,token,expiresAt};
    }).immediate();
}
const inviteBusinessManager = (current,businessId,body) => inviteBusinessMember(current,businessId,body);

function assertNoStaleTeamLease(userId) {
    // Existing-account joining has no native enrollment mutation. A stale new-
    // account barrier must not block a proven active subject's scoped acceptance.
    const user=DB.get('SELECT enabled,subject FROM ava_users WHERE id=?',[userId]);
    if (user?.enabled && user.subject) return;
    if (DB.get("SELECT id FROM ava_invitations WHERE userId=? AND acceptanceMode='team' AND leaseToken IS NOT NULL AND (leasedUntil IS NULL OR leasedUntil<=?) LIMIT 1",[userId,Date.now()])) {
        throw failure('TEAM_ENROLLMENT_RECONCILIATION_REQUIRED',409);
    }
}

function pendingTeamInvitation(token) {
    ensureSchema();
    if (typeof token!=='string' || !/^[\w-]{43}$/.test(token)) throw failure('INVITATION_INVALID',400);
    const row=DB.get(`SELECT i.*,u.email,u.displayName,u.enabled AS userEnabled,u.subject FROM ava_invitations i
        JOIN ava_users u ON u.id=i.userId WHERE tokenHash=? AND expiresAt>? AND state IN ('pending','redeeming')`,[hash(token),Date.now()]);
    DB.run("UPDATE ava_team_email_verifications SET passwordEncrypted='' WHERE passwordEncrypted!='' AND (expiresAtMs<=? OR invitationId IN (SELECT id FROM ava_invitations WHERE expiresAt<=? OR state IN ('consumed','revoked')))",[Date.now(),Date.now()]);
    if (!row) throw failure('INVITATION_INVALID',400);
    if (row.acceptanceMode==='team') assertNoStaleTeamLease(row.userId);
    if (row.businessId!==null && !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1',[row.businessId])) throw failure('BUSINESS_NOT_FOUND',404);
    return row;
}
function inspectInvitation(token) {
    const row=pendingTeamInvitation(token);
    const business=row.businessId===null?null:DB.get('SELECT name FROM instances WHERE id=?',[row.businessId]);
    return {businessId:row.businessId,businessName:business?.name || null,email:row.email,role:row.role,
        acceptance:row.userEnabled && row.subject?'existing_account':row.acceptanceMode==='team'?'new_account':'legacy',expiresAt:row.expiresAt};
}
function acceptInvitation(current,token) {
    ensureSchema();
    return DB.db.transaction(() => {
        const row=pendingTeamInvitation(token),verified=actor(current?.userId);
        if (row.acceptanceMode!=='team' || !row.userEnabled || !row.subject || row.state!=='pending') throw failure('INVITATION_INVALID',400);
        if (verified.userId!==row.userId || verified.subject!==row.subject || current.subject!==verified.subject
            || verified.email.toLowerCase()!==row.email.toLowerCase()) throw failure('INVITATION_ACCOUNT_MISMATCH');
        if (DB.get('SELECT userId FROM ava_business_memberships WHERE userId=? AND businessId=? AND enabled=1',[verified.userId,row.businessId])) throw failure('ACCOUNT_ALREADY_MEMBER',409);
        DB.run(`INSERT INTO ava_business_memberships(userId,businessId,role) VALUES (?,?,?)
            ON CONFLICT(userId,businessId) DO UPDATE SET enabled=1,role=excluded.role`,[verified.userId,row.businessId,row.role]);
        DB.run("UPDATE ava_invitations SET state='consumed',leaseToken=NULL,leasedUntil=NULL WHERE id=?",[row.id]);
        auditTeam(verified,row.businessId,'accept',{userId:verified.userId,invitationId:row.id,role:row.role});
        return actor(verified.userId);
    }).immediate();
}
function teamTarget(current,businessId,userId) {
    const scope=authorizeCapability(current,businessId,'team.manage');
    const target=DB.get(`SELECT m.*,u.enabled AS userEnabled FROM ava_business_memberships m JOIN ava_users u ON u.id=m.userId
        WHERE m.businessId=? AND m.userId=? AND m.enabled=1 AND u.enabled=1`,[scope,userId]);
    if (!target) throw failure('TEAM_MEMBER_NOT_FOUND',404);
    if (current.userId===userId) throw failure('TEAM_SELF_ACCESS_PROTECTED',409);
    if (target.role==='hotel_owner' && DB.get(`SELECT COUNT(*) AS n FROM ava_business_memberships m JOIN ava_users u ON u.id=m.userId
        WHERE m.businessId=? AND m.role='hotel_owner' AND m.enabled=1 AND u.enabled=1`,[scope]).n<=1) throw failure('TEAM_LAST_OWNER',409);
    return target;
}
function revokeScopedNative(userId,businessId) {
    const Modules=require('./module-access-store');
    Modules.revokeBusinessAccess(userId,businessId);
}
function changeBusinessRole(current,businessId,userId,role) {
    ensureSchema();
    require('../ava-workspace.store').ensureSchema();
    require('../ava-autopilot.store').ensureSchema();
    if (!teamRoles.includes(role)) throw failure('TEAM_ROLE_INVALID',400);
    return DB.db.transaction(() => {
        const target=teamTarget(current,businessId,userId);
        if (target.role===role) return {changed:false};
        if (role==='observer') {
            require('../sales-workspace.service').cleanupMemberAssignments(target.businessId,userId,{reason:'role_changed',role});
            require('../ava-workspace.store').cleanupMember(target.businessId,userId);
        }
        require('../ava-autopilot.store').cleanupMember(target.businessId,userId);
        revokeScopedNative(userId,target.businessId);
        DB.run('UPDATE ava_business_memberships SET role=? WHERE userId=? AND businessId=?',[role,userId,target.businessId]);
        auditTeam(current,target.businessId,'change_role',{userId,previousRole:target.role,role});
        return {changed:true};
    }).immediate();
}
function removeBusinessMember(current,businessId,userId) {
    ensureSchema();
    require('../ava-workspace.store').ensureSchema();
    require('../ava-autopilot.store').ensureSchema();
    return DB.db.transaction(() => {
        const target=teamTarget(current,businessId,userId);
        require('../sales-workspace.service').cleanupMemberAssignments(target.businessId,userId,{reason:'removed',role:target.role});
        require('../ava-workspace.store').cleanupMember(target.businessId,userId);
        require('../ava-autopilot.store').cleanupMember(target.businessId,userId);
        revokeScopedNative(userId,target.businessId);
        DB.run('UPDATE ava_business_memberships SET enabled=0 WHERE userId=? AND businessId=?',[userId,target.businessId]);
        DB.run("UPDATE ava_invitations SET state='revoked' WHERE userId=? AND businessId=? AND state IN ('pending','redeeming')",[userId,target.businessId]);
        auditTeam(current,target.businessId,'remove',{userId,previousRole:target.role});
    }).immediate();
}
function renewBusinessInvitation(current,businessId,id) {
    ensureSchema();
    return DB.db.transaction(() => {
        const scope=authorizeCapability(current,businessId,'team.manage');
        const row=DB.get("SELECT * FROM ava_invitations WHERE id=? AND businessId=? AND state IN ('pending','redeeming')",[id,scope]);
        if (!row) throw failure('INVITATION_INVALID',404);
        if (row.acceptanceMode==='team') assertNoStaleTeamLease(row.userId);
        if (row.acceptanceMode==='team' && row.leaseToken) throw failure('INVITATION_IN_PROGRESS',409);
        const delivery=DB.get('SELECT lastAttemptAt FROM ava_team_invitation_delivery WHERE invitationId=?',[id]);
        if (delivery && delivery.lastAttemptAt>Date.now()-60000) throw failure('INVITATION_RESEND_COOLDOWN',429);
        const token=random(),expiresAt=Date.now()+86400000;
        DB.run("UPDATE ava_invitations SET tokenHash=?,expiresAt=?,state='pending',leaseToken=NULL,leasedUntil=NULL WHERE id=?",[hash(token),expiresAt,row.id]);
        DB.run("UPDATE ava_team_email_verifications SET passwordEncrypted='' WHERE invitationId=?",[row.id]);
        auditTeam(current,scope,'renew_invitation',{userId:row.userId,invitationId:row.id,role:row.role});
        return {invitationId:row.id,token,expiresAt};
    }).immediate();
}
function revokeBusinessInvitation(current,businessId,id) {
    ensureSchema();
    return DB.db.transaction(() => {
        const scope=authorizeCapability(current,businessId,'team.manage');
        const row=DB.get("SELECT * FROM ava_invitations WHERE id=? AND businessId=? AND state IN ('pending','redeeming')",[id,scope]);
        if (!row) throw failure('INVITATION_INVALID',404);
        DB.run("UPDATE ava_invitations SET state='revoked' WHERE id=?",[row.id]);
        DB.run("UPDATE ava_team_email_verifications SET passwordEncrypted='' WHERE invitationId=?",[row.id]);
        auditTeam(current,scope,'revoke_invitation',{userId:row.userId,invitationId:row.id,role:row.role});
    }).immediate();
}

function verifiedTeamProof(invitation, user, proofId = null) {
    if (!user || typeof user.email !== 'string' || !user.email) return null;
    const now = Date.now();
    return DB.get(`SELECT id FROM ava_team_email_verifications
        WHERE invitationId=? AND invitationTokenHash=? AND email=? COLLATE NOCASE
          AND verifiedAtMs IS NOT NULL AND verifiedAtMs<=? AND expiresAtMs>?
          AND completedAtMs IS NULL AND (? IS NULL OR id=?)
        ORDER BY createdAtMs DESC,id DESC LIMIT 1`,
    [invitation.id,invitation.tokenHash,user.email,now,now,proofId,proofId]);
}

function claimInvitation(token, emailVerificationId = null) {
    ensureSchema();
    if (!/^[\w-]{43}$/.test(String(token))) throw failure('INVITATION_INVALID', 400);
    return DB.db.transaction(() => {
        const row = DB.get('SELECT * FROM ava_invitations WHERE tokenHash=? AND expiresAt>?', [hash(token), Date.now()]);
        if (!row || !['pending','redeeming'].includes(row.state)) throw failure('INVITATION_INVALID', 400);
        activeOwnerUse(row.id);
        const targetUser=DB.get('SELECT * FROM ava_users WHERE id=?',[row.userId]);
        if (!targetUser) throw failure('INVITATION_INVALID',400);
        if (targetUser.enabled || (row.acceptanceMode==='team' && targetUser.subject !== null)) throw failure('INVITATION_EXISTING_ACCOUNT_REQUIRED',409);
        if (row.acceptanceMode==='team') assertNoStaleTeamLease(row.userId);
        const proof = row.acceptanceMode==='team' ? verifiedTeamProof(row,targetUser,emailVerificationId) : null;
        const registration = require('./self-registration.service').proofForInvitation(row);
        if (row.acceptanceMode==='team' && !proof) throw failure('VERIFICATION_REQUIRED',400);
        if (DB.get("SELECT id FROM ava_identity_outbox WHERE userId=? AND state!='done' LIMIT 1", [row.userId])) {
            throw failure('PREVIOUS_ACCESS_REVOCATION_PENDING', 409);
        }
        const serialized = !!registration || row.acceptanceMode==='team';
        if ((row.state === 'redeeming' && (serialized ? row.leaseToken !== null : row.leasedUntil > Date.now()))
            || (serialized && DB.get('SELECT id FROM ava_invitations WHERE userId=? AND id!=? AND leaseToken IS NOT NULL', [row.userId,row.id]))) throw failure('INVITATION_IN_PROGRESS', 409);
        const leaseToken = random();
        DB.run("UPDATE ava_invitations SET state='redeeming',leaseToken=?,leasedUntil=? WHERE id=?",
            [leaseToken, Date.now() + 60000, row.id]);
        const ownerInvitation = !!DB.get('SELECT id FROM ava_owner_invitation_uses WHERE invitationId=? AND state=?', [row.id, 'pending']);
        return { ...row, leaseToken, ownerInvitation, selfRegistration:!!registration,
            emailVerifiedInvitation:!!proof || !!registration, registrationId:registration?.id || null,
            emailVerificationId:proof?.id || null, user:targetUser };
    }).immediate();
}

function assertInvitationLease(invitation) {
    const row = DB.get("SELECT * FROM ava_invitations WHERE id=? AND state='redeeming' AND leaseToken=? AND leasedUntil>? AND expiresAt>?",
        [invitation.id, invitation.leaseToken, Date.now(), Date.now()]);
    if (!row || DB.get("SELECT id FROM ava_identity_outbox WHERE userId=? AND state!='done' LIMIT 1", [invitation.userId])) {
        throw failure('INVITATION_LEASE_LOST', 409);
    }
    if (invitation.acceptanceMode==='team' || row.acceptanceMode==='team') {
        const user=DB.get('SELECT * FROM ava_users WHERE id=?',[row.userId]);
        // Keep the exact claim bound across provider awaits. A newer proof or
        // a changed invitation must not authorize an enrollment already in flight.
        if (['tokenHash','userId','businessId','role','acceptanceMode'].some(key => row[key] !== invitation[key])
            || !user || user.enabled || user.subject !== null
            || typeof user.email !== 'string' || typeof invitation.user?.email !== 'string'
            || user.email.toLowerCase() !== invitation.user.email.toLowerCase()
            || !invitation.emailVerificationId
            || !verifiedTeamProof(row,user,invitation.emailVerificationId)) {
            throw failure('INVITATION_LEASE_LOST',409);
        }
    }
    activeOwnerUse(row.id);
    if (invitation.selfRegistration || String(row.createdBy).startsWith('self-registration:')) {
        const proof = require('./self-registration.service').proofForInvitation(row);
        const user = DB.get('SELECT * FROM ava_users WHERE id=?', [row.userId]);
        if (!proof || proof.id !== invitation.registrationId
            || ['tokenHash','userId','businessId','role','createdBy'].some(key => row[key] !== invitation[key])
            || user.subject !== invitation.user.subject
            || user.email.toLowerCase() !== invitation.user.email.toLowerCase()
            || DB.get('SELECT COUNT(*) n FROM ava_users WHERE lower(email)=?', [proof.email]).n !== 1) throw failure('INVITATION_LEASE_LOST',409);
    }
    if (row.businessId !== null && !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [row.businessId])) throw failure('BUSINESS_NOT_FOUND', 404);
    return row;
}

function completeInvitation(invitation, subject) {
    ensureSchema();
    if (!subject || String(subject).length > 255) throw failure('IDENTITY_SUBJECT_INVALID');
    return DB.db.transaction(() => {
        const row = assertInvitationLease(invitation);
        const updated = DB.run('UPDATE ava_users SET subject=?,enabled=1 WHERE id=? AND (subject IS NULL OR subject=?)', [subject, row.userId, subject]);
        if (updated.changes !== 1) throw failure('IDENTITY_SUBJECT_MISMATCH');
        if (row.businessId !== null && DB.get('SELECT userId FROM ava_business_memberships WHERE userId=? AND businessId=? AND enabled=1',[row.userId,row.businessId])) throw failure('ACCOUNT_ALREADY_MEMBER',409);
        if (row.businessId !== null) DB.run(`INSERT INTO ava_business_memberships(userId,businessId,role) VALUES (?,?,?)
            ON CONFLICT(userId,businessId) DO UPDATE SET role=excluded.role,enabled=1`, [row.userId, row.businessId, row.role]);
        DB.run("UPDATE ava_invitations SET state='consumed',leaseToken=NULL,leasedUntil=NULL WHERE id=?", [row.id]);
        if (invitation.selfRegistration) require('./self-registration.service').finishIdentityEnrollment(invitation, subject);
        DB.run("UPDATE ava_owner_invitation_uses SET state='completed',finishedAtMs=? WHERE invitationId=? AND state='pending'", [Date.now(), row.id]);
        if (row.acceptanceMode==='team') {
            DB.run("UPDATE ava_team_email_verifications SET completedAtMs=?,passwordEncrypted='' WHERE invitationId=?",[Date.now(),row.id]);
            auditTeam({userId:row.userId},row.businessId,'accept',{userId:row.userId,invitationId:row.id,role:row.role});
        }
        return actor(row.userId);
    }).immediate();
}

function abortEnrollment(invitation, subject) {
    // A native enable request may have succeeded even when its response or
    // the AVA lease was lost. Persist compensation before attempting cleanup.
    return DB.db.transaction(() => {
        if (invitation.selfRegistration || invitation.acceptanceMode==='team') {
            const current = DB.get('SELECT leaseToken FROM ava_invitations WHERE id=?', [invitation.id]);
            // A terminal older generation can never revoke a newer account.
            if (current?.leaseToken !== invitation.leaseToken) return false;
            if (invitation.acceptanceMode==='team' && DB.get('SELECT enabled FROM ava_users WHERE id=?',[invitation.userId])?.enabled) return false;
        }
        const changed = DB.run('UPDATE ava_users SET subject=? WHERE id=? AND (subject IS NULL OR subject=?)', [subject, invitation.userId, subject]);
        if (changed.changes !== 1) throw failure('IDENTITY_SUBJECT_MISMATCH');
        revokeUser({ platformRole: 'platform_admin', userId: 'enrollment-compensation' }, invitation.userId);
        return true;
    }).immediate();
}

function releaseRegistrationLease(invitation) {
    if (!invitation.selfRegistration && invitation.acceptanceMode!=='team') return;
    // Called only by the worker's terminal finally, after every native await
    // and durable compensation. Expiry is not evidence of worker termination.
    DB.run("UPDATE ava_invitations SET state=CASE WHEN acceptanceMode='team' AND state='redeeming' THEN 'pending' ELSE state END,leaseToken=NULL,leasedUntil=NULL WHERE id=? AND leaseToken=?", [invitation.id, invitation.leaseToken]);
}

function attachBusinessOwner(userId, businessId) {
    ensureSchema();
    const current = actor(userId);
    const count = DB.get("SELECT COUNT(*) AS n FROM ava_business_memberships WHERE userId=? AND role='hotel_owner'", [userId]).n;
    if (current.platformRole !== 'platform_admin' && count >= current.businessQuota) throw failure('BUSINESS_QUOTA_EXCEEDED', 409);
    DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES (?,?,'hotel_owner')", [userId, businessId]);
}

function createSession(subject, nativeSid, ttlSeconds = 3600) {
    ensureSchema();
    const user = DB.get('SELECT id FROM ava_users WHERE subject=? AND enabled=1', [subject]);
    if (!user) throw failure('ACCOUNT_NOT_ENROLLED');
    const token = random();
    DB.run('INSERT INTO ava_sessions(tokenHash,userId,nativeSid,expiresAt) VALUES (?,?,?,?)',
        [hash(token), user.id, nativeSid || null, Date.now() + Math.min(3600, Math.max(1, ttlSeconds)) * 1000]);
    return token;
}

function session(token) {
    ensureSchema();
    if (!token) return null;
    const row = DB.get('SELECT userId FROM ava_sessions WHERE tokenHash=? AND revokedAt IS NULL AND expiresAt>?', [hash(token), Date.now()]);
    if (!row) return null;
    try { return actor(row.userId); } catch (_) { return null; }
}

function revokeSession(token) {
    ensureSchema();
    DB.run('UPDATE ava_sessions SET revokedAt=? WHERE tokenHash=?', [Date.now(), hash(token)]);
}

function enqueueLogout(token) {
    return enqueueLogoutBySessionHash(hash(token));
}

// Internal server boundary: never accept this hash from a public HTTP body.
function enqueueLogoutBySessionHash(sessionHash) {
    ensureSchema();
    if (!/^[a-f0-9]{64}$/.test(sessionHash || '')) throw failure('SESSION_INVALID');
    return DB.db.transaction(() => {
        const row = DB.get('SELECT userId FROM ava_sessions WHERE tokenHash=?', [sessionHash]);
        // Keycloak revocation covers the user's sessions, so local denial must
        // have the same scope even while the native revocation queue is offline.
        if (row) DB.run('UPDATE ava_sessions SET revokedAt=COALESCE(revokedAt,?) WHERE userId=?', [Date.now(), row.userId]);
        if (row && !DB.get("SELECT id FROM ava_identity_outbox WHERE userId=? AND action='revoke_sessions' AND state!='done'", [row.userId])) {
            DB.run("INSERT INTO ava_identity_outbox(id,userId,action,nextAttemptAt) VALUES (?,?,'revoke_sessions',?)",
                [crypto.randomUUID(), row.userId, Date.now()]);
        }
    }).immediate();
}

function backchannelLogout({ sub, sid, jti }) {
    ensureSchema();
    return DB.db.transaction(() => {
        DB.run('DELETE FROM ava_logout_receipts WHERE expiresAt<?', [Date.now()]);
        const receipt = DB.run('INSERT OR IGNORE INTO ava_logout_receipts VALUES (?,?)', [hash(jti), Date.now() + 600000]);
        if (!receipt.changes) return;
        // Issuer and audience were verified by OIDC. Never resolve by email.
        DB.run(`UPDATE ava_sessions SET revokedAt=? WHERE revokedAt IS NULL
            AND (? IS NULL OR nativeSid=?)
            AND (? IS NULL OR userId IN (SELECT id FROM ava_users WHERE subject=?))`,
        [Date.now(), sid || null, sid || null, sub || null, sub || null]);
    }).immediate();
}

function revokeUser(current, userId) {
    ensureSchema();
    requirePlatformAdmin(current);
    return DB.db.transaction(() => {
        if (!DB.get('SELECT id FROM ava_users WHERE id=?', [userId])) throw failure('ACCOUNT_NOT_FOUND', 404);
        DB.run('UPDATE ava_users SET enabled=0 WHERE id=?', [userId]);
        DB.run('UPDATE ava_sessions SET revokedAt=? WHERE userId=?', [Date.now(), userId]);
        DB.run('UPDATE ava_business_memberships SET enabled=0 WHERE userId=?', [userId]);
        DB.run("UPDATE ava_invitations SET state='revoked' WHERE userId=?", [userId]);
        if (!DB.get("SELECT id FROM ava_identity_outbox WHERE userId=? AND action='revoke_memberships' AND state!='done'", [userId])) {
            DB.run("INSERT INTO ava_identity_outbox(id,userId,action,nextAttemptAt) VALUES (?,?,'revoke_memberships',?)",
                [crypto.randomUUID(), userId, Date.now()]);
        }
    }).immediate();
}

function reissueInvitation(current, userId, { businessId = null, role = 'hotel_owner' } = {}) {
    requirePlatformAdmin(current);
    ensureSchema();
    if (!['hotel_owner',...teamRoles].includes(role) || (businessId === null && role !== 'hotel_owner')) throw failure('INVITATION_INVALID', 400);
    const scope = businessId === null ? null : authorizeBusiness(current, businessId);
    return DB.db.transaction(() => {
        if (scope !== null && !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [scope])) throw failure('BUSINESS_NOT_FOUND', 404);
        revokeUser(current, userId);
        const token = random(), invitationId = crypto.randomUUID();
        DB.run('INSERT INTO ava_invitations(id,tokenHash,userId,businessId,role,expiresAt,createdBy) VALUES (?,?,?,?,?,?,?)',
            [invitationId, hash(token), userId, scope, role, Date.now() + 86400000, current.userId || 'break-glass']);
        return { invitationId, token, expiresInSeconds: 86400, previousAccessRevocationPending: true };
    }).immediate();
}

module.exports = { ensureSchema, actor, authorizeBusiness, authorizeCapability, capabilitiesForRole, requirePlatformAdmin, createInvitation,
    listBusinessTeam, inviteBusinessManager, inviteBusinessMember, inspectInvitation, pendingTeamInvitation, acceptInvitation,
    changeBusinessRole, removeBusinessMember, renewBusinessInvitation, revokeBusinessInvitation,
    createOwnerInvitationLink, listOwnerInvitationLinks, revokeOwnerInvitationLink, validOwnerLink,
    beginOwnerInvitationUse, failOwnerInvitationUse, finishOwnerInvitationUse,
    claimInvitation, assertInvitationLease, completeInvitation, abortEnrollment, releaseRegistrationLease, attachBusinessOwner, createSession, session, revokeSession,
    enqueueLogout, enqueueLogoutBySessionHash, backchannelLogout, revokeUser, reissueInvitation, hash };
