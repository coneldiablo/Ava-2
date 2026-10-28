const DB = require('../database.service');
const Logger = require('../../utils/logger');
const Store = require('./business-provisioning-store.service');
const { parseJson } = require('../pms/pms-utils');

class BusinessProvisioningWorker {
    constructor({ isolatedProvisioner = null } = {}) {
        this._isProcessing = false;
        this._pollerTimer = null;
        this._isolatedProvisioner = isolatedProvisioner;
        this._knowledgeOnly = false;
    }

    /**
     * Start background poller that periodically recovers stale leases and
     * processes pending/retryable jobs (R1).
     */
    startBackgroundPoller(intervalMs = 3000, { knowledgeOnly = false } = {}) {
        if (this._pollerTimer) return;
        this._knowledgeOnly = knowledgeOnly === true;
        Store.sanitizeLegacyCheckpoints({ knowledgeOnly: this._knowledgeOnly });
        const tick = async () => {
            try {
                // leaseJobs performs stale recovery in the same transaction.
                await this.processQueue();
            } catch (err) {
                Logger.warn('[ProvisioningWorker] Poller error:', err.message);
            }
        };
        this._pollerTimer = setInterval(tick, Math.max(10, Number(intervalMs) || 3000));
        void tick();
        if (this._pollerTimer && typeof this._pollerTimer.unref === 'function') {
            this._pollerTimer.unref();
        }
    }

    /**
     * Stop background poller timer.
     */
    stopBackgroundPoller() {
        if (this._pollerTimer) {
            clearInterval(this._pollerTimer);
            this._pollerTimer = null;
        }
    }

    /**
     * Process pending jobs from the queue with an automatic drain loop.
     * When a module completes (e.g. knowledge_base), dependent modules (e.g. onyx_runtime)
     * are picked up and executed in subsequent drain iterations without stalling (R1).
     * Note: External calls are strictly performed OUTSIDE of database transactions.
     */
    async processQueue(limit = 5) {
        if (this._isProcessing) return 0;
        this._isProcessing = true;
        let totalProcessed = 0;

        try {
            if (!this._knowledgeOnly && process.env.AVA_TELEPHONY_WORKER_ENABLED === 'true') {
                try {await require('../telephony/worker').processOne();}
                catch(_) {Logger.warn('[ProvisioningWorker] Telephony queue unavailable');}
            }
            let batchProcessed = 0;
            do {
                batchProcessed = await this._processBatch(limit);
                totalProcessed += batchProcessed;
            } while (batchProcessed > 0 && totalProcessed < 250);
        } catch (err) {
            Logger.warn('[ProvisioningWorker] Error in processQueue:', err.message);
        } finally {
            this._isProcessing = false;
        }

        return totalProcessed;
    }

    async _processBatch(limit = 5) {
        // 1. Transaction phase: Lease jobs
        let processedCount = 0;
        // 2. Out-of-transaction phase: Execute external operations
        // Lease only the operation we are about to execute; waiting jobs must
        // not lose most of their TTL behind a slow upstream request.
        for (let index = 0; index < limit; index++) {
            const job = Store.leaseJobs(1, 60, { knowledgeOnly: this._knowledgeOnly })[0];
            if (!job) break;
            processedCount += 1;
            let result;
            let leaseLost = false;
            const heartbeat = setInterval(() => {
                try { leaseLost = leaseLost || !Store.renewLease(job.id, job.leaseToken, 60); }
                catch (_) { leaseLost = true; }
            }, 15000);
            heartbeat.unref?.();
            try {
                result = await this._executeJob(job);
            } catch (error) {
                const errorCode = error.code || 'PROVISIONING_EXECUTION_ERROR';
                const retryable = error.retryable !== false && Number(job.attempts || 1) < Number(job.maxAttempts || 5);
                result = {
                    status: 'FAILED',
                    retryable,
                    errorCode,
                    errorMessage: error.message || 'Job execution failed',
                    userNextStep: error.userNextStep || 'Повторите подключение модуля или проверьте настройки',
                    checkpoint: error.checkpoint || parseJson(job.checkpointJson, {}),
                };
            } finally {
                clearInterval(heartbeat);
            }

            // 3. Transaction phase: Record completion or failure
            if (!leaseLost) {
                Store.finishJob(job.id, job.leaseToken, result);
                if(job.module==='telephony_sip' && !this._knowledgeOnly) {
                    const Phones=require('../telephony/store');
                    if(DB.get('SELECT id FROM ava_phone_numbers WHERE businessId=?',[job.businessId])) Phones.syncProjection(job.businessId);
                }
            }
        }

        return processedCount;
    }

