'use strict';

const { describe, it, assert } = require('./test-helper');
const Database = require('better-sqlite3');
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const AuthService = require('../src/services/auth.service');
const LocalKnowledge = require('../src/services/knowledge-local.service');

async function withServer(run) {
    const suffix = crypto.randomUUID();
    const saved = { db: DB.db, post: axios.post, authorize: Identity.authorizeCapability, getSession: AuthService.getSession,
        localLookup: LocalKnowledge.lookup, hasIndexedContent: LocalKnowledge.hasIndexedContent,
        canConcludeNoMatch: LocalKnowledge.canConcludeNoMatch,
        publicUrl: process.env.WHATSAPP_CRM_PUBLIC_URL, adminUrl: process.env.AVA_ADMIN_API_URL,
        token: process.env.CRM_SERVICE_API_TOKEN };
    const database = new Database(':memory:');
    DB.db = database;
    DB.createBusinessGptTables();
    // Existing upstream tests intentionally omit knowledge tables; exercise
    // local retrieval explicitly in the focused cases below.
    LocalKnowledge.lookup = async () => null;
    LocalKnowledge.hasIndexedContent = () => false;
    LocalKnowledge.canConcludeNoMatch = () => false;
    process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
    process.env.AVA_ADMIN_API_URL = 'http://admin.internal:3003';
    process.env.CRM_SERVICE_API_TOKEN = 'test-only-token';
    Identity.authorizeCapability = (auth, businessId) => {
        if (businessId !== 7 || ![`user-a-${suffix}`, `user-b-${suffix}`].includes(auth.userId)) throw Error('denied');
    };
    AuthService.getSession = req => req.auth;
    const app = express();
    app.use(express.json());
    app.use('/api', (req, _res, next) => { req.auth = { userId: `${req.get('X-Test-User') || 'user-a'}-${suffix}` }; next(); });
    app.use('/api', require('../src/routes/customer-business-gpt.routes'));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const root = `http://127.0.0.1:${server.address().port}/api/businesses`;
    const request = (method, path, body, user = 'user-a', origin = 'https://ava.example.test') =>
        fetch(`${root}${path}`, { method, headers: { 'Content-Type': 'application/json',
            'X-Test-User': user, ...(origin ? { Origin: origin } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try { await run({ request, root }); }
    finally {
        await new Promise(resolve => server.close(resolve));
        database.close(); DB.db = saved.db; axios.post = saved.post;
        LocalKnowledge.lookup = saved.localLookup;
        LocalKnowledge.hasIndexedContent = saved.hasIndexedContent;
        LocalKnowledge.canConcludeNoMatch = saved.canConcludeNoMatch;
        Identity.authorizeCapability = saved.authorize; AuthService.getSession = saved.getSession;
        for (const [key, value] of [['WHATSAPP_CRM_PUBLIC_URL', saved.publicUrl],
            ['AVA_ADMIN_API_URL', saved.adminUrl], ['CRM_SERVICE_API_TOKEN', saved.token]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
}

function grounded(payload) {
    return { business_id: payload.business_id, channel: 'whatsapp', correlation_id: payload.correlation_id,
        preview: true, read_only: true, handled: true, grounded: true, stale: false, customer_id: null,
        answer: 'Ответ по документу.', source_timestamp: '2026-09-23T12:00:00Z',
        citations: [{ source_id: 42, title: 'Правила', url: 'https://private.example' }] };
}

describe('Customer Business GPT', () => {
    it('answers real tenant CRM facts with typed sources and durable replay, without forged citations', async () => {
        await withServer(async ({ request }) => {
            DB.createTables(); DB.ensureColumns(); DB.createSalesBrainTables();
            DB.run("INSERT INTO instances(id,name) VALUES(7,'Свой бизнес'),(8,'PRIVATE_FOREIGN')");
            DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES(7,'own','Свой клиент'),(8,'foreign','PRIVATE_FOREIGN_CLIENT')");
            const Deals = require('../src/services/customer-deals.store');
            Deals.create(7, { title: 'Своя сделка', clientChatId: 'own', amount: 125 });
            Deals.create(8, { title: 'PRIVATE_FOREIGN_DEAL', clientChatId: 'foreign', amount: 999 });
            let upstreamCalls = 0;
            axios.post = async () => { upstreamCalls++; throw Error('unexpected upstream'); };
            const { chat } = await (await request('POST', '/7/business-gpt/chats', {})).json();
            const body = { question: 'Что сейчас в моем бизнесе: клиенты и сделки?', requestId: crypto.randomUUID() };
            const response = await request('POST', `/7/business-gpt/chats/${chat.id}/messages`, body);
            assert.equal(response.status, 201);
            const { turn } = await response.json();
            assert.equal(turn.answerContext.kind, 'crm');
            assert.equal(turn.answerContext.businessId, 7);
            assert.deepEqual(turn.citations, []);
            assert.ok(turn.answer.includes('Клиентов в CRM: 1'));
            assert.ok(turn.sources.some(item => item.kind === 'deal'));
            assert.ok(!JSON.stringify(turn).includes('PRIVATE_FOREIGN'));
            const replay = await (await request('POST', `/7/business-gpt/chats/${chat.id}/messages`, body)).json();
            assert.deepEqual(replay.turn, turn);
            const history = await (await request('GET', `/7/business-gpt/chats/${chat.id}`)).json();
            assert.deepEqual(history.turns[0], turn);
            assert.equal(upstreamCalls, 0);
        });
    });

    it('combines canonical customer context with actual document citations, rejecting foreign customer scope', async () => {
        await withServer(async ({ request }) => {
            DB.createTables(); DB.ensureColumns(); DB.createSalesBrainTables();
            require('../src/services/crm-memory-store.service').initSchema(DB.db);
            DB.run("INSERT INTO instances(id,name) VALUES(7,'Свой бизнес'),(8,'Чужой')");
            DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES(7,'own','Свой клиент'),(8,'foreign','PRIVATE_FOREIGN')");
            const { chat } = await (await request('POST', '/7/business-gpt/chats', {})).json();
            LocalKnowledge.lookup = async () => ({ answer: 'Правило документа: заезд с 14:00.',
                citations: [{ source_id: 42, title: 'Правила' }], source_timestamp: '2026-10-15T10:00:00Z' });
            const body = { question: 'Что известно о клиенте и времени заезда?', customerChatId: 'own', requestId: crypto.randomUUID() };
            const response = await request('POST', `/7/business-gpt/chats/${chat.id}/messages`, body);
            assert.equal(response.status, 201);
            const { turn } = await response.json();
            assert.equal(turn.answerContext.kind, 'mixed');
            assert.equal(turn.answerContext.customerChatId, 'own');
            assert.ok(turn.answer.includes('Свой клиент'));
            assert.ok(turn.answer.includes('заезд с 14:00'));
            assert.deepEqual(turn.citations, [{ sourceId: 42, title: 'Правила' }]);
            assert.ok(turn.sources.some(item => item.kind === 'customer'));
            assert.ok(turn.sources.some(item => item.kind === 'document'));
            assert.equal((await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { ...body, customerChatId: 'foreign', requestId: crypto.randomUUID() })).status, 404);
            assert.ok(!JSON.stringify(turn).includes('PRIVATE_FOREIGN'));
        });
    });

    it('saves a cited local answer without waiting for Onyx', async () => {
        await withServer(async ({ request }) => {
            let upstreamCalls = 0;
            axios.post = async () => { upstreamCalls++; throw Error('unexpected upstream'); };
            LocalKnowledge.lookup = async () => ({ answer: 'Заезд с 14:00.',
                citations: [{ source_id: 42, title: 'Правила' }],
                source_timestamp: '2026-09-29T10:00:00Z' });
            const { chat } = await (await request('POST', '/7/business-gpt/chats', {})).json();
            const response = await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'Во сколько заезд?', requestId: crypto.randomUUID() });
            assert.equal(response.status, 201);
            assert.equal((await response.json()).turn.answer, 'Заезд с 14:00.');
            assert.equal(upstreamCalls, 0);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM customer_business_gpt_turns').n, 1);
        });
    });

    it('returns a prompt local no-match without calling Onyx or saving a turn', async () => {
        await withServer(async ({ request }) => {
            let upstreamCalls = 0;
            axios.post = async () => { upstreamCalls++; throw Error('unexpected upstream'); };
            LocalKnowledge.lookup = async () => null;
            LocalKnowledge.canConcludeNoMatch = () => true;
            const { chat } = await (await request('POST', '/7/business-gpt/chats', {})).json();
            const response = await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'Есть ли вертолётная площадка?', requestId: crypto.randomUUID() });
            assert.equal(response.status, 409);
            assert.deepEqual(await response.json(), { success: false, code: 'PREVIEW_NO_MATCH' });
            assert.equal(upstreamCalls, 0);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM customer_business_gpt_turns').n, 0);
        });
    });

    it('keeps Onyx fallback when a large local corpus cannot prove a no-match', async () => {
        await withServer(async ({ request }) => {
            LocalKnowledge.lookup = async () => null;
            LocalKnowledge.hasIndexedContent = () => true;
            LocalKnowledge.canConcludeNoMatch = () => false;
            let upstreamCalls = 0;
            axios.post = async (_url, payload) => { upstreamCalls++; return { data: grounded(payload) }; };
            const { chat } = await (await request('POST', '/7/business-gpt/chats', {})).json();
            const response = await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'Во сколько выезд?', requestId: crypto.randomUUID() });
            assert.equal(response.status, 201);
            assert.equal(upstreamCalls, 1);
        });
    });

    it('persists multi-turn history and replays a request without a second upstream call', async () => {
        await withServer(async ({ request }) => {
            let calls = 0;
            axios.post = async (_url, payload) => { calls++; return { data: grounded(payload) }; };
            const created = await request('POST', '/7/business-gpt/chats', {});
            assert.equal(created.status, 201);
            const { chat } = await created.json();
            const firstId = crypto.randomUUID();
            const first = await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'Когда заезд?', requestId: firstId });
            assert.equal(first.status, 201);
            assert.deepEqual((await first.json()).turn.citations, [{ sourceId: 42, title: 'Правила' }]);
            const replay = await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'Когда заезд?', requestId: firstId });
            assert.equal(replay.status, 200);
            assert.equal((await replay.json()).replayed, true);
            const second = await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'А выезд?', requestId: crypto.randomUUID() });
            assert.equal(second.status, 201);
            const tiedAt = '2026-09-23T12:00:00.000Z';
            DB.run("UPDATE customer_business_gpt_turns SET created_at = ?, id = ? WHERE question = ?",
                [tiedAt, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'Когда заезд?']);
            DB.run("UPDATE customer_business_gpt_turns SET created_at = ?, id = ? WHERE question = ?",
                [tiedAt, '00000000-0000-4000-8000-000000000000', 'А выезд?']);
            const history = await request('GET', `/7/business-gpt/chats/${chat.id}`);
            assert.equal(history.status, 200);
            assert.deepEqual((await history.json()).turns.map(turn => turn.question), ['Когда заезд?', 'А выезд?']);
            assert.equal(calls, 2);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM customer_business_gpt_turns').n, 2);
            assert.equal((await request('GET', '/7/business-gpt/chats').then(r => r.json())).chats[0].title, 'Когда заезд?');
            let contextualQuestion = '';
            axios.post = async (_url, payload) => { calls++; contextualQuestion = payload.question; return { data: grounded(payload) }; };
            const third = await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'Парковка?', requestId: crypto.randomUUID() });
            assert.equal(third.status, 201);
            assert.ok(contextualQuestion.indexOf('1. Вопрос: Когда заезд?') <
                contextualQuestion.indexOf('2. Вопрос: А выезд?'));
            assert.equal(calls, 3);
        });
    });

    it('isolates chats by business and user, validates same-origin and rejects browser scope fields', async () => {
        await withServer(async ({ request }) => {
            let calls = 0;
            axios.post = async () => { calls++; throw Error('unexpected'); };
            const { chat } = await (await request('POST', '/7/business-gpt/chats', {})).json();
            assert.equal((await request('GET', `/7/business-gpt/chats/${chat.id}`, undefined, 'user-b')).status, 404);
            assert.deepEqual((await request('GET', '/7/business-gpt/chats', undefined, 'user-b').then(r => r.json())).chats, []);
            assert.equal((await request('GET', `/8/business-gpt/chats/${chat.id}`)).status, 403);
            assert.equal((await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'Test', requestId: crypto.randomUUID() }, 'user-b')).status, 404);
            assert.equal((await request('POST', '/7/business-gpt/chats', {}, 'user-a', 'https://evil.example')).status, 403);
            assert.equal((await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'Test', requestId: crypto.randomUUID(), business_id: 8 })).status, 400);
            assert.equal(calls, 0);
        });
    });

    it('does not save or return ungrounded answers and rejects conflicting request ids', async () => {
        await withServer(async ({ request }) => {
            const { chat } = await (await request('POST', '/7/business-gpt/chats', {})).json();
            axios.post = async (_url, payload) => ({ data: { ...grounded(payload), grounded: false } });
            const id = crypto.randomUUID();
            const invalid = await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'Test?', requestId: id });
            assert.equal(invalid.status, 503);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM customer_business_gpt_turns').n, 0);
            axios.post = async (_url, payload) => ({ data: grounded(payload) });
            assert.equal((await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'Test?', requestId: id })).status, 201);
            assert.equal((await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'Different?', requestId: id })).status, 409);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM customer_business_gpt_turns').n, 1);
        });
    });

    it('limits simultaneous sends in one chat', async () => {
        await withServer(async ({ request }) => {
            const { chat } = await (await request('POST', '/7/business-gpt/chats', {})).json();
            let resolveCall;
            axios.post = (_url, payload) => new Promise(resolve => {
                resolveCall = () => resolve({ data: grounded(payload) });
            });
            const pending = request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'First?', requestId: crypto.randomUUID() });
            while (!resolveCall) await new Promise(resolve => setTimeout(resolve, 5));
            const duplicate = await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'Second?', requestId: crypto.randomUUID() });
            assert.equal(duplicate.status, 409);
            resolveCall();
            assert.equal((await pending).status, 201);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM customer_business_gpt_turns').n, 1);
        });
    });

    it('drops a late grounded answer after live membership is revoked', async () => {
        await withServer(async ({ request }) => {
            const { chat } = await (await request('POST', '/7/business-gpt/chats', {})).json();
            let revoked = false;
            const original = Identity.authorizeCapability;
            Identity.authorizeCapability = (auth, businessId) => {
                if (revoked) throw Error('revoked');
                return original(auth, businessId);
            };
            axios.post = async (_url, payload) => {
                revoked = true;
                return { data: grounded(payload) };
            };
            const response = await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'Sensitive?', requestId: crypto.randomUUID() });
            assert.equal(response.status, 403);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM customer_business_gpt_turns').n, 0);
        });
    });
    it('drops a late grounded answer after the browser session is revoked', async () => {
        await withServer(async ({ request }) => {
            const { chat } = await (await request('POST', '/7/business-gpt/chats', {})).json();
            let revoked = false;
            AuthService.getSession = req => revoked ? null : req.auth;
            axios.post = async (_url, payload) => {
                revoked = true;
                return { data: grounded(payload) };
            };
            const response = await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'Sensitive?', requestId: crypto.randomUUID() });
            assert.equal(response.status, 403);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM customer_business_gpt_turns').n, 0);
        });
    });

    it('uses the preview cleanup budget and returns an honest timeout code', async () => {
        await withServer(async ({ request }) => {
            const { chat } = await (await request('POST', '/7/business-gpt/chats', {})).json();
            axios.post = async (_url, payload, options) => {
                assert.equal(options.timeout, 40000);
                assert.equal(options.signal.aborted, false);
                return { data: { business_id: 7, channel: 'whatsapp',
                    correlation_id: payload.correlation_id, preview: true, read_only: true,
                    handled: false, customer_id: null, error_code: 'ONYX_RUNTIME_TIMEOUT' } };
            };
            const response = await request('POST', `/7/business-gpt/chats/${chat.id}/messages`,
                { question: 'What is checkout?', requestId: crypto.randomUUID() });
            assert.equal(response.status, 504);
            assert.deepEqual(await response.json(), { success: false, code: 'PREVIEW_TIMEOUT' });
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM customer_business_gpt_turns').n, 0);
        });
    });

    it('cancels the upstream turn and does not save a reply after browser disconnect', async () => {
        await withServer(async ({ request, root }) => {
            const { chat } = await (await request('POST', '/7/business-gpt/chats', {})).json();
            let started;
            const called = new Promise(resolve => { started = resolve; });
            let aborted;
            const cancelled = new Promise(resolve => { aborted = resolve; });
            axios.post = async (_url, _payload, options) => {
                started();
                return new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => {
                        aborted(); reject(Error('cancelled'));
                    }, { once: true });
                });
            };
            const controller = new AbortController();
            const pending = fetch(`${root}/7/business-gpt/chats/${chat.id}/messages`, {
                method: 'POST', signal: controller.signal,
                headers: { 'Content-Type': 'application/json', Origin: 'https://ava.example.test' },
                body: JSON.stringify({ question: 'Заезд?', requestId: crypto.randomUUID() }),
            });
            await called;
            controller.abort();
            await assert.rejects(pending);
            await Promise.race([cancelled, new Promise((_resolve, reject) =>
                setTimeout(() => reject(Error('upstream not cancelled')), 1000))]);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM customer_business_gpt_turns').n, 0);
        });
    });
});
