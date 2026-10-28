const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const SalesBrain = require('../src/services/sales-brain.service');
const ChannelRouter = require('../src/services/channel-router.service');
const AIService = require('../src/services/ai.service');
const { AuthService } = require('../src/services/auth.service');
const { AvaOutboundService } = require('../src/services/ava-outbound.service');
const ApiRoutes = require('../src/routes/api.routes');
const axios = require('axios');

describe('Sales Brain Service Tests', () => {
    it('should recover failed and unknown engine/legacy tool outcomes without masking them as success', () => {
        const transcript = [{ role: 'user', content: 'Соедините с оператором' }];
        for (const run of [
            { name: 'transfer_call', params: {}, result: 'error' },
            { name: 'transfer_call', result: 'unknown' },
            { name: 'transfer_call', result: 'busy' },
            { name: 'transfer_call', result: 'timeout' },
            { name: 'transfer_call', status: 'ok', result: { success: false } },
            { name: 'transfer_call', status: 'ok', result: { status: 'unknown' } },
            { name: 'transfer_call' },
        ]) {
            assert.strictEqual(SalesBrain.resolveHandoffForCall({ transcript, toolRuns: [run] }).reason, 'transfer_failed');
        }
        for (const run of [
            { name: 'create_manager_task', result: 'error' },
            { name: 'create_manager_task', status: 'error', result: { task_id: 'not-saved' } },
            { name: 'create_manager_task', result: { status: 'unknown' } },
            { name: 'create_manager_task' },
        ]) {
            assert.strictEqual(SalesBrain.resolveHandoffForCall({ transcript, toolRuns: [run] }).reason, 'guest_request');
        }
        for (const name of ['transfer_call', 'create_manager_task']) {
            for (const outcome of [{ result: 'success' }, { status: 'ok', output: { success: true } }]) {
                assert.strictEqual(SalesBrain.resolveHandoffForCall({ transcript, toolRuns: [{ name, ...outcome }] }), null);
            }
        }
        const initiated = { name: 'transfer_call', result: 'success' };
        assert.strictEqual(SalesBrain.resolveHandoffForCall({ transcript, toolRuns: [initiated], handoffSignals: [{ type: 'transfer_failed', status: 'BUSY' }] }).reason, 'transfer_failed');
        for (const result of ['unknown', 'error']) {
            assert.strictEqual(SalesBrain.resolveHandoffForCall({ transcript, outcome: 'transferred', toolRuns: [{ name: 'transfer_call', result }] }).reason, 'transfer_failed');
        }
        assert.strictEqual(SalesBrain.resolveHandoffForCall({ transcript, outcome: 'transferred', handoffSignals: [{ type: 'transfer_failed' }] }).reason, 'transfer_failed');
        assert.strictEqual(SalesBrain.resolveHandoffForCall({ transcript, outcome: 'transferred' }), null);
    });

    it('should persist engine params/result/duration and create one recovery task across repeated delivery', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Tool contract hotel' });
        const chatId = '79990008901@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Tool fixture');
        const input = { instanceId: instance.id, chatId, callId: 'tool-contract-call',
            transcript: [{ role: 'user', content: 'Соедините с оператором' }],
            tool_runs: [
                { name: 'transfer_call', params: { target: 'frontdesk' }, result: 'error', message: 'BUSY', duration_ms: 42.5 },
                { name: 'create_manager_task', args: { reason: 'guest_request' }, output: { success: false }, latency_ms: 12 },
            ] };
        const first = await SalesBrain.postCall(input);
        const second = await SalesBrain.postCall(input);
        assert.strictEqual(first.handoff_task.reason, 'transfer_failed');
        assert.strictEqual(second.idempotent, true);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS count FROM manager_tasks WHERE instanceId=? AND callId=?', [instance.id, input.callId]).count, 1);
        const run = DB.getToolRuns(instance.id, chatId).find((item) => item.toolName === 'transfer_call');
        assert.strictEqual(run.status, 'error');
        assert.deepStrictEqual(JSON.parse(run.argsRedactedJson), { target: 'frontdesk' });
        assert.deepStrictEqual(JSON.parse(run.resultRedactedJson), { status: 'error', message: 'BUSY' });
        assert.strictEqual(run.latencyMs, 42.5);
        assert.strictEqual(DB.getToolRuns(instance.id, chatId).find((item) => item.toolRunId.endsWith('_1')).status, 'error');
        const savedTask = { name: 'create_manager_task', result: { task_id: first.handoff_task.task_id } };
        assert.strictEqual(SalesBrain.resolveHandoffForCall({ instanceId: instance.id, chatId, callId: input.callId, transcript: input.transcript, toolRuns: [savedTask] }), null);
        assert.strictEqual(SalesBrain.resolveHandoffForCall({ instanceId: instance.id, chatId: 'different-customer', callId: input.callId, transcript: input.transcript, toolRuns: [savedTask] }).reason, 'guest_request');
    });

    it('should retry an owed recovery when CRM refuses the task without losing the saved call', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Recovery retry hotel' });
        const chatId = '79990008902@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Recovery fixture');
        const input = { instanceId: instance.id, chatId, callId: 'recovery-retry-call',
            transcript: [{ role: 'user', content: 'Нужен оператор' }], tool_runs: [{ name: 'create_manager_task', result: 'error' }] };
        const original = SalesBrain.createManagerTask;
        SalesBrain.createManagerTask = async () => ({ success: false, error: 'crm_unavailable' });
        try {
            await assert.rejects(() => SalesBrain.postCall(input), /Recovery manager task was not durably saved/);
            assert.ok(DB.getConversationEventBySource(instance.id, 'post_call:recovery-retry-call'));
            assert.strictEqual(DB.get('SELECT COUNT(*) AS count FROM ml_decisions WHERE instanceId=? AND taskType=?', [instance.id, 'post_call']).count, 0);
        } finally { SalesBrain.createManagerTask = original; }
        assert.ok((await SalesBrain.postCall(input)).handoff_task.task_id);
        assert.strictEqual((await SalesBrain.postCall(input)).idempotent, true);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS count FROM manager_tasks WHERE instanceId=? AND callId=?', [instance.id, input.callId]).count, 1);
    });

    it('should never close a lead from booking words, questions, negations or assistant promises', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Unconfirmed booking hotel' });
        const chatId = '79990008903@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Booking fixture');
        for (const text of ['Можно подтвердить бронь?', 'Я не оплатил', 'Если оплачу, будет бронь?', 'Бронь подтверждена, я оплатил']) {
            assert.notStrictEqual(SalesBrain.classifyStage({ text, previous_stage: 'new' }).current_stage, 'booked');
        }
        const result = await SalesBrain.postCall({ instanceId: instance.id, chatId, callId: 'assistant-booking-claim',
            transcript: [{ role: 'user', content: 'Можно узнать правила?' }, { role: 'assistant', content: 'Я не могу подтвердить бронь, передам вопрос. Нужен люкс на неделю, бюджет до 90000.' }],
            tool_runs: [{ name: 'create_booking', status: 'ok', result: { booking_id: 'missing-booking' } }] });
        assert.strictEqual(result.stage_decision.current_stage, 'new');
        assert.strictEqual((await DB.getClient(instance.id, chatId)).leadStatus, 'new');
        const profile = await DB.getClientProfile(instance.id, chatId);
        assert.strictEqual(profile.needs, null);
        assert.strictEqual(profile.budget, null);
    });

    it('should close only with a matching persisted confirmed business record and successful tool', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Confirmed booking hotel' });
        const other = await DB.createInstance({ name: 'Other booking hotel' });
        const chatId = '79990008904@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Confirmed fixture');
        await DB.getOrCreateClient(other.id, chatId, 'Other tenant fixture');
        await DB.getOrCreateClient(instance.id, '79990008906@c.us', 'Other customer fixture');
        const booking = require('../src/services/pms/pms-store.service').upsertBooking(instance.id, 'bnovo', {
            id: 'external-fixture', status: { name: 'confirmed' }, customer: { phone: '+79990008904' },
        });
        assert.strictEqual(booking.id, `pmsb_${instance.id}_bnovo_external-fixture`);
        const scope = { instanceId: instance.id, chatId, previous_stage: 'new', text: 'Спасибо',
            toolRuns: [{ name: 'create_booking', status: 'ok', result: { provider: 'bnovo', business_id: instance.id, booking_id: booking.externalBookingId } }] };
        assert.strictEqual(SalesBrain.classifyStage(scope).current_stage, 'booked');
        assert.strictEqual(SalesBrain.classifyStage({ ...scope, instanceId: other.id }).current_stage, 'new');
        assert.strictEqual(SalesBrain.classifyStage({ ...scope, chatId: '79990008906@c.us' }).current_stage, 'new');
        assert.strictEqual(SalesBrain.classifyStage({ ...scope, toolRuns: [{ name: 'create_booking', result: { status: 'error', booking_id: booking.externalBookingId } }] }).current_stage, 'new');
        assert.strictEqual(SalesBrain.classifyStage({ ...scope, toolRuns: [{ name: 'create_booking_request', status: 'ok', result: { booking_id: booking.externalBookingId } }] }).current_stage, 'new');
        for (const result of [
            { provider: 'another-pms', booking_id: booking.externalBookingId },
            { business_id: other.id, provider: 'bnovo', booking_id: booking.externalBookingId },
        ]) assert.strictEqual(SalesBrain.classifyStage({ ...scope, toolRuns: [{ name: 'create_booking', status: 'ok', result }] }).current_stage, 'new');
        assert.strictEqual(SalesBrain.classifyStage({ ...scope,
            toolRuns: [{ name: 'create_booking', status: 'ok', result: { provider: 'bnovo', booking_id: booking.id } }] }).current_stage, 'booked');
        const result = await SalesBrain.postCall({ ...scope, callId: 'confirmed-booking-call', transcript: [{ role: 'user', content: 'Спасибо' }] });
        assert.strictEqual(result.stage_decision.current_stage, 'booked');
        assert.strictEqual((await DB.getClient(instance.id, chatId)).leadStatus, 'booked');
        assert.strictEqual((await SalesBrain.postCall({ ...scope, callId: 'confirmed-booking-call' })).idempotent, true);

        await DB.createPayment('payment-fixture', instance.id, chatId, 1000, 'Synthetic payment', 'pending');
        const payment = { ...scope, toolRuns: [{ name: 'check_payment', result: { success: true, payment_id: 'payment-fixture' } }] };
        assert.strictEqual(SalesBrain.classifyStage(payment).current_stage, 'new');
        await DB.updatePaymentStatus('payment-fixture', 'paid');
        assert.strictEqual(SalesBrain.classifyStage(payment).current_stage, 'booked');
    });

    it('should confirm PMS external booking IDs for opaque clients only through current confirmed phone aliases', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Opaque booking hotel' });
        const other = await DB.createInstance({ name: 'Other opaque booking hotel' });
        const chatId = 'tg_1234567890';
        const client = await DB.getOrCreateClient(instance.id, chatId, 'Opaque fixture');
        const neighbor = await DB.getOrCreateClient(instance.id, 'tg_1234567891', 'Neighbor fixture');
        const identities = require('../src/services/client-identity.service');
        identities.resolve(instance.id, chatId); // Initialize the actual canonical alias schema.
        require('../src/services/pms/pms-store.service').upsertBooking(instance.id, 'bnovo', {
            id: 'opaque-external', status: { name: 'confirmed' }, customer: { phone: '+79990008907' },
        });
        const scope = { instanceId: instance.id, chatId, previous_stage: 'new', text: 'Спасибо',
            toolRuns: [{ name: 'create_booking', result: { success: true, provider: 'bnovo', booking_id: 'opaque-external' } }] };
        assert.strictEqual(SalesBrain.classifyStage(scope).current_stage, 'new');
        const link = { instanceId: instance.id, chatId, normalizedPhone: '79990008907', linkType: 'phone_alias', customerId: `crm_${instance.id}_${client.id}` };
        DB.upsertIdentityLink({ ...link, confidence: 'weak' });
        assert.strictEqual(SalesBrain.classifyStage(scope).current_stage, 'new');
        DB.upsertIdentityLink({ ...link, confidence: 'exact' }); // Opaque IDs cannot establish an exact phone match.
        assert.strictEqual(SalesBrain.classifyStage(scope).current_stage, 'new');
        DB.upsertIdentityLink({ ...link, confidence: 'manual', customerId: `crm_${instance.id}_${neighbor.id}` });
        assert.strictEqual(SalesBrain.classifyStage(scope).current_stage, 'new');
        DB.upsertIdentityLink({ ...link, confidence: 'manual' });
        assert.strictEqual(SalesBrain.classifyStage(scope).current_stage, 'booked');
        assert.strictEqual(SalesBrain.classifyStage({ ...scope, chatId: neighbor.chatId }).current_stage, 'new');
        assert.strictEqual(SalesBrain.classifyStage({ ...scope, instanceId: other.id }).current_stage, 'new');
        DB.deleteIdentityLinksByChat(instance.id, chatId);
        DB.run('INSERT INTO client_aliases(instanceId,chatId,kind,value) VALUES(?,?,?,?)', [instance.id, chatId, 'phone', '+79990008907']);
        assert.strictEqual(SalesBrain.classifyStage(scope).current_stage, 'booked');
        DB.run('DELETE FROM client_aliases WHERE instanceId=? AND chatId=?', [instance.id, chatId]);
        assert.strictEqual(SalesBrain.classifyStage(scope).current_stage, 'new');
    });

    it('should preserve known profile facts on a short call and update only customer-confirmed fields', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Profile retention hotel' });
        const chatId = '79990008905@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Profile fixture');
        await DB.upsertClientProfile(instance.id, chatId, { needs: 'Люкс на 18 октября', budget: 'до 30000', objections: JSON.stringify(['trust']) });
        await SalesBrain.postCall({ instanceId: instance.id, chatId, callId: 'profile-short-call',
            transcript: 'Клиент: Спасибо. Ассистент: Нужен стандартный номер, бюджет до 10000. До свидания.' });
        let profile = await DB.getClientProfile(instance.id, chatId);
        assert.strictEqual(profile.needs, 'Люкс на 18 октября');
        assert.strictEqual(profile.budget, 'до 30000');
        assert.deepStrictEqual(JSON.parse(profile.objections), ['trust']);
        await SalesBrain.postCall({ instanceId: instance.id, chatId, callId: 'profile-update-call',
            transcript: [{ role: 'user', content: 'Нужен семейный номер на неделю. Бюджет до 40000 рублей.' }, { role: 'assistant', content: 'Бюджет до 90000 рублей.' }] });
        profile = await DB.getClientProfile(instance.id, chatId);
        assert.strictEqual(profile.needs, 'семейный номер на неделю');
        assert.ok(profile.budget.includes('40000'));
        assert.deepStrictEqual(JSON.parse(profile.objections), ['trust', 'price']);
    });

    it('should record explicit call summary provenance without treating transcript prefixes as summaries', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Summary provenance hotel', businessType: 'hotel' });
        const chatId = '79990008811';
        await DB.getOrCreateClient(instance.id, chatId, 'Summary test guest');
        const summary = 'Гость уточнил время заезда; дополнительных просьб нет.';
        await SalesBrain.postCall({ instanceId: instance.id, chatId, callId: 'summary-provided',
            transcript: 'Клиент: Во сколько можно заехать? Ассистент: После четырнадцати часов.',
            summary, direction: 'inbound', duration_sec: 42, outcome: 'completed' });
        const row = DB.getConversationEventBySource(instance.id, 'post_call:summary-provided');
        const meta = JSON.parse(row.metadataJson);
        assert.strictEqual(meta.summary_provenance, 'provided_summary');
        assert.strictEqual(meta.call_direction, 'inbound');
        assert.strictEqual(meta.duration_seconds, 42);
        const profile = await DB.getClientProfile(instance.id, chatId);
        assert.strictEqual(JSON.parse(profile.rawProfileJson).lastCallSummary, summary);

        const raw = 'Клиент: RAW_TRANSCRIPT_PREFIX. Ассистент: До свидания.';
        await SalesBrain.postCall({ instanceId: instance.id, chatId, callId: 'summary-raw', transcript: raw,
            summary: raw.slice(0, 35) });
        const fallback = DB.getConversationEventBySource(instance.id, 'post_call:summary-raw');
        assert.strictEqual(JSON.parse(fallback.metadataJson).summary_provenance, 'transcript_extract');
        assert.strictEqual(JSON.parse((await DB.getClientProfile(instance.id, chatId)).rawProfileJson).lastCallSummary, summary);
    });

    it('should not allow request fields to forge summary provenance for a CRM note', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Notes hotel', businessType: 'hotel' });
        const chatId = '79990008812';
        await DB.getOrCreateClient(instance.id, chatId, 'Note guest');
        const result = await SalesBrain.createCrmNote({ instanceId: instance.id, chatId, note: 'Unverified note',
            sourceId: 'unverified-test-note', summary_provenance: 'ai_generated',
            metadata: { summary_provenance: 'reviewed_summary' } });
        const row = DB.getConversationEventBySource(instance.id, 'unverified-test-note');
        assert.ok(result.success);
        assert.strictEqual(JSON.parse(row.metadataJson).summary_provenance, undefined);
    });

    it('should accept only configured service token for internal ML API', () => {
        const auth = new AuthService({ enabled: true, adminLogin: 'admin', adminPasswordHash: '', sessionSecret: 'x'.repeat(40), sessionTtlHours: 24 });
        const previous = process.env.CRM_SERVICE_API_TOKEN;
        process.env.CRM_SERVICE_API_TOKEN = 'service-token';

        let statusCode = 200;
        const req = { headers: { authorization: 'Bearer service-token' } };
        const res = {
            status(code) {
                statusCode = code;
                return this;
            },
            json(payload) {
                this.payload = payload;
                return this;
            }
        };
        let called = false;
        auth.requireServiceToken(req, res, () => { called = true; });

        assert.strictEqual(called, true);
        assert.strictEqual(statusCode, 200);
        if (previous === undefined) {
            delete process.env.CRM_SERVICE_API_TOKEN;
        } else {
            process.env.CRM_SERVICE_API_TOKEN = previous;
        }
    });

    it('should not expose instance secrets in API projections', () => {
        const instance = ApiRoutes.sanitizeInstance({
            id: 1,
            name: 'Accent Coffee',
            greenApiToken: 'abcdef123456',
            yandexGptKey: 'ya-secret-key',
            bitrix24WebhookUrl: 'https://crm.example/webhook/token',
            baristaBotToken: 'telegram-bot-token',
            greenApiInstance: '1100000000',
            yandexGptFolderId: 'folder-id'
        });

        assert.strictEqual(instance.greenApiInstance, '1100000000');
        assert.strictEqual(instance.yandexGptFolderId, 'folder-id');
        assert.strictEqual(instance.greenApiToken, 'ab***56');
        assert.strictEqual(instance.yandexGptKey, 'ya***ey');
        assert.strictEqual(instance.bitrix24WebhookUrl, 'ht***en');
        assert.strictEqual(instance.baristaBotToken, 'te***en');
    });

    it('should enrich customer summary with coffee context without raw transcript', async () => {
        createTestDB();
        const instance = await DB.createInstance({
            name: 'Central Cafe',
            businessType: 'coffee_shop',
            coffeeOperationMode: 'busy',
            coffeeCafeHours: '08:00-22:00',
            coffeeKitchenHours: '09:00-21:00',
            coffeePrepTimeMinutes: 12
        });
        const chatId = '79285348831@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Мевлюд');
        await DB.saveMessage(instance.id, chatId, 'Мевлюд', 'Хочу латте к 15:00', 'user');
        await DB.createOrder(instance.id, chatId, 'Мевлюд', 'Латте 0.3 на кокосовом', 'к 15:00');
        await DB.addCoffeeStopListItem(instance.id, { itemName: 'Матча', reason: 'закончился порошок' });

        const summary = await SalesBrain.customerSummary({ instanceId: instance.id, phone: '79285348831' });

        assert.strictEqual(summary.found, true);
        assert.strictEqual(summary.business_type, 'coffee_shop');
        assert.ok(summary.coffee_context);
        assert.strictEqual(summary.coffee_context.active_orders.length, 1);
        assert.ok(summary.summary_for_voice.includes('Режим кофейни'));
        assert.ok(summary.summary_for_voice.includes('Активный заказ'));
        assert.ok(!JSON.stringify(summary).includes('raw transcript'));
    });

    it('should process post-call idempotently', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Sales CRM' });
        const chatId = '79990000001@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Анна');

        const first = await SalesBrain.postCall({
            instanceId: instance.id,
            phone: '79990000001',
            callId: 'call-sales-brain-1',
            transcript: 'Клиент спросил цену и попросил отправить предложение.'
        });
        const second = await SalesBrain.postCall({
            instanceId: instance.id,
            phone: '79990000001',
            callId: 'call-sales-brain-1',
            transcript: 'Повторная обработка того же звонка.'
        });

        const events = DB.getConversationEvents(instance.id, chatId, 20)
            .filter((event) => event.sourceId === 'post_call:call-sales-brain-1');
        assert.strictEqual(first.success, true);
        assert.strictEqual(second.idempotent, true);
        assert.strictEqual(events.length, 1);
    });

    it('should include tool runs and ML decisions in unified timeline', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Unified Timeline CRM' });
        const chatId = '79990000011@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Тимур');
        await DB.saveMessage(instance.id, chatId, 'Тимур', 'Нужна интеграция с CRM', 'user');
        DB.createToolRun({
            instanceId: instance.id,
            chatId,
            toolName: 'answer_from_knowledge',
            status: 'ok',
            resultRedacted: { answer: 'Готово' }
        });
        DB.createMlDecision({
            instanceId: instance.id,
            chatId,
            taskType: 'next_best_action',
            output: { action_type: 'schedule_call' },
            confidence: 0.8
        });

        const result = await SalesBrain.getTimeline({ instanceId: instance.id, chatId, limit: 20 });
        const types = new Set(result.timeline.map((item) => item.type));

        assert.ok(types.has('message'));
        assert.ok(types.has('tool_run'));
        assert.ok(types.has('ml_decision'));
    });

    it('should surface hotel memory with dates, interests, objections and last call summary', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Ava Hotel', businessType: 'hotel' });
        const chatId = '79990000021@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Марина');
        await DB.saveMessage(instance.id, chatId, 'Марина', 'Ищу номер с 15.07 по 18.07, интересует люкс с видом на море.', 'user');
        await DB.saveMessage(instance.id, chatId, 'AVA', 'Подготовлю варианты.', 'assistant');
        await DB.saveMessage(instance.id, chatId, 'Марина', 'Если будет дорого, я подумаю до завтра.', 'user');

        await SalesBrain.postCall({
            instanceId: instance.id,
            phone: '79990000021',
            callId: 'hotel-memory-call-1',
            summary: 'Клиент подтвердил интерес к люксу и попросил предложение на 15 июля. Сказал, что цена для него чувствительна.'
        });

        const pending = await SalesBrain.customerSummary({ instanceId: instance.id, chatId });
        assert.strictEqual(pending.memory.summary_status, 'generation_pending');
        // Pending generation must not erase facts already present in the
        // accepted call and this customer's messages.
        assert.ok(pending.memory.interests.some(item => /люкс|вид/i.test(item)));
        const memoryStore = require('../src/services/crm-memory-store.service');
        DB.run('UPDATE crm_memory_jobs SET nextAttemptAt=0');
        for (let job = memoryStore.lease(); job; job = memoryStore.lease()) {
            const source = memoryStore.source(job);
            assert.strictEqual(memoryStore.finish(job, {
                relevance: 'relevant', summary: 'Гость рассматривает люкс с видом на море в середине июля; стоимость важна.',
                needs: 'Люкс с видом на море', budget: null, interests: ['люкс', 'вид на море'],
                dates: ['15.07–18.07'], objections: ['price'], preferences: [], next_step: 'Уточнить бюджет',
                evidence_ids: source.messages.map(message => message.id),
            }, source, 'test-fixture'), true);
        }
        const summary = await SalesBrain.customerSummary({ instanceId: instance.id, chatId });

        assert.strictEqual(summary.business_type, 'hotel');
        assert.ok(summary.profile.interests.some((item) => /люкс|вид/i.test(item)));
        assert.ok(summary.profile.importantDates.some((item) => /15\.07|15 июля|завтра/i.test(item)));
        assert.ok(summary.profile.objections.includes('price'));
        assert.ok(summary.profile.lastCallSummary);
        assert.ok(summary.summary_for_voice.includes('Важные даты'));
        assert.ok(summary.summary_for_voice.includes('Последний звонок'));
    });

    it('should merge profile memory metadata instead of overwriting it', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Memory Merge Hotel', businessType: 'hotel' });
        const chatId = '79990000022@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Игорь');

        await DB.upsertClientProfile(instance.id, chatId, {
            interests: ['семейный отдых'],
            rawProfileJson: JSON.stringify({
                keyFacts: ['Есть дети'],
                importantDates: ['20 июля']
            })
        });
        await DB.upsertClientProfile(instance.id, chatId, {
            rawProfileJson: JSON.stringify({
                lastCallSummary: 'Просит перезвонить вечером',
                importantDates: ['21 июля'],
                callCountIncrement: 1
            })
        });

        const summary = await SalesBrain.customerSummary({ instanceId: instance.id, chatId });

        assert.ok(summary.profile.interests.includes('семейный отдых'));
        assert.ok(summary.profile.keyFacts.includes('Есть дети'));
        assert.ok(summary.profile.importantDates.includes('20 июля'));
        assert.ok(summary.profile.importantDates.includes('21 июля'));
        assert.strictEqual(summary.profile.lastCallSummary, 'Просит перезвонить вечером');
        assert.strictEqual(summary.profile.callCount, 1);
    });

    it('should generate outbound opening with AI from customer context', async () => {
        createTestDB();
        const instance = await DB.createInstance({
            name: 'отеля Ava',
        });
        await DB.updateInstance(instance.id, { yandexGptModelUri: 'qwen3.7-test' });
        const chatId = '79990000012@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Ирина');
        await DB.saveMessage(instance.id, chatId, 'Ирина', 'Подскажите, есть свободный номер на выходные?', 'user');

        const originalGeneratePlainText = AIService.generatePlainText;
        let seenPayload = '';
        let seenModel = '';
        AIService.generatePlainText = async (messages, instanceConfig) => {
            seenModel = instanceConfig.yandexGptModelUri;
            seenPayload = messages.map((m) => m.content).join('\n');
            return 'Здравствуйте, это Анастасия из отеля Ava. Видела, что вы уточняли свободный номер на выходные, удобно коротко обсудить варианты?';
        };

        try {
            const result = await SalesBrain.generateOutboundOpening({
                instanceId: instance.id,
                phone: '79990000012',
                direction: 'outbound',
                outboundCustomVars: { whatsapp_chat_id: chatId }
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.fallback_used, false);
            assert.ok(result.opening.includes('Анастасия'));
            assert.ok(result.opening.includes('свободный номер на выходные'));
            assert.ok(!/чем\s+могу\s+помочь/i.test(result.opening));
            assert.ok(result.summary_for_voice.includes('свободный номер на выходные'));
            assert.ok(result.recommended_next_action);
            assert.strictEqual(seenModel, 'qwen3.7-test');
            assert.ok(seenPayload.includes('свободный номер на выходные'));
            assert.ok(seenPayload.includes('recent_timeline'));
        } finally {
            AIService.generatePlainText = originalGeneratePlainText;
        }
    });

    it('should require confirmation before sending WhatsApp follow-up', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Sales CRM' });
        await DB.getOrCreateClient(instance.id, '79990000002@c.us', 'Олег');

        const result = await SalesBrain.sendWhatsAppFollowup({
            instanceId: instance.id,
            phone: '79990000002',
            text: 'Отправляю детали.',
            confirmed: false
        });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.status, 'needs_confirmation');
        assert.strictEqual(result.requires_confirmation, true);
    });

    it('should resolve SIP extension aliases to linked WhatsApp clients', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Sales CRM' });
        await DB.getOrCreateClient(instance.id, '79990000005@c.us', 'Роман');

        const linked = await SalesBrain.bindCustomerAlias({
            instanceId: instance.id,
            extension: '6003',
            whatsappPhone: '79990000005',
            name: 'Роман'
        });
        const resolved = await SalesBrain.resolveCustomer({
            instanceId: instance.id,
            phone: '6003'
        });

        assert.strictEqual(linked.success, true);
        assert.strictEqual(linked.chatId, '79990000005@c.us');
        assert.strictEqual(resolved.found, true);
        assert.strictEqual(resolved.chatId, '79990000005@c.us');
        assert.strictEqual(resolved.identity_link.link_type, 'sip_extension');
    });

    it('should replace the SIP extension linked to a WhatsApp client', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Sales CRM' });
        const chatId = '79990000006@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Нина');

        await SalesBrain.bindCustomerAlias({
            instanceId: instance.id,
            extension: '6003',
            chatId,
            replaceExisting: true
        });
        await SalesBrain.bindCustomerAlias({
            instanceId: instance.id,
            extension: '6004',
            chatId,
            replaceExisting: true
        });

        const aliases = await SalesBrain.getCustomerAliases({ instanceId: instance.id, chatId });
        const oldResolved = await SalesBrain.resolveCustomer({ instanceId: instance.id, phone: '6003' });
        const newResolved = await SalesBrain.resolveCustomer({ instanceId: instance.id, phone: '6004' });

        assert.deepStrictEqual(aliases.aliases.map((item) => item.alias), ['6004']);
        assert.strictEqual(oldResolved.found, false);
        assert.strictEqual(newResolved.chatId, chatId);
    });

    it('should persist WhatsApp follow-up drafts for manager approval', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Sales CRM' });
        const chatId = '79990000007@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Ольга');

        const draft = await SalesBrain.draftWhatsAppFollowup({
            instanceId: instance.id,
            phone: '79990000007',
            text: 'Краткая информация после звонка.'
        });
        const pending = await SalesBrain.listFollowupDrafts({ instanceId: instance.id, chatId });

        assert.strictEqual(draft.success, true);
        assert.ok(draft.draft_id);
        assert.strictEqual(pending.drafts.length, 1);
        assert.strictEqual(pending.drafts[0].text, 'Краткая информация после звонка.');
        assert.strictEqual(pending.drafts[0].status, 'draft');
    });

    it('should keep draft pending when WhatsApp requires QR authorization', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Sales CRM' });
        const chatId = '79990000008@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Ирина');
        const draft = await SalesBrain.draftWhatsAppFollowup({
            instanceId: instance.id,
            phone: '79990000008',
            text: 'Детали после звонка.'
        });
        const originalSendMessageDetailed = ChannelRouter.sendMessageDetailed;
        ChannelRouter.sendMessageDetailed = async () => ({
            success: false,
            channel: 'whatsapp',
            error: 'whatsapp_not_authorized',
            state: 'notAuthorized'
        });

        try {
            // Manager path: a draft only goes out once a human approves it.
            const result = await SalesBrain.approveWhatsAppFollowup({
                instanceId: instance.id,
                draftId: draft.draft_id,
                approvedBy: 'Ирина (ресепшен)'
            });
            const pending = await SalesBrain.listFollowupDrafts({ instanceId: instance.id, chatId });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, 'whatsapp_not_authorized');
            assert.strictEqual(result.requires_whatsapp_authorization, true);
            assert.strictEqual(pending.drafts.length, 1);
            // The approval survives a delivery failure so the manager can retry.
            assert.strictEqual(pending.drafts[0].status, 'failed');
            assert.strictEqual(pending.drafts[0].failure_reason, 'whatsapp_not_authorized');
        } finally {
            ChannelRouter.sendMessageDetailed = originalSendMessageDetailed;
        }
    });

    it('should exclude do_not_call leads from runnable outbound campaign jobs', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Outbound CRM' });
        const allowed = await DB.getOrCreateClient(instance.id, '79990000003@c.us', 'Мария');
        const blocked = await DB.getOrCreateClient(instance.id, '79990000004@c.us', 'Игорь');
        await DB.updateClientTags(instance.id, blocked.chatId, ['do_not_call']);

        const campaign = await SalesBrain.createOutboundCampaign({
            instanceId: instance.id,
            name: 'Demo outbound',
            enabled: true,
            status: 'running',
            call_window: { start: '00:00', end: '23:59' }
        });
        await SalesBrain.syncOutboundCampaignLeads({ campaignId: campaign.campaign.campaign_id });
        const runnable = await SalesBrain.getRunnableOutboundLeads({ campaignId: campaign.campaign.campaign_id, limit: 10 });

        assert.strictEqual(runnable.success, true);
        assert.strictEqual(runnable.jobs.length, 1);
        assert.strictEqual(runnable.jobs[0].phone, '79990000003');
        assert.strictEqual(allowed.senderName, 'Мария');
    });

    it('should export a Sales Brain campaign in AVA outbound format', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'AVA Export CRM' });
        await DB.getOrCreateClient(instance.id, '79990000021@c.us', 'Алина');

        const created = await SalesBrain.createOutboundCampaign({
            instanceId: instance.id,
            name: 'CRM follow-up',
            enabled: true,
            status: 'running',
            context_id: 'unified_sales_agent',
            call_window: { start: '10:00', end: '20:00' }
        });
        const campaignId = created.campaign.campaign_id;
        const exported = await SalesBrain.exportOutboundCampaignForAva({ campaignId });

        assert.strictEqual(exported.success, true);
        assert.strictEqual(exported.external_campaign_id, campaignId);
        assert.strictEqual(exported.campaign.default_context, 'unified_sales_agent');
        assert.strictEqual(exported.campaign.max_attempts, 3);
        assert.strictEqual(exported.campaign.retry_initial_delay_seconds, 60);
        assert.strictEqual(exported.campaign.retry_backoff_multiplier, 2);
        assert.strictEqual(exported.campaign.retry_max_delay_seconds, 3600);
        assert.strictEqual(exported.leads.length, 1);
        assert.strictEqual(exported.leads[0].custom_vars.sales_brain_campaign_id, campaignId);
        assert.ok(exported.leads[0].custom_vars.sales_brain_lead_id);
    });

    it('should preserve legacy fixed-delay retry policy when exporting to AVA', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Legacy Retry CRM' });
        await DB.getOrCreateClient(instance.id, '79990000022@c.us', 'Легаси');
        const created = await SalesBrain.createOutboundCampaign({
            instanceId: instance.id,
            name: 'Legacy retry',
            max_attempts: 4,
            retry_policy: { delay_minutes: 15 }
        });

        const exported = await SalesBrain.exportOutboundCampaignForAva({
            campaignId: created.campaign.campaign_id
        });

        assert.strictEqual(exported.campaign.max_attempts, 4);
        assert.strictEqual(exported.campaign.retry_initial_delay_seconds, 900);
        assert.strictEqual(exported.campaign.retry_backoff_multiplier, 1);
        assert.strictEqual(exported.campaign.retry_max_delay_seconds, 900);
    });

    it('should process AVA transcript arrays and complete linked outbound lead', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'AVA Post-call CRM' });
        const chatId = '79990000031@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Ирина');
        const created = await SalesBrain.createOutboundCampaign({
            instanceId: instance.id,
            name: 'AVA linked campaign',
            enabled: true,
            status: 'running'
        });
        const campaignId = created.campaign.campaign_id;
        await SalesBrain.syncOutboundCampaignLeads({ campaignId });
        const lead = (await SalesBrain.listOutboundLeads({ campaignId })).leads[0];

        const result = await SalesBrain.postCall({
            instanceId: instance.id,
            caller_number: '79990000031',
            callId: 'ava-linked-call-1',
            outcome: 'agent_hangup',
            duration_sec: 42,
            transcript: [
                { role: 'user', content: 'Хочу узнать цену' },
                { role: 'assistant', content: 'Подготовлю предложение' }
            ],
            tool_runs: [
                { name: 'answer_from_knowledge', status: 'ok', result: { spoken: 'Цена уточнена' } }
            ],
            outbound_custom_vars: {
                sales_brain_campaign_id: campaignId,
                sales_brain_lead_id: lead.lead_id
            }
        });

        const updatedLead = DB.getOutboundLead(lead.lead_id);
        const storedToolRuns = DB.getToolRuns(instance.id, chatId, 20);
        const event = DB.getConversationEventBySource(instance.id, 'post_call:ava-linked-call-1');

        assert.strictEqual(result.success, true);
        assert.strictEqual(updatedLead.state, 'completed');
        assert.strictEqual(updatedLead.lastOutcome, 'agent_hangup');
        assert.ok(storedToolRuns.some((run) => run.toolName === 'answer_from_knowledge'));
        assert.ok(event.content.includes('Хочу узнать цену'));
    });

    it('should deploy a Sales Brain campaign to the protected AVA internal API', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Protected outbound campaign' });
        DB.createOutboundCampaign({ campaignId: 'campaign/1', instanceId: instance.id, name: 'Protected campaign' });
        const originalPost = axios.post;
        let captured = null;
        axios.post = async (url, body, options) => {
            captured = { url, body, options };
            return { data: { success: true, ava_campaign: { id: 'ava-1' } } };
        };

        try {
            const service = new AvaOutboundService({
                apiUrl: 'http://admin-ui.test:3003/',
                serviceToken: 'shared-service-token',
                timeoutMs: 3210
            });
            await assert.rejects(() => service.syncCampaign('missing-campaign'), error => error.code === 'CAMPAIGN_NOT_FOUND');
            assert.strictEqual(captured, null);
            const result = await service.syncCampaign('campaign/1', {
                start: true,
                syncLeads: true,
                maxConcurrent: 2,
                minIntervalSecondsBetweenCalls: 15
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(
                captured.url,
                'http://admin-ui.test:3003/api/internal/outbound/sales-brain/campaigns/campaign%2F1/sync'
            );
            assert.strictEqual(captured.body.start, true);
            assert.strictEqual(captured.body.max_concurrent, 2);
            assert.strictEqual(captured.options.timeout, 3210);
            assert.strictEqual(captured.options.headers.Authorization, 'Bearer shared-service-token');

            await service.setCampaignStatus('campaign/1', 'paused');
            assert.strictEqual(
                captured.url,
                'http://admin-ui.test:3003/api/internal/outbound/sales-brain/campaigns/campaign%2F1/status'
            );
            assert.strictEqual(captured.body.status, 'paused');
        } finally {
            axios.post = originalPost;
        }
    });
});
