'use strict';
const DB = require('./database.service');
const Store = require('./ava-workspace.store');
const Canonical = require('./client-identity.service');
const Collaboration = require('./ava-collaboration.service');

function fail(code) { throw Object.assign(new Error(code), { code, statusCode: 409, safeToRetry: true }); }

// Internal channel snapshot. Unlike the public control view, this includes the
// exact send lease so a caller can revalidate its own dispatch without admitting
// another sender or an unresolved provider outcome.
function capture(instanceId, chatId) {
    Store.ensureSchema();
    Collaboration.ensureSchema();
    return DB.db.transaction(() => {
        const client = Store.scope(instanceId, chatId);
        Store.getControl(client.instanceId, client.chatId);
        const row = DB.get('SELECT * FROM ava_conversation_control WHERE businessId=? AND chatId=?', [client.instanceId, client.chatId]);
        return {
            businessId: Number(client.instanceId), chatId: client.chatId,
            dialogueRevision: String(DB.get('SELECT revision FROM ava_dialogue_revisions WHERE businessId=? AND chatId=?', [client.instanceId, client.chatId])?.revision || 1),
            controlRevision: row.revision, mode: row.mode,
            activeSendId: row.activeSendId || null, activeSendStatus: row.activeSendStatus || null
        };
    }).immediate();
}

function assertCanSend(instanceId, chatId, snapshot, { origin, sendId } = {}) {
    const businessId = Number(instanceId);
    if (!snapshot || snapshot.businessId !== businessId ||
        Canonical.resolve(businessId, chatId) !== snapshot.chatId) fail('WORKSPACE_DIALOGUE_CHANGED');
    const current = capture(businessId, chatId);
    const human = origin === 'authenticated_customer_reply';
    if (!human && current.mode !== 'ai') fail('WORKSPACE_HUMAN_CONTROL');
    if (current.mode !== snapshot.mode || current.controlRevision !== snapshot.controlRevision) fail('WORKSPACE_CONTROL_CONFLICT');
    if (current.activeSendId !== snapshot.activeSendId || current.activeSendStatus === 'unknown' ||
        current.activeSendId && current.activeSendId !== sendId) fail('WORKSPACE_SEND_IN_PROGRESS');
    if (current.activeSendId && current.activeSendStatus !== 'sending') fail('WORKSPACE_SEND_IN_PROGRESS');
    if (current.dialogueRevision !== snapshot.dialogueRevision) fail('WORKSPACE_DIALOGUE_CHANGED');
    return current;
}

module.exports = { capture, assertCanSend };
