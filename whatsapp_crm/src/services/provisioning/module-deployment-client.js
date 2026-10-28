'use strict';
const http = require('http');
const MAX = 64 * 1024;
const SAFE_CODES = new Set([
    'DEPLOYMENT_WORKER_REQUIRED', 'DEPLOYMENT_FEATURE_DISABLED', 'DEPLOYMENT_HELPER_UNAVAILABLE',
    'DEPLOYMENT_HELPER_TIMEOUT', 'DEPLOYMENT_HELPER_PROTOCOL_INVALID', 'DEPLOYMENT_HELPER_RESPONSE_TOO_LARGE',
    'DEPLOYMENT_HELPER_BUSY', 'DEPLOYMENT_HELPER_FAILED', 'DEPLOYMENT_OPERATION_FAILED', 'DEPLOYMENT_NOT_RUNNING',
    'DEPLOYMENT_REQUEST_INVALID', 'DEPLOYMENT_OPERATION_FORBIDDEN', 'DEPLOYMENT_RECIPE_REQUIRED',
    'DEPLOYMENT_RECIPE_INVALID', 'DEPLOYMENT_RECIPE_UNTRUSTED', 'DEPLOYMENT_RECIPE_SCOPE_MISMATCH',
    'DEPLOYMENT_RECIPE_DIGEST_MISMATCH', 'DEPLOYMENT_IMAGE_UNPINNED', 'DEPLOYMENT_IMAGE_DRIFT',
    'DEPLOYMENT_COMPOSE_INVALID', 'DEPLOYMENT_COMPOSE_INTERPOLATION_FORBIDDEN', 'DEPLOYMENT_NETWORK_INVALID',
    'DEPLOYMENT_VOLUME_INVALID', 'DEPLOYMENT_SERVICE_INVALID', 'DEPLOYMENT_SERVICE_UNSAFE',
    'DEPLOYMENT_LABELS_INVALID', 'DEPLOYMENT_LIMITS_INVALID', 'DEPLOYMENT_NATIVE_EXPOSED', 'DEPLOYMENT_ENV_INVALID',
    'DEPLOYMENT_RESERVATION_TOO_SMALL', 'DEPLOYMENT_RESOURCE_OWNERSHIP_CONFLICT', 'DEPLOYMENT_INSPECTION_INVALID',
    'DEPLOYMENT_NATIVE_VERIFIER_REQUIRED', 'DEPLOYMENT_NATIVE_PROOF_INCOMPLETE', 'DEPLOYMENT_LEASE_LOST',
    'DEPLOYMENT_BUSINESS_INACTIVE', 'DEPLOYMENT_REVISION_CHANGED', 'DEPLOYMENT_SCOPE_MISMATCH',
    'DEPLOYMENT_RETRY_NOT_DUE', 'DEPLOYMENT_LEASE_UNAVAILABLE', 'DEPLOYMENT_ATTEMPTS_EXHAUSTED',
    'DEPLOYMENT_FACTORY_UNSUPPORTED', 'DEPLOYMENT_FACTORY_ROOT_REQUIRED', 'DEPLOYMENT_IMAGE_CATALOGUE_INVALID',
    'DEPLOYMENT_GENERATED_SECRETS_INVALID', 'DEPLOYMENT_BUSINESS_NAME_INVALID', 'DEPLOYMENT_PREPARED_FILE_CHANGED',
    'DEPLOYMENT_PREPARATION_NOT_OWNED', 'DEPLOYMENT_INIT_INVALID',
    'DEPLOYMENT_KNOWLEDGE_OVERLAY_REQUIRED', 'DEPLOYMENT_NATIVE_VERIFIER_CONFIGURATION_REQUIRED',
    'DEPLOYMENT_GATEWAY_REQUIRED', 'DEPLOYMENT_ENROLLMENT_INVALID',
    'MODULE_ENROLLMENT_INVALID', 'MODULE_ENROLLMENT_CHANGED', 'MODULE_ENROLLMENT_LEASE_LOST',
    'DEPLOYMENT_SYNC_RECOVERY_DISABLED', 'DEPLOYMENT_SYNC_RECOVERY_INVALID',
    'DEPLOYMENT_SYNC_RECOVERY_SCOPE_MISMATCH', 'DEPLOYMENT_SYNC_RECOVERY_LEASE_LOST',
    'DEPLOYMENT_SYNC_RECOVERY_CONTOUR_INVALID', 'DEPLOYMENT_SYNC_RECOVERY_STOP_FAILED',
    'DEPLOYMENT_SYNC_RECOVERY_RESTART_FAILED', 'DEPLOYMENT_SYNC_RECOVERY_DATABASE_UNVERIFIED',
    'DEPLOYMENT_SYNC_RECOVERY_NATIVE_UNVERIFIED',
    'SYNC_RECOVERY_FEATURE_DISABLED', 'SYNC_RECOVERY_REQUEST_INVALID', 'SYNC_RECOVERY_CLAIM_LOST', 'SYNC_RECOVERY_SCOPE_CHANGED',
    'SYNC_RECOVERY_NOT_ELIGIBLE', 'SYNC_RECOVERY_BINDING_CHANGED', 'SYNC_RECOVERY_RECIPE_REQUIRED',
    'SYNC_RECOVERY_INSPECTION_INVALID', 'SYNC_RECOVERY_STOP_UNPROVEN', 'SYNC_RECOVERY_RESTART_UNPROVEN',
    'SYNC_RECOVERY_DATABASE_UNPROVEN',
]);
const TRANSIENT = new Set(['DEPLOYMENT_HELPER_BUSY', 'DEPLOYMENT_OPERATION_FAILED', 'DEPLOYMENT_NOT_RUNNING',
    'DEPLOYMENT_HELPER_UNAVAILABLE', 'DEPLOYMENT_HELPER_TIMEOUT']);
