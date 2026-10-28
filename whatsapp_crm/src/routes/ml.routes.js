const express = require('express');
const router = express.Router();
const SalesBrain = require('../services/sales-brain.service');
const DB = require('../services/database.service');
const HotelProfileService = require('../services/hotel-profile.service');
const RAGService = require('../services/rag.service');
const DocumentQueue = require('../queues/document-queue');
const Logger = require('../utils/logger');
const PmsService = require('../services/pms/pms.service');
const TwentyService = require('../services/twenty/twenty.service');

function asyncRoute(handler) {
    return async (req, res) => {
        try {
            const result = await handler(req, res);
            if (!res.headersSent) {
                res.json({ success: true, ...result });
            }
        } catch (e) {
            Logger.error(`[SalesBrain API] ${req.method} ${Logger.safeRequestPath(req.originalUrl)} error:`, e);
            res.status(e.statusCode || 500).json({
                success: false,
                error: e.message,
                error_code: e.code || 'INTERNAL_SERVICE_ERROR',
                correlation_id: e.correlationId || null,
            });
        }
    };
}

const multer = require('multer');
const hotelKnowledgeUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 10 }
}).fields([
    { name: 'files', maxCount: 10 },
    { name: 'file', maxCount: 10 }
]);

const HOTEL_KB_ALLOWED_TYPES = new Set([
    'application/pdf',
    'text/plain',
    'text/csv',
    'text/markdown',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png',
    'image/jpeg',
    'image/jpg'
]);

const DEFAULT_HOTEL_SMOKE_QUESTIONS = [
    'Какие категории номеров есть в отеле?',
    'Сколько стоит стандартный номер?',
    'Во сколько начинается завтрак?',
    'До скольки подают завтрак?',
    'Есть ли трансфер из аэропорта?',
    'Сколько стоит трансфер?',
    'Во сколько заезд?',
    'Во сколько выезд?',
    'Можно ли ранний заезд?',
    'Можно ли поздний выезд?',
    'Можно ли с животными?',
    'Есть ли парковка?',
    'Какие услуги включены в проживание?',
    'Есть ли spa или фитнес?',
    'Как отменить бронирование?',
    'Какие правила оплаты?',
    'Есть ли детская кроватка?',
    'Есть ли Wi-Fi?',
    'Какие документы нужны при заселении?',
    'Что делать, если ответа нет в базе?'
];

function httpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function collectUploadFiles(req) {
    return [
        ...(Array.isArray(req.files) ? req.files : []),
        ...((req.files && req.files.files) || []),
        ...((req.files && req.files.file) || []),
        ...(req.file ? [req.file] : [])
    ];
}

async function resolveHotelKnowledgeScope(hotelId) {
    const profile = await HotelProfileService.get(hotelId);
    if (!profile) {
        throw httpError(404, 'hotel profile not found');
    }
    const knowledgeBaseInstanceId = Number(profile.knowledgeBaseInstanceId || profile.instanceId || profile.id);
    if (!Number.isFinite(knowledgeBaseInstanceId) || knowledgeBaseInstanceId < 1) {
        throw httpError(400, 'invalid hotel knowledgeBaseInstanceId');
    }
    return { profile, knowledgeBaseInstanceId };
}

async function processHotelKnowledgeFile(knowledgeBaseInstanceId, file) {
    if (!HOTEL_KB_ALLOWED_TYPES.has(file.mimetype)) {
        return {
            originalName: file.originalname,
            success: false,
            error: `Unsupported format: ${file.mimetype}`
        };
    }

    if (DocumentQueue.isAvailable()) {
        const jobId = await DocumentQueue.addDocumentJob(
            knowledgeBaseInstanceId,
            file.buffer,
            file.originalname,
            file.mimetype
        );
        if (jobId) {
            return { originalName: file.originalname, success: true, jobId, queued: true };
        }
    }

    const startTime = Date.now();
    const result = await RAGService.processDocument(
        knowledgeBaseInstanceId,
        file.buffer,
        file.originalname,
        file.mimetype
    );
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
    return {
        originalName: file.originalname,
        ...result,
        processingTime: result.success ? `${processingTime}s` : undefined
    };
}

