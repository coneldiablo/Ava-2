'use strict';
// Explicit operator-only pilot preparation. No deployment or verification is
// inferred from this reservation, and the legacy hotel_1 link is untouched.
const fs = require('node:fs');
const DB = require('/app/src/services/database.service');
const Deployment = require('/app/src/services/provisioning/deployment-store');
const ROOT = '/run/ava-entry';
function check(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
try {
    check(process.argv[2] === '--run' && process.env.AVA_PROCESS_ROLE === 'provisioning-worker', 'OPERATOR_WORKER_REQUIRED');
    DB.db = new (require('/app/node_modules/better-sqlite3'))('/app/data/crm_v2.db', { fileMustExist: true });
    DB.db.pragma('busy_timeout = 5000');
    const hotel = DB.get('SELECT id,name,isActive FROM instances WHERE id=1');
    check(hotel?.isActive === 1, 'HOTEL_INACTIVE');
    const owner = DB.get(`SELECT u.id,u.subject,m.role FROM ava_users u JOIN ava_business_memberships m ON m.userId=u.id
        WHERE u.id=? AND u.enabled=1 AND m.businessId=1 AND m.enabled=1 AND m.role='hotel_owner'`,
        ['7a64e752-8bd7-4aa7-bbcf-adf1d0e8a018']);
    check(owner?.subject, 'OWNER_MEMBERSHIP_REQUIRED');
    const legacy = DB.get('SELECT id,onyx_tenant_id,status,revision FROM onyx_tenant_links WHERE business_id=1');
    check(legacy?.onyx_tenant_id === 'hotel_1' && legacy.status !== 'DISABLED', 'LEGACY_LINK_CHANGED');
    const before = DB.get("SELECT count(*) AS n FROM ava_module_deployments WHERE businessId=1 AND module='twenty'").n;
    // Keep the established public Latin slug; this does not rename the hotel.
    DB.db.transaction(() => Deployment.requestForBusiness(1, 'Alleya Resort', ['onyx'])).immediate();
    const row = DB.get("SELECT * FROM ava_module_deployments WHERE businessId=1 AND module='onyx'");
    check(row.hostname === 'alleya-resort-1.knowledge.meludtech.tech', 'PILOT_HOSTNAME_CHANGED');
    const capacity = JSON.parse(fs.readFileSync(`${ROOT}/capacity.json`, 'utf8'));
    const reservation = Deployment.reserve({ deploymentId: row.id, businessId: 1, expectedRevision: row.revision, memoryMiB: 12800, capacity });
    check(reservation.state === 'reserved', 'PILOT_CAPACITY_OR_STATE_REQUIRED');
    check(DB.get("SELECT count(*) AS n FROM ava_module_deployments WHERE businessId=1 AND module='twenty'").n === before, 'TWENTY_DEPLOYMENT_CHANGED');
    const value = { row: Deployment.getWorkerDeployment({ deploymentId: row.id, businessId: 1, expectedRevision: row.revision }),
        legacy, owner: { userId: owner.id, subject: owner.subject, role: owner.role },
        attachmentMode: 'isolated_workspace_ui', verified: false };
    const file = `${ROOT}/reservation.json`;
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    console.log(JSON.stringify({ deployment_id: row.id, business_id: 1, state: reservation.state,
        hostname: row.hostname, legacy_link_unchanged: true, customer_ready: false }));
} catch (error) {
    console.error(/^[A-Z_]{1,80}$/.test(error.code || '') ? error.code : 'ONYX_PILOT_PREPARATION_FAILED');
    process.exitCode = 1;
} finally { DB.db?.close(); }
