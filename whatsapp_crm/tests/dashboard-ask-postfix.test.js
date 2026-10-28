'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const express = require('express');
const axios = require('axios');
const config = require('../src/config');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const Deals = require('../src/services/customer-deals.store');
const AI = require('../src/services/dashboard/ai');
const routes = require('../src/routes/dashboard-ai.routes');

function fixture() {
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name,hotelTimezone) VALUES (1,'QA A','Europe/Moscow'),(2,'QA B','America/New_York')");
    DB.run("INSERT INTO ava_users(id,email,displayName) VALUES ('qa-postfix','qa@example.test','QA')");
    DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES ('qa-postfix',1,'hotel_owner')");
    const to = new Date(Date.now() - 1000);
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
    const at = new Date((from.getTime() + to.getTime()) / 2).toISOString();
    DB.run('INSERT INTO conversation_events(eventId,instanceId,channel,direction,role,content,createdAt) VALUES (?,?,?,?,?,?,?)',
        ['qa-event-a', 1, 'whatsapp', 'inbound', 'user', 'Tenant A conversation', at]);
    DB.run('INSERT INTO conversation_events(eventId,instanceId,channel,direction,role,content,createdAt) VALUES (?,?,?,?,?,?,?)',
        ['qa-event-b', 2, 'whatsapp', 'inbound', 'user', 'FOREIGN_TENANT_MARKER', at]);
    Deals.create(1, { title: 'Tenant A deal', nextActionAt: to.toISOString().slice(0, 10) });
    Deals.create(2, { title: 'FOREIGN_DEAL_MARKER', nextActionAt: to.toISOString().slice(0, 10) });
    DB.run('INSERT INTO manager_tasks(taskId,instanceId,chatId,customerName,summary,status,priority,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)',
        ['qa-task-a', 1, 'lead-a', 'Tenant A client', 'Позвонить клиенту А', 'open', 'high', at, at]);
    return { from: from.toISOString(), to: to.toISOString(), at };
}

async function server() {
    const oldSession = Auth.getSession;
    Auth.getSession = () => ({ userId: 'qa-postfix' });
    const app = express();
    app.use(express.json());
    app.use('/api', (req, _res, next) => { req.auth = { userId: 'qa-postfix' }; next(); });
    app.use('/api', routes);
    const listener = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    return {
        url: `http://127.0.0.1:${listener.address().port}`,
        close: async () => { await new Promise(resolve => listener.close(resolve)); Auth.getSession = oldSession; },
    };
}

async function ask(url, businessId, question, range) {
    const response = await fetch(`${url}/api/dashboard/${businessId}/ai/ask`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url },
        body: JSON.stringify({ question, from: range.from, to: range.to }),
    });
    return { status: response.status, body: await response.json() };
}

async function overview(url, window) {
    const response = await fetch(`${url}/api/dashboard/1/ai/overview?window=${window}`);
    return { status: response.status, body: await response.json() };
}

async function withFrozenTime(initial, callback) {
    const RealDate = global.Date;
    let current = initial;
    global.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [current])); }
        static now() { return RealDate.parse(current); }
    };
    try { await callback(value => { current = value; }); }
    finally { global.Date = RealDate; }
}

async function withMockModel(callback, { delayMs = 0 } = {}) {
    const oldPost = axios.post;
    const oldConfig = { ...config.aiTunnel };
    config.aiTunnel.apiKey = 'qa-only-key';
    config.aiTunnel.apiUrl = 'https://qa-model.example.test/v1';
    config.aiTunnel.model = 'qa-model';
    const requests = [];
    axios.post = async (url, body, options) => {
        assert.equal(url, 'https://qa-model.example.test/v1/chat/completions');
        assert.equal(body.model, 'qa-model');
        assert.equal(body.store, false);
        assert.equal(options.timeout <= 65_000, true);
        const prompt = JSON.parse(body.messages.find(message => message.role === 'user').content);
        requests.push(prompt);
        const first = prompt.question.includes('план на день')
            ? prompt.facts.find(fact => fact.id.includes('qa-task-a'))
            : prompt.facts.find(fact => fact.id.startsWith('conversation_events:')
                || fact.id.startsWith('conversation_event:')) || prompt.facts[0];
        assert.ok(first?.id, 'model must receive a source-backed fact');
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        const result = prompt.question.includes('рискует уйти')
            ? { status: 'insufficient', answer: 'Зафиксировано событие диалога. Определить риск ухода по этим данным нельзя.', sourceIds: [first.id] }
            : prompt.question.includes('план на день')
                ? { status: 'answered', answer: 'Проверьте задачу: позвонить клиенту А.', sourceIds: [first.id] }
                : { status: 'answered', answer: 'Зафиксировано событие диалога.', sourceIds: [first.id] };
        return { data: { choices: [{ message: { content: JSON.stringify(result) } }] } };
    };
    try { await callback(requests); }
    finally { axios.post = oldPost; Object.assign(config.aiTunnel, oldConfig); }
}

