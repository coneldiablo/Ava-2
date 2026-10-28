'use strict';

const axios = require('axios');
const crypto = require('crypto');
const preview = require('../../routes/customer-knowledge-preview.routes');
const LocalKnowledge = require('../knowledge-local.service');

async function askKnowledge(businessId, userId, question, signal) {
    const release = preview.reservePreview(userId, businessId);
    if (!release) throw Object.assign(new Error('ASK_RATE_LIMITED'), { code: 'ASK_RATE_LIMITED', statusCode: 429 });
    const correlationId = crypto.randomUUID();
    try {
        if (signal?.aborted) {
            throw Object.assign(new Error('KNOWLEDGE_CANCELED'),
                { code: 'KNOWLEDGE_CANCELED', statusCode: 499 });
        }
        const local = await LocalKnowledge.lookup(businessId, question);
        if (signal?.aborted) {
            throw Object.assign(new Error('KNOWLEDGE_CANCELED'),
                { code: 'KNOWLEDGE_CANCELED', statusCode: 499 });
        }
        if (local) return {
            answer: local.answer,
            sources: local.citations.map(item => ({ type: 'knowledge_document',
                id: String(item.source_id), title: item.title,
                createdAt: null, sourceUpdatedAt: local.source_timestamp })),
            grounded: true, generatedAt: new Date().toISOString(),
            sourceUpdatedAt: local.source_timestamp,
            provenance: local.provenance,
        };
        if (LocalKnowledge.canConcludeNoMatch(businessId)) return {
            answer: 'В загруженных документах не найден точный ответ. Уточните вопрос или добавьте документ с нужной информацией.',
            sources: [], grounded: false, dataStatus: 'no_match',
            generatedAt: new Date().toISOString(), sourceUpdatedAt: null,
            provenance: 'local_knowledge_extract',
        };
        const token = process.env.CRM_SERVICE_API_TOKEN;
        const base = (process.env.AVA_ADMIN_API_URL || '').replace(/\/+$/, '');
        if (!token || !/^https?:\/\//.test(base)) {
            throw Object.assign(new Error('KNOWLEDGE_UNAVAILABLE'),
                { code: 'KNOWLEDGE_UNAVAILABLE', statusCode: 503 });
        }
        const response = await axios.post(`${base}/api/internal/onyx/knowledge/preview`, {
            business_id: businessId, question, channel: 'whatsapp', correlation_id: correlationId,
        }, {
            headers: { Authorization: `Bearer ${token}` }, timeout: preview.UPSTREAM_TIMEOUT_MS, signal,
            transitional: { clarifyTimeoutError: true },
            maxRedirects: 0, maxContentLength: 128 * 1024, maxBodyLength: 16 * 1024,
        });
        const data = response.data;
        if (!preview.validPreview(data, businessId, correlationId)) {
            const failure = data?.customer_context_provided === true ? null
                : preview.verifiedFailureCode(data, businessId, correlationId);
            if (failure === 'PREVIEW_UNGROUNDED') {
                return {
                    answer: 'В базе знаний этого бизнеса нет подтверждённого ответа на вопрос. Попробуйте уточнить формулировку или проверьте документы.',
                    sources: [], grounded: false, dataStatus: 'ungrounded',
                    generatedAt: new Date().toISOString(), sourceUpdatedAt: null,
                    provenance: 'onyx_knowledge',
                };
            }
            if (['PREVIEW_EMPTY', 'PREVIEW_INDEXING', 'PREVIEW_TIMEOUT'].includes(failure)) {
                const code = { PREVIEW_EMPTY: 'KNOWLEDGE_EMPTY', PREVIEW_INDEXING: 'KNOWLEDGE_INDEXING',
                    PREVIEW_TIMEOUT: 'KNOWLEDGE_TIMEOUT' }[failure];
                throw Object.assign(new Error(code), { code, statusCode: failure === 'PREVIEW_TIMEOUT' ? 504 : 409 });
            }
            if (failure === 'PREVIEW_NOT_READY') {
                throw Object.assign(new Error('KNOWLEDGE_NOT_READY'),
                    { code: 'KNOWLEDGE_NOT_READY', statusCode: 503 });
            }
            throw Object.assign(new Error('KNOWLEDGE_UNAVAILABLE'), { code: 'KNOWLEDGE_UNAVAILABLE', statusCode: 503 });
        }
        return {
            answer: data.answer,
            sources: data.citations.map(item => ({ type: 'onyx_document', id: String(item.source_id),
                title: item.title.trim() || `Источник №${item.source_id}`,
                createdAt: null, sourceUpdatedAt: data.source_timestamp })),
            grounded: true, generatedAt: new Date().toISOString(), sourceUpdatedAt: data.source_timestamp,
            provenance: 'onyx_knowledge',
        };
    } catch (error) {
        // Axios exceptions may contain request headers and customer text.
        if (['KNOWLEDGE_NOT_READY', 'KNOWLEDGE_EMPTY', 'KNOWLEDGE_INDEXING', 'KNOWLEDGE_TIMEOUT',
            'KNOWLEDGE_UNAVAILABLE', 'KNOWLEDGE_CANCELED'].includes(error?.code)
            && [409, 499, 503, 504].includes(error.statusCode)) throw error;
        if (error?.code === 'ERR_CANCELED' && signal?.aborted) {
            throw Object.assign(new Error('KNOWLEDGE_CANCELED'),
                { code: 'KNOWLEDGE_CANCELED', statusCode: 499 });
        }
        if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
            throw Object.assign(new Error('KNOWLEDGE_TIMEOUT'), { code: 'KNOWLEDGE_TIMEOUT', statusCode: 504 });
        }
        throw Object.assign(new Error('KNOWLEDGE_UNAVAILABLE'), { code: 'KNOWLEDGE_UNAVAILABLE', statusCode: 503 });
    } finally { release(); }
}

module.exports = { askKnowledge };
