const express = require('express');
const router = express.Router();
const TwentyStore = require('../services/twenty/twenty-store.service');
const { decryptJson, sha256, verifyWebhookSignature } = require('../services/twenty/twenty-crypto');
const Logger = require('../utils/logger');

const ALLOWED_EVENTS = new Set([
    'person.updated',
    'opportunity.updated',
    'task.updated',
    'avaFollowUpDraft.updated',
    'avaFollowUpDrafts.updated',
]);

function timestampMillis(value) {
    const raw = String(value || '').trim();
    if (!raw) return NaN;
    if (/^\d+$/.test(raw)) {
        const numeric = Number(raw);
        return numeric > 1e12 ? numeric : numeric * 1000;
    }
    return Date.parse(raw);
}

function handleTwentyWebhook(req, res) {
    try {
        const tokenHash = sha256(req.params.opaqueToken);
        const integration = TwentyStore.findByWebhookTokenHash(tokenHash);
        if (!integration || !integration.enabled || !integration.webhookSecretEncrypted) {
            return res.status(404).json({ accepted: false });
        }

        const signature = req.get('X-Twenty-Webhook-Signature');
        const timestamp = req.get('X-Twenty-Webhook-Timestamp');
        const time = timestampMillis(timestamp);
        if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 5 * 60 * 1000) {
            return res.status(401).json({ accepted: false, error_code: 'TWENTY_WEBHOOK_STALE' });
        }
        const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
        const secret = decryptJson(integration.webhookSecretEncrypted, { businessId: integration.businessId, field: 'webhookSecretEncrypted' }).secret;
        if (!verifyWebhookSignature({ secret, timestamp, rawBody, signature })) {
            return res.status(401).json({ accepted: false, error_code: 'TWENTY_WEBHOOK_SIGNATURE_INVALID' });
        }

        const payload = req.body && typeof req.body === 'object' ? req.body : {};
        const workspaceId = payload.workspaceId || payload.workspace_id || null;
        if (workspaceId && integration.workspaceId && String(workspaceId) !== String(integration.workspaceId)) {
            return res.status(403).json({ accepted: false, error_code: 'TWENTY_WORKSPACE_SCOPE_MISMATCH' });
        }
        // The pinned Twenty v2.37 runtime emits eventName/record. Keep the
        // event/data shape from older integrations, but verify the signature
        // against the original bytes before normalizing either envelope.
        const eventType = String(payload.eventName || payload.event || 'unknown');
        if (!ALLOWED_EVENTS.has(eventType)) {
            return res.status(202).json({ accepted: true, ignored: true });
        }
        const objectName = eventType.split('.')[0];
        const record = payload.record || payload.data;
        if (!record || typeof record !== 'object' || Array.isArray(record) || !record.id) {
            return res.status(400).json({ accepted: false, error_code: 'TWENTY_WEBHOOK_RECORD_REQUIRED' });
        }
        const remoteId = String(record.id);
        const payloadHash = sha256(rawBody);
        // Retries may be re-signed with a new timestamp/nonce. The payload is
        // stable for that event, and delivery IDs must also be tenant-scoped.
        const deliveryId = sha256(`${integration.businessId}:${req.get('X-Twenty-Webhook-Id') || payloadHash}`);
        const safeRecord = Object.fromEntries(
            ['id', 'name', 'status', 'body', 'bodyV2', 'text', 'resolutionNote']
                .filter((key) => Object.hasOwn(record, key))
                .map((key) => [key, record[key]]),
        );
        const row = TwentyStore.saveWebhook({
            deliveryId,
            businessId: integration.businessId,
            expectedRevision: integration.revision,
            workspaceId,
            eventType,
            twentyObject: objectName,
            twentyRecordId: remoteId,
            // Do not persist Twenty's targetUrl (contains the opaque callback
            // credential), nor unrelated person/contact fields.
            payload: { event: eventType, workspaceId, data: safeRecord },
            payloadHash,
        });
        return res.status(202).json({ accepted: true, idempotent: row.idempotent });
    } catch (error) {
        Logger.error('[Twenty webhook] rejected:', error.code || error.message);
        return res.status(error.statusCode || 500).json({ accepted: false, error_code: error.code || 'TWENTY_WEBHOOK_ERROR' });
    }
}

router.post('/twenty/webhooks/:opaqueToken', handleTwentyWebhook);

module.exports = router;
module.exports.handleTwentyWebhook = handleTwentyWebhook;