    /**
     * Dispatch job to the appropriate module runner.
     * Checks checkpoint before making calls to avoid duplicating external resources.
     */
    async _executeJob(job) {
        if (this._knowledgeOnly && !['knowledge_base', 'onyx_runtime'].includes(job.module)) {
            throw Object.assign(new Error('KNOWLEDGE_WORKER_SCOPE_MISMATCH'), { code: 'KNOWLEDGE_WORKER_SCOPE_MISMATCH', retryable: false });
        }
        const checkpoint = Store._internals.safeCheckpoint(parseJson(job.checkpointJson, {}));
        Store.updateJobCheckpoint(job.id, job.leaseToken, checkpoint);
        const instance = await DB.getInstance(job.businessId);
        if (!instance || !Number(instance.isActive)) {
            const error = new Error(`Business ${job.businessId} not found`);
            error.retryable = false;
            error.code = 'BUSINESS_NOT_FOUND';
            throw error;
        }

        switch (job.module) {
        case 'knowledge_base':
            return this._runKnowledgeBaseModule(job, instance, checkpoint);
        case 'crm_workspace':
            return this._runCrmWorkspaceModule(job, instance, checkpoint);
        case 'onyx_runtime':
            return this._runOnyxRuntimeModule(job, instance, checkpoint);
        case 'telephony_sip':
            return this._runTelephonySipModule(job, instance, checkpoint);
        case 'whatsapp':
            return this._runWhatsappModule(job, instance, checkpoint);
        case 'pms':
            return this._runPmsModule(job, instance, checkpoint);
        default:
            return {
                status: 'BLOCKED',
                stage: 'awaiting_setup',
                errorCode: 'PROVISIONING_MODULE_UNKNOWN',
                checkpoint,
                userNextStep: 'Неизвестный модуль: требуется проверка платформой AVA',
            };
        }
    }

    async _runKnowledgeBaseModule(job, instance, checkpoint) {
        // Dedicated knowledge scope verification
        const kbInstanceId = Number(instance.knowledgeBaseInstanceId || instance.id);
        if (kbInstanceId !== Number(instance.id)) throw Object.assign(new Error('Knowledge scope belongs to another business'),
            { code: 'ONYX_KNOWLEDGE_SCOPE_MISMATCH', retryable: false });
        const docsRow = DB.get(
            `SELECT COUNT(*) as count FROM knowledge_base
             WHERE instanceId = ? AND isCurrent = 1 AND (business_id IS NULL OR business_id = ?)`,
            [kbInstanceId, kbInstanceId]
        );
        const docCount = Number(docsRow?.count || 0);
        const hasDocuments = docCount > 0;

        const nextCheckpoint = {
            ...checkpoint,
            scopeVerified: true,
            kbInstanceId,
            docCount,
            hasDocuments,
        };

        return {
            status: 'DONE',
            stage: 'ready',
            checkpoint: nextCheckpoint,
            userNextStep: hasDocuments
                ? 'База знаний содержит документы отеля'
                : 'Добавьте знания в базу отеля',
        };
    }

