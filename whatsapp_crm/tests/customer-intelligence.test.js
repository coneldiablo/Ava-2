'use strict';

const { describe, it, assert } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const MemoryStore = require('../src/services/crm-memory-store.service');
const router = require('../src/routes/customer-intelligence.routes');

describe('Customer intelligence tenant scope', () => {
it('enforces business and client scope and returns only safe fields', async () => {
    const original = {
        getClient: DB.getClient,
        all: DB.all,
        get: DB.get,
        authorizeCapability: Identity.authorizeCapability, getSession: Auth.getSession,
        latest: MemoryStore.latest,
    };
    const calls = [];
    DB.getClient = async (instanceId, chatId) => {
        calls.push(['client', instanceId, chatId]);
        return instanceId === 7 && chatId === 'guest@c.us'
            ? { id: 4, instanceId: 7, chatId, senderName: 'Гость', leadStatus: 'new', tags: '["VIP"]',
                crmContactId: 'private-crm-id', createdAt: '2026-01-01', updatedAt: '2026-01-02', lastMessageTime: '2026-01-02' }
            : null;
    };
    DB.all = (sql, params) => {
        calls.push(['all', params]);
        if (sql.includes('FROM messages')) return [{ id: 2, senderName: 'Гость', content: 'Здравствуйте',
            role: 'user', timestamp: '2026-01-02', channel: 'whatsapp', aiThought: 'private reasoning' }];
        return [{ id: 3, fromStatus: 'new', toStatus: 'qualified', createdAt: '2026-01-02',
            reason: 'private note' }];
    };
    DB.get = (sql, params) => {
        calls.push([sql.includes('FROM client_profiles') ? 'profile' : 'count', params, sql]);
        if (sql.includes('FROM client_profiles')) return {
            interests: '["кофе", "путешествия"]', objections: '["дорого"]', lastProfileUpdate: '2026-01-03',
            rawProfileJson: JSON.stringify({ keyFacts: ['Нужна доставка'], importantDates: ['2026-02-01'],
                lastCallSummary: 'Просил перезвонить', lastCallAt: '2026-01-02',
                budget: 'private budget', needs: 'private need', secret: 'private note' }), budget: 'private budget',
            conversionProbability: 99, sentimentScore: 0.99,
        };
        return { total: 1 };
    };
    Auth.getSession = req => req.auth;
    Identity.authorizeCapability = (_auth, instanceId) => {
        if (instanceId !== 7) throw Object.assign(new Error('denied'), { statusCode: 403 });
    };
    MemoryStore.latest = (instanceId, chatId, kind) => {
        calls.push(['memory', instanceId, chatId, kind]);
        return kind === 'conversation' ? {
            status: 'ai_summary', summary: 'Клиент обсуждал доставку', interests: ['доставка'],
            objections: ['срок'], dates: ['2026-02-01'], needs: 'private need', budget: 'private budget',
            model: 'private model', source_updated_at: '2026-01-03', generated_at: '2026-01-04',
            source_complete: false,
        } : { status: 'policy_refresh_required', summary: 'private stale summary', budget: 'private budget' };
    };

    const handler = router.stack.find(layer => layer.route?.path === '/customer-intelligence/:instanceId/:chatId')
        .route.stack[0].handle;
    const request = async (instanceId, chatId, customer = true) => {
        const response = { statusCode: 200, body: null,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; } };
        await handler({ params: { instanceId: String(instanceId), chatId },
            auth: customer ? { userId: 'customer-1', platformRole: null } : { platformRole: 'platform_admin' } }, response);
        return response;
    };
    try {
        let response = await request(8, 'guest@c.us');
        assert.equal(response.statusCode, 403);
        assert.equal(calls.length, 0, 'cross-tenant requests must not query customer data');

        response = await request(7, 'unknown');
        assert.equal(response.statusCode, 404);
        assert.deepEqual(calls.splice(0), [['client', 7, 'unknown']]);

        response = await request(7, 'guest@c.us', false);
        assert.equal(response.statusCode, 403);
        assert.equal(calls.length, 0, 'platform or legacy access is not a customer session');

        response = await request(7, 'guest@c.us');
        assert.equal(response.statusCode, 200);
        const payload = response.body;
        assert.equal(payload.client.chatId, 'guest@c.us');
        assert.deepEqual(payload.client.tags, ['VIP']);
        assert.equal(payload.messages[0].aiThought, undefined);
        assert.equal(payload.client.crmContactId, undefined);
        assert.deepEqual(payload.customerMemory, {
            provenance: 'saved_ai_profile', interests: ['кофе', 'путешествия'], objections: ['дорого'],
            importantDates: ['2026-02-01'], keyFacts: ['Нужна доставка'],
            lastCallSummary: 'Просил перезвонить', lastCallAt: '2026-01-02', lastProfileUpdate: '2026-01-03',
        });
        assert.equal(payload.generatedMemory.conversation.provenance, 'ai_generated');
        assert.equal(payload.generatedMemory.conversation.summary, 'Клиент обсуждал доставку');
        assert.equal(payload.generatedMemory.conversation.sourceComplete, false);
        assert.equal(payload.generatedMemory.call.summary, null);
        assert.equal(JSON.stringify(payload).includes('private note'), false);
        assert.equal(JSON.stringify(payload).includes('private budget'), false);
        assert.equal(JSON.stringify(payload).includes('private need'), false);
        assert.equal(JSON.stringify(payload).includes('private model'), false);
        assert.equal(JSON.stringify(payload).includes('private stale summary'), false);
        assert.equal(payload.customerMemory.conversionProbability, undefined);
        const profileQuery = calls.find(call => call[0] === 'profile');
        assert.deepEqual(profileQuery[1], [7, 'guest@c.us']);
        assert.match(profileQuery[2], /SELECT interests, objections, rawProfileJson, lastProfileUpdate/);
        assert.doesNotMatch(profileQuery[2], /budget|conversionProbability|sentimentScore/i);
        assert.deepEqual(calls.filter(call => call[0] === 'memory').map(call => call.slice(1)),
            [[7, 'guest@c.us', 'conversation'], [7, 'guest@c.us', 'call']]);
        assert.deepEqual(calls.filter(call => ['all', 'count', 'profile'].includes(call[0])).map(call => call[1]),
            Array.from({length:7}, () => [7, 'guest@c.us']));

        calls.length = 0;
        const originalLookup = DB.getClient;
        DB.getClient = (id, chat) => originalLookup(id, chat === 'tg_old' ? 'guest@c.us' : chat);
        const redirected = await request(7, 'tg_old');
        assert.equal(redirected.statusCode, 200);
        assert.equal(redirected.body.client.chatId, 'guest@c.us');
        assert.ok(calls.filter(call => ['all','count','profile'].includes(call[0])).every(call => call[1][1] === 'guest@c.us'));
        assert.ok(calls.filter(call => call[0] === 'memory').every(call => call[2] === 'guest@c.us'));
        DB.getClient = originalLookup;

        // Hostile or malformed stored values are bounded and never exported raw.
        DB.get = (sql) => sql.includes('FROM client_profiles') ? {
            interests: JSON.stringify(Array.from({ length: 40 }, (_, i) => `интерес ${i}`)),
            objections: '{malformed',
            rawProfileJson: JSON.stringify({ keyFacts: ['a'.repeat(500), 'secret@example.com'],
                importantDates: ['2026-03-01'], lastCallSummary: '+79991234567',
                rawTranscript: 'private transcript', budget: 'private budget' }),
            lastProfileUpdate: 'invalid date',
        } : { total: 0 };
        response = await request(7, 'guest@c.us');
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.customerMemory.interests.length, 8);
        assert.ok(response.body.customerMemory.keyFacts[0].length <= 180);
        assert.equal(response.body.customerMemory.lastProfileUpdate, null);
        assert.equal(JSON.stringify(response.body).includes('private transcript'), false);
        assert.equal(JSON.stringify(response.body).includes('secret@example.com'), false);
        assert.equal(JSON.stringify(response.body).includes('+79991234567'), false);

        let checks = 0;
        Auth.getSession = req => req.auth;
        Identity.authorizeCapability = () => {
            if (++checks > 1) throw Object.assign(new Error('revoked'), { statusCode: 403 });
        };
        response = await request(7, 'guest@c.us');
        assert.equal(response.statusCode, 403);
        assert.equal(response.body.customerMemory, undefined);
    } finally {
        DB.getClient = original.getClient;
        DB.all = original.all;
        DB.get = original.get;
        Identity.authorizeCapability = original.authorizeCapability;
        Auth.getSession = original.getSession;
        MemoryStore.latest = original.latest;
    }
});
});
