'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const SmartTriggers = require('../src/services/smart-triggers.service');
const route = require('../src/routes/customer-trigger-preview.routes');

async function withPreview(run) {
    createTestDB();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Own'),(2,'Foreign')");
    DB.run(`INSERT INTO smart_triggers(id,instanceId,name,triggerType,conditions,actionType,actionData,isActive)
        VALUES (11,1,'Price','keyword','{"keywords":["цена","бронь"]}','send_message','{"message":"secret"}',0),
               (22,2,'Foreign','keyword','{"keywords":["секрет"]}','send_message','{}',1),
               (33,1,'Other type','new_lead','{}','send_message','{}',1)`);
    const authorize = Identity.authorizeCapability, oldSession = Auth.getSession;
    Auth.getSession = req => req.auth;
    const previousUrl = process.env.WHATSAPP_CRM_PUBLIC_URL;
    process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
    Identity.authorizeCapability = (auth, id) => {
        if (auth.userId !== 'owner' || id !== 1) throw Object.assign(new Error('denied'), { statusCode: 403 });
    };
    const handler = route.stack.find(layer => layer.route?.path === '/businesses/:businessId/triggers/:triggerId/preview').route.stack[0].handle;
    const request = async (businessId, triggerId, body, headers = {}) => {
        const allHeaders = { Origin: 'https://ava.example.test', ...headers };
        const req = {
            params: { businessId: String(businessId), triggerId: String(triggerId) }, body, query: {},
            auth: { userId: allHeaders['X-Test-User'] || 'owner' }, protocol: 'https',
            get: name => allHeaders[name] ?? allHeaders[name.toLowerCase()] ?? allHeaders[name[0].toUpperCase() + name.slice(1)],
        };
        const result = { status: 200, body: null };
        const res = { status(code) { result.status = code; return this; }, json(payload) { result.body = payload; return this; } };
        await handler(req, res);
        return { status: result.status, json: async () => result.body };
    };
    try { await run({ request }); }
    finally {
        Identity.authorizeCapability = authorize; Auth.getSession = oldSession;
        if (previousUrl === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
        else process.env.WHATSAPP_CRM_PUBLIC_URL = previousUrl;
    }
}

describe('Customer keyword trigger dry-run', () => {
    it('matches saved keyword rules without executing any action or writing state', async () => {
        await withPreview(async ({ request }) => {
            const blocked = ['_executeAction', 'logTriggerExecution', 'assignClientToSequence', 'updateClientStatus'];
            const originals = new Map();
            for (const key of blocked) {
                const target = key === '_executeAction' ? SmartTriggers : DB;
                originals.set(key, target[key]);
                target[key] = () => { throw Error(`${key} must not run`); };
            }
            try {
                const before = DB.get('SELECT COUNT(*) AS count FROM trigger_log').count;
                const changesBefore = DB.get('SELECT total_changes() AS count').count;
                const match = await request(1, 11, { sampleText: 'Сколько ЦЕНА за ночь?' });
                assert.strictEqual(match.status, 200);
                assert.deepStrictEqual(await match.json(), { success: true, businessId: 1, triggerId: 11,
                    matched: true, matchedKeyword: 'цена', dryRun: true, actionExecuted: false });
                const miss = await request(1, 11, { sampleText: 'Добрый день' });
                assert.strictEqual(miss.status, 200);
                assert.strictEqual((await miss.json()).matched, false);
                assert.strictEqual(DB.get('SELECT COUNT(*) AS count FROM trigger_log').count, before);
                assert.strictEqual(DB.get('SELECT total_changes() AS count').count, changesBefore);
            } finally {
                for (const [key, original] of originals) (key === '_executeAction' ? SmartTriggers : DB)[key] = original;
            }
        });
    });

    it('rejects foreign trigger, foreign business, wrong event, CSRF and untrusted input', async () => {
        await withPreview(async ({ request }) => {
            assert.strictEqual((await request(2, 22, { sampleText: 'секрет' })).status, 403);
            assert.strictEqual((await request(1, 11, { sampleText: 'цена' }, { 'X-Test-User': 'outsider' })).status, 403);
            assert.strictEqual((await request(1, 22, { sampleText: 'секрет' })).status, 404);
            assert.strictEqual((await request(1, 33, { sampleText: 'hello' })).status, 400);
            assert.strictEqual((await request(1, 11, { sampleText: 'цена' }, { Origin: 'https://evil.example' })).status, 403);
            assert.strictEqual((await request(1, 11, { sampleText: 'цена' }, { Origin: '' })).status, 403);
            assert.strictEqual((await request(1, 11, { sampleText: 'цена', actionType: 'send_message' })).status, 400);
            assert.strictEqual((await request(1, 11, { sampleText: '' })).status, 400);
            assert.strictEqual((await request(1, 11, { sampleText: 'a'.repeat(2001) })).status, 400);
        });
    });

    it('does not reveal a match if membership is revoked during the read', async () => {
        await withPreview(async ({ request }) => {
            const authorize = Identity.authorizeCapability, oldSession = Auth.getSession;
    Auth.getSession = req => req.auth;
            let checks = 0;
            Identity.authorizeCapability = (auth, id) => {
                checks++;
                if (checks > 1) throw Object.assign(new Error('revoked'), { statusCode: 403 });
                return authorize(auth, id);
            };
            try {
                const response = await request(1, 11, { sampleText: 'цена' });
                assert.strictEqual(response.status, 403);
                assert.strictEqual((await response.json()).matched, undefined);
            } finally { Identity.authorizeCapability = authorize; Auth.getSession = oldSession; }
        });
    });
});
