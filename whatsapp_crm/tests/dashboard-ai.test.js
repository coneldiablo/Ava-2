'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const express = require('express');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const Deals = require('../src/services/customer-deals.store');
const AI = require('../src/services/dashboard/ai');
const Facts = require('../src/services/dashboard/facts');
const Knowledge = require('../src/services/dashboard/ai.knowledge');
const PDF = require('../src/services/dashboard/ai.pdf');
const Audio = require('../src/services/dashboard/ai.audio');
const routes = require('../src/routes/dashboard-ai.routes');
const WebSocket = require('ws');
const axios = require('axios');
const config = require('../src/config');

async function withMockModel(fn, onRequest = () => {}) {
    const previousPost = axios.post;
    const previousKey = config.aiTunnel.apiKey;
    config.aiTunnel.apiKey = 'local-test-key';
    axios.post = async (endpoint, request) => {
        assert.match(endpoint, /\/chat\/completions$/);
        const input = JSON.parse(request.messages[1].content);
        onRequest(input);
        const fact = input.facts.find(row => row.id.startsWith('clients:')) || input.facts[0];
        const answer = /погод/i.test(input.question)
            ? { status: 'insufficient', answer: '', sourceIds: [] }
            : { status: 'answered', answer: fact.summary, sourceIds: [fact.id] };
        return { data: { choices: [{ message: { content: JSON.stringify(answer) } }] } };
    };
    try { return await fn(); }
    finally { axios.post = previousPost; config.aiTunnel.apiKey = previousKey; }
}

function fixture() {
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Business A'),(2,'Business B')");
    DB.run("INSERT INTO ava_users(id,email,displayName) VALUES ('user-a','a@example.test','A')");
    DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES ('user-a',1,'hotel_owner')");
    const now = new Date();
    const at = new Date(now.getTime() - 60_000).toISOString();
    DB.run('INSERT INTO conversation_events(eventId,instanceId,channel,direction,role,content,createdAt) VALUES (?,?,?,?,?,?,?)',
        ['event-a', 1, 'whatsapp', 'inbound', 'user', 'Private A', at]);
    DB.run('INSERT INTO conversation_events(eventId,instanceId,channel,direction,role,content,createdAt) VALUES (?,?,?,?,?,?,?)',
        ['event-b', 2, 'whatsapp', 'inbound', 'user', 'Private B', at]);
    DB.run('INSERT INTO lead_status_history(instanceId,chatId,toStatus,createdAt) VALUES (?,?,?,?)',
        [1, 'a', 'qualified', at]);
    Deals.create(1, { title: 'Сделка А', nextAction: 'Позвонить', nextActionAt: now.toISOString().slice(0, 10) });
    Deals.create(2, { title: 'Private Deal B', nextActionAt: now.toISOString().slice(0, 10) });
    return { auth: { userId: 'user-a' }, now };
}

async function server(auth) {
    const previousGetSession = Auth.getSession;
    Auth.getSession = () => auth;
    const app = express();
    app.use(express.json());
    app.use('/api', (req, _res, next) => { req.auth = auth; next(); });
    app.use('/api', routes);
    const listener = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    listener.on('close', () => { Auth.getSession = previousGetSession; });
    return { listener, url: `http://127.0.0.1:${listener.address().port}` };
}

