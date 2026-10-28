'use strict';
const net = require('net');
const nodemailer = require('nodemailer');
const { describe, it, assert, createTestDB } = require('./test-helper');
const express = require('express');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Mailer = require('../src/services/identity/system-mailer.service');
const Delivery = require('../src/services/identity/team-invitation-delivery');
const Verification = require('../src/services/identity/team-verification-store');
const origin = 'https://team.example.test';

async function fixture(test) {
    const previousUrl = process.env.WHATSAPP_CRM_PUBLIC_URL, previousAccess=process.env.AVA_CUSTOMER_ACCESS_ENABLED, previousMailer = Mailer._transporter;
    process.env.AVA_CUSTOMER_ACCESS_ENABLED='true';
    process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
    createTestDB(); Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Fixture A'),(2,'Fixture B')");
    const platform = { platformRole: 'platform_admin', userId: 'fixture-operator' };
    const member = (email,businessId,role) => {
        const invite = Identity.createInvitation(platform,{email,businessId,role});
        return Identity.completeInvitation(Identity.claimInvitation(invite.token),`fixture-${email}`);
    };
    const owner = member('owner@example.test',1,'hotel_owner'), foreign = member('foreign@example.test',2,'hotel_owner');
    const cookies={owner:`crm_session=ava2:${Identity.createSession(owner.subject)}`,foreign:`crm_session=ava2:${Identity.createSession(foreign.subject)}`};
    const smtp = { messages: [], reject: false, loseAck: false, sockets: new Set() };
    const server = net.createServer(socket => {
        smtp.sockets.add(socket); socket.on('close',()=>smtp.sockets.delete(socket));
        socket.write('220 fixture ESMTP\r\n');
        let pending='', data=false, message='';
        socket.on('data',chunk=>{
            pending+=chunk.toString();
            while(pending.includes('\r\n')) {
                const end=pending.indexOf('\r\n'),line=pending.slice(0,end);pending=pending.slice(end+2);
                if(data) {
                    if(line==='.') { data=false; smtp.messages.push(message);message='';
                        if(smtp.loseAck) socket.destroy(); else socket.write('250 accepted\r\n');
                    } else message+=line+'\r\n';
                } else if(/^EHLO|HELO/.test(line)) socket.write('250 fixture\r\n');
                else if(/^MAIL FROM/.test(line)) socket.write('250 sender ok\r\n');
                else if(/^RCPT TO/.test(line)) socket.write(smtp.reject?'550 rejected\r\n':'250 recipient ok\r\n');
                else if(line==='DATA') {data=true;socket.write('354 send data\r\n');}
                else if(line==='QUIT') socket.end('221 bye\r\n');
                else socket.write('250 ok\r\n');
            }
        });
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    Mailer._transporter=nodemailer.createTransport({host:'127.0.0.1',port:server.address().port,secure:false,ignoreTLS:true,socketTimeout:1000});
    const app=express();app.use(express.json());
    app.use((req,_res,next)=>{req.auth=req.headers['x-fixture-foreign']?foreign:owner;next();});
    // Exercise the application's default-deny inventory as well as its handler.
    app.use('/api',require('../src/services/identity/customer-role-boundary'));
    app.use('/api',require('../src/routes/customer-team.routes'));
    const web=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
    const request=async(method,path,body,headers={})=>{
        const response=await fetch(`http://127.0.0.1:${web.address().port}/api/businesses/1/team${path}`,{
            method,headers:{'Content-Type':'application/json',Origin:origin,Cookie:headers['x-fixture-foreign']?cookies.foreign:cookies.owner,...headers},...(body?{body:JSON.stringify(body)}:{})});
        return {status:response.status,data:await response.json()};
    };
    try {await test({owner,smtp,request});} finally {
        await new Promise(resolve=>web.close(resolve));
        for(const socket of smtp.sockets)socket.destroy();
        await new Promise(resolve=>server.close(resolve));
        Mailer._transporter=previousMailer;
        if(previousUrl===undefined)delete process.env.WHATSAPP_CRM_PUBLIC_URL;else process.env.WHATSAPP_CRM_PUBLIC_URL=previousUrl;
        if(previousAccess===undefined)delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;else process.env.AVA_CUSTOMER_ACCESS_ENABLED=previousAccess;
    }
}

describe('Staff invitation HTTP/SQLite/SMTP delivery',()=>{
    it('sends an exact recipient through real SMTP and persists acceptance without persisting token or message',()=>fixture(async({smtp,request})=>{
        const result=await request('POST','/invitations',{email:'new@example.test',role:'observer',displayName:'Fixture'});
        assert.equal(result.status,201);assert.equal(result.data.delivery.state,'smtp_accepted');
        assert.equal(result.data.delivery.attempts,1);assert.equal(smtp.messages.length,1);
        assert.ok(smtp.messages[0].includes('new@example.test'));
        const list=await request('GET','');assert.equal(list.data.invitations[0].delivery.state,'smtp_accepted');
        const stored=DB.get('SELECT * FROM ava_team_invitation_delivery WHERE invitationId=?',[result.data.invitationId]);
        assert.equal(JSON.stringify(stored).includes(result.data.inviteUrl.split('#')[1]),false);
        assert.equal(JSON.stringify(stored).includes('new@example.test'),false);
        assert.equal(Identity.inspectInvitation(result.data.inviteUrl.split('#')[1]).role,'observer');
    }));
    it('persists recipient rejection, allows bounded resend with token rotation, denies cross-business and cross-origin retries',()=>fixture(async({smtp,request})=>{
        smtp.reject=true;
        const created=await request('POST','/invitations',{email:'retry@example.test'});
        assert.equal(created.status,201);assert.equal(created.data.delivery.state,'failed');
        assert.equal(created.data.delivery.errorCode,'SMTP_RECIPIENT_REJECTED');
        const path=`/invitations/${created.data.invitationId}/resend`;
        assert.equal((await request('POST',path,{})).status,429);
        assert.equal((await request('POST',path,{}, {'x-fixture-foreign':'yes'})).status,403);
        assert.equal((await request('POST',path,{}, {Origin:'https://foreign.example.test'})).status,403);
        DB.run('UPDATE ava_team_invitation_delivery SET lastAttemptAt=0');smtp.reject=false;
        const resent=await request('POST',path,{});assert.equal(resent.status,200);
        assert.equal(resent.data.delivery.state,'smtp_accepted');assert.equal(resent.data.delivery.attempts,2);
        assert.notEqual(resent.data.inviteUrl,created.data.inviteUrl);
        assert.throws(()=>Identity.inspectInvitation(created.data.inviteUrl.split('#')[1]),{code:'INVITATION_INVALID'});
        assert.equal(Identity.inspectInvitation(resent.data.inviteUrl.split('#')[1]).businessId,1);
    }));
    it('does not call a lost SMTP ACK delivered and reports interrupted old attempts as unknown',()=>fixture(async({smtp,request})=>{
        smtp.loseAck=true;
        const created=await request('POST','/invitations',{email:'unknown@example.test'});
        assert.equal(created.data.delivery.state,'unknown');assert.equal(created.data.delivery.errorCode,'SMTP_OUTCOME_UNKNOWN');
        assert.equal(smtp.messages.length,1);
        DB.run("UPDATE ava_team_invitation_delivery SET state='sending',lastAttemptAt=0");
        assert.equal(Delivery.status(created.data.invitationId).state,'unknown');
        assert.equal(smtp.messages.length,1);
    }));
    it('shows historical link-only invitations honestly and never sends revoked invitations',()=>fixture(async({owner,smtp,request})=>{
        const old=Identity.inviteBusinessMember(owner,1,{email:'historical@example.test'});
        assert.equal((await request('GET','')).data.invitations[0].delivery.state,'not_attempted');
        Identity.revokeBusinessInvitation(owner,1,old.invitationId);
        assert.equal((await request('POST',`/invitations/${old.invitationId}/resend`,{})).status,404);
        assert.equal(smtp.messages.length,0);
    }));
    it('classifies transport/configuration refusal without leaking SMTP response, credentials or recipient',()=>{
        for(const [error,state,errorCode] of [
            [{code:'EAUTH'},'failed','SMTP_AUTH_FAILED'],[{code:'SMTP_NOT_CONFIGURED'},'failed','SMTP_NOT_CONFIGURED'],
            [{code:'ETIMEDOUT',command:'EHLO'},'failed','SMTP_CONNECTION_FAILED'],[{code:'ETIMEDOUT',command:'DATA'},'unknown','SMTP_OUTCOME_UNKNOWN'],
            [{code:'ETLS'},'failed','SMTP_TLS_FAILED'],[{responseCode:554,command:'DATA'},'failed','SMTP_MESSAGE_REJECTED'],
        ])assert.deepEqual(Mailer.classifySmtpFailure({...error,message:'private',response:'private'}),{state,errorCode});
    });
    it('returns relative 60-second cooldown on both real verification service operations',()=>fixture(async({owner})=>{
        const previous=process.env.SESSION_SECRET,send=Mailer.sendVerificationCodeEmail;
        process.env.SESSION_SECRET='fixture-session-secret-is-long-enough';Mailer.sendVerificationCodeEmail=async()=>({success:true});
        try {
            const invite=Identity.inviteBusinessMember(owner,1,{email:'proof@example.test'});
            const proof=await Verification.initiateVerification(invite.token,{password:'fixture-long-password'});
            assert.equal(proof.resendAfterMs,60000);
            assert.ok(DB.get('SELECT resendAfterMs FROM ava_team_email_verifications WHERE id=?',[proof.verificationId]).resendAfterMs>Date.now());
            DB.run('UPDATE ava_team_email_verifications SET resendAfterMs=0');
            assert.equal((await Verification.resendVerificationCode(invite.token,{verificationId:proof.verificationId})).resendAfterMs,60000);
        } finally {Mailer.sendVerificationCodeEmail=send;if(previous===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=previous;}
    }));
    it('serializes two businesses inviting the same new account and fences a stale compensation generation',()=>fixture(async({owner})=>{
        const previous=process.env.SESSION_SECRET,send=Mailer.sendVerificationCodeEmail;let code;
        process.env.SESSION_SECRET='fixture-session-secret-is-long-enough';Mailer.sendVerificationCodeEmail=async input=>{code=input.code;};
        try {
            const inviteA=Identity.inviteBusinessMember(owner,1,{email:'shared@example.test',role:'manager'});
            const foreignOwner=Identity.actor(DB.get("SELECT id FROM ava_users WHERE email='foreign@example.test'").id);
            const inviteB=Identity.inviteBusinessMember(foreignOwner,2,{email:'shared@example.test',role:'observer'});
            const verify=async invite=>{const v=await Verification.initiateVerification(invite.token,{password:'fixture-long-password'});Verification.verifyCode(invite.token,{verificationId:v.verificationId,code});return v;};
            await verify(inviteA);await verify(inviteB);
            const claimA=Identity.claimInvitation(inviteA.token);
            assert.throws(()=>Identity.claimInvitation(inviteB.token),{code:'INVITATION_IN_PROGRESS'});
            DB.run('UPDATE ava_invitations SET leasedUntil=? WHERE id=?',[Date.now()-1,inviteA.invitationId]);
            assert.throws(()=>Identity.claimInvitation(inviteB.token),{code:'TEAM_ENROLLMENT_RECONCILIATION_REQUIRED'});
            assert.throws(()=>Identity.inspectInvitation(inviteB.token),{code:'TEAM_ENROLLMENT_RECONCILIATION_REQUIRED'});
            assert.throws(()=>Identity.renewBusinessInvitation(owner,1,inviteA.invitationId),{code:'TEAM_ENROLLMENT_RECONCILIATION_REQUIRED'});
            // Terminal worker release is the only normal way to end its barrier.
            Identity.releaseRegistrationLease(claimA);
            const claimB=Identity.claimInvitation(inviteB.token);
            const user=Identity.completeInvitation(claimB,'fixture-shared-native');
            assert.equal(Identity.abortEnrollment(claimA,'fixture-shared-native'),false);
            assert.equal(Identity.actor(user.userId).memberships[0].role,'observer');
            assert.equal(Identity.actor(user.userId).memberships[0].businessId,2);
            assert.equal(DB.get('SELECT state FROM ava_invitations WHERE id=?',[inviteB.invitationId]).state,'consumed');
            assert.equal(DB.get('SELECT COUNT(*) n FROM ava_identity_outbox').n,0);
            DB.run('UPDATE ava_invitations SET leaseToken=?,leasedUntil=? WHERE id=?',[claimA.leaseToken,Date.now()-1,inviteA.invitationId]);
            // A historical stale barrier cannot deny an existing exact active subject.
            assert.equal(Identity.inspectInvitation(inviteA.token).acceptance,'existing_account');
            const joined=Identity.acceptInvitation(user,inviteA.token);
            assert.equal(joined.memberships.find(m=>m.businessId===1).role,'manager');
            assert.equal(joined.memberships.find(m=>m.businessId===2).role,'observer');
        } finally {Mailer.sendVerificationCodeEmail=send;if(previous===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=previous;}
    }));
});
