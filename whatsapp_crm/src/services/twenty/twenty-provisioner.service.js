const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DB = require('../database.service');
const TwentyStore = require('./twenty-store.service');
const TwentyService = require('./twenty.service');
const { TwentyClient, normalizeBaseUrl } = require('./twenty-client');
const { encryptJson, decryptJson, context } = require('./twenty-crypto');
const { TwentyNativeProvisioning } = require('./twenty-native-provisioning');
const { listMetadata, createdMetadata } = require('./twenty-metadata');
const { _internals: { safeCheckpoint } } = require('../provisioning/business-provisioning-store.service');

function nativeAdapterRequired() {
    return Object.assign(new Error('Для создания CRM нужен защищённый служебный вход владельца CRM.'),
        { code: 'TWENTY_PROVISIONING_CREDENTIALS_REQUIRED', retryable: false });
}

const MAX_WORKSPACES_WITHOUT_ENTERPRISE_KEY = 5;

const RESERVED_SUBDOMAINS = new Set([
    'app', 'crm', 'api', 'admin', 'auth', 'mail', 'twenty', 'test',
    'localhost', 'dev', 'staging', 'production', 'demo', 'public',
    'support', 'portal', 'dashboard', 'status', 'assets', 'static',
]);

const CYRILLIC_TO_LATIN = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
};

function transliterate(str) {
    return String(str || '')
        .toLowerCase()
        .split('')
        .map((char) => CYRILLIC_TO_LATIN[char] || char)
        .join('');
}

function normalizeSlug(name, businessId) {
    const raw = transliterate(name)
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    let base = raw || 'hotel';
    if (RESERVED_SUBDOMAINS.has(base)) {
        base = `biz-${base}`;
    }

    const suffix = `-${businessId}`;
    const maxBaseLen = Math.max(1, 32 - suffix.length);
    const trimmedBase = base.slice(0, maxBaseLen).replace(/-+$/, '') || 'hotel';

    return `${trimmedBase}${suffix}`;
}

class TwentyProvisionerService {
    constructor(options = {}) {
        this.clientFactory = options.clientFactory || ((opts) => new TwentyClient(opts));
        this.apiAdapter = options.apiAdapter || null;
        // Packaged with src: the production Docker build has no parent checkout.
        // A repository test keeps this copy identical to deploy/twenty's manifest.
        this.manifestPath = options.manifestPath || path.join(__dirname, 'schema-manifest.json');
    }

    generateSlug(name, businessId) {
        return normalizeSlug(name, businessId);
    }

    checkWorkspaceCapacity(currentCount, hasEnterpriseKey = false) {
        const count = Number(currentCount) || 0;
        if (count >= MAX_WORKSPACES_WITHOUT_ENTERPRISE_KEY && !hasEnterpriseKey) {
            const error = new Error('Достигнут лимит рабочих пространств Twenty (максимум 5 без Enterprise-лицензии). Обратитесь к администратору платформы.');
            error.code = 'TWENTY_WORKSPACE_LIMIT_REACHED';
            error.statusCode = 422;
            throw error;
        }
        return true;
    }

    loadManifest() {
        if (!fs.existsSync(this.manifestPath)) {
            throw new Error(`Schema manifest not found at ${this.manifestPath}`);
        }
        return JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
    }

    _getBootstrapCredentials() {
        const apiKey = process.env.TWENTY_BOOTSTRAP_API_KEY || process.env.TWENTY_SERVER_ADMIN_KEY || '';
        const baseUrl = process.env.TWENTY_BASE_URL || process.env.TWENTY_SERVER_URL || 'http://127.0.0.1:3000';
        return {
            apiKey: apiKey.trim(),
            baseUrl: normalizeBaseUrl(baseUrl),
        };
    }

