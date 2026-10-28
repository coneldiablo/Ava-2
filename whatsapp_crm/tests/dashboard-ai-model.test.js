'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const config = require('../src/config');
const axios = require('axios');
const Model = require('../src/services/dashboard/ai.model');

const fact = { id: 'clients:1', summary: 'Создана запись клиента; текущий статус: new.',
    source: { type: 'clients', id: '1', occurredAt: '2026-09-28T21:00:00.000Z' } };

function args(businessId = 1) {
    return { businessId, question: 'Что произошло?',
        range: { from: '2026-09-28T20:00:00.000Z', to: '2026-09-29T09:00:00.000Z' },
        rawFacts: [fact], revision: `revision-${businessId}`, windowKind: 'overnight' };
}

async function withProvider(fn) {
    createTestDB();
    DB.run("INSERT INTO instances(id,name,yandexGptKey) VALUES (1,'A','tenant-a-key'),(2,'B','tenant-b-key')");
    const previousPost = axios.post;
    const previousKey = config.aiTunnel.apiKey;
    config.aiTunnel.apiKey = 'shared-test-key';
    try { return await fn(); }
    finally { axios.post = previousPost; config.aiTunnel.apiKey = previousKey; }
}

describe('Dashboard AI model evidence boundary', () => {
    it('regenerates rejected Gemini prose once with the same facts, validation and deadline', async () => withProvider(async () => {
        const AI = require('../src/services/ai.service'), previousResolve = AI._resolveProviderConfig, previousGenerate = AI.generatePlainText;
        AI._resolveProviderConfig = () => ({ provider: 'gemini', model: 'gemini-fixture', credentialRevision: 'fixture' });
        const calls = [];
        AI.generatePlainText = async (messages, _instance, options) => {
            calls.push({ system: messages[0].content, facts: messages[1].content, deadline: options.deadline });
            assert.equal(options.responseSchema.properties.sourceIds.minItems, 1);
            const raw = JSON.stringify({ status: 'answered', answer: fact.summary,
                sourceIds: [calls.length === 1 ? 'foreign-source' : fact.id] });
            options.validate(raw);
            options.onReceipt({ attempts: [{ model: 'gemini-fixture', status: 'answered' }] });
            return raw;
        };
        try {
            const answer = await Model.generate({ ...args(), revision: 'gemini-repair-once' });
            assert.equal(calls.length, 2); assert.equal(calls[0].deadline, calls[1].deadline);
            assert.equal(calls[0].facts, calls[1].facts); assert.notEqual(calls[0].system, calls[1].system);
            assert.equal(answer.grounded, true); assert.equal(answer.sources[0].id, '1');
            assert.deepStrictEqual(answer.modelReceipt.attempts.map(a => a.status), ['validation_failed', 'answered']);
            let failed = 0;
            AI.generatePlainText = async (_messages, _instance, options) => {
                failed++; options.validate(JSON.stringify({ status: 'answered', answer: fact.summary, sourceIds: ['foreign-source'] }));
            };
            await assert.rejects(Model.generate({ ...args(), revision: 'gemini-repair-fails-closed' }), e => e.code === 'DASHBOARD_MODEL_INVALID');
            assert.equal(failed, 2);
            let offline = 0;
            AI.generatePlainText = async () => { offline++; throw Object.assign(Error(), { code: 'AI_UNAVAILABLE' }); };
            await assert.rejects(Model.generate({ ...args(), revision: 'gemini-no-network-retry' }), e => e.code === 'DASHBOARD_MODEL_UNAVAILABLE');
            assert.equal(offline, 1);
        } finally { AI._resolveProviderConfig = previousResolve; AI.generatePlainText = previousGenerate; }
    }));
    it('accepts only cited facts and rejects fabricated numbers or source IDs', () => {
        const facts = Model.normalizeFacts([fact]);
        assert.deepStrictEqual(Model.validModelAnswer(JSON.stringify({ status: 'answered',
            answer: fact.summary, sourceIds: [fact.id] }), facts).sources[0].id, '1');
        assert.strictEqual(Model.validModelAnswer(JSON.stringify({ reply: JSON.stringify({ status: 'answered',
            answer: fact.summary, sourceIds: [fact.id] }) }), facts).grounded, true);
        for (const answer of [
            { status: 'answered', answer: 'Получено 99 лидов.', sourceIds: [fact.id] },
            { status: 'answered', answer: fact.summary, sourceIds: ['clients:other'] },
            { status: 'answered', answer: 'Иван точно уйдёт.', sourceIds: [fact.id] },
            { status: 'answered', answer: 'Иван может уйти.', sourceIds: [fact.id] },
            { status: 'insufficient', answer: 'Клиенты могут уйти.', sourceIds: [fact.id] },
            { status: 'answered', answer: 'Иван рискует уйти.', sourceIds: [fact.id] },
            { status: 'answered', answer: 'Вероятно, выручка вырастет.', sourceIds: [fact.id] },
        ]) assert.throws(() => Model.validModelAnswer(JSON.stringify(answer), facts),
            error => error.code === 'DASHBOARD_MODEL_INVALID');
        assert.throws(() => Model.validModelAnswer('{bad json', facts),
            error => error.code === 'DASHBOARD_MODEL_INVALID');
        assert.deepStrictEqual(Model.validModelAnswer(JSON.stringify({ status: 'insufficient',
            answer: '', sourceIds: [] }), facts),
        { answer: '', sources: [], grounded: false, answerStatus: 'insufficient' });
    });

    it('accepts completed grounded JSON with list numbering and equivalent numeric formatting', () => {
        const facts = Model.normalizeFacts([{ ...fact, summary: 'Открыто задач: 2. Выручка: 1200.50 рублей.' }]);
        const result = Model.validModelAnswer(JSON.stringify({ status: 'answered',
            answer: '1. Открыто 2 задачи.\n2. Выручка 1 200,5 рублей. Для точного итога используйте эти записи.', sourceIds: [fact.id] }), facts);
        assert.strictEqual(result.grounded, true);
        assert.throws(() => Model.validModelAnswer(JSON.stringify({ status: 'answered',
            answer: 'Выручка 1400 рублей.', sourceIds: [fact.id] }), facts), e => e.code === 'DASHBOARD_MODEL_INVALID');
    });

    it('retains diverse current context when window facts fill the bounded packet', () => {
        const events = Array.from({ length: 90 }, (_, i) => ({ ...fact, id: `event:${i}` }));
        const contexts = ['clients', 'manager_tasks', 'customer_deals'].flatMap(type => Array.from({ length: 25 }, (_, i) => ({
            id: `context:${type}:${i}`, summary: 'Контекст CRM: текущая запись.', source: { type, id: String(i) },
        })));
        const facts = Model.normalizeFacts([...events, ...contexts]);
        assert.strictEqual(facts.length, 80);
        assert.ok(facts.some(f => f.source.type === 'manager_tasks'));
        assert.ok(facts.some(f => f.source.type === 'customer_deals'));
    });

    it('rejects autonomous promises with valid citations while permitting human recommendations', () => {
        const facts = Model.normalizeFacts([fact]);
        for (const answer of ['Я отправлю сообщение.', 'Мы позвоним клиенту.', 'Мы запустим кампанию.', 'Мы оплатим счёт.', 'AVA создаст задачу.', 'АВА свяжется с клиентом.', 'АВА сама отправит сообщение.', 'Ассистент завтра отправит сообщение.', 'Я завтра обязательно позвоню клиенту.', 'Гарантирую успех.']) {
            assert.throws(() => Model.validModelAnswer(JSON.stringify({ status: 'answered', answer, sourceIds: [fact.id] }), facts), e => e.code === 'DASHBOARD_MODEL_INVALID');
        }
        assert.strictEqual(Model.validModelAnswer(JSON.stringify({ status: 'answered', answer: 'Рекомендуется позвонить клиенту. Создайте задачу.', sourceIds: [fact.id] }), facts).grounded, true);
    });

    it('accepts cited insufficient explanation and explicit unknown risk without inventing positive risk', () => {
        const facts = Model.normalizeFacts([fact]);
        const explanation = 'Известно, что создана запись клиента. В доступных данных нет подтверждённых сигналов риска ухода. Кого отнести к группе риска, пока неизвестно.';
        const result = Model.validModelAnswer(JSON.stringify({ status: 'insufficient', answer: explanation, sourceIds: [fact.id] }), facts);
        assert.strictEqual(result.answer, explanation); assert.strictEqual(result.grounded, true);
        assert.strictEqual(result.answerStatus, 'insufficient'); assert.strictEqual(result.sources[0].id, '1');
        for (const [answer, sourceIds] of [
            ['Нет подтверждённых сигналов риска оттока. Иван рискует уйти.', [fact.id]],
            ['Получено 99 клиентов.', [fact.id]],
            ['Известно, что создана запись клиента.', ['foreign-source']],
            ['АВА завтра отправит сообщение.', [fact.id]],
            ['Клиент в группе риска ухода.', [fact.id]],
            ['Клиент с риском ухода.', [fact.id]],
        ]) assert.throws(() => Model.validModelAnswer(JSON.stringify({ status: 'insufficient', answer, sourceIds }), facts), e => e.code === 'DASHBOARD_MODEL_INVALID');
    });

    it('allows explicit unknown forecast caveats and rejects risk supported only by a disclaimer', () => {
        const facts = Model.normalizeFacts([fact]);
        for (const answer of ['Для прогноза недостаточно данных.', 'Прогноз ухода не подтверждён.', 'Определить риск ухода по этим данным нельзя.', 'Риск ухода оценить нельзя.', 'Определить клиентов с риском ухода по этим данным нельзя.', 'По этим данным определить риск ухода клиентов нельзя. В CRM создана запись клиента.']) {
            assert.strictEqual(Model.validModelAnswer(JSON.stringify({ status: 'answered', answer, sourceIds: [fact.id] }), facts).grounded, true);
        }
        const disclaimers = Model.normalizeFacts([{ ...fact, summary: 'Текущий статус не доказывает риск ухода.' }]);
        assert.throws(() => Model.validModelAnswer(JSON.stringify({ status: 'answered', answer: 'Иван рискует уйти.', sourceIds: [fact.id] }), disclaimers), e => e.code === 'DASHBOARD_MODEL_INVALID');
    });

    it('accepts the exact negative forecast/group-risk caveat without erasing other unsupported positive claims', () => {
        const facts = Model.normalizeFacts([fact]);
        const caveat = 'По данным CRM прогноз и группу риска установить невозможно.';
        const payload = answer => JSON.stringify({ status: 'answered', answer, sourceIds: [fact.id] });
        assert.strictEqual(Model.validModelAnswer(payload(caveat), facts).grounded, true);
        for (const answer of [caveat + ' Иван рискует уйти.', 'Прогноз: клиент уйдёт, но недостаточно данных.', 'Вероятно, выручка вырастет.']) {
            assert.throws(() => Model.validModelAnswer(payload(answer), facts), e => e.code === 'DASHBOARD_MODEL_INVALID');
        }
    });

    it('rejects contradictory churn after the exact unknown-risk caveat even with generic cited risk evidence', () => {
        const facts = Model.normalizeFacts([{ ...fact, summary: 'У клиента отмечен общий риск: есть жалоба.' }]);
        assert.strictEqual(Model.validModelAnswer(JSON.stringify({ status: 'answered',
            answer: 'Определить, кто именно из клиентов рискует уйти, по этим данным нельзя — прогноз и группу риска установить невозможно.', sourceIds: [fact.id] }), facts).grounded, true);
        for (const claim of ['Клиент уйдёт.', 'Клиент может уйти.', 'Клиент рискует уйти.']) {
            assert.throws(() => Model.validModelAnswer(JSON.stringify({ status: 'answered',
                answer: 'Прогноз и группу риска установить невозможно. ' + claim, sourceIds: [fact.id] }), facts), e => e.code === 'DASHBOARD_MODEL_INVALID');
        }
    });

    it('preserves grounded insufficient status and AITunnel provenance through generation', async () => withProvider(async () => {
        const answer = 'Создана запись клиента. В доступных данных нет подтверждённых сигналов риска оттока.';
        axios.post = async (_, body) => {
            assert.ok(body.messages[0].content.includes('коротким непустым answer'));
            return { data: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ status: 'insufficient', answer, sourceIds: [fact.id] }) } }] } };
        };
        const result = await Model.generate({ ...args(), revision: 'insufficient-explanation', question: 'Кто из клиентов рискует уйти?', windowKind: null });
        assert.strictEqual(result.answer, answer); assert.strictEqual(result.answerStatus, 'insufficient');
        assert.strictEqual(result.provenance, 'aitunnel_crm'); assert.strictEqual(result.grounded, true);
    }));

    it('grounds localized UTC dates and clocks in cited timestamps, summary dates or trusted reporting range', () => {
        const facts = Model.normalizeFacts([{ ...fact, summary: 'Создана запись клиента. Срок задачи: 2026-10-03.' }]);
        const range = { from: '2026-09-30T21:00:00.000Z', to: '2026-10-01T09:00:00.000Z' };
        for (const answer of ['Окно: 30.09 21:00 — 01.10 09:00. Создана запись клиента.', 'Запись создана 28.09.2026 в 21:00. Срок задачи 2026-10-03.', 'Запись создана 28 сентября.']) {
            assert.strictEqual(Model.validModelAnswer(JSON.stringify({ status: 'answered', answer, sourceIds: [fact.id] }), facts, { range }).grounded, true);
        }
        for (const answer of ['Событие произошло 02.10.2026.', 'Событие произошло в 22:33.', 'Получено 2026 клиентов.']) {
            assert.throws(() => Model.validModelAnswer(JSON.stringify({ status: 'answered', answer, sourceIds: [fact.id] }), facts, { range }), e => e.code === 'DASHBOARD_MODEL_INVALID');
        }
    });

    it('keeps an ambiguous supported decimal as a business number without accepting date components as counts', () => {
        const facts = Model.normalizeFacts([{ ...fact, summary: 'Подтверждённый показатель: 3.05. Срок задачи: 2026-10-03.' }]);
        assert.strictEqual(Model.validModelAnswer(JSON.stringify({ status: 'answered', answer: 'Подтверждённый показатель: 3.05.', sourceIds: [fact.id] }), facts).grounded, true);
        assert.throws(() => Model.validModelAnswer(JSON.stringify({ status: 'answered', answer: 'Получено 2026 клиентов.', sourceIds: [fact.id] }), facts), e => e.code === 'DASHBOARD_MODEL_INVALID');
    });

    it('rejects forged date-time combinations and date identifier suffixes while allowing labeled ranges', () => {
        const facts = Model.normalizeFacts([{ ...fact, source: { ...fact.source, occurredAt: '2026-09-30T10:00:00.000Z' } },
            { ...fact, id: 'synthetic:other', source: { ...fact.source, occurredAt: '2026-09-29T21:00:00.000Z' } }]);
        const payload = answer => JSON.stringify({ status: 'answered', answer, sourceIds: facts.map(f => f.id) });
        const range = { from: '2026-09-30T21:00:00.000Z', to: '2026-10-01T09:00:00.000Z' };
        for (const answer of ['Событие 30.09 21:00.', 'Событие 2026-10-01abc.']) assert.throws(() => Model.validModelAnswer(payload(answer), facts, { range }), e => e.code === 'DASHBOARD_MODEL_INVALID');
        assert.strictEqual(Model.validModelAnswer(payload('Окно: 30.09 21:00 — 01.10 09:00. Создана запись клиента.'), facts, { range }).grounded, true);
        assert.strictEqual(Model.validModelAnswer(payload('Событие 30.09 10:00. Создана запись клиента.'), facts, { range }).grounded, true);
        assert.strictEqual(Model.validModelAnswer(payload('30.09 21:00 — 01.10 09:00. Создана запись клиента.'), facts, { range }).grounded, true);
    });

    it('grounds full ISO timestamps before date identifier checks and excludes ISO calendar digits from metrics', () => {
        const facts = Model.normalizeFacts([{ ...fact, summary: 'Создана запись клиента. Время записи: 2026-10-01T09:00:00Z.', source: { ...fact.source, occurredAt: '2026-10-01T09:00:00.000Z' } }]);
        const payload = answer => JSON.stringify({ status: 'answered', answer, sourceIds: [fact.id] });
        assert.strictEqual(Model.validModelAnswer(payload('Событие произошло 2026-10-01T09:00:00Z.'), facts).grounded, true);
        assert.strictEqual(Model.validModelAnswer(payload('Событие произошло 2026-10-01T12:00:00+03:00.'), facts).grounded, true);
        for (const answer of ['Событие 2026-10-01abc.', 'Событие 2026-10-01T10:00:00Z.', 'Событие 2026-09-30T09:00:00Z.', 'Получено 2026 клиентов.']) {
            assert.throws(() => Model.validModelAnswer(payload(answer), facts), e => e.code === 'DASHBOARD_MODEL_INVALID');
        }
    });

    it('accepts bounded thirteen valid citations and rejects unknown or excessive citations', () => {
        const facts = Model.normalizeFacts(Array.from({ length: 21 }, (_, i) => ({ ...fact, id: `synthetic:${i}` })));
        const answer = 'В CRM есть подтверждённые записи клиентов; вывод ограничен доступными фактами.';
        assert.strictEqual(Model.validModelAnswer(JSON.stringify({ status: 'answered', answer, sourceIds: facts.slice(0, 13).map(f => f.id) }), facts).sources.length, 13);
        assert.throws(() => Model.validModelAnswer(JSON.stringify({ status: 'answered', answer, sourceIds: facts.map(f => f.id) }), facts), e => e.code === 'DASHBOARD_MODEL_INVALID');
    });

    it('optionally discards whole unsupported numeric sentences and revalidates actual remaining AI text', () => {
        const facts = Model.normalizeFacts([fact]);
        const retained = 'Создана запись клиента; подтверждён текущий статус. Для оценки результатов продаж пока недостаточно данных.';
        const payload = answer => JSON.stringify({ status: 'answered', answer, sourceIds: [fact.id] });
        assert.throws(() => Model.validModelAnswer(payload('Получено 99 клиентов. ' + retained), facts), e => e.code === 'DASHBOARD_MODEL_INVALID');
        const options = { allowNumericSentencePruning: true };
        const repaired = Model.validModelAnswer(payload('Получено 99 клиентов. ' + retained), facts, options);
        assert.strictEqual(repaired.answer, retained); assert.strictEqual(repaired.answerStatus, 'insufficient');
        assert.throws(() => Model.validModelAnswer(payload('Получено 99 клиентов.'), facts, options), e => e.code === 'DASHBOARD_MODEL_INVALID');
        assert.throws(() => Model.validModelAnswer(payload('Получено 99 клиентов. Иван рискует уйти. ' + retained), facts, options), e => e.code === 'DASHBOARD_MODEL_INVALID');
        assert.throws(() => Model.validModelAnswer(payload('Получено 99 клиентов. АВА завтра отправит сообщение. ' + retained), facts, options), e => e.code === 'DASHBOARD_MODEL_INVALID');
    });

    it('uses each business credential and cites only its supplied facts', async () => withProvider(async () => {
        const headers = [];
        axios.post = async (_url, body, options) => {
            headers.push(options.headers.Authorization);
            const facts = JSON.parse(body.messages[1].content).facts;
            assert.deepStrictEqual(facts.map(row => row.id), [fact.id]);
            assert.ok(body.max_tokens >= 4096);
            if (body.response_format) assert.strictEqual(body.response_format.type, 'json_object');
            return { data: { choices: [{ message: { content: JSON.stringify({ status: 'answered',
                answer: facts[0].summary, sourceIds: [facts[0].id] }) } }] } };
        };
        const a = await Model.generate(args(1));
        const b = await Model.generate(args(2));
        assert.deepStrictEqual(headers, ['Bearer tenant-a-key', 'Bearer tenant-b-key']);
        assert.strictEqual(a.grounded, true);
        assert.strictEqual(b.grounded, true);
        assert.notStrictEqual(a.sourceRevision, b.sourceRevision);
    }));

    it('falls back from invalid selected-model JSON with identical tenant facts and internal-only model receipt', async () => withProvider(async () => {
        DB.run("UPDATE instances SET yandexGptModelUri='mimo-v2.6-pro' WHERE id=1");
        const previousModel = config.aiTunnel.model; config.aiTunnel.model = 'gpt-oss-120b';
        const calls = [];
        axios.post = async (_, body, options) => {
            calls.push(body); assert.strictEqual(options.headers.Authorization, 'Bearer tenant-a-key');
            const facts = JSON.parse(body.messages[1].content).facts;
            assert.deepStrictEqual(facts.map(f => f.id), [fact.id]);
            return { data: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ status: 'answered', answer: fact.summary,
                sourceIds: [calls.length === 1 ? 'foreign-source' : fact.id] }) } }] } };
        };
        try {
            const result = await Model.generate({ ...args(), revision: 'invalid-selected-fallback', windowKind: null });
            assert.deepStrictEqual(calls.map(body => body.model), ['mimo-v2.6-pro', 'gpt-oss-120b']);
            assert.deepStrictEqual(calls[0].messages, calls[1].messages);
            assert.strictEqual(result.modelReceipt.actualModel, 'gpt-oss-120b');
            assert.strictEqual(JSON.stringify(result).includes('modelReceipt'), false);
            assert.strictEqual(DB.get('SELECT yandexGptModelUri FROM instances WHERE id=1').yandexGptModelUri, 'mimo-v2.6-pro');
        } finally { config.aiTunnel.model = previousModel; }
    }));

    it('falls back for empty model templates when confirmed facts exist and retains useful insufficient explanations', async () => withProvider(async () => {
        DB.run("UPDATE instances SET yandexGptModelUri='mimo-v2.6-pro' WHERE id=1");
        const previousModel = config.aiTunnel.model; config.aiTunnel.model = 'gpt-oss-120b'; let calls = 0;
        axios.post = async () => {
            calls++;
            const result = calls === 1 ? { status: 'insufficient', answer: '', sourceIds: [] }
                : { status: 'insufficient', answer: 'В CRM создана запись клиента; для оценки результата пока недостаточно данных.', sourceIds: [fact.id] };
            return { data: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] } };
        };
        try {
            const result = await Model.generate({ ...args(), revision: 'empty-primary-template-fallback', windowKind: null });
            assert.strictEqual(calls, 2); assert.strictEqual(result.grounded, true);
            assert.strictEqual(result.answerStatus, 'insufficient'); assert.strictEqual(result.modelReceipt.fallbackUsed, true);
        } finally { config.aiTunnel.model = previousModel; }
    }));

    it('reports provider timeout without claiming a generated answer', async () => withProvider(async () => {
        axios.post = async () => { throw Object.assign(new Error('secret upstream detail'), { code: 'ETIMEDOUT' }); };
        await assert.rejects(Model.generate({ ...args(), revision: 'timeout-test' }),
            error => error.code === 'DASHBOARD_MODEL_TIMEOUT' && error.statusCode === 504
                && !error.message.includes('secret'));
    }));

    it('allows two overview windows and an Ask while deduplicating identical requests', async () => withProvider(async () => {
        const releases = [];
        axios.post = (_url, body) => new Promise(resolve => {
            const { facts } = JSON.parse(body.messages[1].content);
            releases.push(() => resolve({ data: { choices: [{ message: { content: JSON.stringify({
                status: 'answered', answer: facts[0].summary, sourceIds: [facts[0].id],
            }) } }] } }));
        });
        const one = { ...args(), revision: 'concurrent-one' };
        const two = { ...args(), revision: 'concurrent-two', windowKind: 'yesterday' };
        const three = { ...args(), revision: 'concurrent-three', question: 'Что со сделками?', windowKind: null };
        const first = Model.generate(one);
        const repeated = Model.generate(one);
        const second = Model.generate(two);
        const ask = Model.generate(three);
        assert.strictEqual(releases.length, 3);
        releases.forEach(release => release());
        const answers = await Promise.all([first, repeated, second, ask]);
        assert.ok(answers.every(answer => answer.grounded));
        assert.strictEqual(answers[0].generatedAt, answers[1].generatedAt);
    }));

    it('does not call a provider for an empty or unavailable fact packet', async () => withProvider(async () => {
        axios.post = async () => { throw new Error('provider should not be called'); };
        const empty = await Model.generate({ ...args(), rawFacts: [] });
        const unavailable = await Model.generate({ ...args(), status: 'unavailable' });
        assert.strictEqual(empty.grounded, false);
        assert.strictEqual(empty.dataStatus, 'empty');
        assert.strictEqual(unavailable.dataStatus, 'unavailable');
    }));
});
