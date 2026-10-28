const config = require('../config');
const Logger = require('../utils/logger');

const SHORT_EXACT_MESSAGES = new Set([
    'да',
    'нет',
    'неа',
    'ага',
    'угу',
    'ок',
    'окей',
    'хорошо',
    'ладно',
    'понял',
    'поняла',
    'принял',
    'приняла',
    'спасибо',
    'благодарю',
    'привет',
    'здравствуйте',
    'добрый день',
    'добрый вечер',
    'доброе утро',
    'салам',
    'hello',
    'hi',
    'yes',
    'no',
    'ok'
]);

class MessageBatcher {
    constructor(options = {}) {
        this.entries = new Map();
        this.defaultIdleMs = options.idleMs ?? config.messageBatching.idleMs;
        this.defaultShortIdleMs = options.shortIdleMs ?? config.messageBatching.shortIdleMs;
        this.defaultMaxMs = options.maxMs ?? config.messageBatching.maxMs;
    }

    enqueue({ key, text, meta = {}, onFlush, idleMs, shortIdleMs, maxMs }) {
        if (!key) throw new Error('MessageBatcher key is required');
        if (typeof onFlush !== 'function') throw new Error('MessageBatcher onFlush callback is required');

        const now = Date.now();
        let entry = this.entries.get(key);
        if (!entry) {
            entry = {
                key,
                messages: [],
                firstAt: null,
                lastAt: null,
                version: 0,
                timer: null,
                maxTimer: null,
                processingCount: 0,
                onFlush
            };
            this.entries.set(key, entry);
        }

        const wasIdle = entry.messages.length === 0;
        if (wasIdle) {
            entry.firstAt = now;
            this._clearTimer(entry, 'maxTimer');
        }

        entry.onFlush = onFlush;
        entry.version += 1;
        entry.lastAt = now;
        entry.messages.push({ text, meta, receivedAt: now });

        const effectiveIdleMs = this._resolveMs(idleMs, this.defaultIdleMs);
        const effectiveShortIdleMs = this._resolveMs(shortIdleMs, this.defaultShortIdleMs);
        const effectiveMaxMs = Math.max(1, this._resolveMs(maxMs, this.defaultMaxMs));
        const preferredDelay = this.isShortOrIncomplete(text) ? effectiveShortIdleMs : effectiveIdleMs;
        const elapsed = now - entry.firstAt;
        const delayMs = Math.max(0, Math.min(preferredDelay, effectiveMaxMs - elapsed));

        this._clearTimer(entry, 'timer');
        entry.timer = setTimeout(() => {
            this.flush(key, 'idle').catch(e => Logger.error('[MessageBatcher] Flush failed:', e.message));
        }, delayMs);

        if (!entry.maxTimer) {
            entry.maxTimer = setTimeout(() => {
                this.flush(key, 'max_wait').catch(e => Logger.error('[MessageBatcher] Max flush failed:', e.message));
            }, Math.max(0, effectiveMaxMs - elapsed));
        }

        return {
            key,
            delayMs,
            maxMs: effectiveMaxMs,
            pendingCount: entry.messages.length,
            version: entry.version
        };
    }

    async flush(key, reason = 'manual') {
        const entry = this.entries.get(key);
        if (!entry || entry.messages.length === 0) return null;

        const messages = entry.messages;
        entry.messages = [];
        entry.firstAt = null;
        this._clearTimer(entry, 'timer');
        this._clearTimer(entry, 'maxTimer');

        const version = entry.version;
        entry.processingCount += 1;

        const text = messages.map(m => m.text).filter(Boolean).join('\n').trim();
        const lastMessage = messages[messages.length - 1] || {};
        const batch = {
            key,
            text,
            lastText: lastMessage.text || '',
            messages,
            meta: lastMessage.meta || {},
            reason,
            version
        };
        const token = {
            key,
            version,
            isStale: () => {
                const current = this.entries.get(key);
                return !current || current.version !== version;
            }
        };

        try {
            await entry.onFlush(batch, token);
            return batch;
        } finally {
            entry.processingCount -= 1;
            const current = this.entries.get(key);
            if (current === entry && entry.processingCount <= 0 && entry.messages.length === 0) {
                this._clearTimer(entry, 'timer');
                this._clearTimer(entry, 'maxTimer');
                this.entries.delete(key);
            }
        }
    }

    clear(key) {
        const entry = this.entries.get(key);
        if (!entry) return;
        this._clearTimer(entry, 'timer');
        this._clearTimer(entry, 'maxTimer');
        this.entries.delete(key);
    }

    clearAll() {
        for (const key of this.entries.keys()) {
            this.clear(key);
        }
    }

    isShortOrIncomplete(text) {
        const raw = String(text || '').trim();
        if (!raw) return true;

        const normalized = raw
            .toLowerCase()
            .replace(/[.!,…]+$/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (SHORT_EXACT_MESSAGES.has(normalized)) return true;
        if (normalized.includes('?')) return false;

        const words = normalized.split(/\s+/).filter(Boolean);
        return normalized.length <= 16 || words.length <= 2;
    }

    _resolveMs(value, fallback) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed >= 0) return parsed;
        return fallback;
    }

    _clearTimer(entry, field) {
        if (entry[field]) {
            clearTimeout(entry[field]);
            entry[field] = null;
        }
    }
}

module.exports = MessageBatcher;
