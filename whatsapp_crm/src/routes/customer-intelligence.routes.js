'use strict';

const express = require('express');
const DB = require('../services/database.service');
const Identity = require('../services/identity/identity-store');
const MemoryStore = require('../services/crm-memory-store.service');

const router = express.Router();

function parseJson(value, fallback) {
    if (typeof value !== 'string' || value.length > 65536) return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function safeList(value, limit = 8, itemLimit = 120) {
    const parsed = typeof value === 'string' ? parseJson(value, value) : value;
    const items = Array.isArray(parsed) ? parsed : typeof parsed === 'string' ? parsed.split(/[,;\n]+/) : [];
    return [...new Set(items.slice(0, 32).filter(item => typeof item === 'string')
        .map(item => MemoryStore.safeText(item, itemLimit)).filter(Boolean))].slice(0, limit);
}

function safeDate(value) {
    if (typeof value !== 'string' || value.length > 40) return null;
    const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
    const date = new Date(normalized);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeCode(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,64}$/.test(value) ? value : null;
}

function safeDuration(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function scopedCalls(instanceId, chatId) {
    // An exact chat link is required. A matching phone number alone is not
    // evidence that a call belongs to this client.
    const attempts = DB.all(
        `SELECT a.attemptId, a.callId, a.status, a.outcome, a.startedAt, a.durationSec
         FROM outbound_attempts a
         JOIN outbound_leads l ON l.instanceId = a.instanceId AND l.leadId = a.leadId
         WHERE a.instanceId = ? AND l.chatId = ?
         ORDER BY a.startedAt DESC, a.attemptId DESC LIMIT 50`,
        [instanceId, chatId]
    );
    const events = DB.all(
        `SELECT eventId, callId, createdAt, metadataJson
         FROM conversation_events
         WHERE instanceId = ? AND chatId = ? AND channel = 'voice' AND callId IS NOT NULL
         ORDER BY createdAt DESC, eventId DESC LIMIT 50`,
        [instanceId, chatId]
    );
    const calls = attempts.map((row, index) => ({
        id: `attempt:${index}`,
        source: 'outbound_attempt',
        callId: safeCode(row.callId),
        timestamp: safeDate(row.startedAt),
        direction: 'outbound',
        status: safeCode(row.status),
        outcome: safeCode(row.outcome),
        durationSeconds: safeDuration(row.durationSec),
    }));
    const byCallId = new Map(calls.filter(call => call.callId).map(call => [call.callId, call]));
    for (const [index, row] of events.entries()) {
        const metadata = parseJson(row.metadataJson, {});
        const details = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
        const callId = safeCode(row.callId);
        const existing = callId && byCallId.get(callId);
        if (existing) {
            // The event can fill an absent outcome without duplicating the call.
            existing.outcome ||= safeCode(details.outcome);
            existing.durationSeconds ??= safeDuration(details.duration_seconds);
            continue;
        }
        const call = {
            id: `event:${index}`,
            source: 'scoped_call_event',
            callId,
            timestamp: safeDate(row.createdAt),
            direction: ['inbound', 'outbound'].includes(details.call_direction) ? details.call_direction : null,
            status: null,
            outcome: safeCode(details.outcome),
            durationSeconds: safeDuration(details.duration_seconds),
        };
        calls.push(call);
        if (callId) byCallId.set(callId, call);
    }
    return calls.sort((a, b) => (Date.parse(b.timestamp || '') || 0) - (Date.parse(a.timestamp || '') || 0))
        .map(({ callId: _callId, ...call }) => call);
}

function scopedTasks(instanceId, chatId) {
    return DB.all(
        `SELECT taskId, summary, status, source, createdAt, updatedAt
         FROM manager_tasks WHERE instanceId = ? AND chatId = ?
         ORDER BY createdAt DESC, taskId DESC LIMIT 50`,
        [instanceId, chatId]
    ).map((row, index) => ({
        id: `task:${index}`,
        summary: MemoryStore.safeText(row.summary, 240),
        status: safeCode(row.status),
        source: safeCode(row.source),
        createdAt: safeDate(row.createdAt),
        updatedAt: safeDate(row.updatedAt),
        provenance: row.source === 'manual' ? 'manager_confirmed' : 'source_record',
    }));
}

function safeGenerated(value) {
    if (!value) return null;
    const status = ['ai_summary', 'generation_pending', 'policy_refresh_required'].includes(value.status)
        ? value.status : 'unavailable';
    return {
        provenance: 'ai_generated', status,
        summary: status === 'ai_summary' ? MemoryStore.safeText(value.summary, 600) : null,
        interests: status === 'ai_summary' ? safeList(value.interests) : [],
        objections: status === 'ai_summary' ? safeList(value.objections) : [],
        importantDates: status === 'ai_summary' ? safeList(value.dates) : [],
        sourceUpdatedAt: safeDate(value.source_updated_at),
        generatedAt: safeDate(value.generated_at),
        sourceComplete: value.source_complete === true,
    };
}

// Mount after requireAuth. This router also checks identity and membership itself,
// so a direct request cannot bypass the customer-access allowlist or tenant scope.
router.get('/customer-intelligence/:instanceId/:chatId', async (req, res) => {
    const instanceId = Number(req.params.instanceId);
    let chatId = req.params.chatId;
    if (!Number.isSafeInteger(instanceId) || instanceId < 1 || !chatId || chatId.length > 256) {
        return res.status(400).json({ success: false, error: 'INVALID_CUSTOMER_SCOPE' });
    }

    try {
        if (!req.auth?.userId || req.auth.platformRole === 'platform_admin') {
            return res.status(403).json({ success: false, error: 'CUSTOMER_ACCESS_REQUIRED' });
        }
        Identity.authorizeCapability(req.auth, instanceId, 'business.read');
        const client = await DB.getClient(instanceId, chatId);
        if (!client) return res.status(404).json({ success: false, error: 'CLIENT_NOT_FOUND' });
        chatId = client.chatId;

        // Select only customer-facing fields. In particular, messages.aiThought,
        // CRM identifiers and raw model metadata never enter this response.
        const messages = DB.all(
            `SELECT id, senderName, messageType, content, role, timestamp, channel
             FROM messages WHERE instanceId = ? AND chatId = ?
             ORDER BY timestamp DESC, id DESC LIMIT 150`,
            [instanceId, chatId]
        ).reverse().map(message => ({
            id: message.id,
            senderName: message.senderName,
            messageType: message.messageType,
            content: message.content,
            role: message.role,
            timestamp: safeDate(message.timestamp),
            channel: message.channel,
        }));
        const count = DB.get(
            'SELECT COUNT(*) AS total FROM messages WHERE instanceId = ? AND chatId = ?',
            [instanceId, chatId]
        );
        // Only allowlisted profile fields are serialized; rawProfileJson is read
        // for three specific fields but the raw object never leaves this process.
        const savedProfile = DB.get(
            `SELECT interests, objections, rawProfileJson, lastProfileUpdate
             FROM client_profiles WHERE instanceId = ? AND chatId = ?`,
            [instanceId, chatId]
        );
        const raw = parseJson(savedProfile?.rawProfileJson, {});
        const allowedRaw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const customerMemory = savedProfile ? {
            provenance: 'saved_ai_profile',
            interests: safeList(savedProfile.interests),
            objections: safeList(savedProfile.objections),
            importantDates: safeList(allowedRaw.importantDates),
            keyFacts: safeList(allowedRaw.keyFacts, 8, 180),
            lastCallSummary: MemoryStore.safeText(allowedRaw.lastCallSummary, 220),
            lastCallAt: safeDate(allowedRaw.lastCallAt),
            lastProfileUpdate: safeDate(savedProfile.lastProfileUpdate),
        } : null;
        // This service enforces the same instance/chat scope and policy version.
        // Do not expose its internal budget, needs, next step, model, or scores.
        const conversationMemory = safeGenerated(MemoryStore.latest(instanceId, chatId, 'conversation'));
        const callMemory = safeGenerated(MemoryStore.latest(instanceId, chatId, 'call'));
        const statusHistory = DB.all(
            `SELECT id, fromStatus, toStatus, changedBy, createdAt
             FROM lead_status_history WHERE instanceId = ? AND chatId = ?
             ORDER BY createdAt DESC, id DESC LIMIT 50`,
            [instanceId, chatId]
        ).reverse().map(status => ({
            id: status.id,
            fromStatus: status.fromStatus,
            toStatus: status.toStatus,
            provenance: status.changedBy === 'manual' ? 'manager_confirmed' : 'source_record',
            createdAt: safeDate(status.createdAt),
        }));
        const callEvents = scopedCalls(instanceId, chatId);
        const tasks = scopedTasks(instanceId, chatId);
        let tags = [];
        try {
            const parsed = JSON.parse(client.tags || '[]');
            if (Array.isArray(parsed)) tags = parsed.filter(tag => typeof tag === 'string').slice(0, 30);
        } catch (_) { /* malformed legacy tags are simply omitted */ }

        // A membership may be revoked while the awaited client lookup runs.
        // Recheck immediately before returning customer history and memory.
        require('../services/identity/customer-access').reauthorize(req, instanceId, 'business.read');
        return res.json({
            success: true,
            canonicalChatId: client.chatId,
            client: {
                id: client.id,
                instanceId,
                chatId: client.chatId,
                senderName: client.senderName,
                leadStatus: client.leadStatus,
                assigneeUserId: client.assigneeUserId || null,
                tags,
                createdAt: safeDate(client.createdAt),
                updatedAt: safeDate(client.updatedAt),
                lastMessageTime: safeDate(client.lastMessageTime),
            },
            messages,
            messageCount: count?.total || 0,
            messagesTruncated: (count?.total || 0) > messages.length,
            statusHistory,
            callEvents,
            tasks,
            customerMemory,
            generatedMemory: { conversation: conversationMemory, call: callMemory },
        });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: 'BUSINESS_ACCESS_DENIED' });
        return res.status(500).json({ success: false, error: 'CUSTOMER_INTELLIGENCE_UNAVAILABLE' });
    }
});

module.exports = router;
