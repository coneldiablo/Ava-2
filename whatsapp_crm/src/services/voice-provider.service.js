// Voice-call providers are independent from CRM text-chat providers.
const VOICE_AI_PROVIDERS = new Set(['google_live', 'openai_realtime', 'yandex_realtime', 'deepgram', 'local', 'neuro_gemini']);
function normalizeVoiceProvider(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !VOICE_AI_PROVIDERS.has(value.trim())) {
        throw Object.assign(new Error('Unsupported voice AI provider'), { statusCode: 400, code: 'INVALID_VOICE_AI_PROVIDER' });
    }
    return value.trim();
}
module.exports = { VOICE_AI_PROVIDERS, normalizeVoiceProvider };
