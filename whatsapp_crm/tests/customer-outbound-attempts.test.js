'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const AvaOutbound = require('../src/services/ava-outbound.service');
const router = require('../src/routes/customer-outbound-attempts.routes');

const handler = router.stack.find(layer => layer.route?.path === '/businesses/:businessId/outbound/campaigns/:campaignId/attempts').route.stack[0].handle;

async function invoke(businessId, campaignId, query = {}, auth = { userId: 'customer' }) {
    const res = { statusCode: 200, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; } };
    await handler({ params: { businessId: String(businessId), campaignId }, query, auth }, res);
    return res;
}

describe('Customer outbound attempt history', () => {
    it('rejects malformed requests, foreign membership and foreign campaigns before AVA', async () => {
        createTestDB();
        DB.db.pragma('foreign_keys = OFF');
        DB.createOutboundCampaign({ campaignId: 'camp_own', instanceId: 7, name: 'Own' });
        DB.createOutboundCampaign({ campaignId: 'camp_foreign', instanceId: 8, name: 'Foreign' });
        const oldAuth = Identity.authorizeCapability, oldSession = Auth.getSession;
        Auth.getSession = req => req.auth;
        const oldList = AvaOutbound.listSalesBrainAttempts;
        let calls = 0;
        Identity.authorizeCapability = (_auth, id) => { if (id !== 7) throw Object.assign(new Error('denied'), { statusCode: 403 }); };
        AvaOutbound.listSalesBrainAttempts = async () => { calls++; return {}; };
        try {
            assert.equal((await invoke('bad', 'camp_own')).statusCode, 400);
            assert.equal((await invoke(7, 'a/b')).statusCode, 400);
            assert.equal((await invoke(7, 'camp_own', { page: '-1' })).statusCode, 400);
            assert.equal((await invoke(8, 'camp_foreign')).statusCode, 403);
            assert.equal((await invoke(7, 'camp_foreign')).statusCode, 404);
            assert.equal(calls, 0);
        } finally {
            Identity.authorizeCapability = oldAuth; Auth.getSession = oldSession;
            AvaOutbound.listSalesBrainAttempts = oldList;
        }
    });

    it('fails closed on upstream tenant, external ID or attempt mismatch', async () => {
        createTestDB();
        DB.db.pragma('foreign_keys = OFF');
        DB.createOutboundCampaign({ campaignId: 'camp_own', instanceId: 7, name: 'Own' });
        const oldAuth = Identity.authorizeCapability, oldSession = Auth.getSession;
        Auth.getSession = req => req.auth;
        const oldList = AvaOutbound.listSalesBrainAttempts;
        Identity.authorizeCapability = () => {};
        const base = { sales_brain_campaign_id: 'camp_own',
            ava_campaign: { id: 'ava-id', business_id: 7, external_source: 'sales_brain', external_campaign_id: 'camp_own' },
            attempts: [], total: 0, total_pages: 0, page: 1, page_size: 20 };
        try {
            for (const changed of [
                { ava_campaign: { ...base.ava_campaign, business_id: 8 } },
                { ava_campaign: { ...base.ava_campaign, external_campaign_id: 'another' } },
                { attempts: [{ campaign_id: 'ava-id', business_id: 8 }] },
                { page_size: 200 },
            ]) {
                AvaOutbound.listSalesBrainAttempts = async () => ({ ...base, ...changed });
                const res = await invoke(7, 'camp_own');
                assert.equal(res.statusCode, 502);
                assert.equal(JSON.stringify(res.body).includes('another'), false);
            }
        } finally {
            Identity.authorizeCapability = oldAuth; Auth.getSession = oldSession;
            AvaOutbound.listSalesBrainAttempts = oldList;
        }
    });

    it('returns only allowlisted diagnostics and bounded pagination', async () => {
        createTestDB();
        DB.db.pragma('foreign_keys = OFF');
        DB.createOutboundCampaign({ campaignId: 'camp_own', instanceId: 7, name: 'Own' });
        const oldAuth = Identity.authorizeCapability, oldSession = Auth.getSession;
        Auth.getSession = req => req.auth;
        const oldList = AvaOutbound.listSalesBrainAttempts;
        Identity.authorizeCapability = () => {};
        let requested;
        AvaOutbound.listSalesBrainAttempts = async (_id, options) => {
            requested = options;
            return { sales_brain_campaign_id: 'camp_own',
                ava_campaign: { id: 'ava-id', business_id: 7, external_source: 'sales_brain', external_campaign_id: 'camp_own' },
                attempts: [{ id: 'attempt-1', campaign_id: 'ava-id', business_id: 7,
                    name: 'Guest', phone_number: '+79990000000', started_at_utc: '2026-09-23 12:00:00',
                    outcome: 'failed', error_stage: 'originate', error_code: 'SIP_503', retryable: 1,
                    error_message: 'SIP 503 Bearer SECRET password=HIDDEN', ari_channel_id: 'PRIVATE_CHANNEL',
                    provider: 'asterisk', call_id: 'call-123', endpoint: 'PRIVATE_ENDPOINT' }],
                total: 1, total_pages: 1, page: 2, page_size: 20 };
        };
        try {
            const res = await invoke(7, 'camp_own', { page: '2' });
            assert.equal(res.statusCode, 200);
            assert.deepEqual(requested, { page: 2, pageSize: 20 });
            assert.equal(res.body.attempts[0].errorCode, 'SIP_503');
            assert.equal(res.body.attempts[0].provider, 'asterisk');
            assert.equal(res.body.attempts[0].callId, 'call-123');
            assert.equal(res.body.attempts[0].startedAt, '2026-09-23T12:00:00Z');
            assert.match(res.body.attempts[0].errorMessage, /SIP 503/);
            assert.equal(JSON.stringify(res.body).includes('SECRET'), false);
            assert.equal(JSON.stringify(res.body).includes('HIDDEN'), false);
            assert.equal(JSON.stringify(res.body).includes('PRIVATE'), false);
        } finally {
            Identity.authorizeCapability = oldAuth; Auth.getSession = oldSession;
            AvaOutbound.listSalesBrainAttempts = oldList;
        }
    });

    it('redacts upstream failures and rechecks membership after the AVA request', async () => {
        createTestDB();
        DB.db.pragma('foreign_keys = OFF');
        DB.createOutboundCampaign({ campaignId: 'camp_own', instanceId: 7, name: 'Own' });
        const oldAuth = Identity.authorizeCapability, oldSession = Auth.getSession;
        Auth.getSession = req => req.auth;
        const oldList = AvaOutbound.listSalesBrainAttempts;
        let checks = 0;
        Identity.authorizeCapability = () => { checks++; };
        try {
            AvaOutbound.listSalesBrainAttempts = async () => {
                throw Object.assign(new Error('Bearer SECRET upstream URL'), { response: { status: 503, data: { detail: 'SECRET' } } });
            };
            let res = await invoke(7, 'camp_own');
            assert.equal(res.statusCode, 502);
            assert.equal(JSON.stringify(res.body).includes('SECRET'), false);

            checks = 0;
            Identity.authorizeCapability = () => {
                if (++checks === 2) throw Object.assign(new Error('revoked'), { statusCode: 403 });
            };
            AvaOutbound.listSalesBrainAttempts = async () => ({ sales_brain_campaign_id: 'camp_own',
                ava_campaign: { id: 'ava-id', business_id: 7, external_source: 'sales_brain', external_campaign_id: 'camp_own' },
                attempts: [], total: 0, total_pages: 0, page: 1, page_size: 20 });
            res = await invoke(7, 'camp_own');
            assert.equal(res.statusCode, 403);
            assert.equal(checks, 2);
        } finally {
            Identity.authorizeCapability = oldAuth; Auth.getSession = oldSession;
            AvaOutbound.listSalesBrainAttempts = oldList;
        }
    });
});