    async _runCrmWorkspaceModule(job, instance, checkpoint) {
        const isolated = await this._isolatedDeploymentStatus(job, instance.id, 'twenty', checkpoint);
        if (isolated) return isolated;
        const TwentyStore = require('../twenty/twenty-store.service');
        const TwentyProvisioner = require('../twenty/twenty-provisioner.service');

        const existingLink = TwentyStore.getIntegrationUnsafe(instance.id);
        if (existingLink && existingLink.connectionStatus === 'connected') {
            return {
                status: 'SKIPPED',
                stage: 'requires_verification',
                checkpoint: {
                    ...checkpoint,
                    workspaceLinked: true,
                    workspaceId: existingLink.workspaceId,
                    mode: existingLink.mode,
                },
                userNextStep: 'Существующее подключение CRM сохранено; проверьте webhook и синхронизацию',
            };
        }

        const twentyBaseUrl = process.env.TWENTY_PROVISIONING_BASE_URL || process.env.TWENTY_BASE_URL || process.env.TWENTY_SERVER_URL;
        if (!twentyBaseUrl && !TwentyProvisioner.apiAdapter) {
            return {
                status: 'BLOCKED',
                stage: 'awaiting_setup',
                errorCode: 'TWENTY_NOT_CONFIGURED',
                checkpoint: { ...checkpoint, skippedReason: 'TWENTY_NOT_CONFIGURED' },
                userNextStep: 'CRM ожидает настройки платформой AVA',
            };
        }

        try {
            const result = await TwentyProvisioner.provisionWorkspace(instance.id, instance, checkpoint, {
                onCheckpoint: (newCp) => Store.updateJobCheckpoint(job.id, job.leaseToken, newCp),
            });
            return {
                status: result.status || 'SKIPPED',
                stage: result.stage || 'requires_verification',
                checkpoint: result.checkpoint,
                userNextStep: result.userNextStep,
            };
        } catch (error) {
            if (error.code === 'TWENTY_WORKSPACE_LIMIT_REACHED') {
                error.retryable = false;
                error.userNextStep = 'Достигнут лимит рабочих пространств Twenty (максимум 5 без Enterprise-лицензии). Обратитесь к администратору платформы.';
            }
            // Preserve progress made before failure (R4)
            error.checkpoint = {
                ...(error.checkpoint || checkpoint),
                lastAttemptError: error.code || 'TWENTY_PROVISIONING_FAILED',
            };
            throw error;
        }
    }

    async _runOnyxRuntimeModule(job, instance, checkpoint) {
        // New knowledge-only jobs request the existing isolated deployment
        // workflow. Do not create a shared legacy tenant just because a global
        // Onyx URL happens to be set. Existing tenant links are preserved.
        if (this._knowledgeOnly && !DB.get('SELECT id FROM onyx_tenant_links WHERE business_id=?', [instance.id])) {
            const deployments = require('./deployment-store');
            DB.db.transaction(() => deployments.requestForBusiness(instance.id, instance.name, ['onyx'])).immediate();
        }
        const isolated = await this._isolatedDeploymentStatus(job, instance.id, 'onyx', checkpoint);
        if (isolated) return isolated;
        const OnyxProvisioner = require('../onyx/onyx-provisioner.service');

        const existingOnyxLink = DB.get(
            'SELECT * FROM onyx_tenant_links WHERE business_id = ?',
            [instance.id]
        );

        if (existingOnyxLink && ['ACTIVE', 'ACTIVE_LIVE'].includes(existingOnyxLink.status)) {
            return {
                status: 'SKIPPED',
                stage: 'requires_verification',
                checkpoint: {
                    ...checkpoint,
                    onyxBound: true,
                    tenantId: existingOnyxLink.onyx_tenant_id,
                    status: existingOnyxLink.status,
                },
                userNextStep: 'Действующее подключение сохранено; автоматическое перенастроение запрещено',
            };
        }

        const onyxBaseUrl = process.env.ONYX_BASE_URL;
        if (!onyxBaseUrl && !OnyxProvisioner.apiAdapter) {
            return {
                status: 'BLOCKED',
                stage: 'awaiting_setup',
                errorCode: 'ONYX_NOT_CONFIGURED',
                checkpoint: { ...checkpoint, skippedReason: 'ONYX_NOT_CONFIGURED' },
                userNextStep: 'Знания ожидают настройки платформой AVA',
            };
        }

        try {
            const result = await OnyxProvisioner.provisionTenant(instance, checkpoint, {
                onCheckpoint: (newCp) => Store.updateJobCheckpoint(job.id, job.leaseToken, newCp),
            });
            return {
                status: 'DONE',
                stage: 'ready',
                checkpoint: result.checkpoint,
                userNextStep: result.userNextStep,
            };
        } catch (error) {
            if (error.code === 'ONYX_VERSION_UNSUPPORTED' || error.nonRetryable) {
                error.retryable = false;
                error.userNextStep = error.message;
            }
            // Preserve progress made before failure (R4)
            error.checkpoint = {
                ...(error.checkpoint || checkpoint),
                lastAttemptError: error.code || 'ONYX_PROVISIONING_FAILED',
            };
            throw error;
        }
    }

