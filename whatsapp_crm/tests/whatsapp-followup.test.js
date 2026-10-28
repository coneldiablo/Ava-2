const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const SalesBrain = require('../src/services/sales-brain.service');
const ChannelRouter = require('../src/services/channel-router.service');
const HotelProfileService = require('../src/services/hotel-profile.service');

// Every test stubs the channel: this suite must never touch a real WhatsApp API.
function stubChannel(result = { success: true, channel: 'whatsapp' }) {
    const original = ChannelRouter.sendMessageDetailed;
    const sent = [];
    ChannelRouter.sendMessageDetailed = async (instanceId, chatId, text) => {
        sent.push({ instanceId, chatId, text });
        return typeof result === 'function' ? result({ instanceId, chatId, text }) : result;
    };
    return {
        sent,
        restore() { ChannelRouter.sendMessageDetailed = original; },
    };
}

async function seedGuest(hotelName, phone) {
    const hotel = await HotelProfileService.create({ name: hotelName, hotelTimezone: 'Europe/Moscow' });
    const chatId = `${phone}@c.us`;
    await DB.getOrCreateClient(hotel.id, chatId, 'Гость');
    return { hotel, chatId, phone };
}

describe('WhatsApp Follow-up Tests', () => {
    it('should draft from call context with every audit field empty until approval', async () => {
        createTestDB();
        const { hotel, phone } = await seedGuest('Draft Hotel', '79990001001');

        const result = await SalesBrain.draftWhatsAppFollowup({
            instanceId: hotel.id,
            phone,
            callId: 'call-draft-1',
            text: 'Спасибо за звонок! Отправляю детали по номеру.',
        });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.requires_approval, true);
        const draft = result.draft;
        assert.strictEqual(draft.status, 'draft');
        assert.strictEqual(draft.call_id, 'call-draft-1');
        assert.strictEqual(
            draft.call_link,
            `/logs?mode=troubleshoot&call_id=call-draft-1&business_id=${hotel.id}`,
        );
        assert.strictEqual(draft.approved_by, null);
        assert.strictEqual(draft.approved_at, null);
        assert.strictEqual(draft.sent_at, null);
        assert.strictEqual(draft.edited, false);
        assert.strictEqual(draft.original_text, draft.text);
        // The agent must not claim the message went out.
        assert.ok(!result.spoken.includes('Отправил'));
    });

    it('should refuse to send an unapproved draft even when the call says confirmed', async () => {
        createTestDB();
        const { hotel, phone } = await seedGuest('Policy Hotel', '79990001002');
        const channel = stubChannel();

        try {
            const drafted = await SalesBrain.draftWhatsAppFollowup({
                instanceId: hotel.id, phone, callId: 'call-policy', text: 'Детали по брони.',
            });

            // This is the whole point of the task: `confirmed` comes from the
            // LLM and must not be enough to message a guest.
            const result = await SalesBrain.sendWhatsAppFollowup({
                instanceId: hotel.id,
                draftId: drafted.draft_id,
                confirmed: true,
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, 'needs_approval');
            assert.strictEqual(result.requires_approval, true);
            assert.strictEqual(channel.sent.length, 0, 'nothing may reach the guest');
        } finally {
            channel.restore();
        }
    });

    it('should refuse an ad-hoc send with arbitrary text and queue it instead', async () => {
        createTestDB();
        const { hotel, phone } = await seedGuest('Adhoc Hotel', '79990001003');
        const channel = stubChannel();

        try {
            const result = await SalesBrain.sendWhatsAppFollowup({
                instanceId: hotel.id,
                phone,
                text: 'Переведите предоплату по ссылке.',
                confirmed: true,
            });

            assert.strictEqual(result.status, 'needs_approval');
            assert.strictEqual(channel.sent.length, 0);

            // The text is not lost: it lands in the queue for a human.
            const queue = await SalesBrain.listFollowupDrafts({ instanceId: hotel.id });
            assert.strictEqual(queue.drafts.length, 1);
            assert.strictEqual(queue.drafts[0].text, 'Переведите предоплату по ссылке.');
            assert.strictEqual(queue.drafts[0].status, 'draft');
        } finally {
            channel.restore();
        }
    });

    it('should keep the needs_confirmation guard for unconfirmed calls', async () => {
        createTestDB();
        const { hotel, phone } = await seedGuest('Unconfirmed Hotel', '79990001004');
        const channel = stubChannel();

        try {
            const result = await SalesBrain.sendWhatsAppFollowup({
                instanceId: hotel.id, phone, text: 'Детали.', confirmed: false,
            });

            assert.strictEqual(result.status, 'needs_confirmation');
            assert.strictEqual(channel.sent.length, 0);
        } finally {
            channel.restore();
        }
    });

    it('should send once a manager approves and record who approved it', async () => {
        createTestDB();
        const { hotel, chatId, phone } = await seedGuest('Approval Hotel', '79990001005');
        const channel = stubChannel();

        try {
            const drafted = await SalesBrain.draftWhatsAppFollowup({
                instanceId: hotel.id, phone, callId: 'call-approve', text: 'Ждём вас 12 мая.',
            });

            const result = await SalesBrain.approveWhatsAppFollowup({
                instanceId: hotel.id,
                draftId: drafted.draft_id,
                approvedBy: 'Ирина (ресепшен)',
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.sent, true);
            assert.strictEqual(channel.sent.length, 1);
            assert.strictEqual(channel.sent[0].chatId, chatId);
            assert.strictEqual(channel.sent[0].text, 'Ждём вас 12 мая.');

            const draft = result.draft;
            assert.strictEqual(draft.status, 'sent');
            assert.strictEqual(draft.approved_by, 'Ирина (ресепшен)');
            assert.ok(draft.approved_at);
            assert.ok(draft.sent_at);
            assert.strictEqual(draft.attempts, 1);
        } finally {
            channel.restore();
        }
    });

    it('should log the send with approver, edit flag and outcome', async () => {
        createTestDB();
        const { hotel, chatId, phone } = await seedGuest('Audit Hotel', '79990001006');
        const channel = stubChannel();

        try {
            const drafted = await SalesBrain.draftWhatsAppFollowup({
                instanceId: hotel.id, phone, callId: 'call-audit', text: 'Черновик.',
            });
            await SalesBrain.editFollowupDraft({
                instanceId: hotel.id,
                draftId: drafted.draft_id,
                text: 'Отредактированный текст.',
                editedBy: 'Пётр',
            });
            await SalesBrain.approveWhatsAppFollowup({
                instanceId: hotel.id, draftId: drafted.draft_id, approvedBy: 'Пётр',
            });

            const runs = DB.getToolRuns(hotel.id, chatId, 20)
                .filter((run) => run.toolName === 'send_whatsapp_followup');
            assert.strictEqual(runs.length, 1);
            const args = JSON.parse(runs[0].argsRedactedJson);
            const result = JSON.parse(runs[0].resultRedactedJson);
            assert.strictEqual(args.approved_by, 'Пётр');
            assert.ok(args.approved_at);
            assert.strictEqual(args.edited, true);
            assert.strictEqual(args.auto_send_policy, false);
            assert.strictEqual(result.sent, true);
            assert.strictEqual(runs[0].status, 'ok');
            // The message body itself is not copied into the audit args.
            assert.ok(!runs[0].argsRedactedJson.includes('Отредактированный текст'));
        } finally {
            channel.restore();
        }
    });

    it('should drop approval when the text is edited after approving', async () => {
        createTestDB();
        const { hotel, phone } = await seedGuest('Reapprove Hotel', '79990001007');
        const channel = stubChannel({ success: false, error: 'whatsapp_send_failed' });

        try {
            const drafted = await SalesBrain.draftWhatsAppFollowup({
                instanceId: hotel.id, phone, callId: 'call-reapprove', text: 'Первый вариант.',
            });
            // Approve, delivery fails, approval survives.
            await SalesBrain.approveWhatsAppFollowup({
                instanceId: hotel.id, draftId: drafted.draft_id, approvedBy: 'Анна',
            });
            const afterFailure = DB.getFollowupDraft(hotel.id, drafted.draft_id);
            assert.strictEqual(afterFailure.status, 'approved');

            // Editing it now must force a fresh approval of the new text.
            const edited = await SalesBrain.editFollowupDraft({
                instanceId: hotel.id,
                draftId: drafted.draft_id,
                text: 'Второй вариант.',
                editedBy: 'Анна',
            });
            assert.strictEqual(edited.draft.status, 'draft');
            assert.strictEqual(edited.draft.approved_by, null);
            assert.strictEqual(edited.draft.original_text, 'Первый вариант.');
            assert.strictEqual(edited.draft.text, 'Второй вариант.');
        } finally {
            channel.restore();
        }
    });

    it('should never send the same draft twice', async () => {
        createTestDB();
        const { hotel, phone } = await seedGuest('Once Hotel', '79990001008');
        const channel = stubChannel();

        try {
            const drafted = await SalesBrain.draftWhatsAppFollowup({
                instanceId: hotel.id, phone, callId: 'call-once', text: 'Одно сообщение.',
            });
            await SalesBrain.approveWhatsAppFollowup({
                instanceId: hotel.id, draftId: drafted.draft_id, approvedBy: 'Ольга',
            });
            const second = await SalesBrain.approveWhatsAppFollowup({
                instanceId: hotel.id, draftId: drafted.draft_id, approvedBy: 'Ольга',
            });

            assert.strictEqual(second.status, 'already_sent');
            assert.strictEqual(second.idempotent, true);
            assert.strictEqual(channel.sent.length, 1, 'the guest gets exactly one message');
        } finally {
            channel.restore();
        }
    });

    it('should not edit or reject a message already delivered', async () => {
        createTestDB();
        const { hotel, phone } = await seedGuest('Sent Hotel', '79990001009');
        const channel = stubChannel();

        try {
            const drafted = await SalesBrain.draftWhatsAppFollowup({
                instanceId: hotel.id, phone, callId: 'call-sent', text: 'Готово.',
            });
            await SalesBrain.approveWhatsAppFollowup({
                instanceId: hotel.id, draftId: drafted.draft_id, approvedBy: 'Игорь',
            });

            const edit = await SalesBrain.editFollowupDraft({
                instanceId: hotel.id, draftId: drafted.draft_id, text: 'Поздно.',
            });
            assert.strictEqual(edit.success, false);
            assert.strictEqual(edit.error, 'draft_already_sent');

            const reject = await SalesBrain.rejectFollowupDraft({
                instanceId: hotel.id, draftId: drafted.draft_id,
            });
            assert.strictEqual(reject.success, false);
            assert.strictEqual(reject.error, 'invalid_status_transition');
        } finally {
            channel.restore();
        }
    });

    it('should let a manager reject a draft without sending it', async () => {
        createTestDB();
        const { hotel, phone } = await seedGuest('Reject Hotel', '79990001010');
        const channel = stubChannel();

        try {
            const drafted = await SalesBrain.draftWhatsAppFollowup({
                instanceId: hotel.id, phone, callId: 'call-reject', text: 'Не отправлять.',
            });
            const rejected = await SalesBrain.rejectFollowupDraft({
                instanceId: hotel.id, draftId: drafted.draft_id, rejectedBy: 'Марина',
            });

            assert.strictEqual(rejected.success, true);
            assert.strictEqual(rejected.draft.status, 'rejected');
            assert.strictEqual(channel.sent.length, 0);

            const send = await SalesBrain.sendWhatsAppFollowup({
                instanceId: hotel.id, draftId: drafted.draft_id, confirmed: true,
            });
            assert.strictEqual(send.status, 'needs_approval');
            assert.strictEqual(channel.sent.length, 0);
        } finally {
            channel.restore();
        }
    });

    it('per-business post-call opt-in must not authorize an arbitrary ad-hoc tool message', async () => {
        createTestDB();
        const { hotel, phone } = await seedGuest('Auto Hotel', '79990001011');
        await DB.updateInstance(hotel.id, { followupAutoSendEnabled: 1 });
        const channel = stubChannel();

        try {
            const policy = await SalesBrain.followupApprovalPolicy(hotel.id);
            assert.strictEqual(policy.auto_send_enabled, true);
            assert.strictEqual(policy.requires_manager_approval, false);

            const result = await SalesBrain.sendWhatsAppFollowup({
                instanceId: hotel.id, phone, text: 'Автоотправка включена.', confirmed: true,
            });

            assert.strictEqual(result.sent, false);
            assert.strictEqual(result.status, 'needs_approval');
            assert.strictEqual(channel.sent.length, 0);
        } finally {
            channel.restore();
        }
    });

    it('should still require confirmation when auto-send is enabled', async () => {
        createTestDB();
        const { hotel, phone } = await seedGuest('Auto Guard Hotel', '79990001012');
        await DB.updateInstance(hotel.id, { followupAutoSendEnabled: 1 });
        const channel = stubChannel();

        try {
            const result = await SalesBrain.sendWhatsAppFollowup({
                instanceId: hotel.id, phone, text: 'Без подтверждения.', confirmed: false,
            });

            assert.strictEqual(result.status, 'needs_confirmation');
            assert.strictEqual(channel.sent.length, 0);
        } finally {
            channel.restore();
        }
    });

    it('should never leak or send a draft across businesses', async () => {
        createTestDB();
        const a = await seedGuest('Isolated Hotel A', '79990001020');
        const b = await seedGuest('Isolated Hotel B', '79990001021');
        const channel = stubChannel();

        try {
            const drafted = await SalesBrain.draftWhatsAppFollowup({
                instanceId: a.hotel.id, phone: a.phone, callId: 'call-iso', text: 'Текст отеля A.',
            });

            const queueB = await SalesBrain.listFollowupDrafts({ instanceId: b.hotel.id });
            assert.strictEqual(queueB.drafts.length, 0);
            assert.strictEqual(DB.getFollowupDraft(b.hotel.id, drafted.draft_id), undefined);

            const approveFromB = await SalesBrain.approveWhatsAppFollowup({
                instanceId: b.hotel.id, draftId: drafted.draft_id, approvedBy: 'Чужой',
            });
            assert.strictEqual(approveFromB.success, false);
            assert.strictEqual(approveFromB.error, 'draft_not_found');
            assert.strictEqual(channel.sent.length, 0);

            const editFromB = await SalesBrain.editFollowupDraft({
                instanceId: b.hotel.id, draftId: drafted.draft_id, text: 'Подмена.',
            });
            assert.strictEqual(editFromB.error, 'draft_not_found');

            // A's draft is untouched by any of it.
            const original = DB.getFollowupDraft(a.hotel.id, drafted.draft_id);
            assert.strictEqual(original.status, 'draft');
            assert.strictEqual(original.text, 'Текст отеля A.');
        } finally {
            channel.restore();
        }
    });

    it('should link the post-call draft to the handoff task from the same call', async () => {
        createTestDB();
        const { hotel, phone } = await seedGuest('Linked Hotel', '79990001030');
        const channel = stubChannel();

        try {
            const result = await SalesBrain.postCall({
                instanceId: hotel.id,
                callId: 'call-linked',
                phone,
                summary: 'Гость просил администратора по оплате.',
                outcome: 'caller_hangup',
                transcript: [{ role: 'user', content: 'Позовите администратора' }],
                generate_followup: true,
            });

            assert.ok(result.handoff_task, 'the call also opened a manager task');
            assert.ok(result.followup_draft);

            const queue = await SalesBrain.listFollowupDrafts({
                instanceId: hotel.id,
                managerTaskId: result.handoff_task.task_id,
            });
            assert.strictEqual(queue.drafts.length, 1);
            assert.strictEqual(queue.drafts[0].manager_task_id, result.handoff_task.task_id);
            assert.strictEqual(queue.drafts[0].call_id, 'call-linked');
            assert.strictEqual(queue.drafts[0].source, 'post_call');
            assert.strictEqual(channel.sent.length, 0, 'post-call never delivers on its own');
        } finally {
            channel.restore();
        }
    });

    it('should queue one draft per call across repeated post-calls', async () => {
        createTestDB();
        const { hotel, phone } = await seedGuest('Dedupe Followup Hotel', '79990001031');
        const channel = stubChannel();

        try {
            const payload = {
                instanceId: hotel.id,
                callId: 'call-followup-dedupe',
                phone,
                summary: 'Уточнили детали заезда.',
                outcome: 'caller_hangup',
                generate_followup: true,
            };
            await SalesBrain.postCall(payload);
            await SalesBrain.postCall(payload);

            const queue = await SalesBrain.listFollowupDrafts({
                instanceId: hotel.id, callId: 'call-followup-dedupe',
            });
            assert.strictEqual(queue.drafts.length, 1);
        } finally {
            channel.restore();
        }
    });

    it('should filter and count drafts by status inside one business', async () => {
        createTestDB();
        const { hotel, phone } = await seedGuest('Counting Followup Hotel', '79990001040');
        const channel = stubChannel();

        try {
            const first = await SalesBrain.draftWhatsAppFollowup({
                instanceId: hotel.id, phone, callId: 'c-a', text: 'A',
            });
            await SalesBrain.draftWhatsAppFollowup({
                instanceId: hotel.id, phone, callId: 'c-b', text: 'B',
            });
            await SalesBrain.approveWhatsAppFollowup({
                instanceId: hotel.id, draftId: first.draft_id, approvedBy: 'Менеджер',
            });

            const pending = await SalesBrain.listFollowupDrafts({ instanceId: hotel.id, status: 'draft' });
            assert.strictEqual(pending.drafts.length, 1);
            assert.strictEqual(pending.drafts[0].text, 'B');
            assert.strictEqual(pending.counts.draft, 1);
            assert.strictEqual(pending.counts.sent, 1);
            assert.strictEqual(pending.policy.requires_manager_approval, true);

            const invalid = await SalesBrain.listFollowupDrafts({ instanceId: hotel.id, status: 'nope' });
            assert.strictEqual(invalid.success, false);
        } finally {
            channel.restore();
        }
    });

    it('should allow a retry after a delivery failure without re-approving', async () => {
        createTestDB();
        const { hotel, phone } = await seedGuest('Retry Hotel', '79990001050');
        let failNext = true;
        const channel = stubChannel(() => {
            if (failNext) {
                failNext = false;
                return { success: false, error: 'whatsapp_send_failed', state: 'error' };
            }
            return { success: true, channel: 'whatsapp' };
        });

        try {
            const drafted = await SalesBrain.draftWhatsAppFollowup({
                instanceId: hotel.id, phone, callId: 'call-retry', text: 'Повтор.',
            });
            const failed = await SalesBrain.approveWhatsAppFollowup({
                instanceId: hotel.id, draftId: drafted.draft_id, approvedBy: 'Дежурный',
            });
            assert.strictEqual(failed.sent, false);
            assert.strictEqual(failed.draft.status, 'failed');
            assert.strictEqual(failed.draft.failure_reason, 'whatsapp_send_failed');

            const retried = await SalesBrain.sendWhatsAppFollowup({
                instanceId: hotel.id, draftId: drafted.draft_id, confirmed: true,
            });
            assert.strictEqual(retried.sent, true);
            assert.strictEqual(retried.draft.status, 'sent');
            assert.strictEqual(retried.draft.approved_by, 'Дежурный');
            assert.strictEqual(retried.draft.attempts, 2);
        } finally {
            channel.restore();
        }
    });
});