describe('Dashboard Ask post-fix acceptance', () => {
    it('answers the client count before the lazily created deals table exists', async () => {
        createTestDB();
        Identity.ensureSchema();
        DB.run("INSERT INTO instances(id,name,hotelTimezone) VALUES (1,'Fresh business','Europe/Moscow')");
        DB.run("INSERT INTO ava_users(id,email,displayName) VALUES ('qa-postfix','qa@example.test','QA')");
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES ('qa-postfix',1,'hotel_owner')");
        const to = new Date();
        const range = { from: new Date(to.getTime() - 86400000).toISOString(), to: to.toISOString() };
        const app = await server();
        try {
            const result = await ask(app.url, 1, 'Сколько клиентов всего в CRM?', range);
            assert.equal(result.status, 200);
            assert.equal(result.body.grounded, false);
            assert.equal(result.body.answerStatus, 'empty');
        } finally { await app.close(); }
    });

    it('sends all-time client counts and historical tenant data through the model', async () => {
        const range = fixture();
        DB.run("INSERT INTO clients(instanceId,chatId,senderName,createdAt) VALUES (1,'historical-own','Own','2026-01-01T00:00:00Z'),(2,'foreign','FOREIGN_CLIENT_MARKER','2026-01-01T00:00:00Z')");
        await withMockModel(async requests => {
            const app = await server();
            try {
                const result = await ask(app.url, 1, 'Сколько клиентов всего в CRM?', range);
                assert.equal(result.status, 200);
                assert.equal(result.body.grounded, true);
                assert.equal(requests.length, 1);
                assert.ok(requests[0].facts.some(f => f.id === 'current:clients' && f.summary.includes('1 клиент')));
                assert.ok(!JSON.stringify(requests).includes('FOREIGN_CLIENT_MARKER'));
            } finally { await app.close(); }
        });
    });

    it('passes a real overdue deal signal with its linked client and exact source to Ask', async () => {
        const range = fixture();
        DB.run('INSERT INTO clients(instanceId,chatId,senderName,leadStatus,createdAt) VALUES (?,?,?,?,?)',
            [1, 'at-risk-client', 'Анна', 'qualified', '2026-01-01T00:00:00Z']);
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const deal = Deals.create(1, { title: 'Бронирование Анны', clientChatId: 'at-risk-client',
            stage: 'proposal', nextAction: 'Позвонить Анне', nextActionAt: yesterday });
        const clientId = DB.get("SELECT id FROM clients WHERE instanceId=1 AND chatId='at-risk-client'").id;
        const previousPost = axios.post;
        const previousConfig = { ...config.aiTunnel };
        config.aiTunnel.apiKey = 'qa-only-key';
        config.aiTunnel.apiUrl = 'https://qa-model.example.test/v1';
        config.aiTunnel.model = 'qa-model';
        let promptedFact;
        axios.post = async (_url, body) => {
            const prompt = JSON.parse(body.messages.find(message => message.role === 'user').content);
            promptedFact = prompt.facts.find(fact => fact.id === `intelligence:deal:${deal.id}`);
            assert.ok(promptedFact?.summary.includes('Просрочено следующее действие'));
            assert.ok(promptedFact.summary.includes('Клиент: Анна'));
            assert.ok(prompt.facts.some(fact => fact.id === `intelligence:client:${clientId}`));
            assert.ok(!JSON.stringify(prompt).includes('FOREIGN_DEAL_MARKER'));
            return { data: { choices: [{ message: { content: JSON.stringify({
                status: 'answered', answer: 'У сделки «Бронирование Анны» просрочено следующее действие. Свяжитесь с Анной.',
                sourceIds: [promptedFact.id, `intelligence:client:${clientId}`],
            }) } }] } };
        };
        const app = await server();
        try {
            const result = await ask(app.url, 1, 'Кто из клиентов рискует уйти?', range);
            assert.equal(result.status, 200);
            assert.equal(result.body.grounded, true);
            assert.ok(promptedFact);
            assert.ok(result.body.sources.some(source => source.type === 'customer_deal' && source.id === deal.id));
            assert.ok(result.body.sources.some(source => source.type === 'client' && source.id === String(clientId)));
            assert.ok(!/точно уйд[её]т|подтвержд[её]нный риск ухода/i.test(result.body.answer));
        } finally {
            await app.close();
            axios.post = previousPost;
            Object.assign(config.aiTunnel, previousConfig);
        }
    });

    it('rejects empty model templates and reports failed models without a synthetic successful fallback', async () => {
        const range = fixture();
        DB.run('INSERT INTO clients(instanceId,chatId,senderName,leadStatus,createdAt) VALUES (?,?,?,?,?)',
            [1, 'historical-own', 'Own', 'qualified', '2026-01-01T00:00:00Z']);
        DB.run('INSERT INTO clients(instanceId,chatId,senderName,leadStatus,createdAt) VALUES (?,?,?,?,?)',
            [2, 'historical-foreign', 'FOREIGN_CLIENT_MARKER', 'new', '2026-01-01T00:00:00Z']);
        const previousPost = axios.post;
        const previousConfig = { ...config.aiTunnel };
        config.aiTunnel.apiKey = 'qa-only-key';
        config.aiTunnel.apiUrl = 'https://qa-model.example.test/v1';
        config.aiTunnel.model = 'qa-model';
        const app = await server();
        try {
            axios.post = async () => ({ data: { choices: [{ message: { content: JSON.stringify({
                status: 'insufficient', answer: '', sourceIds: [],
            }) } }] } });
            const insufficient = await ask(app.url, 1, 'Как идёт мой бизнес?', range);
            assert.equal(insufficient.status, 503);
            assert.equal(insufficient.body.success, false);
            assert.equal(insufficient.body.code, 'DASHBOARD_MODEL_INVALID');
            assert.ok(!JSON.stringify(insufficient.body).includes('FOREIGN_CLIENT_MARKER'));

            axios.post = async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); };
            const timeout = await ask(app.url, 1, 'Как идёт мой бизнес?', range);
            assert.equal(timeout.status, 504);
            assert.equal(timeout.body.success, false);
            assert.equal(timeout.body.code, 'DASHBOARD_MODEL_TIMEOUT');
        } finally {
            await app.close();
            axios.post = previousPost;
            Object.assign(config.aiTunnel, previousConfig);
        }
    });

    it('sends distinct CRM questions to the model with only the selected tenant facts', async () => {
        const range = fixture();
        await withMockModel(async requests => {
            const app = await server();
            try {
                const churn = await ask(app.url, 1, 'Кто из клиентов рискует уйти?', range);
                const plan = await ask(app.url, 1, 'Составь план на день', range);
                assert.equal(churn.status, 200);
                assert.equal(plan.status, 200);
                assert.equal(requests.length, 2, 'both questions must reach the model');
                assert.notEqual(churn.body.answer, plan.body.answer);
                assert.equal(churn.body.grounded, true);
                assert.equal(churn.body.answerStatus, 'insufficient');
                assert.equal(plan.body.grounded, true);
                assert.ok(churn.body.sources.length > 0);
                assert.ok(plan.body.sources.some(source => source.id === 'qa-task-a'));
                assert.equal(requests[0].question, 'Кто из клиентов рискует уйти?');
                assert.equal(requests[1].question, 'Составь план на день');
                assert.ok(requests.every(prompt => !JSON.stringify(prompt).includes('FOREIGN_')
                    && !JSON.stringify(prompt).includes('qa-event-b')));
                assert.ok(!JSON.stringify([churn.body, plan.body]).includes('FOREIGN_'));
                assert.equal((await ask(app.url, 2, 'Кто из клиентов рискует уйти?', range)).status, 403);
            } finally { await app.close(); }
        });
    });

    it('refreshes the fact context and revision after a durable save in the same period', async () => {
        const range = fixture();
        await withMockModel(async requests => {
            const app = await server();
            try {
                const first = await ask(app.url, 1, 'Что изменилось в CRM?', range);
                assert.equal(first.status, 200);
                DB.run('INSERT INTO clients(instanceId,chatId,senderName,leadStatus,createdAt) VALUES (?,?,?,?,?)',
                    [1, 'qa-new-lead', 'Newly saved lead', 'new', range.at]);
                const saved = DB.get("SELECT id FROM clients WHERE instanceId=1 AND chatId='qa-new-lead'");
                const second = await ask(app.url, 1, 'Что изменилось в CRM?', range);
                assert.equal(second.status, 200);
                assert.equal(requests.length, 2, 'a changed source must trigger a new model call');
                assert.ok(requests[1].facts.some(fact => fact.id === `client:${saved.id}`));
                assert.notEqual(first.body.sourceRevision, second.body.sourceRevision);
            } finally { await app.close(); }
        });
    });

    it('rejects malformed model JSON and unknown citation IDs without leaking provider text', async () => {
        const range = fixture();
        const oldPost = axios.post;
        const oldConfig = { ...config.aiTunnel };
        config.aiTunnel.apiKey = 'qa-only-key';
        config.aiTunnel.apiUrl = 'https://qa-model.example.test/v1';
        config.aiTunnel.model = 'qa-model';
        const app = await server();
        try {
            for (const content of ['{bad json', JSON.stringify({ status: 'answered',
                answer: 'Выдуманный результат', sourceIds: ['other-tenant:secret'] })]) {
                axios.post = async () => ({ data: { choices: [{ message: { content } }],
                    raw_error: 'private-provider-detail' } });
                const result = await ask(app.url, 1, 'Что изменилось в CRM?', range);
                assert.equal(result.status, 503);
                assert.equal(result.body.success, false);
                assert.ok(!JSON.stringify(result.body).includes('private-provider-detail'));
            }
        } finally {
            await app.close();
            axios.post = oldPost;
            Object.assign(config.aiTunnel, oldConfig);
        }
    });

    it('does not mark an invented churn claim as grounded by an unrelated valid citation', async () => {
        const range = fixture();
        const oldPost = axios.post;
        const oldConfig = { ...config.aiTunnel };
        config.aiTunnel.apiKey = 'qa-only-key';
        config.aiTunnel.apiUrl = 'https://qa-model.example.test/v1';
        config.aiTunnel.model = 'qa-model';
        axios.post = async (_url, body) => {
            const prompt = JSON.parse(body.messages.find(message => message.role === 'user').content);
            const event = prompt.facts.find(fact => fact.id.includes('qa-event-a'));
            assert.ok(event, 'the harmless event must be available as an unrelated citation');
            return { data: { choices: [{ message: { content: JSON.stringify({ status: 'answered',
                answer: 'Иван точно уйдёт из-за конфликта с менеджером.', sourceIds: [event.id],
            }) } }] } };
        };
        const app = await server();
        try {
            const result = await ask(app.url, 1, 'Кто из клиентов рискует уйти?', range);
            assert.ok(result.status !== 200 || result.body.grounded !== true,
                'an irrelevant source ID cannot validate an invented risk assertion');
            assert.ok(!JSON.stringify(result.body).includes('FOREIGN_'));
        } finally {
            await app.close();
            axios.post = oldPost;
            Object.assign(config.aiTunnel, oldConfig);
        }
    });

    it('uses the same overnight boundary as the fact packet at 20:00 local time', () => {
        fixture();
        const now = new Date('2026-09-28T17:00:00.000Z');
        const Facts = require('../src/services/dashboard/facts');
        const modelWindow = AI.nightPeriod(1, now);
        const factsWindow = Facts.getFactPacket(1, { window: 'overnight', now }).window;
        assert.equal(modelWindow.from, factsWindow.start);
        assert.equal(modelWindow.to, factsWindow.endExclusive);
    });

    it('keeps a completed night report across reloads and later CRM updates', async () => {
        fixture();
        DB.run('INSERT INTO conversation_events(eventId,instanceId,channel,direction,role,content,createdAt) VALUES (?,?,?,?,?,?,?)',
            ['qa-night-first', 1, 'whatsapp', 'inbound', 'user', 'First night event', '2026-09-28T22:00:00Z']);
        await withFrozenTime('2026-09-29T02:00:00.000Z', async setNow => {
            await withMockModel(async requests => {
                const app = await server();
                try {
                    const first = await overview(app.url, 'overnight');
                    setNow('2026-09-29T02:01:00.000Z');
                    const second = await overview(app.url, 'overnight');
                    assert.equal(first.status, 200);
                    assert.equal(second.status, 200);
                    assert.equal(first.body.overview.generatedAt, second.body.overview.generatedAt);
                    assert.equal(requests.length, 1, 'clock progress alone must not make a paid model call');
                    DB.run('INSERT INTO conversation_events(eventId,instanceId,channel,direction,role,content,createdAt) VALUES (?,?,?,?,?,?,?)',
                        ['qa-night-second', 1, 'whatsapp', 'inbound', 'user', 'Second night event', '2026-09-29T01:30:00Z']);
                    setNow('2026-09-29T02:02:00.000Z');
                    const changed = await overview(app.url, 'overnight');
                    assert.equal(changed.status, 200);
                    assert.equal(changed.body.overview.generatedAt, first.body.overview.generatedAt);
                    assert.equal(requests.length, 1, 'saved events do not regenerate the completed report');
                    assert.equal(changed.body.overview.window.complete, true);
                } finally { await app.close(); }
            });
        });
    });

    it('serves concurrent night and yesterday summaries without a busy response', async () => {
        fixture();
        DB.run('INSERT INTO conversation_events(eventId,instanceId,channel,direction,role,content,createdAt) VALUES (?,?,?,?,?,?,?)',
            ['qa-yesterday', 1, 'whatsapp', 'inbound', 'user', 'Yesterday event', '2026-09-28T10:00:00Z']);
        DB.run('INSERT INTO conversation_events(eventId,instanceId,channel,direction,role,content,createdAt) VALUES (?,?,?,?,?,?,?)',
            ['qa-night-concurrent', 1, 'whatsapp', 'inbound', 'user', 'Night event', '2026-09-28T22:00:00Z']);
        await withFrozenTime('2026-09-29T02:00:00.000Z', async () => {
            await withMockModel(async requests => {
                const app = await server();
                try {
                    const [night, yesterday] = await Promise.all([
                        overview(app.url, 'overnight'), overview(app.url, 'yesterday'),
                    ]);
                    assert.equal(night.status, 200, JSON.stringify(night.body));
                    assert.equal(yesterday.status, 200, JSON.stringify(yesterday.body));
                    assert.equal(night.body.overview.grounded, true);
                    assert.equal(yesterday.body.overview.grounded, true);
                    assert.equal(requests.length, 2);
                } finally { await app.close(); }
            }, { delayMs: 40 });
        });
    });
    it('reports repeated HTTP200 truncation as a bounded explicit failure', async () => {
        const range = fixture();
        const oldPost = axios.post, oldConfig = { ...config.aiTunnel };
        config.aiTunnel.apiKey = 'qa-only-key'; config.aiTunnel.apiUrl = 'https://qa-model.example.test/v1';
        let requests = 0;
        axios.post = async () => { requests++; return { data: { choices: [{ finish_reason: 'length',
            message: { content: '{"status":"answered","answer":"partial' } }] } }; };
        const app = await server();
        try {
            const result = await ask(app.url, 1, 'Что произошло в CRM?', range);
            assert.equal(requests, 2);
            assert.equal(result.status, 502);
            assert.equal(result.body.success, false);
            assert.equal(result.body.code, 'DASHBOARD_MODEL_TRUNCATED');
            assert.equal(result.body.answer, undefined);
        } finally { await app.close(); axios.post = oldPost; Object.assign(config.aiTunnel, oldConfig); }
    });

});