describe('Dashboard AI tenant-scoped briefing', () => {
    it('routes service, price and stay questions to knowledge while keeping CRM analytics on records', () => {
        for (const question of [
            'Какие услуги доступны?', 'Сколько стоит номер?', 'Во сколько работает бассейн?',
            'Какие правила проживания?', 'Как отменить бронь?', 'Что входит в тариф?',
        ]) assert.strictEqual(AI.isKnowledgeQuestion(question), true, question);
        for (const question of [
            'Сколько новых клиентов сегодня?', 'Прогноз выручки по услугам',
            'Какие сделки по номерам закрылись?', 'Сколько было звонков о заселении?',
            'Кто из клиентов рискует уйти?', 'Как идет мой бизнес?',
        ]) assert.strictEqual(AI.isKnowledgeQuestion(question), false, question);
    });

    it('counts only selected business records and cites recommendation sources', async () => {
        const { now } = fixture();
        const range = AI.period({}, now);
        const result = AI.briefing(1, range, { pdf: true, audio: { available: false } });
        assert.strictEqual(result.businessId, 1);
        assert.strictEqual(result.eventCount, 2);
        assert.strictEqual(result.sourceComplete, true);
        assert.ok(result.recommendations.some(row => row.id.startsWith('deal:')));
        assert.ok(result.recommendations.every(row => row.sources.length && row.sources.every(src => src.type && src.id && src.createdAt)));
        assert.ok(!JSON.stringify(result).includes('Private B'));
        assert.ok(!JSON.stringify(result).includes('Private Deal B'));
        await withMockModel(async () => {
            const answer = await AI.ask(1, range, 'Что со сделками?');
            assert.strictEqual(answer.grounded, true);
            assert.ok(answer.sources.every(src => src.id !== 'event-b'));
            await assert.rejects(AI.ask(1, range, 'Какая будет погода?'),
                error => error.code === 'DASHBOARD_MODEL_INVALID');
        });
    });

    it('rejects invalid period and produces a truthful empty briefing', () => {
        fixture();
        assert.throws(() => AI.period({ from: 'yesterday' }), /INVALID_PERIOD/);
        const empty = AI.briefing(1, AI.period({ from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z' }),
            { pdf: true, audio: { available: false } });
        assert.strictEqual(empty.eventCount, 0);
        assert.ok(empty.summary.includes('нет'));
    });

    it('uses the business timezone for the last night and handles its start boundary', () => {
        fixture();
        DB.run("UPDATE instances SET hotelTimezone='Europe/Moscow' WHERE id=1");
        assert.deepStrictEqual(AI.nightPeriod(1, new Date('2026-09-25T06:00:00Z')),
            { from: '2026-09-24T17:00:00.000Z', to: '2026-09-25T06:00:00.000Z' });
        assert.deepStrictEqual(AI.nightPeriod(1, new Date('2026-09-25T17:00:00Z')),
            { from: '2026-09-25T17:00:00.000Z', to: '2026-09-25T17:00:00.000Z' });
        assert.deepStrictEqual(AI.nightPeriod(1, new Date('2026-09-25T17:00:30Z')),
            { from: '2026-09-25T17:00:00.000Z', to: '2026-09-25T17:00:30.000Z' });
    });

    it('enforces live membership and scope at the HTTP route', async () => {
        const { auth } = fixture();
        const { listener, url } = await server(auth);
        try {
            const own = await fetch(`${url}/api/dashboard/1/ai/briefing`);
            assert.strictEqual(own.status, 200);
            const ownBody = await own.json();
            assert.strictEqual(ownBody.briefing.eventCount, 2);
            assert.strictEqual(ownBody.briefing.capabilities.audio.available, false);
            const pdf = await fetch(`${url}/api/dashboard/1/ai/briefing.pdf`);
            assert.strictEqual(pdf.status, 200);
            assert.strictEqual((await pdf.arrayBuffer()).byteLength > 1000, true);
            const audio = await fetch(`${url}/api/dashboard/1/ai/briefing/audio`);
            assert.strictEqual(audio.status, 503);
            assert.strictEqual((await audio.json()).code, 'AUDIO_UNAVAILABLE');
            const other = await fetch(`${url}/api/dashboard/2/ai/briefing`);
            assert.strictEqual(other.status, 403);
            const override = await fetch(`${url}/api/dashboard/1/ai/briefing?businessId=2`);
            assert.strictEqual(override.status, 403);
            const crossOrigin = await fetch(`${url}/api/dashboard/1/ai/ask`, { method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
                body: JSON.stringify({ question: 'План' }) });
            assert.strictEqual(crossOrigin.status, 403);
            DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='user-a' AND businessId=1");
            const revoked = await fetch(`${url}/api/dashboard/1/ai/briefing`);
            assert.strictEqual(revoked.status, 403);
        } finally { await new Promise(resolve => listener.close(resolve)); }
    });

    it('replays the same Ask request and rejects conflicting request IDs', async () => {
        const { auth } = fixture();
        const { listener, url } = await server(auth);
        const requestId = '11111111-1111-4111-8111-111111111111';
        const ask = (question, origin = url) => fetch(`${url}/api/dashboard/1/ai/ask`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
            body: JSON.stringify({ question, requestId }),
        });
        try { await withMockModel(async () => {
            const first = await ask('Что со сделками?');
            assert.strictEqual(first.status, 200);
            const body = await first.json();
            assert.strictEqual(body.grounded, true);
            const repeated = await ask('Что со сделками?');
            assert.strictEqual(repeated.status, 200);
            assert.strictEqual((await repeated.json()).replayed, true);
            const conflict = await ask('План на день');
            assert.strictEqual(conflict.status, 409);
        }); } finally { await new Promise(resolve => listener.close(resolve)); }
    });

    it('answers overnight CRM prompts and serves a tenant-scoped activity feed without Onyx', async () => {
        const { auth } = fixture();
        const window = AI.nightPeriod(1);
        const at = new Date((Date.parse(window.from) + Date.parse(window.to)) / 2).toISOString();
        DB.run('INSERT INTO clients(instanceId,chatId,senderName,leadStatus,createdAt) VALUES (?,?,?,?,?)',
            [1, 'lead-a', 'Лид бизнеса А', 'new', at]);
        DB.run('INSERT INTO clients(instanceId,chatId,senderName,leadStatus,createdAt) VALUES (?,?,?,?,?)',
            [2, 'lead-b', 'Foreign private lead', 'new', at]);
        DB.run('UPDATE customer_deals SET revision=2,updatedAt=? WHERE instanceId=1', [at]);
        DB.run('INSERT INTO tool_runs(toolRunId,instanceId,toolName,status,createdAt) VALUES (?,?,?,?,?)',
            ['tool-a', 1, 'qualify_lead', 'ok', at]);
        const previousToken = process.env.CRM_SERVICE_API_TOKEN;
        delete process.env.CRM_SERVICE_API_TOKEN;
        const { listener, url } = await server(auth);
        try { await withMockModel(async () => {
            const activity = await fetch(`${url}/api/dashboard/1/activity?window=overnight`);
            assert.strictEqual(activity.status, 200);
            const feed = await activity.json();
            assert.strictEqual(feed.instanceId, 1);
            assert.strictEqual(feed.status, 'available');
            assert.strictEqual(feed.sourceComplete, false);
            assert.ok(feed.items.some(item => item.kind === 'new_lead' && item.title === 'Лид бизнеса А'));
            assert.ok(feed.items.some(item => item.kind === 'deal_updated'));
            assert.ok(feed.items.every(item => item.kind !== 'tool_run' && !item.source));
            assert.ok(!JSON.stringify(feed.items).includes('qualify_lead'));
            assert.ok(!JSON.stringify(feed.items).includes('internal'));
            assert.ok(!JSON.stringify(feed.items).includes('draft'));
            assert.ok(!JSON.stringify(feed).includes('Foreign private lead'));
            assert.strictEqual((await fetch(`${url}/api/dashboard/2/activity?window=overnight`)).status, 403);
            assert.strictEqual((await fetch(`${url}/api/dashboard/1/activity?window=today`)).status, 400);
            for (const question of ['Что произошло за ночь?', 'Новые лиды за ночь',
                'Какие сделки требуют внимания?', 'Составь план на день', 'Что важно сегодня?']) {
                const response = await fetch(`${url}/api/dashboard/1/ai/ask`, { method: 'POST',
                    headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ question }) });
                assert.strictEqual(response.status, 200, question);
                const answer = await response.json();
                assert.strictEqual(answer.provenance, 'aitunnel_crm');
                assert.ok(answer.answer.length > 20);
                if (/ноч/.test(question)) assert.ok(answer.sources.some(item => item.type === 'clients'));
                assert.ok(!JSON.stringify(answer).includes('Foreign private lead'));
            }
        });
        } finally {
            if (previousToken === undefined) delete process.env.CRM_SERVICE_API_TOKEN;
            else process.env.CRM_SERVICE_API_TOKEN = previousToken;
            await new Promise(resolve => listener.close(resolve));
        }
    });

    it('regenerates the overnight answer after a durable new fact in the same window', async () => {
        fixture();
        const now = new Date('2026-09-29T08:00:00Z');
        const range = AI.nightPeriod(1, now);
        DB.run('INSERT INTO clients(instanceId,chatId,senderName,leadStatus,createdAt) VALUES (?,?,?,?,?)',
            [1, 'first', 'First', 'new', '2026-09-28T22:00:00Z']);
        let requests = 0;
        await withMockModel(async () => {
            const first = await AI.ask(1, range, 'Что произошло за ночь?', { overnight: true, now });
            assert.strictEqual(first.grounded, true);
            const later = new Date(now.getTime() + 60_000);
            const laterRange = AI.nightPeriod(1, later);
            const repeated = await AI.ask(1, laterRange, 'Что произошло за ночь?',
                { overnight: true, now: later });
            assert.strictEqual(repeated.sourceRevision, first.sourceRevision);
            assert.strictEqual(repeated.generatedAt, first.generatedAt);
            assert.strictEqual(repeated.summarizedThrough, first.summarizedThrough);
            assert.strictEqual(requests, 1);
            DB.run('INSERT INTO clients(instanceId,chatId,senderName,leadStatus,createdAt) VALUES (?,?,?,?,?)',
                [1, 'second', 'Second', 'qualified', '2026-09-28T23:00:00Z']);
            const second = await AI.ask(1, laterRange, 'Что произошло за ночь?',
                { overnight: true, now: later });
            assert.strictEqual(second.grounded, true);
            assert.notStrictEqual(second.sourceRevision, first.sourceRevision);
            assert.notStrictEqual(second.answer, first.answer);
            assert.strictEqual(requests, 2);
        }, () => { requests++; });
    });

    it('serves separate generated yesterday and overnight summaries without cross-tenant records', async () => {
        const { auth } = fixture();
        for (const kind of ['yesterday', 'overnight']) {
            const window = Facts.getFactPacket(1, { window: kind }).window;
            const at = new Date((Date.parse(window.start) + Date.parse(window.endExclusive)) / 2).toISOString();
            DB.run('INSERT INTO clients(instanceId,chatId,senderName,leadStatus,createdAt) VALUES (?,?,?,?,?)',
                [1, `${kind}-a`, 'Visible client', kind, at]);
            DB.run('INSERT INTO clients(instanceId,chatId,senderName,leadStatus,createdAt) VALUES (?,?,?,?,?)',
                [2, `${kind}-b`, 'Private tenant B', kind, at]);
        }
        const { listener, url } = await server(auth);
        try { await withMockModel(async () => {
            for (const kind of ['yesterday', 'overnight']) {
                const response = await fetch(`${url}/api/dashboard/1/ai/overview?window=${kind}`);
                assert.strictEqual(response.status, 200);
                const { overview } = await response.json();
                assert.strictEqual(overview.window.kind, kind);
                assert.strictEqual(overview.grounded, true);
                assert.strictEqual(overview.answerStatus, 'answered');
                assert.ok(overview.summary.length > 10);
                assert.ok(Array.isArray(overview.changes));
                assert.ok(Array.isArray(overview.attention));
                assert.strictEqual(overview.outcome, overview.summary);
                assert.ok(overview.highlights.every(item => Object.keys(item).join(',') === 'text'));
                assert.strictEqual(overview.sources, undefined);
                assert.strictEqual(overview.counts, undefined);
                assert.strictEqual(overview.limitations, undefined);
                assert.ok(!JSON.stringify(overview).includes('Private tenant B'));
                assert.ok(!JSON.stringify(overview).includes('chatId'));
            }
            assert.strictEqual((await fetch(`${url}/api/dashboard/2/ai/overview?window=overnight`)).status, 403);
            assert.strictEqual((await fetch(`${url}/api/dashboard/1/ai/overview?window=all`)).status, 400);
        }); } finally { await new Promise(resolve => listener.close(resolve)); }
    });

    it('uses verified tenant-scoped Onyx only for unsupported knowledge questions', async () => {
        const { auth } = fixture();
        const { listener, url } = await server(auth);
        const previousPost = axios.post;
        const previousToken = process.env.CRM_SERVICE_API_TOKEN;
        const previousBase = process.env.AVA_ADMIN_API_URL;
        process.env.CRM_SERVICE_API_TOKEN = 'test-service-token';
        process.env.AVA_ADMIN_API_URL = 'https://admin.example.test';
        axios.post = async (endpoint, body, options) => {
            assert.strictEqual(endpoint, 'https://admin.example.test/api/internal/onyx/knowledge/preview');
            assert.strictEqual(body.business_id, 1);
            assert.strictEqual(body.customer_id, undefined);
            assert.strictEqual(options.timeout, 40000);
            assert.ok(options.signal);
            return { data: { business_id: 1, channel: 'whatsapp', correlation_id: body.correlation_id,
                preview: true, read_only: true, handled: true, grounded: true, stale: false,
                customer_id: null, customer_context_provided: false,
                answer: 'Заселение после 14:00.', source_timestamp: new Date().toISOString(),
                citations: [{ source_id: 7, title: 'Правила заселения' }] } };
        };
        try {
            const response = await fetch(`${url}/api/dashboard/1/ai/ask`, { method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: url },
                body: JSON.stringify({ question: 'Какие правила заселения?' }) });
            assert.strictEqual(response.status, 200);
            const result = await response.json();
            assert.strictEqual(result.provenance, 'onyx_knowledge');
            assert.strictEqual(result.grounded, true);
            assert.strictEqual(result.sources[0].title, 'Правила заселения');
            axios.post = async () => { throw new Error('contains-sensitive-provider-details'); };
            const unavailable = await fetch(`${url}/api/dashboard/1/ai/ask`, { method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: url },
                body: JSON.stringify({ question: 'Как действует программа лояльности?' }) });
            assert.strictEqual(unavailable.status, 503);
            assert.strictEqual((await unavailable.json()).code, 'KNOWLEDGE_UNAVAILABLE');
            axios.post = async () => { throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); };
            const timeout = await fetch(`${url}/api/dashboard/1/ai/ask`, { method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: url },
                body: JSON.stringify({ question: 'Что в базе знаний о позднем выезде?' }) });
            assert.strictEqual(timeout.status, 504);
            assert.strictEqual((await timeout.json()).code, 'KNOWLEDGE_TIMEOUT');
        } finally {
            axios.post = previousPost;
            if (previousToken === undefined) delete process.env.CRM_SERVICE_API_TOKEN;
            else process.env.CRM_SERVICE_API_TOKEN = previousToken;
            if (previousBase === undefined) delete process.env.AVA_ADMIN_API_URL;
            else process.env.AVA_ADMIN_API_URL = previousBase;
            await new Promise(resolve => listener.close(resolve));
        }
    });

    it('answers a document question from current local chunks without a slow Onyx request', async () => {
        fixture();
        DB.run("INSERT INTO ava_users(id,email,displayName) VALUES ('local-doc-user','local-doc@example.test','Local')");
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES ('local-doc-user',1,'hotel_owner')");
        const own = DB.addKnowledgeBaseFile(1, 'rules.txt', 'Правила', 'local-one', 'text/plain', 80);
        await DB.addKnowledgeBaseChunks(own, [
            'Заезд с 14:00. Выезд до 12:00.',
            'Услуги: бассейн и завтрак доступны ежедневно.',
        ]);
        const foreign = DB.addKnowledgeBaseFile(2, 'rules.txt', 'Чужое', 'local-two', 'text/plain', 80);
        await DB.addKnowledgeBaseChunks(foreign, ['Заезд с 09:00.', 'Услуги: казино и яхта.']);
        const { listener, url } = await server({ userId: 'local-doc-user' });
        const previousPost = axios.post;
        axios.post = async () => { throw Error('Onyx should not be called'); };
        try {
            const response = await fetch(`${url}/api/dashboard/1/ai/ask`, { method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: url },
                body: JSON.stringify({ question: 'Во сколько заезд?' }) });
            assert.strictEqual(response.status, 200);
            const answer = await response.json();
            assert.strictEqual(answer.provenance, 'local_knowledge_extract');
            assert.strictEqual(answer.grounded, true);
            assert.match(answer.answer, /14:00/);
            assert.ok(!JSON.stringify(answer).includes('09:00'));
            assert.deepStrictEqual(answer.sources.map(item => item.id), [String(own)]);
            const servicesResponse = await fetch(`${url}/api/dashboard/1/ai/ask`, { method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: url },
                body: JSON.stringify({ question: 'Какие услуги доступны?' }) });
            assert.strictEqual(servicesResponse.status, 200);
            const services = await servicesResponse.json();
            assert.strictEqual(services.provenance, 'local_knowledge_extract');
            assert.match(services.answer, /бассейн и завтрак/);
            assert.ok(!JSON.stringify(services).includes('казино'));
            assert.deepStrictEqual(services.sources.map(item => item.id), [String(own)]);
            const missingResponse = await fetch(`${url}/api/dashboard/1/ai/ask`, { method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: url },
                body: JSON.stringify({ question: 'Что сказано о парковке?' }) });
            assert.strictEqual(missingResponse.status, 200);
            const missing = await missingResponse.json();
            assert.strictEqual(missing.grounded, false);
            assert.strictEqual(missing.dataStatus, 'no_match');
            assert.deepStrictEqual(missing.sources, []);
            assert.strictEqual(missing.provenance, 'local_knowledge_extract');
        } finally {
            axios.post = previousPost;
            await new Promise(resolve => listener.close(resolve));
        }
    });

    it('adds current tenant state to broad business questions beyond the default 24-hour window', async () => {
        fixture();
        DB.run(`INSERT INTO clients(instanceId,chatId,senderName,leadStatus,createdAt)
            VALUES (1,'historical-own','Own','qualified','2026-01-01T00:00:00Z'),
                   (2,'historical-foreign','Foreign','lost','2026-01-01T00:00:00Z')`);
        const range = AI.period();
        let input;
        await withMockModel(async () => {
            const answer = await AI.ask(1, range, 'Как идет мой бизнес?');
            assert.strictEqual(answer.grounded, true);
        }, request => { input = request; });
        assert.ok(input.facts.some(fact => fact.id === 'current:clients'
            && fact.summary.includes('1 клиент')));
        assert.ok(input.facts.some(fact => fact.id === 'current:lead-status:qualified'));
        assert.ok(!JSON.stringify(input).includes('historical-foreign'));
        assert.ok(!JSON.stringify(input).includes('lost'));
    });

    it('returns a truthful empty answer for a verified ungrounded Onyx result', async () => {
        fixture();
        DB.run("INSERT INTO ava_users(id,email,displayName) VALUES ('user-ungrounded','u@example.test','U')");
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES ('user-ungrounded',1,'hotel_owner')");
        const { listener, url } = await server({ userId: 'user-ungrounded' });
        const previousPost = axios.post;
        const previousToken = process.env.CRM_SERVICE_API_TOKEN;
        const previousBase = process.env.AVA_ADMIN_API_URL;
        process.env.CRM_SERVICE_API_TOKEN = 'test-service-token';
        process.env.AVA_ADMIN_API_URL = 'https://admin.example.test';
        const ask = question => fetch(`${url}/api/dashboard/1/ai/ask`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ question }) });
        try {
            axios.post = async (_endpoint, body) => ({ data: {
                business_id: 1, channel: 'whatsapp', correlation_id: body.correlation_id,
                preview: true, read_only: true, handled: false, customer_id: null,
                error_code: 'ONYX_RUNTIME_UNGROUNDED', raw_error: 'Bearer private-token',
            } });
            const ungrounded = await ask('Какие правила заселения?');
            assert.strictEqual(ungrounded.status, 200);
            const result = await ungrounded.json();
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.grounded, false);
            assert.deepStrictEqual(result.sources, []);
            assert.match(result.answer, /нет подтверждённого ответа/i);
            assert.ok(!JSON.stringify(result).includes('private-token'));
            axios.post = async (_endpoint, body) => ({ data: {
                business_id: 2, channel: 'whatsapp', correlation_id: body.correlation_id,
                preview: true, read_only: true, handled: false, customer_id: null,
                error_code: 'ONYX_RUNTIME_UNGROUNDED',
            } });
            const foreign = await ask('Что сказано о позднем выезде?');
            assert.strictEqual(foreign.status, 503);
            assert.strictEqual((await foreign.json()).code, 'KNOWLEDGE_UNAVAILABLE');
            axios.post = async () => ({ data: {
                business_id: 1, channel: 'whatsapp', correlation_id: 'foreign-request',
                preview: true, read_only: true, handled: false, customer_id: null,
                error_code: 'ONYX_RUNTIME_UNGROUNDED',
            } });
            const unrelated = await ask('Что сказано о питании?');
            assert.strictEqual(unrelated.status, 503);
            assert.strictEqual((await unrelated.json()).code, 'KNOWLEDGE_UNAVAILABLE');
            axios.post = async (_endpoint, body) => ({ data: {
                business_id: 1, channel: 'whatsapp', correlation_id: body.correlation_id,
                preview: true, read_only: true, handled: false, customer_id: null,
                error_code: 'ONYX_RUNTIME_NOT_LIVE',
            } });
            const notReady = await ask('Что написано о парковке?');
            assert.strictEqual(notReady.status, 503);
            assert.strictEqual((await notReady.json()).code, 'KNOWLEDGE_NOT_READY');

        } finally {
            axios.post = previousPost;
            if (previousToken === undefined) delete process.env.CRM_SERVICE_API_TOKEN;
            else process.env.CRM_SERVICE_API_TOKEN = previousToken;
            if (previousBase === undefined) delete process.env.AVA_ADMIN_API_URL;
            else process.env.AVA_ADMIN_API_URL = previousBase;
            await new Promise(resolve => listener.close(resolve));
        }
    });

    it('preserves empty and indexing states through the HTTP error whitelist', async () => {
        fixture();
        DB.run("INSERT INTO ava_users(id,email,displayName) VALUES ('user-source-state','state@example.test','S')");
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES ('user-source-state',1,'hotel_owner')");
        const { listener, url } = await server({ userId: 'user-source-state' });
        const previousPost = axios.post;
        const previousToken = process.env.CRM_SERVICE_API_TOKEN;
        const previousBase = process.env.AVA_ADMIN_API_URL;
        process.env.CRM_SERVICE_API_TOKEN = 'test-service-token';
        process.env.AVA_ADMIN_API_URL = 'https://admin.example.test';
        const ask = question => fetch(`${url}/api/dashboard/1/ai/ask`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ question }) });
        try {
            for (const [upstream, code] of [['ONYX_RUNTIME_EMPTY', 'KNOWLEDGE_EMPTY'],
                ['ONYX_RUNTIME_INDEXING', 'KNOWLEDGE_INDEXING']]) {
                axios.post = async (_endpoint, body) => ({ data: {
                    business_id: 1, channel: 'whatsapp', correlation_id: body.correlation_id,
                    preview: true, read_only: true, handled: false, customer_id: null,
                    error_code: upstream,
                } });
                const response = await ask('Каковы правила для гостей?');
                assert.strictEqual(response.status, 409);
                assert.deepStrictEqual(await response.json(), { success: false, code });
            }
        } finally {
            axios.post = previousPost;
            if (previousToken === undefined) delete process.env.CRM_SERVICE_API_TOKEN;
            else process.env.CRM_SERVICE_API_TOKEN = previousToken;
            if (previousBase === undefined) delete process.env.AVA_ADMIN_API_URL;
            else process.env.AVA_ADMIN_API_URL = previousBase;
            await new Promise(resolve => listener.close(resolve));
        }
    });

    it('distinguishes client cancellation from an Onyx outage', async () => {
        const previousPost = axios.post;
        const previousToken = process.env.CRM_SERVICE_API_TOKEN;
        const previousBase = process.env.AVA_ADMIN_API_URL;
        process.env.CRM_SERVICE_API_TOKEN = 'test-service-token';
        process.env.AVA_ADMIN_API_URL = 'https://admin.example.test';
        const controller = new AbortController();
        controller.abort();
        axios.post = async (_endpoint, _body, options) => {
            assert.strictEqual(options.signal, controller.signal);
            throw Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });
        };
        try {
            await assert.rejects(Knowledge.askKnowledge(1, 'abort-user', 'Правила?', controller.signal),
                error => error.code === 'KNOWLEDGE_CANCELED' && error.statusCode === 499);
        } finally {
            axios.post = previousPost;
            if (previousToken === undefined) delete process.env.CRM_SERVICE_API_TOKEN;
            else process.env.CRM_SERVICE_API_TOKEN = previousToken;
            if (previousBase === undefined) delete process.env.AVA_ADMIN_API_URL;
            else process.env.AVA_ADMIN_API_URL = previousBase;
        }
    });

    it('exports a Cyrillic PDF and honest audio capability', async () => {
        const { now } = fixture();
        const result = AI.briefing(1, AI.period({}, now), { pdf: true, audio: Audio.capability() });
        const pdf = await PDF.exportPdf(result);
        assert.strictEqual(pdf.subarray(0, 5).toString(), '%PDF-');
        assert.ok(pdf.length > 1000);
        assert.deepStrictEqual(Audio.capability(), { available: false, reason: 'TTS_NOT_CONFIGURED' });
        await assert.rejects(Audio.synthesize(result), /AUDIO_UNAVAILABLE/);
    });

    it('uses the local AI TTS protocol and returns playable PCM WAV', async () => {
        const wsServer = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
        await new Promise(resolve => wsServer.once('listening', resolve));
        wsServer.on('connection', socket => socket.on('message', raw => {
            const message = JSON.parse(raw.toString());
            if (message.type === 'auth') {
                assert.strictEqual(message.auth_token, 'test-token');
                socket.send(JSON.stringify({ type: 'auth_response', status: 'ok' }));
            } else if (message.type === 'status') {
                socket.send(JSON.stringify({ type: 'status_response', status: 'ok',
                    models: { tts: { loaded: true } } }));
            } else if (message.type === 'tts_request') {
                assert.ok(message.text.length <= 800);
                const bytes = Buffer.alloc(320, 0xff);
                socket.send(JSON.stringify({ type: 'tts_response', request_id: message.request_id,
                    encoding: 'mulaw', sample_rate_hz: 8000, byte_length: bytes.length,
                    audio_data: bytes.toString('base64') }));
            }
        }));
        const previousUrl = process.env.DASHBOARD_TTS_WS_URL;
        const previousToken = process.env.DASHBOARD_TTS_AUTH_TOKEN;
        process.env.DASHBOARD_TTS_WS_URL = `ws://127.0.0.1:${wsServer.address().port}`;
        process.env.DASHBOARD_TTS_AUTH_TOKEN = 'test-token';
        try {
            assert.strictEqual(Audio.capability().available, true);
            assert.strictEqual((await Audio.probe()).available, true);
            const buffer = await Audio.synthesize({ summary: 'Краткий брифинг', recommendations: [] });
            assert.strictEqual(buffer.subarray(0, 4).toString(), 'RIFF');
            assert.strictEqual(buffer.subarray(8, 12).toString(), 'WAVE');
            assert.strictEqual(buffer.readUInt16LE(20), 1);
            assert.strictEqual(buffer.readUInt32LE(24), 8000);
            assert.strictEqual(buffer.length, 44 + 640);
        } finally {
            await new Promise(resolve => wsServer.close(resolve));
            if (previousUrl === undefined) delete process.env.DASHBOARD_TTS_WS_URL;
            else process.env.DASHBOARD_TTS_WS_URL = previousUrl;
            if (previousToken === undefined) delete process.env.DASHBOARD_TTS_AUTH_TOKEN;
            else process.env.DASHBOARD_TTS_AUTH_TOKEN = previousToken;
        }
    });
});
