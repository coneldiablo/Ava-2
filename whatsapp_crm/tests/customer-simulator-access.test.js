const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Access = require('../src/services/identity/customer-access');

function fixture(role = 'hotel_owner') {
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Own business'),(2,'Foreign business')");
    const invite = Identity.createInvitation({ platformRole: 'platform_admin' },
        { email: 'simulator@example.test', businessId: 1, role });
    return Identity.completeInvitation(Identity.claimInvitation(invite.token), 'simulator-subject');
}

function authorize(actor, body, { origin = 'https://ava.example.test', query = {}, fetchSite } = {}) {
    let passed = false;
    let status = 200;
    let code;
    const req = { auth: actor, params: {}, body, query,
        headers: { origin, ...(fetchSite ? { 'sec-fetch-site': fetchSite } : {}) } };
    const previous = process.env.WHATSAPP_CRM_PUBLIC_URL;
    process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
    try {
        Access.forRoute('post', '/simulate')(req, {
            status(value) { status = value; return this; },
            json(payload) { code = payload.code; },
        }, () => { passed = true; });
    } finally {
        if (previous === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
        else process.env.WHATSAPP_CRM_PUBLIC_URL = previous;
    }
    return { passed, status, code, body: req.body };
}

describe('Customer simulator access', () => {
    it('allows only the owner of the selected business and strips history metadata', () => {
        const owner = fixture();
        const own = authorize(owner, { instanceId: 1, message: '  Когда заезд?  ',
            history: [{ role: 'user', content: 'Когда заезд?', clientId: 999 }] });
        assert.strictEqual(own.passed, true);
        assert.deepStrictEqual(own.body, { instanceId: 1, message: 'Когда заезд?',
            history: [{ role: 'user', content: 'Когда заезд?' }] });
        assert.strictEqual(authorize(owner, { instanceId: 2, message: 'Question', history: [] }).status, 403);
        assert.strictEqual(authorize(owner, { instanceId: 1, message: 'Question', history: [] },
            { origin: 'https://evil.example' }).status, 403);
        assert.strictEqual(authorize(owner, { instanceId: 1, message: 'Question', history: [] },
            { fetchSite: 'cross-site' }).status, 403);
        assert.strictEqual(authorize(owner, { instanceId: 1, message: 'Question', history: [], modelId: 7 }).status, 400);
        assert.strictEqual(authorize(owner, { instanceId: 1, message: 'Question', history: [] },
            { query: { businessId: 2 } }).status, 400);
        const manager = fixture('manager');
        assert.strictEqual(authorize(manager, { instanceId: 1, message: 'Question', history: [] }).status, 403);
    });

    it('routes a real owner request and rejects a foreign business before AI is called', async () => {
        const owner = fixture();
        const Auth = require('../src/services/auth.service');
        const AI = require('../src/services/ai.service');
        const RAG = require('../src/services/rag.service');
        const app = require('../src/app').app;
        const oldEnabled = Auth.config.enabled;
        const oldCustomer = process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        const oldOrigin = process.env.WHATSAPP_CRM_PUBLIC_URL;
        const oldResponse = AI.getResponse;
        const oldContext = RAG.buildConversationContext;
        Auth.config.enabled = true;
        process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
        const token = Identity.createSession(owner.subject, 'simulator-owner-session');
        const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
        const origin = `http://127.0.0.1:${server.address().port}`;
        process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
        const headers = { Cookie: `crm_session=ava2:${token}`, Origin: origin, 'Content-Type': 'application/json' };
        let calls = 0;
        AI.getResponse = async (_history, context) => {
            calls++;
            assert.strictEqual(context.dryRun, true);
            assert.strictEqual(context.effectsDisabled, true);
            assert.strictEqual(context.toolsEnabled, false);
            assert.deepStrictEqual(context.allowedTools, []);
            return { reply: 'Заезд после 14:00.', action: 'generate_payment',
                toolCalls: [{ name: 'send', args: {} }], orderItems: [{ itemName: 'real order' }] };
        };
        RAG.buildConversationContext = async () => ({ context: '', searched: false });
        const request = body => fetch(`${origin}/api/simulate`, { method: 'POST', headers, body: JSON.stringify(body) });
        try {
            const own = await request({ instanceId: 1, message: 'Когда заезд?',
                history: [{ role: 'user', content: 'Когда заезд?' }] });
            assert.strictEqual(own.status, 200);
            const result = await own.json();
            assert.strictEqual(result.response.reply, 'Заезд после 14:00.');
            assert.strictEqual(result.response.action, 'none');
            assert.strictEqual(result.response.toolCalls, undefined);
            assert.strictEqual(result.response.orderItems, undefined);
            assert.deepStrictEqual(result.capabilities, { dryRun: true, effectsDisabled: true, toolsEnabled: false });
            assert.strictEqual(calls, 1);
            const foreign = await request({ instanceId: 2, message: 'Когда заезд?', history: [] });
            assert.strictEqual(foreign.status, 403);
            assert.strictEqual(calls, 1);
        } finally {
            AI.getResponse = oldResponse;
            RAG.buildConversationContext = oldContext;
            Auth.config.enabled = oldEnabled;
            if (oldCustomer === undefined) delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;
            else process.env.AVA_CUSTOMER_ACCESS_ENABLED = oldCustomer;
            if (oldOrigin === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
            else process.env.WHATSAPP_CRM_PUBLIC_URL = oldOrigin;
            await new Promise(resolve => server.close(resolve));
        }
    });

    it('AIService dry run strips model payment and order instructions at its own boundary', async () => {
        const AI = require('../src/services/ai.service');
        const savedResolve = AI._resolveProviderConfig;
        const savedCall = AI._callAITunnel;
        AI._resolveProviderConfig = () => ({ provider: 'aitunnel', apiKey: 'fixture', model: 'fixture', temperature: 0 });
        AI._callAITunnel = async messages => {
            assert.ok(messages[0].content.includes('РЕЖИМ СИМУЛЯЦИИ'));
            return JSON.stringify({ reply: 'Тестовый ответ', action: 'generate_payment',
                status: 'offer', order_items: [{ itemName: 'Заказ' }] });
        };
        try {
            const result = await AI.getResponse([{ role: 'user', content: 'Создай оплату' }], { dryRun: true });
            assert.strictEqual(result.action, 'none');
            assert.strictEqual(result.orderItems, undefined);
            assert.strictEqual(result.effectsDisabled, true);
            assert.strictEqual(result.toolsEnabled, false);
        } finally { AI._resolveProviderConfig = savedResolve; AI._callAITunnel = savedCall; }
    });
});
