const Logger = require('../utils/logger');
const DB = require('./database.service');
const AIService = require('./ai.service');

class PersonalizationService {

    async buildClientProfile(instanceId, chatId) {
        try {
            const messages = await DB.getMessages(instanceId, chatId);
            if (!messages || messages.length < 3) {
                Logger.info(`[Personalization] Not enough messages for ${chatId} to build profile`);
                return null;
            }

            const instanceConfig = await DB.getInstance(instanceId);
            const history = messages.map(m =>
                `${m.role === 'user' ? '👤 Клиент' : '🤖 Бот'}: ${m.content}`
            ).join('\n');

            const systemMsg = {
                role: 'system',
                content: `Ты аналитик CRM. Проанализируй переписку и составь профиль клиента.
Ответь ТОЛЬКО валидным JSON без лишнего текста:
{
  "needs": "что нужно клиенту (1-2 предложения)",
  "budget": "бюджет или финансовые ограничения (если упоминались)",
  "objections": "возражения клиента через запятую (если были)",
  "interests": ["интерес1", "интерес2"],
  "importantDates": ["дата или временное окно, если клиент называл"],
  "communicationStyle": "formal|casual|emotional",
  "decisionSpeed": "fast|medium|slow",
  "sentimentScore": 0.5,
  "conversionProbability": 50,
  "keyFacts": ["факт1", "факт2"]
}

Правила:
• sentimentScore: 0.0 (негативный) — 1.0 (позитивный)
• conversionProbability: 0-100 (вероятность покупки/записи)
• communicationStyle: определи по стилю общения клиента
• decisionSpeed: fast (решает сразу), medium (думает), slow (долго решает)
• Если информации нет — ставь null или значения по умолчанию
• ТОЛЬКО JSON, без markdown`
            };
            const userMsg = { role: 'user', content: `Переписка:\n${history}\n\nСоставь профиль клиента.` };

            const raw = await AIService._callProviderPlain([systemMsg, userMsg], instanceConfig);
            const profile = AIService._extractJson(raw);

            if (!profile) {
                Logger.warn('[Personalization] Failed to parse AI profile response');
                return null;
            }

            const profileData = {
                needs: profile.needs || null,
                budget: profile.budget || null,
                objections: Array.isArray(profile.objections) ? profile.objections.join(', ') : (profile.objections || null),
                interests: profile.interests || [],
                communicationStyle: profile.communicationStyle || 'casual',
                decisionSpeed: profile.decisionSpeed || 'medium',
                sentimentScore: typeof profile.sentimentScore === 'number' ? profile.sentimentScore : 0.5,
                conversionProbability: typeof profile.conversionProbability === 'number' ? profile.conversionProbability : 0,
                rawProfileJson: JSON.stringify({
                    ...profile,
                    importantDates: Array.isArray(profile.importantDates) ? profile.importantDates : [],
                    keyFacts: Array.isArray(profile.keyFacts) ? profile.keyFacts : []
                })
            };

            const saved = await DB.upsertClientProfile(instanceId, chatId, profileData);
            Logger.info(`[Personalization] ✅ Profile built for ${chatId}: conv=${profileData.conversionProbability}%, sentiment=${profileData.sentimentScore}`);
            return saved;
        } catch (e) {
            Logger.error('[Personalization] buildClientProfile error:', e.message);
            return null;
        }
    }

    async analyzeContactTimes(instanceId, chatId) {
        try {
            const messages = await DB.getMessages(instanceId, chatId);
            if (!messages || messages.length < 2) return;

            let prevBotTime = null;
            for (const msg of messages) {
                if (msg.role === 'assistant') {
                    prevBotTime = new Date(msg.timestamp);
                } else if (msg.role === 'user' && msg.timestamp) {
                    const msgTime = new Date(msg.timestamp);
                    const dayOfWeek = msgTime.getDay();
                    const hourSlot = msgTime.getHours();

                    let responseTimeSec = 0;
                    if (prevBotTime) {
                        responseTimeSec = Math.max(0, (msgTime - prevBotTime) / 1000);
                        if (responseTimeSec > 86400) responseTimeSec = 86400; // cap at 24h
                    }

                    await DB.upsertContactTime(instanceId, chatId, dayOfWeek, hourSlot, responseTimeSec);
                    prevBotTime = null;
                }
            }
        } catch (e) {
            Logger.error('[Personalization] analyzeContactTimes error:', e.message);
        }
    }

