const Logger = require('../utils/logger');
const AIService = require('./ai.service');

class LanguageService {
    constructor() {
        this._cache = new Map();
        this._cacheMaxSize = 500;
    }

    detectLanguage(text) {
        if (!text || text.trim().length < 3) return 'ru';

        const sample = text.substring(0, 200);

        // Count character ranges
        let cyrillic = 0, latin = 0, arabic = 0, cjk = 0, total = 0;
        for (const ch of sample) {
            const code = ch.codePointAt(0);
            if (code >= 0x0400 && code <= 0x04FF) cyrillic++;
            else if ((code >= 0x0041 && code <= 0x005A) || (code >= 0x0061 && code <= 0x007A)) latin++;
            else if (code >= 0x0600 && code <= 0x06FF) arabic++;
            else if (code >= 0x4E00 && code <= 0x9FFF) cjk++;
            if (code > 0x20) total++;
        }

        if (total === 0) return 'ru';

        const cyrillicRatio = cyrillic / total;
        const latinRatio = latin / total;
        const arabicRatio = arabic / total;
        const cjkRatio = cjk / total;

        if (cyrillicRatio > 0.3) return 'ru';
        if (arabicRatio > 0.3) return 'ar';
        if (cjkRatio > 0.2) return 'zh';
        if (latinRatio > 0.3) {
            // Try to distinguish between common latin-based languages
            const lower = sample.toLowerCase();
            if (/\b(the|and|is|are|you|this|that|have|for|not|with|from)\b/.test(lower)) return 'en';
            if (/\b(der|die|das|und|ist|ich|nicht|ein|für|mit)\b/.test(lower)) return 'de';
            if (/\b(le|la|les|et|est|un|une|des|que|pour|dans)\b/.test(lower)) return 'fr';
            if (/\b(el|la|los|las|es|un|una|que|por|para|con)\b/.test(lower)) return 'es';
            if (/\b(il|la|di|che|un|una|per|non|con|sono)\b/.test(lower)) return 'it';
            if (/\b(o|a|os|as|um|uma|de|que|para|com|não)\b/.test(lower)) return 'pt';
            if (/\b(i|w|z|na|do|nie|się|jest|co|jak|to)\b/.test(lower)) return 'pl';
            if (/\b(ve|bir|bu|da|ile|için|olan|var|ben|ne)\b/.test(lower)) return 'tr';
            return 'en';
        }

        return 'ru';
    }

    async translateMessage(text, fromLang, toLang, instanceConfig = {}) {
        if (!text || fromLang === toLang) return text;

        // Check cache
        const cacheKey = `${fromLang}:${toLang}:${text.substring(0, 100)}`;
        if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);

        const langNames = {
            ru: 'русский', en: 'английский', de: 'немецкий', fr: 'французский',
            es: 'испанский', it: 'итальянский', pt: 'португальский', ar: 'арабский',
            zh: 'китайский', pl: 'польский', tr: 'турецкий'
        };

        const fromName = langNames[fromLang] || fromLang;
        const toName = langNames[toLang] || toLang;

        try {
            const messages = [
                {
                    role: 'system',
                    content: `Ты профессиональный переводчик. Переведи текст с ${fromName} на ${toName}. Верни ТОЛЬКО перевод, без пояснений, без кавычек, без markdown.`
                },
                { role: 'user', content: text }
            ];

            const raw = await AIService._callProviderPlain(messages, instanceConfig);
            const translated = raw ? raw.trim().replace(/^["']|["']$/g, '') : text;

            // Cache the result
            if (this._cache.size >= this._cacheMaxSize) {
                const firstKey = this._cache.keys().next().value;
                this._cache.delete(firstKey);
            }
            this._cache.set(cacheKey, translated);

            return translated;
        } catch (e) {
            Logger.warn('[Language] Translation error:', e.message);
            return text;
        }
    }

    getLanguageName(code) {
        const names = {
            ru: 'Русский', en: 'English', de: 'Deutsch', fr: 'Français',
            es: 'Español', it: 'Italiano', pt: 'Português', ar: 'العربية',
            zh: '中文', pl: 'Polski', tr: 'Türkçe'
        };
        return names[code] || code;
    }
}

module.exports = new LanguageService();