function mapRagResults(searchResult) {
    const results = searchResult.effectiveResults || [];
    return {
        searchType: searchResult.searchType,
        responseTimeMs: searchResult.responseTimeMs,
        resultsCount: results.length,
        results: results.map((result) => ({
            id: result.id,
            kbId: result.kbId,
            text: result.text,
            section: result.section,
            originalName: result.originalName,
            score: result.combinedScore || result.score,
            keywordScore: result.keywordScore,
            vectorScore: result.vectorScore,
            searchType: result.searchType,
            reranked: result.reranked || false
        }))
    };
}

function normalizeSmokeQuestions(rawQuestions) {
    const questions = Array.isArray(rawQuestions) && rawQuestions.length
        ? rawQuestions
        : DEFAULT_HOTEL_SMOKE_QUESTIONS.map((question) => ({ question }));
    return questions
        .map((item) => {
            if (typeof item === 'string') return { question: item.trim(), expected: [] };
            const expected = Array.isArray(item.expected)
                ? item.expected
                : String(item.expected || '')
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean);
            return { question: String(item.question || '').trim(), expected };
        })
        .filter((item) => item.question)
        .slice(0, 40);
}

function smokeAnswerStatus(result, expected) {
    const noAnswer = Boolean(result.should_handoff) && Number(result.confidence || 0) === 0;
    if (noAnswer) return 'missing';
    if (!expected || expected.length === 0) return result.answer ? 'answered' : 'missing';

    const haystack = `${result.answer || ''} ${result.spoken || ''}`.toLowerCase();
    const matched = expected.some((token) => haystack.includes(String(token).toLowerCase()));
    return matched ? 'passed' : 'failed';
}

router.get('/hotel-profiles', asyncRoute(async () => {
    return { profiles: await HotelProfileService.list() };
}));

router.get('/hotel-profiles/by-sip-alias/:alias', asyncRoute(async (req) => {
    const profile = await HotelProfileService.findBySipAlias(req.params.alias);
    return { profile };
}));

router.get('/hotel-profiles/:id', asyncRoute(async (req) => {
    const profile = await HotelProfileService.get(req.params.id);
    if (!profile) {
        const error = new Error('hotel profile not found');
        error.statusCode = 404;
        throw error;
    }
    return { profile };
}));

router.post('/hotel-profiles', asyncRoute(async (req) => {
    const idempotencyKey = req.headers['idempotency-key'] || req.body?.idempotencyKey || null;
    return { profile: await HotelProfileService.create(req.body || {}, { idempotencyKey }) };
}));

router.get('/hotel-profiles/:id/provisioning', asyncRoute(async (req) => {
    const provisioning = await HotelProfileService.getProvisioningStatus(req.params.id);
    if (!provisioning) {
        throw httpError(404, 'hotel profile not found');
    }
    return { provisioning };
}));

router.post('/hotel-profiles/:id/provisioning/retry', asyncRoute(async (req) => {
    const result = await HotelProfileService.retryProvisioning(req.params.id, {
        module: req.body?.module || null,
    });
    return result;
}));

router.put('/hotel-profiles/:id', asyncRoute(async (req) => {
    return { profile: await HotelProfileService.update(req.params.id, req.body || {}) };
}));

router.get('/hotel-profiles/:id/knowledge-base', asyncRoute(async (req) => {
    const { profile, knowledgeBaseInstanceId } = await resolveHotelKnowledgeScope(req.params.id);
    const [files, stats] = await Promise.all([
        DB.getKnowledgeBaseFiles(knowledgeBaseInstanceId),
        RAGService.getStats(knowledgeBaseInstanceId)
    ]);
    return { profile, knowledgeBaseInstanceId, files, stats };
}));

router.post('/hotel-profiles/:id/knowledge-base/upload', hotelKnowledgeUpload, asyncRoute(async (req) => {
    const { profile, knowledgeBaseInstanceId } = await resolveHotelKnowledgeScope(req.params.id);
    const files = collectUploadFiles(req);
    if (files.length === 0) {
        throw httpError(400, 'files are required');
    }

    const results = [];
    for (const file of files) {
        results.push(await processHotelKnowledgeFile(knowledgeBaseInstanceId, file));
    }

    const hasSuccess = results.some((result) => result.success);
    const hasFailure = results.some((result) => !result.success);
    if (!hasSuccess) {
        const error = httpError(results[0]?.isDuplicate ? 409 : 400, results[0]?.error || 'upload failed');
        error.results = results;
        throw error;
    }

    return {
        profile,
        knowledgeBaseInstanceId,
        results,
        partial: hasFailure
    };
}));

