'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Deals = require('../src/services/customer-deals.store');
const AI = require('../src/services/dashboard/ai');
const Model = require('../src/services/dashboard/ai.model');
function fixture() {
    createTestDB();
    DB.run("INSERT INTO instances(id,name,hotelTimezone) VALUES (1,'Own','Europe/Moscow'),(2,'Foreign','Europe/Moscow')");
    Deals.ensureSchema();
    DB.run("INSERT INTO clients(instanceId,chatId,senderName,createdAt) VALUES (1,'old','Historical customer','2026-01-01T00:00:00Z'),(2,'foreign','FOREIGN_SECRET','2026-01-01T00:00:00Z')");
}
async function model(fn) {
    const old = Model.generate;
    const calls = [];
    Model.generate = async request => {
        calls.push(request);
        const fact = request.rawFacts.find(f => f.id === 'current:clients') || request.rawFacts[0];
        const result = { answer: 'Подтверждённый AI ответ.', sources: [fact.source], grounded: true,
            answerStatus: 'answered', dataStatus: request.status, provenance: 'aitunnel_crm', generatedAt: new Date().toISOString() };
        Object.defineProperty(result, 'modelReceipt', { value: { selectedModel: 'selected-test', actualModel: 'fallback-test', fallbackUsed: true, attempts: 2 } });
        return result;
    };
    try { await fn(calls); } finally { Model.generate = old; }
}
describe('Dashboard AI historical context regressions', () => {
    it('sends historical business facts to AI for client, risk and plan questions with no events', async () => {
        fixture();
        await model(async calls => {
            for (const question of ['Сколько клиентов всего?', 'Кто требует внимания?', 'Составь план на день']) {
                const answer = await AI.ask(1, AI.period(), question);
                assert.equal(answer.provenance, 'aitunnel_crm');
                assert.equal(answer.answer, 'Подтверждённый AI ответ.');
                assert.equal(answer.modelReceipt.actualModel, 'fallback-test');
                assert.ok(!JSON.stringify(answer).includes('modelReceipt'));
            }
            assert.equal(calls.length, 3);
            assert.ok(calls.every(call => call.rawFacts.some(f => /Historical customer/.test(JSON.stringify(f)))));
            assert.ok(!JSON.stringify(calls).includes('FOREIGN_SECRET'));
        });
    });
    it('keeps AI enabled for an empty night when the business has historical records', async () => {
        fixture();
        await model(async calls => {
            const overview = await AI.overview(1, 'overnight');
            assert.equal(calls.length, 1);
            assert.equal(overview.outcome, 'Подтверждённый AI ответ.');
            assert.equal(overview.sources, undefined);
            assert.equal(overview.counts, undefined);
            assert.equal(overview.limitations, undefined);
            assert.equal(overview.modelReceipt.fallbackUsed, true);
            assert.ok(!JSON.stringify(overview).includes('fallback-test'));
            assert.ok(calls[0].rawFacts.some(f => f.id.startsWith('aggregate:messages:') && /0 сообщений/.test(f.summary)));
            assert.ok(!JSON.stringify(calls[0].rawFacts).includes('Historical customer'));
        });
    });
    it('grounds an empty reporting window in explicit zero counts instead of historical events', async () => {
        fixture();
        const Facts = require('../src/services/dashboard/facts');
        const Service = require('../src/services/ai.service');
        const old = Service.generatePlainText;
        const oldResolve = Service._resolveProviderConfig;
        Service._resolveProviderConfig = () => ({ provider: 'gemini', model: 'fixture-model', credentialRevision: 'fixture' });
        const seen = [];
        Service.generatePlainText = async (messages, _instance, options) => {
            const { facts } = JSON.parse(messages[1].content);
            seen.push(facts);
            const zero = facts.find(f => f.id.startsWith('aggregate:messages:'));
            assert.ok(zero, 'zero messages for the period must remain citable');
            assert.match(zero.summary, /За выбранное окно: 0 сообщений/);
            assert.ok(!JSON.stringify(facts).includes('FOREIGN_SECRET'));
            const raw = JSON.stringify({ status: 'answered',
                answer: 'В AVA за этот период сохранено 0 сообщений. Новых сообщений для обзора нет.',
                sourceIds: [zero.id] });
            options.validate(raw);
            return raw;
        };
        try {
            for (const kind of ['overnight', 'yesterday']) {
                const packet = Facts.getFactPacket(1, { window: kind, completeOnly: true });
                assert.equal(packet.facts.length, 0);
                // A missing source must never acquire an invented zero count.
                packet.sources.clients = { status: 'unavailable', count: null };
                packet.sources.lead_status_history = { status: 'partial', count: 0 };
                const answer = await AI.ask(1, { from: packet.window.start, to: packet.window.endExclusive },
                    'Что произошло за период?', { factWindow: kind, factPacket: packet });
                assert.equal(answer.grounded, true);
                assert.equal(answer.sources.length, 1);
                assert.match(answer.sources[0].id, /^aggregate:messages:/);
            }
            assert.equal(seen.length, 2);
            assert.ok(seen.every(facts => !facts.some(f => /^aggregate:(clients|lead_status_history):/.test(f.id))));
        } finally { Service.generatePlainText = old; Service._resolveProviderConfig = oldResolve; }
    });
    it('does not call AI for an objectively empty business or claim a successful grounded result', async () => {
        fixture();
        DB.run('DELETE FROM clients WHERE instanceId=1');
        await model(async calls => {
            const answer = await AI.ask(1, AI.period(), 'Как идёт мой бизнес?');
            const overview = await AI.overview(1, 'overnight');
            assert.equal(calls.length, 0);
            assert.equal(answer.answerStatus, 'empty');
            assert.equal(answer.grounded, false);
            assert.equal(overview.grounded, false);
        });
    });
    it('adds a deterministic total of deal amounts by currency without treating it as paid revenue', async () => {
        fixture();
        Deals.create(1, { title: 'A', amount: 120, currency: 'RUB' });
        Deals.create(1, { title: 'B', amount: 180, currency: 'RUB' });
        Deals.create(2, { title: 'Foreign', amount: 9999, currency: 'RUB' });
        await model(async calls => {
            await AI.ask(1, AI.period(), 'Какая сумма открытых сделок?');
            const total = calls[0].rawFacts.find(f => f.id === 'current:open-deal-amount:RUB');
            assert.ok(total);
            assert.match(total.summary, /300 RUB/);
            assert.match(total.summary, /не подтверждённая выручка/);
        });
    });
    it('keeps tool audit facts and diagnostics out of customer night summaries', async () => {
        fixture();
        const range = AI.nightPeriod(1);
        const at = new Date((Date.parse(range.from) + Date.parse(range.to)) / 2).toISOString();
        DB.run("INSERT INTO tool_runs(toolRunId,instanceId,toolName,status,createdAt) VALUES ('technical-tool',1,'qualify_lead','ok',?)", [at]);
        await model(async calls => {
            const overview = await AI.overview(1, 'overnight');
            assert.equal(calls.length, 1);
            assert.ok(calls[0].rawFacts.every(f => f.source.type !== 'tool_runs' && !f.id.startsWith('aggregate:tool_runs')));
            assert.ok(!JSON.stringify(calls).includes('qualify_lead'));
            assert.ok(!JSON.stringify(overview).includes('tool_runs'));
            assert.ok(!JSON.stringify(overview).includes('technical-tool'));
        });
    });

    it('shows only still-open cited records in the current attention block', async () => {
        fixture();
        DB.run("INSERT INTO manager_tasks(taskId,instanceId,chatId,summary,status,createdAt,updatedAt) VALUES ('open-task',1,'old','Связаться с клиентом','open','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),('done-task',1,'old','Уже выполненная задача','completed','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')");
        const old = Model.generate;
        Model.generate = async request => ({ answer: 'Текущая задача требует внимания.',
            sources: request.rawFacts.map(f => f.source), grounded: true,
            answerStatus: 'answered', generatedAt: new Date().toISOString() });
        try {
            const overview = await AI.overview(1, 'overnight');
            assert.equal(overview.attention.length, 1);
            assert.match(overview.attention[0], /Связаться с клиентом/);
            assert.ok(!overview.attention.some(text => text.includes('Уже выполненная')));
        } finally { Model.generate = old; }
    });

    it('preserves cited AI explanations for risk and plan questions when decisive signals are missing', async () => {
        fixture();
        const axios = require('axios');
        const config = require('../src/config');
        const oldPost = axios.post, oldConfig = { ...config.aiTunnel };
        config.aiTunnel.apiKey = 'synthetic-key';
        config.aiTunnel.apiUrl = 'https://model.example.test/v1';
        const calls = [];
        axios.post = async (_url, request) => {
            const input = JSON.parse(request.messages[1].content);
            calls.push(input);
            const known = input.facts.find(f => f.id === 'current:clients');
            const answer = input.question.includes('рискует уйти')
                ? 'В CRM есть 1 клиент. В предоставленных данных нет подтверждённых сигналов риска ухода; отсутствие сигнала не доказывает отсутствие риска.'
                : 'В CRM есть 1 клиент. Начните с проверки его обращения; подтверждённых сроков задач для плана на день в предоставленных данных нет.';
            return { data: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
                status: 'insufficient', answer, sourceIds: [known.id],
            }) } }] } };
        };
        try {
            for (const question of ['Кто из клиентов рискует уйти?', 'Составь план на день']) {
                const result = await AI.ask(1, AI.period(), question);
                assert.equal(result.answerStatus, 'insufficient');
                assert.equal(result.provenance, 'aitunnel_crm');
                assert.equal(result.grounded, true);
                assert.match(result.answer, /В CRM есть 1 клиент/);
                assert.ok(result.sources.length);
                assert.ok(!result.answer.includes('нет основания для ответа'));
            }
            assert.equal(calls.length, 2);
            assert.ok(!JSON.stringify(calls).includes('FOREIGN_SECRET'));
        } finally { axios.post = oldPost; Object.assign(config.aiTunnel, oldConfig); }
    });

    it('uses Russian task, client and deal labels in customer changes and attention', async () => {
        fixture();
        const window = require('../src/services/dashboard/facts').windowFor('overnight', new Date(), 'Europe/Moscow', true);
        const range = { from: window.start, to: window.endExclusive };
        const at = new Date((Date.parse(range.from) + Date.parse(range.to)) / 2).toISOString();
        DB.run("INSERT INTO manager_tasks(taskId,instanceId,chatId,summary,status,priority,createdAt,updatedAt) VALUES ('night-done',1,'old','Завершённая проверка','done','high',?,?),('night-open',1,'old','Связаться с клиентом','open','high',?,?)", [at,at,at,at]);
        DB.run("INSERT INTO clients(instanceId,chatId,senderName,leadStatus,createdAt) VALUES (1,'night-client','Новый клиент','qualified',?)", [at]);
        const deal = Deals.create(1, { title: 'Предложение клиенту', stage: 'proposal', nextAction: 'Проверить предложение' });
        DB.run('UPDATE customer_deals SET createdAt=?,updatedAt=? WHERE instanceId=1 AND id=?', [at,at,deal.id]);
        const old = Model.generate;
        Model.generate = async request => ({ answer: 'Задача завершена, открытая задача требует внимания.',
            sources: request.rawFacts.map(f => f.source), grounded: true, answerStatus: 'answered', generatedAt: new Date().toISOString() });
        try {
            const overview = await AI.overview(1, 'overnight');
            const body = JSON.stringify({ changes: overview.changes, attention: overview.attention });
            assert.ok(!/\b(?:done|high|open|qualified|proposal)\b/.test(body));
            assert.match(body, /выполнена/);
            assert.match(body, /высокий/);
            assert.match(body, /квалифицирован/);
            assert.match(body, /предложение/);
            assert.equal(overview.attention.length, 2);
            assert.ok(!overview.attention.some(text => text.includes('Завершённая проверка')));
            DB.run('UPDATE customer_deals SET revision=2 WHERE instanceId=1 AND id=?', [deal.id]);
            DB.run("INSERT INTO lead_status_history(instanceId,chatId,fromStatus,toStatus,createdAt) VALUES (1,'night-client','new','qualified',?)", [at]);
            const feed = AI.activity(1, new Date(range.to));
            const feedText = JSON.stringify(feed.items.map(({title,description}) => ({title,description})));
            assert.ok(!/\b(?:done|high|open|qualified|proposal)\b/.test(feedText));
            assert.ok(!feedText.includes('Предыдущий этап недоступен'));
            assert.match(feedText, /выполнена/);
            assert.match(feedText, /высокий/);
            assert.match(feedText, /квалифицирован/);

        } finally { Model.generate = old; }
    });

});
