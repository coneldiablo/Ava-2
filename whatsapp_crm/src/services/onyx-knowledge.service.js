const axios = require('axios');
const crypto = require('crypto');
const DB = require('./database.service');

// The server's grounded turn plus private-session teardown can exceed the
// previous chat timeout. This bounds the CRM wait above that server budget.
const ANSWER_TIMEOUT_MS = 65000;

class OnyxKnowledgeService {
    async answer({ businessId, question, channel, chatId = null, correlationId = null, shouldRecord = null } = {}) {
        // Voice must not wait for a long Onyx retrieval during a live call.
        if (!Number.isSafeInteger(businessId) || businessId < 1 || channel !== 'whatsapp'
            || typeof question !== 'string' || !question.trim() || question.length > 8000) return null;
        const instance = await DB.getInstance(businessId);
        if (!instance?.isActive) return null;
        // No request/model parameter can select the server, API key, preview
        // mode, agent or tenant. The upstream independently checks active scope.
        const token = process.env.CRM_SERVICE_API_TOKEN;
        const base = (process.env.AVA_ADMIN_API_URL || '').replace(/\/+$/, '');
        if (!token || !base) return null;
        const requestId = correlationId || crypto.randomUUID();
        try {
            // Select identity from the current transport, not a model-supplied
            // customerId/history.
            let customerId = null;
            if (chatId) {
                const resolved = await require('./sales-brain.service').resolveCustomer({
                    instanceId: businessId, chatId,
                });
                if (resolved.found && Number.isSafeInteger(resolved.client?.id)) customerId = resolved.client.id;
            }
            const response = await axios.post(`${base}/api/internal/onyx/knowledge`, {
                business_id: businessId, question: question.trim(), channel, correlation_id: requestId,
                ...(customerId === null ? {} : { customer_id: customerId }),
            }, { headers: { Authorization: `Bearer ${token}` },
                timeout: ANSWER_TIMEOUT_MS, maxRedirects: 0,
                maxContentLength: 128 * 1024, maxBodyLength: 32 * 1024 });
            const result = response.data;
            if (!result || typeof result !== 'object' || Array.isArray(result)
                || result.handled !== true || result.error_code != null || result.success === false
                || result.business_id !== businessId || result.channel !== channel
                || result.correlation_id !== requestId || result.preview !== false || result.stale !== false
                || result.grounded !== true || !Array.isArray(result.citations) || !result.citations.length
                || result.citations.length > 50 || !result.citations.every(citation => citation
                    && typeof citation === 'object' && !Array.isArray(citation)
                    && Number.isSafeInteger(citation.source_id) && citation.source_id > 0
                    && (citation.title == null || (typeof citation.title === 'string' && citation.title.length <= 300)))
                || (customerId !== null && (result.customer_id !== customerId || result.customer_context_provided !== true))
                || (customerId === null && (result.customer_id != null || result.customer_context_provided === true))
                || typeof result.answer !== 'string' || !result.answer.trim() || result.answer.length > 20000) return null;
            // A business may be disabled while the provider is answering.
            if (!(await DB.getInstance(businessId))?.isActive) return null;
            // Record verified provenance, not private provider errors or tokens.
            if (typeof shouldRecord !== 'function' || shouldRecord()) {
                DB.createMlDecision({ instanceId: businessId, chatId, taskType: 'rag_answer', model: 'onyx.scoped_knowledge',
                    output: result, latencyMs: result.response_time_ms || 0 });
            }
            return result;
        } catch (_) {
            return null; // Same-business local RAG remains the outage fallback.
        }
    }
}

module.exports = new OnyxKnowledgeService();