router.post('/hotel-profiles/:id/knowledge-base/text', asyncRoute(async (req) => {
    const { profile, knowledgeBaseInstanceId } = await resolveHotelKnowledgeScope(req.params.id);
    const title = String(req.body?.title || 'hotel-knowledge-base.md').trim();
    const text = String(req.body?.text || '').trim();
    if (!title) throw httpError(400, 'title is required');
    if (!text) throw httpError(400, 'text is required');

    const originalName = /\.(md|txt)$/i.test(title) ? title : `${title}.md`;
    const result = await RAGService.processDocument(
        knowledgeBaseInstanceId,
        Buffer.from(text, 'utf8'),
        originalName,
        'text/markdown'
    );
    if (!result.success) {
        throw httpError(result.isDuplicate ? 409 : 400, result.error || 'text upload failed');
    }

    return { profile, knowledgeBaseInstanceId, result };
}));

router.post('/hotel-profiles/:id/knowledge-base/search', asyncRoute(async (req) => {
    const { profile, knowledgeBaseInstanceId } = await resolveHotelKnowledgeScope(req.params.id);
    const query = String(req.body?.query || '').trim();
    if (!query) throw httpError(400, 'query is required');

    const searchResult = await RAGService.runSearchPipeline(knowledgeBaseInstanceId, query, {
        searchType: req.body?.searchType || 'hybrid',
        k: Math.max(1, Math.min(Number(req.body?.k || 5), 10)),
        applyThreshold: true,
        usedByAI: false
    });

    return {
        profile,
        knowledgeBaseInstanceId,
        query,
        ...mapRagResults(searchResult)
    };
}));

router.delete('/hotel-profiles/:id/knowledge-base/:fileId', asyncRoute(async (req) => {
    const { profile, knowledgeBaseInstanceId } = await resolveHotelKnowledgeScope(req.params.id);
    const fileId = Number(req.params.fileId);
    if (!Number.isInteger(fileId) || fileId < 1) {
        throw httpError(400, 'invalid fileId');
    }

    const result = await DB.deleteKnowledgeBaseFile(fileId, knowledgeBaseInstanceId);
    return { profile, knowledgeBaseInstanceId, result };
}));

router.post('/hotel-profiles/:id/knowledge-base/smoke-test', asyncRoute(async (req) => {
    const { profile, knowledgeBaseInstanceId } = await resolveHotelKnowledgeScope(req.params.id);
    const questions = normalizeSmokeQuestions(req.body?.questions);
    if (!questions.length) throw httpError(400, 'questions are required');

    const results = [];
    for (const item of questions) {
        const answer = await RAGService.answerFromKnowledge(knowledgeBaseInstanceId, item.question, {
            channel: 'text',
            k: Math.max(1, Math.min(Number(req.body?.k || 5), 8)),
            searchType: req.body?.searchType || 'hybrid'
        });
        const status = smokeAnswerStatus(answer, item.expected);
        results.push({
            question: item.question,
            expected: item.expected,
            status,
            answer: answer.answer,
            confidence: answer.confidence,
            citations: answer.citations || [],
            should_handoff: Boolean(answer.should_handoff)
        });
    }

    const failed = results.filter((result) => result.status === 'failed').length;
    return {
        profile,
        knowledgeBaseInstanceId,
        smoke: {
            total: results.length,
            passed: results.length - failed,
            failed,
            results
        }
    };
}));

router.post('/customer/resolve', asyncRoute(async (req) => {
    return SalesBrain.resolveCustomer(req.body || {});
}));

router.post('/customer/summary', asyncRoute(async (req) => {
    return SalesBrain.customerSummary(req.body || {});
}));

router.post('/customer/timeline', asyncRoute(async (req) => {
    return SalesBrain.getTimeline(req.body || {});
}));

