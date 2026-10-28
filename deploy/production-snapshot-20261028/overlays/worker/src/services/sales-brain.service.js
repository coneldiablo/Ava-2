const DB = require('./database.service');
const AIService = require('./ai.service');
const RAGService = require('./rag.service');
const ChannelRouter = require('./channel-router.service');
const HotelProfileService = require('./hotel-profile.service');
const PmsService = require('./pms/pms.service');
const Logger = require('../utils/logger');
const { createHash } = require('crypto');
const {
    VALID_STATUSES,
    getStatusesForBusiness,
    resolveBusinessType,
    MANAGER_TASK_STATUSES,
    MANAGER_TASK_TRANSITIONS,
    normalizeManagerTaskStatus,
    normalizeManagerTaskReason,
    normalizeManagerTaskPriority,
    canTransitionManagerTask,
    FOLLOWUP_DRAFT_STATUSES,
    FOLLOWUP_DRAFT_TRANSITIONS,
    normalizeFollowupDraftStatus,
    canTransitionFollowupDraft,
    followupAutoSendEnabled,
} = require('../utils/constants');

const STAGE_ORDER = ['new', 'qualified', 'audit', 'offer', 'pickup_confirmed', 'ready_for_pickup', 'booked'];
const HIGH_RISK_ACTIONS = new Set(['send_whatsapp_followup', 'send_payment', 'book_appointment']);
const ACTIVE_COFFEE_ORDER_STATUSES = new Set(['new', 'accepted', 'ready']);
const FOLLOWUP_IN_FLIGHT_STATUSES = new Set(['pending', 'sending', 'unknown', 'unknown_pending', 'unknown-pending', 'delivery_pending', 'unconfirmed']);
const OBJECTION_LABELS = {
    price: 'цена',
    timing: 'сроки',
    trust: 'доверие'
};

function digits(value) {
    return String(value || '').replace(/\D+/g, '');
}

function canonicalPhone(value) {
    const raw=String(value||'').replace(/@(c\.us|s\.whatsapp\.net)$/,'');
    if(!/^\+?[\d ()-]+$/.test(raw)) return null;
    let normalized=digits(raw);
    if(normalized.length===11&&normalized[0]==='8') normalized='7'+normalized.slice(1);
    return /^[1-9]\d{7,14}$/.test(normalized)?normalized:null;
}