const safeErrorCode = code => SAFE_CODES.has(code) ? code : 'DEPLOYMENT_HELPER_FAILED';
const failure = (code, retryable = true) => Object.assign(new Error(code), { code, retryable });
class ModuleDeploymentClient {
    constructor(socketPath = process.env.AVA_MODULE_DEPLOYMENT_SOCKET, { timeoutMs = 240000, recoveryTimeoutMs = 540000 } = {}) {
        this.socketPath = socketPath;
        this.timeoutMs = Math.min(240000, Math.max(1000, Number(timeoutMs) || 240000));
        // Whole-contour stop + verified restart is intentionally longer than a
        // normal deployment request, but remains below the 10-minute durable
        // recovery claim. A timeout never removes the active sync barrier.
        this.recoveryTimeoutMs = Math.min(540000, Math.max(1000, Number(recoveryTimeoutMs) || 540000));
    }
    call(path, body = {}, timeoutMs = this.timeoutMs) {
        if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') return Promise.reject(failure('DEPLOYMENT_WORKER_REQUIRED', false));
        if (typeof this.socketPath !== 'string' || !this.socketPath.startsWith('/') || this.socketPath.includes('\0')) {
            return Promise.reject(failure('DEPLOYMENT_HELPER_UNAVAILABLE', false));
        }
        if (!['/v1/capacity', '/v1/reconcile', '/v1/provision', '/v1/enrollment', '/v1/verify', '/v1/sync-recovery'].includes(path)) {
            return Promise.reject(failure('DEPLOYMENT_REQUEST_INVALID', false));
        }
        const payload = JSON.stringify(body);
        return new Promise((resolve, reject) => {
            let request, deadline, settled = false;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(deadline);
                if (error) { request?.destroy(); reject(error); } else resolve(value);
            };
            try {
                request = http.request({ socketPath: this.socketPath, path, method: 'POST',
                    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, response => {
                    let size = 0;
                    const chunks = [];
                    response.on('data', chunk => {
                        size += chunk.length;
                        if (size > MAX) finish(failure('DEPLOYMENT_HELPER_RESPONSE_TOO_LARGE', false));
                        else chunks.push(chunk);
                    });
                    response.on('error', () => finish(failure('DEPLOYMENT_HELPER_UNAVAILABLE')));
                    response.on('aborted', () => finish(failure('DEPLOYMENT_HELPER_UNAVAILABLE')));
                    response.on('end', () => {
                        if (settled) return;
                        try {
                            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
                            if (response.statusCode !== 200) {
                                const code = safeErrorCode(value.error_code);
                                return finish(failure(code, response.statusCode >= 500 || TRANSIENT.has(code)));
                            }
                            finish(null, value);
                        } catch (_) { finish(failure('DEPLOYMENT_HELPER_PROTOCOL_INVALID', false)); }
                    });
                });
                request.on('error', () => finish(failure('DEPLOYMENT_HELPER_UNAVAILABLE')));
                deadline = setTimeout(() => finish(failure('DEPLOYMENT_HELPER_TIMEOUT')), timeoutMs);
                request.end(payload);
            } catch (_) { finish(failure('DEPLOYMENT_HELPER_UNAVAILABLE')); }
        });
    }
    capacity() { return this.call('/v1/capacity', {}); }
    deployment(path, input) {
        if (!input || Object.keys(input).sort().join(',') !== 'businessId,deploymentId,leaseToken,revision') {
            return Promise.reject(failure('DEPLOYMENT_REQUEST_INVALID', false));
        }
        return this.call(path, input);
    }
    reconcile(input) { return this.deployment('/v1/reconcile', input); }
    provision(input) { return this.deployment('/v1/provision', input); }
    enrollment(input) { return this.deployment('/v1/enrollment', input); }
    verify(input) { return this.deployment('/v1/verify', input); }
    syncRecovery(input) {
        const keys = ['adapterRevision','businessId','contractVersion','correlationId','deploymentId','deploymentRevision',
            'integrationRevision','leaseId','leaseRevision','outboxEventId','recoveryId','recoveryToken'];
        if (!input || Object.keys(input).sort().join(',') !== keys.sort().join(',')
            || input.contractVersion !== 'ava-sync-recovery-v1') {
            return Promise.reject(failure('DEPLOYMENT_REQUEST_INVALID', false));
        }
        return this.call('/v1/sync-recovery', input, this.recoveryTimeoutMs);
    }
}
module.exports = ModuleDeploymentClient;
module.exports.safeErrorCode = safeErrorCode;