router.post('/customer/link', asyncRoute(async (req) => {
    return SalesBrain.bindCustomerAlias(req.body || {});
}));

router.post('/context/assemble', asyncRoute(async (req) => {
    return SalesBrain.assembleContext(req.body || {});
}));

router.post('/outbound/opening', asyncRoute(async (req) => {
    return SalesBrain.generateOutboundOpening(req.body || {});
}));

router.post('/reply', asyncRoute(async (req) => {
    return SalesBrain.reply(req.body || {});
}));

router.post('/classify-stage', asyncRoute(async (req) => {
    const decision = SalesBrain.classifyStage(req.body || {});
    DB.createMlDecision({
        instanceId: Number(req.body.instanceId || req.body.instance_id || SalesBrain.defaultInstanceId()),
        chatId: req.body.chatId || req.body.chat_id || null,
        taskType: 'lead_stage_classifier',
        output: decision,
        confidence: decision.confidence
    });
    return { decision };
}));

router.post('/next-action', asyncRoute(async (req) => {
    return SalesBrain.nextAction(req.body || {});
}));

router.post('/rag/answer', asyncRoute(async (req) => {
    const result = await SalesBrain.answerFromKnowledge(req.body || {});
    return { result };
}));

router.post('/post-call', asyncRoute(async (req) => {
    return SalesBrain.postCall(req.body || {});
}));

router.get('/post-call/summary', asyncRoute(async (req) => {
    return SalesBrain.getPostCallSummary(req.query || {});
}));

router.post('/tool-result', asyncRoute(async (req) => {
    const toolRun = DB.createToolRun({
        instanceId: Number(req.body.instanceId || req.body.instance_id || SalesBrain.defaultInstanceId()),
        chatId: req.body.chatId || req.body.chat_id || null,
        customerId: req.body.customerId || req.body.customer_id || null,
        callId: req.body.callId || req.body.call_id || null,
        conversationEventId: req.body.conversationEventId || req.body.conversation_event_id || null,
        toolName: req.body.toolName || req.body.tool_name || 'unknown_tool',
        phase: req.body.phase || 'internal',
        argsRedacted: req.body.argsRedacted || req.body.args_redacted || {},
        resultRedacted: req.body.resultRedacted || req.body.result_redacted || {},
        status: req.body.status || 'ok',
        latencyMs: req.body.latencyMs || req.body.latency_ms || 0
    });
    return { tool_run: toolRun };
}));

router.post('/crm-note', asyncRoute(async (req) => {
    return SalesBrain.createCrmNote(req.body || {});
}));

router.post('/manager-task', asyncRoute(async (req) => {
    return SalesBrain.createManagerTask(req.body || {});
}));

// Manager handoff queue. instanceId is required scope on every call: tasks of
// one business must never be readable or writable from another.
router.get('/manager-tasks', asyncRoute(async (req) => {
    return SalesBrain.listManagerTasks({
        instanceId: req.query.instanceId || req.query.instance_id || req.query.business_id,
        status: req.query.status,
        callId: req.query.callId || req.query.call_id,
        phone: req.query.phone,
        limit: req.query.limit,
    });
}));

router.patch('/manager-tasks/:taskId', asyncRoute(async (req) => {
    return SalesBrain.updateManagerTask({
        ...(req.body || {}),
        taskId: req.params.taskId,
        instanceId: (req.body && (req.body.instanceId || req.body.instance_id))
            || req.query.instanceId
            || req.query.instance_id
            || req.query.business_id,
    });
}));

router.post('/stage/update', asyncRoute(async (req) => {
    return SalesBrain.updateStage(req.body || {});
}));

router.post('/followup/draft', asyncRoute(async (req) => {
    return SalesBrain.draftWhatsAppFollowup(req.body || {});
}));

router.post('/followup/drafts', asyncRoute(async (req) => {
    return SalesBrain.listFollowupDrafts(req.body || {});
}));

router.post('/followup/send', asyncRoute(async (req) => {
    return SalesBrain.sendWhatsAppFollowup(req.body || {});
}));

router.post('/followup/approve', asyncRoute(async (req) => {
    return SalesBrain.approveWhatsAppFollowup(req.body || {});
}));

