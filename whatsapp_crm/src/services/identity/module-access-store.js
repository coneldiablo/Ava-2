'use strict';

// AVA-owned authorization boundary for independently implemented native adapters.
// No Enterprise implementation, license flags, native passwords or native JWT
// signing keys are used here. This is not, by itself, a native SSO adapter.
const crypto = require('crypto');
const DB = require('../database.service');
const Identity = require('./identity-store');
const initialized = new WeakSet();
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const fail = (code, statusCode = 403) => Object.assign(new Error(code), { code, statusCode });
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
// Native adapters have proved only these exact roles. Keep the native CHECK
// narrow until new roles pass their own permission/session readback probes.
const NATIVE_ROLES = new Set(['hotel_owner', 'manager']);
function assertNativeRole(role) {
    if (!NATIVE_ROLES.has(role)) throw fail('MODULE_ROLE_NOT_SUPPORTED');
}

function schema() {
    Identity.ensureSchema();
    if (initialized.has(DB.db)) return;
    DB.db.exec(`
        CREATE TABLE IF NOT EXISTS ava_module_adapters (
            id TEXT PRIMARY KEY, businessId INTEGER NOT NULL REFERENCES instances(id),
            module TEXT NOT NULL CHECK(module IN ('twenty','onyx')),
            publicOrigin TEXT NOT NULL, nativeScope TEXT NOT NULL,
            integrationId TEXT NOT NULL, integrationRevision INTEGER NOT NULL,
            attachmentMode TEXT NOT NULL DEFAULT 'full' CHECK(attachmentMode IN ('full','existing_workspace_ui')),
            attachmentModeV2 TEXT CHECK(attachmentModeV2 IS NULL OR attachmentModeV2='isolated_workspace_ui'),
            peerSecretHash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
            enabled INTEGER NOT NULL DEFAULT 1, UNIQUE(businessId,module),
            UNIQUE(module,publicOrigin,nativeScope)
        );
        CREATE TABLE IF NOT EXISTS ava_module_principals (
            id TEXT PRIMARY KEY, adapterId TEXT NOT NULL REFERENCES ava_module_adapters(id),
            userId TEXT NOT NULL REFERENCES ava_users(id), subject TEXT NOT NULL,
            nativeUserId TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('hotel_owner','manager')),
            adapterRevision INTEGER NOT NULL, verifiedAt INTEGER,
            UNIQUE(adapterId,userId), UNIQUE(adapterId,nativeUserId)
        );
        CREATE TABLE IF NOT EXISTS ava_module_grants (
            tokenHash TEXT PRIMARY KEY, principalId TEXT NOT NULL REFERENCES ava_module_principals(id),
            parentSessionHash TEXT NOT NULL REFERENCES ava_sessions(tokenHash),
            adapterRevision INTEGER NOT NULL, challenge TEXT NOT NULL,
            expiresAt INTEGER NOT NULL, consumedAt INTEGER
        );
        CREATE TABLE IF NOT EXISTS ava_module_sessions (
            tokenHash TEXT PRIMARY KEY, principalId TEXT NOT NULL REFERENCES ava_module_principals(id),
            parentSessionHash TEXT NOT NULL REFERENCES ava_sessions(tokenHash),
            adapterRevision INTEGER NOT NULL, expiresAt INTEGER NOT NULL, revokedAt INTEGER
        );
        CREATE INDEX IF NOT EXISTS ava_module_sessions_parent ON ava_module_sessions(parentSessionHash);
        CREATE INDEX IF NOT EXISTS ava_module_grants_expiry ON ava_module_grants(expiresAt);
        CREATE TABLE IF NOT EXISTS ava_module_revocations (
            bindingId TEXT PRIMARY KEY,
            adapterId TEXT NOT NULL REFERENCES ava_module_adapters(id),
            state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','done','failed')),
            attempts INTEGER NOT NULL DEFAULT 0,
            leaseToken TEXT, leasedUntil INTEGER, nextAttemptAt INTEGER NOT NULL,
            lastErrorCode TEXT, createdAt INTEGER NOT NULL, completedAt INTEGER
        );
        CREATE INDEX IF NOT EXISTS ava_module_revocations_due ON ava_module_revocations(adapterId,state,nextAttemptAt);
        CREATE TABLE IF NOT EXISTS ava_module_enrollments (
            deploymentId TEXT PRIMARY KEY, businessId INTEGER NOT NULL REFERENCES instances(id),
            module TEXT NOT NULL CHECK(module IN ('twenty','onyx')),
            deploymentRevision INTEGER NOT NULL, publicOrigin TEXT NOT NULL,
            nativeScope TEXT NOT NULL, peerSecretHash TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('prepared','active')),
            adapterRevision INTEGER, createdAt INTEGER NOT NULL, activatedAt INTEGER
        );
        CREATE TABLE IF NOT EXISTS ava_sync_leases (
            leaseId TEXT PRIMARY KEY,
            adapterId TEXT,
            peerSecretHash TEXT,
            deploymentId TEXT NOT NULL,
            businessId INTEGER NOT NULL REFERENCES instances(id),
            nativeScope TEXT NOT NULL,
            revision INTEGER NOT NULL,
            nativeKeyId TEXT NOT NULL,
            generation INTEGER NOT NULL,
            roleId TEXT NOT NULL,
            correlationId TEXT NOT NULL,
            method TEXT NOT NULL CHECK(method IN ('GET','POST','PATCH')),
            path TEXT NOT NULL,
            objectName TEXT NOT NULL,
            recordId TEXT,
            bodyDigest TEXT,
            status TEXT NOT NULL CHECK(status IN ('active','completed','failed','denied','fenced','abandoned')),
            createdAt INTEGER NOT NULL,
            expiresAt INTEGER NOT NULL,
            releasedAt INTEGER,
            outcome TEXT
        );
        CREATE INDEX IF NOT EXISTS ava_sync_leases_corr ON ava_sync_leases(correlationId, status);
        CREATE INDEX IF NOT EXISTS ava_sync_leases_deploy ON ava_sync_leases(deploymentId, status);
        CREATE TABLE IF NOT EXISTS ava_sync_mutations (
            correlationId TEXT PRIMARY KEY,
            businessId INTEGER NOT NULL REFERENCES instances(id),
            adapterId TEXT NOT NULL REFERENCES ava_module_adapters(id),
            deploymentId TEXT NOT NULL,
            nativeScope TEXT NOT NULL,
            revision INTEGER NOT NULL,
            integrationRevision INTEGER NOT NULL,
            outboxLeaseHash TEXT NOT NULL,
            method TEXT NOT NULL CHECK(method IN ('GET','POST','PATCH')),
            path TEXT NOT NULL,
            objectName TEXT NOT NULL,
            recordId TEXT,
            bodyDigest TEXT,
            bodyJson TEXT,
            preparedAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ava_sync_lease_recoveries (
            recoveryId TEXT PRIMARY KEY,
            leaseId TEXT NOT NULL UNIQUE REFERENCES ava_sync_leases(leaseId),
            deploymentId TEXT NOT NULL,
            businessId INTEGER NOT NULL REFERENCES instances(id),
            leaseRevision INTEGER NOT NULL,
            deploymentRevision INTEGER NOT NULL,
            adapterRevision INTEGER NOT NULL,
            integrationRevision INTEGER NOT NULL,
            correlationId TEXT NOT NULL,
            outboxEventId TEXT NOT NULL,
            outboxEntityType TEXT NOT NULL,
            outboxSourceTable TEXT NOT NULL,
            outboxSourceId TEXT NOT NULL,
            outboxOperation TEXT NOT NULL,
            outboxLeaseHash TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('pending','leased','blocked','readback_required','completed')),
            tokenHash TEXT,
            leasedUntil INTEGER,
            attempts INTEGER NOT NULL DEFAULT 0,
            nextAttemptAt INTEGER,
            proofJson TEXT,
            proofDigest TEXT,
            lastErrorCode TEXT,
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL,
            provenAt INTEGER,
            readbackAt INTEGER
        );
        CREATE INDEX IF NOT EXISTS ava_sync_recoveries_due
            ON ava_sync_lease_recoveries(state,nextAttemptAt,leasedUntil);
    `);
    const columns = new Set(DB.all('PRAGMA table_info(ava_module_sessions)').map(row => row.name));
    if (!columns.has('bindingId')) DB.db.exec('ALTER TABLE ava_module_sessions ADD COLUMN bindingId TEXT');
    DB.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ava_module_sessions_binding ON ava_module_sessions(bindingId) WHERE bindingId IS NOT NULL');
    const adapterColumns = new Set(DB.all('PRAGMA table_info(ava_module_adapters)').map(row => row.name));
    for (const [name, type] of [['deploymentId','TEXT'], ['deploymentRevision','INTEGER']]) {
        if (!adapterColumns.has(name)) DB.db.exec(`ALTER TABLE ava_module_adapters ADD COLUMN ${name} ${type}`);
    }
    if (!adapterColumns.has('attachmentMode')) {
        // Existing records keep their prior, fully guarded adapter behavior.
        // UI-only attachment is always an explicit worker-side choice.
        DB.db.exec("ALTER TABLE ava_module_adapters ADD COLUMN attachmentMode TEXT NOT NULL DEFAULT 'full' CHECK(attachmentMode IN ('full','existing_workspace_ui'))");
    }
    if (!adapterColumns.has('attachmentModeV2')) {
        DB.db.exec("ALTER TABLE ava_module_adapters ADD COLUMN attachmentModeV2 TEXT CHECK(attachmentModeV2 IS NULL OR attachmentModeV2='isolated_workspace_ui')");
    }
    const leaseColumns = new Set(DB.all('PRAGMA table_info(ava_sync_leases)').map(row => row.name));
    for (const [name, type] of [['adapterId','TEXT'], ['peerSecretHash','TEXT']]) {
        if (!leaseColumns.has(name)) DB.db.exec(`ALTER TABLE ava_sync_leases ADD COLUMN ${name} ${type}`);
    }
    initialized.add(DB.db);
}

function workerOnly() {
    if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') throw fail('MODULE_WORKER_REQUIRED');
}

function integration(businessId, module) {
    const id = Number(businessId);
    if (!Number.isSafeInteger(id) || id < 1 || !['twenty','onyx'].includes(module)) throw fail('MODULE_SCOPE_INVALID');
    if (!DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [id])) throw fail('MODULE_BUSINESS_INACTIVE');
    const row = module === 'twenty'
        ? DB.get('SELECT id,workspaceId AS scope,revision,enabled FROM twenty_workspace_links WHERE businessId=?', [id])
        : DB.get("SELECT id,onyx_tenant_id AS scope,revision,status FROM onyx_tenant_links WHERE business_id=?", [id]);
    if (!row?.scope || !Number.isInteger(row.revision) || (module === 'twenty' ? !row.enabled : row.status === 'DISABLED')) {
        throw fail('MODULE_INTEGRATION_UNAVAILABLE');
    }
    return { id: String(row.id), scope: String(row.scope), revision: row.revision };
}

function origin(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw fail('MODULE_ORIGIN_INVALID'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || url.port || !url.hostname.endsWith('.meludtech.tech') || url.hostname.includes('*')) throw fail('MODULE_ORIGIN_INVALID');
    return url.origin;
}

function currentAdapter(id) {
    const raw = DB.get('SELECT * FROM ava_module_adapters WHERE id=? AND enabled=1', [id]);
    if (!raw) throw fail('MODULE_ADAPTER_UNAVAILABLE');
    const isolated = raw.attachmentModeV2 === 'isolated_workspace_ui';
    if (raw.attachmentModeV2 !== null && !isolated) throw fail('MODULE_CONFIGURATION_CHANGED');
    if (isolated && (raw.attachmentMode !== 'existing_workspace_ui' || raw.module !== 'onyx')) throw fail('MODULE_CONFIGURATION_CHANGED');
    const adapter = { ...raw, attachmentMode: isolated ? 'isolated_workspace_ui' : raw.attachmentMode };
    if (!['full', 'existing_workspace_ui', 'isolated_workspace_ui'].includes(adapter.attachmentMode)) throw fail('MODULE_CONFIGURATION_CHANGED');
    const linked = integration(adapter.businessId, adapter.module);
    if (adapter.integrationId !== linked.id || adapter.integrationRevision !== linked.revision
        || (adapter.attachmentMode !== 'isolated_workspace_ui' && adapter.nativeScope !== linked.scope)) {
        throw fail('MODULE_CONFIGURATION_CHANGED');
    }
    if (adapter.attachmentMode === 'existing_workspace_ui'
        && (adapter.module !== 'twenty' || adapter.deploymentId || adapter.deploymentRevision)) {
        throw fail('MODULE_CONFIGURATION_CHANGED');
    }
    if (adapter.attachmentMode === 'isolated_workspace_ui'
        && (adapter.module !== 'onyx' || !adapter.deploymentId || !Number.isSafeInteger(adapter.deploymentRevision))) {
        throw fail('MODULE_CONFIGURATION_CHANGED');
    }
    if (adapter.deploymentId) {
        const deployment = DB.get("SELECT * FROM ava_module_deployments WHERE id=? AND businessId=? AND module=? AND state='verified'",
            [adapter.deploymentId, adapter.businessId, adapter.module]);
        if (!deployment || deployment.revision !== adapter.deploymentRevision || adapter.publicOrigin !== `https://${deployment.hostname}`
            || (adapter.attachmentMode === 'isolated_workspace_ui' && adapter.nativeScope !== deployment.namespace)) {
            throw fail('MODULE_DEPLOYMENT_CHANGED');
        }
    }
    return adapter;
}

