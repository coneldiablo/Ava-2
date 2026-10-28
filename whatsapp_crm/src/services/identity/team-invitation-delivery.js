'use strict';
const crypto = require('crypto');
const DB = require('../database.service');
const Identity = require('./identity-store');
const Mailer = require('./system-mailer.service');
const { getPublicUrl } = require('./public-url');

function status(invitationId) {
    const row = DB.get('SELECT state,attempts,lastAttemptAt,errorCode FROM ava_team_invitation_delivery WHERE invitationId=?', [invitationId]);
    if (!row) return { state: 'not_attempted', attempts: 0 };
    // A process could stop after DATA reached SMTP and before the ACK was saved.
    // Such an attempt must never be called delivered or retried automatically.
    if (row.state === 'sending' && row.lastAttemptAt <= Date.now() - 60000) {
        return { ...row, state: 'unknown', errorCode: 'SMTP_OUTCOME_UNKNOWN' };
    }
    return row;
}

async function send(actor, businessId, result) {
    const attemptId = crypto.randomUUID(), now = Date.now();
    const invite = DB.db.transaction(() => {
        Identity.authorizeCapability(actor, businessId, 'team.manage');
        const row = Identity.pendingTeamInvitation(result.token);
        if (row.id !== result.invitationId || row.businessId !== businessId || row.acceptanceMode !== 'team' || row.state !== 'pending') {
            throw Object.assign(new Error('INVITATION_INVALID'), { code: 'INVITATION_INVALID', statusCode: 409 });
        }
        const prior = DB.get('SELECT lastAttemptAt FROM ava_team_invitation_delivery WHERE invitationId=?', [row.id]);
        if (prior && prior.lastAttemptAt > now - 60000) throw Object.assign(new Error('INVITATION_RESEND_COOLDOWN'), { code: 'INVITATION_RESEND_COOLDOWN', statusCode: 429 });
        DB.run(`INSERT INTO ava_team_invitation_delivery(invitationId,tokenHash,attemptId,state,attempts,lastAttemptAt)
            VALUES (?,?,?,'sending',1,?) ON CONFLICT(invitationId) DO UPDATE SET
            tokenHash=excluded.tokenHash,attemptId=excluded.attemptId,state='sending',
            attempts=attempts+1,lastAttemptAt=excluded.lastAttemptAt,errorCode=NULL`, [row.id,row.tokenHash,attemptId,now]);
        return row;
    }).immediate();
    const url = new URL('/invite', getPublicUrl()); url.hash = result.token;
    let state = 'smtp_accepted', errorCode = null;
    try {
        await Mailer.sendTeamInvitationEmail({ to: invite.email, displayName: invite.displayName,
            inviteUrl: url.href, role: invite.role });
    } catch (error) {
        const failure = Mailer.classifySmtpFailure(error);
        state = failure.state; errorCode = failure.errorCode;
    }
    DB.run(`UPDATE ava_team_invitation_delivery SET state=?,errorCode=?
        WHERE invitationId=? AND tokenHash=? AND attemptId=?`, [state,errorCode,invite.id,invite.tokenHash,attemptId]);
    return status(invite.id);
}
module.exports = { send, status };