// Pilot analytics aggregates for one business. Counts only — no client rows,
// no phone numbers, no message bodies.
router.get('/pilot-analytics', asyncRoute(async (req) => {
    return SalesBrain.pilotAnalytics({
        instanceId: req.query.instanceId || req.query.instance_id || req.query.business_id,
        startAt: req.query.startAt || req.query.start_at,
        endAt: req.query.endAt || req.query.end_at,
    });
}));

// Manager approval queue. instanceId is required scope on every call: a draft
// of one business must never be readable, editable or sendable from another.
router.get('/followup-drafts', asyncRoute(async (req) => {
    return SalesBrain.listFollowupDrafts({
        instanceId: req.query.instanceId || req.query.instance_id || req.query.business_id,
        status: req.query.status,
        chatId: req.query.chatId || req.query.chat_id,
        callId: req.query.callId || req.query.call_id,
        managerTaskId: req.query.managerTaskId || req.query.manager_task_id,
        limit: req.query.limit,
    });
}));

router.patch('/followup-drafts/:draftId', asyncRoute(async (req) => {
    const body = req.body || {};
    const scoped = {
        ...body,
        draftId: req.params.draftId,
        instanceId: body.instanceId
            || body.instance_id
            || req.query.instanceId
            || req.query.instance_id
            || req.query.business_id,
    };
    const action = String(body.action || '').trim().toLowerCase();
    if (action === 'approve') return SalesBrain.approveWhatsAppFollowup(scoped);
    if (action === 'reject') return SalesBrain.rejectFollowupDraft(scoped);
    if (action === 'edit' || body.text !== undefined) return SalesBrain.editFollowupDraft(scoped);
    return { success: false, error: 'unsupported_action', allowed_actions: ['edit', 'approve', 'reject'] };
}));

router.get('/outbound/campaigns', asyncRoute(async (req) => {
    return SalesBrain.listOutboundCampaigns({
        instanceId: req.query.instanceId || req.query.instance_id,
        includeDisabled: req.query.includeDisabled === 'true' || req.query.include_disabled === 'true',
        includeArchived: req.query.includeArchived === 'true' || req.query.include_archived === 'true',
    });
}));

router.post('/outbound/campaigns', asyncRoute(async (req) => {
    return SalesBrain.createOutboundCampaign(req.body || {});
}));

router.get('/outbound/campaigns/:campaignId', asyncRoute(async (req) => {
    return SalesBrain.getOutboundCampaign({ campaignId: req.params.campaignId });
}));

router.patch('/outbound/campaigns/:campaignId', asyncRoute(async (req) => {
    return SalesBrain.updateOutboundCampaign({ ...(req.body || {}), campaignId: req.params.campaignId });
}));

router.post('/outbound/campaigns/:campaignId/sync-leads', asyncRoute(async (req) => {
    return SalesBrain.syncOutboundCampaignLeads({ ...(req.body || {}), campaignId: req.params.campaignId });
}));

router.get('/outbound/campaigns/:campaignId/leads', asyncRoute(async (req) => {
    return SalesBrain.listOutboundLeads({
        campaignId: req.params.campaignId,
        state: req.query.state,
        limit: req.query.limit,
    });
}));

router.post('/outbound/campaigns/:campaignId/runnable-leads', asyncRoute(async (req) => {
    return SalesBrain.getRunnableOutboundLeads({ ...(req.body || {}), campaignId: req.params.campaignId });
}));

router.post('/outbound/campaigns/:campaignId/ava-export', asyncRoute(async (req) => {
    return SalesBrain.exportOutboundCampaignForAva({ ...(req.body || {}), campaignId: req.params.campaignId });
}));

router.post('/outbound/attempts', asyncRoute(async (req) => {
    return SalesBrain.recordOutboundAttempt(req.body || {});
}));

