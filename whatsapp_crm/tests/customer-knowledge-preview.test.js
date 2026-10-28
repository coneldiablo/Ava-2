'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const express = require('express');
const axios = require('axios');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const DB = require('../src/services/database.service');
const crypto = require('crypto');

async function withServer(run) {
    const original = {
        post: axios.post, authorize: Identity.authorizeCapability, getSession: Auth.getSession,
        publicUrl: process.env.WHATSAPP_CRM_PUBLIC_URL,
        adminUrl: process.env.AVA_ADMIN_API_URL,
        token: process.env.CRM_SERVICE_API_TOKEN,
    };
    process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
    process.env.AVA_ADMIN_API_URL = 'http://admin.internal:3003';
    process.env.CRM_SERVICE_API_TOKEN = 'test-service-secret';
    Identity.authorizeCapability = (auth, businessId) => {
        if (!auth.userId?.startsWith('owner-') || businessId !== 7) {
            throw Object.assign(new Error('denied'), { statusCode: 403 });
        }
        return businessId;
    };
    Auth.getSession = req => req.auth;
    const routePath = require.resolve('../src/routes/customer-knowledge-preview.routes');
    delete require.cache[routePath];
    const routes = require(routePath);
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api', (req, _res, next) => {
        req.auth = { userId: req.get('X-Test-User') || `owner-${crypto.randomUUID()}` };
        next();
    });
    app.use('/api', routes);
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (businessId, body, headers = {}) => fetch(`${origin}/api/businesses/${businessId}/knowledge/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://ava.example.test', ...headers },
        body: JSON.stringify(body),
    });
    try { await run({ request, origin }); }
    finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        axios.post = original.post;
        Identity.authorizeCapability = original.authorize;
        Auth.getSession = original.getSession;
        for (const [key, value] of [
            ['WHATSAPP_CRM_PUBLIC_URL', original.publicUrl],
            ['AVA_ADMIN_API_URL', original.adminUrl],
            ['CRM_SERVICE_API_TOKEN', original.token],
        ]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

describe('Customer knowledge preview BFF', () => {
    it('returns only verified scoped answer fields and never exposes the service token or source URL', async () => {
        await withServer(async ({ request }) => {
            let call;
            axios.post = async (url, payload, options) => {
                call = { url, payload, options };
                return { data: {
                    business_id: 7, channel: 'whatsapp', correlation_id: payload.correlation_id,
                    preview: true, read_only: true, handled: true, grounded: true,
                    stale: false, customer_id: null, answer: 'Бассейн открыт до 22:00.',
                    source_timestamp: '2026-09-23T12:00:00Z',
                    citations: [{ source_id: 42, title: 'Услуги',
                        external_id: 'private-id', url: 'https://private.example', raw_error: 'secret' }],
                    provider: 'onyx', api_key: 'private-upstream-key',
                } };
            };
            const response = await request(7, { question: 'Когда закрывается бассейн?' });
            assert.equal(response.status, 200);
            const result = await response.json();
            assert.deepEqual(Object.keys(result), [
                'success', 'businessId', 'answer', 'citations', 'sourceTimestamp', 'correlationId',
            ]);
            assert.deepEqual(result.citations, [{ sourceId: 42, title: 'Услуги' }]);
            assert.equal(result.correlationId, call.payload.correlation_id);
            assert.deepEqual(Object.keys(call.payload), [
                'business_id', 'question', 'channel', 'correlation_id',
            ]);
            assert.equal(call.url, 'http://admin.internal:3003/api/internal/onyx/knowledge/preview');
            assert.equal(call.options.headers.Authorization, 'Bearer test-service-secret');
            assert.equal(call.options.timeout, 40000);
            assert.equal(call.options.signal.aborted, false);
            assert.equal(call.options.maxRedirects, 0);
            assert.ok(call.options.maxContentLength <= 128 * 1024);
            assert.ok(call.options.maxBodyLength <= 16 * 1024);
            assert.equal(JSON.stringify(result).includes('secret'), false);
            assert.equal(JSON.stringify(result).includes('private'), false);
        });
    });

    it('rejects cross-tenant access, CSRF, and browser-controlled scope or model fields before upstream', async () => {
        await withServer(async ({ request }) => {
            let calls = 0;
            axios.post = async () => { calls++; throw Error('should not call'); };
            assert.equal((await request(8, { question: 'Test' })).status, 403);
            assert.equal((await request(7, { question: 'Test' }, { Origin: 'https://evil.example' })).status, 403);
            assert.equal((await request(7, { question: 'Test' }, { Origin: '' })).status, 403);
            assert.equal((await request(7, { question: 'Test' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
            for (const extra of [
                { business_id: 8 }, { customer_id: 2 }, { tenant_id: 8 },
                { model: 'override' }, { channel: 'voice' }, { preview: false },
            ]) {
                assert.equal((await request(7, { question: 'Test', ...extra })).status, 400);
            }
            assert.equal((await request(7, { question: 'x'.repeat(2001) })).status, 400);
            assert.equal((await request(7, { question: '   ' })).status, 400);
            assert.equal(calls, 0);
        });
    });

    it('fails closed on outages and fabricated or incomplete upstream evidence', async () => {
        await withServer(async ({ request }) => {
            const valid = payload => ({ business_id: 7, channel: 'whatsapp',
                correlation_id: payload.correlation_id, preview: true, read_only: true,
                handled: true, grounded: true, stale: false, customer_id: null,
                answer: 'Verified answer', source_timestamp: '2026-09-23T12:00:00Z',
                citations: [{ source_id: 1, title: 'FAQ' }] });
            const mutations = [
                data => { data.business_id = 8; },
                data => { data.channel = 'voice'; },
                data => { data.correlation_id = 'forged'; },
                data => { data.preview = false; },
                data => { data.read_only = false; },
                data => { data.handled = false; },
                data => { data.error_code = 'ONYX_RUNTIME_TIMEOUT'; },
                data => { data.success = false; },
                data => { data.grounded = false; },
                data => { data.stale = true; },
                data => { data.customer_id = 12; },
                data => { data.citations = []; },
                data => { data.citations = [{ source_id: 1, title: null }]; },
                data => { data.source_timestamp = 'not a timestamp'; },
            ];
            for (const mutate of mutations) {
                axios.post = async (_url, payload) => {
                    const data = valid(payload); mutate(data); return { data };
                };
                const response = await request(7, { question: 'Question' });
                assert.equal(response.status, 503);
                assert.deepEqual(await response.json(), { success: false, code: 'PREVIEW_UNAVAILABLE' });
            }
            axios.post = async () => { throw Error('Authorization: Bearer test-service-secret; guest private'); };
            const outage = await request(7, { question: 'Question' });
            assert.equal(outage.status, 503);
            assert.deepEqual(await outage.json(), { success: false, code: 'PREVIEW_UNAVAILABLE' });
        });
    });

    it('shows only safe status codes for a matching runtime failure', async () => {
        await withServer(async ({ request }) => {
            axios.post = async (_url, payload) => ({ data: {
                business_id: 7, channel: 'whatsapp', correlation_id: payload.correlation_id,
                preview: true, read_only: true, handled: false, customer_id: null,
                error_code: 'ONYX_RUNTIME_UNGROUNDED', raw_error: 'Authorization: Bearer secret',
            } });
            const ungrounded = await request(7, { question: 'Question' });
            assert.equal(ungrounded.status, 503);
            assert.deepEqual(await ungrounded.json(), { success: false, code: 'PREVIEW_UNGROUNDED' });
            axios.post = async (_url, payload) => ({ data: {
                business_id: 7, channel: 'whatsapp', correlation_id: payload.correlation_id,
                preview: true, read_only: true, handled: false, customer_id: null,
                error_code: 'ONYX_RUNTIME_NOT_LIVE',
            } });
            const notReady = await request(7, { question: 'Question' });
            assert.equal(notReady.status, 503);
            assert.deepEqual(await notReady.json(), { success: false, code: 'PREVIEW_NOT_READY' });
            axios.post = async (_url, payload) => ({ data: {
                business_id: 7, channel: 'whatsapp', correlation_id: payload.correlation_id,
                preview: true, read_only: true, handled: false, customer_id: null,
                error_code: 'ONYX_RUNTIME_TIMEOUT',
            } });
            const timeout = await request(7, { question: 'Question' });
            assert.equal(timeout.status, 504);
            assert.deepEqual(await timeout.json(), { success: false, code: 'PREVIEW_TIMEOUT' });
        });
    });

    it('distinguishes empty, indexing and transport timeout without exposing upstream details', async () => {
        await withServer(async ({ request }) => {
            for (const state of ['EMPTY', 'INDEXING']) {
                axios.post = async (_url, payload) => ({ data: {
                    business_id: 7, channel: 'whatsapp', correlation_id: payload.correlation_id,
                    preview: true, read_only: true, handled: false, customer_id: null,
                    error_code: `ONYX_RUNTIME_${state}`, raw_error: 'private-source-text',
                } });
                const response = await request(7, { question: 'Question' });
                assert.equal(response.status, 409);
                assert.deepEqual(await response.json(), { success: false, code: `PREVIEW_${state}` });
            }
            axios.post = async () => { throw Object.assign(new Error('secret'), { code: 'ETIMEDOUT' }); };
            const response = await request(7, { question: 'Question' });
            assert.equal(response.status, 504);
            assert.deepEqual(await response.json(), { success: false, code: 'PREVIEW_TIMEOUT' });
        });
    });

    it('aborts the Onyx request when the browser cancels', async () => {
        await withServer(async ({ origin }) => {
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
            const pending = fetch(`${origin}/api/businesses/7/knowledge/preview`, {
                method: 'POST', signal: controller.signal,
                headers: { 'Content-Type': 'application/json', Origin: 'https://ava.example.test',
                    'X-Test-User': 'owner-cancel' },
                body: JSON.stringify({ question: 'Question' }),
            });
            await called;
            controller.abort();
            await assert.rejects(pending);
            await Promise.race([cancelled, new Promise((_resolve, reject) =>
                setTimeout(() => reject(Error('upstream not cancelled')), 1000))]);
        });
    });

    it('accepts verified sources with missing titles and adds a non-sensitive label', async () => {
        await withServer(async ({ request }) => {
            axios.post = async (_url, payload) => ({ data: {
                business_id: 7, channel: 'whatsapp', correlation_id: payload.correlation_id,
                preview: true, read_only: true, handled: true, grounded: true, stale: false,
                customer_id: null, answer: 'Verified answer',
                source_timestamp: '2026-09-23T12:00:00Z',
                citations: [{ source_id: 42, title: '' }],
            } });
            const response = await request(7, { question: 'Question' });
            assert.equal(response.status, 200);
            assert.deepEqual((await response.json()).citations, [{ sourceId: 42, title: 'Источник №42' }]);
        });
    });

    it('limits repeated requests by the same user before calling Onyx', async () => {
        await withServer(async ({ request }) => {
            let calls = 0;
            axios.post = async (_url, payload) => {
                calls += 1;
                return { data: { business_id: 7, channel: 'whatsapp',
                    correlation_id: payload.correlation_id, preview: true, read_only: true,
                    handled: false, customer_id: null, error_code: 'ONYX_RUNTIME_UNGROUNDED' } };
            };
            for (let index = 0; index < 4; index++) {
                assert.equal((await request(7, { question: 'Test' }, { 'X-Test-User': 'owner-rate' })).status, 503);
            }
            const limited = await request(7, { question: 'Test' }, { 'X-Test-User': 'owner-rate' });
            assert.equal(limited.status, 429);
            assert.deepEqual(await limited.json(), { success: false, code: 'PREVIEW_RATE_LIMITED' });
            assert.equal(calls, 4);
        });
    });

    it('accepts a same-host HTTPS origin through a reverse proxy', async () => {
        await withServer(async ({ request, origin }) => {
            axios.post = async (_url, payload) => ({ data: { business_id: 7,
                channel: 'whatsapp', correlation_id: payload.correlation_id,
                preview: true, read_only: true, handled: false, customer_id: null,
                error_code: 'ONYX_RUNTIME_NOT_LIVE' } });
            const response = await request(7, { question: 'Test' }, {
                'X-Forwarded-Proto': 'https', Origin: origin.replace('http://', 'https://'),
            });
            assert.equal(response.status, 503);
            assert.deepEqual(await response.json(), { success: false, code: 'PREVIEW_NOT_READY' });
        });
    });

    it('returns a cited current-document excerpt without waiting for Onyx when local search matches', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (7,'Own'),(8,'Foreign')");
        const own = DB.addKnowledgeBaseFile(7, 'rules.txt', 'Правила', 'local-test-7', 'text/plain', 80);
        await DB.addKnowledgeBaseChunks(own, ['Заезд с 14:00. Выезд до 12:00.']);
        const foreign = DB.addKnowledgeBaseFile(8, 'rules.txt', 'Чужое', 'local-test-8', 'text/plain', 80);
        await DB.addKnowledgeBaseChunks(foreign, ['Заезд с 09:00.']);
        await withServer(async ({ request }) => {
            let upstreamCalls = 0;
            axios.post = async () => { upstreamCalls++; throw Error('Onyx should not be called'); };
            delete process.env.CRM_SERVICE_API_TOKEN;
            delete process.env.AVA_ADMIN_API_URL;
            const response = await request(7, { question: 'Во сколько заезд?' });
            assert.equal(response.status, 200);
            const result = await response.json();
            assert.match(result.answer, /14:00/);
            assert.ok(!result.answer.includes('09:00'));
            assert.deepEqual(result.citations, [{ sourceId: own, title: 'Правила' }]);
            assert.equal(result.provenance, 'local_knowledge_extract');
            assert.equal(upstreamCalls, 0);
        });
    });

    it('checks semantic retrieval after a lexical miss and distinguishes no fact from a search outage', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (7,'Own'),(8,'Foreign')");
        const own = DB.addKnowledgeBaseFile(7, 'rules.txt', 'Правила', 'local-no-match-7', 'text/plain', 80);
        await DB.addKnowledgeBaseChunks(own, ['Заезд с 14:00. Выезд до 12:00.']);
        const foreign = DB.addKnowledgeBaseFile(8, 'prices.txt', 'Цены', 'local-no-match-8', 'text/plain', 80);
        await DB.addKnowledgeBaseChunks(foreign, ['Трансфер стоит 1000 рублей.']);
        await withServer(async ({ request }) => {
            let upstreamCalls = 0;
            axios.post = async (_url, payload) => {
                upstreamCalls++;
                return { data: {
                    business_id: 7, channel: 'whatsapp', correlation_id: payload.correlation_id,
                    preview: true, read_only: true, handled: false, customer_id: null,
                    error_code: 'ONYX_RUNTIME_UNGROUNDED',
                } };
            };
            const response = await request(7, { question: 'Сколько стоит трансфер?' });
            assert.equal(response.status, 503);
            assert.deepEqual(await response.json(), { success: false, code: 'PREVIEW_UNGROUNDED' });
            assert.equal(upstreamCalls, 1);
            axios.post = async () => { throw Error('private provider outage'); };
            const outage = await request(7, { question: 'Сколько стоит трансфер?' });
            assert.equal(outage.status, 503);
            assert.deepEqual(await outage.json(), { success: false, code: 'PREVIEW_UNAVAILABLE' });
        });
    });

    it('preserves the local fast hit and sends four ordinary paraphrases to bounded cited semantic retrieval', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (7,'Own'),(8,'Foreign')");
        const own = DB.addKnowledgeBaseFile(7, 'rules.txt', 'Правила', 'paraphrase-7', 'text/plain', 80);
        await DB.addKnowledgeBaseChunks(own, ['Выезд до 12:00. Для резервирования позвоните администратору.']);
        const foreign = DB.addKnowledgeBaseFile(8, 'rules.txt', 'Чужое', 'paraphrase-8', 'text/plain', 80);
        await DB.addKnowledgeBaseChunks(foreign, ['Выезд до 09:00.']);
        await withServer(async ({ request }) => {
            const questions = [
                'К какому часу следует освободить апартаменты?',
                'Когда нужно покинуть жилье?',
                'До какого времени разрешено оставаться в апартаментах?',
                'В какой час заканчивается проживание?',
            ];
            const calls = [];
            axios.post = async (_url, payload, options) => {
                calls.push(payload.question);
                assert.equal(payload.business_id, 7);
                assert.equal(options.timeout, 40000);
                assert.equal(options.signal.aborted, false);
                return { data: {
                    business_id: 7, channel: 'whatsapp', correlation_id: payload.correlation_id,
                    preview: true, read_only: true, handled: true, grounded: true,
                    stale: false, customer_id: null, answer: 'Выезд до 12:00.',
                    source_timestamp: '2026-10-15T09:00:00Z',
                    citations: [{ source_id: own, title: 'Правила' }],
                } };
            };
            const exact = await request(7, { question: 'Во сколько выезд?' });
            assert.equal(exact.status, 200);
            const expected = await exact.json();
            assert.match(expected.answer, /12:00/);
            assert.deepEqual(calls, []);
            for (const question of questions) {
                const response = await request(7, { question });
                assert.equal(response.status, 200);
                const result = await response.json();
                assert.equal(result.answer, 'Выезд до 12:00.');
                assert.deepEqual(result.citations, expected.citations);
            }
            assert.deepEqual(calls, questions);
        });
    });

    it('never turns a stale semantic answer or a revoked permission into an answer', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (7,'Own')");
        const own = DB.addKnowledgeBaseFile(7, 'rules.txt', 'Правила', 'semantic-stale-7', 'text/plain', 80);
        await DB.addKnowledgeBaseChunks(own, ['Выезд до 12:00.']);
        await withServer(async ({ request }) => {
            let revoked = false;
            axios.post = async (_url, payload) => ({ data: {
                business_id: 7, channel: 'whatsapp', correlation_id: payload.correlation_id,
                preview: true, read_only: true, handled: true, grounded: true,
                stale: true, customer_id: null, answer: 'Выезд до 12:00.',
                source_timestamp: '2026-10-15T09:00:00Z',
                citations: [{ source_id: own, title: 'Правила' }],
            } });
            const stale = await request(7, { question: 'Когда нужно покинуть жилье?' });
            assert.equal(stale.status, 503);
            assert.deepEqual(await stale.json(), { success: false, code: 'PREVIEW_UNAVAILABLE' });
            const originalAuthorize = Identity.authorizeCapability;
            Identity.authorizeCapability = (...args) => {
                if (revoked) throw Error('revoked');
                return originalAuthorize(...args);
            };
            const stalePost = axios.post;
            axios.post = async (...args) => {
                const result = await stalePost(...args);
                result.data.stale = false;
                revoked = true;
                return result;
            };
            const denied = await request(7, { question: 'Когда нужно покинуть жилье?' });
            assert.equal(denied.status, 403);
            assert.deepEqual(await denied.json(), { success: false, code: 'BUSINESS_ACCESS_DENIED' });
        });
    });

    it('keeps Onyx available when the tenant has no current local chunks', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (7,'Own'),(8,'Foreign')");
        const foreign = DB.addKnowledgeBaseFile(8, 'rules.txt', 'Чужое', 'foreign-only-8', 'text/plain', 80);
        await DB.addKnowledgeBaseChunks(foreign, ['Заезд с 09:00.']);
        await withServer(async ({ request }) => {
            let upstreamCalls = 0;
            axios.post = async (_url, payload) => {
                upstreamCalls++;
                return { data: {
                    business_id: 7, channel: 'whatsapp', correlation_id: payload.correlation_id,
                    preview: true, read_only: true, handled: true, grounded: true,
                    stale: false, customer_id: null, answer: 'Ответ из Onyx.',
                    source_timestamp: '2026-09-29T09:00:00Z',
                    citations: [{ source_id: 42, title: 'Onyx source' }],
                } };
            };
            const response = await request(7, { question: 'Во сколько заезд?' });
            assert.equal(response.status, 200);
            assert.equal((await response.json()).answer, 'Ответ из Onyx.');
            assert.equal(upstreamCalls, 1);
        });
    });

    it('keeps Onyx available when the local corpus exceeds the complete-scan bound', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (7,'Own')");
        const own = DB.addKnowledgeBaseFile(7, 'rules.txt', 'Большие правила',
            'over-limit-7', 'text/plain', 6000);
        await DB.addKnowledgeBaseChunks(own,
            Array.from({ length: 513 }, (_, index) => `Описание услуги номер ${index}.`));
        await withServer(async ({ request }) => {
            let upstreamCalls = 0;
            axios.post = async (_url, payload) => {
                upstreamCalls++;
                return { data: {
                    business_id: 7, channel: 'whatsapp', correlation_id: payload.correlation_id,
                    preview: true, read_only: true, handled: true, grounded: true,
                    stale: false, customer_id: null, answer: 'Ответ из Onyx.',
                    source_timestamp: '2026-09-29T09:00:00Z',
                    citations: [{ source_id: 42, title: 'Onyx source' }],
                } };
            };
            const response = await request(7, { question: 'Где парковка?' });
            assert.equal(response.status, 200);
            assert.equal((await response.json()).answer, 'Ответ из Onyx.');
            assert.equal(upstreamCalls, 1);
        });
    });
});