const ATTACHMENT_MODE_FULL = 'full';
const ATTACHMENT_MODE_EXISTING_WORKSPACE_UI = 'existing_workspace_ui';
const ATTACHMENT_MODE_ISOLATED_WORKSPACE_UI = 'isolated_workspace_ui';

// Called only after the worker resolves the exact deployment/workspace. Issuing
// a peer secret does not attest that an adapter or tenant isolation works.
// existing_workspace_ui is deliberately a narrower, UI-only attachment: it
// keeps AVA identity/session checks but never represents a native sync runtime.
function configure({ businessId, module, publicOrigin, attachmentMode = ATTACHMENT_MODE_FULL,
    expectedNativeScope, expectedIntegrationRevision }) {
    workerOnly(); schema();
    return DB.db.transaction(() => {
        const linked = integration(businessId, module), publicUrl = origin(publicOrigin);
        const deployment = DB.get('SELECT * FROM ava_module_deployments WHERE businessId=? AND module=?', [businessId, module]);
        if (![ATTACHMENT_MODE_FULL, ATTACHMENT_MODE_EXISTING_WORKSPACE_UI, ATTACHMENT_MODE_ISOLATED_WORKSPACE_UI].includes(attachmentMode)) {
            throw fail('MODULE_ATTACHMENT_MODE_INVALID');
        }
        if (attachmentMode === ATTACHMENT_MODE_EXISTING_WORKSPACE_UI) {
            if (module !== 'twenty' || deployment
                || expectedNativeScope !== linked.scope
                || !Number.isSafeInteger(expectedIntegrationRevision)
                || expectedIntegrationRevision !== linked.revision) {
                throw fail('MODULE_EXISTING_WORKSPACE_UI_INVALID');
            }
        } else if (attachmentMode === ATTACHMENT_MODE_ISOLATED_WORKSPACE_UI) {
            if (module !== 'onyx' || !deployment || deployment.state !== 'verified'
                || publicUrl !== `https://${deployment.hostname}`
                || expectedNativeScope !== deployment.namespace
                || !Number.isSafeInteger(expectedIntegrationRevision)
                || expectedIntegrationRevision !== linked.revision) {
                throw fail('MODULE_ISOLATED_WORKSPACE_UI_INVALID');
            }
        } else if (expectedNativeScope !== undefined || expectedIntegrationRevision !== undefined) {
            throw fail('MODULE_ATTACHMENT_MODE_INVALID');
        }
        if (deployment && (deployment.state !== 'verified' || publicUrl !== `https://${deployment.hostname}`)) {
            throw fail('MODULE_DEPLOYMENT_NOT_VERIFIED');
        }
        const existing = DB.get('SELECT * FROM ava_module_adapters WHERE businessId=? AND module=?', [businessId, module]);
        const existingMode = existing && (existing.attachmentModeV2 === 'isolated_workspace_ui' ? ATTACHMENT_MODE_ISOLATED_WORKSPACE_UI : existing.attachmentMode);
        if (existing && existingMode !== attachmentMode) throw fail('MODULE_ATTACHMENT_MODE_MIGRATION_REQUIRED');
        const id = existing?.id || crypto.randomUUID(), secret = random();
        const nativeScope = attachmentMode === ATTACHMENT_MODE_ISOLATED_WORKSPACE_UI ? expectedNativeScope : linked.scope;
        DB.run(`INSERT INTO ava_module_adapters(id,businessId,module,publicOrigin,nativeScope,integrationId,integrationRevision,attachmentMode,peerSecretHash,attachmentModeV2)
            VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(businessId,module) DO UPDATE SET
            publicOrigin=excluded.publicOrigin,nativeScope=excluded.nativeScope,integrationId=excluded.integrationId,
            integrationRevision=excluded.integrationRevision,attachmentMode=excluded.attachmentMode,peerSecretHash=excluded.peerSecretHash,
            attachmentModeV2=excluded.attachmentModeV2,revision=ava_module_adapters.revision+1,enabled=1`,
        [id, Number(businessId), module, publicUrl, nativeScope, linked.id, linked.revision,
            attachmentMode === ATTACHMENT_MODE_ISOLATED_WORKSPACE_UI ? 'existing_workspace_ui' : attachmentMode, digest(secret),
            attachmentMode === ATTACHMENT_MODE_ISOLATED_WORKSPACE_UI ? ATTACHMENT_MODE_ISOLATED_WORKSPACE_UI : null]);
        DB.run('UPDATE ava_module_adapters SET deploymentId=?,deploymentRevision=? WHERE id=?',
            [deployment?.id || null, deployment?.revision || null, id]);
        DB.run('UPDATE ava_module_principals SET verifiedAt=NULL WHERE adapterId=?', [id]);
        const current = currentAdapter(id);
        return { id, peerSecret: secret, revision: current.revision, nativeScope: current.nativeScope,
            businessId: current.businessId, deploymentId: current.deploymentId, attachmentMode: current.attachmentMode };
    }).immediate();
}

// Enrollment is deliberately separate from authorization. The root deployment
// helper retains the peer credential and returns only its hash after reading the
// native bootstrap identity. A worker crash/lost response must not rotate it.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function prepareDeployment(wire, receipt) {
    workerOnly(); schema();
    const wireKeys = ['businessId','deploymentId','leaseToken','revision'];
    const receiptKeys = ['adapterId','businessId','deploymentId','hostname','module','namespace','nativeScope','peerSecretHash','revision','sourceCommit'];
    if (!wire || Object.keys(wire).sort().join() !== wireKeys.join()
        || !receipt || Object.keys(receipt).sort().join() !== receiptKeys.join()
        || !uuidPattern.test(wire.deploymentId || '') || !uuidPattern.test(wire.leaseToken || '')
        || !Number.isSafeInteger(wire.businessId) || wire.businessId < 1
        || !Number.isSafeInteger(wire.revision) || wire.revision < 1
        || receipt.adapterId !== wire.deploymentId || !/^[0-9a-f]{64}$/.test(receipt.peerSecretHash || '')) {
        throw fail('MODULE_ENROLLMENT_INVALID');
    }
    return DB.db.transaction(() => {
        const row = DB.get(`SELECT d.* FROM ava_module_deployments d JOIN instances i ON i.id=d.businessId
            WHERE d.id=? AND d.businessId=? AND i.isActive=1 AND d.state='provisioning'
            AND d.revision=? AND d.leaseToken=? AND d.leasedUntil>?`,
        [wire.deploymentId, wire.businessId, wire.revision, wire.leaseToken, Date.now()]);
        if (!row) throw fail('MODULE_ENROLLMENT_LEASE_LOST');
        if (receipt.deploymentId !== row.id || receipt.businessId !== row.businessId || receipt.revision !== row.revision
            || ['module','hostname','namespace','sourceCommit'].some(key => receipt[key] !== row[key])
            || (row.module === 'twenty' ? !uuidPattern.test(receipt.nativeScope || '') : receipt.nativeScope !== row.namespace)) {
            throw fail('MODULE_ENROLLMENT_INVALID');
        }
        const publicOrigin = origin(`https://${row.hostname}`);
        const previous = DB.get('SELECT * FROM ava_module_enrollments WHERE deploymentId=?', [row.id]);
        if (previous) {
            if (previous.businessId !== row.businessId || previous.module !== row.module
                || previous.deploymentRevision !== row.revision || previous.publicOrigin !== publicOrigin
                || previous.nativeScope !== receipt.nativeScope || previous.peerSecretHash !== receipt.peerSecretHash) {
                throw fail('MODULE_ENROLLMENT_CHANGED');
            }
            return { id: row.id, state: previous.state, businessId: row.businessId, module: row.module };
        }
        DB.run(`INSERT INTO ava_module_enrollments(deploymentId,businessId,module,deploymentRevision,publicOrigin,
            nativeScope,peerSecretHash,state,createdAt) VALUES (?,?,?,?,?,?,?,'prepared',?)`,
        [row.id, row.businessId, row.module, row.revision, publicOrigin, receipt.nativeScope, receipt.peerSecretHash, Date.now()]);
        return { id: row.id, state: 'prepared', businessId: row.businessId, module: row.module };
    }).immediate();
}