// PMS administration — all operations are scoped by the hotel profile ID.
router.get('/hotel-profiles/:id/pms', asyncRoute(async (req) => ({ pms: PmsService.get(req.params.id) })));
router.put('/hotel-profiles/:id/pms', asyncRoute(async (req) => ({ pms: PmsService.configure(req.params.id, req.body || {}) })));
router.delete('/hotel-profiles/:id/pms', asyncRoute(async (req) => PmsService.disconnect(req.params.id)));
router.post('/hotel-profiles/:id/pms/test', asyncRoute(async (req) => PmsService.test(req.params.id, req.body?.correlation_id)));
router.post('/hotel-profiles/:id/pms/sync', asyncRoute(async (req) => PmsService.enqueueInitialSync(req.params.id)));
router.post('/hotel-profiles/:id/pms/webhooks', asyncRoute(async (req) => PmsService.connectWebhooks(
    req.params.id, req.body?.public_base_url, req.body?.correlation_id,
)));
router.get('/hotel-profiles/:id/pms/bookings', asyncRoute(async (req) => ({
    business_id: Number(req.params.id), provider: 'bnovo',
    bookings: PmsService.listBookings(req.params.id, {
        phone: req.query.phone, bookingNumber: req.query.booking_number, limit: req.query.limit,
    }),
})));
router.get('/hotel-profiles/:id/pms/booking-requests', asyncRoute(async (req) => ({
    business_id: Number(req.params.id), provider: 'bnovo',
    booking_requests: PmsService.listBookingRequests(req.params.id, { status: req.query.status, limit: req.query.limit }),
})));

// Twenty CRM bridge — one isolated workspace link per hotel/business.
router.get('/hotel-profiles/:id/twenty', asyncRoute(async (req) => ({
    twenty: TwentyService.get(req.params.id),
})));
router.put('/hotel-profiles/:id/twenty', asyncRoute(async (req) => ({
    twenty: TwentyService.configure(req.params.id, req.body || {}),
})));
router.delete('/hotel-profiles/:id/twenty', asyncRoute(async (req) => TwentyService.disconnect(req.params.id)));
router.post('/hotel-profiles/:id/twenty/test', asyncRoute(async (req) => ({
    twenty: await TwentyService.test(req.params.id, req.body?.correlation_id),
})));
router.post('/hotel-profiles/:id/twenty/sync', asyncRoute(async (req) => TwentyService.enqueueInitialSync(req.params.id)));
router.post('/hotel-profiles/:id/twenty/webhook', asyncRoute(async (req) => ({
    twenty: TwentyService.connectWebhook(req.params.id, req.body?.public_base_url),
})));

// Voice/WhatsApp service contract. The MCP wrapper overwrites the tenant and
// current caller fields from ToolExecutionContext before these handlers run.
router.post('/pms/lookup-booking', asyncRoute(async (req) => PmsService.lookupBooking(
    req.body?.business_id || req.body?.instance_id, req.body || {},
)));
router.post('/pms/check-availability', asyncRoute(async (req) => PmsService.checkAvailability(
    req.body?.business_id || req.body?.instance_id, req.body || {},
)));
router.post('/pms/booking-services', asyncRoute(async (req) => PmsService.bookingServices(
    req.body?.business_id || req.body?.instance_id, req.body || {},
)));
router.post('/pms/booking-request', asyncRoute(async (req) => PmsService.createBookingRequest(
    req.body?.business_id || req.body?.instance_id, req.body || {},
)));
router.get('/pms/customer-context', asyncRoute(async (req) => PmsService.customerContext(
    req.query.business_id || req.query.instance_id, req.query.caller_number || req.query.phone,
)));

router.get('/memory/status', asyncRoute(async (req) => {
    const memory=require('../services/crm-memory-store.service');
    return memory.diagnostics(memory.businessId(req.query.business_id));
}));
router.post('/memory/backfill', asyncRoute(async (req) => require('../services/crm-memory-store.service').backfill(
    require('../services/crm-memory-store.service').businessId(req.body?.business_id), 50,
    { dryRun: req.body?.dry_run !== false, afterCustomerId: req.body?.after_customer_id ?? 0 },
)));
router.post('/memory/retry', asyncRoute(async (req) => {
    const memory=require('../services/crm-memory-store.service');
    const businessId=memory.businessId(req.body?.business_id);
    return {business_id:businessId,retried:memory.retryJob(businessId,req.body?.job_id)};
}));

router.post('/evaluate/smoke', asyncRoute(async () => {
    return SalesBrain.runSmokeEval();
}));

module.exports = router;
