const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const routes = require('../src/routes/api.routes');

const LOCKED_ERROR = 'sequence_has_unfinished_enrollments';

function routeHandler(method, path) {
    const layer = routes.stack.find(item => item.route?.path === path && item.route.methods[method]);
    if (!layer) throw new Error(`route_not_found:${method}:${path}`);
    return layer.route.stack.at(-1).handle;
}

async function invoke(handler, params, body = {}) {
    let status = 200;
    let json;
    await handler({ params, body }, {
        status(value) { status = value; return this; },
        json(value) { json = value; return this; }
    });
    return { status, body: json };
}

describe('Sequence step mutation safety', () => {
    it('exposes unfinished enrollment counts and blocks every step mutation atomically', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Live sequence' });
        const sequence = await DB.createSequence(instance.id, { name: 'Follow-up' });
        const first = await DB.addSequenceStep(sequence.id, { stepOrder: 1, delayMinutes: 0, messageTemplate: 'First' });
        await DB.addSequenceStep(sequence.id, { stepOrder: 2, delayMinutes: 60, messageTemplate: 'Second' });
        await DB.assignClientToSequence(instance.id, '79990001005@c.us', sequence.id);
        DB.run("INSERT INTO client_sequences(instanceId,chatId,sequenceId,currentStep,status,nextStepAt) VALUES (?,?,?,?,?,datetime('now'))",
            [instance.id, '79990001007@c.us', sequence.id, 0, 'paused']);
        DB.run("INSERT INTO client_sequences(instanceId,chatId,sequenceId,currentStep,status,nextStepAt) VALUES (?,?,?,?,?,datetime('now'))",
            [instance.id, '79990001002@c.us', sequence.id, 0, 'delivery_failed']);
        DB.run("INSERT INTO client_sequences(instanceId,chatId,sequenceId,currentStep,status,nextStepAt) VALUES (?,?,?,?,?,datetime('now'))",
            [instance.id, '79990001006@c.us', sequence.id, 2, 'completed']);

        const listed = await DB.getSequences(instance.id);
        assert.strictEqual(listed[0].unfinishedEnrollmentCount, 3);
        assert.strictEqual(listed[0].deliveryFailureCount, 1);
        assert.strictEqual(await DB.getSequenceUnfinishedEnrollmentCount(sequence.id), 3);

        for (const action of [
            () => DB.addSequenceStep(sequence.id, { messageTemplate: 'Do not add' }),
            () => DB.updateSequenceStep(first.id, { messageTemplate: 'Do not update' }),
            () => DB.deleteSequenceStep(first.id),
        ]) {
            await assert.rejects(action, error => {
                assert.strictEqual(error.code, LOCKED_ERROR);
                assert.strictEqual(error.statusCode, 409);
                assert.strictEqual(error.unfinishedEnrollmentCount, 3);
                return true;
            });
        }

        const steps = await DB.getSequenceSteps(sequence.id);
        assert.strictEqual(steps.length, 2);
        assert.strictEqual(steps[0].messageTemplate, 'First');
    });

    it('returns a stable 409 route contract and the steps endpoint includes the count', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'API live sequence' });
        const sequence = await DB.createSequence(instance.id, { name: 'Follow-up' });
        const first = await DB.addSequenceStep(sequence.id, { stepOrder: 1, delayMinutes: 0, messageTemplate: 'First' });
        await DB.assignClientToSequence(instance.id, '79990001005@c.us', sequence.id);
        const params = { instanceId: String(instance.id), seqId: String(sequence.id), stepId: String(first.id) };

        const getSteps = await invoke(routeHandler('get', '/sequences/:instanceId/:seqId/steps'), params);
        assert.strictEqual(getSteps.status, 200);
        assert.strictEqual(getSteps.body.unfinishedEnrollmentCount, 1);
        assert.strictEqual(getSteps.body.steps.length, 1);

        for (const [method, path, body] of [
            ['post', '/sequences/:instanceId/:seqId/steps', { messageTemplate: 'Blocked add' }],
            ['put', '/sequences/:instanceId/:seqId/steps/:stepId', { messageTemplate: 'Blocked update' }],
            ['delete', '/sequences/:instanceId/:seqId/steps/:stepId', {}],
        ]) {
            const result = await invoke(routeHandler(method, path), params, body);
            assert.strictEqual(result.status, 409);
            assert.deepStrictEqual(result.body, {
                success: false,
                error: LOCKED_ERROR,
                unfinishedEnrollmentCount: 1
            });
        }
    });

    it('allows step mutations once enrollments are finished', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Finished sequence' });
        const sequence = await DB.createSequence(instance.id, { name: 'Follow-up' });
        const first = await DB.addSequenceStep(sequence.id, { stepOrder: 1, delayMinutes: 0, messageTemplate: 'First' });
        await DB.assignClientToSequence(instance.id, '79990001006@c.us', sequence.id);
        DB.run("UPDATE client_sequences SET status='completed', currentStep=1 WHERE sequenceId=?", [sequence.id]);

        assert.strictEqual(await DB.getSequenceUnfinishedEnrollmentCount(sequence.id), 0);
        const second = await DB.addSequenceStep(sequence.id, { messageTemplate: 'Second' });
        const updated = await DB.updateSequenceStep(second.id, { messageTemplate: 'Updated second' });
        assert.strictEqual(updated.messageTemplate, 'Updated second');
        await DB.deleteSequenceStep(first.id);

        const steps = await DB.getSequenceSteps(sequence.id);
        assert.deepStrictEqual(steps.map(step => step.messageTemplate), ['Updated second']);
    });

    it('enrolls a client while holding the immediate transaction before reading the first step', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Assignment lock' });
        const sequence = await DB.createSequence(instance.id, { name: 'Follow-up' });
        await DB.addSequenceStep(sequence.id, { stepOrder: 1, delayMinutes: 0, messageTemplate: 'First' });
        // Prepare identity migrations before instrumenting the sequence transaction.
        require('../src/services/client-identity.service').resolve(instance.id, '79990001001@c.us');
        const originalTransaction = DB.db.transaction.bind(DB.db);
        const originalGet = DB.get.bind(DB);
        let insideImmediate = false;
        let checkedFirstStepInsideImmediate = false;
        DB.db.transaction = fn => ({
            immediate: (...args) => {
                insideImmediate = true;
                try {
                    return originalTransaction(fn).immediate(...args);
                } finally {
                    insideImmediate = false;
                }
            }
        });
        DB.get = (sql, params = []) => {
            if (String(sql).includes('FROM sequence_steps')) {
                checkedFirstStepInsideImmediate = true;
                assert.strictEqual(insideImmediate, true);
            }
            return originalGet(sql, params);
        };
        try {
            const assigned = await DB.assignClientToSequence(instance.id, '79990001001@c.us', sequence.id);
            const duplicate = await DB.assignClientToSequence(instance.id, '79990001001@c.us', sequence.id);
            assert.strictEqual(duplicate.id, assigned.id);
            assert.strictEqual(checkedFirstStepInsideImmediate, true);
        } finally {
            DB.get = originalGet;
            DB.db.transaction = originalTransaction;
        }
    });
});
