// Controlled local trace. No provider requests or customer messages are used.
// Run: node tests/whatsapp-latency-benchmark.js
const { createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const WhatsApp = require('../src/services/whatsapp.service');
const AI = require('../src/services/ai.service');
const Onyx = require('../src/services/onyx-knowledge.service');
const RAG = require('../src/services/rag.service');
const Push = require('../src/services/push.service');
const Triggers = require('../src/services/smart-triggers.service');
const Sequences = require('../src/services/sequence.service');
const Personalization = require('../src/services/personalization.service');
const Logger = require('../src/utils/logger');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (rows, field, p) => {
    const sorted = rows.map(row => row[field] || 0).sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * p) - 1];
};

async function run() {
    createTestDB();
    const original = {
        send: WhatsApp._sendMessage,
        ai: AI.getResponse,
        onyx: Onyx.answer,
        rag: RAG.buildConversationContext,
        push: Push.notifyNewLead,
        triggers: Triggers.checkKeywordTriggers,
        sequences: Sequences.onClientReply,
        personalization: Personalization.analyzeContactTimes,
        log: Logger.info,
        idle: WhatsApp.delayTime,
        short: WhatsApp.shortDelayTime,
        max: WhatsApp.maxBatchTime,
        onyxWait: WhatsApp.onyxWaitMs,
        onyxHedge: WhatsApp.onyxHedgeMs,
    };
    const traces = [];
    WhatsApp._sendMessage = async () => { await sleep(40); return { idMessage: 'local-ack' }; };
    AI.getResponse = async () => {
        await sleep(160);
        return { reply: 'Тестовый ответ', status: 'new', action: 'none' };
    };
    Onyx.answer = async () => { await sleep(90); return null; };
    RAG.buildConversationContext = async (_id, _chatId, query) => {
        await sleep(60);
        return { query, context: '', searched: true };
    };
    Push.notifyNewLead = async () => {};
    Triggers.checkKeywordTriggers = async () => {};
    Sequences.onClientReply = async () => {};
    Personalization.analyzeContactTimes = async () => {};
    Logger.info = message => {
        if (message.startsWith('[WhatsAppLatency] ')) {
            traces.push(JSON.parse(message.slice('[WhatsAppLatency] '.length)));
        }
    };

    try {
        const instance = await DB.createInstance({ name: 'Latency fixture' });
        await DB.updateInstance(instance.id, { isActive: 1 });
        const scenarios = [
            { name: 'previous_defaults', idle: 9000, short: 18000, max: 30000 },
            { name: 'new_defaults', idle: 1500, short: 3500, max: 6000 },
            { name: 'slow_onyx_with_budget', idle: 1500, short: 3500, max: 6000,
                onyxDelay: 25000, onyxWait: 6000, onyxHedge: 3000 },
        ];
        for (const scenario of scenarios) {
            traces.length = 0;
            WhatsApp.delayTime = scenario.idle;
            WhatsApp.shortDelayTime = scenario.short;
            WhatsApp.maxBatchTime = scenario.max;
            WhatsApp.onyxWaitMs = scenario.onyxWait || original.onyxWait;
            WhatsApp.onyxHedgeMs = scenario.onyxHedge || original.onyxHedge;
            Onyx.answer = async () => {
                const delay = scenario.onyxDelay || 90;
                if (delay < 10000) await sleep(delay);
                else await new Promise(resolve => {
                    // Let the script finish after fallback; the separate test
                    // verifies behavior when this late provider resolves.
                    const timer = setTimeout(resolve, delay);
                    timer.unref();
                });
                return null;
            };
            const turnStart = Date.now();
            await Promise.all(Array.from({ length: 12 }, (_, i) => WhatsApp._handleIncomingMessage(
                instance.id,
                `${scenario.name}-${i}@c.us`,
                'Fixture',
                i < 6 ? 'Подскажите, какие условия бронирования указаны в документах?' : 'Подскажите',
            )));
            while (traces.length < 12 && Date.now() - turnStart < scenario.max + WhatsApp.onyxWaitMs + 3000) await sleep(10);
            if (traces.length !== 12 || traces.some(trace => trace.outcome !== 'acknowledged')) {
                throw new Error(`${scenario.name}: expected 12 acknowledged traces, got ${traces.length}`);
            }
            console.log(JSON.stringify({
                scenario: scenario.name,
                samples: traces.length,
                onyx_outcomes: traces.reduce((counts, trace) => {
                    counts[trace.onyx_outcome] = (counts[trace.onyx_outcome] || 0) + 1;
                    return counts;
                }, {}),
                inbound_save_ms: {
                    p50: percentile(traces, 'inbound_save_ms', 0.5),
                    p95: percentile(traces, 'inbound_save_ms', 0.95),
                },
                first_inbound_to_ack_ms: {
                    p50: percentile(traces, 'first_inbound_to_ack_ms', 0.5),
                    p95: percentile(traces, 'first_inbound_to_ack_ms', 0.95),
                },
                batch_wait_ms: {
                    p50: percentile(traces, 'batch_wait_ms', 0.5),
                    p95: percentile(traces, 'batch_wait_ms', 0.95),
                },
                context_ms: {
                    p50: percentile(traces, 'context_ms', 0.5),
                    p95: percentile(traces, 'context_ms', 0.95),
                },
                authorization_ms: {
                    p50: percentile(traces, 'authorization_ms', 0.5),
                    p95: percentile(traces, 'authorization_ms', 0.95),
                },
                memory_ms: {
                    p50: percentile(traces, 'memory_ms', 0.5),
                    p95: percentile(traces, 'memory_ms', 0.95),
                },
                pms_ms: {
                    p50: percentile(traces, 'pms_ms', 0.5),
                    p95: percentile(traces, 'pms_ms', 0.95),
                },
                onyx_ms: {
                    p50: percentile(traces, 'onyx_ms', 0.5),
                    p95: percentile(traces, 'onyx_ms', 0.95),
                },
                local_rag_ms: {
                    p50: percentile(traces, 'local_rag_ms', 0.5),
                    p95: percentile(traces, 'local_rag_ms', 0.95),
                },
                ai_ms: {
                    p50: percentile(traces, 'ai_ms', 0.5),
                    p95: percentile(traces, 'ai_ms', 0.95),
                },
                effects_ms: {
                    p50: percentile(traces, 'effects_ms', 0.5),
                    p95: percentile(traces, 'effects_ms', 0.95),
                },
                send_ack_ms: {
                    p50: percentile(traces, 'send_ack_ms', 0.5),
                    p95: percentile(traces, 'send_ack_ms', 0.95),
                },
                reply_save_ms: {
                    p50: percentile(traces, 'reply_save_ms', 0.5),
                    p95: percentile(traces, 'reply_save_ms', 0.95),
                },
            }));
            WhatsApp.batcher.clearAll();
        }
    } finally {
        WhatsApp._sendMessage = original.send;
        AI.getResponse = original.ai;
        Onyx.answer = original.onyx;
        RAG.buildConversationContext = original.rag;
        Push.notifyNewLead = original.push;
        Triggers.checkKeywordTriggers = original.triggers;
        Sequences.onClientReply = original.sequences;
        Personalization.analyzeContactTimes = original.personalization;
        Logger.info = original.log;
        WhatsApp.delayTime = original.idle;
        WhatsApp.shortDelayTime = original.short;
        WhatsApp.maxBatchTime = original.max;
        WhatsApp.onyxWaitMs = original.onyxWait;
        WhatsApp.onyxHedgeMs = original.onyxHedge;
        WhatsApp.batcher.clearAll();
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
