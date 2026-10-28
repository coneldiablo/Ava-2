const DB = require('./database.service');
const PmsService = require('./pms/pms.service');

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const { VOICE_AI_PROVIDERS, normalizeVoiceProvider } = require('./voice-provider.service');
const DEFAULT_WORKING_HOURS = Object.freeze({
    mon: { enabled: true, start: '09:00', end: '18:00' },
    tue: { enabled: true, start: '09:00', end: '18:00' },
    wed: { enabled: true, start: '09:00', end: '18:00' },
    thu: { enabled: true, start: '09:00', end: '18:00' },
    fri: { enabled: true, start: '09:00', end: '18:00' },
    sat: { enabled: false, start: '09:00', end: '18:00' },
    sun: { enabled: false, start: '09:00', end: '18:00' },
});

function parseJson(value, fallback) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function httpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function normalizeTime(value, fieldName) {
    const text = String(value || '').trim();
    if (!/^\d{2}:\d{2}$/.test(text)) {
        throw httpError(400, `${fieldName} must use HH:MM format`);
    }
    const [hour, minute] = text.split(':').map(Number);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        throw httpError(400, `${fieldName} must be a valid 24h time`);
    }
    return text;
}

function normalizeTimezone(value) {
    const timezone = String(value || 'UTC').trim() || 'UTC';
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    } catch (_) {
        throw httpError(400, 'hotelTimezone must be a valid IANA timezone');
    }
    return timezone;
}

function normalizeWorkingHours(value) {
    const raw = parseJson(value, DEFAULT_WORKING_HOURS);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw httpError(400, 'hotelWorkingHours must be an object');
    }

    for (const key of Object.keys(raw)) {
        if (!DAY_KEYS.includes(key)) {
            throw httpError(400, `Unsupported working hours day: ${key}`);
        }
    }

    const normalized = {};
    for (const day of DAY_KEYS) {
        const source = raw[day] && typeof raw[day] === 'object'
            ? raw[day]
            : DEFAULT_WORKING_HOURS[day];
        normalized[day] = {
            enabled: source.enabled === undefined ? true : Boolean(source.enabled),
            start: normalizeTime(source.start || DEFAULT_WORKING_HOURS[day].start, `${day}.start`),
            end: normalizeTime(source.end || DEFAULT_WORKING_HOURS[day].end, `${day}.end`),
        };
    }
    return normalized;
}

function normalizeSipAliases(value) {
    const raw = Array.isArray(value)
        ? value
        : String(value || '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    const seen = new Set();
    const aliases = [];
    for (const item of raw) {
        const normalized = String(item || '').replace(/\D+/g, '');
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        aliases.push(normalized);
    }
    return aliases;
}

function toBooleanInt(value, fallback = 1) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return value ? 1 : 0;
    return ['1', 'true', 'yes', 'on', 'active'].includes(String(value).trim().toLowerCase()) ? 1 : 0;
}

function toPositiveInt(value, fallback) {
    const num = Number(value || fallback);
    if (!Number.isFinite(num) || num < 1) return fallback;
    return Math.floor(num);
}

function hotelName(value, required = false) {
    const name = String(value || '').trim();
    if (required && !name) throw httpError(400, 'name is required');
    return name;
}

function serializeOptionalString(value) {
    if (value === undefined) return undefined;
    const text = String(value || '').trim();
    return text || null;
}

class HotelProfileService {
    toProfile(instance) {
        if (!instance) return null;
        const instanceId = Number(instance.id);
        const knowledgeBaseInstanceId = toPositiveInt(instance.knowledgeBaseInstanceId, instanceId);
        const sipAliases = normalizeSipAliases(parseJson(instance.sipAliases, []));
        const voice = require('./voice-settings.service').project(instance);
        const postCallPolicy = require('./postcall-followup.service').policy(instance);
        const voiceAiProvider = voice.voiceAiProvider;
        return {
            id: instanceId,
            businessId: instanceId,
            business_id: instanceId,
            instanceId,
            instance_id: instanceId,
            businessType: instance.businessType || 'hotel',
            name: instance.name || '',
            isActive: Number(instance.isActive ?? 1) !== 0,
            greenApiInstance: instance.greenApiInstance || null,
            hotelTone: instance.hotelTone || '',
            hotelTimezone: instance.hotelTimezone || 'UTC',
            hotelWorkingHours: normalizeWorkingHours(instance.hotelWorkingHours),
            sipTrunkNumber: instance.sipTrunkNumber || '',
            sipCallerId: instance.sipCallerId || '',
            sipAliases,
            knowledgeBaseInstanceId,
            voiceContextName: instance.voiceContextName || 'unified_sales_agent',
            aiProvider: voiceAiProvider,
            ai_provider: voiceAiProvider,
            voiceAiProvider,
            crmAiProvider: instance.aiProvider || null,
            voiceModel: voice.voiceModel,
            voiceName: voice.voiceName,
            voiceSettings: voice.voiceSettings,
            voiceWaiting: voice.voiceWaiting,
            followupAutoSendEnabled: postCallPolicy.enabled,
            followupAutoSendRevision: postCallPolicy.revision,
            voiceAmbient: voice.voiceAmbient,
            voice: voice.voiceName,
            voiceGreetingTemplate: instance.voiceGreetingTemplate || '',
            outboundOpenerTemplate: instance.outboundOpenerTemplate || '',
            systemPrompt: instance.systemPrompt || '',
            pms: PmsService.get(instanceId),
            createdAt: instance.createdAt,
            updatedAt: instance.updatedAt,
        };
    }