// Only the final verified deployment can become a broker peer. Native identity
// enrollment, container health and TLS by themselves never grant buyer access.
function activateDeployment(input) {
    workerOnly(); schema();
    const keys = input && Object.keys(input).sort().join();
    const isolated = keys === 'attachmentMode,businessId,deploymentId,expectedRevision'
        && input.attachmentMode === ATTACHMENT_MODE_ISOLATED_WORKSPACE_UI;
    if (!input || (!isolated && keys !== 'businessId,deploymentId,expectedRevision')
        || !uuidPattern.test(input.deploymentId || '') || !Number.isSafeInteger(input.businessId) || input.businessId < 1
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw fail('MODULE_ENROLLMENT_INVALID');
    return DB.db.transaction(() => {
        const row = DB.get(`SELECT d.* FROM ava_module_deployments d JOIN instances i ON i.id=d.businessId
            WHERE d.id=? AND d.businessId=? AND i.isActive=1 AND d.state='verified' AND d.revision=?`,
        [input.deploymentId, input.businessId, input.expectedRevision]);
        if (!row) throw fail('MODULE_DEPLOYMENT_NOT_VERIFIED');
        if (isolated && row.module !== 'onyx') throw fail('MODULE_ATTACHMENT_MODE_INVALID');
        const prepared = DB.get('SELECT * FROM ava_module_enrollments WHERE deploymentId=?', [row.id]);
        if (!prepared || prepared.businessId !== row.businessId || prepared.module !== row.module
            || prepared.deploymentRevision !== row.revision || prepared.publicOrigin !== `https://${row.hostname}`) {
            throw fail('MODULE_ENROLLMENT_CHANGED');
        }
        const linked = integration(row.businessId, row.module);
        if (linked.scope !== prepared.nativeScope) throw fail('MODULE_ENROLLMENT_CHANGED');
        const existing = DB.get('SELECT * FROM ava_module_adapters WHERE businessId=? AND module=?', [row.businessId, row.module]);
        if (existing && (existing.id !== row.id || existing.deploymentId !== row.id)) {
            throw fail('MODULE_EXISTING_ADAPTER_MIGRATION_REQUIRED');
        }
        if (existing) {
            if (isolated && (existing.attachmentMode !== ATTACHMENT_MODE_EXISTING_WORKSPACE_UI
                || existing.attachmentModeV2 !== ATTACHMENT_MODE_ISOLATED_WORKSPACE_UI)) {
                throw fail('MODULE_EXISTING_ADAPTER_MIGRATION_REQUIRED');
            }
            if (prepared.state !== 'active' || !existing.enabled || existing.revision !== prepared.adapterRevision
                || existing.deploymentRevision !== row.revision || existing.peerSecretHash !== prepared.peerSecretHash
                || existing.nativeScope !== prepared.nativeScope || existing.publicOrigin !== prepared.publicOrigin
                || existing.integrationId !== linked.id || existing.integrationRevision !== linked.revision) {
                throw fail('MODULE_ENROLLMENT_CHANGED');
            }
            return { id: existing.id, revision: existing.revision, businessId: row.businessId, module: row.module };
        }
        if (prepared.state !== 'prepared') throw fail('MODULE_ENROLLMENT_CHANGED');
        DB.run(`INSERT INTO ava_module_adapters(id,businessId,module,publicOrigin,nativeScope,integrationId,integrationRevision,
            peerSecretHash,deploymentId,deploymentRevision,attachmentMode,attachmentModeV2) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.id, row.businessId, row.module, prepared.publicOrigin, prepared.nativeScope, linked.id, linked.revision,
            prepared.peerSecretHash, row.id, row.revision,
            isolated ? ATTACHMENT_MODE_EXISTING_WORKSPACE_UI : ATTACHMENT_MODE_FULL,
            isolated ? ATTACHMENT_MODE_ISOLATED_WORKSPACE_UI : null]);
        DB.run("UPDATE ava_module_enrollments SET state='active',adapterRevision=1,activatedAt=? WHERE deploymentId=?", [Date.now(), row.id]);
        return { id: row.id, revision: 1, businessId: row.businessId, module: row.module };
    }).immediate();
}

function disable(adapterId) {
    workerOnly(); schema();
    DB.db.transaction(() => {
        const adapter = DB.get('SELECT * FROM ava_module_adapters WHERE id=?', [adapterId]);
        DB.run('UPDATE ava_module_adapters SET enabled=0,revision=revision+1 WHERE id=?', [adapterId]);
        if (adapter?.module === 'twenty') {
            // Closing the adapter prevents new acquire/readback immediately,
            // but an in-flight native write is not canceled by changing this
            // SQLite row. Keep its active barrier until the old peer reports a
            // terminal outcome (or an external supervisor proves process
            // death and releases it as fenced).
            DB.run("UPDATE ava_sync_leases SET outcome='disable_pending' WHERE adapterId=? AND status='active'", [adapter.id]);
        }
    }).immediate();
}

function member(userId, adapter) {
    const user = Identity.actor(userId);
    const membership = user.memberships.find(item => item.businessId === adapter.businessId);
    // A platform administrator is not silently turned into the customer's
    // native identity. Break-glass access remains a separate path.
    if (!user.subject || user.platformRole !== 'customer' || !membership) throw fail('MODULE_MEMBERSHIP_REQUIRED');
    assertNativeRole(membership.role);
    return { user, role: membership.role };
}

async function verifyPrincipal({ adapterId, userId, nativeUserId, readback }) {
    workerOnly(); schema();
    if (typeof nativeUserId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(nativeUserId)
        || typeof readback !== 'function') throw fail('MODULE_NATIVE_ADAPTER_REQUIRED', 503);
    const adapter = currentAdapter(adapterId), initial = member(userId, adapter);
    // Implementations must perform native positive/negative probes. This
    // callback is an internal adapter interface, never an HTTP request body.
    const proof = await readback({ module: adapter.module, businessId: adapter.businessId,
        nativeScope: adapter.nativeScope, nativeUserId, subject: initial.user.subject, role: initial.role });
    return DB.db.transaction(() => {
        workerOnly();
        const current = currentAdapter(adapterId), latest = member(userId, current);
        if (current.revision !== adapter.revision || latest.user.subject !== initial.user.subject || latest.role !== initial.role) {
            throw fail('MODULE_CONFIGURATION_CHANGED');
        }
        if (!proof || proof.nativeUserId !== nativeUserId || proof.subject !== latest.user.subject
            || proof.nativeScope !== current.nativeScope || proof.role !== latest.role
            || proof.ownAccess !== true || proof.foreignAccessDenied !== true
            || proof.platformAdminDenied !== true || proof.sessionGuardVerified !== true) throw fail('MODULE_NATIVE_PROOF_INCOMPLETE');
        const reusedIdentity = DB.get(`SELECT p.id FROM ava_module_principals p
            JOIN ava_module_adapters a ON a.id=p.adapterId
            WHERE a.module=? AND a.publicOrigin=? AND p.nativeUserId=? AND p.userId!=? LIMIT 1`,
        [current.module, current.publicOrigin, nativeUserId, userId]);
        if (reusedIdentity) throw fail('MODULE_NATIVE_IDENTITY_ALREADY_LINKED');
        const existing = DB.get('SELECT id FROM ava_module_principals WHERE adapterId=? AND userId=?', [adapterId, userId]);
        const id = existing?.id || crypto.randomUUID();
        // Re-binding a native identity must invalidate even previously issued
        // sessions. Do not update an identity underneath a live grant.
        if (existing) {
            DB.run('DELETE FROM ava_module_grants WHERE principalId=?', [id]);
            DB.run('UPDATE ava_module_sessions SET revokedAt=? WHERE principalId=?', [Date.now(), id]);
        }
        DB.run(`INSERT INTO ava_module_principals(id,adapterId,userId,subject,nativeUserId,role,adapterRevision,verifiedAt)
            VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(adapterId,userId) DO UPDATE SET subject=excluded.subject,
            nativeUserId=excluded.nativeUserId,role=excluded.role,adapterRevision=excluded.adapterRevision,verifiedAt=excluded.verifiedAt`,
        [id, adapterId, userId, latest.user.subject, nativeUserId, latest.role, current.revision, Date.now()]);
        return { id, businessId: current.businessId, module: current.module };
    }).immediate();
}

function principal(id, adapter) {
    const row = DB.get('SELECT * FROM ava_module_principals WHERE id=? AND adapterId=?', [id, adapter.id]);
    if (!row?.verifiedAt || row.adapterRevision !== adapter.revision) throw fail('MODULE_PRINCIPAL_NOT_VERIFIED');
    const latest = member(row.userId, adapter);
    if (latest.user.subject !== row.subject || latest.role !== row.role) throw fail('MODULE_MEMBERSHIP_CHANGED');
    return row;
}

function parentSession(hash, userId) {
    const row = DB.get('SELECT * FROM ava_sessions WHERE tokenHash=? AND userId=? AND revokedAt IS NULL AND expiresAt>?',
        [hash, userId, Date.now()]);
    if (!row) throw fail('MODULE_PARENT_SESSION_REVOKED');
    return row;
}

function peer(adapterId, secret) {
    if (typeof secret !== 'string' || !tokenPattern.test(secret)) throw fail('MODULE_PEER_DENIED');
    const adapter = currentAdapter(adapterId);
    if (!crypto.timingSafeEqual(Buffer.from(digest(secret), 'hex'), Buffer.from(adapter.peerSecretHash, 'hex'))) throw fail('MODULE_PEER_DENIED');
    return adapter;
}

// Internal service contracts only; never expose adapter credentials in HTTP DTOs.
function authenticatePeer(adapterId, secret) {
    schema();
    return peer(adapterId, secret);
}

function getCurrentAdapter(adapterId) {
    schema();
    return currentAdapter(adapterId);
}

// Cleanup deliberately remains available after business/adapter disable. This
// credential grants deletion acknowledgements only, never authorization.
function cleanupPeer(adapterId, secret) {
    if (typeof secret !== 'string' || !tokenPattern.test(secret)) throw fail('MODULE_PEER_DENIED');
    const adapter = DB.get('SELECT * FROM ava_module_adapters WHERE id=?', [adapterId]);
    if (!adapter || !crypto.timingSafeEqual(Buffer.from(digest(secret), 'hex'), Buffer.from(adapter.peerSecretHash, 'hex'))) throw fail('MODULE_PEER_DENIED');
    return adapter;
}

function issue({ sessionToken, adapterId, codeChallenge }) {
    schema();
    if (typeof sessionToken !== 'string' || !tokenPattern.test(sessionToken)
        || typeof codeChallenge !== 'string' || !tokenPattern.test(codeChallenge)) throw fail('MODULE_GRANT_INVALID');
    return DB.db.transaction(() => {
        const user = Identity.session(sessionToken);
        if (!user) throw fail('MODULE_PARENT_SESSION_REVOKED');
        const adapter = currentAdapter(adapterId);
        const liveRole = user.memberships.find(item => item.businessId === adapter.businessId)?.role;
        if (liveRole) assertNativeRole(liveRole);
        const binding = DB.get('SELECT id FROM ava_module_principals WHERE userId=? AND adapterId=?', [user.userId, adapterId]);
        const native = principal(binding?.id || '', adapter);
        const parent = parentSession(digest(sessionToken), user.userId);
        const token = random(), expiresAt = Math.min(Date.now() + 60000, parent.expiresAt);
        DB.run('DELETE FROM ava_module_grants WHERE expiresAt<=?', [Date.now()]);
        DB.run(`INSERT INTO ava_module_grants(tokenHash,principalId,parentSessionHash,adapterRevision,challenge,expiresAt)
            VALUES (?,?,?,?,?,?)`, [digest(token), native.id, parent.tokenHash, adapter.revision, codeChallenge, expiresAt]);
        return { code: token, expiresAt, businessId: adapter.businessId, module: adapter.module,
            // No client-supplied callback, hostname, email or business override.
            callbackUrl: `${adapter.publicOrigin}/ava-auth/callback` };
    }).immediate();
}

function redeem({ adapterId, peerSecret, code, verifier }) {
    schema();
    if (typeof code !== 'string' || !tokenPattern.test(code) || typeof verifier !== 'string'
        || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw fail('MODULE_GRANT_INVALID');
    return DB.db.transaction(() => {
        const adapter = peer(adapterId, peerSecret);
        const grant = DB.get('SELECT * FROM ava_module_grants WHERE tokenHash=? AND consumedAt IS NULL AND expiresAt>?', [digest(code), Date.now()]);
        if (!grant || grant.adapterRevision !== adapter.revision) throw fail('MODULE_GRANT_INVALID');
        const native = principal(grant.principalId, adapter);
        const parent = parentSession(grant.parentSessionHash, native.userId);
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        if (!crypto.timingSafeEqual(Buffer.from(challenge), Buffer.from(grant.challenge))) throw fail('MODULE_PKCE_INVALID');
        const token = random(), bindingId = crypto.randomUUID(), expiresAt = Math.min(Date.now() + 3600000, parent.expiresAt);
        const changed = DB.run('UPDATE ava_module_grants SET consumedAt=? WHERE tokenHash=? AND consumedAt IS NULL', [Date.now(), grant.tokenHash]);
        if (changed.changes !== 1) throw fail('MODULE_GRANT_INVALID');
        DB.run(`INSERT INTO ava_module_sessions(tokenHash,bindingId,principalId,parentSessionHash,adapterRevision,expiresAt)
            VALUES (?,?,?,?,?,?)`, [digest(token), bindingId, native.id, parent.tokenHash, adapter.revision, expiresAt]);
        // Only the authenticated native adapter receives this response. The
        // opaque session remains server-side alongside its native session ID.
        return { sessionHandle: token, bindingId, expiresAt, revision: adapter.revision, userId: native.userId,
            businessId: adapter.businessId, module: adapter.module,
            nativeScope: adapter.nativeScope, nativeUserId: native.nativeUserId, subject: native.subject, role: native.role };
    }).immediate();
}

function authorize({ adapterId, peerSecret, sessionHandle }) {
    schema();
    if (typeof sessionHandle !== 'string' || !tokenPattern.test(sessionHandle)) throw fail('MODULE_SESSION_INVALID');
    return DB.db.transaction(() => {
        const adapter = peer(adapterId, peerSecret);
        const session = DB.get('SELECT * FROM ava_module_sessions WHERE tokenHash=? AND revokedAt IS NULL AND expiresAt>?', [digest(sessionHandle), Date.now()]);
        if (!session || session.adapterRevision !== adapter.revision) throw fail('MODULE_SESSION_INVALID');
        const native = principal(session.principalId, adapter);
        parentSession(session.parentSessionHash, native.userId);
        return { bindingId: session.bindingId, expiresAt: session.expiresAt, revision: adapter.revision,
            userId: native.userId, businessId: adapter.businessId, module: adapter.module, nativeScope: adapter.nativeScope,
            nativeUserId: native.nativeUserId, subject: native.subject, role: native.role };
    }).immediate();
}

// The adapter can revoke only its own session. Revoking one module does not
// silently revoke the user's whole AVA login. Global logout is owned by Identity.
function logout({ adapterId, peerSecret, sessionHandle }) {
    schema();
    if (typeof sessionHandle !== 'string' || !tokenPattern.test(sessionHandle)) throw fail('MODULE_SESSION_INVALID');
    return DB.db.transaction(() => {
        const adapter = cleanupPeer(adapterId, peerSecret);
        const row = DB.get(`SELECT s.tokenHash FROM ava_module_sessions s
            JOIN ava_module_principals p ON p.id=s.principalId WHERE s.tokenHash=? AND p.adapterId=?`,
        [digest(sessionHandle), adapter.id]);
        if (!row) throw fail('MODULE_SESSION_INVALID');
        DB.run('UPDATE ava_module_sessions SET revokedAt=COALESCE(revokedAt,?) WHERE tokenHash=?', [Date.now(), row.tokenHash]);
        return { revoked: true };
    }).immediate();
}

function logoutAll({ adapterId, peerSecret, sessionHandle }) {
    schema();
    if (typeof sessionHandle !== 'string' || !tokenPattern.test(sessionHandle)) throw fail('MODULE_SESSION_INVALID');
    return DB.db.transaction(() => {
        const adapter = cleanupPeer(adapterId, peerSecret);
        const row = DB.get(`SELECT s.parentSessionHash FROM ava_module_sessions s
            JOIN ava_module_principals p ON p.id=s.principalId WHERE s.tokenHash=? AND p.adapterId=?`,
        [digest(sessionHandle), adapter.id]);
        if (!row) throw fail('MODULE_SESSION_INVALID');
        Identity.enqueueLogoutBySessionHash(row.parentSessionHash);
        collectRevocations();
        return { revoked: true, nativeRevocationPending: true };
    }).immediate();
}

function list({ sessionToken, businessId }) {
    schema();
    const user = Identity.session(sessionToken);
    if (!user) throw fail('MODULE_PARENT_SESSION_REVOKED');
    Identity.authorizeBusiness(user, businessId);
    return listForUser(user, businessId);
}

function navigation({ adapterId, peerSecret, sessionHandle }) {
    const authorized = authorize({ adapterId, peerSecret, sessionHandle });
    const user = Identity.actor(authorized.userId);
    const business = DB.get('SELECT name FROM instances WHERE id=? AND isActive=1', [authorized.businessId]);
    if (!business) throw fail('MODULE_BUSINESS_INACTIVE');
    return { business_id: authorized.businessId, business_name: business.name,
        module: authorized.module, modules: listForUser(user, authorized.businessId) };
}

function listForUser(user, businessId) {
    return ['twenty','onyx'].map(module => {
        const result = { business_id: Number(businessId), module,
            label: module === 'twenty' ? 'CRM' : 'Знания', state: 'awaiting_setup',
            revision: null, last_verified_at: null, allowed_actions: [], error_code: 'MODULE_NOT_CONFIGURED' };
        const row = DB.get('SELECT id FROM ava_module_adapters WHERE businessId=? AND module=?', [Number(businessId), module]);
        if (!row) return result;
        try {
            const adapter = currentAdapter(row.id);
            member(user.userId, adapter);
            const binding = DB.get('SELECT id FROM ava_module_principals WHERE userId=? AND adapterId=?', [user.userId, adapter.id]);
            const native = principal(binding?.id || '', adapter);
            return { ...result, adapter_id: adapter.id, deployment_id: adapter.deploymentId || null,
                state: 'verified', revision: adapter.revision,
                last_verified_at: new Date(native.verifiedAt).toISOString(), allowed_actions: ['open'], error_code: null,
                // This is a fixed local adapter endpoint, never an arbitrary redirect URL.
                start_url: `${adapter.publicOrigin}/ava-auth/start` };
        } catch (error) {
            return { ...result, error_code: /^MODULE_[A-Z_]+$/.test(error.code || '') ? error.code : 'MODULE_ACCESS_UNAVAILABLE' };
        }
    });
}

// Called inside the membership role/remove transaction. Business-scoped native
// denial must preserve the user's AVA login and all other business sessions.
function revokeBusinessAccess(userId, businessId) {
    schema();
    const scope = Number(businessId);
    if (typeof userId !== 'string' || !userId || !Number.isSafeInteger(scope) || scope < 1) {
        throw fail('MODULE_SCOPE_INVALID');
    }
    return DB.db.transaction(() => {
        const ids = DB.all(`SELECT p.id FROM ava_module_principals p
            JOIN ava_module_adapters a ON a.id=p.adapterId WHERE p.userId=? AND a.businessId=?`, [userId, scope]);
        let grantsRevoked = 0, sessionsRevoked = 0;
        const now = Date.now();
        for (const { id } of ids) {
            grantsRevoked += DB.run('DELETE FROM ava_module_grants WHERE principalId=?', [id]).changes;
            sessionsRevoked += DB.run('UPDATE ava_module_sessions SET revokedAt=? WHERE principalId=? AND revokedAt IS NULL', [now, id]).changes;
            // A changed role requires new native proof, never an automatic map.
            DB.run('UPDATE ava_module_principals SET verifiedAt=NULL WHERE id=?', [id]);
        }
        collectRevocations({ userId, businessId: scope });
        // Historical sessions without a binding cannot receive a native ACK.
        // Local denial is still immediate, but never report cleanup as proved.
        const pending = DB.get(`SELECT COUNT(*) AS n FROM ava_module_sessions s
            JOIN ava_module_principals p ON p.id=s.principalId
            JOIN ava_module_adapters a ON a.id=p.adapterId
            LEFT JOIN ava_module_revocations r ON r.bindingId=s.bindingId
            WHERE p.userId=? AND a.businessId=?
                AND (s.bindingId IS NULL OR r.state IS NULL OR r.state!='done')`, [userId, scope]).n;
        return { businessId: scope, principalsInvalidated: ids.length, grantsRevoked, sessionsRevoked,
            nativeRevocationPending: pending > 0 };
    }).immediate();
}

function collectRevocations({ userId = null, businessId = null } = {}) {
    schema();
    return DB.db.transaction(() => {
        // Local denial is immediate. This outbox additionally removes actual
        // native sessions, even if no further browser request ever arrives.
        const rows = DB.all(`SELECT s.*,p.adapterId,p.userId FROM ava_module_sessions s
            JOIN ava_module_principals p ON p.id=s.principalId
            JOIN ava_module_adapters a ON a.id=p.adapterId
            LEFT JOIN ava_module_revocations r ON r.bindingId=s.bindingId
            WHERE s.bindingId IS NOT NULL AND r.bindingId IS NULL
                AND (? IS NULL OR p.userId=?) AND (? IS NULL OR a.businessId=?)`,
        [userId, userId, businessId, businessId]);
        let count = 0;
        for (const row of rows) {
            let invalid = row.revokedAt !== null || row.expiresAt <= Date.now();
            if (!invalid) {
                try {
                    const adapter = currentAdapter(row.adapterId);
                    if (adapter.revision !== row.adapterRevision) throw fail('MODULE_CONFIGURATION_CHANGED');
                    const native = principal(row.principalId, adapter);
                    parentSession(row.parentSessionHash, native.userId);
                } catch (_) { invalid = true; }
            }
            if (!invalid) continue;
            DB.run('UPDATE ava_module_sessions SET revokedAt=COALESCE(revokedAt,?) WHERE tokenHash=?', [Date.now(), row.tokenHash]);
            DB.run(`INSERT OR IGNORE INTO ava_module_revocations(bindingId,adapterId,nextAttemptAt,createdAt)
                VALUES (?,?,?,?)`, [row.bindingId, row.adapterId, Date.now(), Date.now()]);
            count++;
        }
        return count;
    }).immediate();
}

function leaseRevocation({ adapterId, peerSecret }) {
    schema();
    return DB.db.transaction(() => {
        const adapter = cleanupPeer(adapterId, peerSecret);
        collectRevocations();
        DB.run(`UPDATE ava_module_revocations SET state='pending',leaseToken=NULL,leasedUntil=NULL
            WHERE adapterId=? AND state='leased' AND leasedUntil<=?`, [adapter.id, Date.now()]);
        DB.run(`UPDATE ava_module_revocations SET state='failed',lastErrorCode='NATIVE_REVOKE_ATTEMPTS_EXHAUSTED'
            WHERE adapterId=? AND state='pending' AND attempts>=8`, [adapter.id]);
        const row = DB.get(`SELECT * FROM ava_module_revocations WHERE adapterId=? AND state='pending'
            AND nextAttemptAt<=? ORDER BY createdAt,bindingId LIMIT 1`, [adapter.id, Date.now()]);
        if (!row) return { job: null };
        const token = crypto.randomUUID(), expiresAt = Date.now() + 30000;
        DB.run(`UPDATE ava_module_revocations SET state='leased',attempts=attempts+1,leaseToken=?,leasedUntil=?
            WHERE bindingId=?`, [token, expiresAt, row.bindingId]);
        return { job: { bindingId: row.bindingId, leaseToken: token, expiresAt, action: 'revoke_session' } };
    }).immediate();
}

function finishRevocation({ adapterId, peerSecret, bindingId, leaseToken, result }) {
    schema();
    if (!/^[0-9a-f-]{36}$/.test(bindingId || '') || !/^[0-9a-f-]{36}$/.test(leaseToken || '')
        || !['native_session_absent','retry'].includes(result)) throw fail('MODULE_REVOCATION_INVALID');
    return DB.db.transaction(() => {
        const adapter = cleanupPeer(adapterId, peerSecret);
        const row = DB.get(`SELECT * FROM ava_module_revocations WHERE bindingId=? AND adapterId=?
            AND state='leased' AND leaseToken=? AND leasedUntil>?`, [bindingId, adapter.id, leaseToken, Date.now()]);
        if (!row) throw fail('MODULE_REVOCATION_LEASE_LOST');
        const done = result === 'native_session_absent';
        DB.run(`UPDATE ava_module_revocations SET state=?,leaseToken=NULL,leasedUntil=NULL,lastErrorCode=?,completedAt=?,nextAttemptAt=?
            WHERE bindingId=? AND leaseToken=?`, [done ? 'done' : row.attempts >= 8 ? 'failed' : 'pending',
            done ? null : 'NATIVE_SESSION_REVOCATION_UNVERIFIED', done ? Date.now() : null,
            Date.now() + Math.min(3600000, 5000 * 2 ** (row.attempts - 1)), bindingId, leaseToken]);
        return { completed: done };
    }).immediate();
}

const SYNC_CONTRACT = 'ava-sync-lease-v1';
const SYNC_RECOVERY_CONTRACT = 'ava-sync-recovery-v1';
const SYNC_RECOVERY_CLAIM_MS = 10 * 60 * 1000;
const SYNC_ALLOWED_OBJECTS = new Set(['people','companies','tasks','avaCalls','avaCampaigns','avaCampaignMembers','avaCallAttempts','avaFollowUpDrafts','avaBookingRequests']);
const SYNC_DEFAULT_ENTITIES = Object.freeze({
    hotel: Object.freeze({ objectName: 'companies', sourceTable: 'instances' }),
    person: Object.freeze({ objectName: 'people', sourceTable: 'clients' }),
    manager_task: Object.freeze({ objectName: 'tasks', sourceTable: 'manager_tasks' }),
    call: Object.freeze({ objectName: 'avaCalls', sourceTable: 'conversation_events' }),
    outbound_campaign: Object.freeze({ objectName: 'avaCampaigns', sourceTable: 'outbound_campaigns' }),
    outbound_lead: Object.freeze({ objectName: 'avaCampaignMembers', sourceTable: 'outbound_leads' }),
    outbound_attempt: Object.freeze({ objectName: 'avaCallAttempts', sourceTable: 'outbound_attempts' }),
    followup_draft: Object.freeze({ objectName: 'avaFollowUpDrafts', sourceTable: 'followup_drafts' }),
    booking_request: Object.freeze({ objectName: 'avaBookingRequests', sourceTable: 'pms_booking_requests' }),
});
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_REGEX = /^[0-9a-f]{64}$/;

const exactObject = (value, keys) => Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(','));

function canonicalSyncBody(value, depth = 0) {
    if (depth > 8) throw fail('MODULE_SYNC_BODY_INVALID', 400);
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(item => canonicalSyncBody(item, depth + 1)).join(',')}]`;
    if (value && typeof value === 'object'
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalSyncBody(value[key], depth + 1)}`).join(',')}}`;
    }
    throw fail('MODULE_SYNC_BODY_INVALID', 400);
}

function expectedDeployment(adapter) {
    // A shared/existing Twenty workspace is authorized for the UI identity
    // bridge only. It has no AVA-controlled native runtime or storage boundary
    // from which a sync lease could be safely issued.
    if ([ATTACHMENT_MODE_EXISTING_WORKSPACE_UI, ATTACHMENT_MODE_ISOLATED_WORKSPACE_UI].includes(adapter.attachmentMode)) {
        throw fail('MODULE_EXISTING_WORKSPACE_UI_ONLY', 403);
    }
    return {
        deploymentId: adapter.deploymentId || adapter.id,
        revision: adapter.deploymentRevision || adapter.revision,
    };
}

function exactSyncPath(method, objectName, recordId) {
    return method === 'POST' ? `/rest/${objectName}` : `/rest/${objectName}/${recordId}`;
}

// Called only by the AVA-owned CRM sync producer after it has loaded the
// tenant-scoped source row and built the exact native REST request. The native
// process cannot create or alter this binding through the private broker.
function prepareSyncMutation(input) {
    schema();
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || !Number.isSafeInteger(input.businessId) || input.businessId < 1
        || typeof input.correlationId !== 'string'
        || (!UUID_REGEX.test(input.correlationId) && !/^twout_[0-9a-f-]{32,36}$/i.test(input.correlationId))
        || typeof input.outboxLeaseToken !== 'string' || !UUID_REGEX.test(input.outboxLeaseToken)
        || !Number.isSafeInteger(input.integrationRevision) || input.integrationRevision < 1) {
        throw fail('MODULE_SYNC_PREPARATION_INVALID', 400);
    }
    const configuredAdapter = DB.get("SELECT id,enabled FROM ava_module_adapters WHERE businessId=? AND module='twenty'", [input.businessId]);
    if (!configuredAdapter) {
        return { prepared: false, reason: 'MODULE_ADAPTER_UNAVAILABLE' };
    }
    // Once a buyer has a native adapter, disabling it must fence the producer
    // too. Falling back to the legacy unguarded client here would turn the
    // disable switch into an authorization bypass.
    if (!configuredAdapter.enabled) throw fail('MODULE_ADAPTER_UNAVAILABLE', 403);

    // This is not an automatic fallback. An explicitly attached, pre-existing
    // Twenty workspace keeps its AVA UI/session authorization, while its
    // unchanged legacy runtime owns normal sync execution. Check all mutable
    // AVA linkage first so disabling or a changed integration can never use
    // this response to evade the adapter fence.
    const uiOnly = DB.db.transaction(() => {
        const adapter = DB.get("SELECT * FROM ava_module_adapters WHERE businessId=? AND module='twenty' AND enabled=1", [input.businessId]);
        if (!adapter) throw fail('MODULE_ADAPTER_UNAVAILABLE', 403);
        const current = currentAdapter(adapter.id);
        if (current.attachmentMode !== ATTACHMENT_MODE_EXISTING_WORKSPACE_UI) return null;
        const link = DB.get('SELECT * FROM twenty_workspace_links WHERE businessId=? AND enabled=1', [input.businessId]);
        if (!link || link.workspaceId !== current.nativeScope || Number(link.revision) !== input.integrationRevision
            || Number(current.integrationRevision) !== input.integrationRevision) {
            throw fail('MODULE_CONFIGURATION_CHANGED', 403);
        }
        return { prepared: false, reason: 'MODULE_EXISTING_WORKSPACE_UI_LEGACY_RUNTIME' };
    }).immediate();
    if (uiOnly) return uiOnly;

    const method = String(input.method || '').toUpperCase();
    if (!['GET', 'POST', 'PATCH'].includes(method) || !SYNC_ALLOWED_OBJECTS.has(input.objectName)) {
        throw fail('MODULE_SYNC_PREPARATION_INVALID', 400);
    }
    const recordId = input.recordId == null ? null : String(input.recordId);
    if ((method === 'POST' && recordId !== null)
        || (method !== 'POST' && !UUID_REGEX.test(recordId || ''))) {
        throw fail('MODULE_SYNC_PREPARATION_INVALID', 400);
    }
    const path = exactSyncPath(method, input.objectName, recordId);
    let bodyDigest = null;
    let bodyJson = null;
    if (method === 'POST' || method === 'PATCH') {
        if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
            throw fail('MODULE_SYNC_BODY_INVALID', 400);
        }
        if (input.body.avaBusinessId != null && String(input.body.avaBusinessId) !== String(input.businessId)) {
            throw fail('MODULE_SCOPE_MISMATCH', 403);
        }
        bodyJson = canonicalSyncBody(input.body);
        if (Buffer.byteLength(bodyJson) > 65536) throw fail('MODULE_SYNC_BODY_INVALID', 400);
        bodyDigest = digest(bodyJson);
    } else if (input.body !== null && input.body !== undefined) {
        throw fail('MODULE_SYNC_BODY_INVALID', 400);
    }

    return DB.db.transaction(() => {
        const adapter = DB.get("SELECT * FROM ava_module_adapters WHERE businessId=? AND module='twenty' AND enabled=1", [input.businessId]);
        // The preflight already proved an adapter exists. Losing it or seeing
        // it disabled at the serialized check is a fence, never legacy mode.
        if (!adapter) throw fail('MODULE_ADAPTER_UNAVAILABLE', 403);
        const current = currentAdapter(adapter.id);
        const deployment = expectedDeployment(current);
        const link = DB.get('SELECT * FROM twenty_workspace_links WHERE businessId=? AND enabled=1', [input.businessId]);
        if (!link || link.workspaceId !== current.nativeScope || Number(link.revision) !== input.integrationRevision
            || Number(current.integrationRevision) !== input.integrationRevision) {
            throw fail('MODULE_CONFIGURATION_CHANGED', 403);
        }
        const outbox = DB.get(`SELECT * FROM twenty_sync_outbox WHERE eventId=? AND businessId=? AND status='LEASED'
            AND leaseToken=? AND datetime(leasedUntil)>datetime('now')`,
        [input.correlationId, input.businessId, input.outboxLeaseToken]);
        if (!outbox) throw fail('MODULE_SYNC_LEASE_FENCED', 403);
        const mapping = SYNC_DEFAULT_ENTITIES[outbox.entityType];
        if (!mapping || mapping.objectName !== input.objectName || mapping.sourceTable !== outbox.sourceTable
            || outbox.operation !== 'upsert') throw fail('MODULE_SYNC_MAPPING_INVALID', 403);
        if (DB.get(`SELECT r.recoveryId FROM ava_sync_lease_recoveries r
            JOIN ava_sync_leases l ON l.leaseId=r.leaseId
            WHERE l.correlationId=? AND l.businessId=? AND r.state='readback_required'`,
        [input.correlationId, input.businessId])) throw fail('MODULE_SYNC_RECOVERY_READBACK_REQUIRED', 409);
        if (DB.get("SELECT leaseId FROM ava_sync_leases WHERE correlationId=? AND status='active'", [input.correlationId])) {
            throw fail('MODULE_SYNC_LEASE_CONCURRENT', 409);
        }
        const remoteConflict = recordId && DB.get(`SELECT r.businessId,r.sourceTable,r.sourceId FROM twenty_record_links r
            JOIN twenty_workspace_links w ON w.businessId=r.businessId
            WHERE w.workspaceId=? AND r.twentyObject=? AND r.twentyRecordId=? LIMIT 1`,
        [current.nativeScope, input.objectName, recordId]);
        if (remoteConflict && (remoteConflict.businessId !== input.businessId
            || remoteConflict.sourceTable !== outbox.sourceTable
            || String(remoteConflict.sourceId) !== String(outbox.sourceId))) {
            throw fail('MODULE_SCOPE_MISMATCH', 403);
        }
        DB.run(`INSERT INTO ava_sync_mutations(correlationId,businessId,adapterId,deploymentId,nativeScope,revision,
            integrationRevision,outboxLeaseHash,method,path,objectName,recordId,bodyDigest,bodyJson,preparedAt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(correlationId) DO UPDATE SET
            businessId=excluded.businessId,adapterId=excluded.adapterId,deploymentId=excluded.deploymentId,
            nativeScope=excluded.nativeScope,revision=excluded.revision,integrationRevision=excluded.integrationRevision,
            outboxLeaseHash=excluded.outboxLeaseHash,method=excluded.method,path=excluded.path,
            objectName=excluded.objectName,recordId=excluded.recordId,bodyDigest=excluded.bodyDigest,
            bodyJson=excluded.bodyJson,preparedAt=excluded.preparedAt`, [
            input.correlationId, input.businessId, current.id, deployment.deploymentId, current.nativeScope,
            deployment.revision, input.integrationRevision, digest(input.outboxLeaseToken), method, path,
            input.objectName, recordId, bodyDigest, bodyJson, Date.now(),
        ]);
        return { prepared: true, correlationId: input.correlationId, method, path, objectName: input.objectName,
            recordId, bodyDigest };
    }).immediate();
}

function acquireSyncLease(claim, peerAuth) {
    schema();
    if (!peerAuth?.adapterId || !peerAuth?.peerSecret) throw fail('MODULE_PEER_DENIED', 403);
    // Authenticate before detailed claim validation so an unauthenticated
    // caller cannot use validation differences as a broker oracle.
    const syncAdapter = peer(peerAuth.adapterId, peerAuth.peerSecret);
    expectedDeployment(syncAdapter);
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw fail('MODULE_CLAIM_INVALID', 400);
    if (claim.contractVersion !== SYNC_CONTRACT) throw fail('MODULE_CONTRACT_INVALID', 400);

    for (const key of ['deploymentId', 'nativeScope', 'nativeKeyId', 'roleId']) {
        if (typeof claim[key] !== 'string' || !UUID_REGEX.test(claim[key])) {
            throw fail('MODULE_CLAIM_INVALID', 400);
        }
    }
    if (typeof claim.correlationId !== 'string' || (!UUID_REGEX.test(claim.correlationId) && !/^twout_[0-9a-f-]{32,36}$/i.test(claim.correlationId))) {
        throw fail('MODULE_CLAIM_INVALID', 400);
    }
    for (const key of ['businessId', 'revision', 'generation']) {
        if (!Number.isSafeInteger(claim[key]) || claim[key] < 1) {
            throw fail('MODULE_CLAIM_INVALID', 400);
        }
    }

    const method = String(claim.method || '').toUpperCase();
    if (!['GET', 'POST', 'PATCH'].includes(method)) throw fail('MODULE_CLAIM_INVALID', 400);
    if (typeof claim.path !== 'string' || !claim.path.startsWith('/rest/')) throw fail('MODULE_CLAIM_INVALID', 400);
    if (!SYNC_ALLOWED_OBJECTS.has(claim.objectName)) throw fail('MODULE_CLAIM_INVALID', 400);

    if (method === 'POST') {
        if (claim.recordId !== null && claim.recordId !== undefined) throw fail('MODULE_CLAIM_INVALID', 400);
    } else {
        if (typeof claim.recordId !== 'string' || !UUID_REGEX.test(claim.recordId)) throw fail('MODULE_CLAIM_INVALID', 400);
    }

    if (method === 'GET') {
        if (claim.bodyDigest !== null && claim.bodyDigest !== undefined) throw fail('MODULE_CLAIM_INVALID', 400);
    } else {
        if (typeof claim.bodyDigest !== 'string' || !/^[0-9a-f]{64}$/.test(claim.bodyDigest)) throw fail('MODULE_CLAIM_INVALID', 400);
    }

    return DB.db.transaction(() => {
        const adapter = peer(peerAuth.adapterId, peerAuth.peerSecret);
        const deployment = expectedDeployment(adapter);
        if (adapter.module !== 'twenty' || adapter.businessId !== claim.businessId || adapter.nativeScope !== claim.nativeScope) {
            throw fail('MODULE_SCOPE_MISMATCH', 403);
        }
        if (deployment.deploymentId !== claim.deploymentId) throw fail('MODULE_DEPLOYMENT_CHANGED', 403);
        if (deployment.revision !== claim.revision) throw fail('MODULE_CONFIGURATION_CHANGED', 403);

        const instance = DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [claim.businessId]);
        if (!instance) throw fail('MODULE_BUSINESS_INACTIVE', 403);

        const link = DB.get('SELECT * FROM twenty_workspace_links WHERE businessId=? AND enabled=1', [claim.businessId]);
        if (!link || link.workspaceId !== claim.nativeScope || Number(link.revision) !== Number(adapter.integrationRevision)) {
            throw fail('MODULE_CONFIGURATION_CHANGED', 403);
        }

        if (DB.get(`SELECT r.recoveryId FROM ava_sync_lease_recoveries r
            JOIN ava_sync_leases l ON l.leaseId=r.leaseId
            WHERE l.correlationId=? AND l.businessId=? AND r.state='readback_required'`,
        [claim.correlationId, claim.businessId])) throw fail('MODULE_SYNC_RECOVERY_READBACK_REQUIRED', 409);

        const outbox = DB.get('SELECT * FROM twenty_sync_outbox WHERE (eventId=? OR eventId=? OR eventId=?) AND businessId=?',
            [claim.correlationId, 'twout_' + claim.correlationId, claim.correlationId.replace(/^twout_/, ''), claim.businessId]);
        if (!outbox) throw fail('MODULE_SYNC_LEASE_DENIED', 403);
        if (outbox.status !== 'LEASED' || !outbox.leaseToken) throw fail('MODULE_SYNC_LEASE_FENCED', 403);
        const leasedUntilMs = typeof outbox.leasedUntil === 'number' ? outbox.leasedUntil : Date.parse(outbox.leasedUntil);
        if (!Number.isFinite(leasedUntilMs) || leasedUntilMs <= Date.now()) throw fail('MODULE_SYNC_LEASE_EXPIRED', 403);
        const binding = DB.get('SELECT * FROM ava_sync_mutations WHERE correlationId=? AND businessId=?',
            [claim.correlationId, claim.businessId]);
        if (!binding || binding.adapterId !== adapter.id || binding.deploymentId !== claim.deploymentId
            || binding.nativeScope !== claim.nativeScope || binding.revision !== claim.revision
            || binding.integrationRevision !== link.revision || binding.outboxLeaseHash !== digest(outbox.leaseToken)
            || ['method','path','objectName','recordId','bodyDigest'].some(key => binding[key] !== (claim[key] ?? null))) {
            throw fail('MODULE_SYNC_LEASE_DENIED', 403);
        }

        const expected = SYNC_DEFAULT_ENTITIES[outbox.entityType];
        if (!expected || expected.objectName !== claim.objectName || expected.sourceTable !== outbox.sourceTable
            || outbox.operation !== 'upsert' || claim.path !== exactSyncPath(method, claim.objectName, claim.recordId)) {
            throw fail('MODULE_SYNC_LEASE_DENIED', 403);
        }

        if (claim.recordId) {
            const conflict = DB.get(`SELECT r.businessId,r.sourceTable,r.sourceId FROM twenty_record_links r
                JOIN twenty_workspace_links w ON w.businessId=r.businessId
                WHERE w.workspaceId=? AND r.twentyObject=? AND r.twentyRecordId=? LIMIT 1`,
            [claim.nativeScope, claim.objectName, claim.recordId]);
            if (conflict && (conflict.businessId !== claim.businessId || conflict.sourceTable !== outbox.sourceTable
                || String(conflict.sourceId) !== String(outbox.sourceId))) {
                throw fail('MODULE_SCOPE_MISMATCH', 403);
            }
        }

        const activeLease = DB.get("SELECT * FROM ava_sync_leases WHERE correlationId=? AND status='active'", [claim.correlationId]);
        if (activeLease) throw fail('MODULE_SYNC_LEASE_CONCURRENT', 409);

        const leaseId = crypto.randomUUID();
        const now = Date.now();
        const expiresAt = Math.min(now + 30000, leasedUntilMs);
        if (expiresAt <= now + 5000) throw fail('MODULE_SYNC_LEASE_EXPIRED', 403);

        DB.run(`INSERT INTO ava_sync_leases(
            leaseId, adapterId, peerSecretHash, deploymentId, businessId, nativeScope, revision,
            nativeKeyId, generation, roleId, correlationId, method,
            path, objectName, recordId, bodyDigest, status, createdAt, expiresAt
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`, [
            leaseId, adapter.id, adapter.peerSecretHash, claim.deploymentId, claim.businessId, claim.nativeScope, claim.revision,
            claim.nativeKeyId, claim.generation, claim.roleId, claim.correlationId, method,
            claim.path, claim.objectName, claim.recordId || null, claim.bodyDigest || null, now, expiresAt
        ]);

        return {
            authorized: true,
            contractVersion: SYNC_CONTRACT,
            leaseId,
            expiresAt,
            deploymentId: claim.deploymentId,
            businessId: claim.businessId,
            nativeScope: claim.nativeScope,
            revision: claim.revision,
            nativeKeyId: claim.nativeKeyId,
            generation: claim.generation,
            roleId: claim.roleId,
            correlationId: claim.correlationId,
            method: claim.method,
            path: claim.path,
            objectName: claim.objectName,
            recordId: claim.recordId || null,
            bodyDigest: claim.bodyDigest || null
        };
    }).immediate();
}

