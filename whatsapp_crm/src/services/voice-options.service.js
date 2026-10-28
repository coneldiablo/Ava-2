const fs = require('node:fs');
const path = require('node:path');

const PROVIDERS = ['google_live', 'openai_realtime', 'yandex_realtime', 'deepgram', 'local', 'neuro_gemini'];
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash'];
const PREVIEW_TEXT = 'Здравствуйте! Я ассистент AVA.';
const DEFAULTS = {
    google_live: { model: 'gemini-live-2.5-flash-native-audio', voiceName: 'Aoede' },
    openai_realtime: { model: 'gpt-realtime-2', voiceName: 'alloy' },
    yandex_realtime: { model: 'speech-realtime-max-tts-live/latest', voiceName: 'sofia' },
    deepgram: { model: 'nova-2', voiceName: 'aura-2-thalia-en' },
    local: { model: 'models/llm/phi-3-mini-4k-instruct.Q4_K_M.gguf', voiceName: 'af_heart' },
    neuro_gemini: { model: 'gemini-3.8-flash', voiceName: 'edsel' },
};
const LABELS = { google_live: 'Google Gemini Live', openai_realtime: 'OpenAI Realtime',
    yandex_realtime: 'Yandex Realtime', deepgram: 'Deepgram', local: 'Local AI', neuro_gemini: 'Neuro + Gemini' };
const YANDEX_ROLES = { sofia: ['casual', 'support'], vera: ['casual', 'support'],
    vasily: ['support', 'sales'], sergey: ['support', 'sales'], denis: ['casual', 'formal', 'neutral', 'sales'],
    irina: ['formal', 'support', 'narrator', 'sales', 'neutral'] };
const CATALOG_FIELDS = new Set(['enabled', 'credentials_configured', 'llm_model', 'model', 'voice', 'voice_name', 'tts_voice_name', 'tts_model',
    'tts_voice', 'kokoro_voice', 'role', 'use_vertex_ai', 'vertex_project', 'project_id']);
const text = value => typeof value === 'string' ? value.trim() : '';
const first = (...values) => values.map(text).find(Boolean) || '';
const enabled = value => value === true || value === 'true' || value === '1';
const error = (code, statusCode, message) => Object.assign(new Error(message), { code, statusCode });
const unavailable = () => error('VOICE_PROVIDER_UNAVAILABLE', 503, 'Voice provider is unavailable');
const aborted = () => error('VOICE_REQUEST_CANCELLED', 499, 'Voice request was cancelled');
const checkSignal = signal => { if (signal?.aborted) throw aborted(); };
const choices = ids => [...new Set(ids.filter(Boolean))].map(id => ({ id, label: id }));

function wrapPreviewPcm(pcm, sampleRate = 24000) {
    const invalid = () => error('VOICE_UPSTREAM_INVALID_RESPONSE', 502, 'Voice provider returned invalid audio');
    if (!pcm.length || pcm.length % 2) throw invalid();
    // Do not mistake a provider error or a WAV container for the requested raw PCM.
    if (pcm.length >= 12 && pcm.toString('ascii', 0, 4) === 'RIFF' && pcm.toString('ascii', 8, 12) === 'WAVE') throw invalid();
    const possibleJson = pcm.toString('utf8').trimStart();
    if (possibleJson.startsWith('{') || possibleJson.startsWith('[')) {
        let isJson = false;
        try { JSON.parse(possibleJson); isJson = true; } catch { /* Raw PCM can have any byte prefix. */ }
        if (isJson) throw invalid();
    }
    const audio = Buffer.alloc(44 + pcm.length);
    audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVE', 8);
    audio.write('fmt ', 12); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20);
    audio.writeUInt16LE(1, 22); audio.writeUInt32LE(sampleRate, 24); audio.writeUInt32LE(sampleRate * 2, 28);
    audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(pcm.length, 40);
    pcm.copy(audio, 44);
    return audio;
}

