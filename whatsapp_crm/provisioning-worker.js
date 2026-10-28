'use strict';

// Load configuration before modules resolve DB_PATH. No HTTP server, messaging
// consumers or automatic outbound scheduler is started by this entrypoint.
require('dotenv').config();
const DB = require('./src/services/database.service');

async function startRuntime({
    env = process.env,
    db = DB,
    identityStore = require('./src/services/identity/identity-store'),
    identityBrokerService = require('./src/services/identity/identity-broker'),
    loadTelephonyWorker = () => require('./src/services/telephony/worker'),
    loadProvisioningWorker = () => require('./src/services/provisioning/business-provisioning-worker.service'),
    loadRevocationWorker = () => require('./src/services/identity/revocation-worker'),
    loadPasswordRecoveryWorker = () => require('./src/services/identity/password-recovery.service'),
    loadRegistrationStore = () => require('./src/services/identity/self-registration.service'),
    loadRecoveryWorker = () => require('./src/services/identity/sync-lease-recovery-worker'),
    schedule = setInterval,
    cancel = clearInterval,
} = {}) {
    let phase = 'DB_INIT';
    let identityBroker = null, identityTimer = null, recoveryTimer = null, telephonyTimer = null, worker = null;
    let identityBusy = false, recoveryBusy = false, telephonyBusy = false;
    try {
        await db.init();
        phase = 'IDENTITY_SCHEMA';
        identityStore.ensureSchema();
        phase = 'SALES_SCHEMA';
        if (typeof db.createSalesWorkspaceTables === 'function') db.createSalesWorkspaceTables();
        phase = 'BROKER_BIND';
        identityBroker = identityBrokerService.start({ ready: false });
        if (identityBroker && typeof identityBroker.once === 'function' && !identityBroker.listening) {
            await new Promise((resolve, reject) => {
                const ready = () => { identityBroker.removeListener('error', failed); resolve(); };
                const failed = error => { identityBroker.removeListener('listening', ready); reject(error); };
                identityBroker.once('listening', ready);
                identityBroker.once('error', failed);
            });
        }
        const provisioningJobsEnabled = env.AVA_PROVISIONING_JOBS_ENABLED !== 'false';
        const knowledgeProvisioningEnabled = env.AVA_KNOWLEDGE_PROVISIONING_ENABLED === 'true';
        if (!provisioningJobsEnabled && !identityBroker) {
            throw Object.assign(new Error('IDENTITY_BROKER_REQUIRED'), { code: 'IDENTITY_BROKER_REQUIRED' });
        }
        phase = 'LOAD_REVOCATION';
        const revocationWorker = loadRevocationWorker();
        phase = 'LOAD_PASSWORD_RECOVERY';
        const passwordRecoveryWorker = loadPasswordRecoveryWorker();
        phase = 'LOAD_REGISTRATION';
        const registrationStore = loadRegistrationStore();
        phase = 'IDENTITY_TIMER';
        identityTimer = schedule(async () => {
            if (identityBusy) return;
            identityBusy = true;
            try {
                await revocationWorker.processOne(provisioningJobsEnabled ? undefined : { keycloakOnly: true });
                registrationStore.ensureSchema();
                await passwordRecoveryWorker.processOne();
            } catch (_) { process.stderr.write('IDENTITY_REVOCATION_WORKER_FAILED\n'); }
            finally { identityBusy = false; }
        }, 3000);
        if (provisioningJobsEnabled) {
            if (env.AVA_TWENTY_SYNC_RECOVERY_ENABLED === 'true') {
                phase = 'LOAD_SYNC_RECOVERY';
                const recoveryWorker = loadRecoveryWorker();
                phase = 'SYNC_RECOVERY_TIMER';
                recoveryTimer = schedule(async () => {
                    if (recoveryBusy) return;
                    recoveryBusy = true;
                    try { await recoveryWorker.processOne(); }
                    catch (_) { process.stderr.write('TWENTY_SYNC_RECOVERY_WORKER_FAILED\n'); }
                    finally { recoveryBusy = false; }
                }, 5000);
            }
        }
        if (provisioningJobsEnabled || knowledgeProvisioningEnabled) {
            phase = 'LOAD_PROVISIONING';
            worker = loadProvisioningWorker();
            phase = 'PROVISIONING_POLLER';
            worker.startBackgroundPoller(3000, { knowledgeOnly: !provisioningJobsEnabled });
            // The shared poller is unref'ed for embedding in tests; this entrypoint
            // owns its lifetime and must stay alive while the queue is idle.
            worker._pollerTimer.ref();
        }
        // The global queue owns telephony when enabled. Otherwise a narrowly
        // scoped timer keeps it operational without starting provisioning jobs.
        if (!provisioningJobsEnabled && env.AVA_TELEPHONY_WORKER_ENABLED === 'true') {
            phase = 'LOAD_TELEPHONY';
            const telephonyWorker = loadTelephonyWorker();
            phase = 'TELEPHONY_TIMER';
            telephonyTimer = schedule(async () => {
                if (telephonyBusy) return;
                telephonyBusy = true;
                try { await telephonyWorker.processOne(); }
                catch (_) { process.stderr.write('TELEPHONY_WORKER_FAILED\n'); }
                finally { telephonyBusy = false; }
            }, 3000);
        }
        phase = 'READY';
        identityBroker?.setReady?.(true);
        let stopping = false;
        const shutdown = async () => {
            if (stopping) return;
            stopping = true;
            identityBroker?.setReady?.(false);
            worker?.stopBackgroundPoller();
            identityBroker?.close();
            if (identityTimer) cancel(identityTimer);
            if (recoveryTimer) cancel(recoveryTimer);
            if (telephonyTimer) cancel(telephonyTimer);
            const deadline = Date.now() + 25000;
            while ((worker?._isProcessing || identityBusy || recoveryBusy || telephonyBusy || identityBroker?.activeEnrollments) && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (!worker?._isProcessing && !identityBusy && !recoveryBusy && !telephonyBusy && !identityBroker?.activeEnrollments) db.db.close();
        };
        return { provisioningJobsEnabled, knowledgeProvisioningEnabled, shutdown };
    } catch (cause) {
        // Preserve the original failure even if teardown itself fails. The
        // broker must not outlive a partially initialized runtime.
        try { identityBroker?.setReady?.(false); } catch (_) {}
        try { if (identityTimer) cancel(identityTimer); } catch (_) {}
        try { if (recoveryTimer) cancel(recoveryTimer); } catch (_) {}
        try { if (telephonyTimer) cancel(telephonyTimer); } catch (_) {}
        try { worker?.stopBackgroundPoller(); } catch (_) {}
        try {
            if (identityBroker && typeof identityBroker.once === 'function') {
                await new Promise(resolve => identityBroker.close(() => resolve()));
            } else identityBroker?.close();
        } catch (_) {}
        try { db.db?.close(); } catch (_) {}
        const error = cause && typeof cause === 'object' ? cause : new Error('WORKER_STARTUP_FAILED');
        error.workerStartupStage = phase;
        throw error;
    }
}

function startupDiagnostic(error) {
    const known = /^(?:SQLITE_[A-Z_]+|ERR_[A-Z_]+|MODULE_NOT_FOUND|EADDRINUSE|EACCES|ENOENT|IDENTITY_[A-Z_]+)$/;
    const code = typeof error?.code === 'string' && error.code.length <= 80 && known.test(error.code)
        ? error.code : 'WORKER_STARTUP_FAILED';
    const phase = /^[A-Z_]{3,40}$/.test(error?.workerStartupStage || '') ? error.workerStartupStage : 'BOOTSTRAP';
    // Extract only a bounded repository source location, never the message,
    // SQL, environment, full stack, configuration path or credential values.
    const match = typeof error?.stack === 'string' && error.stack.match(/(?:\bat |\()([^\s()]*\/(?:src\/[a-zA-Z0-9_./-]+|provisioning-worker)\.js):(\d+):(\d+)/);
    let source;
    if (match && !match[1].includes('/../')) {
        const relative = match[1].match(/(?:src\/[a-zA-Z0-9_./-]+|provisioning-worker)\.js$/)?.[0];
        if (relative && relative.length <= 180) source = { path: relative, line: Number(match[2]) };
    }
    return { event: 'PROVISIONING_WORKER_START_FAILED', phase, code, ...(source ? { source } : {}) };
}

async function main() {
    process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
    const runtime = await startRuntime();
    const shutdown = async () => {
        await runtime.shutdown();
        // Unfinished leases are recovered by a replacement worker.
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

if (require.main === module) main().catch(error => {
    process.stderr.write(JSON.stringify(startupDiagnostic(error)) + '\n');
    process.exitCode = 1;
});
module.exports = { main, startRuntime, startupDiagnostic };