function releaseSyncLease(input, peerAuth) {
    schema();
    if (!peerAuth?.adapterId || !peerAuth?.peerSecret || !UUID_REGEX.test(peerAuth.adapterId)
        || !tokenPattern.test(peerAuth.peerSecret)) throw fail('MODULE_PEER_DENIED', 403);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('MODULE_BODY_INVALID', 400);
    if (input.contractVersion !== SYNC_CONTRACT) throw fail('MODULE_CONTRACT_INVALID', 400);
    if (typeof input.leaseId !== 'string' || !UUID_REGEX.test(input.leaseId)) throw fail('MODULE_LEASE_INVALID', 400);
    if (!['completed', 'failed', 'denied', 'fenced', 'abandoned'].includes(input.outcome)) throw fail('MODULE_OUTCOME_INVALID', 400);

    return DB.db.transaction(() => {
        const lease = DB.get('SELECT * FROM ava_sync_leases WHERE leaseId=?', [input.leaseId]);
        if (!lease) {
            // Only a currently valid peer receives the idempotent not-found
            // response; arbitrary credentials learn nothing about lease IDs.
            peer(peerAuth.adapterId, peerAuth.peerSecret);
            return { released: false, error_code: 'MODULE_LEASE_NOT_FOUND' };
        }
        if (lease.adapterId !== peerAuth.adapterId
            || typeof lease.peerSecretHash !== 'string' || !/^[0-9a-f]{64}$/.test(lease.peerSecretHash)
            || !crypto.timingSafeEqual(Buffer.from(digest(peerAuth.peerSecret), 'hex'), Buffer.from(lease.peerSecretHash, 'hex'))) {
            throw fail('MODULE_PEER_DENIED', 403);
        }
        if (lease.status !== 'active') return { released: false, outcome: lease.status };

        if (input.outcome === 'abandoned') {
            // A disconnected HTTP client does not cancel a Twenty handler or
            // its PostgreSQL transaction. Record the diagnostic and fail the
            // outbox row, but retain the active barrier until a privileged
            // supervisor proves the exact native process and its database
            // transaction can no longer write.
            DB.run("UPDATE ava_sync_leases SET outcome='abandoned_pending_death' WHERE leaseId=? AND status='active'",
                [input.leaseId]);
            DB.run(`UPDATE twenty_sync_outbox SET status='FAILED', lastErrorCode='TWENTY_SYNC_ABANDONED', updatedAt=CURRENT_TIMESTAMP
                WHERE (eventId=? OR eventId=?) AND businessId=? AND status='LEASED'`,
                [lease.correlationId, 'twout_' + lease.correlationId, lease.businessId]);
            return { released: false, leaseId: input.leaseId, outcome: input.outcome, barrierActive: true };
        }

        DB.run('UPDATE ava_sync_leases SET status=?, releasedAt=?, outcome=? WHERE leaseId=?',
            [input.outcome, Date.now(), input.outcome, input.leaseId]);

        if (input.outcome === 'fenced') {
            DB.run(`UPDATE twenty_sync_outbox SET status='FAILED', lastErrorCode=?, updatedAt=CURRENT_TIMESTAMP
                WHERE (eventId=? OR eventId=?) AND businessId=? AND status='LEASED'`,
                ['TWENTY_SYNC_' + input.outcome.toUpperCase(), lease.correlationId, 'twout_' + lease.correlationId, lease.businessId]);
        }

        return { released: true, leaseId: input.leaseId, outcome: input.outcome };
    }).immediate();
}

