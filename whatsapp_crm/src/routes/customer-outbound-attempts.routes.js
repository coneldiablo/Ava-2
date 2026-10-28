'use strict';

const express = require('express');
const DB = require('../services/database.service');
const Identity = require('../services/identity/identity-store');
const AvaOutbound = require('../services/ava-outbound.service');
const { redact } = require('../services/pms/pms-utils');

const router = express.Router();
const CAMPAIGN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CODE = /^[A-Za-z0-9_-]{1,64}$/;
const PAGE_SIZE = 20;

function safeCode(value) {
    return typeof value === 'string' && CODE.test(value) ? value : null;
}

function safeCallId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;
}

function safeText(value, limit = 120) {
    return typeof value === 'string' ? value.slice(0, limit) : null;
}

function safeDate(value) {
    if (typeof value !== 'string' || value.length > 64) return null;
    const text = value.trim();
    const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
        ? `${text.replace(' ', 'T')}Z` : text;
    return Number.isFinite(Date.parse(normalized)) ? normalized : null;
}

function safeDiagnostic(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const cleaned = redact(value, 240);
    return cleaned || null;
}

function safeAttempt(row) {
    return {
        id: safeText(row.id, 128),
        leadName: safeText(row.name),
        phoneNumber: typeof row.phone_number === 'string' && /^\+?[0-9()\-\s]{5,24}$/.test(row.phone_number)
            ? row.phone_number : null,
        startedAt: safeDate(row.started_at_utc),
        endedAt: safeDate(row.ended_at_utc),
        durationSeconds: Number.isSafeInteger(row.duration_seconds) && row.duration_seconds >= 0
            ? row.duration_seconds : null,
        provider: safeCode(row.provider),
        callId: safeCallId(row.call_id),
        outcome: safeCode(row.outcome),
        amdStatus: safeCode(row.amd_status),
        consentResult: safeCode(row.consent_result),
        errorStage: safeCode(row.error_stage),
        errorCode: safeCode(row.error_code),
        errorMessage: safeDiagnostic(row.error_message),
        retryable: row.retryable === 1 || row.retryable === true,
    };
}

router.get('/businesses/:businessId/outbound/campaigns/:campaignId/attempts', async (req, res) => {
    const businessId = Number(req.params.businessId);
    const campaignId = req.params.campaignId;
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    if (!Number.isSafeInteger(businessId) || businessId < 1 ||
        !CAMPAIGN_ID.test(campaignId) || !Number.isSafeInteger(page) || page < 1 || page > 10000) {
        return res.status(400).json({ success: false, error: 'INVALID_ATTEMPT_REQUEST' });
    }

    try {
        if (!req.auth?.userId && req.auth?.platformRole !== 'platform_admin') {
            return res.status(403).json({ success: false, error: 'CUSTOMER_ACCESS_REQUIRED' });
        }
        Identity.authorizeCapability(req.auth, businessId, 'business.read');
        const campaign = DB.getOutboundCampaign(campaignId);
        if (!campaign || Number(campaign.instanceId) !== businessId) {
            return res.status(404).json({ success: false, error: 'CAMPAIGN_NOT_FOUND' });
        }

        const upstream = await AvaOutbound.listSalesBrainAttempts(campaignId, { page, pageSize: PAGE_SIZE });
        // The AVA campaign is located by the Sales Brain external key, not by a locally guessed ID.
        const avaCampaign = upstream?.ava_campaign;
        const rows = upstream?.attempts;
        const total = upstream?.total;
        const totalPages = upstream?.total_pages;
        if (upstream?.sales_brain_campaign_id !== campaignId ||
            avaCampaign?.external_source !== 'sales_brain' ||
            avaCampaign?.external_campaign_id !== campaignId ||
            Number(avaCampaign?.business_id) !== businessId ||
            typeof avaCampaign?.id !== 'string' || !avaCampaign.id ||
            !Array.isArray(rows) || rows.length > PAGE_SIZE ||
            !Number.isSafeInteger(total) || total < 0 ||
            !Number.isSafeInteger(totalPages) || totalPages < 0 ||
            upstream.page !== page || upstream.page_size !== PAGE_SIZE ||
            rows.some(row => !row || row.campaign_id !== avaCampaign.id || Number(row.business_id) !== businessId)) {
            return res.status(502).json({ success: false, error: 'ATTEMPT_HISTORY_UNAVAILABLE' });
        }

        // Membership may be revoked during the upstream request.
        require('../services/identity/customer-access').reauthorize(req, businessId, 'business.read');
        return res.json({ success: true, businessId, campaignId, attempts: rows.map(safeAttempt),
            page, pageSize: PAGE_SIZE, total, totalPages });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: 'BUSINESS_ACCESS_DENIED' });
        if (error.response?.status === 404) return res.status(404).json({ success: false, error: 'ATTEMPT_HISTORY_NOT_FOUND' });
        // Never return upstream diagnostics, endpoint URLs, or credentials to the browser.
        return res.status(502).json({ success: false, error: 'ATTEMPT_HISTORY_UNAVAILABLE' });
    }
});

module.exports = router;
