const axios = require('axios');
const config = require('../config');

class AvaOutboundService {
    constructor(options = config.avaAdmin) {
        this.baseUrl = String(options.apiUrl || '').replace(/\/+$/, '');
        this.serviceToken = String(options.serviceToken || '').trim();
        this.timeoutMs = Number(options.timeoutMs || 15000);
    }

    assertConfigured() {
        if (!this.baseUrl) {
            throw new Error('AVA_ADMIN_API_URL is not configured');
        }
        if (!this.serviceToken) {
            throw new Error('CRM_SERVICE_API_TOKEN is not configured');
        }
    }

    async syncCampaign(campaignId, options = {}) {
        this.assertConfigured();
        const DB = require('./database.service');
        const campaign = DB.getOutboundCampaign(campaignId);
        if (!campaign) throw Object.assign(new Error('CAMPAIGN_NOT_FOUND'), {code:'CAMPAIGN_NOT_FOUND',statusCode:404});
        const route = require('./telephony/store').source(Number(campaign.instanceId), options.sourceNumberId ?? null);
        const response = await axios.post(
            `${this.baseUrl}/api/internal/outbound/sales-brain/campaigns/${encodeURIComponent(campaignId)}/sync`,
            {
                start: Boolean(options.start),
                source_number_id: route.managed ? route.phoneId : null,
                sync_leads: options.syncLeads !== false,
                max_concurrent: route.managed ? 1 : Math.max(1, Math.min(Number(options.maxConcurrent || 1), 5)),
                min_interval_seconds_between_calls: Math.max(
                    10,
                    Number(options.minIntervalSecondsBetweenCalls || 10)
                )
            },
            {
                timeout: this.timeoutMs,
                headers: {
                    Authorization: `Bearer ${this.serviceToken}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                }
            }
        );
        return response.data;
    }

    async setCampaignStatus(campaignId, status, options = {}) {
        this.assertConfigured();
        const response = await axios.post(
            `${this.baseUrl}/api/internal/outbound/sales-brain/campaigns/${encodeURIComponent(campaignId)}/status`,
            {
                status,
                cancel_pending: Boolean(options.cancelPending)
            },
            {
                timeout: this.timeoutMs,
                headers: {
                    Authorization: `Bearer ${this.serviceToken}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                }
            }
        );
        return response.data;
    }

    async listSalesBrainAttempts(campaignId, { page = 1, pageSize = 20 } = {}) {
        this.assertConfigured();
        const response = await axios.get(
            `${this.baseUrl}/api/internal/outbound/sales-brain/campaigns/${encodeURIComponent(campaignId)}/attempts`,
            {
                params: { page, page_size: pageSize },
                timeout: this.timeoutMs,
                maxRedirects: 0,
                maxContentLength: 256 * 1024,
                headers: {
                    Authorization: `Bearer ${this.serviceToken}`,
                    Accept: 'application/json'
                }
            }
        );
        return response.data;
    }

    async getCampaignStatus(campaignId) {
        this.assertConfigured();
        const response = await axios.get(
            `${this.baseUrl}/api/internal/outbound/sales-brain/campaigns/${encodeURIComponent(campaignId)}/status`,
            { timeout: this.timeoutMs, maxRedirects: 0, maxContentLength: 65536,
                headers: { Authorization: `Bearer ${this.serviceToken}`, Accept: 'application/json' } }
        );
        return response.data;
    }
}

module.exports = new AvaOutboundService();
module.exports.AvaOutboundService = AvaOutboundService;