function getSyncLease(leaseId) {
    schema();
    if (typeof leaseId !== 'string' || !UUID_REGEX.test(leaseId)) return null;
    return DB.get('SELECT * FROM ava_sync_leases WHERE leaseId=?', [leaseId]) || null;
}

// Returns the server-owned request binding for an active sync lease, scoped to
// the exact current adapter incarnation. No outbox/peer lease credentials are
// returned.
function getSyncReadback(leaseId, peerAuth) {
    schema();
    if (typeof leaseId !== 'string' || !UUID_REGEX.test(leaseId)) throw fail('MODULE_LEASE_INVALID', 400);
    return DB.db.transaction(() => {
        // Peer auth enforces adapter scope — the same pattern as acquireSyncLease.
        const adapterId = peerAuth?.adapterId;
        const peerSecret = peerAuth?.peerSecret;
        if (!adapterId || !peerSecret) throw fail('MODULE_PEER_DENIED', 403);
        const adapter = peer(adapterId, peerSecret);
        const lease = DB.get("SELECT * FROM ava_sync_leases WHERE leaseId=? AND status='active' AND expiresAt>?",
            [leaseId, Date.now()]);
        if (!lease) throw fail('MODULE_SYNC_READBACK_LEASE_NOT_ACTIVE', 403);
        const deployment = expectedDeployment(adapter);
        if (adapter.module !== 'twenty' || lease.adapterId !== adapter.id || lease.businessId !== adapter.businessId
            || lease.deploymentId !== deployment.deploymentId || lease.nativeScope !== adapter.nativeScope
            || lease.revision !== deployment.revision) throw fail('MODULE_SCOPE_MISMATCH', 403);
        const outbox = DB.get('SELECT * FROM twenty_sync_outbox WHERE (eventId=? OR eventId=?) AND businessId=?',
            [lease.correlationId, 'twout_' + lease.correlationId, lease.businessId]);
        if (!outbox) throw fail('MODULE_SYNC_READBACK_OUTBOX_MISSING', 403);
        const binding = DB.get('SELECT * FROM ava_sync_mutations WHERE correlationId=? AND businessId=? AND adapterId=?',
            [lease.correlationId, lease.businessId, adapter.id]);
        if (!binding || binding.bodyDigest !== lease.bodyDigest || binding.method !== lease.method
            || binding.path !== lease.path || binding.objectName !== lease.objectName
            || binding.recordId !== lease.recordId || binding.outboxLeaseHash !== digest(outbox.leaseToken || '')) {
            throw fail('MODULE_SYNC_READBACK_BINDING_CHANGED', 403);
        }
        return {
            contractVersion: SYNC_CONTRACT,
            leaseId: lease.leaseId,
            correlationId: lease.correlationId,
            businessId: lease.businessId,
            objectName: lease.objectName,
            method: lease.method,
            path: lease.path,
            recordId: lease.recordId || null,
            entityType: outbox.entityType,
            sourceTable: outbox.sourceTable,
            sourceId: outbox.sourceId,
            operation: outbox.operation,
            bodyDigest: lease.bodyDigest || null,
            body: binding.bodyJson ? JSON.parse(binding.bodyJson) : null,
        };
    }).immediate();
}