    async getOptimalContactTime(instanceId, chatId) {
        const times = await DB.getContactTimes(instanceId, chatId);
        if (!times || times.length === 0) return null;

        // Score: responseCount * (1 / max(avgResponseTimeSec, 1))
        const scored = times.map(t => ({
            dayOfWeek: t.dayOfWeek,
            hour: t.hourSlot,
            responseCount: t.responseCount,
            avgResponseTimeSec: t.avgResponseTimeSec,
            score: t.responseCount * (1 / Math.max(t.avgResponseTimeSec, 1))
        })).sort((a, b) => b.score - a.score);

        const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
        const top3 = scored.slice(0, 3).map(s => ({
            day: dayNames[s.dayOfWeek],
            dayOfWeek: s.dayOfWeek,
            hour: s.hour,
            score: Math.round(s.score * 100) / 100,
            responseCount: s.responseCount
        }));

        return {
            bestSlots: top3,
            allSlots: times,
            confidence: Math.min(100, Math.round((times.reduce((s, t) => s + t.responseCount, 0) / 10) * 100))
        };
    }

    async generatePersonalizedOffer(instanceId, chatId) {
        try {
            const profile = await DB.getClientProfile(instanceId, chatId);
            const instanceConfig = await DB.getInstance(instanceId);
            if (!profile) {
                return { error: 'Профиль клиента не найден. Сначала постройте профиль.' };
            }

            const systemMsg = {
                role: 'system',
                content: `Ты маркетолог-эксперт. На основе профиля клиента сгенерируй персональное коммерческое предложение.

Профиль клиента:
- Потребности: ${profile.needs || 'Не выявлены'}
- Бюджет: ${profile.budget || 'Не указан'}
- Возражения: ${profile.objections || 'Нет'}
- Интересы: ${profile.interests || '[]'}
- Стиль общения: ${profile.communicationStyle}
- Вероятность конверсии: ${profile.conversionProbability}%

Бизнес: ${instanceConfig.systemPrompt ? instanceConfig.systemPrompt.substring(0, 500) : 'Не описан'}

Ответь ТОЛЬКО JSON:
{
  "offerText": "Текст предложения для клиента (2-4 предложения, под стиль клиента)",
  "discount": 0,
  "validUntil": "дата (через 3 дня)",
  "reasoning": "Почему именно такое предложение (1 предложение)"
}
ТОЛЬКО JSON, без markdown.`
            };
            const userMsg = { role: 'user', content: 'Сгенерируй предложение.' };

            const raw = await AIService._callProviderPlain([systemMsg, userMsg], instanceConfig);
            const offer = AIService._extractJson(raw);

            if (!offer) {
                return { error: 'Не удалось сгенерировать предложение' };
            }

            return {
                offerText: offer.offerText || raw,
                discount: offer.discount || 0,
                validUntil: offer.validUntil || null,
                reasoning: offer.reasoning || null,
                profile: {
                    needs: profile.needs,
                    budget: profile.budget,
                    conversionProbability: profile.conversionProbability,
                    sentimentScore: profile.sentimentScore
                }
            };
        } catch (e) {
            Logger.error('[Personalization] generateOffer error:', e.message);
            return { error: e.message };
        }
    }

    async getDynamicPricing(instanceId, chatId) {
        try {
            const profile = await DB.getClientProfile(instanceId, chatId);
            const instance = await DB.getInstance(instanceId);

            if (!profile) {
                return { discount: 0, label: 'Нет профиля', reasoning: 'Профиль клиента не построен' };
            }

            if (!instance.dynamicPricingEnabled) {
                return { discount: 0, label: 'Выключено', reasoning: 'Динамическое ценообразование выключено' };
            }

            let rules;
            try {
                rules = JSON.parse(instance.dynamicPricingRules || '{}');
            } catch { rules = {}; }

            const baseDiscount = rules.baseDiscount || 0;
            const maxDiscount = rules.maxDiscount || 25;
            let totalDiscount = baseDiscount;
            const appliedRules = [];

            const rulesList = rules.rules || [];
            for (const rule of rulesList) {
                let matches = false;
                if (rule.condition === 'conversionProbability < 30' && profile.conversionProbability < 30) matches = true;
                if (rule.condition === "objections includes 'дорого'" && profile.objections && profile.objections.includes('дорого')) matches = true;
                if (rule.condition === 'sentimentScore < 0.3' && profile.sentimentScore < 0.3) matches = true;

                if (matches) {
                    totalDiscount += (rule.discount || 0);
                    appliedRules.push(rule.label || rule.condition);
                }
            }

            totalDiscount = Math.min(totalDiscount, maxDiscount);

            return {
                discount: totalDiscount,
                label: appliedRules.length > 0 ? appliedRules.join('; ') : 'Стандартная цена',
                reasoning: `Конверсия: ${profile.conversionProbability}%, Sentiment: ${profile.sentimentScore}`,
                appliedRules,
                conversionProbability: profile.conversionProbability,
                sentimentScore: profile.sentimentScore
            };
        } catch (e) {
            Logger.error('[Personalization] getDynamicPricing error:', e.message);
            return { discount: 0, label: 'Ошибка', reasoning: e.message };
        }
    }

    async shouldUpdateProfile(instanceId, chatId) {
        const count = await DB.getMessageCount(instanceId, chatId);
        return count > 0 && count % 5 === 0;
    }
}

module.exports = new PersonalizationService();
