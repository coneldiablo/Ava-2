const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const SalesBrain = require('../src/services/sales-brain.service');
const HotelProfileService = require('../src/services/hotel-profile.service');

async function seedHotel(name) {
    return HotelProfileService.create({ name, hotelTimezone: 'Europe/Moscow' });
}

describe('Manager Handoff Tests', () => {
    it('should create a task with every acceptance field filled', async () => {
        createTestDB();
        const hotel = await seedHotel('Grand Pilot Hotel');

        const result = await SalesBrain.createManagerTask({
            instanceId: hotel.id,
            phone: '+7 (999) 000-00-01',
            callId: 'call-handoff-1',
            summary: 'Гость просит перенести бронь на другие даты.',
            reason: 'booking_change',
            priority: 'high',
        });

        assert.strictEqual(result.success, true);
        const task = result.task;
        assert.ok(task.task_id, 'task id is required');
        assert.strictEqual(task.business_id, hotel.id);
        assert.strictEqual(task.summary, 'Гость просит перенести бронь на другие даты.');
        assert.strictEqual(task.phone, '79990000001');
        assert.strictEqual(task.reason, 'booking_change');
        assert.strictEqual(task.priority, 'high');
        assert.strictEqual(task.status, 'new');
        assert.strictEqual(task.call_id, 'call-handoff-1');
        assert.strictEqual(
            task.call_link,
            `/logs?mode=troubleshoot&call_id=call-handoff-1&business_id=${hotel.id}`,
        );
    });

    it('should keep the voice tool contract working without a reason', async () => {
        createTestDB();
        const hotel = await seedHotel('Legacy Hotel');

        // Old call shape from the MCP tool: task text only, no reason field.
        const result = await SalesBrain.createManagerTask({
            instanceId: hotel.id,
            phone: '79990000002',
            task: 'Связаться с гостем по трансферу',
        });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.spoken, 'Создал задачу менеджеру.');
        assert.ok(result.event_id, 'conversation event stays for backward compatibility');
        assert.strictEqual(result.task.reason, 'manual');
        assert.strictEqual(result.task.summary, 'Связаться с гостем по трансферу');

        const events = DB.getConversationEvents(hotel.id, null, 10);
        assert.ok(events.some((event) => event.role === 'task' && event.channel === 'manager'));
    });

    it('should normalize an unknown reason instead of failing the handoff', async () => {
        createTestDB();
        const hotel = await seedHotel('Normalizing Hotel');

        const result = await SalesBrain.createManagerTask({
            instanceId: hotel.id,
            phone: '79990000003',
            summary: 'Что-то пошло не так',
            reason: 'totally-unknown-reason',
            priority: 'super-urgent',
        });

        assert.strictEqual(result.task.reason, 'manual');
        assert.strictEqual(result.task.priority, 'normal');
    });

    it('should never leak tasks across businesses', async () => {
        createTestDB();
        const hotelA = await seedHotel('Hotel A');
        const hotelB = await seedHotel('Hotel B');

        const created = await SalesBrain.createManagerTask({
            instanceId: hotelA.id,
            phone: '79990000010',
            summary: 'Задача отеля A',
            reason: 'guest_request',
        });

        const listB = await SalesBrain.listManagerTasks({ instanceId: hotelB.id });
        assert.strictEqual(listB.tasks.length, 0);

        const listA = await SalesBrain.listManagerTasks({ instanceId: hotelA.id });
        assert.strictEqual(listA.tasks.length, 1);
        assert.strictEqual(listA.tasks[0].summary, 'Задача отеля A');

        // Reading a foreign task by id must look like "not found", never like data.
        assert.strictEqual(DB.getManagerTask(hotelB.id, created.task.task_id), undefined);
        const updateFromB = await SalesBrain.updateManagerTask({
            instanceId: hotelB.id,
            taskId: created.task.task_id,
            status: 'done',
        });
        assert.strictEqual(updateFromB.success, false);
        assert.strictEqual(updateFromB.error, 'task_not_found');

        // And the task in A is untouched by the attempt.
        const stillOpen = DB.getManagerTask(hotelA.id, created.task.task_id);
        assert.strictEqual(stillOpen.status, 'new');
    });

    it('should never hand back another tenant row on a task id collision', async () => {
        createTestDB();
        const hotelA = await seedHotel('Collision Hotel A');
        const hotelB = await seedHotel('Collision Hotel B');

        // Same callId in two businesses must produce independent scoped tasks.
        const sharedCallId = 'call-collision';
        await SalesBrain.createManagerTask({
            instanceId: hotelA.id,
            phone: '79990000050',
            callId: sharedCallId,
            summary: 'Задача отеля A',
        });
        const second = await SalesBrain.createManagerTask({
            instanceId: hotelB.id,
            phone: '79990000051',
            callId: sharedCallId,
            summary: 'Задача отеля B',
        });

        // B must never receive A's row back, whatever the storage did.
        assert.strictEqual(second.task.business_id, hotelB.id);
        assert.strictEqual(second.task.summary, 'Задача отеля B');

        const listB = await SalesBrain.listManagerTasks({ instanceId: hotelB.id });
        assert.strictEqual(listB.tasks.length, 1);

        const listA = await SalesBrain.listManagerTasks({ instanceId: hotelA.id });
        assert.strictEqual(listA.tasks.length, 1);
        assert.strictEqual(listA.tasks[0].summary, 'Задача отеля A');
    });

    it('should enforce the status lifecycle', async () => {
        createTestDB();
        const hotel = await seedHotel('Lifecycle Hotel');
        const created = await SalesBrain.createManagerTask({
            instanceId: hotel.id,
            phone: '79990000011',
            summary: 'Проверка статусов',
        });
        const taskId = created.task.task_id;

        const started = await SalesBrain.updateManagerTask({
            instanceId: hotel.id,
            taskId,
            status: 'in_progress',
            assignee: 'Ирина',
        });
        assert.strictEqual(started.success, true);
        assert.strictEqual(started.task.status, 'in_progress');
        assert.strictEqual(started.task.assignee, 'Ирина');
        assert.strictEqual(started.task.closed_at, null);

        const done = await SalesBrain.updateManagerTask({
            instanceId: hotel.id,
            taskId,
            status: 'done',
            resolution_note: 'Перезвонили гостю',
        });
        assert.strictEqual(done.task.status, 'done');
        assert.ok(done.task.closed_at, 'closing a task stamps closedAt');
        assert.strictEqual(done.task.resolution_note, 'Перезвонили гостю');

        // done -> in_progress is not a legal jump.
        const illegal = await SalesBrain.updateManagerTask({
            instanceId: hotel.id,
            taskId,
            status: 'in_progress',
        });
        assert.strictEqual(illegal.success, false);
        assert.strictEqual(illegal.error, 'invalid_status_transition');

        const unknown = await SalesBrain.updateManagerTask({
            instanceId: hotel.id,
            taskId,
            status: 'archived',
        });
        assert.strictEqual(unknown.success, false);

        // Reopening is allowed and clears the close stamp.
        const reopened = await SalesBrain.updateManagerTask({
            instanceId: hotel.id,
            taskId,
            status: 'new',
        });
        assert.strictEqual(reopened.task.status, 'new');
        assert.strictEqual(reopened.task.closed_at, null);
    });

    it('should open a task when the transfer to a human never landed', async () => {
        createTestDB();
        const hotel = await seedHotel('Transfer Hotel');

        const result = await SalesBrain.postCall({
            instanceId: hotel.id,
            callId: 'call-transfer-failed',
            phone: '79990000020',
            summary: 'Гость просил администратора, перевод не прошел.',
            outcome: 'caller_hangup',
            handoff_signals: [{ type: 'transfer_failed', target: 'SIP/reception', status: 'NOANSWER' }],
            transcript: [{ role: 'user', content: 'Соедините меня с администратором' }],
        });

        assert.ok(result.handoff_task, 'post-call opens a manager task');
        assert.strictEqual(result.handoff_task.reason, 'transfer_failed');
        assert.strictEqual(result.handoff_task.source, 'auto_post_call');
        assert.strictEqual(result.handoff_task.call_id, 'call-transfer-failed');
        assert.strictEqual(result.handoff_task.metadata.dial_status, 'NOANSWER');
    });

    it('should open a task from a guest handoff intent the agent ignored', async () => {
        createTestDB();
        const hotel = await seedHotel('Intent Hotel');

        const result = await SalesBrain.postCall({
            instanceId: hotel.id,
            callId: 'call-intent',
            phone: '79990000021',
            summary: 'Гость жаловался на уборку.',
            outcome: 'caller_hangup',
            transcript: [
                { role: 'assistant', content: 'Чем могу помочь?' },
                { role: 'user', content: 'У меня жалоба на уборку номера' },
            ],
        });

        assert.ok(result.handoff_task);
        assert.strictEqual(result.handoff_task.reason, 'complaint');
        assert.strictEqual(result.handoff_task.priority, 'high');
    });

    it('should not open a task when the agent already filed one', async () => {
        createTestDB();
        const hotel = await seedHotel('Already Filed Hotel');

        const result = await SalesBrain.postCall({
            instanceId: hotel.id,
            callId: 'call-already-filed',
            phone: '79990000022',
            summary: 'Задача уже создана в звонке.',
            outcome: 'caller_hangup',
            transcript: [{ role: 'user', content: 'Позовите администратора' }],
            tool_runs: [{ name: 'mcp_sales_create_manager_task', status: 'ok' }],
        });

        assert.strictEqual(result.handoff_task, null);
    });

    it('should not open a task when the call actually reached a human', async () => {
        createTestDB();
        const hotel = await seedHotel('Transferred Hotel');

        const result = await SalesBrain.postCall({
            instanceId: hotel.id,
            callId: 'call-transferred',
            phone: '79990000023',
            summary: 'Перевели на администратора.',
            outcome: 'transferred',
            transcript: [{ role: 'user', content: 'Соедините с администратором' }],
            handoff_signals: [{ type: 'transfer_failed', target: 'SIP/reception', status: 'BUSY' }],
        });

        assert.strictEqual(result.handoff_task, null, 'a retry that succeeded is not a handoff');
    });

    it('should not open a task for an ordinary call', async () => {
        createTestDB();
        const hotel = await seedHotel('Quiet Hotel');

        const result = await SalesBrain.postCall({
            instanceId: hotel.id,
            callId: 'call-quiet',
            phone: '79990000024',
            summary: 'Гость уточнил время завтрака.',
            outcome: 'caller_hangup',
            transcript: [
                { role: 'user', content: 'Во сколько завтрак?' },
                { role: 'assistant', content: 'Завтрак с 7 до 11.' },
            ],
        });

        assert.strictEqual(result.handoff_task.source, 'post_call_followup');
        assert.ok(result.followup_draft);
        const tasks = await SalesBrain.listManagerTasks({ instanceId: hotel.id });
        assert.strictEqual(tasks.tasks.length, 1);
    });

    it('should ignore the assistant own words when detecting handoff intent', async () => {
        createTestDB();
        const hotel = await seedHotel('Assistant Voice Hotel');

        const result = await SalesBrain.postCall({
            instanceId: hotel.id,
            callId: 'call-assistant-only',
            phone: '79990000025',
            summary: 'AVA предложила уточнить у администратора.',
            outcome: 'caller_hangup',
            transcript: [
                { role: 'user', content: 'А есть ли у вас сауна?' },
                { role: 'assistant', content: 'Уточню у администратора и вернусь с ответом.' },
            ],
        });

        assert.strictEqual(result.handoff_task, null, 'the agent mentioning an admin is not a guest request');
    });

    it('should create at most one task per call across both triggers', async () => {
        createTestDB();
        const hotel = await seedHotel('Dedupe Hotel');

        const payload = {
            instanceId: hotel.id,
            callId: 'call-dedupe',
            phone: '79990000026',
            summary: 'Перевод не прошел, гость просил человека.',
            outcome: 'caller_hangup',
            handoff_signals: [{ type: 'transfer_failed', target: 'SIP/reception', status: 'CONGESTION' }],
            transcript: [{ role: 'user', content: 'Позовите оператора' }],
        };

        const first = await SalesBrain.postCall(payload);
        assert.ok(first.handoff_task);

        // A retried post-call webhook must not duplicate the queue entry.
        await SalesBrain.postCall(payload);
        const direct = await SalesBrain.createManagerTask({
            instanceId: hotel.id,
            callId: 'call-dedupe',
            phone: '79990000026',
            summary: 'Ещё одна попытка по тому же звонку',
        });
        assert.strictEqual(direct.idempotent, true);

        const tasks = await SalesBrain.listManagerTasks({ instanceId: hotel.id, callId: 'call-dedupe' });
        assert.strictEqual(tasks.tasks.length, 1);
    });

    it('should filter and count tasks by status inside one business', async () => {
        createTestDB();
        const hotel = await seedHotel('Counting Hotel');

        const first = await SalesBrain.createManagerTask({
            instanceId: hotel.id, phone: '79990000030', summary: 'A', callId: 'c1',
        });
        await SalesBrain.createManagerTask({
            instanceId: hotel.id, phone: '79990000031', summary: 'B', callId: 'c2',
        });
        await SalesBrain.updateManagerTask({
            instanceId: hotel.id, taskId: first.task.task_id, status: 'done',
        });

        const open = await SalesBrain.listManagerTasks({ instanceId: hotel.id, status: 'new' });
        assert.strictEqual(open.tasks.length, 1);
        assert.strictEqual(open.tasks[0].summary, 'B');
        assert.strictEqual(open.counts.new, 1);
        assert.strictEqual(open.counts.done, 1);

        const invalid = await SalesBrain.listManagerTasks({ instanceId: hotel.id, status: 'nope' });
        assert.strictEqual(invalid.success, false);
    });

    it('should keep internal identifiers and raw payloads out of the task summary', async () => {
        createTestDB();
        const hotel = await seedHotel('Redaction Hotel');

        const result = await SalesBrain.postCall({
            instanceId: hotel.id,
            callId: 'call-redaction',
            phone: '79990000040',
            summary: 'Гость просит администратора по вопросу оплаты.',
            outcome: 'caller_hangup',
            transcript: [{ role: 'user', content: 'Хочу уточнить оплату, позовите администратора' }],
        });

        const task = result.handoff_task;
        assert.ok(task);
        const serialized = JSON.stringify(task);
        assert.ok(!serialized.includes('Bearer'), 'no auth headers in the task');
        assert.ok(!/instanceId"\s*:\s*"?\d+"?\s*,\s*"greenApiToken/.test(serialized), 'no raw instance row');
        // The link is relative: a task must not carry an absolute host.
        assert.ok(task.call_link.startsWith('/logs?'));
        assert.ok(!task.summary.includes('call-redaction'), 'the call id lives in its own field');
    });

    it('should survive a call with no transcript and no signals', async () => {
        createTestDB();
        const hotel = await seedHotel('Empty Call Hotel');

        const result = await SalesBrain.postCall({
            instanceId: hotel.id,
            callId: 'call-empty',
            phone: '79990000041',
            outcome: 'no_answer',
        });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.handoff_task, null);
    });
});
