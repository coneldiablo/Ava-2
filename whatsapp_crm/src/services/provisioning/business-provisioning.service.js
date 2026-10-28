const Store = require('./business-provisioning-store.service');
const Worker = require('./business-provisioning-worker.service');

class BusinessProvisioningService {
    /**
     * Unified entrypoint to create a new business instance with atomic database
     * transaction and module provisioning queue.
     */
    async createBusiness(data = {}, options = {}) {
        const idempotencyKey = options.idempotencyKey || data.idempotencyKey || null;
        const voiceInput = { ...data };
        if (!Object.hasOwn(data, 'voiceAiProvider') && (Object.hasOwn(data, 'aiProvider') || Object.hasOwn(data, 'ai_provider'))) voiceInput.voiceAiProvider = data.aiProvider ?? data.ai_provider;
        if (!Object.hasOwn(data, 'voiceName') && Object.hasOwn(data, 'voice')) voiceInput.voiceName = data.voice;
        const { patch: voicePatch } = await require('../voice-settings.service').prepareWrite(voiceInput);
        options.beforeWrite?.();
        const result = Store.createBusinessAtomic(data, { idempotencyKey, ownerUserId: options.ownerUserId, voicePatch });

        // HTTP handlers only persist work. Explicit inline execution is kept
        // for isolated tests/CLI; bootstrap credentials never enter web jobs.
        if (options.syncProcess && process.env.AVA_PROCESS_ROLE === 'provisioning-worker' && !result.isExisting) {
            await Worker.processQueue();
        }

        const provisioning = Store.getProvisioningStatus(result.instance.id);
        return {
            instance: result.instance,
            business: result.instance,
            isExisting: Boolean(result.isExisting),
            idempotencyKey: result.idempotencyKey || null,
            provisioning,
        };
    }

    /**
     * Retrieve the current sanitized module provisioning status for a business.
     */
    async getProvisioningStatus(businessId) {
        return Store.getProvisioningStatus(businessId);
    }

    /**
     * Manually retry failed or blocked provisioning modules for a business.
     * Does not recreate or duplicate the business.
     */
    async retryProvisioning(businessId, options = {}) {
        const retriedCount = Store.retryJobs(businessId, { module: options.module || null });

        if (options.syncProcess && process.env.AVA_PROCESS_ROLE === 'provisioning-worker' && retriedCount > 0) {
            await Worker.processQueue();
        }

        return {
            retriedCount,
            provisioning: Store.getProvisioningStatus(businessId),
        };
    }

    /**
     * Atomically update SIP aliases with database-level conflict checking.
     */
    async updateSipAliases(businessId, aliases = []) {
        return Store.updateBusinessSipAliasesAtomic(businessId, aliases);
    }

    /**
     * Execute one queue iteration of the worker.
     */
    async processQueue(limit = 5) {
        return Worker.processQueue(limit);
    }
}

module.exports = new BusinessProvisioningService();
module.exports.BusinessProvisioningStore = Store;
module.exports.BusinessProvisioningWorker = Worker;