const RECOVERY_REQUEST_KEYS = ['contractVersion','recoveryId','recoveryToken','leaseId','deploymentId','businessId',
    'leaseRevision','deploymentRevision','adapterRevision','integrationRevision','correlationId','outboxEventId'];
const RECOVERY_PROOF_KEYS = ['contractVersion','recoveryId','leaseId','deploymentId','businessId','leaseRevision',
    'deploymentRevision','adapterRevision','integrationRevision','correlationId','outboxEventId','namespace','sourceCommit',
    'project','stopObservedAt','ownedContainerIds','stoppedContainerIds','containers','database','native','completedAt'];
const RECOVERY_CONTAINER_KEYS = ['service','containerId','beforeRunning','beforeRestarting','beforePid','beforeStartedAt',
    'stoppedRunning','stoppedRestarting','stoppedPid','afterRunning','afterRestarting','afterPid','afterStartedAt','health'];

function exactRecoveryOutbox(lease) {
    const ids = [...new Set([lease.correlationId, `twout_${lease.correlationId}`,
        String(lease.correlationId).replace(/^twout_/, '')])];
    const placeholders = ids.map(() => '?').join(',');
    const rows = DB.all(`SELECT * FROM twenty_sync_outbox WHERE businessId=? AND eventId IN (${placeholders})`,
        [lease.businessId, ...ids]);
    if (rows.length !== 1) throw fail('MODULE_SYNC_RECOVERY_OUTBOX_MISMATCH', 409);
    return rows[0];
}

