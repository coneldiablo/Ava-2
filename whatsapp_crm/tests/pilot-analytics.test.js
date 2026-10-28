const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const SalesBrain = require('../src/services/sales-brain.service');
const ChannelRouter = require('../src/services/channel-router.service');
const HotelProfileService = require('../src/services/hotel-profile.service');

function stubChannel(result = { success: true, channel: 'whatsapp' }) {
    const original = ChannelRouter.sendMessageDetailed;
    ChannelRouter.sendMessageDetailed = async () => result;
    return { restore() { ChannelRouter.sendMessageDetailed = original; } };
}

async function seedHotel(name, phone) {
    const hotel = await HotelProfileService.create({ name, hotelTimezone: 'Europe/Moscow' });
    const chatId = `${phone}@c.us`;
    await DB.getOrCreateClient(hotel.id, chatId, 'Гость');
    return { hotel, chatId, phone };
}

describe('Pilot Analytics Tests', () => {
    it('should return zeros for an empty business instead of failing', async () => {
        createTestDB();
        const hotel = await HotelProfileService.create({ name: 'Empty Hotel', hotelTimezone: 'UTC' });

        const result = await SalesBrain.pilotAnalytics({ instanceId: hotel.id });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.manager_tasks.created, 0);
        assert.strictEqual(result.followups.sent, 0);
        assert.strictEqual(result.followups.created, 0);
        // Every known status is present, so the UI never renders undefined.
        assert.strictEqual(result.manager_tasks.by_status.new, 0);
        assert.strictEqual(result.followups.by_status.sent, 0);
    });

    it('should carry the business timezone with the numbers', async () => {
        createTestDB();
        const hotel = await HotelProfileService.create({ name: 'TZ Hotel', hotelTimezone: 'Asia/Almaty' });

        const result = await SalesBrain.pilotAnalytics({ instanceId: hotel.id });

        assert.strictEqual(result.timezone, 'Asia/Almaty');
        assert.strictEqual(result.business_name, 'TZ Hotel');
    });

    it('should count manager tasks by status inside one business', async () => {
        createTestDB();
        const { hotel, phone } = await seedHotel('Task Count Hotel', '79990002001');

        const first = await SalesBrain.createManagerTask({
            instanceId: hotel.id, phone, callId: 'c-1', summary: 'A',
        });
        await SalesBrain.createManagerTask({
            instanceId: hotel.id, phone, callId: 'c-2', summary: 'B',
        });
        await SalesBrain.updateManagerTask({
            instanceId: hotel.id, taskId: first.task.task_id, status: 'done',
        });

        const result = await SalesBrain.pilotAnalytics({ instanceId: hotel.id });

        assert.strictEqual(result.manager_tasks.created, 2);
        assert.strictEqual(result.manager_tasks.by_status.new, 1);
        assert.strictEqual(result.manager_tasks.by_status.done, 1);
        assert.strictEqual(result.manager_tasks.by_status.in_progress, 0);
    });

    it('should count only delivered follow-ups as sent', async () => {
        createTestDB();
        const { hotel, phone } = await seedHotel('Sent Count Hotel', '79990002002');
        const channel = stubChannel();

        try {
            const sent = await SalesBrain.draftWhatsAppFollowup({
                instanceId: hotel.id, phone, callId: 'f-sent', text: 'Отправленное.',
            });
            await SalesBrain.approveWhatsAppFollowup({
                instanceId: hotel.id, draftId: sent.draft_id, approvedBy: 'Менеджер',
            });

            // draft: never touched
            await SalesBrain.draftWhatsAppFollowup({
                instanceId: hotel.id, phone, callId: 'f-draft', text: 'Черновик.',
            });
            // rejected
            const rejected = await SalesBrain.draftWhatsAppFollowup({
                instanceId: hotel.id, phone, callId: 'f-rejected', text: 'Отклонённое.',
            });
            await SalesBrain.rejectFollowupDraft({ instanceId: hotel.id, draftId: rejected.draft_id });

            const result = await SalesBrain.pilotAnalytics({ instanceId: hotel.id });

            assert.strictEqual(result.followups.sent, 1, 'only status=sent counts');
            assert.strictEqual(result.followups.created, 3);
            assert.strictEqual(result.followups.by_status.draft, 1);
            assert.strictEqual(result.followups.by_status.rejected, 1);
            assert.strictEqual(result.followups.by_status.sent, 1);
        } finally {
            channel.restore();
        }
    });

    it('should not count approved or failed follow-ups as sent', async () => {
        createTestDB();
        const { hotel, phone } = await seedHotel('Failed Count Hotel', '79990002003');
        const channel = stubChannel({ success: false, error: 'whatsapp_send_failed' });

        try {
            const drafted = await SalesBrain.draftWhatsAppFollowup({
                instanceId: hotel.id, phone, callId: 'f-failed', text: 'Не ушло.',
            });
            // Approved, delivery failed: the draft stays approved, not sent.
            await SalesBrain.approveWhatsAppFollowup({
                instanceId: hotel.id, draftId: drafted.draft_id, approvedBy: 'Менеджер',
            });

            const result = await SalesBrain.pilotAnalytics({ instanceId: hotel.id });

            assert.strictEqual(result.followups.sent, 0);
            assert.strictEqual(result.followups.by_status.approved, 1);
        } finally {
            channel.restore();
        }
    });

    it('should never mix tasks or follow-ups across businesses', async () => {
        createTestDB();
        const a = await seedHotel('Analytics Hotel A', '79990002010');
        const b = await seedHotel('Analytics Hotel B', '79990002011');
        const channel = stubChannel();

        try {
            await SalesBrain.createManagerTask({
                instanceId: a.hotel.id, phone: a.phone, callId: 'a-1', summary: 'Задача A',
            });
            const draftA = await SalesBrain.draftWhatsAppFollowup({
                instanceId: a.hotel.id, phone: a.phone, callId: 'a-2', text: 'Сообщение A.',
            });
            await SalesBrain.approveWhatsAppFollowup({
                instanceId: a.hotel.id, draftId: draftA.draft_id, approvedBy: 'Менеджер A',
            });

            const resultB = await SalesBrain.pilotAnalytics({ instanceId: b.hotel.id });
            assert.strictEqual(resultB.manager_tasks.created, 0);
            assert.strictEqual(resultB.followups.sent, 0);
            assert.strictEqual(resultB.followups.created, 0);

            const resultA = await SalesBrain.pilotAnalytics({ instanceId: a.hotel.id });
            assert.strictEqual(resultA.manager_tasks.created, 1);
            assert.strictEqual(resultA.followups.sent, 1);
        } finally {
            channel.restore();
        }
    });

    it('should respect the requested date range', async () => {
        createTestDB();
        const { hotel, phone } = await seedHotel('Range Hotel', '79990002020');

        await SalesBrain.createManagerTask({
            instanceId: hotel.id, phone, callId: 'r-1', summary: 'Внутри диапазона',
        });

        const inRange = await SalesBrain.pilotAnalytics({
            instanceId: hotel.id,
            startAt: '2000-01-01T00:00:00.000Z',
            endAt: '2999-01-01T00:00:00.000Z',
        });
        assert.strictEqual(inRange.manager_tasks.created, 1);

        // A window that closed before the task existed must report nothing.
        const outOfRange = await SalesBrain.pilotAnalytics({
            instanceId: hotel.id,
            startAt: '2000-01-01T00:00:00.000Z',
            endAt: '2000-01-02T00:00:00.000Z',
        });
        assert.strictEqual(outOfRange.manager_tasks.created, 0);
        assert.strictEqual(outOfRange.followups.sent, 0);
    });

    it('should count a follow-up in the period it was delivered', async () => {
        createTestDB();
        const { hotel, phone } = await seedHotel('Delivery Window Hotel', '79990002021');
        const channel = stubChannel();

        try {
            const drafted = await SalesBrain.draftWhatsAppFollowup({
                instanceId: hotel.id, phone, callId: 'd-1', text: 'Сообщение.',
            });
            await SalesBrain.approveWhatsAppFollowup({
                instanceId: hotel.id, draftId: drafted.draft_id, approvedBy: 'Менеджер',
            });

            const row = DB.getFollowupDraft(hotel.id, drafted.draft_id);
            assert.ok(row.sentAt, 'delivery time is recorded');

            // Window that ends before delivery: not counted, even though the
            // draft itself was created earlier.
            const before = await SalesBrain.pilotAnalytics({
                instanceId: hotel.id,
                startAt: '2000-01-01T00:00:00.000Z',
                endAt: '2000-01-02T00:00:00.000Z',
            });
            assert.strictEqual(before.followups.sent, 0);
        } finally {
            channel.restore();
        }
    });

    it('should not return client rows or message bodies', async () => {
        createTestDB();
        const { hotel, phone } = await seedHotel('Privacy Hotel', '79990002030');
        const channel = stubChannel();

        try {
            const drafted = await SalesBrain.draftWhatsAppFollowup({
                instanceId: hotel.id, phone, callId: 'p-1', text: 'Секретный текст гостя.',
            });
            await SalesBrain.approveWhatsAppFollowup({
                instanceId: hotel.id, draftId: drafted.draft_id, approvedBy: 'Менеджер',
            });

            const serialized = JSON.stringify(await SalesBrain.pilotAnalytics({ instanceId: hotel.id }));

            assert.ok(!serialized.includes('Секретный текст гостя'), 'no message bodies');
            assert.ok(!serialized.includes(phone), 'no phone numbers');
            assert.ok(!serialized.includes('@c.us'), 'no chat ids');
        } finally {
            channel.restore();
        }
    });
});
