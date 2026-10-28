const express = require('express');
const axios = require('axios');
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const HotelProfileService = require('../src/services/hotel-profile.service');
const RAGService = require('../src/services/rag.service');
const SalesBrain = require('../src/services/sales-brain.service');
const config = require('../src/config');
const mlRouter = require('../src/routes/ml.routes');

function disableExternalRagServices() {
    config.rag.hydeEnabled = false;
    config.cohere.rerankingEnabled = false;
    config.rag.minConfidence = 0.05;
    RAGService.embeddingsInitialized = true;
    RAGService.embeddingsAvailable = false;
    RAGService.vectorSearchAvailable = false;
}

async function uploadText(instanceId, name, text) {
    const result = await RAGService.processDocument(
        instanceId,
        Buffer.from(text, 'utf8'),
        name,
        'text/markdown'
    );
    assert.strictEqual(result.success, true, result.error);
    return result;
}

async function withMlServer(fn) {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/ml', mlRouter);

    const server = await new Promise((resolve) => {
        const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    const address = server.address();
    const baseUrl = `http://${address.address}:${address.port}/api/ml`;

    try {
        return await fn(baseUrl);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

describe('Hotel Knowledge Base MVP', () => {
    it('prefers the room inventory section for room category questions', () => {
        const selection = RAGService._selectAnswerChunk([
            {
                id: 1,
                section: 'Цены',
                text: 'Цены зависят от даты, категории номера и выбранного тарифа.',
                combinedScore: 0.9,
            },
            {
                id: 2,
                section: 'Номерной фонд',
                text: `${'Общие сведения о ценах. '.repeat(12)} Какая категория номера вас интересует? У нас есть Стандарт, Комфорт, Семейный комфорт, Люкс и Президентский люкс.`,
                combinedScore: 0.6,
            },
        ], 'Какие категории номеров есть в отеле?');

        assert.strictEqual(selection.result.id, 2);
        const snippet = RAGService._voiceSnippet(selection, 420);
        assert.ok(snippet.includes('Стандарт'));
        assert.ok(!snippet.startsWith('Общие сведения о ценах'));
    });

    it('uses hotel vocabulary aliases instead of returning an unrelated chunk', () => {
        const selection = RAGService._selectAnswerChunk([
            { id: 1, text: 'При бронировании уточните дату заезда и категорию номера.', combinedScore: 0.9 },
            { id: 2, text: '| Заезд / Выезд | 14:00 / 12:00 |', combinedScore: 0.5 },
        ], 'Во сколько заселение?');

        assert.strictEqual(selection.result.id, 2);
        assert.ok(selection.matchedTokens.includes('заезд'));
        assert.ok(RAGService._voiceSnippet(selection, 420).includes('14:00'));
        assert.ok(RAGService._expandSearchQuestion('Во сколько заселение?').includes('заезд'));
        assert.ok(RAGService._expandSearchQuestion('Во сколько заселение?').includes('выезд'));
    });
    it('does not treat a high retrieval rank as evidence for an unrelated hotel question', async () => {
        const original = RAGService.runSearchPipeline;
        RAGService.runSearchPipeline = async () => ({ responseTimeMs: 1, effectiveResults: [{
            id: 1, kbId: 1, combinedScore: 0.98, originalName: 'hotel.md',
            section: 'Частые вопросы об отеле', text: 'Наш отель не подаёт алкоголь. Можно заказать безалкогольные напитки.',
        }] });
        try {
            for (const question of ['Есть ли в отеле обсерватория с телескопом?', 'Можно ли приехать на конференцию астрономов?']) {
                const result = await RAGService.answerFromKnowledge(1, question);
                assert.strictEqual(result.confidence, 0);
                assert.deepStrictEqual(result.citations, []);
                assert.deepStrictEqual(result.missing_info, [question]);
                assert.strictEqual(result.manager_task_created, false);
                assert.ok(!result.answer.includes('алкоголь'));
            }
        } finally { RAGService.runSearchPipeline = original; }
    });

    it('extracts the requested fact without adjacent prices/scripts and supports pet synonyms', async () => {
        const original = RAGService.runSearchPipeline;
        RAGService.runSearchPipeline = async () => ({ responseTimeMs: 1, effectiveResults: [{
            id: 1, kbId: 1, combinedScore: 0.9, originalName: 'hotel.md',
            text: 'Отель не подаёт алкоголь. Размещение с животными запрещено.\n#### Цены и акции\nСтоимость от 3 000 рублей.\nВсегда отправляй клиента менеджеру.',
        }] });
        try {
            for (const question of ['Можно ли с домашним животным?', 'Можно ли с собакой?', 'Можно ли приехать с кошкой?']) {
                const result = await RAGService.answerFromKnowledge(1, question);
                assert.strictEqual(result.answer, 'Размещение с животными запрещено.');
                assert.strictEqual(result.requires_manager, false);
                assert.strictEqual(result.citations.length, 1);
            }
        } finally { RAGService.runSearchPipeline = original; }
    });

    it('extracts table check-in facts without assuming a specific hotel check-in time', async () => {
        const original = RAGService.runSearchPipeline;
        RAGService.runSearchPipeline = async () => ({ responseTimeMs: 1, effectiveResults: [{
            id: 1, kbId: 1, combinedScore: 0.9, originalName: 'hotel.md',
            text: '| Год постройки | 2023 |\n| Заезд / Выезд | 16:00 / 11:00 |\n| Этажность | 3 этажа |',
        }] });
        try {
            const result = await RAGService.answerFromKnowledge(1, 'Во сколько заезд и выезд?');
            assert.strictEqual(result.answer, 'Заезд / Выезд: 16:00 / 11:00');
            assert.strictEqual(result.requires_manager, false);
        } finally { RAGService.runSearchPipeline = original; }
    });

    it('should answer the same hotel question from separate tenant knowledge bases', async () => {
        createTestDB();
        disableExternalRagServices();

        const hotelA = await HotelProfileService.create({ name: 'Hotel Alpha', hotelTimezone: 'Europe/Moscow' });
        const hotelB = await HotelProfileService.create({ name: 'Hotel Beta', hotelTimezone: 'Europe/Moscow' });

        await uploadText(hotelA.id, 'alpha.md', `
# Hotel Alpha
Завтрак в Hotel Alpha проходит с 07:00 до 10:00 в ресторане Alpha Hall.
Трансфер Hotel Alpha стоит 2500 рублей и бронируется заранее через администратора.
Парковка Hotel Alpha находится у северного входа и стоит 700 рублей в сутки.
        `);
        await uploadText(hotelB.id, 'beta.md', `
# Hotel Beta
Завтрак в Hotel Beta проходит с 09:00 до 12:00 на террасе Beta Terrace.
Трансфер Hotel Beta стоит 3900 рублей и требует номер рейса гостя.
Парковка Hotel Beta находится на подземном уровне и стоит 1100 рублей в сутки.
        `);

        const alphaAnswer = await SalesBrain.answerFromKnowledge({
            instanceId: hotelA.id,
            question: 'Во сколько завтрак?'
        });
        const betaAnswer = await SalesBrain.answerFromKnowledge({
            instanceId: hotelB.id,
            question: 'Во сколько завтрак?'
        });

        assert.strictEqual(alphaAnswer.knowledgeBaseInstanceId, hotelA.id);
        assert.strictEqual(betaAnswer.knowledgeBaseInstanceId, hotelB.id);
        assert.ok(alphaAnswer.answer.includes('07:00'));
        assert.ok(betaAnswer.answer.includes('09:00'));
        assert.notStrictEqual(alphaAnswer.answer, betaAnswer.answer);
    });

    it('should not fallback to another hotel knowledge base when current hotel has no answer', async () => {
        createTestDB();
        disableExternalRagServices();

        const hotelA = await HotelProfileService.create({ name: 'Hotel A', hotelTimezone: 'UTC' });
        const hotelB = await HotelProfileService.create({ name: 'Hotel B', hotelTimezone: 'UTC' });

        await uploadText(hotelA.id, 'hotel-a.md', `
# Hotel A
Завтрак подается с 07:00 до 10:00. Заезд начинается в 15:00, выезд до 12:00.
Парковка доступна у главного входа. Wi-Fi бесплатный на всей территории отеля.
        `);
        await uploadText(hotelB.id, 'hotel-b.md', `
# Hotel B
Обсерватория Hotel B открыта на крыше с 21:00 до 23:00 и стоит 95000 рублей за приватное бронирование.
Для приватной обсерватории нужен паспорт гостя и подтверждение службы безопасности.
        `);

        const answer = await SalesBrain.answerFromKnowledge({
            instanceId: hotelA.id,
            question: 'Сколько стоит приватная обсерватория?'
        });

        assert.strictEqual(answer.knowledgeBaseInstanceId, hotelA.id);
        assert.strictEqual(answer.should_handoff, false);
        assert.strictEqual(answer.requires_manager, false);
        assert.strictEqual(answer.manager_task_created, false);
        assert.strictEqual(answer.confidence, 0);
        assert.deepStrictEqual(answer.citations, []);
        assert.ok(!answer.answer.includes('95000'));
    });

    it('should upload text through hotel profile endpoint into knowledgeBaseInstanceId scope', async () => {
        createTestDB();
        disableExternalRagServices();

        const other = await DB.createInstance({ name: 'Other hotel' });
        const hotel = await HotelProfileService.create({
            name: 'Scoped Hotel',
            hotelTimezone: 'UTC'
        });

        await withMlServer(async (baseUrl) => {
            const upload = await axios.post(`${baseUrl}/hotel-profiles/${hotel.id}/knowledge-base/text`, {
                title: 'scoped-hotel-kb',
                text: `
# Scoped Hotel
Завтрак Scoped Hotel проходит с 06:30 до 10:30 в ресторане Scope.
Трансфер Scoped Hotel стоит 3100 рублей и подтверждается менеджером.
Wi-Fi бесплатный, правила проживания выдаются гостю при заселении.
                `
            });
            assert.strictEqual(upload.status, 200);
            assert.strictEqual(upload.data.knowledgeBaseInstanceId, hotel.id);

            const hotelDocs = await DB.getKnowledgeBaseFiles(hotel.id);
            const otherDocs = await DB.getKnowledgeBaseFiles(other.id);
            assert.strictEqual(hotelDocs.length, 1);
            assert.strictEqual(otherDocs.length, 0);

            const search = await axios.post(`${baseUrl}/hotel-profiles/${hotel.id}/knowledge-base/search`, {
                query: 'Во сколько завтрак?',
                searchType: 'keyword',
                k: 3
            });
            assert.strictEqual(search.data.knowledgeBaseInstanceId, hotel.id);
            assert.ok(search.data.results[0].text.includes('06:30'));

            const smoke = await axios.post(`${baseUrl}/hotel-profiles/${hotel.id}/knowledge-base/smoke-test`, {});
            assert.strictEqual(smoke.data.smoke.total, 20);
            assert.strictEqual(smoke.data.smoke.failed, 0);
        });
    });

    it('should delete documents only through the hotel knowledge base scope', async () => {
        createTestDB();
        disableExternalRagServices();

        const hotelA = await HotelProfileService.create({ name: 'Hotel A', hotelTimezone: 'UTC' });
        const hotelB = await HotelProfileService.create({ name: 'Hotel B', hotelTimezone: 'UTC' });
        await uploadText(hotelA.id, 'hotel-a.md', `
# Hotel A
Завтрак Hotel A проходит с 07:00 до 10:00. Парковка стоит 700 рублей.
Трансфер Hotel A стоит 2500 рублей и заказывается заранее.
        `);
        await uploadText(hotelB.id, 'hotel-b.md', `
# Hotel B
Завтрак Hotel B проходит с 09:00 до 12:00. Парковка стоит 1100 рублей.
Трансфер Hotel B стоит 3900 рублей и заказывается заранее.
        `);

        const [hotelADoc] = await DB.getKnowledgeBaseFiles(hotelA.id);

        await withMlServer(async (baseUrl) => {
            const wrongDelete = await axios.delete(
                `${baseUrl}/hotel-profiles/${hotelB.id}/knowledge-base/${hotelADoc.id}`
            );
            assert.strictEqual(wrongDelete.data.result.deleted, 0);
            assert.strictEqual((await DB.getKnowledgeBaseFiles(hotelA.id)).length, 1);

            const correctDelete = await axios.delete(
                `${baseUrl}/hotel-profiles/${hotelA.id}/knowledge-base/${hotelADoc.id}`
            );
            assert.strictEqual(correctDelete.data.result.deleted, 1);
            assert.strictEqual((await DB.getKnowledgeBaseFiles(hotelA.id)).length, 0);
            assert.strictEqual((await DB.getKnowledgeBaseFiles(hotelB.id)).length, 1);
        });
    });
});