// Resolve every mutable registry row while holding the SQLite write lock. The
// helper repeats this join read-only before it touches Docker; neither side
// trusts paths, service names, process IDs, or project names from the request.
function recoverySnapshot(lease) {
    if (!DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [lease.businessId])) {
        throw fail('MODULE_SYNC_RECOVERY_BUSINESS_INACTIVE', 409);
    }
    const adapter = DB.get('SELECT * FROM ava_module_adapters WHERE id=? AND businessId=? AND module=\'twenty\'',
        [lease.adapterId, lease.businessId]);
    if (!adapter || adapter.deploymentId !== lease.deploymentId || adapter.deploymentRevision !== lease.revision
        || adapter.nativeScope !== lease.nativeScope) throw fail('MODULE_SYNC_RECOVERY_SCOPE_CHANGED', 409);
    const deployment = DB.get('SELECT * FROM ava_module_deployments WHERE id=? AND businessId=? AND module=\'twenty\'',
        [lease.deploymentId, lease.businessId]);
    if (!deployment || deployment.revision !== lease.revision || deployment.state !== 'verified') {
        throw fail('MODULE_SYNC_RECOVERY_DEPLOYMENT_NOT_VERIFIED', 409);
    }
    if (adapter.publicOrigin !== `https://${deployment.hostname}`
        || deployment.namespace !== `ava_${deployment.id.replaceAll('-', '')}`
        || typeof deployment.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(deployment.sourceCommit)) {
        throw fail('MODULE_SYNC_RECOVERY_SCOPE_CHANGED', 409);
    }
    const link = DB.get('SELECT * FROM twenty_workspace_links WHERE id=? AND businessId=?',
        [adapter.integrationId, lease.businessId]);
    if (!link || !link.enabled || link.workspaceId !== lease.nativeScope || link.revision !== adapter.integrationRevision) {
        throw fail('MODULE_SYNC_RECOVERY_SCOPE_CHANGED', 409);
    }
    const binding = DB.get('SELECT * FROM ava_sync_mutations WHERE correlationId=? AND businessId=? AND adapterId=?',
        [lease.correlationId, lease.businessId, adapter.id]);
    if (!binding || binding.deploymentId !== lease.deploymentId || binding.nativeScope !== lease.nativeScope
        || binding.revision !== lease.revision || binding.integrationRevision !== link.revision
        || binding.method !== lease.method || binding.path !== lease.path || binding.objectName !== lease.objectName
        || binding.recordId !== lease.recordId || binding.bodyDigest !== lease.bodyDigest
        || !SHA256_REGEX.test(binding.outboxLeaseHash || '')) {
        throw fail('MODULE_SYNC_RECOVERY_BINDING_CHANGED', 409);
    }
    const outbox = exactRecoveryOutbox(lease);
    const mapping = SYNC_DEFAULT_ENTITIES[outbox.entityType];
    if (!mapping || mapping.objectName !== lease.objectName || mapping.sourceTable !== outbox.sourceTable
        || outbox.operation !== 'upsert') throw fail('MODULE_SYNC_RECOVERY_OUTBOX_MISMATCH', 409);
    return { adapter, deployment, link, binding, outbox };
}

function recoveryEligible(lease, now = Date.now()) {
    return lease.status === 'active' && (lease.expiresAt <= now
        || ['abandoned_pending_death','disable_pending'].includes(lease.outcome));
}

function persistBlockedRecovery(lease, code, now = Date.now()) {
    const adapter = DB.get('SELECT * FROM ava_module_adapters WHERE id=?', [lease.adapterId]) || {};
    const deployment = DB.get('SELECT * FROM ava_module_deployments WHERE id=?', [lease.deploymentId]) || {};
    const binding = DB.get('SELECT * FROM ava_sync_mutations WHERE correlationId=?', [lease.correlationId]) || {};
    const ids = [...new Set([lease.correlationId, `twout_${lease.correlationId}`,
        String(lease.correlationId).replace(/^twout_/, '')])];
    const outbox = DB.get(`SELECT * FROM twenty_sync_outbox WHERE businessId=? AND eventId IN (${ids.map(() => '?').join(',')})`,
        [lease.businessId, ...ids]) || {};
    DB.run(`INSERT OR IGNORE INTO ava_sync_lease_recoveries(
        recoveryId,leaseId,deploymentId,businessId,leaseRevision,deploymentRevision,adapterRevision,
        integrationRevision,correlationId,outboxEventId,outboxEntityType,outboxSourceTable,outboxSourceId,
        outboxOperation,outboxLeaseHash,state,lastErrorCode,createdAt,updatedAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'blocked',?,?,?)`, [
        crypto.randomUUID(), lease.leaseId, lease.deploymentId, lease.businessId, lease.revision,
        Number.isSafeInteger(deployment.revision) ? deployment.revision : 0,
        Number.isSafeInteger(adapter.revision) ? adapter.revision : 0,
        Number.isSafeInteger(binding.integrationRevision) ? binding.integrationRevision : 0,
        lease.correlationId, String(outbox.eventId || lease.correlationId), String(outbox.entityType || ''),
        String(outbox.sourceTable || ''), String(outbox.sourceId || ''), String(outbox.operation || ''),
        SHA256_REGEX.test(binding.outboxLeaseHash || '') ? binding.outboxLeaseHash : '0'.repeat(64),
        code, now, now,
    ]);
}

function recoveryRowMatches(row, lease, snapshot) {
    const { adapter, deployment, link, binding, outbox } = snapshot;
    return row.leaseId === lease.leaseId && row.deploymentId === lease.deploymentId
        && row.businessId === lease.businessId && row.leaseRevision === lease.revision
        && row.deploymentRevision === deployment.revision && row.adapterRevision === adapter.revision
        && row.integrationRevision === link.revision && row.correlationId === lease.correlationId
        && row.outboxEventId === outbox.eventId && row.outboxEntityType === outbox.entityType
        && row.outboxSourceTable === outbox.sourceTable && row.outboxSourceId === String(outbox.sourceId)
        && row.outboxOperation === outbox.operation && row.outboxLeaseHash === binding.outboxLeaseHash;
}

function recoveryRequest(row, recoveryToken) {
    return {
        contractVersion: SYNC_RECOVERY_CONTRACT,
        recoveryId: row.recoveryId,
        recoveryToken,
        leaseId: row.leaseId,
        deploymentId: row.deploymentId,
        businessId: row.businessId,
        leaseRevision: row.leaseRevision,
        deploymentRevision: row.deploymentRevision,
        adapterRevision: row.adapterRevision,
        integrationRevision: row.integrationRevision,
        correlationId: row.correlationId,
        outboxEventId: row.outboxEventId,
    };
}

function validateRecoveryRequest(input) {
    if (!exactObject(input, RECOVERY_REQUEST_KEYS) || input.contractVersion !== SYNC_RECOVERY_CONTRACT
        || !UUID_REGEX.test(input.recoveryId || '') || !UUID_REGEX.test(input.recoveryToken || '')
        || !UUID_REGEX.test(input.leaseId || '') || !UUID_REGEX.test(input.deploymentId || '')
        || !Number.isSafeInteger(input.businessId) || input.businessId < 1
        || ['leaseRevision','deploymentRevision','adapterRevision','integrationRevision']
            .some(key => !Number.isSafeInteger(input[key]) || input[key] < 1)
        || typeof input.correlationId !== 'string' || typeof input.outboxEventId !== 'string') {
        throw fail('MODULE_SYNC_RECOVERY_CLAIM_INVALID', 400);
    }
}

function assertRecoveryClaim(input) {
    validateRecoveryRequest(input);
    const row = DB.get("SELECT * FROM ava_sync_lease_recoveries WHERE recoveryId=? AND state='leased' AND leasedUntil>?",
        [input.recoveryId, Date.now()]);
    if (!row || !SHA256_REGEX.test(row.tokenHash || '')
        || !crypto.timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), Buffer.from(digest(input.recoveryToken), 'hex'))
        || RECOVERY_REQUEST_KEYS.filter(key => !['contractVersion','recoveryToken'].includes(key))
            .some(key => row[key] !== input[key])) throw fail('MODULE_SYNC_RECOVERY_CLAIM_LOST', 409);
    return row;
}

