#!/usr/bin/env node
'use strict';
const { readProof } = require('./admit-onyx-native-knowledge.cjs');
const fail = () => { throw new Error('ONYX_NATIVE_INTEGRATION_FAILED'); };
function prepareIntegration({ db, access, businessId, deploymentId, revision, ownerUserId, dryRun = true }) {
    if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') fail();
    return db.transaction(() => {
        const row = db.prepare(`SELECT d.* FROM ava_module_deployments d JOIN instances i ON i.id=d.businessId
            WHERE d.id=? AND d.businessId=? AND d.module='onyx' AND d.state='verified' AND d.revision=? AND i.isActive=1`)
            .get(deploymentId, businessId, revision);
        const owner = db.prepare(`SELECT 1 FROM ava_users u JOIN ava_business_memberships m ON m.userId=u.id
            WHERE u.id=? AND u.enabled=1 AND u.subject IS NOT NULL AND m.businessId=? AND m.enabled=1 AND m.role='hotel_owner'`)
            .get(ownerUserId, businessId);
        if (!row || !owner || row.namespace !== `ava_${deploymentId.replaceAll('-', '')}`) fail();
        const enrollment = db.prepare('SELECT * FROM ava_module_enrollments WHERE deploymentId=?').get(deploymentId);
        if (!enrollment || enrollment.businessId !== businessId || enrollment.module !== 'onyx'
            || enrollment.deploymentRevision !== revision || enrollment.nativeScope !== row.namespace
            || enrollment.publicOrigin !== `https://${row.hostname}` || !/^[0-9a-f]{64}$/.test(enrollment.peerSecretHash || '')) fail();
        const legacy = db.prepare('SELECT * FROM onyx_tenant_links WHERE business_id=?').get(businessId);
        const marker = { nativeOnly: true, deploymentId, deploymentRevision: revision };
        if (legacy) {
            let readiness; try { readiness = JSON.parse(legacy.readiness_json || '{}'); } catch (_) { fail(); }
            if (legacy.status !== 'STAGING' || legacy.onyx_tenant_id !== row.namespace || legacy.onyx_base_url !== `https://${row.hostname}/api`
                || legacy.credential_ref !== null || legacy.cc_pair_id !== null || readiness.nativeOnly !== true
                || readiness.deploymentId !== deploymentId || readiness.deploymentRevision !== revision) fail();
        }
        if (dryRun) return { businessId, deploymentId, dryRun: true, anchorRequired: !legacy, runtimeAdmitted: false };
        if (!legacy) db.prepare(`INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,status,readiness_json,revision)
            VALUES (?,?,?,'STAGING',?,1)`).run(businessId, row.namespace, `https://${row.hostname}/api`, JSON.stringify(marker));
        const activated = access.activateDeployment({ businessId, deploymentId, expectedRevision: revision, attachmentMode: 'isolated_workspace_ui' });
        const current = access.getCurrentAdapter(activated.id);
        if (current.id !== deploymentId || current.attachmentMode !== 'isolated_workspace_ui'
            || current.peerSecretHash !== enrollment.peerSecretHash || current.deploymentRevision !== revision) fail();
        return { businessId, deploymentId, adapterId: current.id, adapterRevision: current.revision,
            integrationRevision: current.integrationRevision, deploymentRevision: current.deploymentRevision,
            dryRun: false, runtimeAdmitted: false };
    }).immediate();
}
function main() {
    if (process.getuid?.() !== 0 || !['', '--run'].includes(process.argv.slice(2).join(','))) fail();
    const DB = require('../whatsapp_crm/src/services/database.service');
    const Access = require('../whatsapp_crm/src/services/identity/module-access-store');
    const Database = require('../whatsapp_crm/node_modules/better-sqlite3');
    const config = readProof(process.env.AVA_ONYX_BOOTSTRAP_CONFIG);
    DB.db = new Database(process.env.AVA_CRM_DB_PATH, { fileMustExist: true });
    try {
        const result = prepareIntegration({ db: DB.db, access: Access, businessId: config.businessId,
            deploymentId: config.deploymentId, revision: config.revision, ownerUserId: config.ownerUserId,
            dryRun: process.argv[2] !== '--run' });
        process.stdout.write(JSON.stringify(result) + '\n');
    } finally { DB.db.close(); }
}
if (require.main === module) { try { main(); } catch (_) { process.stderr.write('ONYX_NATIVE_INTEGRATION_FAILED\n'); process.exitCode = 1; } }
module.exports = { prepareIntegration };