function clip(value, limit = 240) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3)).trim()}...` : text;
}

function parseJson(value, fallback) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function transcriptToText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return clip(JSON.stringify(value), 4000);
    return value
        .map((entry) => {
            if (!entry) return '';
            if (typeof entry === 'string') return entry;
            const role = String(entry.role || entry.speaker || 'unknown').trim();
            const content = String(entry.content || entry.text || entry.transcript || '').trim();
            return content ? `${role}: ${content}` : '';
        })
        .filter(Boolean)
        .join('\n');
}

function extractiveCallSummary(transcript) {
    const turns = Array.isArray(transcript)
        ? transcript.filter((entry) => entry && typeof entry === 'object'
            && GUEST_ROLES.has(String(entry.role || entry.speaker || '').toLowerCase()))
            .map((entry) => String(entry.content || entry.text || entry.transcript || '').trim())
            .filter(Boolean)
        : String(transcript || '').split(/[.!?]\s+/).map((part) => part.trim()).filter(Boolean);
    return turns.length ? `По расшифровке: ${clip(turns.slice(0, 2).join('; '), 600)}` : null;
}

function callEventId(instanceId, callId) {
    return `evt_post_call_${instanceId}_${createHash('sha256').update(String(callId)).digest('hex')}`;
}

// Only the guest's own turns are evidence of a handoff intent. The assistant
// saying "передам администратору" is not a request, it is the symptom.
const GUEST_ROLES = new Set(['user', 'caller', 'guest', 'human', 'customer', 'client', 'клиент', 'гость', 'пользователь']);

function transcriptGuestText(value, preserveCase = false) {
    if (!value) return '';
    if (typeof value === 'string') {
        // Legacy payloads can be plain guest text or a role-labelled transcript.
        // Once labels are present, unlabelled/assistant text is not evidence.
        const labels = /(?:^|\n|[.!?]\s+)(user|caller|guest|human|customer|client|клиент|гость|пользователь|assistant|agent|асcистент|ассистент|ava|system)\s*:/gi;
        const turns = [...value.matchAll(labels)];
        if (!turns.length) return preserveCase ? value : value.toLowerCase();
        const text = turns.filter((turn) => GUEST_ROLES.has(turn[1].toLowerCase()) || /^(клиент|гость|пользователь)$/i.test(turn[1]))
            .map((turn) => {
                const index = turns.indexOf(turn);
                return value.slice(turn.index + turn[0].length, turns[index + 1]?.index ?? value.length);
            }).join('\n');
        return preserveCase ? text : text.toLowerCase();
    }
    if (!Array.isArray(value)) return '';
    const text = value
        .map((entry) => {
            if (!entry || typeof entry === 'string') return '';
            const role = String(entry.role || entry.speaker || '').trim().toLowerCase();
            if (!GUEST_ROLES.has(role)) return '';
            return String(entry.content || entry.text || entry.transcript || '').trim();
        })
        .filter(Boolean)
        .join('\n');
    return preserveCase ? text : text.toLowerCase();
}

function declaredCallerName(transcript) {
    // Only an explicit self-introduction in a caller turn is name evidence.
    // Caller ID, the assistant, generated summaries and third-party names are not.
    const text = transcriptGuestText(transcript, true);
    const introductions = [...text.matchAll(/(?:меня\s+зовут|мо[её]\s+имя)\s*[:—-]?\s+([\p{L}][\p{L}'’\-]{1,39})/giu)];
    const names = introductions.flatMap(match => {
        const first = match[1];
        if (/^(?:не|так|как|пока|никто|никогда|забыли|забывай|называть|скажите|известно|назову|назвать|вас|клиент|пользователь)$/iu.test(first)) return [];
        // ASR often omits punctuation. Taking only the declared first name
        // avoids saving the next capitalized sentence as part of a name.
        return [first[0].toLocaleUpperCase('ru-RU') + first.slice(1)];
    });
    // Conflicting self-introductions need a human; never guess an identity.
    // A short direct answer to the assistant's name question is also an
    // explicit declaration. Never infer a name from an assistant's statement.
    const turns = Array.isArray(transcript) ? transcript : (() => {
        const value = String(transcript || '');
        const labels = [...value.matchAll(/(?:^|\n)(user|caller|guest|human|customer|client|клиент|гость|пользователь|assistant|agent|ассистент|ava)\s*:/gi)];
        return labels.map((label, index) => ({role: label[1], content: value.slice(label.index + label[0].length, labels[index + 1]?.index ?? value.length)}));
    })();
    for (let index = 1; index < turns.length; index++) {
        const previous = turns[index - 1], answer = turns[index];
        if (!previous || !answer || !/^(?:assistant|agent|ассистент|ava)$/i.test(previous.role || previous.speaker || '')
            || !GUEST_ROLES.has(String(answer.role || answer.speaker || '').toLowerCase())) continue;
        if (!/(?:как\s+вас\s+зовут|как\s+(?:я\s+могу\s+)?к\s+вам\s+(?:можно\s+)?обращаться|ваше\s+имя|представьтесь)/iu.test(previous.content || previous.text || '')) continue;
        const value = String(answer.content || answer.text || answer.transcript || '').trim().replace(/[.!]+$/, '').trim();
        if (!/^[\p{L}][\p{L}'’\-]{1,39}(?:\s+[\p{L}][\p{L}'’\-]{1,39}){0,2}$/u.test(value)
            || /(?:^|\s)(?:не|нет|мне|хочу|нужен|нужна|нужно|спасибо|зачем|потом|позже|скажите|пришлите|посмотреть|каталог|оборудование)(?=\s|$)/iu.test(value)) continue;
        const first = value.split(/\s+/)[0];
        names.push(first[0].toLocaleUpperCase('ru-RU') + first.slice(1));
    }
    const unique = [...new Map(names.map(name => [name.toLocaleLowerCase('ru-RU'), name])).values()];
    return unique.length === 1 ? unique[0] : null;
}

function unnamedVoiceClient(client) {
    const value = String(client?.senderName || '').trim();
    return !value || /^(?:звонивший клиент|клиент|гость|unknown|неизвестно|без имени)$/iu.test(value)
        || canonicalPhone(value) !== null;
}

const TOOL_SUCCESS_STATUSES = new Set(['ok', 'success', 'succeeded', 'completed', 'transferred', 'answered', 'answer', 'connected', 'confirmed', 'booked', 'paid']);
const TOOL_FAILURE_STATUSES = /(?:^|_)(error|failed|failure|busy|timeout|timed_out|denied|rejected|cancelled|canceled|no_answer|unavailable)(?:$|_)/;

function normalizeToolRun(run = {}) {
    if (!run || typeof run !== 'object') run = {};
    const rawResult = run.result ?? run.output ?? parseJson(run.resultRedactedJson, {});
    const result = typeof rawResult === 'string' ? parseJson(rawResult, rawResult) : rawResult;
    const payload = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
    const statuses = [run.status, typeof result === 'string' ? result : payload.status, payload.outcome, payload.dial_status || payload.dialStatus]
        .filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim().toLowerCase());
    const failed = result === false || run.success === false || payload.success === false || Boolean(run.error || payload.error)
        || statuses.some((status) => TOOL_FAILURE_STATUSES.test(status));
    // An explicit unknown/pending/unrecognised outcome wins over a success flag.
    const status = failed ? 'error'
        : statuses.some((value) => !TOOL_SUCCESS_STATUSES.has(value)) ? 'unknown'
        : statuses.length || run.success === true || payload.success === true ? 'ok' : 'unknown';
    const latency = Number(run.duration_ms ?? run.latency_ms ?? run.latencyMs ?? 0);
    return {
        name: String(run.name || run.tool_name || run.function_name || run.toolName || 'unknown_tool'),
        phase: run.phase || 'in_call',
        arguments: parseJson(run.arguments ?? run.args ?? run.params ?? run.argsRedactedJson, {}),
        result: typeof result === 'string' ? { status: result, ...(run.message ? { message: run.message } : {}) } : (result || {}),
        status,
        latencyMs: Number.isFinite(latency) && latency >= 0 ? latency : 0,
    };
}

// Deterministic, keyword-based. No LLM call: post-call must stay cheap and
// reproducible, and a wrong guess here creates noise in the manager's queue.
const HANDOFF_INTENT_RULES = [
    { reason: 'guest_request', patterns: ['оператор', 'администратор', 'живой человек', 'с человеком', 'позовите', 'соедините', 'ресепшен', 'ресепшн'] },
    { reason: 'complaint', patterns: ['жалоб', 'претензи', 'хамств', 'безобрази', 'верните деньги', 'требую'] },
    { reason: 'payment', patterns: ['оплату', 'оплата', 'оплатить', 'платёж', 'платеж', 'предоплат', 'возврат денег', 'вернуть деньги'] },
    { reason: 'booking_change', patterns: ['перенести брон', 'изменить брон', 'отменить брон', 'поменять дат', 'перенести дат'] },
];

function detectHandoffIntent(transcript) {
    const text = transcriptGuestText(transcript);
    if (!text) return null;
    for (const rule of HANDOFF_INTENT_RULES) {
        const hit = rule.patterns.find((pattern) => text.includes(pattern));
        if (hit) return { reason: rule.reason, matched: hit };
    }
    return null;
}

const FOLLOWUP_CHANNELS = new Map([['whatsapp','WhatsApp'],['telegram','Telegram'],['email','почту'],['vk','ВКонтакте'],['max','MAX'],['avito','Авито'],['instagram','Instagram']]);
const requestedFollowupChannels = require('./followup-intent').requestedChannels;

function isoNow() {
    return new Date().toISOString();
}

function addMinutesIso(minutes) {
    return new Date(Date.now() + Math.max(1, Number(minutes || 60)) * 60 * 1000).toISOString();
}

function safeKey(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 96);
}

function localMinutes(now, timezone) {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: timezone || 'UTC',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(now);
        const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
        const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
        return hour * 60 + minute;
    } catch (_) {
        return now.getUTCHours() * 60 + now.getUTCMinutes();
    }
}

function parseTimeToMinutes(value, fallback) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return fallback;
    const hour = Math.max(0, Math.min(23, Number(match[1])));
    const minute = Math.max(0, Math.min(59, Number(match[2])));
    return hour * 60 + minute;
}

function isWithinCallWindow(callWindow, timezone, now = new Date()) {
    const start = parseTimeToMinutes(callWindow?.start || callWindow?.from || '09:00', 9 * 60);
    const end = parseTimeToMinutes(callWindow?.end || callWindow?.to || '18:00', 18 * 60);
    const current = localMinutes(now, timezone);
    if (start === end) return true;
    if (start < end) return current >= start && current <= end;
    return current >= start || current <= end;
}

function includesAny(values, candidates) {
    const lower = new Set((values || []).map((v) => String(v || '').toLowerCase()));
    return (candidates || []).some((candidate) => lower.has(String(candidate || '').toLowerCase()));
}

function uniqueTextList(values, limit = 8, itemLimit = 140) {
    const source = Array.isArray(values) ? values : [values];
    const seen = new Set();
    const result = [];
    for (const value of source) {
        const text = clip(value, itemLimit);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(text);
        if (result.length >= limit) break;
    }
    return result;
}

function normalizeTextArray(value, splitPattern = /[,;\n]+/) {
    if (!value) return [];
    if (Array.isArray(value)) return uniqueTextList(value);
    const parsed = parseJson(value, null);
    if (Array.isArray(parsed)) return uniqueTextList(parsed);
    return uniqueTextList(String(value || '').split(splitPattern));
}

function extractDateMentions(text) {
    const source = String(text || '');
    if (!source.trim()) return [];
    const patterns = [
        /\bс\s+\d{1,2}(?:[./-]\d{1,2}(?:[./-]\d{2,4})?)?\s+(?:по|до)\s+\d{1,2}(?:[./-]\d{1,2}(?:[./-]\d{2,4})?)?\b/gi,
        /\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/gi,
        /\b\d{1,2}\s+(?:январ[ья]|феврал[ья]|марта?|апрел[ья]|ма[йя]|июн[ья]|июл[ья]|август[а]?|сентябр[ья]|октябр[ья]|ноябр[ья]|декабр[ья])(?:\s+\d{4})?\b/gi,
        /\b(?:сегодня|завтра|послезавтра|на\s+выходны[ех]|в\s+выходные|на\s+следующ(?:ей|ие)\s+неделе|на\s+этой\s+неделе)\b/gi,
        /\b(?:к|на)\s*\d{1,2}:\d{2}\b/gi,
    ];
    const matches = [];
    for (const pattern of patterns) {
        const found = source.match(pattern);
        if (found) matches.push(...found);
    }
    return uniqueTextList(matches, 8, 80);
}

function extractInterestMentions(text) {
    const source = String(text || '');
    if (!source.trim()) return [];
    const matches = [];
    const patterns = [
        /(?:интересует|интересны|ищу|ищем|нужен|нужна|нужно|нужны|хочу|хотим|важно)\s+([^.!?\n]{6,120})/gi,
        /(?:номер|люкс|апартамент|апартаменты|семейный номер|вид на море|spa|спа|трансфер|завтрак|ранний заезд|поздний выезд|конференц-зал)([^.!?\n]{0,80})/gi,
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(source)) !== null) {
            const snippet = clip((match[1] || match[0] || '').replace(/^[,:;\s-]+/, ''), 120);
            if (snippet) matches.push(snippet);
        }
    }
    return uniqueTextList(matches, 8, 120);
}

function extractObjectionSignals(text) {
    const lower = String(text || '').toLowerCase();
    const objections = [];
    if (/дорого|цена|стоимость|бюджет/.test(lower)) objections.push('price');
    if (/подума|позже|не сейчас|нет времени/.test(lower)) objections.push('timing');
    if (/сомнева|не уверен|риск/.test(lower)) objections.push('trust');
    return uniqueTextList(objections, 5, 40);
}

function humanizeObjection(value) {
    return OBJECTION_LABELS[String(value || '').toLowerCase()] || String(value || '');
}

class SalesBrainService {
    defaultInstanceId() {
        return Number(process.env.WHATSAPP_CRM_DEFAULT_INSTANCE_ID || 1);
    }

    businessScope(input = {}) {
        const supplied = [input.instanceId, input.instance_id, input.business_id].filter(value => value !== undefined && value !== null);
        const ids = supplied.length ? supplied.map(Number) : [this.defaultInstanceId()];
        if (ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== 1) {
            throw Object.assign(new Error('BUSINESS_SCOPE_REQUIRED'), { code: 'BUSINESS_SCOPE_REQUIRED', statusCode: 400 });
        }
        return ids[0];
    }

    async resolveCustomer(input = {}) {
        const instanceId = this.businessScope(input);
        const rawPhone = String(input.phone || input.caller_number || input.callerNumber || '');
        const phone = canonicalPhone(rawPhone) || (/^[\d ()+\-]+$/.test(rawPhone) ? digits(rawPhone) : '');
        const explicitChatId = input.chatId || input.chat_id || null;
        const clientForChat = async (chatId) => {
            if (!chatId || /@(g\.us|broadcast)$/.test(String(chatId))) return null;
            const canonical = require('./client-identity.service').resolve(instanceId, String(chatId));
            return (await DB.getClient(instanceId, canonical)) || null;
        };

        let match = null;
        let confidence = 'none';
        let identityLink = null;
        if (explicitChatId) {
            const candidate = await clientForChat(explicitChatId);
            const exactPhone = canonicalPhone(candidate?.chatId) && canonicalPhone(candidate?.chatId) === canonicalPhone(phone);
            const alias = phone ? DB.getIdentityLinkByPhone(instanceId, phone) : null;
            const manualAlias = alias?.confidence === 'manual' && String(alias.chatId) === String(candidate?.chatId)
                && alias.customerId === `crm_${instanceId}_${candidate.id}`;
            // An explicit chat ID cannot override conflicting caller ID evidence.
            match = candidate && (!phone || exactPhone || manualAlias) ? candidate : null;
            confidence = match ? 'exact' : 'none';
        }

        if (!match && phone) {
            identityLink = DB.getIdentityLinkByPhone(instanceId, phone);
            if (identityLink?.chatId && ['exact','manual'].includes(identityLink.confidence)) {
                const candidate=await clientForChat(identityLink.chatId);
                const verified=identityLink.confidence==='manual' || canonicalPhone(candidate?.chatId)&&canonicalPhone(candidate?.chatId)===canonicalPhone(phone);
                if(candidate && verified && identityLink.customerId===`crm_${instanceId}_${candidate.id}`) {
                    match=candidate;
                    confidence=identityLink.confidence;
                }
            }
        }

        if (!match && phone) {
            const normalized=canonicalPhone(input.phone || input.caller_number || input.callerNumber);
            if (normalized) {
                const variants = [normalized, `${normalized}@c.us`, `${normalized}@s.whatsapp.net`];
                if (normalized.length === 11 && normalized.startsWith('7')) {
                    const legacy = `8${normalized.slice(1)}`;
                    variants.push(legacy, `${legacy}@c.us`, `${legacy}@s.whatsapp.net`);
                }
                for (const chatId of variants) {
                    match = await clientForChat(chatId);
                    if (match) break;
                }
            }
            confidence = match ? 'exact' : confidence;
        }

        // Names, suffix matches and opaque WhatsApp LIDs are not proof of identity.
        // Operator-created aliases still work; uncertain callers remain unresolved.

        if (!match) {
            return {
                found: false,
                instanceId,
                phone,
                identity_confidence: 'none',
                customer_id: null,
                chatId: null,
                client: null,
                spoken: 'Я не нашел этого клиента в CRM.'
            };
        }

        const normalizedPhone = canonicalPhone(match.chatId) || (identityLink?.confidence==='manual' ? canonicalPhone(identityLink.normalizedPhone) : null);
        const link = normalizedPhone ? DB.upsertIdentityLink({
            instanceId,
            customerId: `crm_${instanceId}_${match.id}`,
            chatId: match.chatId,
            normalizedPhone,
            linkType: 'phone',
            confidence,
            evidence: { source: 'sales_brain_resolve', chatId: match.chatId }
        }) : null;

        return {
            found: true,
            instanceId,
            phone: normalizedPhone,
            identity_confidence: confidence,
            identity_link: identityLink ? {
                link_type: identityLink.linkType,
                normalized_phone: identityLink.normalizedPhone
            } : null,
            customer_id: link?.customerId || `crm_${instanceId}_${match.id}`,
            chatId: match.chatId,
            client: this.safeClient(match),
            spoken: `Нашел клиента ${match.senderName || 'без имени'}. Статус: ${match.leadStatus || 'new'}.`
        };
    }

    async ensureVoiceCustomer(input = {}) {
        const resolved = await this.resolveCustomer(input);
        if (resolved.found) return resolved;
        const instanceId = Number(input.instanceId || input.instance_id || input.business_id);
        const phone = canonicalPhone(input.phone || input.caller_number || input.callerNumber);
        // A caller ID can create its own phone card, but cannot override an
        // explicit, conflicting customer binding or identify an opaque LID.
        if (!Number.isSafeInteger(instanceId) || instanceId < 1 || !phone
            || input.chatId || input.chat_id || !(await DB.getInstance(instanceId))) {
            return resolved;
        }
        const chatId = `${phone}@c.us`;
        try {
            await DB.getOrCreateClient(instanceId, chatId, input.callerName || input.caller_name || 'Звонивший клиент');
        } catch (error) {
            // A parallel pre-call/post-call delivery may have inserted the same
            // tenant-scoped card after the SELECT in getOrCreateClient.
            if (!(await DB.getClient(instanceId, chatId))) throw error;
        }
        return this.resolveCustomer({ instanceId, phone, chatId });
    }

    normalizeWhatsAppChatId(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        if (raw.includes('@')) return raw;
        const phone = digits(raw);
        return phone ? `${phone}@c.us` : '';
    }

    async bindCustomerAlias(input = {}) {
        const instanceId = Number(input.instanceId || input.instance_id || this.defaultInstanceId());
        const alias = digits(input.alias || input.phone || input.caller_number || input.extension || '');
        const chatId = this.normalizeWhatsAppChatId(input.chatId || input.chat_id || input.whatsappPhone || input.whatsapp_phone || input.targetPhone || input.target_phone || '');
        const senderName = String(input.senderName || input.sender_name || input.name || 'Связанный клиент').trim();
        const linkType = String(input.linkType || input.link_type || (alias.length <= 6 ? 'sip_extension' : 'phone_alias')).trim();

        if (!alias) {
            return { success: false, error: 'alias_required', spoken: 'Не указан номер или extension для привязки.' };
        }
        if (!chatId) {
            return { success: false, error: 'chat_id_required', spoken: 'Не указан WhatsApp номер клиента.' };
        }

        const client = await DB.getOrCreateClient(instanceId, chatId, senderName);
        if (input.replaceExisting || input.replace_existing) {
            DB.deleteIdentityLinksByChat(instanceId, chatId, linkType);
        }
        const link = DB.upsertIdentityLink({
            instanceId,
            customerId: `crm_${instanceId}_${client.id}`,
            chatId,
            normalizedPhone: alias,
            linkType,
            confidence: input.confidence || 'manual',
            evidence: {
                source: 'manual_sales_brain_link',
                alias,
                chatId,
                createdBy: input.createdBy || input.created_by || 'api'
            }
        });

        return {
            success: true,
            instanceId,
            alias,
            chatId,
            link_type: link.linkType,
            customer_id: link.customerId,
            spoken: `Привязал ${alias} к WhatsApp ${chatId}.`
        };
    }

    async getCustomerAliases(input = {}) {
        const instanceId = Number(input.instanceId || input.instance_id || this.defaultInstanceId());
        const chatId = this.normalizeWhatsAppChatId(input.chatId || input.chat_id || input.whatsappPhone || input.whatsapp_phone || '');
        if (!chatId) return { success: true, aliases: [] };
        const aliases = DB.getIdentityLinksByChat(instanceId, chatId)
            .map((link) => ({
                alias: link.normalizedPhone,
                link_type: link.linkType,
                confidence: link.confidence,
                updated_at: link.updatedAt
            }));
        return { success: true, instanceId, chatId, aliases };
    }

    async removeCustomerAlias(input = {}) {
        const instanceId = Number(input.instanceId || input.instance_id || this.defaultInstanceId());
        const chatId = this.normalizeWhatsAppChatId(input.chatId || input.chat_id || input.whatsappPhone || input.whatsapp_phone || '');
        const linkType = input.linkType || input.link_type || 'sip_extension';
        if (!chatId) return { success: false, error: 'chat_id_required' };
        DB.deleteIdentityLinksByChat(instanceId, chatId, linkType);
        return { success: true, instanceId, chatId, spoken: 'SIP-привязку удалил.' };
    }

    safeClient(client) {
        if (!client) return null;
        return {
            id: client.id,
            chatId: client.chatId,
            senderName: client.senderName,
            leadStatus: client.leadStatus || 'new',
            assigneeUserId: client.assigneeUserId || null,
            lastMessage: clip(client.lastMessage, 220),
            lastMessageTime: client.lastMessageTime,
            preferredChannel: client.preferredChannel || 'whatsapp',
            detectedLanguage: client.detectedLanguage || 'ru',
            tags: parseJson(client.tags, []),
            updatedAt: client.updatedAt,
            createdAt: client.createdAt
        };
    }

    safeProfile(profile) {
        if (!profile) return null;
        const raw = parseJson(profile.rawProfileJson, {});
        const rawKeyFacts = normalizeTextArray(raw.keyFacts);
        const rawImportantDates = normalizeTextArray(raw.importantDates);
        const rawInterestSignals = normalizeTextArray(raw.interestSignals);
        const rawCallSummaries = normalizeTextArray(raw.callSummaries);
        return {
            needs: profile.needs || null,
            budget: profile.budget || null,
            objections: normalizeTextArray(profile.objections),
            interests: uniqueTextList([
                ...normalizeTextArray(profile.interests),
                ...rawInterestSignals
            ], 8, 120),
            communicationStyle: profile.communicationStyle || 'casual',
            decisionSpeed: profile.decisionSpeed || 'medium',
            sentimentScore: Number(profile.sentimentScore || 0.5),
            conversionProbability: Number(profile.conversionProbability || 0),
            lastProfileUpdate: profile.lastProfileUpdate,
            keyFacts: rawKeyFacts,
            importantDates: rawImportantDates,
            lastCallSummary: raw.lastCallSummary ? clip(raw.lastCallSummary, 220) : (rawCallSummaries[0] || null),
            lastCallAt: raw.lastCallAt || null,
            callCount: Number(raw.callCount || 0),
            rawProfile: raw
        };
    }

    getRecentCallEvents(instanceId, chatId, limit = 3) {
        if (!instanceId || !chatId) return [];
        // One call has many linked task/draft/tool events. Use its canonical
        // summary, so creating a follow-up never replaces the call's memory.
        return require('./customer-context.service').snapshot(instanceId, chatId, {callLimit: Math.max(1, Math.min(100, limit))})
            .calls.filter(call => call.summary).reverse().map(call => ({
                eventId: call.id, callId: call.callId, content: call.summary, createdAt: call.timestamp,
                channel: 'voice', role: 'summary', transcript: call.transcript || null,
            }));
    }

    buildMemorySnapshot({ profile, messages = [], callEvents = [], generated = null, generatedCall = null }) {
        if (generated) {
            const lastCallEvent = callEvents.slice(-1)[0] || null;
            return {
                interests: generated.interests, important_dates: generated.dates, objections: generated.objections,
                key_facts: [generated.summary, generated.needs, generated.budget].filter(Boolean),
                conversation_summary: generated.summary, summary_provenance: generated.provenance,
                summary_status: generated.status, summary_relevance: generated.relevance,
                summary_policy_version: generated.policy_version,
                summary_source_complete: generated.source_complete, summary_source_updated_at: generated.source_updated_at,
                next_step_recommendation: generated.next_step,
                last_call_summary: (lastCallEvent?.content ? clip(lastCallEvent.content, 600) : null)
                    || generatedCall?.summary || profile?.lastCallSummary || null,
                last_call_at: lastCallEvent?.createdAt || profile?.lastCallAt || null,
                recent_calls_count: Math.max(Number(profile?.callCount || 0), callEvents.length),
            };
        }
        const recentTexts = [
            ...(messages || []).map((message) => message?.content || ''),
            ...(callEvents || []).map((event) => event?.content || '')
        ];
        const inferredDates = uniqueTextList(recentTexts.flatMap((text) => extractDateMentions(text)), 8, 80);
        const inferredInterests = uniqueTextList(recentTexts.flatMap((text) => extractInterestMentions(text)), 8, 120);
        const inferredObjections = uniqueTextList(recentTexts.flatMap((text) => extractObjectionSignals(text)), 5, 40);
        const lastCall = (callEvents || []).slice(-1)[0] || null;
        const lastCallSummary = (lastCall?.content ? clip(lastCall.content, 600) : null) || profile?.lastCallSummary || null;
        const lastCallAt = lastCall?.createdAt || profile?.lastCallAt || null;
        const lastUserMessage = [...(messages || [])].reverse().find((message) => message?.role === 'user');
        const keyFacts = uniqueTextList([
            ...(profile?.keyFacts || []),
            ...(profile?.needs ? [`Потребность: ${profile.needs}`] : []),
            ...(profile?.budget ? [`Бюджет: ${profile.budget}`] : []),
            ...(inferredDates[0] ? [`Дата: ${inferredDates[0]}`] : []),
            ...(inferredInterests[0] ? [`Интерес: ${inferredInterests[0]}`] : []),
            ...(lastCallSummary ? [`Последний звонок: ${lastCallSummary}`] : []),
            ...(lastUserMessage?.content ? [`Последний чат: ${clip(lastUserMessage.content, 120)}`] : []),
        ], 10, 180);

        return {
            interests: uniqueTextList([...(profile?.interests || []), ...inferredInterests], 8, 120),
            important_dates: uniqueTextList([...(profile?.importantDates || []), ...inferredDates], 8, 80),
            objections: uniqueTextList([...(profile?.objections || []), ...inferredObjections], 5, 40),
            key_facts: keyFacts,
            last_call_summary: lastCallSummary,
            last_call_at: lastCallAt,
            recent_calls_count: Math.max(Number(profile?.callCount || 0), callEvents.length),
        };
    }

    compactCoffeeOrder(order) {
        if (!order) return null;
        return {
            id: order.id,
            status: order.status,
            summary: clip(order.orderSummary, 160),
            pickup_time: order.pickupTime || null,
            created_at: order.createdAt,
            accepted_at: order.acceptedAt || null,
            ready_at: order.readyAt || null,
            barista_name: order.baristaName || null
        };
    }

    async buildCoffeeContext(instanceId, chatId, instance = null) {
        const resolvedInstance = instance || await DB.getInstance(instanceId);
        if (!resolvedInstance || resolveBusinessType(resolvedInstance) !== 'coffee_shop' || !chatId) {
            return null;
        }

        const orders = await DB.getOrdersByClient(instanceId, chatId, 10);
        const activeOrders = orders
            .filter((order) => ACTIVE_COFFEE_ORDER_STATUSES.has(order.status))
            .slice(0, 3)
            .map((order) => this.compactCoffeeOrder(order));
        const lastOrder = orders.length ? this.compactCoffeeOrder(orders[0]) : null;
        const stopList = await DB.getCoffeeStopList(instanceId, false);
        const stopListHints = stopList.slice(0, 6).map((item) => ({
            item: item.itemName,
            reason: clip(item.reason, 100)
        }));

        return {
            business_type: 'coffee_shop',
            settings: {
                mode: resolvedInstance.coffeeOperationMode || 'normal',
                cafe_hours: resolvedInstance.coffeeCafeHours || '09:00-00:00',
                kitchen_hours: resolvedInstance.coffeeKitchenHours || '09:00-22:00',
                prep_time_minutes: Number(resolvedInstance.coffeePrepTimeMinutes || 15),
                busy_prep_time_minutes: Number(resolvedInstance.coffeeBusyPrepTimeMinutes || 25)
            },
            active_orders: activeOrders,
            last_order: lastOrder,
            stop_list_hints: stopListHints
        };
    }

    coffeeContextSummary(coffeeContext) {
        if (!coffeeContext) return [];
        const parts = [
            `Режим кофейни: ${coffeeContext.settings.mode}, зал ${coffeeContext.settings.cafe_hours}, кухня ${coffeeContext.settings.kitchen_hours}, приготовление около ${coffeeContext.settings.prep_time_minutes} минут.`
        ];

        if (coffeeContext.active_orders.length > 0) {
            parts.push(`Активный заказ: ${coffeeContext.active_orders.map((order) => `#${order.id} ${order.status}: ${order.summary}`).join('; ')}.`);
        } else if (coffeeContext.last_order) {
            parts.push(`Последний заказ: #${coffeeContext.last_order.id} ${coffeeContext.last_order.status}: ${coffeeContext.last_order.summary}.`);
        }

        if (coffeeContext.stop_list_hints.length > 0) {
            parts.push(`Стоп-лист: ${coffeeContext.stop_list_hints.map((item) => item.item).join(', ')}.`);
        }
        return parts.map((part) => clip(part, 260));
    }

    hydrateOutboundCampaign(row) {
        if (!row) return null;
        return {
            campaign_id: row.campaignId,
            instance_id: Number(row.instanceId),
            name: row.name,
            source_filter: parseJson(row.sourceFilterJson, {}),
            context_id: row.contextId,
            timezone: row.timezone,
            call_window: parseJson(row.callWindowJson, {}),
            max_attempts: Number(row.maxAttempts || 3),
            retry_policy: parseJson(row.retryPolicyJson, {}),
            post_call_action: parseJson(row.postCallActionJson, {}),
            enabled: Boolean(row.enabled),
            status: row.status,
            created_at: row.createdAt,
            updated_at: row.updatedAt
        };
    }

    hydrateOutboundLead(row) {
        if (!row) return null;
        return {
            lead_id: row.leadId,
            campaign_id: row.campaignId,
            instance_id: Number(row.instanceId),
            chatId: row.chatId,
            customer_id: row.customerId,
            phone: row.phone,
            name: row.name,
            source: parseJson(row.sourceJson, {}),
            custom_vars: parseJson(row.customVarsJson, {}),
            state: row.state,
            do_not_call: Boolean(row.doNotCall),
            attempt_count: Number(row.attemptCount || 0),
            next_attempt_at: row.nextAttemptAt,
            last_attempt_at: row.lastAttemptAt,
            last_outcome: row.lastOutcome,
            created_at: row.createdAt,
            updated_at: row.updatedAt
        };
    }

    hydrateFollowupDraft(row) {
        if (!row) return null;
        const metadata = parseJson(row.metadataJson, {});
        return {
            draft_id: row.eventId,
            event_id: row.eventId,
            instance_id: Number(row.instanceId),
            chatId: row.chatId,
            customer_id: row.customerId,
            text: row.content || '',
            status: metadata.status || 'draft',
            source: metadata.source || 'sales_brain',
            created_at: row.createdAt,
            sent_at: metadata.sent_at || null,
            error: metadata.error || null,
            call_id: row.callId || null,
            metadata
        };
    }

    async getTimeline(input = {}) {
        const resolved = input.chatId ? {
            found: true,
            instanceId: Number(input.instanceId || this.defaultInstanceId()),
            chatId: input.chatId,
            customer_id: input.customerId || null,
            identity_confidence: 'exact'
        } : await this.resolveCustomer(input);

        if (!resolved.found && !resolved.chatId) {
            return { ...resolved, timeline: [] };
        }

        const instanceId = resolved.instanceId;
        const chatId = resolved.chatId;
        const limit = Math.max(1, Math.min(Number(input.limit || 20), 100));
        const messages = chatId ? await DB.getMessages(instanceId, chatId) : [];
        const events = DB.getConversationEvents(instanceId, chatId, limit);
        const toolRuns = DB.getToolRuns(instanceId, chatId, limit);
        const mlDecisions = DB.getMlDecisions(instanceId, chatId, limit);
        const timeline = [
            ...messages.slice(-limit).map((m) => ({
                type: 'message',
                channel: m.channel || 'whatsapp',
                role: m.role,
                content: clip(m.content, 500),
                timestamp: m.timestamp
            })),
            ...events.map((e) => ({
                type: 'event',
                channel: e.channel,
                role: e.role,
                content: clip(e.content, 500),
                callId: e.callId,
                metadata: parseJson(e.metadataJson, {}),
                timestamp: e.createdAt
            })),
            ...toolRuns.map((run) => ({
                type: 'tool_run',
                channel: 'sales_brain',
                role: 'tool',
                content: `${run.toolName}: ${run.status}`,
                callId: run.callId,
                metadata: {
                    phase: run.phase,
                    latency_ms: Number(run.latencyMs || 0),
                    result: parseJson(run.resultRedactedJson, {})
                },
                timestamp: run.createdAt
            })),
            ...mlDecisions.map((decision) => ({
                type: 'ml_decision',
                channel: 'sales_brain',
                role: 'ai',
                content: `${decision.taskType}: confidence ${Number(decision.confidence || 0).toFixed(2)}`,
                metadata: {
                    model: decision.model,
                    prompt_version: decision.promptVersion,
                    output: parseJson(decision.outputJson, {})
                },
                timestamp: decision.createdAt
            }))
        ].sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || ''))).slice(-limit);

        return { ...resolved, timeline };
    }

    async customerSummary(input = {}) {
        const resolved = await this.resolveCustomer(input);
        const scopedPhone = input.phone || input.caller_number || resolved.phone || '';
        let pmsContext = null;
        try { pmsContext = PmsService.customerContext(resolved.instanceId || input.instanceId || input.instance_id, scopedPhone); } catch (_) {}
        if (!resolved.found) {
            if (!pmsContext?.upcoming_bookings?.length) return resolved;
            const booking = pmsContext.upcoming_bookings[0];
            const summary = `В Bnovo текущего отеля есть бронь ${booking.booking_number || ''}: заезд ${booking.arrival || 'не указан'}, выезд ${booking.departure || 'не указан'}, статус ${booking.status || 'не указан'}.`;
            return { ...resolved, pms_context: pmsContext, summary_for_voice: summary, spoken: summary };
        }

        const instance = await DB.getInstance(resolved.instanceId);
        const businessType = resolveBusinessType(instance || {});
        const coffeeContext = await this.buildCoffeeContext(resolved.instanceId, resolved.chatId, instance);
        const profile = await DB.getClientProfile(resolved.instanceId, resolved.chatId);
        const messages = await DB.getRecentMessages(resolved.instanceId, resolved.chatId, 12);
        const callEvents = this.getRecentCallEvents(resolved.instanceId, resolved.chatId, 3);
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        const safeProfile = this.safeProfile(profile);
        const generated = require('./crm-memory-store.service').latest(resolved.instanceId, resolved.chatId);
        const generatedCall = require('./crm-memory-store.service').latest(resolved.instanceId, resolved.chatId, 'call');
        const readyGenerated = [generated, generatedCall].filter(value => value?.summary && value.source_complete
            && ['relevant', 'mixed'].includes(value.relevance)).sort((a, b) =>
            (Date.parse(b.source_updated_at || '') || 0) - (Date.parse(a.source_updated_at || '') || 0))[0] || null;
        const fallbackAllowed = ![generated, generatedCall].some(value => value?.status === 'policy_refresh_required'
            || ['out_of_scope', 'no_business_facts'].includes(value?.relevance));
        if (unnamedVoiceClient(resolved.client)) {
            const declaredNames = [...new Map(callEvents.map(call => declaredCallerName(call.transcript)).filter(Boolean)
                .map(name => [name.toLocaleLowerCase('ru-RU'), name])).values()];
            if (declaredNames.length === 1) resolved.client = {...resolved.client, senderName: declaredNames[0]};
        }
        const memory = this.buildMemorySnapshot({ profile: fallbackAllowed ? safeProfile : null,
            messages: fallbackAllowed ? messages : [], callEvents: fallbackAllowed ? callEvents : [],
            generated: readyGenerated, generatedCall: generatedCall?.source_complete ? generatedCall : null });
        if (!readyGenerated && generated) Object.assign(memory, {
            summary_status: generated.status, summary_provenance: generated.provenance,
            summary_source_complete: false,
        });
        const enrichedProfile = safeProfile || generated || callEvents.length ? {
            ...(fallbackAllowed ? safeProfile : {}),
            ...(readyGenerated ? {needs:readyGenerated.needs,budget:readyGenerated.budget} : {}),
            interests: memory.interests,
            objections: memory.objections,
            importantDates: memory.important_dates,
            keyFacts: memory.key_facts,
            lastCallSummary: memory.last_call_summary,
            lastCallAt: memory.last_call_at,
            callCount: memory.recent_calls_count,
        } : null;
        const nextAction = this.nextActionFor({
            client: resolved.client,
            profile: enrichedProfile,
            lastUserText: readyGenerated || !fallbackAllowed ? '' : lastUser?.content || resolved.client?.lastMessage || '',
            businessType,
            coffeeContext
        });
        const availableChannels = this.followupChannelTargets(resolved.instanceId, resolved.chatId);
        const summary = [
            `Клиент: ${resolved.client.senderName || 'без имени'}.`,
            `Статус: ${resolved.client.leadStatus || 'new'}.`,
            availableChannels.length ? `Подключённые каналы клиента: ${[...new Set(availableChannels.map(c => c.label))].join(', ')}. Номер звонка не заменяет привязанный адрес канала.` : 'Привязанных каналов для отправки сейчас нет.',
            enrichedProfile?.needs ? `Потребность: ${clip(enrichedProfile.needs, 120)}.` : null,
            enrichedProfile?.budget ? `Бюджет: ${clip(enrichedProfile.budget, 80)}.` : null,
            enrichedProfile?.interests?.length ? `Интерес: ${enrichedProfile.interests.slice(0, 3).join(', ')}.` : null,
            enrichedProfile?.importantDates?.length ? `Важные даты: ${enrichedProfile.importantDates.slice(0, 3).join(', ')}.` : null,
            enrichedProfile?.objections?.length ? `Возражения: ${enrichedProfile.objections.slice(0, 3).map((item) => humanizeObjection(item)).join(', ')}.` : null,
            readyGenerated ? readyGenerated.summary : fallbackAllowed && lastUser?.content ? `Последнее сообщение: ${clip(lastUser.content, 160)}.` : null,
            memory.last_call_summary ? `Последний звонок: ${clip(memory.last_call_summary, 160)}.` : null,
            ...this.coffeeContextSummary(coffeeContext),
            pmsContext?.upcoming_bookings?.length
                ? `Bnovo: ${pmsContext.upcoming_bookings.slice(0, 2).map((booking) => `${booking.booking_number || 'бронь'} ${booking.arrival || ''}—${booking.departure || ''}, ${booking.status || ''}`).join('; ')}.`
                : null,
            `Следующий шаг: ${nextAction.message}.`
        ].filter(Boolean).join(' ');

        return {
            ...resolved,
            business_type: businessType,
            available_channels: availableChannels.map(({channel,label}) => ({channel,label})),
            profile: enrichedProfile,
            memory,
            coffee_context: coffeeContext,
            pms_context: pmsContext,
            summary_for_voice: summary,
            next_action: nextAction,
            spoken: summary
        };
    }

    extractOutboundOpeningText(raw) {
        if (!raw) return '';
        let text = String(raw || '')
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/g, '')
            .trim();

        const jsonCandidates = [];
        jsonCandidates.push(text);
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) jsonCandidates.push(jsonMatch[0]);

        for (const candidate of jsonCandidates) {
            try {
                const parsed = JSON.parse(candidate);
                for (const key of ['opening', 'outbound_opening', 'greeting', 'reply', 'text']) {
                    if (typeof parsed?.[key] === 'string' && parsed[key].trim()) {
                        text = parsed[key].trim();
                        break;
                    }
                }
            } catch (_) {
                // Plain text is expected for most models.
            }
        }

        text = text
            .split(/\n+/)
            .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
            .find(Boolean) || '';
        text = text
            .replace(/^["'«»]+|["'«»]+$/g, '')
            .replace(/^(?:анастасия|ava|ава|ассистент)\s*[:—-]\s*/i, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (/чем\s+могу\s+помочь/i.test(text)) return '';
        if (!text) return '';
        if (!/^(здравствуйте|добрый\s+день|добрый\s+вечер|приветствую)/i.test(text)) {
            text = `Здравствуйте. ${text}`;
        }
        return clip(text, 360);
    }

    outboundOpeningFallback(input = {}) {
        const personaName = clip(input.personaName || input.persona_name || 'Анастасия', 40);
        const businessName = clip(input.businessName || input.business_name || 'отеля Ava', 80);
        return `Здравствуйте, это ${personaName} из ${businessName}. Звоню по вашему недавнему обращению, удобно сейчас коротко поговорить?`;
    }

    async generateOutboundOpening(input = {}) {
        const direction = String(input.direction || input.call_direction || 'outbound').toLowerCase();
        if (direction && direction !== 'outbound') {
            return { success: true, skipped: true, opening: '', spoken: '' };
        }

        const outboundCustomVars = parseJson(input.outboundCustomVars || input.outbound_custom_vars, {});
        const instanceId = Number(
            input.instanceId
            || input.instance_id
            || outboundCustomVars.sales_brain_instance_id
            || this.defaultInstanceId()
        );
        const instance = await DB.getInstance(instanceId);
        const phone = digits(input.phone || input.caller_number || outboundCustomVars.phone || '');
        const chatId = input.chatId || input.chat_id || outboundCustomVars.whatsapp_chat_id || null;
        const personaName = clip(input.personaName || input.persona_name || 'Анастасия', 40);
        const businessName = clip(input.businessName || input.business_name || instance?.name || 'отеля Ava', 80);
        const hotelTone = clip(input.hotelTone || input.hotel_tone || instance?.hotelTone || '', 220);
        const hotelTimezone = clip(input.timezone || input.hotelTimezone || input.hotel_timezone || instance?.hotelTimezone || 'UTC', 80);
        const workingHours = input.workingHours || input.working_hours || input.hotelWorkingHours || instance?.hotelWorkingHours || null;

        let summary = null;
        let timeline = [];
        try {
            summary = await this.customerSummary({ instanceId, phone, chatId });
            if (summary?.found) {
                const timelineResult = await this.getTimeline({
                    instanceId,
                    chatId: summary.chatId,
                    phone,
                    limit: Math.max(5, Math.min(Number(input.timelineLimit || input.timeline_limit || 30), 50))
                });
                timeline = Array.isArray(timelineResult.timeline) ? timelineResult.timeline : [];
            }
        } catch (e) {
            Logger.warn('[SalesBrain] Failed to assemble outbound opening context:', e.message);
        }

        const modelOverride = input.model || input.opening_model || process.env.SALES_BRAIN_OUTBOUND_OPENING_MODEL || null;
        const instanceConfig = {
            aiProvider: instance?.aiProvider,
            geminiModel: instance?.geminiModel,
            yandexGptKey: instance?.yandexGptKey,
            yandexGptFolderId: instance?.yandexGptFolderId,
            yandexGptModelUri: modelOverride || instance?.yandexGptModelUri,
            aiTemperature: input.temperature || process.env.SALES_BRAIN_OUTBOUND_OPENING_TEMPERATURE || 0.65
        };

        const promptContext = {
            task: 'generate_first_outbound_voice_opening',
            persona_name: personaName,
            business_name: businessName,
            hotel_tone: hotelTone,
            hotel_timezone: hotelTimezone,
            hotel_working_hours: workingHours,
            phone,
            campaign_id: input.campaignId || input.campaign_id || outboundCustomVars.sales_brain_campaign_id || null,
            lead_id: input.leadId || input.lead_id || outboundCustomVars.sales_brain_lead_id || null,
            context_id: input.contextId || input.context_id || null,
            customer_found: Boolean(summary?.found),
            customer_name: summary?.client?.senderName || input.callerName || input.caller_name || outboundCustomVars.caller_name || null,
            lead_stage: summary?.client?.leadStatus || outboundCustomVars.lead_stage || null,
            summary_for_voice: summary?.summary_for_voice || outboundCustomVars.sales_brain_summary || '',
            known_needs: summary?.profile?.needs || null,
            known_objections: summary?.profile?.objections || [],
            interests: summary?.profile?.interests || [],
            important_dates: summary?.profile?.importantDates || [],
            last_call_summary: summary?.profile?.lastCallSummary || null,
            key_facts: summary?.profile?.keyFacts || [],
            recommended_next_action: summary?.next_action?.message || '',
            recent_timeline: timeline.slice(-30).map((item) => ({
                type: item.type,
                channel: item.channel,
                role: item.role,
                content: clip(item.content, 500),
                timestamp: item.timestamp
            })),
            outbound_custom_vars: outboundCustomVars
        };

        const systemMessage = {
            role: 'system',
            content: `Ты пишешь ПЕРВУЮ фразу для исходящего голосового звонка клиенту.

Жесткие правила:
• Говорит ${personaName} из ${businessName}.
${hotelTone ? `• Тон общения отеля: ${hotelTone}.` : '• Тон общения: спокойный, вежливый, без давления.'}
• Учитывай timezone отеля: ${hotelTimezone}.
• Верни только готовую реплику, без JSON, markdown, вариантов и пояснений.
• 1-2 коротких разговорных предложения, до 35 слов.
• Не говори "чем могу помочь" и не звучите как входящий автоответчик.
• Естественно используй контекст клиента: что он спрашивал, что ему нужно, следующий шаг.
• Не цитируй внутренние поля CRM, ID, статусы, raw transcript.
• Не выдумывай факты. Если контекста мало, скажи "по вашему недавнему обращению".
• В конце мягко спроси, удобно ли сейчас коротко поговорить.`
        };
        const userMessage = {
            role: 'user',
            content: `Контекст клиента для звонка:\n${JSON.stringify(promptContext, null, 2)}`
        };

        let opening = '';
        let fallbackUsed = false;
        let raw = '';
        try {
            raw = await AIService.generatePlainText([systemMessage, userMessage], instanceConfig);
            opening = this.extractOutboundOpeningText(raw);
        } catch (e) {
            fallbackUsed = true;
            Logger.warn('[SalesBrain] Outbound opening generation failed:', e.message);
        }

        if (!opening) {
            fallbackUsed = true;
            opening = this.outboundOpeningFallback({ personaName, businessName });
        }

        try {
            DB.createMlDecision({
                instanceId,
                chatId: summary?.chatId || chatId || null,
                customerId: summary?.customer_id || null,
                taskType: 'outbound_opening',
                model: instanceConfig.yandexGptModelUri || null,
                promptVersion: 'outbound_opening_v1',
                output: {
                    opening,
                    fallback_used: fallbackUsed,
                    customer_found: Boolean(summary?.found),
                    campaign_id: promptContext.campaign_id,
                    lead_id: promptContext.lead_id
                },
                confidence: fallbackUsed ? 0.35 : 0.75
            });
        } catch (e) {
            Logger.debug('[SalesBrain] Failed to persist outbound opening decision:', e.message);
        }

        return {
            success: true,
            opening,
            generated_opening: opening,
            outbound_opening: opening,
            fallback_used: fallbackUsed,
            customer_found: Boolean(summary?.found),
            customer_name: summary?.client?.senderName || null,
            lead_stage: summary?.client?.leadStatus || null,
            summary_for_voice: summary?.summary_for_voice || '',
            recommended_next_action: summary?.next_action?.message || '',
            chatId: summary?.chatId || chatId || null,
            customer_id: summary?.customer_id || null,
            model: instanceConfig.yandexGptModelUri || null,
            spoken: opening
        };
    }

    async assembleContext(input = {}) {
        const resolved = await this.ensureVoiceCustomer(input);
        const summary = await this.customerSummary({ ...input,
            ...(resolved.found ? { chatId: resolved.chatId } : {}) });
        const autopilotAllowance = require('./ava-autopilot.service').voiceAllowance(resolved.instanceId || Number(input.instanceId || input.business_id), resolved.chatId, {callId:input.callId || input.call_id || null,voicePhase:input.voicePhase || 'before_start'});
        const autopilotGate = {autopilot_activated:Boolean(autopilotAllowance?.activated),autopilot_allowed:autopilotAllowance?.allowed ?? true,autopilot_reason:autopilotAllowance?.reason || '',autopilot_policy_revision:autopilotAllowance?.policyRevision || 0,autopilot_allowed_actions:autopilotAllowance?.allowedActions || []};
        if (autopilotAllowance && !autopilotAllowance.allowed) return {...summary,...autopilotGate,autopilot:autopilotAllowance,requires_manager:true,allowed_tools:['mcp_sales_create_manager_task'],spoken:'Обращение должен продолжить менеджер.'};
        if (!summary.found) {
            return {
                ...summary,
                ...autopilotGate,
                customer_found: false,
                allowed_tools: ['mcp_sales_answer_from_knowledge', 'mcp_sales_create_manager_task']
            };
        }
        return {
            ...autopilotGate,
            customer_found: true,
            available_channels: summary.available_channels || [],
            customer_name: summary.client.senderName,
            lead_stage: summary.client.leadStatus,
            summary_for_voice: summary.summary_for_voice,
            known_needs: summary.profile?.needs || null,
            known_objections: summary.profile?.objections || [],
            interests: summary.profile?.interests || [],
            important_dates: summary.profile?.importantDates || [],
            key_facts: summary.profile?.keyFacts || [],
            last_call_summary: summary.profile?.lastCallSummary || null,
            business_type: summary.business_type,
            coffee_context: summary.coffee_context || null,
            recommended_next_action: summary.next_action.message,
            allowed_tools: [
                'mcp_sales_customer_summary',
                'mcp_sales_answer_from_knowledge',
                'mcp_sales_get_next_action',
                'mcp_sales_create_crm_note',
                'mcp_sales_create_manager_task',
                'mcp_sales_draft_whatsapp_followup',
                'mcp_sales_send_whatsapp_followup',
                'mcp_sales_draft_followup',
                'mcp_sales_send_followup'
            ],
            identity_confidence: summary.identity_confidence,
            customer_id: summary.customer_id,
            chatId: summary.chatId,
            spoken: summary.summary_for_voice
        };
    }

    async reply(input = {}) {
        const instanceId = this.businessScope(input);
        const instance = await DB.getInstance(instanceId);
        if (!instance) throw new Error('Instance not found');
        const resolved = await this.resolveCustomer({...input, instanceId});
        const customer = resolved.found ? require('./channel-customer-context.service').aiContext(instanceId, resolved.chatId) : {};
        const context = {
            ...customer,
            clientName: resolved.client?.senderName || input.clientName || 'Клиент',
            leadStatus: resolved.client?.leadStatus || input.leadStatus || 'new',
            systemPrompt: instance.systemPrompt || 'Ты полезный sales assistant.',
            yclientsLink: instance.yclientsLink,
            salesGoal: instance.salesGoal || 'call',
            instanceId,
            ragContext: input.ragContext || '',
            ragSearched: Boolean(input.ragContext),
            instanceConfig: {
                aiProvider: instance.aiProvider,
                geminiModel: instance.geminiModel,
                yandexGptKey: instance.yandexGptKey,
                yandexGptFolderId: instance.yandexGptFolderId,
                yandexGptModelUri: instance.yandexGptModelUri,
                aiTemperature: instance.aiTemperature,
                aiResponseFormat: instance.aiResponseFormat,
            }
        };
        const result = await AIService.getResponse(input.history || [], context);
        DB.createMlDecision({
            instanceId,
            chatId: resolved.chatId || null,
            taskType: 'sales_chat_reply',
            model: AIService.providerSelection(instance).model,
            output: result,
            confidence: result?.status ? 0.7 : 0.3,
        });
        return { success: true, response: result };
    }

    confirmedBusinessEvidence(input = {}) {
        const instanceId = Number(input.instanceId || input.instance_id);
        const chatId = input.chatId || input.chat_id;
        if (!Number.isSafeInteger(instanceId) || instanceId < 1 || !chatId) return null;
        const identities = require('./client-identity.service');
        const canonical = identities.resolve(instanceId, chatId);
        const client = DB.get('SELECT * FROM clients WHERE instanceId=? AND chatId=?', [instanceId, canonical]);
        if (!client) return null;
        const primaryPhone = canonicalPhone(client.chatId);
        const phones = new Set(primaryPhone ? [primaryPhone] : []);
        // Opaque Telegram/LID clients have phone proof only through confirmed
        // aliases. Never reinterpret their numeric identifier as a phone.
        for (const alias of DB.all("SELECT kind,value FROM client_aliases WHERE instanceId=? AND chatId=? AND kind IN ('phone','whatsapp')", [instanceId, canonical])) {
            const phone = canonicalPhone(alias.value);
            if (phone && identities.resolve(instanceId, phone) === canonical) phones.add(phone);
        }
        for (const link of DB.getIdentityLinksByChat(instanceId, canonical)) {
            const phone = canonicalPhone(link.normalizedPhone);
            if (phone && ['phone', 'phone_alias', 'whatsapp'].includes(link.linkType)
                && link.customerId === `crm_${instanceId}_${client.id}`
                && (link.confidence === 'manual' || (link.confidence === 'exact' && phone === primaryPhone))) phones.add(phone);
        }
        const runs = input.toolRuns || input.tool_runs;
        for (const raw of Array.isArray(runs) ? runs : []) {
            const run = normalizeToolRun(raw);
            if (run.status !== 'ok') continue;
            const result = run.result;
            const paymentId = result.payment_id || result.paymentId || result.payment?.payment_id || result.payment?.paymentId;
            if (paymentId && /payment|оплат/.test(run.name)) {
                const payment = DB.get('SELECT paymentId, status FROM payments WHERE instanceId=? AND chatId=? AND paymentId=?', [instanceId, canonical, String(paymentId)]);
                if (payment && ['paid', 'succeeded', 'completed'].includes(String(payment.status).toLowerCase())) {
                    return { kind: 'payment', id: payment.paymentId, status: payment.status };
                }
            }
            const bookingId = result.booking_id ?? result.bookingId ?? result.booking?.booking_id ?? result.booking?.id;
            if (bookingId != null && phones.size && /book|reservation/.test(run.name) && !/request|availability|search|cancel/.test(run.name)) {
                const provider = String(result.provider ?? result.booking?.provider ?? 'bnovo').trim();
                if (!provider || (result.business_id != null && Number(result.business_id) !== instanceId)
                    || (result.booking?.business_id != null && Number(result.booking.business_id) !== instanceId)
                    || (result.provider != null && result.booking?.provider != null && result.provider !== result.booking.provider)) continue;
                // PMS exposes externalBookingId as booking_id; its internal id
                // includes tenant/provider prefixes. Retain exact internal-id
                // compatibility while rejecting ambiguous matches.
                const matches = DB.all('SELECT id, statusCode, statusName, normalizedPhone FROM pms_bookings WHERE businessId=? AND provider=? AND (externalBookingId=? OR id=?)',
                    [instanceId, provider, String(bookingId), String(bookingId)]);
                const booking = matches.length === 1 && phones.has(canonicalPhone(matches[0].normalizedPhone)) ? matches[0] : null;
                const statuses = [booking?.statusCode, booking?.statusName].filter(Boolean).map((status) => String(status).toLowerCase());
                if (booking && statuses.some((status) => /^(confirmed|booked|paid|checked_in|checked_out|подтверждена|подтверждено|оплачена|заселен|заселён)$/.test(status))
                    && !statuses.some((status) => /cancel|отмен|аннул|no.?show/.test(status))) {
                    return { kind: 'booking', id: booking.id, status: booking.statusName || booking.statusCode };
                }
            }
        }
        return null;
    }

    classifyStage(input = {}) {
        const text = transcriptGuestText(input.transcript || input.text || input.message || '');
        const allowedStatuses = Array.isArray(input.allowedStatuses) && input.allowedStatuses.length
            ? input.allowedStatuses
            : VALID_STATUSES;
        const previous = allowedStatuses.includes(input.previous_stage || input.previousStage) ? (input.previous_stage || input.previousStage) : 'new';
        let stage = previous;
        let confidence = 0.55;
        let reason = 'No stronger evidence found; keeping previous stage.';

        const businessEvidence = this.confirmedBusinessEvidence(input);
        if (businessEvidence) {
            stage = 'booked'; confidence = 0.99; reason = 'Confirmed persisted business result linked to a successful tool.';
        } else if (/(цена|стоим|прайс|сколько|offer|предложен|коммерческ)/i.test(text)) {
            stage = 'offer'; confidence = 0.76; reason = 'Price or proposal discussion detected.';
        } else if (/(детал|интеграц|требован|аудит|задач|процесс|crm|pms)/i.test(text)) {
            stage = 'audit'; confidence = 0.7; reason = 'Detailed business/process discussion detected.';
        } else if (/(интерес|нужно|хочу|ищу|актуально|проблем|лид|заявк)/i.test(text)) {
            stage = 'qualified'; confidence = 0.66; reason = 'Need or buying interest detected.';
        } else if (/(не интересно|не надо|отказ|спам|отпиш|stop|unsubscribe)/i.test(text)) {
            stage = 'junk'; confidence = 0.86; reason = 'Explicit refusal or opt-out detected.';
        }

        if (!allowedStatuses.includes(stage)) {
            reason = `Classifier proposed ${stage}, but this business allows only: ${allowedStatuses.join(', ')}.`;
            stage = previous;
            confidence = 0.35;
        }

        const guarded = this.applyStageGuard(previous, stage, reason);
        return {
            current_stage: guarded.stage,
            previous_stage: previous,
            should_update: guarded.stage !== previous,
            confidence: guarded.allowed ? confidence : Math.min(confidence, 0.4),
            reasoning: guarded.reason,
            evidence: [
                ...(text ? [{ channel: input.channel || 'unknown', quote: clip(text, 180) }] : []),
                ...(businessEvidence ? [{ channel: 'business_record', ...businessEvidence }] : []),
            ]
        };
    }

    applyStageGuard(previous, proposed, reason) {
        if (previous === 'booked' && proposed !== 'booked') {
            return { stage: previous, allowed: false, reason: 'Guard blocked automatic downgrade from booked.' };
        }
        if (proposed === 'junk' && !/refusal|opt-out|отказ|не интересно|unsubscribe/i.test(reason)) {
            return { stage: previous, allowed: false, reason: 'Guard blocked junk without explicit refusal evidence.' };
        }
        const prevIdx = STAGE_ORDER.indexOf(previous);
        const nextIdx = STAGE_ORDER.indexOf(proposed);
        if (prevIdx >= 0 && nextIdx >= 0 && nextIdx < prevIdx && previous !== proposed) {
            return { stage: previous, allowed: false, reason: 'Guard blocked automatic stage downgrade.' };
        }
        return { stage: proposed, allowed: true, reason };
    }

    nextActionFor({ client, profile, lastUserText, businessType = 'standard', coffeeContext = null }) {
        const stage = client?.leadStatus || 'new';
        const text = String(lastUserText || client?.lastMessage || '').toLowerCase();
        if (businessType === 'coffee_shop') {
            const readyOrder = coffeeContext?.active_orders?.find((order) => order.status === 'ready');
            if (readyOrder) {
                return { action_type: 'send_reply', priority: 'high', message: `сообщить, что заказ #${readyOrder.id} готов к выдаче` };
            }
            if (coffeeContext?.active_orders?.length > 0) {
                return { action_type: 'create_task', priority: 'normal', message: 'проверить статус активного заказа и не закрывать его без бариста' };
            }
            if (/заказ|кофе|забрать|готов/i.test(text)) {
                return { action_type: 'ask_question', priority: 'normal', message: 'уточнить напиток, время выдачи и имя клиента' };
            }
        }
        if (/менеджер|человек|оператор|позвон/i.test(text)) {
            return { action_type: 'handoff', priority: 'high', message: 'создать задачу менеджеру и передать контекст' };
        }
        if (stage === 'offer') {
            return { action_type: 'draft_followup', priority: 'high', message: 'подготовить короткий follow-up с ценностью и следующим шагом' };
        }
        if (stage === 'audit') {
            return { action_type: 'ask_question', priority: 'normal', message: 'уточнить детали задачи и критерии успеха' };
        }
        if (stage === 'qualified') {
            return { action_type: 'schedule_call', priority: 'normal', message: 'предложить демо или короткий созвон' };
        }
        if (stage === 'booked') {
            return { action_type: 'wait', priority: 'low', message: 'подтвердить детали и не давить продажей' };
        }
        return { action_type: 'ask_question', priority: 'normal', message: 'выявить потребность одним коротким вопросом' };
    }

    async nextAction(input = {}) {
        const summary = await this.customerSummary(input);
        if (!summary.found) {
            return { ...summary, next_action: { action_type: 'ask_question', priority: 'normal', message: 'уточнить контакт и потребность' } };
        }
        return { ...summary, next_action: summary.next_action };
    }

    async answerFromKnowledge(input = {}) {
        const instanceId = Number(input.instanceId || input.instance_id || this.defaultInstanceId());
        const productAnswer = await require('./knowledge-local.service').answerCatalog(instanceId, input.question || input.query,
            { channel: input.channel || 'voice', customerContext: input.customerContext || input.customer_context || null });
        if (productAnswer) return { ...productAnswer, business_id: instanceId, instanceId, knowledgeBaseInstanceId: instanceId };
        // Keep live voice turns off the slower Onyx retrieval path; voice uses
        // this business's own knowledge below when Onyx declines the channel.
        const onyx = await require('./onyx-knowledge.service').answer({
            businessId: instanceId, question: input.question || input.query,
            channel: input.channel === 'whatsapp' ? 'whatsapp' : 'voice',
            chatId: input.chatId || input.chat_id || null,
            correlationId: input.callId || input.call_id || null,
        });
        if (onyx) return { ...onyx, instanceId, knowledgeBaseInstanceId: instanceId };
        let knowledgeBaseInstanceId = instanceId;
        try {
            const hotelProfile = await HotelProfileService.get(instanceId);
            if (hotelProfile?.knowledgeBaseInstanceId) {
                knowledgeBaseInstanceId = Number(hotelProfile.knowledgeBaseInstanceId) || instanceId;
            }
        } catch (error) {
            Logger.warn(`Hotel knowledge profile lookup failed for instance ${instanceId}: ${error.message}`);
        }

        const result = await RAGService.answerFromKnowledge(knowledgeBaseInstanceId, input.question || input.query, {
            channel: input.channel || 'voice',
            customerContext: input.customerContext || input.customer_context || null
        });
        DB.createMlDecision({
            instanceId,
            chatId: input.chatId || input.chat_id || null,
            taskType: 'rag_answer',
            model: 'rag.sqlite_vec.hybrid',
            output: { ...result, knowledgeBaseInstanceId },
            confidence: result.confidence,
            latencyMs: result.response_time_ms || 0
        });
        return {
            ...result,
            business_id: instanceId,
            instanceId,
            knowledgeBaseInstanceId
        };
    }

    async createCrmNote(input = {}, summaryEvidence = null, memoryInput = null) {
        const resolved = await this.resolveCustomer(input);
        const instanceId = resolved.instanceId || Number(input.instanceId || this.defaultInstanceId());
        const chatId = resolved.chatId || input.chatId || null;
        const callId = input.callId || input.call_id || null;
        const saveNote = () => {
            const event = DB.createConversationEvent({
                eventId: input.eventId || input.event_id || null,
                instanceId, chatId, customerId: resolved.customer_id || null,
                channel: input.channel || 'voice', direction: 'internal', role: 'manager_note',
                content: input.note || input.summary || '', callId,
                sourceId: input.sourceId || input.source_id || null,
                metadata: { source: 'sales_brain', kind: 'crm_note', ...(summaryEvidence || {}) }
            }, memoryInput);
            if (!event || Number(event.instanceId) !== Number(instanceId)
                || String(event.callId || '') !== String(callId || '')
                || String(event.chatId || '') !== String(chatId || '')) {
                throw new Error('CRM event was not durably saved for the requested call and customer');
            }
            DB.createToolRun({
                toolRunId: `tool_crm_note_${instanceId}_${createHash('sha256').update(event.eventId).digest('hex')}`,
                instanceId, chatId, customerId: resolved.customer_id || null, callId,
                conversationEventId: event.eventId, toolName: 'create_crm_note',
                phase: input.phase || 'post_call',
                argsRedacted: { has_note: Boolean(input.note || input.summary) },
                resultRedacted: { eventId: event.eventId }, status: 'ok'
            });
            return { success: true, event_id: event.eventId, spoken: 'Заметку сохранил в CRM.' };
        };
        // Only this server-side postCall invocation supplies both evidence
        // arguments. Saving actual call evidence remains possible after takeover.
        if (summaryEvidence !== null && memoryInput !== null) return DB.db.transaction(saveNote).immediate();
        const write = require('./ava-autopilot.service').runVoiceMutation({
            businessId: instanceId, chatId, callId, operation: 'create_crm_note',
            input: { note: input.note || input.summary || '', sourceId: input.sourceId || input.source_id || null,
                eventId: input.eventId || input.event_id || null }
        }, saveNote);
        return { ...write.result, ...(write.idempotent ? { idempotent: true } : {}), action_id: write.action?.id };
    }

    // Builds the Admin UI deep link for a call. Relative on purpose: the task
    // must never carry an absolute host, and the panel is the one from the
    // call-logs troubleshoot work.
    managerTaskCallLink({ callId, instanceId }) {
        if (!callId) return null;
        const params = new URLSearchParams({
            mode: 'troubleshoot',
            call_id: String(callId),
        });
        if (instanceId) params.set('business_id', String(instanceId));
        return `/logs?${params.toString()}`;
    }

    managerTaskView(task) {
        if (!task) return null;
        return {
            task_id: task.taskId,
            instanceId: Number(task.instanceId),
            instance_id: Number(task.instanceId),
            business_id: Number(task.instanceId),
            chatId: task.chatId || null,
            customer_id: task.customerId || null,
            call_id: task.callId || null,
            call_link: this.managerTaskCallLink({ callId: task.callId, instanceId: task.instanceId }),
            phone: task.phone || null,
            customer_name: task.customerName || null,
            summary: task.summary || '',
            reason: task.reason || 'manual',
            priority: task.priority || 'normal',
            status: task.status || 'new',
            source: task.source || 'sales_brain',
            assignee: task.assignee || null,
            assigneeUserId: task.assigneeUserId || null,
            assignee_user_id: task.assigneeUserId || null,
            dueAt: task.dueAt || null,
            due_at: task.dueAt || null,
            resolution_note: task.resolutionNote || null,
            metadata: parseJson(task.metadataJson, {}),
            created_at: task.createdAt,
            updated_at: task.updatedAt,
            closed_at: task.closedAt || null,
        };
    }

    managerTaskAssigneeUserId(instanceId, input = {}, client = null) {
        // Legacy display labels stay visible but never become an authorization key.
        // An explicit canonical assignment wins; otherwise inherit the canonical
        // customer assignment before considering an exact legacy manager ID.
        const candidate = input.assigneeUserId !== undefined ? input.assigneeUserId
            : client?.assigneeUserId || input.manager_id || input.assignee || null;
        if (typeof candidate !== 'string' || !candidate.trim()) return null;
        try {
            const Identity = require('./identity/identity-store');
            if (typeof Identity.authorizeCapability !== 'function') return null;
            const current = Identity.actor(candidate);
            const membership = current.memberships.find(item => Number(item.businessId) === Number(instanceId));
            if (!membership || !['hotel_owner', 'sales_lead', 'manager'].includes(membership.role)) return null;
            Identity.authorizeCapability({ userId: candidate }, instanceId, 'tasks.claim');
            return candidate;
        } catch (_) { return null; }
    }

    async createManagerTask(input = {}) {
        const resolved = await this.resolveCustomer(input);
        const instanceId = resolved.instanceId || Number(input.instanceId || this.defaultInstanceId());
        const callId = input.callId || input.call_id || null;
        const summary = clip(
            input.summary || input.task || input.note || 'Связаться с клиентом',
            800,
        );
        const reason = normalizeManagerTaskReason(input.reason || input.handoff_reason, 'manual');
        const priority = normalizeManagerTaskPriority(input.priority, 'normal');
        const phone = digits(input.phone || input.caller_number || resolved.phone || '');
        const source = String(input.source || 'sales_brain').trim() || 'sales_brain';

        const taskId = input.taskId
            || (callId && input.dedupe_by_call !== false ? `task_handoff_${instanceId}_${safeKey(callId)}` : null);
        const existing = taskId ? DB.getManagerTask(instanceId, taskId) : null;
        if (callId) {
            const requestedBusinessId = Number(input.instanceId || input.instance_id || input.business_id);
            if (!Number.isSafeInteger(requestedBusinessId) || requestedBusinessId < 1
                || requestedBusinessId !== Number(instanceId)) {
                throw Object.assign(new Error('TELEPHONY_TASK_CUSTOMER_UNCONFIRMED'), {
                    code: 'TELEPHONY_TASK_CUSTOMER_UNCONFIRMED', statusCode: 409,
                });
            }
            require('./telephony/call-reconciliation').assertCreationTarget({
                businessId: requestedBusinessId, callId,
                chatId: resolved.chatId, customerId: resolved.customer_id,
                existingTask: existing,
            });
        }
        const event = existing ? DB.getConversationEventById(existing.conversationEventId) : DB.createConversationEvent({
            instanceId,
            chatId: resolved.chatId || input.chatId || null,
            customerId: resolved.customer_id || null,
            channel: 'manager',
            direction: 'internal',
            role: 'task',
            content: summary,
            callId,
            metadata: { priority, reason, source }
        });

        const task = existing || DB.createManagerTask({
            taskId,
            instanceId,
            chatId: resolved.chatId || input.chatId || null,
            customerId: resolved.customer_id || null,
            callId,
            phone: phone || null,
            customerName: resolved.client?.senderName || input.callerName || input.caller_name || null,
            summary,
            reason,
            priority,
            status: 'new',
            source,
            assignee: input.assignee || input.manager_id || resolved.client?.managerId || null,
            assigneeUserId: this.managerTaskAssigneeUserId(instanceId, input, resolved.client),
            dueAt: input.dueAt || input.due_at || null,
            conversationEventId: event?.eventId || existing?.conversationEventId || null,
            metadata: input.metadata || {},
        });

        DB.createToolRun({
            instanceId,
            chatId: resolved.chatId || input.chatId || null,
            customerId: resolved.customer_id || null,
            callId,
            conversationEventId: event?.eventId || existing?.conversationEventId || null,
            toolName: 'create_manager_task',
            phase: input.phase || 'in_call',
            argsRedacted: { priority, reason, source },
            resultRedacted: { eventId: event?.eventId || existing?.conversationEventId || null, taskId: task?.taskId || null },
            status: 'ok'
        });

        return {
            success: true,
            event_id: event?.eventId || existing?.conversationEventId || null,
            task_id: task?.taskId || null,
            task: this.managerTaskView(task),
            idempotent: Boolean(existing),
            spoken: 'Создал задачу менеджеру.'
        };
    }

    // Decides whether a call that already ended still needs a human.
    // Two triggers only: a transfer that did not land, and a guest handoff
    // intent the agent never turned into a task.
    resolveHandoffForCall(input = {}) {
        const toolRuns = (Array.isArray(input.toolRuns || input.tool_runs) ? input.toolRuns || input.tool_runs : []).map(normalizeToolRun);
        if (toolRuns.some((run) => {
            if (!run.name.includes('create_manager_task') || run.status === 'error') return false;
            if (run.status === 'ok') return true;
            const taskId = run.result.task_id || run.result.taskId;
            const task = taskId && input.instanceId ? DB.getManagerTask(input.instanceId, taskId) : null;
            return Boolean(task && task.chatId === input.chatId && task.callId === input.callId && task.status !== 'cancelled');
        })) {
            // The agent already filed it in-call; a second task would be a duplicate.
            return null;
        }

        const outcome = String(input.outcome || '').trim().toLowerCase();
        const signals = Array.isArray(input.handoffSignals) ? input.handoffSignals : [];
        const failedTransfer = signals.find((signal) => String(signal?.type || '') === 'transfer_failed');
        const transfers = toolRuns.filter((run) => run.name.includes('transfer') && !run.name.includes('cancel'));
        const transferred = !failedTransfer && transfers.every((run) => run.status === 'ok')
            && (outcome === 'transferred' || transfers.length > 0);
        if (!transferred && (failedTransfer || transfers.some((run) => run.status !== 'ok'))) {
            return {
                reason: 'transfer_failed',
                detail: {
                    target: failedTransfer?.target || null,
                    dial_status: failedTransfer?.status || transfers.find((run) => run.status !== 'ok')?.status || null,
                },
            };
        }

        if (transferred) return null;

        const intent = detectHandoffIntent(input.transcript);
        if (intent) {
            return { reason: intent.reason, detail: { matched: intent.matched } };
        }
        return null;
    }

    async listManagerTasks(input = {}) {
        const instanceId = Number(input.instanceId || input.instance_id || this.defaultInstanceId());
        const status = input.status ? normalizeManagerTaskStatus(input.status, null) : null;
        if (input.status && !status) {
            return { success: false, error: 'invalid_status', allowed_statuses: MANAGER_TASK_STATUSES };
        }
        const tasks = DB.getManagerTasks(instanceId, {
            status,
            callId: input.callId || input.call_id || null,
            phone: input.phone ? digits(input.phone) : null,
            limit: input.limit,
        });
        const counts = {};
        for (const row of DB.countManagerTasksByStatus(instanceId)) {
            counts[row.status] = Number(row.total || 0);
        }
        return {
            success: true,
            instanceId,
            instance_id: instanceId,
            counts,
            tasks: tasks.map((task) => this.managerTaskView(task)),
        };
    }

    async updateManagerTask(input = {}) {
        const instanceId = Number(input.instanceId || input.instance_id || this.defaultInstanceId());
        const taskId = String(input.taskId || input.task_id || '').trim();
        if (!taskId) {
            return { success: false, error: 'task_id_required' };
        }
        const existing = DB.getManagerTask(instanceId, taskId);
        if (!existing) {
            // Scoped lookup: a task of another instance reads as "not found",
            // never as someone else's row.
            return { success: false, error: 'task_not_found' };
        }

        if (input.actor !== undefined) {
            const actorError = this.salesActorCapabilityError(instanceId, input.actor, 'sales.write');
            if (actorError) return { success: false, error: actorError };
            if (parseJson(existing.metadataJson, {}).assignment_reconciliation_required) return { success: false, error: 'assignment_reconciliation_required' };
            if (!this.salesActorCanAssign(instanceId, input.actor)) {
                if (!existing.assigneeUserId) return { success: false, error: 'task_claim_required' };
                if (existing.assigneeUserId !== this.salesActorUserId(input.actor)) return { success: false, error: 'task_assigned_to_another_manager' };
                if (input.assigneeUserId !== undefined || input.assignee !== undefined) return { success: false, error: 'assignment_capability_required' };
            }
        }
        if (input.assigneeUserId !== undefined || input.assignee !== undefined) {
            try { require('./sales-workspace.service').assertDeliveryMutable(instanceId, { taskId }); }
            catch (error) { return { success: false, error: error.code || 'delivery_pending' }; }
        }
        const patch = {};
        if (input.assigneeUserId !== undefined) {
            if (input.assigneeUserId === null) patch.assigneeUserId = null;
            else {
                const userId = this.managerTaskAssigneeUserId(instanceId, { assigneeUserId: input.assigneeUserId });
                if (!userId) return { success: false, error: 'assignee_not_active' };
                patch.assigneeUserId = userId;
            }
        }
        if (input.dueAt !== undefined || input.due_at !== undefined) {
            const dueAt = input.dueAt !== undefined ? input.dueAt : input.due_at;
            if (dueAt !== null && (typeof dueAt !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(dueAt) || !Number.isFinite(Date.parse(dueAt))))
                return { success: false, error: 'invalid_due_at' };
            patch.dueAt = dueAt === null ? null : new Date(dueAt).toISOString();
        }
        if (input.status !== undefined) {
            const target = String(input.status || '').trim().toLowerCase();
            if (!canTransitionManagerTask(existing.status, target)) {
                return {
                    success: false,
                    error: 'invalid_status_transition',
                    from: existing.status,
                    to: target,
                    allowed_transitions: MANAGER_TASK_TRANSITIONS[existing.status] || [],
                };
            }
            patch.status = target;
        }
        if (input.assignee !== undefined) patch.assignee = clip(input.assignee, 120);
        if (input.priority !== undefined) patch.priority = normalizeManagerTaskPriority(input.priority, existing.priority);
        if (input.summary !== undefined) patch.summary = clip(input.summary, 800);
        if (input.reason !== undefined) patch.reason = normalizeManagerTaskReason(input.reason, existing.reason);
        if (input.resolutionNote !== undefined || input.resolution_note !== undefined) {
            patch.resolutionNote = clip(input.resolutionNote ?? input.resolution_note, 800);
        }

        const updated = DB.updateManagerTask(instanceId, taskId, patch);
        return { success: true, task: this.managerTaskView(updated) };
    }

    async updateStage(input = {}) {
        const resolved = await this.resolveCustomer(input);
        if (!resolved.found || !resolved.chatId) {
            return { success: false, error: 'customer_not_found', spoken: 'Не нашел клиента для обновления статуса.' };
        }
        const targetStage = input.stage || input.lead_stage;
        const instance = await DB.getInstance(resolved.instanceId);
        const allowedStatuses = getStatusesForBusiness(instance || {});
        if (!allowedStatuses.includes(targetStage)) {
            return {
                success: false,
                error: 'invalid_stage',
                allowed_statuses: allowedStatuses,
                business_type: resolveBusinessType(instance || {}),
                spoken: 'Такого статуса воронки нет для этого бизнеса.'
            };
        }
        const callId = input.callId || input.call_id || null;
        const write = require('./ava-autopilot.service').runVoiceMutation({
            businessId: resolved.instanceId, chatId: resolved.chatId, callId,
            operation: 'update_stage', input: { stage: targetStage, reason: input.reason || '' }
        }, ({ client }) => {
            const guarded = this.applyStageGuard(client.leadStatus || 'new', targetStage, input.reason || 'Explicit Sales Brain stage update');
            if (!guarded.allowed) return { success: false, error: 'stage_guard_blocked', decision: guarded, spoken: 'Я не обновил статус: не хватает подтверждения.' };
            DB.updateClientStatusSync(resolved.instanceId, resolved.chatId, targetStage, input.reason || 'Sales Brain update', 'sales_brain');
            DB.createToolRun({
                instanceId: resolved.instanceId, chatId: resolved.chatId, customerId: resolved.customer_id,
                callId, toolName: 'update_lead_stage', phase: input.phase || 'internal',
                argsRedacted: { stage: targetStage }, resultRedacted: { status: 'updated' }, status: 'ok'
            });
            return { success: true, stage: targetStage, spoken: `Обновил статус клиента на ${targetStage}.` };
        });
        return { ...write.result, ...(write.idempotent ? { idempotent: true } : {}), action_id: write.action?.id };
    }

    followupRequest(transcript) {
        const channels = requestedFollowupChannels(transcript);
        return { channels, channel: channels.length === 1 ? channels[0] : null };
    }

    async draftFollowup(input = {}) { return this.draftWhatsAppFollowup(input); }
    async sendFollowup(input = {}) { return this.sendWhatsAppFollowup(input); }

    async draftWhatsAppFollowup(input = {}) {
        const channel = input.channel || 'whatsapp';
        if (!FOLLOWUP_CHANNELS.has(channel)) return { success: false, error: 'unsupported_followup_channel' };
        const summary = await this.customerSummary(input);
        const instanceId = summary.instanceId || Number(input.instanceId || input.instance_id || this.defaultInstanceId());
        const chatId = summary.chatId || input.chatId || input.chat_id || null;
        const targets = chatId ? await this.followupChannels(instanceId, chatId) : [];
        const candidates = input.channel ? targets.filter(item => item.channel === channel && (!input.recipient || item.recipient === String(input.recipient))) : [];
        const target = candidates.length === 1 ? candidates[0] : null;
        if (input.recipient && !target) return { success: false, error: 'channel_not_linked' };
        const text = input.text || (
            summary.found
                ? `Здравствуйте, ${summary.client.senderName || ''}! Коротко зафиксировал наш разговор. ${summary.next_action.message}. Если удобно, могу отправить детали следующим сообщением.`
                : 'Здравствуйте! Спасибо за обращение. Готов отправить короткие детали и следующий шаг.'
        );
        const safeText = clip(text, 500);
        const callId = input.callId || input.call_id || null;

        const draftId = input.draftId
            || (callId && input.dedupe_by_call !== false ? `draft_followup_${instanceId}_${safeKey(callId)}` : null);
        let existing = draftId ? DB.getFollowupDraft(instanceId, draftId) : null;
        if (existing && input.source === 'post_call' && callId) {
            // A voice tool may already have prepared this call's draft. Adopt
            // that untouched row after accepted post-call evidence; do not
            // create a second draft or authorize an edited/attempted send.
            DB.db.transaction(() => {
                const current = DB.getFollowupDraft(instanceId, draftId);
                const source = DB.getConversationEventBySource(instanceId, 'post_call:' + callId);
                if (!current || current.source !== 'sales_brain' || current.status !== 'draft' || current.editedAt
                    || current.approvedAt || current.sentAt || current.attempts || this.followupDeliveryPending(current)
                    || current.chatId !== chatId || current.customerId !== summary.customer_id || current.callId !== callId
                    || !source || source.chatId !== chatId || source.customerId !== summary.customer_id) return;
                const metadata = { ...parseJson(current.metadataJson,{}), ...(input.metadata || {}),
                    ...(input.channel ? {channel,requested_channel:channel} : {}),
                    ...(target ? {recipient:target.recipient} : {}) };
                DB.run('UPDATE followup_drafts SET source=?,managerTaskId=COALESCE(managerTaskId,?),metadataJson=?,updatedAt=CURRENT_TIMESTAMP WHERE instanceId=? AND draftId=?',
                    ['post_call',input.managerTaskId || input.manager_task_id || null,JSON.stringify(metadata),instanceId,draftId]);
                if(current.conversationEventId)DB.run("UPDATE conversation_events SET channel=? WHERE instanceId=? AND eventId=? AND chatId=? AND role='draft'",[channel,instanceId,current.conversationEventId,chatId]);
            }).immediate();
            existing = DB.getFollowupDraft(instanceId, draftId);
        }
        const event = !existing && chatId
            ? DB.createConversationEvent({
                eventId: callId ? `evt_followup_${instanceId}_${createHash('sha256').update(String(callId)).digest('hex')}` : null,
                instanceId,
                chatId,
                customerId: summary.customer_id || null,
                channel,
                direction: 'outbound',
                role: 'draft',
                content: safeText,
                callId,
                metadata: {
                    kind: 'whatsapp_followup_draft',
                    status: 'draft',
                    source: input.source || 'sales_brain',
                    requires_confirmation: true
                }
            })
            : null;

        const draft = existing || DB.createFollowupDraft({
            draftId: draftId || event?.eventId,
            instanceId,
            chatId,
            customerId: summary.customer_id || null,
            callId,
            managerTaskId: input.managerTaskId || input.manager_task_id || null,
            phone: digits(input.phone || input.caller_number || summary.phone || ''),
            originalText: safeText,
            text: safeText,
            status: 'draft',
            source: input.source || 'sales_brain',
            conversationEventId: event?.eventId || null,
            metadata: { ...(input.metadata || {}), ...(input.channel ? { requested_channel: channel, channel } : {}),
                ...(target ? { channel, recipient: target.recipient } : {}) },
        });
        if (!draft) return { success: false, error: 'draft_save_failed' };

        return {
            success: true,
            draft_id: draft?.draftId || event?.eventId || null,
            event_id: event?.eventId || null,
            chatId,
            text: draft?.text || safeText,
            status: draft?.status || 'draft',
            requires_approval: true,
            draft: this.followupDraftView(draft),
            idempotent: Boolean(existing),
            spoken: 'Подготовил черновик follow-up сообщения. Отправит менеджер после проверки.'
        };
    }

    followupDraftView(draft) {
        if (!draft) return null;
        const task = draft.managerTaskId ? DB.getManagerTask(draft.instanceId, draft.managerTaskId) : null;
        const { autoDispatch: _privateAutomaticDispatch, ...publicMetadata } = parseJson(draft.metadataJson, {});
        return {
            draft_id: draft.draftId,
            instanceId: Number(draft.instanceId),
            instance_id: Number(draft.instanceId),
            business_id: Number(draft.instanceId),
            chatId: draft.chatId || null,
            customer_id: draft.customerId || null,
            call_id: draft.callId || null,
            call_link: this.managerTaskCallLink({ callId: draft.callId, instanceId: draft.instanceId }),
            manager_task_id: draft.managerTaskId || null,
            assignee: task?.assignee || null,
            assigneeUserId: task?.assigneeUserId || null,
            assignee_user_id: task?.assigneeUserId || null,
            phone: draft.phone || null,
            text: draft.text || '',
            original_text: draft.originalText || '',
            channel: parseJson(draft.metadataJson, {}).channel || null,
            recipient: parseJson(draft.metadataJson, {}).recipient || null,
            edited: Boolean(draft.editedAt) && draft.text !== draft.originalText,
            status: parseJson(draft.metadataJson, {}).delivery_status || draft.status || 'draft',
            approval_status: draft.status || 'draft',
            source: draft.source || 'sales_brain',
            approved_by: draft.approvedBy || null,
            approved_at: draft.approvedAt || null,
            edited_by: draft.editedBy || null,
            edited_at: draft.editedAt || null,
            sent_at: draft.sentAt || null,
            failure_reason: draft.failureReason || null,
            attempts: Number(draft.attempts || 0),
            metadata: publicMetadata,
            created_at: draft.createdAt,
            updated_at: draft.updatedAt,
        };
    }

    async followupApprovalPolicy(instanceId) {
        const instance = await DB.getInstance(instanceId);
        return {
            auto_send_enabled: followupAutoSendEnabled(instance || {}),
            requires_manager_approval: !followupAutoSendEnabled(instance || {}),
        };
    }

    async sendWhatsAppFollowup(input = {}) {
        if (HIGH_RISK_ACTIONS.has('send_whatsapp_followup') && !input.confirmed) {
            return {
                success: false,
                status: 'needs_confirmation',
                requires_confirmation: true,
                spoken: 'Перед отправкой WhatsApp-сообщения нужно подтверждение.'
            };
        }
        const draftId = input.draftId || input.draft_id || input.eventId || input.event_id || null;
        const scopeHint = Number(input.instanceId || input.instance_id || 0) || null;
        // HTTP actors must be authorized before customer resolution or ad-hoc
        // draft persistence, both of which may write durable rows.
        const initialActorError = this.salesActorCapabilityError(scopeHint, input.actor, 'messages.send');
        if (initialActorError) return { success: false, sent: false, error: initialActorError };
        let draftRow = draftId && scopeHint ? DB.getFollowupDraft(scopeHint, draftId) : null;
        let draftEvent = draftId ? DB.getConversationEventById(draftId) : null;
        const resolved = await this.resolveCustomer({
            ...input,
            chatId: input.chatId || input.chat_id || draftRow?.chatId || draftEvent?.chatId || null,
            instanceId: input.instanceId || input.instance_id || draftRow?.instanceId || draftEvent?.instanceId || undefined
        });
        if (!resolved.found || !resolved.chatId) {
            return { success: false, error: 'customer_not_found', spoken: 'Не нашел клиента для отправки сообщения.' };
        }
        if (!draftRow && draftId) {
            draftRow = DB.getFollowupDraft(resolved.instanceId, draftId);
        }

        if (draftRow && (draftRow.chatId !== resolved.chatId
            || draftRow.customerId && draftRow.customerId !== resolved.customer_id
            || input.voiceRequest === true && draftRow.callId !== (input.callId || input.call_id))) {
            return { success: false, sent: false, error: 'draft_context_mismatch',
                spoken: 'Этот черновик относится к другому обращению. Подготовлю информацию для текущего клиента отдельно.' };
        }

        const requestedText = clip(input.text || '', 500);
        if (!draftRow) {
            // Match an existing pending draft by text before creating a new one,
            // so an ad-hoc send does not queue a duplicate message.
            if (requestedText) {
                draftRow = DB.getFollowupDrafts(resolved.instanceId, { chatId: resolved.chatId, limit: 20 })
                    .find((row) => row.status !== 'sent' && clip(row.text, 500) === requestedText) || null;
            }
            if (!draftRow) {
                const created = await this.draftWhatsAppFollowup({
                    ...input,
                    instanceId: resolved.instanceId,
                    chatId: resolved.chatId,
                    text: requestedText || undefined,
                });
                draftRow = created.draft_id
                    ? DB.getFollowupDraft(resolved.instanceId, created.draft_id)
                    : null;
            }
        }
        if (!draftRow) {
            return { success: false, error: 'draft_not_found', spoken: 'Не нашел черновик follow-up сообщения.' };
        }

        const actorError = this.followupActorError(draftRow, input.actor, 'messages.send');
        if (actorError) return { success: false, sent: false, error: actorError };
        if (this.followupDeliveryPending(draftRow)) return { success: false, sent: false, status: 'pending',
            error: 'delivery_pending', draft: this.followupDraftView(draftRow) };
        if (draftRow.status === 'sent') {
            // Approving twice must not message the guest twice.
            return {
                success: true,
                sent: false,
                status: 'already_sent',
                idempotent: true,
                draft_id: draftRow.draftId,
                draft: this.followupDraftView(draftRow),
                spoken: 'Это сообщение уже отправлено.'
            };
        }

        // Approval policy. `confirmed` coming from a call is not approval: only
        // an approved draft (or an explicit per-business auto-send opt-in) may
        // reach the guest.
        const policy = await this.followupApprovalPolicy(resolved.instanceId);
        if (draftRow.status !== 'approved' && (policy.requires_manager_approval
            || require('./postcall-followup.service').requiresApproval(draftRow, input.autoDispatchToken))) {
            if (input.voiceRequest === true && input.actor === undefined && policy.auto_send_enabled
                && require('./postcall-followup.service').policy(DB.get('SELECT * FROM instances WHERE id=?', [resolved.instanceId])).enabled
                && draftRow.callId && draftRow.callId === (input.callId || input.call_id)
                && draftRow.source === 'sales_brain' && draftRow.status === 'draft' && !draftRow.editedAt && !draftRow.attempts) {
                return { success: true, sent: false, status: 'awaiting_call_completion', draft_id: draftRow.draftId,
                    spoken: 'Запрос записан. После разговора проверю информацию и отправлю её в выбранный канал. Если отправить не получится, обращение останется у менеджера.' };
            }
            return {
                success: false,
                sent: false,
                status: 'needs_approval',
                error: 'needs_approval',
                requires_approval: true,
                draft_id: draftRow.draftId,
                draft_status: draftRow.status,
                draft: this.followupDraftView(draftRow),
                approvals_url: '/followups',
                spoken: 'Черновик готов, но отправит его менеджер после проверки.'
            };
        }

        // Grounded post-call material can be longer than the manual composer.
        // Preserve its checked conditions rather than clipping them at send.
        const text = clip(draftRow.text || requestedText || '', 2200);
        const selection = parseJson(draftRow.metadataJson, {});
        const selectedChannel = selection.channel || 'whatsapp';
        if (input.channel && input.channel !== selectedChannel) return { success: false, sent: false, error: 'draft_channel_mismatch' };
        const recipient = selection.recipient || resolved.chatId;
        if (selection.recipient && !(await this.followupChannels(resolved.instanceId, resolved.chatId)).some(a => a.channel === selectedChannel && a.recipient === recipient))
            return { success: false, sent: false, error: 'channel_not_linked' };
        // The claim and final live authorization share a write transaction:
        // role revocation or reassignment cannot race between these two checks.
        const sendingSnapshot = draftRow;
        const Workspace = require('./ava-workspace.store');
        const AutopilotStore = require('./ava-autopilot.store');
        Workspace.ensureSchema(); AutopilotStore.ensureSchema();
        let providerStarted = false;
        const sendId = `followup:${resolved.instanceId}:${draftRow.draftId}:${Number(draftRow.attempts || 0) + 1}`;
        const claimResult = DB.db.transaction(() => {
            const current = DB.getFollowupDraft(resolved.instanceId, sendingSnapshot.draftId);
            if (!current) return { error: 'draft_not_found' };
            const currentActorError = this.followupActorError(current, input.actor, 'messages.send');
            if (currentActorError) return { error: currentActorError };
            if (current.status !== 'approved' && !require('./postcall-followup.service').automaticSendAllowed(current, input.autoDispatchToken)) return { error: 'needs_approval' };
            if (this.followupDeliveryPending(current)) return { error: 'delivery_pending', status: 'pending' };
            if (current.status === 'sent') return { sentAlready: true, draft: current };
            const currentSelection = parseJson(current.metadataJson, {});
            if (current.text !== sendingSnapshot.text || current.status !== sendingSnapshot.status
                || currentSelection.channel !== selection.channel || currentSelection.recipient !== selection.recipient)
                return { error: 'draft_changed_retry_required' };
            const aiPolicy = AutopilotStore.policy(resolved.instanceId);
            // Raw legacy follow-up drafts are outside published catalog/scenario
            // actions. An authenticated manager can still review and send them.
            if (input.actor === undefined && aiPolicy?.activated) return { error: 'AUTOPILOT_ACTION_NOT_ALLOWED' };
            let control;
            try {
                control = input.actor === undefined
                    ? Workspace.assertAiAllowed(resolved.instanceId, resolved.chatId)
                    : Workspace.setControl({ businessId: resolved.instanceId, chatId: resolved.chatId,
                        mode: 'human', reason: 'Менеджер отправляет сообщение после звонка',
                        actorUserId: this.salesActorUserId(input.actor) });
            } catch (error) { return { error: error.code || 'WORKSPACE_CONTROL_CONFLICT' }; }
            // Claim before the provider await. An interrupted send remains
            // pending for reconciliation rather than risking duplicate delivery.
            const claim = DB.run(`UPDATE followup_drafts SET metadataJson = json_set(COALESCE(metadataJson, '{}'), '$.delivery_status', 'pending')
                WHERE instanceId = ? AND draftId = ?
                  AND COALESCE(json_extract(metadataJson, '$.delivery_status'), '') != 'pending'`,
                [resolved.instanceId, current.draftId]);
            return claim.changes ? { draft: current, control } : { error: 'delivery_pending', status: 'pending' };
        }).immediate();
        if (claimResult.error) return { success: false, sent: false, error: claimResult.error,
            ...(claimResult.status ? { status: claimResult.status } : {}),
            draft: this.followupDraftView(DB.getFollowupDraft(resolved.instanceId, sendingSnapshot.draftId)) };
        draftRow = claimResult.draft;
        if (claimResult.sentAlready) return { success: true, sent: false, status: 'already_sent', idempotent: true,
            draft: this.followupDraftView(draftRow) };
        // Reauthorize at the actual provider boundary after channel/config
        // preparation. The shared slot also fences WhatsApp AI and manual sends.
        const beforeSend = () => DB.db.transaction(() => {
            const current = DB.getFollowupDraft(resolved.instanceId, draftRow.draftId);
            const actorError = current ? this.followupActorError(current, input.actor, 'messages.send') : 'draft_not_found';
            if (actorError) throw Object.assign(new Error(actorError), { code: actorError, statusCode: 403 });
            if (!DB.get('SELECT 1 FROM instances WHERE id=? AND isActive=1', [resolved.instanceId]))
                throw Object.assign(new Error('BUSINESS_NOT_FOUND'), { code: 'BUSINESS_NOT_FOUND', statusCode: 404 });
            if (current.status !== 'approved' && !require('./postcall-followup.service').automaticSendAllowed(current, input.autoDispatchToken))
                throw Object.assign(new Error('FOLLOWUP_POLICY_CHANGED'), { code: 'FOLLOWUP_POLICY_CHANGED', statusCode: 409 });
            const currentSelection = parseJson(current.metadataJson, {});
            if (current.text !== sendingSnapshot.text || current.status !== sendingSnapshot.status
                || currentSelection.channel !== selection.channel || currentSelection.recipient !== selection.recipient)
                throw Object.assign(new Error('draft_changed_retry_required'), { code: 'draft_changed_retry_required', statusCode: 409 });
            if (selection.recipient) {
                const linked = this.followupChannelTargets(resolved.instanceId, resolved.chatId)
                    .some(target => target.channel === selectedChannel && target.recipient === recipient);
                if (!linked) throw Object.assign(new Error('channel_not_linked'), { code: 'channel_not_linked', statusCode: 409 });
            }
            if (input.actor === undefined) {
                if (AutopilotStore.policy(resolved.instanceId)?.activated)
                    throw Object.assign(new Error('AUTOPILOT_ACTION_NOT_ALLOWED'), { code: 'AUTOPILOT_ACTION_NOT_ALLOWED', statusCode: 409 });
                Workspace.beginAiSend({ businessId: resolved.instanceId, chatId: resolved.chatId, revision: claimResult.control.revision, sendId });
            } else {
                Workspace.beginHumanSend({ businessId: resolved.instanceId, chatId: resolved.chatId, revision: claimResult.control.revision, sendId });
            }
            providerStarted = true;
        }).immediate();
        const finishSlot = (status) => {
            if (providerStarted) Workspace.endAiSend({ businessId: resolved.instanceId, chatId: resolved.chatId, sendId, status });
        };
        let sendResult;
        try {
            sendResult = await ChannelRouter.sendMessageDetailed(resolved.instanceId,
                selectedChannel === 'whatsapp' ? recipient : resolved.chatId, text, selectedChannel,
                { beforeSend, origin: input.actor === undefined ? 'legacy_ai_followup' : 'authenticated_customer_reply',
                    businessId: resolved.instanceId, idempotencyKey: sendId });
        } catch (error) {
            sendResult = { success: false, unknown: providerStarted, safeToRetry: !providerStarted,
                error: providerStarted ? 'delivery_unconfirmed' : error.code || 'channel_preflight_failed' };
        }
        if (!sendResult || sendResult.pending === true || sendResult.unknown === true
            || FOLLOWUP_IN_FLIGHT_STATUSES.has(String(sendResult.status || '').toLowerCase())
            || providerStarted && sendResult.success !== true && sendResult.safeToRetry !== true
            || providerStarted && selectedChannel === 'whatsapp' && sendResult.success === true && !sendResult.provider_message_id) {
            finishSlot('unknown');
            return { success: false, sent: false, status: 'pending', error: 'delivery_pending',
                draft: this.followupDraftView(DB.getFollowupDraft(resolved.instanceId, draftRow.draftId)) };
        }
        const ok = sendResult.success === true && sendResult.pending !== true && sendResult.status !== 'pending';
        finishSlot(ok ? 'sent' : 'failed');
        if (ok && sendResult.stored_message_id) {
            try {
                if (input.actor !== undefined) Workspace.recordManualMessage({ businessId: resolved.instanceId,
                    chatId: resolved.chatId, messageId: sendResult.stored_message_id, userId: this.salesActorUserId(input.actor) });
                Workspace.ingestPromises({ businessId: resolved.instanceId, chatId: resolved.chatId,
                    sourceType: 'message', sourceId: String(sendResult.stored_message_id) });
            } catch (_) { Logger.warn('[SalesBrain] Promise extraction requires reconciliation after acknowledged follow-up'); }
        }
        const failureReason = ok ? null : (sendResult.error || 'whatsapp_send_failed');
        // A delivery failure keeps the approval: the manager fixes WhatsApp and
        // retries instead of re-approving from scratch.
        const nextStatus = ok ? 'sent' : draftRow.status === 'approved' ? 'approved' : 'draft';
        const updatedDraft = DB.updateFollowupDraft(resolved.instanceId, draftRow.draftId, {
            status: nextStatus,
            sentAt: ok ? isoNow() : null,
            failureReason,
            attempts: Number(draftRow.attempts || 0) + 1,
            metadata: {
                delivery_status: ok ? 'sent' : 'failed',
                whatsapp_state: sendResult.state || null,
                last_attempt_at: isoNow(),
            },
        });

        const targetDraftEvent = draftRow.conversationEventId
            ? DB.getConversationEventById(draftRow.conversationEventId)
            : draftEvent;
        if (targetDraftEvent) {
            DB.updateConversationEvent(targetDraftEvent.eventId, {
                content: text,
                metadata: {
                    status: ok ? 'sent' : 'draft',
                    sent_at: ok ? isoNow() : null,
                    error: failureReason,
                    whatsapp_state: sendResult.state || null,
                    last_attempt_at: isoNow()
                }
            });
        }

        // Audit: who approved, what went out, how it ended.
        DB.createToolRun({
            instanceId: resolved.instanceId,
            chatId: resolved.chatId,
            customerId: resolved.customer_id,
            callId: draftRow.callId || null,
            toolName: 'send_whatsapp_followup',
            phase: input.phase || 'in_call',
            argsRedacted: {
                draft_id: draftRow.draftId,
                approved_by: draftRow.approvedBy || null,
                approved_at: draftRow.approvedAt || null,
                edited: Boolean(draftRow.editedAt) && draftRow.text !== draftRow.originalText,
                auto_send_policy: policy.auto_send_enabled,
                text_len: text.length
            },
            resultRedacted: {
                sent: Boolean(ok),
                error: failureReason,
                whatsapp_state: sendResult.state || null,
                attempts: Number(updatedDraft?.attempts || 0)
            },
            status: ok ? 'ok' : 'error'
        });

        if (sendResult.error === 'whatsapp_not_authorized') {
            return {
                success: false,
                sent: false,
                status: 'whatsapp_not_authorized',
                error: 'whatsapp_not_authorized',
                whatsapp_state: sendResult.state || 'notAuthorized',
                requires_whatsapp_authorization: true,
                settings_url: '/integrations',
                draft_id: draftRow.draftId,
                draft: this.followupDraftView(updatedDraft),
                spoken: 'WhatsApp сейчас не авторизован. Откройте настройки CRM и отсканируйте QR-код.'
            };
        }
        return {
            success: Boolean(ok),
            sent: Boolean(ok),
            status: ok ? 'sent' : failureReason,
            error: failureReason,
            whatsapp_state: sendResult.state || null,
            draft_id: draftRow.draftId,
            draft: this.followupDraftView(updatedDraft),
            spoken: ok ? `Отправил сообщение в ${FOLLOWUP_CHANNELS.get(selectedChannel) || 'выбранный канал'}.` : 'Не удалось отправить сообщение в выбранный канал.'
        };
    }

    async listFollowupDrafts(input = {}) {
        const explicitScope = Number(input.instanceId || input.instance_id || 0) || null;
        const chatId = input.chatId || input.chat_id || null;
        // A chat filter still resolves the customer; a business-wide queue does
        // not need one, so the manager can review every pending draft at once.
        let instanceId = explicitScope;
        let scopedChatId = chatId;
        if (chatId || input.phone) {
            const resolved = await this.resolveCustomer(input);
            instanceId = resolved.instanceId || explicitScope || this.defaultInstanceId();
            scopedChatId = resolved.chatId || chatId;
        }
        instanceId = Number(instanceId || this.defaultInstanceId());

        const status = input.status ? normalizeFollowupDraftStatus(input.status, null) : null;
        if (input.status && !status) {
            return { success: false, error: 'invalid_status', allowed_statuses: FOLLOWUP_DRAFT_STATUSES };
        }

        const drafts = DB.getFollowupDrafts(instanceId, {
            status,
            chatId: scopedChatId,
            callId: input.callId || input.call_id || null,
            managerTaskId: input.managerTaskId || input.manager_task_id || null,
            limit: input.limit || 50,
        });
        const counts = {};
        for (const row of DB.countFollowupDraftsByStatus(instanceId)) {
            counts[row.status] = Number(row.total || 0);
        }
        return {
            success: true,
            instanceId,
            instance_id: instanceId,
            counts,
            policy: await this.followupApprovalPolicy(instanceId),
            drafts: drafts.map((row) => this.followupDraftView(row)),
        };
    }

    // Pilot analytics: counts for one business over one period. Returns no
    // client rows, phone numbers or message bodies — only aggregates.
    async pilotAnalytics(input = {}) {
        const instanceId = Number(input.instanceId || input.instance_id || this.defaultInstanceId());
        const startAt = input.startAt || input.start_at || null;
        const endAt = input.endAt || input.end_at || null;

        const tasksByStatus = {};
        for (const status of MANAGER_TASK_STATUSES) tasksByStatus[status] = 0;
        for (const row of DB.countManagerTasksInRange(instanceId, startAt, endAt)) {
            tasksByStatus[row.status] = Number(row.total || 0);
        }

        const followupsByStatus = {};
        for (const status of FOLLOWUP_DRAFT_STATUSES) followupsByStatus[status] = 0;
        for (const row of DB.countFollowupDraftsInRange(instanceId, startAt, endAt)) {
            followupsByStatus[row.status] = Number(row.total || 0);
        }

        const instance = await DB.getInstance(instanceId);

        return {
            success: true,
            instanceId,
            instance_id: instanceId,
            // The business timezone travels with the numbers so the UI can label
            // the period without a second round trip.
            timezone: instance?.hotelTimezone || 'UTC',
            business_name: instance?.name || null,
            range: { start_at: startAt, end_at: endAt },
            manager_tasks: {
                created: Object.values(tasksByStatus).reduce((sum, value) => sum + value, 0),
                by_status: tasksByStatus,
            },
            followups: {
                // Only a delivered message counts as sent.
                sent: DB.countFollowupsSentInRange(instanceId, startAt, endAt),
                created: Object.values(followupsByStatus).reduce((sum, value) => sum + value, 0),
                by_status: followupsByStatus,
            },
        };
    }

    followupChannelTargets(instanceId, chatId) {
        const identity = require('./client-identity.service').list(instanceId, chatId);
        const instance = DB.get('SELECT * FROM instances WHERE id=? AND isActive=1', [instanceId]);
        const client = DB.get('SELECT * FROM clients WHERE instanceId=? AND chatId=?', [instanceId, identity.canonicalChatId]);
        if (!instance || !client) return [];
        const explicitWhatsApp = identity.aliases.filter(a => a.kind === 'whatsapp' && a.id != null);
        const targets = (explicitWhatsApp.length ? explicitWhatsApp : identity.aliases.filter(a => a.kind === 'whatsapp'))
            .map(a => ({ channel: a.kind, recipient: a.value, label: 'WhatsApp' }));
        if (!explicitWhatsApp.length && identity.canonicalChatId.endsWith('@c.us')) targets.push({ channel: 'whatsapp', recipient: identity.canonicalChatId, label: 'WhatsApp' });
        const configured = {
            whatsapp: Boolean(require('./whatsapp-gateway.service').getConfig(instance).hasOpenWa || require('./whatsapp-gateway.service').getConfig(instance).hasGreenApi),
            telegram: Boolean(instance.telegramBotToken), email: Boolean(instance.emailSmtpHost && instance.emailSmtpUser),
            vk: Boolean(instance.vkGroupToken), max: Boolean(instance.maxBotToken), avito: false,
        };
        if (DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customer_external_connections'")) {
            const connection = DB.get("SELECT status,capabilitiesJson FROM customer_external_connections WHERE instanceId=? AND provider='avito'",[instanceId]);
            configured.avito = connection?.status === 'connected' && parseJson(connection.capabilitiesJson,{}).send !== false;
        }
        for (const channel of ['telegram','email','vk','max','avito']) if (configured[channel]) {
            const recipient = ChannelRouter._recipient(instanceId, client, channel, client.chatId);
            if (recipient) {
                try { if (channel !== 'avito') require('./client-identity.service').normalize(channel,String(recipient)); }
                catch { continue; }
                targets.push({ channel, recipient: String(recipient), label: FOLLOWUP_CHANNELS.get(channel) });
            }
        }
        return targets.filter((a, i) => targets.findIndex(b => b.channel === a.channel && b.recipient === a.recipient) === i)
            .filter(a => configured[a.channel]);
    }

    async followupChannels(instanceId, chatId) { return this.followupChannelTargets(instanceId, chatId); }

    salesActorUserId(actor) {
        const value = typeof actor === 'string' ? actor : actor?.userId;
        return typeof value === 'string' && value.trim() ? value : null;
    }

    salesActorCapabilityError(instanceId, actor, capability) {
        if (actor === undefined) return null; // Trusted internal callers retain their approval contract.
        const userId = this.salesActorUserId(actor);
        if (!userId) return 'manager_auth_required';
        try {
            const Identity = require('./identity/identity-store');
            if (typeof Identity.authorizeCapability !== 'function') return 'identity_authorization_unavailable';
            Identity.authorizeCapability({ userId }, instanceId, capability);
            return null;
        } catch (error) { return error.code || 'business_access_denied'; }
    }

    salesActorCanAssign(instanceId, actor) {
        if (actor === undefined) return false;
        return !this.salesActorCapabilityError(instanceId, actor, 'sales.assign');
    }

    followupDeliveryPending(draft) {
        const pending = require('./sales-workspace.service').deliveryPending(draft);
        return pending || FOLLOWUP_IN_FLIGHT_STATUSES.has(String(parseJson(draft?.metadataJson, {}).provider_status || '').toLowerCase());
    }

    followupActorError(draft, actor, capability = 'sales.write') {
        const error = this.salesActorCapabilityError(draft.instanceId, actor, capability);
        if (error || actor === undefined) return error;
        const task = draft.managerTaskId ? DB.getManagerTask(draft.instanceId, draft.managerTaskId) : null;
        if (!task || task.chatId !== draft.chatId || (draft.callId && task.callId !== draft.callId)) return 'manager_task_not_linked';
        if (parseJson(task.metadataJson, {}).assignment_reconciliation_required
            || parseJson(draft.metadataJson, {}).assignment_reconciliation_required) return 'assignment_reconciliation_required';
        if (this.salesActorCanAssign(draft.instanceId, actor)) return null;
        if (!task.assigneeUserId) return 'task_claim_required';
        return task.assigneeUserId === this.salesActorUserId(actor) ? null : 'task_assigned_to_another_manager';
    }

    claimFollowupDraft(input = {}) {
        const instanceId = Number(input.instanceId);
        if (!Number.isSafeInteger(instanceId) || instanceId < 1) return { success: false, error: 'business_scope_required' };
        const actorError = this.salesActorCapabilityError(instanceId, input.actor ?? null, 'tasks.claim');
        if (actorError) return { success: false, error: actorError };
        try { return DB.db.transaction(() => {
            let draft = DB.getFollowupDraft(instanceId, input.draftId);
            if (!draft) return { success: false, error: 'draft_not_found' };
            if (this.followupDeliveryPending(draft)) return { success: false, error: 'delivery_pending' };
            if (draft.status === 'sent' || draft.status === 'rejected') return { success: false, error: 'draft_closed' };
            let task = draft.managerTaskId ? DB.getManagerTask(instanceId, draft.managerTaskId) : null;
            if (!draft.managerTaskId) {
                const client = DB.get('SELECT * FROM clients WHERE instanceId = ? AND chatId = ?', [instanceId, draft.chatId]);
                if (!client) return { success: false, error: 'customer_not_found' };
                const taskId = `task_followup_${instanceId}_${createHash('sha256').update(String(draft.draftId)).digest('hex')}`;
                task = DB.createManagerTask({ taskId, instanceId, chatId: draft.chatId,
                    customerId: draft.customerId, callId: draft.callId, phone: draft.phone,
                    summary: 'Проверить и отправить сообщение после звонка',
                    source: 'legacy_followup_claim', status: 'new',
                    assigneeUserId: this.managerTaskAssigneeUserId(instanceId, {}, client) });
                if (!task || task.chatId !== draft.chatId || (draft.callId && task.callId !== draft.callId))
                    throw new Error('Legacy follow-up task could not be linked');
                draft = DB.updateFollowupDraft(instanceId, draft.draftId, { managerTaskId: taskId });
                if (!draft) throw new Error('Legacy follow-up task link was not saved');
            }
            if (!task || task.chatId !== draft.chatId || (draft.callId && task.callId !== draft.callId)) return { success: false, error: 'manager_task_not_linked' };
            // One implementation owns all claim guards, including related drafts
            // whose provider ACK is unresolved. Never fall back to legacy labels.
            const claimed = require('./sales-workspace.service').claimTask(
                { userId: this.salesActorUserId(input.actor) }, instanceId, task.taskId);
            if (!claimed.success) return claimed;
            return { success: true, idempotent: Boolean(claimed.idempotent), draft: this.followupDraftView(draft) };
        }).immediate(); } catch (error) {
            const errors = { SALES_TASK_ASSIGNED: 'task_assigned_to_another_manager',
                SALES_TASK_CLOSED: 'task_closed', SALES_DELIVERY_PENDING: 'delivery_pending' };
            if (!error.code) throw error;
            return { success: false, error: errors[error.code] || error.code };
        }
    }

    async editFollowupDraft(input = {}) {
        const instanceId = Number(input.instanceId || input.instance_id || this.defaultInstanceId());
        const draftId = String(input.draftId || input.draft_id || '').trim();
        if (!draftId) return { success: false, error: 'draft_id_required' };
        const existing = DB.getFollowupDraft(instanceId, draftId);
        if (!existing) return { success: false, error: 'draft_not_found' };
        const actorError = this.followupActorError(existing, input.actor);
        if (actorError) return { success: false, error: actorError };
        if (existing.status === 'sent' || this.followupDeliveryPending(existing)) {
            return { success: false, error: existing.status === 'sent' ? 'draft_already_sent' : 'delivery_pending' };
        }
        if (String(input.text || '').length > 500) return { success: false, error: 'text_too_long', max_length: 500 };
        const text = clip(input.text, 500);
        if (!text) return { success: false, error: 'text_required' };

        const target = input.channel || input.recipient
            ? (await this.followupChannels(instanceId, existing.chatId)).find(a => a.channel === input.channel && a.recipient === String(input.recipient)) : null;
        if ((input.channel || input.recipient) && !target) return { success: false, error: 'channel_not_linked' };
        const current = DB.getFollowupDraft(instanceId, draftId);
        if (!current) return { success: false, error: 'draft_not_found' };
        const currentActorError = this.followupActorError(current, input.actor);
        if (currentActorError) return { success: false, error: currentActorError };
        if (this.followupDeliveryPending(current)) return { success: false, error: 'delivery_pending' };
        if (current.status === 'sent') return { success: false, error: 'draft_already_sent' };
        if (current.status !== existing.status || current.text !== existing.text) return { success: false, error: 'draft_changed_retry_required' };
        // Editing an approved draft drops the approval: a manager must approve
        // the text that will actually be sent, not the one they saw before.
        const status = existing.status === 'approved' ? 'draft' : existing.status;
        const updated = DB.updateFollowupDraft(instanceId, draftId, {
            text,
            status,
            metadata: { delivery_status: null, ...(target ? { channel: target.channel, recipient: target.recipient } : {}) },
            editedBy: this.salesActorUserId(input.actor) || clip(input.editedBy || input.edited_by || 'manager', 120),
            editedAt: isoNow(),
            approvedBy: status === 'draft' ? null : existing.approvedBy,
            approvedAt: status === 'draft' ? null : existing.approvedAt,
        });
        return { success: true, draft: this.followupDraftView(updated) };
    }

    async rejectFollowupDraft(input = {}) {
        const instanceId = Number(input.instanceId || input.instance_id || this.defaultInstanceId());
        const draftId = String(input.draftId || input.draft_id || '').trim();
        if (!draftId) return { success: false, error: 'draft_id_required' };
        const existing = DB.getFollowupDraft(instanceId, draftId);
        if (!existing) return { success: false, error: 'draft_not_found' };
        const actorError = this.followupActorError(existing, input.actor);
        if (actorError) return { success: false, error: actorError };
        if (this.followupDeliveryPending(existing)) return { success: false, error: 'delivery_pending' };
        if (!canTransitionFollowupDraft(existing.status, 'rejected')) {
            return {
                success: false,
                error: 'invalid_status_transition',
                from: existing.status,
                to: 'rejected',
                allowed_transitions: FOLLOWUP_DRAFT_TRANSITIONS[existing.status] || [],
            };
        }
        const updated = DB.updateFollowupDraft(instanceId, draftId, {
            status: 'rejected',
            approvedBy: null,
            approvedAt: null,
            metadata: { rejected_by: this.salesActorUserId(input.actor) || clip(input.rejectedBy || input.rejected_by || 'manager', 120), rejected_at: isoNow() },
        });
        return { success: true, draft: this.followupDraftView(updated) };
    }

    async approveWhatsAppFollowup(input = {}) {
        const draftId = String(input.draftId || input.draft_id || input.eventId || input.event_id || '').trim();
        if (!draftId) {
            return { success: false, error: 'draft_id_required', spoken: 'Не указан черновик для отправки.' };
        }
        const instanceId = Number(input.instanceId || input.instance_id || this.defaultInstanceId());
        const existing = DB.getFollowupDraft(instanceId, draftId);
        if (!existing) {
            return { success: false, error: 'draft_not_found', spoken: 'Не нашел черновик follow-up сообщения.' };
        }
        const actorError = this.followupActorError(existing, input.actor, 'messages.send');
        if (actorError) return { success: false, error: actorError };
        if (this.followupDeliveryPending(existing)) return { success: false, sent: false, status: 'pending',
            error: 'delivery_pending', draft: this.followupDraftView(existing) };
        if (existing.status === 'sent') {
            return {
                success: true,
                sent: false,
                status: 'already_sent',
                idempotent: true,
                draft_id: draftId,
                draft: this.followupDraftView(existing),
                spoken: 'Это сообщение уже отправлено.'
            };
        }
        if (!canTransitionFollowupDraft(existing.status, 'approved')) {
            return {
                success: false,
                error: 'invalid_status_transition',
                from: existing.status,
                to: 'approved',
                allowed_transitions: FOLLOWUP_DRAFT_TRANSITIONS[existing.status] || [],
            };
        }

        if (input.text !== undefined && String(input.text).length > 500) return { success: false, error: 'text_too_long', max_length: 500 };
        // The approval is recorded before the send, so a delivery failure still
        // leaves an auditable "who signed this off".
        const approved = DB.updateFollowupDraft(instanceId, draftId, {
            status: 'approved',
            approvedBy: this.salesActorUserId(input.actor) || clip(input.approvedBy || input.approved_by || 'manager', 120),
            approvedAt: isoNow(),
            failureReason: null,
        });
        if (input.text !== undefined && clip(input.text, 500) && clip(input.text, 500) !== approved.text) {
            // Approving with edited text in one step: record the edit too.
            DB.updateFollowupDraft(instanceId, draftId, {
                text: clip(input.text, 500),
                editedBy: this.salesActorUserId(input.actor) || clip(input.approvedBy || input.approved_by || 'manager', 120),
                editedAt: isoNow(),
            });
        }

        return this.sendWhatsAppFollowup({
            ...input,
            instanceId,
            draftId,
            text: undefined,
            confirmed: true,
        });
    }

    isDoNotCallClient(client) {
        const tags = parseJson(client?.tags, []).map((tag) => String(tag || '').toLowerCase());
        return (
            String(client?.leadStatus || '').toLowerCase() === 'junk'
            || includesAny(tags, ['do_not_call', 'no_call', 'dnc', 'stop', 'не звонить', 'отказ'])
        );
    }

    clientMatchesOutboundFilter(client, sourceFilter = {}) {
        const statuses = sourceFilter.statuses || sourceFilter.lead_statuses || sourceFilter.stages || [];
        if (Array.isArray(statuses) && statuses.length > 0 && !statuses.includes(client.leadStatus || 'new')) {
            return false;
        }

        const tags = parseJson(client.tags, []);
        const includeTags = sourceFilter.tags || sourceFilter.include_tags || [];
        if (Array.isArray(includeTags) && includeTags.length > 0 && !includesAny(tags, includeTags)) {
            return false;
        }

        const excludeTags = sourceFilter.exclude_tags || [];
        if (Array.isArray(excludeTags) && excludeTags.length > 0 && includesAny(tags, excludeTags)) {
            return false;
        }

        const silentDays = Number(sourceFilter.silent_days || sourceFilter.silentDays || 0);
        if (silentDays > 0) {
            const last = Date.parse(client.lastMessageTime || client.updatedAt || client.createdAt || '');
            if (Number.isFinite(last)) {
                const ageMs = Date.now() - last;
                if (ageMs < silentDays * 24 * 60 * 60 * 1000) return false;
            }
        }

        return true;
    }

    async createOutboundCampaign(input = {}) {
        const instanceId = Number(input.instanceId || input.instance_id || this.defaultInstanceId());
        const campaign = DB.createOutboundCampaign({
            instanceId,
            name: input.name,
            sourceFilter: input.source_filter || input.sourceFilter || {},
            contextId: input.context_id || input.contextId || 'unified_sales_agent',
            timezone: input.timezone || 'Europe/Moscow',
            callWindow: input.call_window || input.callWindow || { start: '09:00', end: '18:00' },
            maxAttempts: input.max_attempts || input.maxAttempts || 3,
            retryPolicy: input.retry_policy || input.retryPolicy || {
                initial_delay_seconds: 60,
                multiplier: 2,
                max_delay_seconds: 3600
            },
            postCallAction: input.post_call_action || input.postCallAction || { create_note: true, draft_followup: true },
            enabled: Boolean(input.enabled),
            status: input.status || 'draft'
        });
        return { success: true, campaign: this.hydrateOutboundCampaign(campaign) };
    }

    async listOutboundCampaigns(input = {}) {
        const instanceId = Number(input.instanceId || input.instance_id || this.defaultInstanceId());
        const includeDisabled = input.include_disabled === undefined && input.includeDisabled === undefined
            ? true
            : Boolean(input.include_disabled || input.includeDisabled);
        const rows = DB.listOutboundCampaigns(instanceId, {
            includeDisabled,
            includeArchived: Boolean(input.include_archived || input.includeArchived),
        });
        return { campaigns: rows.map((row) => this.hydrateOutboundCampaign(row)) };
    }

    async getOutboundCampaign(input = {}) {
        const campaign = DB.getOutboundCampaign(input.campaignId || input.campaign_id);
        if (!campaign) return { success: false, error: 'campaign_not_found' };
        return { success: true, campaign: this.hydrateOutboundCampaign(campaign) };
    }

    async updateOutboundCampaign(input = {}) {
        const campaignId = input.campaignId || input.campaign_id;
        const campaign = DB.updateOutboundCampaign(campaignId, input);
        if (!campaign) return { success: false, error: 'campaign_not_found' };
        return { success: true, campaign: this.hydrateOutboundCampaign(campaign) };
    }

    async syncOutboundCampaignLeads(input = {}) {
        const campaignId = input.campaignId || input.campaign_id;
        const campaignRow = DB.getOutboundCampaign(campaignId);
        if (!campaignRow) return { success: false, error: 'campaign_not_found' };

        const campaign = this.hydrateOutboundCampaign(campaignRow);
        const clients = await DB.getClients(campaign.instance_id);
        let accepted = 0;
        let blocked = 0;
        let skipped = 0;
        const leads = [];

        for (const client of clients) {
            if (!this.clientMatchesOutboundFilter(client, campaign.source_filter)) {
                skipped += 1;
                continue;
            }

            const phone = digits(client.chatId);
            if (!phone) {
                skipped += 1;
                continue;
            }

            const tags = parseJson(client.tags, []);
            const doNotCall = this.isDoNotCallClient(client);
            const customerId = `crm_${campaign.instance_id}_${client.id}`;
            const lead = DB.upsertOutboundLead({
                campaignId,
                instanceId: campaign.instance_id,
                chatId: client.chatId,
                customerId,
                phone,
                name: client.senderName,
                doNotCall,
                state: doNotCall ? 'blocked' : 'pending',
                nextAttemptAt: isoNow(),
                source: { crm_client_id: client.id, chatId: client.chatId, leadStatus: client.leadStatus, tags },
                customVars: {
                    caller_name: client.senderName,
                    lead_stage: client.leadStatus || 'new',
                    whatsapp_chat_id: client.chatId,
                    last_message: clip(client.lastMessage, 160),
                    sales_brain_campaign_id: campaignId
                }
            });
            if (doNotCall) {
                DB.updateOutboundLead(lead.leadId, { state: 'blocked', doNotCall: true });
                blocked += 1;
            } else {
                DB.updateOutboundLead(lead.leadId, { state: lead.state === 'blocked' ? 'pending' : lead.state, doNotCall: false });
                accepted += 1;
            }
            leads.push(this.hydrateOutboundLead(DB.getOutboundLead(lead.leadId)));
        }

        return {
            success: true,
            campaign,
            accepted,
            blocked,
            skipped,
            total_clients: clients.length,
            leads
        };
    }

    async getRunnableOutboundLeads(input = {}) {
        const campaignId = input.campaignId || input.campaign_id;
        const campaignRow = DB.getOutboundCampaign(campaignId);
        if (!campaignRow) return { success: false, error: 'campaign_not_found', jobs: [] };
        const campaign = this.hydrateOutboundCampaign(campaignRow);
        if (!campaign.enabled || !['running', 'active'].includes(String(campaign.status || '').toLowerCase())) {
            return { success: true, campaign, jobs: [], blocked_reason: 'campaign_not_running' };
        }
        if (!isWithinCallWindow(campaign.call_window, campaign.timezone)) {
            return { success: true, campaign, jobs: [], blocked_reason: 'outside_call_window' };
        }

        require('./telephony/campaign-permission').refreshSnapshot(campaign.instance_id,campaignId);
        const rows = DB.getRunnableOutboundLeads(campaignId, input.limit || 10, input.now || null);
        const jobs = [];
        for (const row of rows) {
            if (require('./telephony/campaign-permission').optedOut(campaign.instance_id,row)) continue;
            const lead = this.hydrateOutboundLead(row);
            if (lead.attempt_count >= campaign.max_attempts) {
                DB.updateOutboundLead(lead.lead_id, { state: 'failed', lastOutcome: 'max_attempts' });
                continue;
            }
            let preCallContext = null;
            if (lead.chatId) {
                try {
                    preCallContext = await this.customerSummary({ instanceId: lead.instance_id, chatId: lead.chatId, phone: lead.phone });
                } catch (e) {
                    Logger.warn('[SalesBrain] Failed to build outbound pre-call context:', e.message);
                }
            }
            jobs.push({
                lead_id: lead.lead_id,
                campaign_id: lead.campaign_id,
                phone: lead.phone,
                name: lead.name,
                context_id: campaign.context_id,
                custom_vars: {
                    ...lead.custom_vars,
                    sales_brain_lead_id: lead.lead_id,
                    sales_brain_campaign_id: lead.campaign_id,
                    sales_brain_summary: clip(preCallContext?.summary_for_voice || '', 400)
                },
                pre_call_context: preCallContext ? {
                    customer_found: Boolean(preCallContext.found),
                    summary_for_voice: preCallContext.summary_for_voice,
                    next_action: preCallContext.next_action
                } : null
            });
        }
        return { success: true, campaign, jobs };
    }

    async listOutboundLeads(input = {}) {
        const rows = DB.listOutboundLeads(input.campaignId || input.campaign_id, {
            state: input.state,
            limit: input.limit || 100
        });
        return { leads: rows.map((row) => this.hydrateOutboundLead(row)) };
    }

    async exportOutboundCampaignForAva(input = {}) {
        const campaignId = input.campaignId || input.campaign_id;
        const campaignRow = DB.getOutboundCampaign(campaignId);
        if (!campaignRow) return { success: false, error: 'campaign_not_found' };

        if (input.sync_leads !== false && input.syncLeads !== false) {
            await this.syncOutboundCampaignLeads({ campaignId });
        }

        const campaign = this.hydrateOutboundCampaign(DB.getOutboundCampaign(campaignId));
        const retryPolicy = campaign.retry_policy || {};
        const legacyDelayMinutes = Number(retryPolicy.delay_minutes || retryPolicy.retry_delay_minutes || 0);
        const retryInitialDelaySeconds = Math.max(
            1,
            Number(retryPolicy.initial_delay_seconds || (legacyDelayMinutes > 0 ? legacyDelayMinutes * 60 : 60))
        );
        const retryBackoffMultiplier = Math.max(
            1,
            Number(retryPolicy.multiplier || retryPolicy.backoff_multiplier || (legacyDelayMinutes > 0 ? 1 : 2))
        );
        const retryMaxDelaySeconds = Math.max(
            retryInitialDelaySeconds,
            Number(retryPolicy.max_delay_seconds || (legacyDelayMinutes > 0 ? retryInitialDelaySeconds : 3600))
        );
        const Permission=require('./telephony/campaign-permission');
        Permission.refreshSnapshot(campaign.instance_id,campaignId);
        const rows = DB.listOutboundLeads(campaignId, { limit: input.limit || 5000 });
        const leads = rows
            .filter(row=>!Permission.optedOut(campaign.instance_id,row))
            .map((row) => this.hydrateOutboundLead(row))
            .filter((lead) => !lead.do_not_call && !['blocked', 'completed', 'unknown'].includes(lead.state))
            .map((lead) => ({
                external_lead_id: lead.lead_id,
                name: lead.name || '',
                phone_number: lead.phone,
                context: campaign.context_id,
                timezone: campaign.timezone,
                custom_vars: {
                    ...lead.custom_vars,
                    sales_brain_campaign_id: campaign.campaign_id,
                    sales_brain_lead_id: lead.lead_id,
                    sales_brain_instance_id: lead.instance_id,
                    whatsapp_chat_id: lead.chatId,
                    customer_id: lead.customer_id
                }
            }));

        return {
            success: true,
            schema_version: 1,
            external_source: 'sales_brain',
            external_campaign_id: campaign.campaign_id,
            idempotency_key: `sales_brain:${campaign.campaign_id}`,
            campaign: {
                name: campaign.name,
                business_id: campaign.instance_id,
                instance_id: campaign.instance_id,
                timezone: campaign.timezone,
                daily_window_start_local: campaign.call_window.start || campaign.call_window.from || '09:00',
                daily_window_end_local: campaign.call_window.end || campaign.call_window.to || '18:00',
                max_concurrent: Math.max(1, Math.min(Number(input.max_concurrent || 1), 5)),
                min_interval_seconds_between_calls: Math.max(0, Number(input.min_interval_seconds_between_calls || 10)),
                max_attempts: Math.max(1, Number(campaign.max_attempts || 3)),
                retry_initial_delay_seconds: retryInitialDelaySeconds,
                retry_backoff_multiplier: retryBackoffMultiplier,
                retry_max_delay_seconds: retryMaxDelaySeconds,
                default_context: campaign.context_id || 'unified_sales_agent',
                voicemail_drop_enabled: Boolean(input.voicemail_drop_enabled),
                consent_enabled: Boolean(input.consent_enabled)
            },
            leads,
            spoken: `Подготовил для AVA кампанию ${campaign.name}: ${leads.length} лидов.`
        };
    }

    async recordOutboundAttempt(input = {}) {
        const campaignId = input.campaignId || input.campaign_id;
        const leadId = input.leadId || input.lead_id || null;
        const campaignRow = DB.getOutboundCampaign(campaignId);
        if (!campaignRow) return { success: false, error: 'campaign_not_found' };
        const campaign = this.hydrateOutboundCampaign(campaignRow);
        const lead = leadId ? this.hydrateOutboundLead(DB.getOutboundLead(leadId)) : null;
        const outcome = input.outcome || input.status || 'unknown';
        const phone = digits(input.phone || lead?.phone || '');
        const attempt = DB.createOutboundAttempt({
            attemptId: input.attemptId || input.attempt_id,
            campaignId,
            leadId,
            instanceId: campaign.instance_id,
            callId: input.callId || input.call_id || null,
            phone,
            status: input.status || 'finished',
            outcome,
            durationSec: input.duration_sec || input.durationSec || null,
            errorMessage: input.error || input.error_message || null,
            metadata: input.metadata || {},
            leadState: 'called'
        });

        let updatedLead = lead;
        if (leadId) {
            const fresh = this.hydrateOutboundLead(DB.getOutboundLead(leadId));
            const answered = ['answered', 'completed', 'agent_hangup', 'booked'].includes(String(outcome).toLowerCase());
            const exhausted = Number(fresh.attempt_count || 0) >= campaign.max_attempts;
            const policy = campaign.retry_policy || {};
            const legacyDelayMinutes = Number(policy.delay_minutes || policy.retry_delay_minutes || 0);
            const initialDelaySeconds = Math.max(1, Number(
                policy.initial_delay_seconds || (legacyDelayMinutes > 0 ? legacyDelayMinutes * 60 : 60)
            ));
            const multiplier = Math.max(1, Number(
                policy.multiplier || policy.backoff_multiplier || (legacyDelayMinutes > 0 ? 1 : 2)
            ));
            const maxDelaySeconds = Math.max(initialDelaySeconds, Number(
                policy.max_delay_seconds || (legacyDelayMinutes > 0 ? initialDelaySeconds : 3600)
            ));
            const retryDelaySeconds = Math.min(
                maxDelaySeconds,
                Math.round(initialDelaySeconds * Math.pow(multiplier, Math.max(0, Number(fresh.attempt_count || 1) - 1)))
            );
            const state = answered ? 'completed' : (exhausted ? 'failed' : 'retry');
            updatedLead = this.hydrateOutboundLead(DB.updateOutboundLead(leadId, {
                state,
                lastOutcome: outcome,
                lastAttemptAt: isoNow(),
                nextAttemptAt: state === 'retry' ? new Date(Date.now() + retryDelaySeconds * 1000).toISOString() : null
            }));
        }

        let postCall = null;
        if (['answered', 'completed', 'agent_hangup', 'booked'].includes(String(outcome).toLowerCase()) && (input.transcript || input.summary)) {
            postCall = await this.postCall({
                instanceId: campaign.instance_id,
                phone,
                caller_number: phone,
                callId: input.callId || input.call_id || attempt.attemptId,
                transcript: input.transcript,
                summary: input.summary,
                outcome,
                campaignId,
                leadId
            });
        }

        return {
            success: true,
            campaign,
            attempt,
            lead: updatedLead,
            post_call: postCall
        };
    }

    extractProfilePatchFromCall(text, stageDecision, providedSummary = null, existingProfile = null) {
        text = transcriptGuestText(text);
        const lower = String(text || '').toLowerCase();
        const objections = extractObjectionSignals(text);
        const budgetMatch = String(text || '').match(/(?:бюджет|до|около)\s*([0-9][0-9\s.,]*(?:руб|₽|евро|eur|usd|\$)?)/i);
        const needMatch = String(text || '').match(/(?:нужно|нужен|нужна|нужны|хочу|ищу|интересует|надо)\s+([^.!?\n]{8,160})/i);
        const interests = extractInterestMentions(text);
        const importantDates = extractDateMentions(text);
        // A transcript prefix is not a summary and must not be exported as one.
        const lastCallSummary = providedSummary ? clip(providedSummary, 220) : null;
        const keyFacts = uniqueTextList([
            needMatch ? `Потребность: ${clip(needMatch[1], 120)}` : null,
            budgetMatch ? `Бюджет: ${clip(budgetMatch[1], 80)}` : null,
            importantDates[0] ? `Дата: ${importantDates[0]}` : null,
            interests[0] ? `Интерес: ${interests[0]}` : null,
            objections[0] ? `Возражение: ${humanizeObjection(objections[0])}` : null,
        ], 8, 160);

        return {
            ...(needMatch ? { needs: clip(needMatch[1], 180) } : {}),
            ...(budgetMatch ? { budget: clip(budgetMatch[1], 80) } : {}),
            ...(objections.length ? { objections: JSON.stringify(uniqueTextList([...normalizeTextArray(existingProfile?.objections), ...objections], 5, 40)) } : {}),
            ...(/спасибо|отлично|давайте|готов|не интересно|отказ|дорого/i.test(lower)
                ? { sentimentScore: /спасибо|отлично|давайте|готов/i.test(lower) ? 0.75 : 0.25 } : {}),
            conversionProbability: stageDecision.current_stage === 'booked' ? 0.95 : (stageDecision.current_stage === 'offer' ? 0.65 : 0.35),
            rawProfileJson: JSON.stringify({
                source: 'post_call_extractor',
                stage: stageDecision.current_stage,
                ...(objections.length ? { objections } : {}),
                interests,
                interestSignals: interests,
                importantDates,
                keyFacts,
                lastCallSummary,
                lastCallAt: isoNow(),
                callSummaries: lastCallSummary ? [lastCallSummary] : [],
                callCountIncrement: 1
            })
        };
    }

    runSmokeEval() {
        const checks = [];
        const stage = this.classifyStage({ text: 'Клиент спросил цену и попросил коммерческое предложение', previous_stage: 'qualified' });
        checks.push({ name: 'stage_classifier_offer', passed: stage.current_stage === 'offer', output: stage });

        const guard = this.applyStageGuard('booked', 'qualified', 'Manual downgrade attempt');
        checks.push({ name: 'stage_guard_booked_no_downgrade', passed: guard.stage === 'booked' && guard.allowed === false, output: guard });

        const confirmation = HIGH_RISK_ACTIONS.has('send_whatsapp_followup');
        checks.push({ name: 'confirmation_policy_followup_send', passed: confirmation, output: { high_risk: confirmation } });

        const callWindow = isWithinCallWindow({ start: '00:00', end: '23:59' }, 'UTC', new Date('2026-01-01T12:00:00Z'));
        checks.push({ name: 'call_window_all_day', passed: callWindow, output: { callWindow } });

        return {
            success: checks.every((check) => check.passed),
            checks,
            metrics: {
                passed: checks.filter((check) => check.passed).length,
                failed: checks.filter((check) => !check.passed).length
            }
        };
    }

    async postCall(input = {}) {
        const requestedInstanceId = Number(input.instanceId || input.instance_id || input.business_id);
        const requestedCallId = input.callId || input.call_id;
        if (!Number.isSafeInteger(requestedInstanceId) || requestedInstanceId < 1
            || typeof requestedCallId !== 'string' || !requestedCallId.trim()) {
            const error = new Error('instanceId and callId are required for post-call delivery');
            error.statusCode = 400;
            throw error;
        }
        const text = transcriptToText(input.transcript) || String(input.summary || '');
        const outboundCustomVars = parseJson(
            input.outbound_custom_vars || input.outboundCustomVars,
            {}
        );
        const resolved = await this.ensureVoiceCustomer({ ...input, instanceId: requestedInstanceId });
        const instanceId = resolved.instanceId || Number(input.instanceId || this.defaultInstanceId());
        const instance = await DB.getInstance(instanceId);
        const allowedStatuses = getStatusesForBusiness(instance || {});
        const callId = input.callId || input.call_id || null;
        const sourceId = callId ? `post_call:${callId}` : null;
        const eventId = callId ? callEventId(instanceId, callId) : null;
        if (sourceId) {
            const existing = DB.getConversationEventBySource(instanceId, sourceId);
            if (existing && String(existing.chatId || '') !== String(resolved.chatId || '')) {
                throw new Error('Post-call identity differs from the saved call');
            }
            if (existing && DB.get('SELECT decisionId FROM ml_decisions WHERE instanceId = ? AND decisionId = ?', [instanceId, `dec_post_call_${instanceId}_${safeKey(callId)}`])) {
                require('./crm-memory-store.service').enqueueCall(existing, {
                    text, identityConfidence: resolved.identity_confidence,
                    phone: input.phone || input.caller_number || input.callerNumber || null,
                    sourceComplete: Boolean(transcriptToText(input.transcript)),
                });
                return {
                    success: true,
                    idempotent: true,
                    resolved,
                    crm_note: existing,
                    spoken: 'Этот звонок уже был обработан в CRM.'
                };
            }
        }
        const toolRuns = (Array.isArray(input.tool_runs || input.toolRuns) ? input.tool_runs || input.toolRuns : []).map(normalizeToolRun);
        const guestText = transcriptGuestText(input.transcript);
        const requestedFollowup = this.followupRequest(input.transcript);
        const needsFollowup = Boolean(input.generate_followup || input.generateFollowup || requestedFollowup.channels.length);
        const stageDecision = this.classifyStage({
            instanceId, chatId: resolved.chatId, toolRuns,
            previous_stage: resolved.client?.leadStatus || 'new',
            text: guestText,
            channel: 'voice',
            allowedStatuses
        });
        const providedSummary = typeof input.summary === 'string' ? input.summary.trim() : '';
        const normalizedTranscript = text.replace(/\s+/g, ' ').trim();
        const normalizedSummary = providedSummary.replace(/\s+/g, ' ').trim();
        const verifiedSummary = normalizedSummary.length >= 10
            && (!transcriptToText(input.transcript) || normalizedTranscript !== normalizedSummary
                && !normalizedTranscript.startsWith(normalizedSummary))
            ? providedSummary : null;
        const finalSummary = verifiedSummary || extractiveCallSummary(input.transcript)
            || 'Звонок завершён; содержание разговора недоступно.';
        const summaryProvenance = verifiedSummary ? 'provided_summary'
            : transcriptToText(input.transcript) ? 'transcript_extract' : 'unavailable';
        const rawDuration = Number(input.duration_sec ?? input.durationSec);
        const note = await this.createCrmNote({
            ...input,
            instanceId,
            chatId: resolved.chatId,
            note: finalSummary,
            eventId,
            sourceId,
            channel: 'voice',
            phase: 'post_call'
        }, {
            summary_provenance: summaryProvenance,
            call_started_at: typeof input.call_started_at === 'string' && Number.isFinite(Date.parse(input.call_started_at))
                ? new Date(input.call_started_at).toISOString() : null,
            call_direction: ['inbound', 'outbound'].includes(input.direction) ? input.direction : null,
            outcome: typeof input.outcome === 'string' && /^[a-z][a-z0-9_:-]{0,79}$/.test(input.outcome) ? input.outcome : null,
            duration_seconds: Number.isFinite(rawDuration) && rawDuration >= 0 && rawDuration <= 86400 ? rawDuration : null,
        }, {
            text, identityConfidence: resolved.identity_confidence,
            phone: input.phone || input.caller_number || input.callerNumber || null,
            sourceComplete: Boolean(transcriptToText(input.transcript)),
        });
        // Preserve exact accepted transcript before extraction, never infer promises from a generated summary.
        await require('./ava-autopilot.service').postCall({businessId:instanceId,chatId:resolved.chatId,eventId:note.event_id || eventId,callId,transcript:input.transcript,durationSeconds:Number.isFinite(rawDuration)&&rawDuration>=0&&rawDuration<=86400?rawDuration:null});
        for (let index = 0; index < toolRuns.length; index += 1) {
            const run = toolRuns[index];
            DB.createToolRun({
                toolRunId: callId ? `tool_call_${instanceId}_${safeKey(callId)}_${index}` : null,
                instanceId,
                chatId: resolved.chatId || null,
                customerId: resolved.customer_id || null,
                callId,
                conversationEventId: note.event_id || null,
                toolName: run.name,
                phase: run.phase,
                argsRedacted: run.arguments,
                resultRedacted: run.result,
                status: run.status,
                latencyMs: run.latencyMs
            });
        }

        // Manager handoff: the call is over, decide whether a human still owes
        // this guest something. Idempotent per callId via the deterministic task id.
        let handoffTask = null;
        const handoff = this.resolveHandoffForCall({
            instanceId, chatId: resolved.chatId, callId,
            transcript: input.transcript,
            toolRuns,
            handoffSignals: parseJson(input.handoff_signals || input.handoffSignals, []),
            outcome: input.outcome,
        });
        if (handoff) {
            await require('./ava-autopilot.service').postCall({businessId:instanceId,chatId:resolved.chatId,eventId:note.event_id || eventId,callId,transcript:input.transcript,durationSeconds:Number.isFinite(rawDuration)&&rawDuration>=0?rawDuration:null,handoffReason:handoff.reason});
            try {
                const created = await this.createManagerTask({
                    instanceId,
                    chatId: resolved.chatId || null,
                    phone: input.phone || input.caller_number || resolved.phone || '',
                    callId,
                    summary: input.summary || clip(text, 800) || 'Звонок завершен без ответа AVA.',
                    reason: handoff.reason,
                    priority: handoff.reason === 'complaint' ? 'high' : 'normal',
                    source: 'auto_post_call',
                    phase: 'post_call',
                    metadata: { trigger: handoff.reason, ...handoff.detail },
                });
                if (!created.success || !created.task?.task_id) throw new Error('Recovery manager task was not durably saved');
                handoffTask = created.task || null;
            } catch (e) {
                // The note/tool evidence is already saved. Do not ACK an owed
                // recovery as complete: retry the idempotent call delivery.
                Logger.warn('[SalesBrain] Failed to create handoff task:', e.message);
                throw e;
            }
        }

        const salesCampaignId = input.sales_brain_campaign_id
            || input.salesBrainCampaignId
            || outboundCustomVars.sales_brain_campaign_id
            || null;
        const salesLeadId = input.sales_brain_lead_id
            || input.salesBrainLeadId
            || outboundCustomVars.sales_brain_lead_id
            || null;
        let outboundAttempt = null;
        if (salesCampaignId && DB.getOutboundCampaign(salesCampaignId)) {
            outboundAttempt = DB.createOutboundAttempt({
                attemptId: callId ? `attempt_ava_${instanceId}_${safeKey(callId)}` : null,
                campaignId: salesCampaignId,
                leadId: salesLeadId,
                instanceId,
                callId,
                phone: digits(input.phone || input.caller_number || resolved.phone || ''),
                status: 'finished',
                outcome: input.outcome || 'completed',
                endedAt: input.call_ended_at || input.callEndedAt || isoNow(),
                durationSec: input.duration_sec || input.durationSec || null,
                metadata: {
                    source: 'ava_post_call',
                    ava_campaign_id: input.ava_campaign_id || null,
                    ava_lead_id: input.ava_lead_id || null,
                    context_id: input.context_id || null,
                    provider: input.provider || null
                },
                leadState: 'completed'
            });
            if (salesLeadId) {
                DB.updateOutboundLead(salesLeadId, {
                    state: 'completed',
                    lastOutcome: input.outcome || 'completed',
                    lastAttemptAt: input.call_ended_at || input.callEndedAt || isoNow(),
                    nextAttemptAt: null
                });
            }
        }
        const inferenceWrite = resolved.found && resolved.chatId
            ? require('./ava-autopilot.service').runVoiceMutation({
                businessId: instanceId, chatId: resolved.chatId, callId,
                operation: 'post_call_inference', sourceEventId: note.event_id || eventId,
                postCall: true
            }, ({ client }) => {
                // Preparation above can await; read the current stage again in
                // the same transaction as the live policy/control check.
                const liveStage = this.classifyStage({ instanceId, chatId: resolved.chatId, toolRuns,
                    previous_stage: client.leadStatus || 'new', text: guestText, channel: 'voice', allowedStatuses });
                if (liveStage.should_update) DB.updateClientStatusSync(instanceId, resolved.chatId, liveStage.current_stage, liveStage.reasoning, 'sales_brain_post_call');
                const declaredName = declaredCallerName(input.transcript);
                if (declaredName && unnamedVoiceClient(client)) {
                    DB.run('UPDATE clients SET senderName=?,updatedAt=CURRENT_TIMESTAMP WHERE instanceId=? AND chatId=?', [declaredName, instanceId, resolved.chatId]);
                }
                const existingProfile = DB.get('SELECT * FROM client_profiles WHERE instanceId=? AND chatId=?', [instanceId, resolved.chatId]);
                DB.upsertClientProfileSync(instanceId, resolved.chatId, this.extractProfilePatchFromCall(guestText, liveStage, verifiedSummary, existingProfile));
                return { success: true, stage: liveStage.current_stage, stageUpdated: liveStage.should_update, profileUpdated: true };
            }) : null;
        const next = resolved.found ? await this.nextAction({ instanceId, chatId: resolved.chatId }) : null;
        if (resolved.found && !handoffTask && (needsFollowup || next?.next_action?.action_type === 'draft_followup')) {
            const created = await this.createManagerTask({ instanceId, chatId: resolved.chatId, callId,
                phone: resolved.phone, summary: requestedFollowup.channel
                    ? `Подготовить информацию и отправить клиенту в ${FOLLOWUP_CHANNELS.get(requestedFollowup.channel)} после проверки`
                    : 'Проверить и отправить сообщение после звонка',
                source: 'post_call_followup', assignee: input.manager_id || resolved.client?.managerId || null,
                assigneeUserId: input.assigneeUserId, metadata: { assigned_manager_id: input.manager_id || resolved.client?.managerId || null,
                    requested_channel: requestedFollowup.channel, requested_channels: requestedFollowup.channels,
                    requires_manager_confirmation: true, request: clip(guestText, 4000) } });
            handoffTask = created.task;
            if (!handoffTask) throw new Error('Follow-up manager task was not durably saved');
        }
        const followupDraft = resolved.found && (needsFollowup || next?.next_action?.action_type === 'draft_followup')
            ? await this.draftWhatsAppFollowup({
                instanceId,
                chatId: resolved.chatId,
                phone: resolved.phone,
                callId,
                ...(requestedFollowup.channel ? { channel: requestedFollowup.channel } : {}),
                // Ties the draft to the handoff task from the same call, so a
                // manager reviews one thread instead of two queues.
                managerTaskId: handoffTask?.task_id || null,
                source: 'post_call',
                text: input.followup_text || null,
                metadata: { requested_channel: requestedFollowup.channel, requested_channels: requestedFollowup.channels,
                    requires_manager_confirmation: true, request: clip(guestText, 4000) },
            })
            : null;
        if (followupDraft && !followupDraft.success) throw new Error('Follow-up draft was not durably saved');
        // Save owed automatic work before the completion marker. A crash can
        // replay this idempotent draft/queue instead of silently losing it.
        const automaticFollowup = followupDraft?.draft_id ? require('./postcall-followup.service').enqueue({
            businessId: instanceId, draftId: followupDraft.draft_id, eventId: note.event_id || eventId,
            consent: Boolean(requestedFollowup.channel), requestedChannel: requestedFollowup.channel,
        }) : null;
        const decision = DB.createMlDecision({
            decisionId: callId ? `dec_post_call_${instanceId}_${safeKey(callId)}` : null,
            instanceId,
            chatId: resolved.chatId || null,
            customerId: resolved.customer_id || null,
            taskType: 'post_call',
            output: { stageDecision, note, inference_write: inferenceWrite, next_action: next?.next_action || null, followup_draft: followupDraft, handoff_task: handoffTask },
            confidence: stageDecision.confidence
        });
        if (automaticFollowup?.queued) require('./followup.service').wakePostCall();
        return {
            success: true,
            resolved,
            stage_decision: stageDecision,
            inference_write: inferenceWrite,
            crm_note: note,
            next_action: next?.next_action || null,
            followup_draft: followupDraft,
            automatic_followup: automaticFollowup,
            outbound_attempt: outboundAttempt,
            handoff_task: handoffTask,
            ml_decision: decision,
            spoken: 'Звонок обработан и записан в CRM.'
        };
    }

    getPostCallSummary(input = {}) {
        const instanceId = Number(input.instanceId || input.instance_id || input.business_id);
        const chatId = String(input.chatId || input.chat_id || '');
        const callId = String(input.callId || input.call_id || '');
        if (!Number.isSafeInteger(instanceId) || instanceId < 1 || !chatId || !callId) {
            throw new Error('business_id, chatId and callId are required');
        }
        const event = DB.getConversationEventBySource(instanceId, `post_call:${callId}`);
        if (!event || String(event.chatId || '') !== chatId || String(event.callId || '') !== callId) {
            return { found: false, summary: null };
        }
        const generated = DB.getConversationEvents(instanceId, chatId, 200)
            .filter((row) => row.callId === callId && row.role === 'summary').at(-1);
        const selected = generated || event;
        return {
            found: true,
            summary: selected.content,
            provenance: parseJson(selected.metadataJson, {}).summary_provenance || 'unknown',
            event_id: selected.eventId,
            business_id: instanceId,
            chatId,
            callId,
        };
    }
}

module.exports = new SalesBrainService();