// The claim is available only to the provisioning worker. Expiry recovers a
// lost helper response by minting a new token for the same recoveryId; it never
// changes the active sync-lease barrier.
function leaseSyncRecovery() {
    workerOnly(); schema();
    return DB.db.transaction(() => {
        const now = Date.now();
        DB.run(`UPDATE ava_sync_lease_recoveries SET state=CASE WHEN attempts>=8 THEN 'blocked' ELSE 'pending' END,
            tokenHash=NULL,leasedUntil=NULL,nextAttemptAt=CASE WHEN attempts>=8 THEN NULL ELSE ? END,
            lastErrorCode=CASE WHEN attempts>=8 THEN 'MODULE_SYNC_RECOVERY_ATTEMPTS_EXHAUSTED'
                ELSE 'MODULE_SYNC_RECOVERY_RESPONSE_LOST' END,updatedAt=?
            WHERE state='leased' AND leasedUntil<=?`, [now, now, now]);

        // Persist invalid old leases as blocked and continue scanning, so one
        // corrupt or superseded deployment cannot starve another tenant's
        // valid recovery job.
        const candidates = DB.all(`SELECT l.* FROM ava_sync_leases l
            LEFT JOIN ava_sync_lease_recoveries r ON r.leaseId=l.leaseId
            WHERE r.recoveryId IS NULL AND l.status='active'
            AND (l.expiresAt<=? OR l.outcome IN ('abandoned_pending_death','disable_pending'))
            ORDER BY l.createdAt,l.leaseId LIMIT 32`, [now]);
        for (const lease of candidates) {
            let snapshot;
            try { snapshot = recoverySnapshot(lease); }
            catch (error) {
                persistBlockedRecovery(lease, /^MODULE_SYNC_RECOVERY_[A-Z_]+$/.test(error.code || '')
                    ? error.code : 'MODULE_SYNC_RECOVERY_SCOPE_CHANGED', now);
                continue;
            }
            const recoveryId = crypto.randomUUID(), blocked = !snapshot.adapter.enabled;
            DB.run(`INSERT INTO ava_sync_lease_recoveries(
                recoveryId,leaseId,deploymentId,businessId,leaseRevision,deploymentRevision,adapterRevision,
                integrationRevision,correlationId,outboxEventId,outboxEntityType,outboxSourceTable,outboxSourceId,
                outboxOperation,outboxLeaseHash,state,lastErrorCode,createdAt,updatedAt,nextAttemptAt
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
                recoveryId, lease.leaseId, lease.deploymentId, lease.businessId, lease.revision,
                snapshot.deployment.revision, snapshot.adapter.revision, snapshot.link.revision,
                lease.correlationId, snapshot.outbox.eventId, snapshot.outbox.entityType, snapshot.outbox.sourceTable,
                String(snapshot.outbox.sourceId), snapshot.outbox.operation, snapshot.binding.outboxLeaseHash,
                blocked ? 'blocked' : 'pending', blocked ? 'MODULE_SYNC_RECOVERY_ADAPTER_DISABLED' : null,
                now, now, blocked ? null : now,
            ]);
        }
        DB.run(`UPDATE ava_sync_lease_recoveries SET state='blocked',nextAttemptAt=NULL,
            lastErrorCode='MODULE_SYNC_RECOVERY_ATTEMPTS_EXHAUSTED',updatedAt=?
            WHERE state='pending' AND attempts>=8`, [now]);

        for (const row of DB.all(`SELECT * FROM ava_sync_lease_recoveries
            WHERE state='pending' AND attempts<8 AND COALESCE(nextAttemptAt,0)<=?
            ORDER BY createdAt,recoveryId`, [now])) {
            const lease = DB.get("SELECT * FROM ava_sync_leases WHERE leaseId=? AND status='active'", [row.leaseId]);
            if (!lease || !recoveryEligible(lease, now)) {
                DB.run(`UPDATE ava_sync_lease_recoveries SET state='blocked',nextAttemptAt=NULL,lastErrorCode=?,updatedAt=?
                    WHERE recoveryId=?`, ['MODULE_SYNC_RECOVERY_LEASE_CHANGED', now, row.recoveryId]);
                continue;
            }
            let snapshot;
            try { snapshot = recoverySnapshot(lease); }
            catch (error) {
                DB.run(`UPDATE ava_sync_lease_recoveries SET state='blocked',nextAttemptAt=NULL,lastErrorCode=?,updatedAt=?
                    WHERE recoveryId=?`, [/^MODULE_SYNC_RECOVERY_[A-Z_]+$/.test(error.code || '')
                    ? error.code : 'MODULE_SYNC_RECOVERY_SCOPE_CHANGED', now, row.recoveryId]);
                continue;
            }
            if (!snapshot.adapter.enabled || !recoveryRowMatches(row, lease, snapshot)) {
                DB.run(`UPDATE ava_sync_lease_recoveries SET state='blocked',tokenHash=NULL,leasedUntil=NULL,
                    nextAttemptAt=NULL,lastErrorCode=?,updatedAt=? WHERE recoveryId=?`,
                [!snapshot.adapter.enabled ? 'MODULE_SYNC_RECOVERY_ADAPTER_DISABLED' : 'MODULE_SYNC_RECOVERY_SCOPE_CHANGED', now, row.recoveryId]);
                continue;
            }
            // Revoke any outbox retry lease before the privileged helper begins
            // a whole-project stop. The immutable original hash remains bound.
            const outboxFence = DB.run(`UPDATE twenty_sync_outbox SET status='FAILED',leaseToken=NULL,leasedUntil=NULL,
                lastErrorCode='TWENTY_SYNC_RECOVERY_IN_PROGRESS',updatedAt=CURRENT_TIMESTAMP
                WHERE eventId=? AND businessId=? AND entityType=? AND sourceTable=? AND sourceId=? AND operation=?`,
            [row.outboxEventId, row.businessId, row.outboxEntityType, row.outboxSourceTable, row.outboxSourceId, row.outboxOperation]);
            if (outboxFence.changes !== 1) {
                DB.run(`UPDATE ava_sync_lease_recoveries SET state='blocked',nextAttemptAt=NULL,
                    lastErrorCode='MODULE_SYNC_RECOVERY_OUTBOX_MISMATCH',updatedAt=? WHERE recoveryId=?`, [now, row.recoveryId]);
                continue;
            }
            const recoveryToken = crypto.randomUUID();
            const update = DB.run(`UPDATE ava_sync_lease_recoveries SET state='leased',tokenHash=?,leasedUntil=?,
                attempts=attempts+1,nextAttemptAt=NULL,lastErrorCode=NULL,updatedAt=? WHERE recoveryId=? AND state='pending'`,
            [digest(recoveryToken), now + SYNC_RECOVERY_CLAIM_MS, now, row.recoveryId]);
            if (update.changes !== 1) continue;
            return recoveryRequest(DB.get('SELECT * FROM ava_sync_lease_recoveries WHERE recoveryId=?', [row.recoveryId]), recoveryToken);
        }
        return null;
    }).immediate();
}

function validateRecoveryProof(proof, claim, deployment) {
    if (!exactObject(proof, RECOVERY_PROOF_KEYS) || proof.contractVersion !== SYNC_RECOVERY_CONTRACT
        || RECOVERY_REQUEST_KEYS.filter(key => !['contractVersion','recoveryToken'].includes(key))
            .some(key => proof[key] !== claim[key])
        || proof.namespace !== deployment.namespace || proof.sourceCommit !== deployment.sourceCommit
        || proof.project !== deployment.namespace || !Number.isSafeInteger(proof.stopObservedAt)
        || !Number.isSafeInteger(proof.completedAt) || proof.completedAt < proof.stopObservedAt
        || !Array.isArray(proof.ownedContainerIds) || !Array.isArray(proof.stoppedContainerIds)
        || !Array.isArray(proof.containers) || proof.containers.length < 2) {
        throw fail('MODULE_SYNC_RECOVERY_PROOF_INVALID', 409);
    }
    const idsValid = ids => ids.length === new Set(ids).size && ids.every(id => /^[a-f0-9]{64}$/.test(id));
    if (!idsValid(proof.ownedContainerIds) || !idsValid(proof.stoppedContainerIds)
        || JSON.stringify(proof.ownedContainerIds) !== JSON.stringify([...proof.ownedContainerIds].sort())
        || JSON.stringify(proof.ownedContainerIds) !== JSON.stringify(proof.stoppedContainerIds)) {
        throw fail('MODULE_SYNC_RECOVERY_PROOF_INVALID', 409);
    }
    const services = new Map();
    for (const item of proof.containers) {
        if (!exactObject(item, RECOVERY_CONTAINER_KEYS) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.service || '')
            || !proof.ownedContainerIds.includes(item.containerId) || services.has(item.service)
            || typeof item.beforeRunning !== 'boolean' || typeof item.beforeRestarting !== 'boolean'
            || !Number.isSafeInteger(item.beforePid) || item.beforePid < 0
            || (item.beforeStartedAt !== null && !Number.isSafeInteger(item.beforeStartedAt))
            || (item.beforeRunning && (item.beforePid < 1 || !Number.isSafeInteger(item.beforeStartedAt)))
            || (!item.beforeRunning && item.beforePid !== 0)
            || item.stoppedRunning !== false || item.stoppedRestarting !== false || item.stoppedPid !== 0
            || typeof item.afterRunning !== 'boolean' || typeof item.afterRestarting !== 'boolean'
            || !Number.isSafeInteger(item.afterPid) || !Number.isSafeInteger(item.afterStartedAt)
            || !['healthy','running','exited'].includes(item.health)) throw fail('MODULE_SYNC_RECOVERY_PROOF_INVALID', 409);
        if (item.health !== 'exited') {
            if (!item.afterRunning || item.afterRestarting || item.afterPid < 1 || item.afterStartedAt <= proof.stopObservedAt
                || !['healthy','running'].includes(item.health)) {
                throw fail('MODULE_SYNC_RECOVERY_PROOF_INVALID', 409);
            }
        } else if (item.afterRunning || item.afterRestarting || item.afterPid !== 0
            || item.afterStartedAt <= proof.stopObservedAt) {
            throw fail('MODULE_SYNC_RECOVERY_PROOF_INVALID', 409);
        }
        services.set(item.service, item);
    }
    if (services.size !== proof.containers.length
        || JSON.stringify([...services.values()].map(item => item.containerId).sort()) !== JSON.stringify(proof.ownedContainerIds)) {
        throw fail('MODULE_SYNC_RECOVERY_PROOF_INVALID', 409);
    }
    const database = services.get('database'), native = services.get('native');
    if (!database || !native || database.health !== 'healthy' || native.health !== 'healthy'
        || !exactObject(proof.database, ['containerId','postmasterStartedAt','recoveryCompletedAt','readyAt'])
        || proof.database.containerId !== database.containerId
        || ![proof.database.postmasterStartedAt, proof.database.recoveryCompletedAt, proof.database.readyAt]
            .every(Number.isSafeInteger)
        || proof.database.postmasterStartedAt < database.afterStartedAt
        || proof.database.recoveryCompletedAt < proof.database.postmasterStartedAt
        || proof.database.readyAt < proof.database.recoveryCompletedAt
        || proof.database.readyAt > proof.completedAt
        || !exactObject(proof.native, ['containerId','readyAt']) || proof.native.containerId !== native.containerId
        || !Number.isSafeInteger(proof.native.readyAt) || proof.native.readyAt < native.afterStartedAt
        || proof.native.readyAt > proof.completedAt) throw fail('MODULE_SYNC_RECOVERY_PROOF_INVALID', 409);
}

// Only a direct response from the root-owned Unix helper reaches this method.
// The helper constructs the observations itself after independently checking
// the hashed token in SQLite; there is deliberately no broker or HTTP route
// that accepts a caller-supplied death boolean or proof body.
function acceptSyncRecoveryProof(claim, proof) {
    workerOnly(); schema(); validateRecoveryRequest(claim);
    return DB.db.transaction(() => {
        const row = assertRecoveryClaim(claim);
        const lease = DB.get("SELECT * FROM ava_sync_leases WHERE leaseId=? AND status='active'", [row.leaseId]);
        if (!lease || !recoveryEligible(lease)) throw fail('MODULE_SYNC_RECOVERY_LEASE_CHANGED', 409);
        const snapshot = recoverySnapshot(lease);
        if (!snapshot.adapter.enabled || !recoveryRowMatches(row, lease, snapshot)) {
            throw fail('MODULE_SYNC_RECOVERY_SCOPE_CHANGED', 409);
        }
        validateRecoveryProof(proof, claim, snapshot.deployment);
        const canonicalProof = canonicalSyncBody(proof);
        const now = Date.now();
        const fenced = DB.run(`UPDATE ava_sync_leases SET status='fenced',releasedAt=?,outcome='process_death_proven'
            WHERE leaseId=? AND status='active'`, [now, lease.leaseId]);
        if (fenced.changes !== 1) throw fail('MODULE_SYNC_RECOVERY_LEASE_CHANGED', 409);
        const outboxUpdate = DB.run(`UPDATE twenty_sync_outbox SET status='FAILED',leaseToken=NULL,leasedUntil=NULL,
            lastErrorCode='TWENTY_SYNC_RECOVERY_READBACK_REQUIRED',updatedAt=CURRENT_TIMESTAMP
            WHERE eventId=? AND businessId=? AND entityType=? AND sourceTable=? AND sourceId=? AND operation=?`,
        [row.outboxEventId, row.businessId, row.outboxEntityType, row.outboxSourceTable, row.outboxSourceId, row.outboxOperation]);
        if (outboxUpdate.changes !== 1) throw fail('MODULE_SYNC_RECOVERY_OUTBOX_MISMATCH', 409);
        DB.run(`UPDATE ava_sync_lease_recoveries SET state='readback_required',tokenHash=NULL,leasedUntil=NULL,
            proofJson=?,proofDigest=?,lastErrorCode='MODULE_SYNC_RECOVERY_READBACK_REQUIRED',provenAt=?,updatedAt=?
            WHERE recoveryId=? AND state='leased'`, [canonicalProof, digest(canonicalProof), now, now, row.recoveryId]);
        return { recovered: true, recoveryId: row.recoveryId, leaseId: row.leaseId,
            state: 'readback_required', retryAllowed: false };
    }).immediate();
}

function finishSyncRecoveryAttempt(claim, { code, retryable }) {
    workerOnly(); schema(); validateRecoveryRequest(claim);
    if (typeof code !== 'string' || !/^(?:MODULE_SYNC_RECOVERY|DEPLOYMENT_|SYNC_RECOVERY_)[A-Z0-9_]{2,80}$/.test(code)
        || typeof retryable !== 'boolean') throw fail('MODULE_SYNC_RECOVERY_RESULT_INVALID', 400);
    return DB.db.transaction(() => {
        const row = assertRecoveryClaim(claim), now = Date.now();
        const retry = retryable && row.attempts < 8;
        DB.run(`UPDATE ava_sync_lease_recoveries SET state=?,tokenHash=NULL,leasedUntil=NULL,nextAttemptAt=?,
            lastErrorCode=?,updatedAt=? WHERE recoveryId=? AND state='leased'`,
        [retry ? 'pending' : 'blocked', retry ? now + Math.min(300000, 5000 * (2 ** (row.attempts - 1))) : null,
            code, now, row.recoveryId]);
        return { recoveryId: row.recoveryId, state: retry ? 'pending' : 'blocked', barrierActive: true };
    }).immediate();
}

function getSyncRecovery(recoveryId) {
    workerOnly(); schema();
    if (!UUID_REGEX.test(recoveryId || '')) return null;
    const row = DB.get('SELECT * FROM ava_sync_lease_recoveries WHERE recoveryId=?', [recoveryId]);
    if (!row) return null;
    const { tokenHash, proofJson, ...safe } = row;
    return safe;
}

function createServiceAuthorization(peerAuth) {
    schema();
    if (!peerAuth?.adapterId || !peerAuth?.peerSecret) throw fail('MODULE_PEER_DENIED', 403);
    return {
        contractVersion: SYNC_CONTRACT,
        async acquire(claim) {
            return acquireSyncLease(claim, peerAuth);
        },
        async release(input) {
            return releaseSyncLease(input, peerAuth);
        },
        async readback(leaseId) {
            return getSyncReadback(leaseId, peerAuth);
        }
    };
}

module.exports = { configure, prepareDeployment, activateDeployment, disable, verifyPrincipal, issue, redeem, authorize, logout, logoutAll, list, navigation,
    collectRevocations, revokeBusinessAccess, leaseRevocation, finishRevocation, prepareSyncMutation, acquireSyncLease, releaseSyncLease, getSyncLease, getSyncReadback,
    leaseSyncRecovery, acceptSyncRecoveryProof, finishSyncRecoveryAttempt, getSyncRecovery,
    canonicalSyncBody, createServiceAuthorization, authenticatePeer, getCurrentAdapter };