    async _isolatedDeploymentStatus(job, businessId, module, checkpoint) {
        const deployment = require('./deployment-store').list(businessId).find(row => row.module === module);
        if (!deployment) return null; // Preserve legacy deployments; no automatic migration.
        const progress = { ...checkpoint, deploymentId: deployment.deployment_id, deploymentRevision: deployment.revision };
        if (process.env.AVA_ISOLATED_MODULES_ENABLED !== 'true' || !process.env.AVA_MODULE_DEPLOYMENT_SOCKET) return {
            status: 'BLOCKED', stage: 'awaiting_setup',
            errorCode: process.env.AVA_ISOLATED_MODULES_ENABLED !== 'true' ? 'DEPLOYMENT_FEATURE_DISABLED' : 'DEPLOYMENT_HELPER_UNAVAILABLE',
            checkpoint: progress, userNextStep: 'Отдельный кабинет ожидает настройки платформой AVA',
        };
        const provisioner = this._isolatedProvisioner || new (require('./isolated-module-provisioner'))({ knowledgeOverlay: this._knowledgeOnly });
        // A new isolated tenant must never silently fall back to the shared
        // Enterprise/group-based provisioner. Infrastructure verification alone
        // is not a successful native user login or a completed initial sync.
        try { return await provisioner.run(job, module); }
        catch (error) {
            const errorCode = require('./module-deployment-client').safeErrorCode(error.code);
            const requiresSetup = ['DEPLOYMENT_RECIPE_REQUIRED', 'DEPLOYMENT_NATIVE_VERIFIER_REQUIRED'].includes(errorCode);
            return { status: requiresSetup ? 'BLOCKED' : 'FAILED', stage: 'awaiting_setup',
                errorCode, errorMessage: errorCode, retryable: error.retryable !== false,
                retryAt: error.nextRetryAt, checkpoint: progress,
                userNextStep: error.retryable !== false
                    ? 'Подготовка прервалась. AVA повторит попытку автоматически'
                    : 'Отдельный кабинет требует проверки платформой AVA' };
        }
    }

    async _runTelephonySipModule(job, instance, checkpoint) {
        const Phones = require('../telephony/store');
        Phones.ensureSchema();
        const managed = DB.all("SELECT id,state FROM ava_phone_numbers WHERE businessId=? AND state<>'released'", [instance.id]);
        if (managed.length) return {
            status: managed.some(p => p.state === 'active') ? 'DONE' : 'BLOCKED',
            stage: managed.some(p => p.state === 'active') ? 'ready' : 'awaiting_setup',
            checkpoint: {managedPhoneIds:managed.map(p=>p.id)},
            userNextStep: 'Состояние номеров доступно в разделе Каналы → Телефония',
        };
        const aliasesRow = DB.all(
            'SELECT alias FROM business_sip_aliases WHERE businessId = ?',
            [instance.id]
        );
        const aliases = aliasesRow.map((r) => r.alias);

        return {
            status: 'SKIPPED',
            stage: 'requires_verification',
            checkpoint: {
                ...checkpoint,
                sipAliasesVerified: false,
                aliases,
                trunkConfigured: Boolean(instance.sipTrunkNumber),
            },
            userNextStep: (instance.sipTrunkNumber || aliases.length)
                ? 'Проверьте регистрацию SIP и выполните тестовый звонок'
                : 'Укажите номер транка или SIP-алиас для приема звонков',
        };
    }

    async _runWhatsappModule(job, instance, checkpoint) {
        return {
            status: 'SKIPPED',
            stage: 'requires_connection',
            checkpoint: {
                ...checkpoint,
                whatsappProvider: instance.whatsappProvider || 'openwa',
                sessionSlotReady: false,
            },
            userNextStep: 'Подключите WhatsApp сессию по QR-коду в настройках',
        };
    }

    async _runPmsModule(job, instance, checkpoint) {
        const PmsService = require('../pms/pms.service');
        const pmsConfig = PmsService.get(instance.id);

        if (!pmsConfig || !pmsConfig.enabled) {
            return {
                status: 'SKIPPED',
                stage: 'skipped',
                checkpoint: { ...checkpoint, skipped: true },
                userNextStep: 'Настройте интеграцию с Bnovo при необходимости',
            };
        }

        return {
            status: 'DONE',
            stage: 'ready',
            checkpoint: {
                ...checkpoint,
                pmsProvider: pmsConfig.provider || 'bnovo',
            },
            userNextStep: 'Интеграция с PMS подключена',
        };
    }
}

module.exports = new BusinessProvisioningWorker();
module.exports.BusinessProvisioningWorker = BusinessProvisioningWorker;
