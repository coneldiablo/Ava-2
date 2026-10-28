'use strict';
const { VOICE_AI_PROVIDERS, normalizeVoiceProvider } = require('./voice-provider.service');
const Options = () => require('./voice-options.service');
const Waiting = require('./voice-waiting.service');
const has = (value, key) => Object.hasOwn(value, key);
function error(code, statusCode = 400) {
    return Object.assign(new Error(code), { code, statusCode });
}
function selection(value) {
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 160 || !value.trim()) throw error('INVALID_VOICE_SELECTION');
    return value.trim();
}
function normalizeAmbient(value) {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'enabled,preset,volume'
        || typeof value.enabled !== 'boolean' || value.preset !== 'office'
        || typeof value.volume !== 'number' || !Number.isFinite(value.volume)
        || value.volume < 0 || value.volume > 1) throw error('INVALID_VOICE_AMBIENT');
    return { enabled: value.enabled, preset: 'office', volume: value.volume };
}
function parseAmbient(value) {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch (_) { return null; } }
    try { return normalizeAmbient(value ?? null); } catch (_) { return null; }
}
function normalizeTone(value) {
    if (value === null) return null;
    if (typeof value !== 'string' || value.length > 500) throw error('INVALID_VOICE_TONE');
    return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim() || null;
}
function parseSettings(value) {
    let raw = value;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_) { raw = {}; } }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const result = {};
    for (const provider of VOICE_AI_PROVIDERS) {
        const saved = raw[provider];
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) continue;
        result[provider] = {
            model: typeof saved.model === 'string' && saved.model.length <= 160 ? saved.model : null,
            voiceName: typeof saved.voiceName === 'string' && saved.voiceName.length <= 160 ? saved.voiceName : null,
            ...(saved.progress ? { progress: Waiting.parse(saved.progress) } : {}),
        };
    }
    return result;
}
function configuredProvider() {
    const provider = Options().getDefaultProvider();
    return VOICE_AI_PROVIDERS.has(provider) ? provider : 'google_live';
}
function storedProvider(row = {}) {
    return row.voiceAiProvider || (VOICE_AI_PROVIDERS.has(row.aiProvider) ? row.aiProvider : null) || configuredProvider();
}
function defaults(provider) {
    if (!VOICE_AI_PROVIDERS.has(provider)) return { model: null, voiceName: null };
    const value = Options().getDefaults(provider) || {};
    return { model: value.model ?? value.defaultModel ?? null, voiceName: value.voiceName ?? value.defaultVoiceName ?? null };
}
function project(row = {}) {
    const provider = storedProvider(row);
    const voiceSettings = parseSettings(row.voiceSettings);
    const own = voiceSettings[provider] || {};
    const fallback = defaults(provider);
    const model = row.voiceModel || own.model || fallback.model;
    const voiceName = row.voiceName || own.voiceName || fallback.voiceName;
    // The map contains only selections, never provider credentials or arbitrary input.
    if (VOICE_AI_PROVIDERS.has(provider)) voiceSettings[provider] = { ...own, model, voiceName };
    return { voiceAiProvider: provider, voiceModel: model, voiceName, voiceSettings, voiceWaiting: Waiting.parse(own.progress), voiceAmbient: parseAmbient(row.voiceAmbient) };
}
function hasWrite(data = {}) {
    return ['voiceAiProvider', 'voiceModel', 'voiceName', 'voiceSettings', 'voiceAmbient', 'voiceWaiting', 'hotelTone'].some(key => has(data, key));
}
function planWrite(data = {}, row = {}, catalog) {
    if (has(data, 'voiceSettings')) throw error('VOICE_SETTINGS_READ_ONLY');
    if (!hasWrite(data)) return {};
    const ambient = {
        ...(has(data, 'voiceAmbient') ? { voiceAmbient: data.voiceAmbient === null ? null : JSON.stringify(normalizeAmbient(data.voiceAmbient)) } : {}),
        ...(has(data, 'hotelTone') ? { hotelTone: normalizeTone(data.hotelTone) } : {}),
    };
    if (!['voiceAiProvider', 'voiceModel', 'voiceName', 'voiceWaiting'].some(key => has(data, key))) return ambient;
    const before = project(row);
    if (has(data, 'voiceWaiting') && has(data, 'expectedVoiceProvider')
        && data.expectedVoiceProvider !== before.voiceAiProvider) throw error('VOICE_SETTINGS_CHANGED', 409);
    const provider = has(data, 'voiceAiProvider') ? normalizeVoiceProvider(data.voiceAiProvider) || configuredProvider() : before.voiceAiProvider;
    const voiceSettings = before.voiceSettings;
    const saved = provider === before.voiceAiProvider
        ? { ...voiceSettings[provider], model: before.voiceModel, voiceName: before.voiceName }
        : voiceSettings[provider] || defaults(provider);
    const fallback = defaults(provider);
    const model = has(data, 'voiceModel') ? selection(data.voiceModel) || fallback.model : saved.model;
    const voiceName = has(data, 'voiceName') ? selection(data.voiceName) || fallback.voiceName : saved.voiceName;
    const changed = !row.id || provider !== before.voiceAiProvider || model !== before.voiceModel || voiceName !== before.voiceName;
    if (changed) {
        if (!catalog) return { needsCatalog: true };
        const option = catalog.providers.find(item => item.id === provider);
        if (!option?.available) throw error('VOICE_PROVIDER_UNAVAILABLE', 503);
        if (model && !option.models.some(item => item.id === model)) throw error('INVALID_VOICE_MODEL');
        if (voiceName && !option.voices.some(item => item.id === voiceName)) throw error('INVALID_VOICE_NAME');
        if (option.models.length && !model) throw error('INVALID_VOICE_MODEL');
        if (option.voices.length && !voiceName) throw error('INVALID_VOICE_NAME');
    }
    voiceSettings[provider] = { model, voiceName,
        ...(has(data, 'voiceWaiting') ? { progress: Waiting.normalize(data.voiceWaiting) } : saved.progress ? { progress: saved.progress } : {}) };
    return { ...ambient, voiceAiProvider: provider, voiceModel: model, voiceName, voiceSettings: JSON.stringify(voiceSettings) };
}
async function prepareWrite(data, row = {}, options = {}) {
    const patch = planWrite(data, row);
    if (!patch.needsCatalog) return { patch, catalog: null };
    const catalog = await Options().getOptions({ signal: options.signal });
    return { patch: planWrite(data, row, catalog), catalog };
}
module.exports = { project, parseSettings, normalizeAmbient, parseAmbient, normalizeTone, planWrite, prepareWrite, hasWrite };
