
'use strict';
const crypto=require('crypto');
const DB=require('../database.service');
const Identity=require('./identity-store');
const Mailer=require('./system-mailer.service');
const fail=(code,statusCode=400,extra={})=>Object.assign(new Error(code),{code,statusCode,...extra});
function key() {
    const secret=String(process.env.SESSION_SECRET || process.env.TWENTY_CREDENTIALS_MASTER_KEY || '');
    if (secret.length<32) throw fail('VERIFICATION_ENCRYPTION_KEY_MISSING',503);
    return crypto.createHash('sha256').update(secret).digest();
}
function encrypt(value) {
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key(),iv);
    const ciphertext=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    return [iv,cipher.getAuthTag(),ciphertext].map(bytes=>bytes.toString('base64url')).join('.');
}
function decrypt(value) {
    const [iv,tag,data]=value.split('.').map(part=>Buffer.from(part,'base64url'));
    const cipher=crypto.createDecipheriv('aes-256-gcm',key(),iv);cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data),cipher.final()]).toString('utf8');
}
function digest(id,code) { return crypto.createHmac('sha256',key()).update(`${id}:${code}`).digest('hex'); }
function invitation(token) {
    const row=Identity.pendingTeamInvitation(token);
    if (row.acceptanceMode!=='team' || row.userEnabled || row.subject) throw fail('INVITATION_EXISTING_ACCOUNT_REQUIRED',409);
    return row;
}
function maskedEmail(address) {
    const [name,domain]=address.split('@');return `${name[0]}***@${domain}`;
}
async function initiateVerification(token,{password}={}) {
    if (typeof password!=='string' || password.length<12 || password.length>256) throw fail('PASSWORD_POLICY');
    const row=invitation(token),now=Date.now(),id=crypto.randomUUID(),code=String(crypto.randomInt(100000,1000000));
    const encrypted=encrypt(password),codeHash=digest(id,code),expiresAtMs=Math.min(now+900000,row.expiresAt),resendAfterMs=now+60000;
    DB.db.transaction(()=>{
        if (DB.get('SELECT COUNT(*) AS n FROM ava_team_email_verifications WHERE invitationId=? AND createdAtMs>?',[row.id,now-3600000]).n>=10) throw fail('IDENTITY_RATE_LIMITED',429);
        const active=DB.get('SELECT resendAfterMs FROM ava_team_email_verifications WHERE invitationId=? AND invitationTokenHash=? AND completedAtMs IS NULL ORDER BY createdAtMs DESC LIMIT 1',[row.id,row.tokenHash]);
        if (active && active.resendAfterMs>now) throw fail('RESEND_COOLDOWN',429,{waitSeconds:Math.ceil((active.resendAfterMs-now)/1000)});
        DB.run('INSERT INTO ava_team_email_verifications(id,invitationId,invitationTokenHash,email,passwordEncrypted,codeHash,resendAfterMs,expiresAtMs,createdAtMs) VALUES (?,?,?,?,?,?,?,?,?)',[id,row.id,row.tokenHash,row.email,encrypted,codeHash,resendAfterMs,expiresAtMs,now]);
    }).immediate();
    try { await Mailer.sendVerificationCodeEmail({to:row.email,code,displayName:row.displayName}); }
    catch(error) { DB.run('DELETE FROM ava_team_email_verifications WHERE id=?',[id]);throw error; }
    return {verificationId:id,maskedEmail:maskedEmail(row.email),resendAfterMs:60000,expiresAtMs};
}
async function resendVerificationCode(token,{verificationId}={}) {
    const invite=invitation(token),now=Date.now(),code=String(crypto.randomInt(100000,1000000));
    const row=DB.db.transaction(()=>{
        const current=DB.get('SELECT * FROM ava_team_email_verifications WHERE id=? AND invitationId=? AND invitationTokenHash=? AND completedAtMs IS NULL AND verifiedAtMs IS NULL',[verificationId,invite.id,invite.tokenHash]);
        if (!current) throw fail('VERIFICATION_NOT_FOUND',404);
        if (current.resendAfterMs>now) throw fail('RESEND_COOLDOWN',429,{waitSeconds:Math.ceil((current.resendAfterMs-now)/1000)});
        if (current.resendCount>=10) throw fail('IDENTITY_RATE_LIMITED',429);
        DB.run('UPDATE ava_team_email_verifications SET codeHash=?,attempts=0,resendCount=resendCount+1,expiresAtMs=?,resendAfterMs=? WHERE id=?',[digest(current.id,code),Math.min(now+900000,invite.expiresAt),now+60000,current.id]);
        return current;
    }).immediate();
    try { await Mailer.sendVerificationCodeEmail({to:row.email,code,displayName:invite.displayName}); }
    catch(error) { DB.run('UPDATE ava_team_email_verifications SET codeHash=?,attempts=?,expiresAtMs=?,resendAfterMs=?,resendCount=? WHERE id=? AND codeHash=?',[row.codeHash,row.attempts,row.expiresAtMs,row.resendAfterMs,row.resendCount,row.id,digest(row.id,code)]);throw error; }
    return {resendAfterMs:60000};
}
function verifyCode(token,{verificationId,code}={}) {
    const invite=invitation(token),now=Date.now();
    if (typeof code!=='string' || !/^\d{6}$/.test(code)) throw fail('INVALID_VERIFICATION_CODE');
    // Commit wrong-attempt increments even when returning an error.
    const result=DB.db.transaction(()=>{
        const row=DB.get('SELECT * FROM ava_team_email_verifications WHERE id=? AND invitationId=? AND invitationTokenHash=? AND completedAtMs IS NULL',[verificationId,invite.id,invite.tokenHash]);
        if (!row) return {error:fail('VERIFICATION_NOT_FOUND',404)};
        if (row.expiresAtMs<=now) return {error:fail('VERIFICATION_CODE_EXPIRED')};
        if (row.attempts>=5) return {error:fail('MAX_ATTEMPTS_EXCEEDED',429)};
        const actual=Buffer.from(digest(row.id,code),'hex'),expected=Buffer.from(row.codeHash,'hex');
        if (actual.length!==expected.length || !crypto.timingSafeEqual(actual,expected)) {
            DB.run('UPDATE ava_team_email_verifications SET attempts=attempts+1 WHERE id=?',[row.id]);
            const remaining=4-row.attempts;return {error:fail(remaining?'INVALID_VERIFICATION_CODE':'MAX_ATTEMPTS_EXCEEDED',remaining?400:429,{attemptsLeft:remaining})};
        }
        const password=decrypt(row.passwordEncrypted);
        DB.run('UPDATE ava_team_email_verifications SET verifiedAtMs=COALESCE(verifiedAtMs,?) WHERE id=?',[now,row.id]);
        return {password,invitationId:invite.id,userId:invite.userId};
    }).immediate();
    if (result.error) throw result.error;return result;
}
function completed(invitationId,verificationId) {
    Identity.ensureSchema();
    const row=DB.get(`SELECT v.completedAtMs,i.state,u.enabled,u.subject FROM ava_team_email_verifications v
        JOIN ava_invitations i ON i.id=v.invitationId JOIN ava_users u ON u.id=i.userId WHERE v.id=? AND v.invitationId=?`,[verificationId,invitationId]);
    return !!(row && row.completedAtMs && row.state==='consumed' && row.enabled && row.subject);
}
module.exports={initiateVerification,resendVerificationCode,verifyCode,completed};