function scalar(raw, env) {
    let value = raw.trim().replace(/\s+#.*$/, '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    value = value.replace(/\$\{([A-Z][A-Z0-9_]*)(?::[-=]([^}]*))?\}/g, (_, key, fallback) => first(env[key], fallback));
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null' || value === '~') return null;
    // Only simple scalar fields are consumed; never interpret arbitrary YAML tags/objects.
    return /^[\w./:\- ]{1,240}$/.test(value) ? value : '';
}

function readConfig(file, env) {
    const result = { providers: {}, ambient_audio: {} };
    let source;
    try { source = fs.readFileSync(file, 'utf8'); } catch { return result; }
    let inProviders = false;
    let provider = null;
    let inAmbient = false;
    let ambientIds = false;
    for (const line of source.split(/\r?\n/)) {
        if (/^ambient_audio:\s*(?:#.*)?$/.test(line)) { inAmbient = true; continue; }
        if (inAmbient && /^\S/.test(line) && !line.startsWith('#')) inAmbient = false;
        if (inAmbient) {
            if (/^  business_ids:\s*(?:#.*)?$/.test(line)) { ambientIds = true; result.ambient_audio.business_ids = []; continue; }
            const sequenceId = /^\s{2,4}-\s+(\d+)\s*(?:#.*)?$/.exec(line);
            if (ambientIds && sequenceId) {
                const id = Number(sequenceId[1]);
                if (Number.isSafeInteger(id) && id > 0) result.ambient_audio.business_ids.push(id);
                continue;
            }
            if (/^\s*\w/.test(line)) ambientIds = false;
            const field = /^  (enabled|volume):\s*(.*)$/.exec(line);
            if (field) result.ambient_audio[field[1]] = scalar(field[2], env);
            const ids = /^  business_ids:\s*\[([\d,\s]*)\]\s*(?:#.*)?$/.exec(line);
            if (ids) result.ambient_audio.business_ids = ids[1].split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
            continue;
        }
        if (/^default_provider:\s*/.test(line)) result.default_provider = scalar(line.slice(line.indexOf(':') + 1), env);
        if (/^providers:\s*(?:#.*)?$/.test(line)) { inProviders = true; continue; }
        if (inProviders && /^\S/.test(line) && !line.startsWith('#')) { inProviders = false; provider = null; }
        if (!inProviders) continue;
        const block = /^  ([a-z_]+):\s*(?:#.*)?$/.exec(line);
        if (block) { provider = PROVIDERS.includes(block[1]) ? block[1] : null; if (provider) result.providers[provider] = {}; continue; }
        const field = /^    ([a-z_]+):\s*(.*)$/.exec(line);
        if (provider && field && CATALOG_FIELDS.has(field[1])) result.providers[provider][field[1]] = scalar(field[2], env);
    }
    return result;
}

function loadConfig(env) {
    const file = first(env.AVA_VOICE_CONFIG_PATH) || path.resolve(__dirname, '../../../config/ai-agent.yaml');
    const config = readConfig(file, env);
    // Match the runtime's additive local provider override without executing Python or exposing credentials.
    const override = readConfig(file.replace(/(\.ya?ml)$/, '.local$1'), env);
    for (const [id, block] of Object.entries(override.providers)) {
        config.providers[id] = { ...config.providers[id], ...block };
        for (const [key, value] of Object.entries(config.providers[id])) if (value === null) delete config.providers[id][key];
    }
    if (override.default_provider) config.default_provider = override.default_provider;
    config.ambient_audio = { ...config.ambient_audio, ...override.ambient_audio };
    return config;
}

function createVoiceOptionsService({ env = process.env, fetchImpl = globalThis.fetch, engineConfig,
    now = Date.now, catalogTtlMs = 300000, catalogTimeoutMs = 5000, previewTimeoutMs = 10000,
    maxCatalogBytes = 131072, maxAudioBytes = 1048576 } = {}) {
    const config = engineConfig || loadConfig(env);
    let cachedCatalog = null;
    const previews = new Map();
    const ambientPaths = ['../../assets/audio/office-ambience.wav', '../../../assets/audio/office-ambience.wav'].map(file => path.resolve(__dirname, file));
    const ambientPath = first(env.AVA_VOICE_AMBIENT_PATH) || ambientPaths.find(file => fs.existsSync(file)) || ambientPaths[0];
    let ambientAsset = null;

    function ambientAvailable() {
        try { const stat = fs.statSync(ambientPath); return stat.isFile() && stat.size >= 364 && stat.size <= 8000 * 2 * 300 + 65536; }
        catch (_) { return false; }
    }

    function ambientOptions(profile = {}) {
        const override = require('./voice-settings.service').parseAmbient(profile.voiceAmbient);
        const legacy = config.ambient_audio || {};
        const rawVolume = Number(legacy.volume ?? 1);
        const volume = Number.isFinite(rawVolume) && rawVolume >= 0 && rawVolume <= 1 ? rawVolume : 1;
        const effective = override || { enabled: enabled(legacy.enabled) && (legacy.business_ids || []).includes(Number(profile.id || profile.businessId)), preset: 'office', volume };
        const available = ambientAvailable();
        return { available, presets: [{ id: 'office', label: 'Офис' }], defaultPreset: 'office', defaultVolume: 1,
            minVolume: 0, maxVolume: 1, previewAvailable: available, effective };
    }

    async function ambientPreview(input, { signal, beforeSynthesis } = {}) {
        checkSignal(signal);
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).sort().join(',') !== 'preset,volume') throw error('INVALID_VOICE_AMBIENT', 400, 'Invalid ambience');
        const setting = require('./voice-settings.service').normalizeAmbient({ enabled: true, ...input });
        if (beforeSynthesis) beforeSynthesis();
        if (!ambientAvailable()) throw error('VOICE_AMBIENT_UNAVAILABLE', 503, 'Ambience preview is unavailable');
        if (!ambientAsset) {
            const source = await fs.promises.readFile(ambientPath, { signal });
            if (source.toString('ascii', 0, 4) !== 'RIFF' || source.toString('ascii', 8, 12) !== 'WAVE') throw error('VOICE_AMBIENT_UNAVAILABLE', 503, 'Invalid ambience asset');
            let format, pcm;
            for (let offset = 12; offset + 8 <= source.length;) {
                const size = source.readUInt32LE(offset + 4), end = offset + 8 + size;
                if (end > source.length) throw error('VOICE_AMBIENT_UNAVAILABLE', 503, 'Invalid ambience asset');
                const type = source.toString('ascii', offset, offset + 4);
                if (type === 'fmt ') format = source.subarray(offset + 8, end);
                if (type === 'data') pcm = source.subarray(offset + 8, end);
                offset = end + (size % 2);
            }
            if (!format || format.length < 16 || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1
                || format.readUInt32LE(4) !== 8000 || format.readUInt16LE(14) !== 16
                || !pcm || pcm.length < 320 || pcm.length % 2 || pcm.length > 8000 * 2 * 300) throw error('VOICE_AMBIENT_UNAVAILABLE', 503, 'Invalid ambience asset');
            ambientAsset = Buffer.from(pcm);
        }
        checkSignal(signal);
        const pcm = Buffer.alloc(8000 * 2 * 4);
        for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(Math.trunc(ambientAsset.readInt16LE(offset % ambientAsset.length) * setting.volume), offset);
        return { audio: wrapPreviewPcm(pcm, 8000), contentType: 'audio/wav' };
    }

    function geminiModels() {
        const configured = text(env.NEURO_GEMINI_MODELS);
        return GEMINI_MODELS.filter(id => !configured || configured.split(',').map(text).includes(id));
    }

    function getDefaults(provider) {
        if (!PROVIDERS.includes(provider)) throw error('INVALID_VOICE_AI_PROVIDER', 400, 'Unsupported voice AI provider');
        const block = config.providers[provider] || {};
        if (provider === 'neuro_gemini') {
            const models = geminiModels();
            const preferred = first(block.model, DEFAULTS[provider].model);
            return { model: models.includes(preferred) ? preferred : models[0] || DEFAULTS[provider].model,
                voiceName: first(block.voice_name, DEFAULTS[provider].voiceName) };
        }
        return { model: first(block.llm_model, block.model, DEFAULTS[provider].model),
            voiceName: first(block.tts_voice_name, block.voice, block.kokoro_voice, block.tts_voice,
                provider === 'deepgram' ? block.tts_model : '', DEFAULTS[provider].voiceName) };
    }

    function getDefaultProvider() {
        const selected = first(env.AVA_VOICE_DEFAULT_PROVIDER, config.default_provider);
        return PROVIDERS.includes(selected) ? selected : 'google_live';
    }

    function neuroEndpoint() {
        try {
            const url = new URL(first(env.NEURO_API_ENDPOINT, 'https://speech.neuro.net'));
            if (url.protocol !== 'https:' || url.hostname !== 'speech.neuro.net' || url.username || url.password || url.search || url.hash) return null;
            return url.toString().replace(/\/+$/, '');
        } catch { return null; }
    }

    function ready(provider) {
        const block = config.providers[provider];
        if (provider === 'neuro_gemini') return !!block && enabled(block.enabled)
            && enabled(env.NEURO_GEMINI_ENABLED) && !!text(env.NEURO_API_KEY)
            && !!neuroEndpoint() && !!first(env.GEMINI_PROJECT_ID, env.GOOGLE_CLOUD_PROJECT)
            && first(env.GEMINI_LOCATION, 'global') === 'global' && geminiModels().length > 0;
        if (!block || block.enabled === false || block.enabled === 'false') return false;
        // A server-owned sanitized projection can attest runtime credentials without copying them into CRM.
        if (Object.hasOwn(block, 'credentials_configured')) return enabled(block.credentials_configured);
        if (provider === 'google_live') return !!text(env.GOOGLE_API_KEY)
            || (enabled(block.use_vertex_ai) && !!first(block.vertex_project, block.project_id, env.GOOGLE_CLOUD_PROJECT));
        if (provider === 'openai_realtime') return !!text(env.OPENAI_API_KEY);
        if (provider === 'yandex_realtime') return !!text(env.YANDEX_CLOUD_API_KEY) && !!text(env.YANDEX_CLOUD_FOLDER_ID);
        if (provider === 'deepgram') return !!text(env.DEEPGRAM_API_KEY);
        return provider === 'local';
    }

    function legacyProvider(id) {
        const defaults = getDefaults(id);
        let voices = [defaults.voiceName];
        if (id === 'google_live') voices = [defaults.voiceName, 'Aoede', 'Puck', 'Charon', 'Kore', 'Fenrir'];
        if (id === 'openai_realtime') voices = [defaults.voiceName, 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'];
        if (id === 'yandex_realtime') {
            const role = first(config.providers[id]?.role, 'support');
            voices = Object.keys(YANDEX_ROLES).filter(voice => YANDEX_ROLES[voice].includes(role));
        }
        const models = id === 'yandex_realtime' ? [
            { id: 'aliceai-llm-flash', label: 'Яндекс — быстрый диалог' },
            { id: 'speech-realtime-max-tts-live/latest', label: 'Яндекс Realtime Max' },
        ] : choices([defaults.model]);
        return { id, label: LABELS[id], available: ready(id), models, voices: choices(voices),
            defaultModel: defaults.model, defaultVoiceName: defaults.voiceName };
    }

    async function request(relative, { signal, timeoutMs, limit, method = 'GET', body, kind }) {
        checkSignal(signal);
        const controller = new AbortController();
        let timedOut = false;
        let response;
        let activeReader;
        let prefixComplete = false;
        const onAbort = () => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        let onInternalAbort;
        const interruption = new Promise((_, reject) => {
            onInternalAbort = () => {
                if (activeReader) Promise.resolve(activeReader.cancel()).catch(() => {});
                if (prefixComplete && !signal?.aborted && !timedOut) return;
                reject(timedOut ? error('VOICE_UPSTREAM_TIMEOUT', 504, 'Voice provider timed out') : aborted());
            };
            controller.signal.addEventListener('abort', onInternalAbort, { once: true });
        });
        const execute = async () => {
            response = await fetchImpl(`${neuroEndpoint()}${relative}`, {
                method, redirect: 'error', signal: controller.signal,
                headers: { 'xi-api-key': text(env.NEURO_API_KEY), Accept: kind === 'pcm' ? 'audio/pcm, application/octet-stream' : 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            if (controller.signal.aborted) {
                Promise.resolve(response.body?.cancel()).catch(() => {});
                throw aborted();
            }
            if (!response.ok) throw unavailable();
            const length = Number(response.headers.get('content-length'));
            if (kind !== 'pcm' && Number.isFinite(length) && length > limit) throw error('VOICE_UPSTREAM_BODY_TOO_LARGE', 502, 'Voice provider response is too large');
            const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase().trim();
            const allowed = kind === 'pcm' ? ['audio/pcm', 'audio/x-pcm', 'audio/l16', 'application/octet-stream'] : ['application/json'];
            if (!allowed.includes(contentType)) throw error('VOICE_UPSTREAM_INVALID_RESPONSE', 502, 'Voice provider returned an invalid response');
            if (!response.body || typeof response.body.getReader !== 'function') throw error('VOICE_UPSTREAM_INVALID_RESPONSE', 502, 'Voice provider returned an invalid response');
            const reader = response.body.getReader();
            activeReader = reader;
            const chunks = [];
            let size = 0;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (kind === 'pcm') {
                        const prefix = value.subarray(0, limit - size);
                        chunks.push(Buffer.from(prefix));
                        size += prefix.byteLength;
                        if (size >= limit) {
                            // A preview intentionally ends after four seconds; it is not an upstream failure.
                            prefixComplete = true;
                            controller.abort();
                            break;
                        }
                        continue;
                    }
                    size += value.byteLength;
                    if (size > limit) throw error('VOICE_UPSTREAM_BODY_TOO_LARGE', 502, 'Voice provider response is too large');
                    chunks.push(Buffer.from(value));
                }
            } catch (err) {
                // Do not wait on a hostile/stalled source's cancel promise.
                Promise.resolve(reader.cancel()).catch(() => {});
                throw err;
            } finally { activeReader = null; reader.releaseLock(); }
            return Buffer.concat(chunks, size);
        };
        try {
            return await Promise.race([execute(), interruption]);
        } catch (err) {
            controller.abort();
            if (signal?.aborted) throw aborted();
            if (timedOut) throw error('VOICE_UPSTREAM_TIMEOUT', 504, 'Voice provider timed out');
            if (typeof err.code === 'string' && err.code.startsWith('VOICE_')) throw err;
            throw unavailable();
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            controller.signal.removeEventListener('abort', onInternalAbort);
            if (controller.signal.aborted && response?.body && !response.body.locked) Promise.resolve(response.body.cancel()).catch(() => {});
        }
    }

    function normalizeCatalog(data) {
        const values = Array.isArray(data) ? data : data?.voices;
        if (!Array.isArray(values) || !values.length || values.length > 100) throw error('VOICE_UPSTREAM_INVALID_RESPONSE', 502, 'Voice catalog is invalid');
        const seen = new Set();
        return values.map(value => {
            const id = text(value?.voice_id);
            if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || seen.has(id)) throw error('VOICE_UPSTREAM_INVALID_RESPONSE', 502, 'Voice catalog is invalid');
            seen.add(id);
            const label = first(value.name, id).slice(0, 100).replace(/[\x00-\x1f\x7f]/g, '');
            const language = first(value.language, value.labels?.language);
            return { id, label, ...(/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language) ? { language } : {}) };
        });
    }

    async function neuroProvider({ signal } = {}) {
        const defaults = getDefaults('neuro_gemini');
        const base = { id: 'neuro_gemini', label: LABELS.neuro_gemini, available: false,
            models: choices(geminiModels()).map(model => ({ ...model, label: model.id === 'gemini-3.8-flash' ? 'Gemini 3.8 Flash' : 'Gemini 3.7 Flash' })),
            voices: cachedCatalog?.voices || [], defaultModel: defaults.model, defaultVoiceName: defaults.voiceName };
        if (!ready('neuro_gemini')) return base;
        if (cachedCatalog && now() - cachedCatalog.at < catalogTtlMs) return { ...base, voices: cachedCatalog.voices, available: true };
        try {
            const bytes = await request('/v1/voices', { signal, timeoutMs: catalogTimeoutMs, limit: maxCatalogBytes, kind: 'json' });
            let data;
            try { data = JSON.parse(bytes.toString('utf8')); } catch { throw error('VOICE_UPSTREAM_INVALID_RESPONSE', 502, 'Voice catalog is invalid'); }
            const voices = normalizeCatalog(data);
            cachedCatalog = { at: now(), voices };
            return { ...base, voices, available: true };
        } catch (err) {
            if (signal?.aborted || err.code === 'VOICE_REQUEST_CANCELLED') throw aborted();
            return base;
        }
    }

    async function getOptions({ signal, profile } = {}) {
        checkSignal(signal);
        const providers = PROVIDERS.filter(id => id !== 'neuro_gemini').map(legacyProvider);
        providers.push(await neuroProvider({ signal }));
        for (const provider of providers) provider.capabilities = {
            voicePreview: ['neuro_gemini', 'yandex_realtime'].includes(provider.id), tone: true,
            waitingPhrases: provider.id === 'neuro_gemini',
            speechRate: false, pitch: false, changesApply: 'next_call',
        };
        checkSignal(signal);
        // Defensive copies prevent request handlers from mutating the shared cache.
        return JSON.parse(JSON.stringify({ providers, defaultProvider: getDefaultProvider(), ambientAudio: ambientOptions(profile) }));
    }

    async function validateSelection({ provider, model, voiceName }, { signal } = {}) {
        if (!PROVIDERS.includes(provider)) throw error('INVALID_VOICE_AI_PROVIDER', 400, 'Unsupported voice AI provider');
        // A Yandex preview must not wait for an unrelated Neuro catalog request.
        const options = provider === 'neuro_gemini'
            ? (await getOptions({ signal })).providers.find(option => option.id === provider)
            : legacyProvider(provider);
        if (!options.available) throw unavailable();
        const selectedModel = model === undefined ? options.defaultModel : model;
        const selectedVoice = voiceName === undefined ? options.defaultVoiceName : voiceName;
        if (typeof selectedModel !== 'string' || !options.models.some(option => option.id === selectedModel)) throw error('INVALID_VOICE_MODEL', 400, 'Unsupported voice model');
        if (typeof selectedVoice !== 'string' || !options.voices.some(option => option.id === selectedVoice)) throw error('INVALID_VOICE_NAME', 400, 'Unsupported voice');
        return { provider, model: selectedModel, voiceName: selectedVoice };
    }

    async function preview(input, { signal, beforeSynthesis } = {}) {
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).some(key => !['provider', 'voiceName'].includes(key))
            || typeof input.provider !== 'string' || typeof input.voiceName !== 'string') {
            throw error('INVALID_VOICE_PREVIEW_BODY', 400, 'Preview requires provider and voiceName');
        }
        const { provider, voiceName } = await validateSelection(input, { signal });
        if (!['neuro_gemini', 'yandex_realtime'].includes(provider)) throw unavailable();
        // The route reauthorizes after the awaited catalog fetch, closing the revocation window.
        if (beforeSynthesis) beforeSynthesis();
        checkSignal(signal);
        const key = `${provider}:${voiceName}`;
        const cached = previews.get(key);
        if (cached && now() - cached.at < 3600000) return { audio: Buffer.from(cached.audio), contentType: 'audio/wav' };
        if (provider === 'yandex_realtime') {
            const result = await require('./yandex-voice-preview.service').synthesize({
                apiKey: env.YANDEX_CLOUD_API_KEY, folderId: env.YANDEX_CLOUD_FOLDER_ID, voice: voiceName,
                role: first(config.providers.yandex_realtime?.role, 'support'), text: PREVIEW_TEXT, signal,
                timeoutMs: previewTimeoutMs, maxBytes: Math.floor(Math.min(maxAudioBytes, 44100 * 2 * 4) / 2) * 2,
            });
            checkSignal(signal);
            const audio = wrapPreviewPcm(result.pcm, result.sampleRate);
            if (previews.size >= 32) previews.delete(previews.keys().next().value);
            previews.set(key, { audio: Buffer.from(audio), at: now() });
            return { audio, contentType: 'audio/wav' };
        }
        const clipBytes = Math.floor(Math.min(maxAudioBytes, 24000 * 2 * 4) / 2) * 2;
        if (clipBytes < 2) throw error('VOICE_UPSTREAM_INVALID_RESPONSE', 502, 'Voice preview size is invalid');
        const pcm = await request(`/v1/text-to-speech/${encodeURIComponent(voiceName)}/stream?output_format=pcm_24000`, {
            signal, method: 'POST', timeoutMs: previewTimeoutMs, limit: clipBytes, kind: 'pcm',
            body: { text: PREVIEW_TEXT, model_id: 'neuro_tts_v2' },
        });
        const audio = wrapPreviewPcm(pcm);
        checkSignal(signal);
        // Bound process memory even if an enterprise catalog adds more voices later.
        if (previews.size >= 32) previews.delete(previews.keys().next().value);
        previews.set(key, { audio: Buffer.from(audio), at: now() });
        return { audio, contentType: 'audio/wav' };
    }

    return { getOptions, getDefaults, getDefaultProvider, validateSelection, preview, ambientPreview, ambientOptions };
}

module.exports = { ...createVoiceOptionsService(), createVoiceOptionsService };