    async list() {
        // `instances` is the canonical business registry for both AVA and the CRM.
        // Older CRM versions created hotel customers as `standard`, so keep them
        // visible here instead of forcing an operator to create a duplicate hotel.
        const rows = DB.all(
            "SELECT * FROM instances WHERE businessType IN ('hotel', 'standard') ORDER BY id ASC"
        );
        return rows.map((row) => this.toProfile(row));
    }

    async get(instanceId) {
        const row = await DB.getInstance(instanceId);
        if (!row || !['hotel', 'standard', 'coffee_shop'].includes(row.businessType)) return null;
        return this.toProfile(row);
    }

    async create(data = {}, options = {}) {
        const BusinessProvisioningService = require('./provisioning/business-provisioning.service');
        const idempotencyKey = options.idempotencyKey || data.idempotencyKey || null;
        const result = await BusinessProvisioningService.createBusiness(data, {
            idempotencyKey,
            autoProcess: options.autoProcess,
            syncProcess: options.syncProcess,
            ownerUserId: options.ownerUserId,
            beforeWrite: options.beforeWrite,
        });
        const profile = this.toProfile(result.instance);
        if (result.provisioning) {
            profile.provisioning = result.provisioning;
        }
        profile.isExisting = result.isExisting;
        return profile;
    }

    async update(instanceId, data = {}, options = {}) {
        const current = await DB.getInstance(instanceId);
        if (!current || !['hotel', 'standard', 'coffee_shop'].includes(current.businessType)) {
            throw httpError(404, 'hotel profile not found');
        }

        const normalized = this._normalizePatch(data, { current });
        const aliases = parseJson(
            normalized.sipAliases !== undefined ? normalized.sipAliases : current.sipAliases,
            [],
        );
        await this._assertAliasesAvailable(aliases, Number(instanceId));

        const updated = await DB.updateInstance(instanceId, normalized, options);
        if (normalized.sipAliases !== undefined) {
            const BusinessProvisioningService = require('./provisioning/business-provisioning.service');
            await BusinessProvisioningService.updateSipAliases(instanceId, aliases);
        }
        return this.toProfile(updated || await DB.getInstance(instanceId));
    }

    async findBySipAlias(alias) {
        const normalized = normalizeSipAliases([alias])[0];
        if (!normalized) return null;
        for (const profile of await this.list()) {
            if (!profile.isActive) continue;
            if ((profile.sipAliases || []).includes(normalized)) {
                return profile;
            }
        }
        return null;
    }

