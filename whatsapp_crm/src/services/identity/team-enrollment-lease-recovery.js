'use strict';
const crypto = require('crypto');
const http = require('http');
const DB = require('../database.service');
const Admin = require('./keycloak-admin');
const fail = code => Object.assign(new Error(code), { code, statusCode: 409 });
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Fixed local socket and GET-only API. Config/Env can be present in Docker's
// response, so retain only checked stop evidence and never log raw responses.
function dockerGet(apiPath) {
    return new Promise((resolve, reject) => {
        const request = http.get({ socketPath: '/var/run/docker.sock', path: apiPath, timeout: 5000 }, response => {
            const chunks = []; let bytes = 0;
            response.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > 1024 * 1024) { response.destroy(); reject(fail('TEAM_LEASE_DOCKER_UNAVAILABLE')); }
                else chunks.push(chunk);
            });
            response.on('error', () => reject(fail('TEAM_LEASE_DOCKER_UNAVAILABLE')));
            response.on('end', () => {
                if (response.statusCode !== 200) return reject(fail('TEAM_LEASE_DOCKER_UNAVAILABLE'));
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch (_) { reject(fail('TEAM_LEASE_DOCKER_UNAVAILABLE')); }
            });
        });
        request.on('timeout', () => request.destroy());
        request.on('error', () => reject(fail('TEAM_LEASE_DOCKER_UNAVAILABLE')));
    });
}
class StoppedWorkerInspector {
    constructor({ get = dockerGet } = {}) { this.get = get; }
    checked(value, containerId, notBefore) {
        const state = value?.State, labels = value?.Config?.Labels;
        const finished = Date.parse(state?.FinishedAt), started = Date.parse(state?.StartedAt);
        const project = labels?.['com.docker.compose.project'];
        if (value?.Id !== containerId || labels?.['com.docker.compose.service'] !== 'provisioning_worker'
            || typeof project !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(project)
            || state?.Running !== false || state?.Restarting !== false || state?.Paused !== false
            || state?.Dead !== false || state?.Status !== 'exited'
            || !Number.isFinite(finished) || finished < notBefore || finished > Date.now()
            || !Number.isFinite(started) || started <= 0 || started > finished
            || !Number.isSafeInteger(value.RestartCount) || value.RestartCount < 0) throw fail('TEAM_LEASE_WORKER_NOT_STOPPED');
        return { containerId, project, finishedAt: state.FinishedAt, startedAt: state.StartedAt, restartCount: value.RestartCount };
    }
    async inspect({ containerId, notBefore }) {
        if (!hex64(containerId) || !Number.isSafeInteger(notBefore) || notBefore <= 0) throw fail('TEAM_LEASE_SCOPE_REQUIRED');
        const first = this.checked(await this.get(`/containers/${containerId}/json`), containerId, notBefore);
        // Legacy lease rows do not record their owning worker/container. Use
        // host-wide maintenance proof: a different compose project could mount
        // the same DB and must never be ignored as an unrelated replacement.
        const filters = encodeURIComponent(JSON.stringify({ label: ['com.docker.compose.service=provisioning_worker'] }));
        const workers = await this.get(`/containers/json?all=1&filters=${filters}`);
        if (!Array.isArray(workers) || workers.length !== 1 || workers[0]?.Id !== containerId
            || workers[0]?.State !== 'exited'
            || workers[0]?.Labels?.['com.docker.compose.project'] !== first.project
            || workers[0]?.Labels?.['com.docker.compose.service'] !== 'provisioning_worker') throw fail('TEAM_LEASE_WORKER_SET_CONFLICT');
        const last = this.checked(await this.get(`/containers/${containerId}/json`), containerId, notBefore);
        if (JSON.stringify(first) !== JSON.stringify(last)) throw fail('TEAM_LEASE_WORKER_CHANGED');
        return last;
    }
}
function localState(invitationId, leaseDigest) {
    const row = DB.get(`SELECT i.*,u.subject,u.email,u.enabled AS userEnabled,u.platformRole,b.isActive
        FROM ava_invitations i JOIN ava_users u ON u.id=i.userId
        JOIN instances b ON b.id=i.businessId WHERE i.id=?`, [invitationId]);
    const now = Date.now();
    if (!row || row.acceptanceMode !== 'team' || !['redeeming', 'revoked'].includes(row.state)
        || !['sales_lead', 'manager', 'observer'].includes(row.role) || row.isActive !== 1
        || row.userEnabled !== 0 || row.subject !== null || row.platformRole !== 'customer'
        || typeof row.email !== 'string' || !row.email || !/^[\w-]{43}$/.test(row.leaseToken || '')
        || !Number.isSafeInteger(row.leasedUntil) || row.leasedUntil <= 60000 || row.leasedUntil >= now
        || !crypto.timingSafeEqual(Buffer.from(digest(row.leaseToken), 'hex'), Buffer.from(leaseDigest, 'hex'))
        || DB.get('SELECT COUNT(*) n FROM ava_users WHERE lower(email)=lower(?)', [row.email]).n !== 1
        || DB.get('SELECT COUNT(*) n FROM ava_business_memberships WHERE userId=? AND enabled=1', [row.userId]).n !== 0
        || DB.get('SELECT COUNT(*) n FROM ava_sessions WHERE userId=? AND revokedAt IS NULL AND expiresAt>?', [row.userId, now]).n !== 0
        || DB.get("SELECT COUNT(*) n FROM ava_identity_outbox WHERE userId=? AND state!='done'", [row.userId]).n !== 0
        || DB.get("SELECT COUNT(*) n FROM ava_invitations WHERE userId=? AND (state='consumed' OR (id!=? AND leaseToken IS NOT NULL))", [row.userId, row.id]).n !== 0
        || DB.get('SELECT COUNT(*) n FROM ava_team_email_verifications v JOIN ava_invitations i ON i.id=v.invitationId WHERE i.userId=? AND v.completedAtMs IS NOT NULL', [row.userId]).n !== 0) throw fail('TEAM_LEASE_LOCAL_CONFLICT');
    const proofs = DB.all(`SELECT id,invitationTokenHash,email,createdAtMs,expiresAtMs,verifiedAtMs,completedAtMs
        FROM ava_team_email_verifications WHERE invitationId=? ORDER BY id`, [row.id]);
    return { row, proofs };
}
function matchesDisabled(user, target) {
    return typeof user?.id === 'string' && !!user.id && user.id.length <= 255
        && user.username === `ava-${target.userId}` && user.enabled === false
        && typeof user.email === 'string' && user.email.toLowerCase() === target.email.toLowerCase()
        && Array.isArray(user.attributes?.avaUserId) && user.attributes.avaUserId.length === 1
        && user.attributes.avaUserId[0] === target.userId;
}
async function recover({ invitationId, leaseDigest, workerContainerId, providerQuiescent = false, apply = false,
    admin = Admin, inspector = new StoppedWorkerInspector() } = {}) {
    if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') throw fail('IDENTITY_WORKER_REQUIRED');
    if (typeof invitationId !== 'string' || !/^[\w-]{1,128}$/.test(invitationId) || !hex64(leaseDigest)
        || !hex64(workerContainerId) || providerQuiescent !== true || typeof apply !== 'boolean') throw fail('TEAM_LEASE_SCOPE_REQUIRED');
    const snapshot = DB.db.transaction(() => localState(invitationId, leaseDigest))();
    const fingerprint = JSON.stringify(snapshot), target = snapshot.row;
    const assertLocal = () => {
        const current = DB.db.transaction(() => localState(invitationId, leaseDigest))();
        if (JSON.stringify(current) !== fingerprint) throw fail('TEAM_LEASE_LOCAL_CHANGED');
    };
    const stop = await inspector.inspect({ containerId: workerContainerId, notBefore: target.leasedUntil - 60000 });
    assertLocal();
    const get = async nativePath => {
        const value = await admin.call('GET', nativePath, undefined, false, assertLocal);
        assertLocal();
        return value;
    };
    const username = `ava-${target.userId}`;
    const users = await get(`/users?username=${encodeURIComponent(username)}&exact=true`);
    const emailMatches = await get(`/users?email=${encodeURIComponent(target.email)}&exact=true`);
    if (!Array.isArray(users) || !Array.isArray(emailMatches) || users.length > 1 || emailMatches.length > 1) throw fail('TEAM_LEASE_NATIVE_CONFLICT');
    let nativeAbsent = false;
    if (users.length === 0 && emailMatches.length === 0) nativeAbsent = true;
    else {
        const user = users[0];
        if (users.length !== 1 || emailMatches.length !== 1 || !matchesDisabled(user, target)
            || !matchesDisabled(emailMatches[0], target) || emailMatches[0].id !== user.id) throw fail('TEAM_LEASE_NATIVE_CONFLICT');
        const nativePath = `/users/${encodeURIComponent(user.id)}`;
        const current = await get(nativePath);
        if (!matchesDisabled(current, target) || current.id !== user.id) throw fail('TEAM_LEASE_NATIVE_CONFLICT');
        const sessions = await get(`${nativePath}/sessions`);
        if (!Array.isArray(sessions) || sessions.length !== 0) throw fail('TEAM_LEASE_NATIVE_CONFLICT');
    }
    // No provider awaits between this final independent worker inspection and
    // the local immediate transaction. Operator maintenance/quiescence remains
    // mandatory: Docker, Keycloak and SQLite do not share an atomic transaction.
    const stoppedAgain = await inspector.inspect({ containerId: workerContainerId, notBefore: target.leasedUntil - 60000 });
    if (JSON.stringify(stoppedAgain) !== JSON.stringify(stop)) throw fail('TEAM_LEASE_WORKER_CHANGED');
    const evidence = { workerStoppedVerified: true, workerFinishedAt: stop.finishedAt, workerStopDigest: digest(JSON.stringify(stop)) };
    const finish = DB.db.transaction(() => {
        assertLocal();
        if (!apply) return { status: 'recovery_required', changed: false, nativeState: nativeAbsent ? 'absent' : 'disabled_no_sessions', ...evidence };
        const updated = DB.run(`UPDATE ava_invitations SET state=CASE WHEN state='redeeming' THEN 'pending' ELSE state END,
            leaseToken=NULL,leasedUntil=NULL WHERE id=? AND leaseToken=? AND leasedUntil=? AND state=?`,
        [target.id, target.leaseToken, target.leasedUntil, target.state]);
        if (updated.changes !== 1) throw fail('TEAM_LEASE_LOCAL_CHANGED');
        const row = DB.get('SELECT state,leaseToken,leasedUntil FROM ava_invitations WHERE id=?', [target.id]);
        if (row.leaseToken !== null || row.leasedUntil !== null || row.state !== (target.state === 'redeeming' ? 'pending' : 'revoked')) throw fail('TEAM_LEASE_READBACK_FAILED');
        return { status: 'recovered', changed: true, state: row.state, nativeState: nativeAbsent ? 'absent' : 'disabled_no_sessions', ...evidence, readbackVerified: true };
    });
    return apply ? finish.immediate() : finish.deferred();
}
function scopeDigest(invitationId, leaseDigest, workerContainerId) { return digest(JSON.stringify([invitationId, leaseDigest, workerContainerId])); }
module.exports = { recover, StoppedWorkerInspector, scopeDigest };
