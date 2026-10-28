const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const SequenceService = require('../src/services/sequence.service');

describe('Sequence delivery safety', () => {
    it('does not enroll or deliver a disabled sequence, including a stale worker item', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Paused sequence' });
        await DB.updateInstance(instance.id, { smartTriggersEnabled: 1 });
        const sequence = await DB.createSequence(instance.id, { name: 'Follow-up' });
        await DB.addSequenceStep(sequence.id, { delayMinutes: 0, messageTemplate: 'Hello' });
        const assigned = await DB.assignClientToSequence(instance.id, '79990001001@c.us', sequence.id);
        const staleDue = (await DB.getActiveClientSequences()).find(item => item.id === assigned.id);
        assert.ok(staleDue);
        await DB.updateSequence(sequence.id, { isActive: 0 });
        assert.ok(!(await DB.getActiveClientSequences()).some(item => item.id === assigned.id));
        await assert.rejects(() => DB.assignClientToSequence(instance.id, '79990001003@c.us', sequence.id),
            error => error.code === 'sequence_disabled');
        assert.strictEqual(await DB.claimClientSequenceDelivery(staleDue, 'whatsapp'), false);
        const previous = SequenceService._channelRouter;
        let sends = 0;
        SequenceService._channelRouter = { sendMessage: async () => { sends++; return true; } };
        try {
            await SequenceService._processSequenceStep(staleDue);
            assert.strictEqual(sends, 0);
            assert.strictEqual(DB.get('SELECT status FROM client_sequences WHERE id = ?', [assigned.id]).status, 'active');
            await DB.updateSequence(sequence.id, { isActive: 1 });
            assert.ok((await DB.getActiveClientSequences()).some(item => item.id === assigned.id));
            await SequenceService._processSequenceStep(staleDue);
            assert.strictEqual(sends, 1);
        } finally { SequenceService._channelRouter = previous; }
    });

    it('keeps a failed step out of future polls and reports a scoped failure count', async () => {
        createTestDB();
        const own = await DB.createInstance({ name: 'Own' });
        const other = await DB.createInstance({ name: 'Other' });
        await DB.updateInstance(own.id, { smartTriggersEnabled: 1 });
        const sequence = await DB.createSequence(own.id, { name: 'Follow-up' });
        await DB.addSequenceStep(sequence.id, { delayMinutes: 0, messageTemplate: 'Hello' });
        const assigned = await DB.assignClientToSequence(own.id, '79990001001@c.us', sequence.id);
        const due = (await DB.getActiveClientSequences()).find(item => item.id === assigned.id);
        const previous = SequenceService._channelRouter;
        let sends = 0;
        SequenceService._channelRouter = { sendMessage: async () => { sends++; return false; } };
        try {
            await SequenceService._processSequenceStep(due);
            await SequenceService._processSequenceStep(due);
            await SequenceService._processSequences();
            assert.strictEqual(sends, 1);
            const saved = DB.get('SELECT status, currentStep, deliveryFailureCode, deliveryAttemptAt FROM client_sequences WHERE id = ?', [assigned.id]);
            assert.strictEqual(saved.status, 'delivery_failed');
            assert.strictEqual(saved.currentStep, 0);
            assert.strictEqual(saved.deliveryFailureCode, 'send_returned_false');
            assert.ok(saved.deliveryAttemptAt);
            assert.strictEqual((await DB.assignClientToSequence(own.id, '79990001001@c.us', sequence.id)).id, assigned.id);
            assert.strictEqual((await DB.getSequences(own.id))[0].deliveryFailureCount, 1);
            assert.deepStrictEqual(await DB.getSequences(other.id), []);
        } finally { SequenceService._channelRouter = previous; }
    });

    it('advances a confirmed send while an exception leaves the step blocked', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Sequence delivery' });
        await DB.updateInstance(instance.id, { smartTriggersEnabled: 1 });
        const sequence = await DB.createSequence(instance.id, { name: 'Two steps' });
        await DB.addSequenceStep(sequence.id, { delayMinutes: 0, messageTemplate: 'One' });
        await DB.addSequenceStep(sequence.id, { delayMinutes: 60, messageTemplate: 'Two' });
        const success = await DB.assignClientToSequence(instance.id, '79990001004@c.us', sequence.id);
        const failed = await DB.assignClientToSequence(instance.id, '79990001002@c.us', sequence.id);
        const previous = SequenceService._channelRouter;
        try {
            SequenceService._channelRouter = { sendMessage: async (_id, chatId) => {
                if (chatId === '79990001002@c.us') throw new Error('unconfirmed provider result');
                return true;
            } };
            const due = await DB.getActiveClientSequences();
            await SequenceService._processSequenceStep(due.find(item => item.id === success.id));
            await SequenceService._processSequenceStep(due.find(item => item.id === failed.id));
            const advanced = DB.get('SELECT * FROM client_sequences WHERE id = ?', [success.id]);
            const blocked = DB.get('SELECT * FROM client_sequences WHERE id = ?', [failed.id]);
            assert.strictEqual(advanced.currentStep, 1);
            assert.strictEqual(advanced.status, 'active');
            assert.strictEqual(advanced.deliveryFailureCode, null);
            assert.strictEqual(blocked.currentStep, 0);
            assert.strictEqual(blocked.status, 'delivery_failed');
            assert.strictEqual(blocked.deliveryFailureCode, 'send_exception');
        } finally { SequenceService._channelRouter = previous; }
    });

    it('does not resend after provider acceptance if recording the next step fails', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Ambiguous persistence' });
        await DB.updateInstance(instance.id, { smartTriggersEnabled: 1 });
        const sequence = await DB.createSequence(instance.id, { name: 'Persistence failure' });
        await DB.addSequenceStep(sequence.id, { delayMinutes: 0, messageTemplate: 'Hello' });
        const assigned = await DB.assignClientToSequence(instance.id, '79990001001@c.us', sequence.id);
        const due = (await DB.getActiveClientSequences()).find(item => item.id === assigned.id);
        const previousRouter = SequenceService._channelRouter;
        const previousUpdate = DB.updateClientSequence;
        let sends = 0;
        try {
            SequenceService._channelRouter = { sendMessage: async () => { sends++; return true; } };
            DB.updateClientSequence = async () => { throw new Error('database unavailable after send'); };
            await SequenceService._processSequenceStep(due);
            DB.updateClientSequence = previousUpdate;
            await SequenceService._processSequences();
            assert.strictEqual(sends, 1);
            const saved = DB.get('SELECT status, deliveryFailureCode FROM client_sequences WHERE id = ?', [assigned.id]);
            assert.strictEqual(saved.status, 'delivery_failed');
            assert.strictEqual(saved.deliveryFailureCode, 'outcome_unknown');
        } finally {
            DB.updateClientSequence = previousUpdate;
            SequenceService._channelRouter = previousRouter;
        }
    });
});