    _buildWorkspaceUrl(subdomain, baseUrl) {
        try {
            const parsed = new URL(baseUrl);
            if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
                return baseUrl;
            }
            const hostParts = parsed.hostname.split('.');
            if (hostParts.length >= 2) {
                if (hostParts[0] === 'app') {
                    hostParts[0] = subdomain;
                } else if (hostParts[0] !== subdomain) {
                    hostParts.unshift(subdomain);
                }
                parsed.hostname = hostParts.join('.');
            }
            return parsed.toString().replace(/\/$/, '');
        } catch (_) {
            return baseUrl;
        }
    }

    async findExistingWorkspace(slug, workspaceId, bootstrap) {
        if (this.apiAdapter?.findWorkspace) {
            return this.apiAdapter.findWorkspace({ slug, workspaceId });
        }

        throw nativeAdapterRequired();
    }

    async createWorkspace({ name, slug, ownerEmail, bootstrap }) {
        if (this.apiAdapter?.createWorkspace) {
            return this.apiAdapter.createWorkspace({ name, slug, ownerEmail });
        }

        throw nativeAdapterRequired();
    }

    async configureMembership({ workspaceId, ownerEmail, bootstrap }) {
        if (this.apiAdapter?.configureMembership) {
            return this.apiAdapter.configureMembership({ workspaceId, ownerEmail });
        }
        throw nativeAdapterRequired();
    }

    async issueWorkspaceApiKey({ workspaceId, businessId, bootstrap }) {
        if (this.apiAdapter?.issueWorkspaceApiKey) {
            return this.apiAdapter.issueWorkspaceApiKey({ workspaceId, businessId });
        }

        throw nativeAdapterRequired();
    }

    async applySchemaManifest(workspaceUrl, apiKey, manifest = null) {
        manifest = manifest || this.loadManifest();

        if (this.apiAdapter?.applySchemaManifest) {
            return this.apiAdapter.applySchemaManifest(workspaceUrl, apiKey, manifest);
        }

        const client = this.clientFactory({
            baseUrl: workspaceUrl,
            apiKey,
            timeoutMs: 15000,
        });
        const request = client.request.bind(client);
        client.request = async (...args) => {
            this.assertLease?.();
            const response = await request(...args);
            this.assertLease?.();
            return response;
        };

        // 1. Inspect existing metadata objects
        const existingObjects = await listMetadata(client, 'objects');
        const objectMap = new Map();
        for (const obj of existingObjects) {
            if (obj.namePlural) objectMap.set(obj.namePlural, obj);
        }

        let objectsCreated = 0;
        let fieldsCreated = 0;
        let fieldsVerified = 0;

        // 2. Ensure custom objects exist
        for (const customObj of manifest.custom_objects || []) {
            let metadata = objectMap.get(customObj.namePlural);
            if (!metadata) {
                try {
                    const created = await client.request('POST', '/rest/metadata/objects', {
                        retries: 0,
                        data: {
                            nameSingular: customObj.nameSingular,
                            namePlural: customObj.namePlural,
                            labelSingular: customObj.labelSingular,
                            labelPlural: customObj.labelPlural,
                            description: `Безопасная tenant-scoped проекция AVA: ${customObj.labelPlural}`,
                            icon: 'IconHotelService',
                        },
                    });
                    metadata = createdMetadata(created, 'Object');
                    if (!metadata?.id || metadata.namePlural !== customObj.namePlural) throw new Error('Native object ID missing');
                    objectsCreated += 1;
                } catch (e) {
                    if (e.statusCode !== 409 && e.status !== 409) throw e;
                    const objects = await listMetadata(client, 'objects');
                    metadata = objects.find(obj => obj.namePlural === customObj.namePlural);
                    if (!metadata?.id) throw e;
                }
                objectMap.set(customObj.namePlural, metadata);
            }
        }

        // 3. Inspect existing fields
        const existingFields = await listMetadata(client, 'fields');
        const fieldsByObject = new Map();
        for (const f of existingFields) {
            const objId = String(f.objectMetadataId || '');
            if (!fieldsByObject.has(objId)) fieldsByObject.set(objId, new Map());
            fieldsByObject.get(objId).set(f.name, f);
        }

        // 4. Plan and apply fields
        const definitions = manifest.field_definitions || {};
        const fieldPlan = [];

        for (const [objName, fieldNames] of Object.entries(manifest.standard_object_fields || {})) {
            for (const name of fieldNames) {
                fieldPlan.push({ objectName: objName, fieldName: name });
            }
        }
        for (const customObj of manifest.custom_objects || []) {
            for (const name of customObj.fields || []) {
                fieldPlan.push({ objectName: customObj.namePlural, fieldName: name });
            }
        }

        for (const item of fieldPlan) {
            const objMeta = objectMap.get(item.objectName);
            if (!objMeta?.id) throw Object.assign(new Error(`Native metadata object ${item.objectName} is missing`),
                { code: 'TWENTY_SCHEMA_OBJECT_MISSING', retryable: false });
            const definition = definitions[item.fieldName];
            if (!definition) continue;

            const currentObjFields = fieldsByObject.get(String(objMeta.id));
            const existingField = currentObjFields?.get(item.fieldName);

            if (existingField) {
                const existingType = String(existingField.type || '').toUpperCase();
                const expectedType = String(definition.type || '').toUpperCase();
                if (existingType !== expectedType) {
                    const typeError = new Error(`Type mismatch for ${item.objectName}.${item.fieldName}: ${existingType} != ${expectedType}`);
                    typeError.code = 'TWENTY_SCHEMA_TYPE_MISMATCH';
                    throw typeError;
                }
                fieldsVerified += 1;
                continue;
            }

            try {
                await client.request('POST', '/rest/metadata/fields', {
                    retries: 0,
                    data: {
                        type: definition.type,
                        objectMetadataId: objMeta.id,
                        name: item.fieldName,
                        label: definition.label,
                        description: 'Синхронизируется из AVA; tenant scope проверяется на стороне AVA.',
                        isNullable: true,
                    },
                });
                fieldsCreated += 1;
            } catch (fieldErr) {
                if (fieldErr?.statusCode === 409 || fieldErr?.status === 409) {
                    const fields = await listMetadata(client, 'fields');
                    const verified = fields.find(field => String(field.objectMetadataId) === String(objMeta.id) && field.name === item.fieldName);
                    if (!verified || String(verified.type).toUpperCase() !== String(definition.type).toUpperCase()) {
                        throw Object.assign(new Error(`Schema conflict for ${item.objectName}.${item.fieldName}`),
                            { code: 'TWENTY_SCHEMA_TYPE_MISMATCH', retryable: false });
                    }
                    fieldsVerified += 1;
                } else {
                    const schemaError = new Error(`Failed to create schema field ${item.objectName}.${item.fieldName}: ${fieldErr.message || 'Metadata API error'}`);
                    schemaError.code = 'TWENTY_SCHEMA_APPLICATION_FAILED';
                    schemaError.retryable = true;
                    throw schemaError;
                }
            }
        }

        // A successful POST is not evidence that every requested field exists.
        const verifiedFields = await listMetadata(client, 'fields');
        for (const item of fieldPlan) {
            const definition = definitions[item.fieldName];
            if (!definition) continue;
            const field = verifiedFields.find(value => value.name === item.fieldName
                && String(value.objectMetadataId) === String(objectMap.get(item.objectName)?.id));
            if (!field || String(field.type).toUpperCase() !== String(definition.type).toUpperCase()) {
                throw Object.assign(new Error(`Schema readback failed for ${item.objectName}.${item.fieldName}`),
                    { code: 'TWENTY_SCHEMA_NOT_VERIFIED', retryable: true });
            }
        }

        return {
            objectsCreated,
            fieldsCreated,
            fieldsVerified,
        };
    }

    async provisionWorkspace(businessId, instance, checkpoint = {}, options = {}) {
        if (!this.apiAdapter) {
            // A fresh adapter per job keeps owner sessions out of the singleton
            // and out of other businesses. Close every session on all exits.
            const adapter = new TwentyNativeProvisioning();
            const provisioner = new TwentyProvisionerService({ apiAdapter: adapter,
                clientFactory: this.clientFactory, manifestPath: this.manifestPath });
            try { return await provisioner.provisionWorkspace(businessId, instance, checkpoint, options); }
            finally { await adapter.close(); }
        }
        businessId = Number(businessId);
        if (Number(instance.id) !== businessId || !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [businessId])) {
            throw Object.assign(new Error('Business scope mismatch'), { code: 'TWENTY_BUSINESS_SCOPE_REQUIRED', retryable: false });
        }
        checkpoint = safeCheckpoint(checkpoint);
        let expectedRevision = TwentyStore.getIntegrationUnsafe(businessId)?.revision ?? null;
        const save = updates => {
            const current = TwentyStore.getIntegrationUnsafe(businessId);
            if ((current?.revision ?? null) !== expectedRevision || !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [businessId])) {
                throw Object.assign(new Error('Business or CRM configuration changed'), { code: 'TWENTY_CONFIGURATION_CHANGED', retryable: false });
            }
            checkpoint = safeCheckpoint({ ...checkpoint, ...updates });
            options.onCheckpoint?.(checkpoint);
            if (this.apiAdapter instanceof TwentyNativeProvisioning) this.apiAdapter.checkpoint = checkpoint;
        };
        const ownWrite = fn => {
            save({});
            const result = fn();
            expectedRevision = TwentyStore.getIntegrationUnsafe(businessId)?.revision ?? null;
            return result;
        };
        if (this.apiAdapter instanceof TwentyNativeProvisioning) {
            this.apiAdapter.checkpoint = checkpoint;
            this.apiAdapter.onCheckpoint = save;
            this.apiAdapter.assertLease = () => save({});
        }
        this.assertLease = () => save({});
        // Fail before allocating any remote resource when encryption is absent.
        encryptJson({ preflight: true }, context(businessId));
        const bootstrap = this._getBootstrapCredentials();
        const slug = checkpoint.slug || this.generateSlug(instance.name, businessId);
        const previous = TwentyStore.getIntegrationUnsafe(businessId);
        // Never relink an existing live installation as a side effect of retry.
        if (previous?.mode === 'live') {
            throw Object.assign(new Error('Existing live CRM requires explicit operator verification'),
                { code: 'TWENTY_LIVE_LINK_REQUIRES_REVIEW', retryable: false });
        }
        try {
            if (this.apiAdapter instanceof TwentyNativeProvisioning) {
                save({ slug });
                await require('../provisioning/workspace-route-client').ensureWorkspaceRoute(businessId, slug);
                save({ httpsRouteVerified: true });
            }
            // Native reconciliation is mandatory even when the create response
            // was lost before workspaceId could be checkpointed.
            let workspace = await this.findExistingWorkspace(slug, checkpoint.workspaceId || previous?.workspaceId, bootstrap);
            if (!workspace) {
                if (checkpoint.workspaceId || previous?.workspaceId || checkpoint.createRequested) {
                    throw Object.assign(new Error('Результат создания CRM пока не подтвержден; повторное создание запрещено'),
                        { code: 'TWENTY_CREATE_RECONCILIATION_REQUIRED', retryable: true });
                }
                if (!this.apiAdapter?.countWorkspaces) throw nativeAdapterRequired();
                this.checkWorkspaceCapacity(await this.apiAdapter.countWorkspaces(), Boolean(process.env.TWENTY_ENTERPRISE_KEY));
                // Persist the intent BEFORE the non-idempotent external call.
                save({ slug, createRequested: true });
                workspace = await this.createWorkspace({ name: instance.name, slug, ownerEmail: instance.ownerEmail, bootstrap });
            }
            if (!workspace?.id || workspace.subdomain !== slug || workspace.activationStatus !== 'ACTIVE'
                || (checkpoint.workspaceId && workspace.id !== checkpoint.workspaceId)
                || (previous?.workspaceId && workspace.id !== previous.workspaceId)) {
                throw Object.assign(new Error('Native workspace identity or activation not verified'),
                    { code: 'TWENTY_WORKSPACE_NOT_VERIFIED', retryable: false });
            }
            const workspaceId = workspace.id;
            const workspaceUrl = normalizeBaseUrl(workspace.workspaceUrl || workspace.baseUrl || this._buildWorkspaceUrl(slug, bootstrap.baseUrl));
            DB.db.transaction(() => {
                // Fences the entire local update against a stale worker.
                save({ workspaceId, slug, workspaceUrl, workspaceCreated: true });
                ownWrite(() => TwentyStore.upsertIntegration(businessId, { workspaceId, baseUrl: workspaceUrl, mode: 'shadow', enabled: Boolean(previous?.enabled), connectionStatus: 'staged' }));
            }).immediate();

            const membership = await this.configureMembership({ workspaceId, ownerEmail: instance.ownerEmail, bootstrap });
            if (membership?.configured !== true) throw Object.assign(new Error('Native membership not verified'),
                { code: 'TWENTY_MEMBERSHIP_NOT_VERIFIED', retryable: false });
            let link = TwentyStore.getIntegrationUnsafe(businessId);
            let apiKey = link?.apiKeyEncrypted ? decryptJson(link.apiKeyEncrypted, context(businessId)).apiKey : null;
            if (!apiKey) {
                save({ membershipConfigured: true });
                const issued = await this.issueWorkspaceApiKey({ workspaceId, businessId, bootstrap });
                apiKey = issued?.apiKey;
                if (!apiKey || apiKey === bootstrap.apiKey) throw Object.assign(new Error('Dedicated native runtime key required'),
                    { code: 'TWENTY_RUNTIME_KEY_INVALID', retryable: false });
                // Encryption and checkpoint commit together, never store the
                // raw key in checkpointJson, errors or callback payloads.
                DB.db.transaction(() => {
                    save({ apiKeyIssued: true, credentialRef: 'twenty_workspace_links' });
                    ownWrite(() => TwentyStore.updateStatus(businessId, { apiKeyEncrypted: encryptJson({ apiKey }, context(businessId)), enabled: false }));
                }).immediate();
            }
            const schemaResult = await this.applySchemaManifest(workspaceUrl, apiKey);
            save({ schemaApplied: true, schemaStats: schemaResult });
            const testOk = this.apiAdapter?.testConnection
                ? await this.apiAdapter.testConnection(workspaceUrl, apiKey)
                : await this.clientFactory({ baseUrl: workspaceUrl, apiKey }).testConnection(crypto.randomUUID());
            if (!testOk) throw Object.assign(new Error('Twenty workspace connection test failed'),
                { code: 'TWENTY_CONNECTION_FAILED', retryable: true });

            const publicUrl = process.env.AVA_PUBLIC_BASE_URL || process.env.WHATSAPP_CRM_PUBLIC_URL;
            if (!publicUrl || !/^https:\/\//i.test(publicUrl)) {
                throw Object.assign(new Error('Configure the public HTTPS URL for CRM webhooks'),
                    { code: 'TWENTY_PUBLIC_URL_REQUIRED', retryable: false });
            }
            const webhook = ownWrite(() => TwentyService.connectWebhook(businessId, publicUrl));
            let webhookVerified = false;
            if (this.apiAdapter?.configureWebhook) {
                const result = await this.apiAdapter.configureWebhook({ workspaceId, workspaceUrl, apiKey, webhook,
                    secret: decryptJson(TwentyStore.getIntegrationUnsafe(businessId).webhookSecretEncrypted, context(businessId, 'webhookSecretEncrypted')).secret });
                webhookVerified = result?.verified === true;
            }
            save({ webhookConfigured: webhookVerified, webhookManualSetupRequired: !webhookVerified });
            DB.db.transaction(() => {
                ownWrite(() => TwentyStore.updateStatus(businessId, { enabled: true, connectionStatus: 'staged', mode: 'shadow' }));
                if (!checkpoint.initialSyncQueued) {
                    if (this.apiAdapter instanceof TwentyNativeProvisioning && checkpoint.createRequested) TwentyStore.queueBootstrapSync(businessId);
                    else TwentyStore.enqueueInitialSync(businessId);
                    save({ initialSyncQueued: true });
                } else save({});
            }).immediate();
            const initialSyncVerified = TwentyStore.bootstrapVerification(businessId);
            const customerAccessVerified = membership.customerAccessVerified === true;
            const webhookDeliveryVerified = Boolean(TwentyStore.getIntegrationUnsafe(businessId).lastWebhookAt);
            const complete = webhookVerified && webhookDeliveryVerified && initialSyncVerified && customerAccessVerified;
            const status = complete ? 'DONE' : 'SKIPPED';
            const connectionStatus = complete ? 'connected' : 'staged';
            DB.db.transaction(() => {
                save({ workspaceLinked: true, connectionStatus, initialSyncVerified,
                    customerAccessVerified, mode: 'shadow' });
                save({ webhookDeliveryVerified });
                ownWrite(() => TwentyStore.updateStatus(businessId, { connectionStatus, lastSuccessAt: new Date().toISOString() }));
            }).immediate();
            return {
                status, stage: complete ? 'ready' : 'requires_verification', workspaceId, workspaceUrl, slug,
                checkpoint,
                userNextStep: complete ? 'CRM проверена в режиме shadow'
                    : !customerAccessVerified ? 'Служебный доступ CRM создан; отдельно подключите аккаунт владельца бизнеса'
                        : !webhookVerified ? 'Подтвердите webhook в CRM; начальная синхронизация выполняется отдельно'
                        : !webhookDeliveryVerified ? 'Проверьте доставку подписанного события из CRM'
                            : 'CRM в режиме shadow: подтвердите включение синхронизации и проверьте перенос данных',
            };
        } catch (error) {
            error.checkpoint = safeCheckpoint(checkpoint);
            throw error;
        }
    }
}

module.exports = new TwentyProvisionerService();
module.exports.TwentyProvisionerService = TwentyProvisionerService;
module.exports.normalizeSlug = normalizeSlug;
module.exports.MAX_WORKSPACES_WITHOUT_ENTERPRISE_KEY = MAX_WORKSPACES_WITHOUT_ENTERPRISE_KEY;