    _normalizePatch(data = {}, options = {}) {
        const current = options.current || {};
        const patch = {};
        // Retain the legacy standard-to-hotel upgrade on business edits without
        // copying unrelated values into an awaited voice-only save.
        if (current.businessType === 'standard' && ['name', 'hotelTimezone', 'timezone', 'hotelWorkingHours', 'workingHours'].some(key => Object.hasOwn(data, key))) patch.businessType = 'hotel';
        if (data.salesGoal !== undefined) patch.salesGoal = data.salesGoal || current.salesGoal || 'call';

        if (data.name !== undefined || options.requireName) {
            patch.name = hotelName(data.name, options.requireName);
        }
        if (data.isActive !== undefined) {
            patch.isActive = toBooleanInt(data.isActive, Number(current.isActive ?? 1));
        }

        if (Object.hasOwn(data, 'hotelTimezone') || Object.hasOwn(data, 'timezone')) {
            patch.hotelTimezone = normalizeTimezone(data.hotelTimezone ?? data.timezone ?? current.hotelTimezone ?? 'UTC');
        }

        if (Object.hasOwn(data, 'hotelWorkingHours') || Object.hasOwn(data, 'workingHours')) {
            patch.hotelWorkingHours = JSON.stringify(normalizeWorkingHours(data.hotelWorkingHours ?? data.workingHours ?? current.hotelWorkingHours));
        }

        if (Object.hasOwn(data, 'sipAliases') || Object.hasOwn(data, 'sip_aliases')) {
            patch.sipAliases = JSON.stringify(normalizeSipAliases(data.sipAliases ?? data.sip_aliases ?? current.sipAliases ?? []));
        }

        const knowledgeBaseInstanceId = data.knowledgeBaseInstanceId
            ?? data.knowledge_base_instance_id
            ?? current.knowledgeBaseInstanceId
            ?? current.id;
        const scope = toPositiveInt(knowledgeBaseInstanceId, Number(current.id || 1));
        if (current.id && scope !== Number(current.id)) {
            throw Object.assign(httpError(400, 'Knowledge scope must match the selected business'), { code: 'ONYX_KNOWLEDGE_SCOPE_MISMATCH' });
        }
        if (Object.hasOwn(data, 'knowledgeBaseInstanceId') || Object.hasOwn(data, 'knowledge_base_instance_id')) patch.knowledgeBaseInstanceId = scope;

        const stringFields = [
            'sipTrunkNumber',
            'sipCallerId',
            'voiceGreetingTemplate',
            'outboundOpenerTemplate',
        ];
        if (data.hotelTone !== undefined) {
            patch.hotelTone = require('./voice-settings.service').normalizeTone(data.hotelTone);
        }
        for (const field of stringFields) {
            if (data[field] !== undefined) {
                patch[field] = serializeOptionalString(data[field]);
            }
        }

        if (data.systemPrompt !== undefined) {
            if (typeof data.systemPrompt !== 'string' || data.systemPrompt.length > 8000) {
                throw httpError(400, 'systemPrompt must be text up to 8000 characters');
            }
            patch.systemPrompt = serializeOptionalString(data.systemPrompt);
        }

        if (Object.hasOwn(data, 'voiceContextName') || Object.hasOwn(data, 'voice_context_name')) {
            patch.voiceContextName = String(data.voiceContextName ?? data.voice_context_name ?? 'unified_sales_agent').trim() || 'unified_sales_agent';
        }

        for (const field of ['voiceAiProvider', 'voiceModel', 'voiceName', 'voiceSettings', 'voiceAmbient', 'voiceWaiting', 'expectedVoiceProvider', 'followupAutoSendEnabled', 'expectedFollowupRevision']) {
            if (Object.hasOwn(data, field)) patch[field] = data[field];
        }
        if (!Object.hasOwn(data, 'voiceAiProvider') && (Object.hasOwn(data, 'aiProvider') || Object.hasOwn(data, 'ai_provider'))) {
            patch.voiceAiProvider = normalizeVoiceProvider(data.aiProvider ?? data.ai_provider);
        }
        if (!Object.hasOwn(data, 'voiceName') && Object.hasOwn(data, 'voice')) patch.voiceName = data.voice;

        return patch;
    }

    async _assertAliasesAvailable(aliases = [], currentId = null) {
        if (!aliases.length) return;
        for (const alias of aliases) {
            const conflict = DB.get(`
                SELECT s.businessId, i.isActive
                FROM business_sip_aliases s
                JOIN instances i ON i.id = s.businessId
                WHERE s.alias = ? AND (? IS NULL OR s.businessId != ?) AND i.isActive = 1
            `, [alias, currentId, currentId]);
            if (conflict) {
                throw httpError(409, `sip alias ${alias} already belongs to hotel profile ${conflict.businessId}`);
            }
        }
    }

    async getProvisioningStatus(instanceId) {
        const BusinessProvisioningService = require('./provisioning/business-provisioning.service');
        return BusinessProvisioningService.getProvisioningStatus(instanceId);
    }

    async retryProvisioning(instanceId, options = {}) {
        const BusinessProvisioningService = require('./provisioning/business-provisioning.service');
        return BusinessProvisioningService.retryProvisioning(instanceId, options);
    }
}

module.exports = new HotelProfileService();
module.exports._internals = {
    DAY_KEYS,
    DEFAULT_WORKING_HOURS,
    normalizeSipAliases,
    normalizeTimezone,
    normalizeWorkingHours,
};
