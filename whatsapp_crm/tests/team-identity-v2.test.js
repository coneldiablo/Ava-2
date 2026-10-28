
'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const Database=require('better-sqlite3');
const fs=require('fs'),os=require('os'),path=require('path');
const express=require('express');
const DB=require('../src/services/database.service');
const I=require('../src/services/identity/identity-store');
const V=require('../src/services/identity/team-verification-store');
const Mailer=require('../src/services/identity/system-mailer.service');
const Auth=require('../src/services/auth.service');
const Sso=require('../src/services/identity/oidc.service');
const identityRoutes=require('../src/routes/identity.routes');
const teamRoutes=require('../src/routes/customer-team.routes');
const platform={platformRole:'platform_admin',userId:'operator'};
const good={Origin:'https://ava.example.test','Sec-Fetch-Site':'same-origin'};
function setup() {
    createTestDB();I.ensureSchema();DB.run("INSERT INTO instances(id,name) VALUES (1,'Hotel A'),(2,'Hotel B')");
    const add=(email,role,businessId=1)=>{const link=I.createInvitation(platform,{email,role,businessId});return I.completeInvitation(I.claimInvitation(link.token),`sub-${email}`);};
    return {owner:add('owner@example.test','hotel_owner'),manager:add('manager@example.test','manager'),
        lead:add('lead@example.test','sales_lead'),observer:add('observer@example.test','observer'),foreign:add('foreign@example.test','hotel_owner',2),add};
}
function env() {const names=['WHATSAPP_CRM_PUBLIC_URL','AVA_CUSTOMER_ACCESS_ENABLED','SESSION_SECRET'];const old=Object.fromEntries(names.map(n=>[n,process.env[n]]));process.env.WHATSAPP_CRM_PUBLIC_URL='https://ava.example.test';process.env.AVA_CUSTOMER_ACCESS_ENABLED='true';process.env.SESSION_SECRET='team-tests-only-secret-with-at-least-32-characters';return()=>names.forEach(n=>old[n]===undefined?delete process.env[n]:process.env[n]=old[n]);}
async function withServer(auth,fn) {
    let cookie=null;
    const app=express();app.use(express.json());app.use('/api',identityRoutes);app.use('/api',(req,_res,next)=>{req.auth=auth;next();},teamRoutes);
    const server=await new Promise(resolve=>{const srv=app.listen(0,'127.0.0.1',()=>resolve(srv));});
    try {return await fn(async(method,payloadPath,payload,headers=good)=>{
        if (!cookie && auth?.subject && payloadPath.startsWith('/businesses/')) cookie=`crm_session=ava2:${I.createSession(auth.subject)}`;
        const res=await fetch(`http://127.0.0.1:${server.address().port}/api${payloadPath}`,{method,headers:{'Content-Type':'application/json',...(cookie && payloadPath.startsWith('/businesses/')?{Cookie:cookie}:{}),...headers},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
        return {status:res.status,data:await res.json(),headers:res.headers};
    });} finally {await new Promise(resolve=>server.close(resolve));}
}
describe('AVA team identity v2',()=>{
    it('enforces capabilities from live role, denies forged body/snapshot/admin and exposes exact session identity',()=>{
        const {owner,manager,lead,observer}=setup();
        const allowed={hotel_owner:['team.manage','business.manage','tasks.manage','messages.send','ai.use'],sales_lead:['tasks.manage','sales.assign','messages.send','ai.use'],manager:['tasks.claim','sales.write','messages.send','ai.use'],observer:['sales.read','team.read','business.read']};
        for(const actor of [owner,manager,lead,observer]) for(const capability of I.capabilitiesForRole('hotel_owner')) {
            const role=actor.memberships[0].role;
            if(I.capabilitiesForRole(role).includes(capability)) assert.equal(I.authorizeCapability(actor,1,capability),1);
            else assert.throws(()=>I.authorizeCapability(actor,1,capability),{code:'CAPABILITY_DENIED'});
        }
        for(const [role,caps] of Object.entries(allowed)) assert(caps.every(c=>I.capabilitiesForRole(role).includes(c)));
        assert.throws(()=>I.authorizeCapability({...observer,memberships:owner.memberships},1,'team.manage'),{code:'CAPABILITY_DENIED'});
        assert.throws(()=>I.authorizeCapability({...observer,platformRole:'platform_admin'},1,'team.manage'),{code:'PLATFORM_ADMIN_REQUIRED'});
        assert.throws(()=>I.authorizeCapability(manager,2,'business.read'),{code:'BUSINESS_ACCESS_DENIED'});
        const token=I.createSession(manager.subject);const session=I.session(token);
        assert.equal(session.userId,manager.userId);assert.equal(session.displayName,'');assert.equal(session.canCreateBusiness,false);
        assert(session.memberships[0].capabilities.includes('sales.write'));
        DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId=?",[manager.userId]);
        assert.throws(()=>I.authorizeCapability(manager,1,'sales.write'),{code:'CAPABILITY_DENIED'});
        assert(!I.session(token).memberships[0].capabilities.includes('sales.write'));
    });
    it('joins only an authenticated exact existing account without claim/password/reset/session switching',async()=>{
        const restore=env(),{owner,foreign,manager}=setup();
        try {
            const before=DB.get('SELECT * FROM ava_users WHERE id=?',[foreign.userId]);
            const link=I.inviteBusinessMember(owner,1,{email:'FOREIGN@example.test',role:'observer'});
            assert.equal(I.inspectInvitation(link.token).acceptance,'existing_account');
            assert.throws(()=>I.acceptInvitation(manager,link.token),{code:'INVITATION_ACCOUNT_MISMATCH'});
            assert.throws(()=>I.acceptInvitation({...foreign,subject:manager.subject},link.token),{code:'INVITATION_ACCOUNT_MISMATCH'});
            assert.throws(()=>I.claimInvitation(link.token),{code:'INVITATION_EXISTING_ACCOUNT_REQUIRED'});
            const cookieToken=I.createSession(foreign.subject);
            await withServer(owner,async(request)=>{
                assert.equal((await request('POST','/invitations/accept',{token:link.token})).status,401);
                const joined=await request('POST','/invitations/accept',{token:link.token},{...good,Cookie:`crm_session=ava2:${cookieToken}`});
                assert.equal(joined.status,200);assert.equal(joined.data.user_id,foreign.userId);assert.equal(joined.data.businessId,1);
                assert.equal(joined.headers.get('set-cookie'),null);
            });
            assert.deepEqual(DB.get('SELECT * FROM ava_users WHERE id=?',[foreign.userId]),before);
            assert.equal(I.session(cookieToken).memberships.length,2);
            assert.equal(I.actor(foreign.userId).memberships.find(m=>m.businessId===1).role,'observer');
            assert.throws(()=>I.acceptInvitation(foreign,link.token),{code:'INVITATION_INVALID'});
            assert.throws(()=>I.inviteBusinessMember(owner,1,{email:foreign.email,role:'manager'}),{code:'ACCOUNT_ALREADY_MEMBER'});
        } finally {restore();}
    });
    it('rotates/expires/revokes only scoped invitations and blocks renewal while a worker owns a lease',()=>{
        const {owner,foreign}=setup();
        const link=I.inviteBusinessMember(owner,1,{email:'rotating@example.test',role:'sales_lead'});
        assert.throws(()=>I.renewBusinessInvitation(foreign,2,link.invitationId),{code:'INVITATION_INVALID'});
        DB.run('UPDATE ava_invitations SET expiresAt=? WHERE id=?',[Date.now()-1,link.invitationId]);
        assert.throws(()=>I.inspectInvitation(link.token),{code:'INVITATION_INVALID'});
        assert.equal(I.listBusinessTeam(owner,1).invitations[0].state,'expired');
        const renewed=I.renewBusinessInvitation(owner,1,link.invitationId);
        assert.notEqual(renewed.token,link.token);assert.throws(()=>I.inspectInvitation(link.token),{code:'INVITATION_INVALID'});
        DB.run("UPDATE ava_invitations SET state='redeeming',leaseToken='old',leasedUntil=? WHERE id=?",[Date.now()+60000,link.invitationId]);
        assert.throws(()=>I.renewBusinessInvitation(owner,1,link.invitationId),{code:'INVITATION_IN_PROGRESS'});
        I.releaseRegistrationLease({id:link.invitationId,leaseToken:'old',acceptanceMode:'team'});
        const rotated=I.renewBusinessInvitation(owner,1,link.invitationId);
        assert.throws(()=>I.assertInvitationLease({id:link.invitationId,userId:DB.get('SELECT userId FROM ava_invitations WHERE id=?',[link.invitationId]).userId,leaseToken:'old'}),{code:'INVITATION_LEASE_LOST'});
        I.revokeBusinessInvitation(owner,1,link.invitationId);
        assert.throws(()=>I.inspectInvitation(rotated.token),{code:'INVITATION_INVALID'});
        assert.throws(()=>I.renewBusinessInvitation(owner,1,link.invitationId),{code:'INVITATION_INVALID'});
    });
    it('owner-only HTTP role/remove/renew/revoke use same-origin and live records, self and last-owner protected',async()=>{
        const restore=env(),{owner,manager,lead,observer,foreign}=setup();
        try {
            for(const role of [manager,lead,observer,foreign]) await withServer(role,async(request)=>{
                const prefix='/businesses/1/team';
                assert.equal((await request('POST',`${prefix}/invitations`,{email:'denied@example.test',role:'observer'})).status,403);
                assert.equal((await request('PATCH',`${prefix}/members/${manager.userId}`,{role:'observer'})).status,403);
                assert.equal((await request('DELETE',`${prefix}/members/${manager.userId}`)).status,403);
                assert.equal((await request('POST',`${prefix}/invitations/x/renew`,{})).status,403);
                assert.equal((await request('DELETE',`${prefix}/invitations/x`)).status,403);
            });
            await withServer(owner,async(request)=>{
                assert.equal((await request('PATCH',`/businesses/1/team/members/${owner.userId}`,{role:'manager'})).data.code,'TEAM_SELF_ACCESS_PROTECTED');
                assert.equal((await request('PATCH',`/businesses/1/team/members/${manager.userId}`,{role:'observer'},{Origin:'https://evil.test'})).status,403);
                assert.equal((await request('PATCH',`/businesses/1/team/members/${manager.userId}`,{role:'observer',userId:owner.userId})).status,400);
                assert.equal((await request('PATCH',`/businesses/1/team/members/${manager.userId}`,{role:'observer'})).status,200);
                assert.equal((await request('DELETE',`/businesses/1/team/members/${manager.userId}`)).status,200);
            });
            assert.throws(()=>I.removeBusinessMember(platform,1,owner.userId),{code:'TEAM_LAST_OWNER'});
            assert.throws(()=>I.changeBusinessRole(owner,1,owner.userId,'hotel_owner'),{code:'TEAM_ROLE_INVALID'});
            DB.run("UPDATE ava_business_memberships SET role='manager' WHERE userId=?",[owner.userId]);
            assert.throws(()=>I.inviteBusinessMember(owner,1,{email:'stale@example.test'}),{code:'CAPABILITY_DENIED'});
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM ava_team_audit').n,2);
        } finally {restore();}
    });
    it('membership removal leaves other business and AVA session usable, cleans assignments atomically',()=>{
        const {owner,manager}=setup();
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES (?,2,'manager')",[manager.userId]);
        const cookie=I.createSession(manager.subject);
        DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES (1,'owned','Customer',?)",[manager.userId]);
        I.removeBusinessMember(owner,1,manager.userId);
        assert.equal(DB.get("SELECT assigneeUserId FROM clients WHERE instanceId=1 AND chatId='owned'").assigneeUserId,null);
        assert.throws(()=>I.authorizeCapability(manager,1,'business.read'),{code:'BUSINESS_ACCESS_DENIED'});
        assert.equal(I.authorizeCapability(manager,2,'sales.write'),2);
        assert(I.session(cookie));assert.equal(I.session(cookie).memberships.length,1);
        assert.equal(DB.get('SELECT enabled FROM ava_users WHERE id=?',[manager.userId]).enabled,1);
        assert.equal(DB.get('SELECT COUNT(*) AS n FROM ava_identity_outbox').n,0);
        assert.equal(I.actor(manager.userId).canCreateBusiness,false);
    });
    it('does not mutate membership/native/audit when sales cleanup fails',()=>{
        const {owner,manager}=setup(),Sales=require('../src/services/sales-workspace.service');
        const cleanup=Sales.cleanupMemberAssignments;Sales.cleanupMemberAssignments=()=>{DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId=?",[manager.userId]);throw new Error('fixture rollback');};
        try {assert.throws(()=>I.removeBusinessMember(owner,1,manager.userId),/fixture rollback/);
            assert.equal(I.actor(manager.userId).memberships[0].role,'manager');assert.equal(DB.get('SELECT COUNT(*) AS n FROM ava_team_audit').n,0);
        } finally {Sales.cleanupMemberAssignments=cleanup;}
    });
    it('new-account code uses invitation email, encrypted password, bounded wrong attempts, reset/resend and proof rotates with token',async()=>{
        const restore=env(),{owner}=setup(),send=Mailer.sendVerificationCodeEmail;let delivered;
        Mailer.sendVerificationCodeEmail=async(message)=>{delivered=message;};
        try {
            const link=I.inviteBusinessMember(owner,1,{email:'new@example.test',role:'observer',displayName:'New person'});
            assert.throws(()=>I.claimInvitation(link.token),{code:'VERIFICATION_REQUIRED'});
            const verify=await V.initiateVerification(link.token,{password:'correct-long-password',email:'attacker@example.test'});
            assert.equal(delivered.to,'new@example.test');assert.equal(delivered.displayName,'New person');
            assert(!JSON.stringify(DB.all('SELECT * FROM ava_team_email_verifications')).includes('correct-long-password'));
            await assert.rejects(V.initiateVerification(link.token,{password:'another-long-password'}),{code:'RESEND_COOLDOWN'});
            const wrong=delivered.code==='100000'?'100001':'100000';
            for(let attempt=0;attempt<5;attempt++) assert.throws(()=>V.verifyCode(link.token,{verificationId:verify.verificationId,code:wrong}),{code:attempt===4?'MAX_ATTEMPTS_EXCEEDED':'INVALID_VERIFICATION_CODE'});
            assert.throws(()=>V.verifyCode(link.token,{verificationId:verify.verificationId,code:delivered.code}),{code:'MAX_ATTEMPTS_EXCEEDED'});
            DB.run('UPDATE ava_team_email_verifications SET resendAfterMs=0');
            await V.resendVerificationCode(link.token,{verificationId:verify.verificationId});
            const proof=V.verifyCode(link.token,{verificationId:verify.verificationId,code:delivered.code});
            assert.equal(proof.password,'correct-long-password');
            const claimed=I.claimInvitation(link.token);assert.equal(claimed.emailVerifiedInvitation,true);
            assert.throws(()=>I.renewBusinessInvitation(owner,1,link.invitationId),{code:'INVITATION_IN_PROGRESS'});
            I.releaseRegistrationLease(claimed);
            const rotated=I.renewBusinessInvitation(owner,1,link.invitationId);
            assert.throws(()=>I.assertInvitationLease(claimed),{code:'INVITATION_LEASE_LOST'});
            assert.throws(()=>V.verifyCode(rotated.token,{verificationId:verify.verificationId,code:delivered.code}),{code:'VERIFICATION_NOT_FOUND'});
            assert.throws(()=>I.claimInvitation(rotated.token),{code:'VERIFICATION_REQUIRED'});
        } finally {Mailer.sendVerificationCodeEmail=send;restore();}
    });
    it('verified new enrollment completes one time, scrubs passwords and keeps observer server-only privileges',async()=>{
        const restore=env(),{owner}=setup(),send=Mailer.sendVerificationCodeEmail;let message;
        Mailer.sendVerificationCodeEmail=async(m)=>{message=m;};
        try {
            const link=I.inviteBusinessMember(owner,1,{email:'once@example.test',role:'observer'});
            const verification=await V.initiateVerification(link.token,{password:'sufficient-password-value'});
            V.verifyCode(link.token,{verificationId:verification.verificationId,code:message.code});
            const leased=I.claimInvitation(link.token);I.completeInvitation(leased,'new-observer-subject');
            assert(V.completed(link.invitationId,verification.verificationId));
            assert.equal(DB.get('SELECT passwordEncrypted FROM ava_team_email_verifications').passwordEncrypted,'');
            assert.throws(()=>V.verifyCode(link.token,{verificationId:verification.verificationId,code:message.code}),{code:'INVITATION_INVALID'});
            assert.throws(()=>I.claimInvitation(link.token),{code:'INVITATION_INVALID'});
            assert.throws(()=>I.authorizeCapability(I.actor(leased.userId),1,'ai.use'),{code:'CAPABILITY_DENIED'});
        } finally {Mailer.sendVerificationCodeEmail=send;restore();}
    });
    it('expired/revoked proof and mail failures never enable a user or membership',async()=>{
        const restore=env(),{owner}=setup(),send=Mailer.sendVerificationCodeEmail;let message;
        Mailer.sendVerificationCodeEmail=async(m)=>{message=m;};
        try {
            const link=I.inviteBusinessMember(owner,1,{email:'expires@example.test',role:'manager'});
            const code=await V.initiateVerification(link.token,{password:'sufficient-password-value'});
            DB.run('UPDATE ava_team_email_verifications SET expiresAtMs=?',[Date.now()-1]);
            assert.throws(()=>V.verifyCode(link.token,{verificationId:code.verificationId,code:message.code}),{code:'VERIFICATION_CODE_EXPIRED'});
            I.revokeBusinessInvitation(owner,1,link.invitationId);
            await assert.rejects(V.resendVerificationCode(link.token,{verificationId:code.verificationId}),{code:'INVITATION_INVALID'});
            const failed=I.inviteBusinessMember(owner,1,{email:'mailer@example.test',role:'manager'});
            Mailer.sendVerificationCodeEmail=async()=>{throw new Error('fixture mail unavailable');};
            await assert.rejects(V.initiateVerification(failed.token,{password:'sufficient-password-value'}),/fixture mail unavailable/);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM ava_team_email_verifications WHERE invitationId=?',[failed.invitationId]).n,0);
            assert.equal(DB.get('SELECT enabled FROM ava_users WHERE email=?',['mailer@example.test']).enabled,0);
        } finally {Mailer.sendVerificationCodeEmail=send;restore();}
    });
    it('runs the new-account HTTP code protocol, refuses password-only/account switching, reconciles lost reply and rejects replay',async()=>{
        const restore=env(),{owner,manager}=setup(),send=Mailer.sendVerificationCodeEmail,axios=require('axios'),post=axios.post;
        let delivered,calls=0;
        Mailer.sendVerificationCodeEmail=async(m)=>{delivered=m;};
        axios.post=async(url,payload)=>{
            calls++;assert.equal(url,'http://provisioning_worker:3900/invitations/redeem');
            assert.equal(payload.password,'new-account-long-password');
            const lease=I.claimInvitation(payload.token);assert.equal(lease.emailVerifiedInvitation,true);
            I.completeInvitation(lease,'http-new-native-subject');
            throw new Error('fixture lost broker response after durable completion');
        };
        try {
            const link=I.inviteBusinessMember(owner,1,{email:'http-new@example.test',role:'sales_lead'});
            const managerCookie=I.createSession(manager.subject);
            await withServer(owner,async(request)=>{
                const details=await request('POST','/invitations/inspect',{token:link.token});
                assert.equal(details.status,200);assert.equal(details.data.acceptance,'new_account');assert.equal(details.data.role,'sales_lead');
                assert.equal((await request('POST','/invitations/request-verification',{token:link.token,password:'new-account-long-password'},{...good,Cookie:`crm_session=ava2:${managerCookie}`})).status,403);
                assert.equal(delivered,undefined);
                const proof=await request('POST','/invitations/request-verification',{token:link.token,password:'new-account-long-password'});
                assert.equal(proof.status,200);assert(proof.data.verification_id);assert.equal(proof.data.masked_email,'h***@example.test');
                const direct=await request('POST','/invitations/redeem',{token:link.token,password:'new-account-long-password'});
                assert.equal(direct.status,400);assert.equal(direct.data.error_code,'VERIFICATION_REQUIRED');assert.equal(calls,0);
                const done=await request('POST','/invitations/redeem',{token:link.token,verificationId:proof.data.verification_id,code:delivered.code});
                assert.equal(done.status,200);assert.equal(done.data.success,true);assert(done.data.user_id);assert.equal(done.headers.get('set-cookie'),null);assert.equal(calls,1);
                const replay=await request('POST','/invitations/redeem',{token:link.token,verificationId:proof.data.verification_id,code:delivered.code});
                assert.equal(replay.status,400);assert.equal(replay.data.error_code,'INVITATION_INVALID');assert.equal(calls,1);
            });
            assert.equal(I.session(managerCookie).userId,manager.userId);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM ava_sessions').n,1);
            const member=I.actor(DB.get("SELECT id FROM ava_users WHERE email='http-new@example.test'").id);
            assert.equal(member.memberships[0].role,'sales_lead');assert(member.memberships[0].capabilities.includes('sales.assign'));
            assert.equal(DB.get('SELECT passwordEncrypted FROM ava_team_email_verifications').passwordEncrypted,'');
        } finally {Mailer.sendVerificationCodeEmail=send;axios.post=post;restore();}
    });
    it('migrates old roles with all states/FKs/custom drift index and trigger preserved and survives restart',async()=>{
        const db=createTestDB();DB.run("INSERT INTO instances(id,name) VALUES (1,'Legacy hotel')");
        db.exec(`CREATE TABLE ava_users(id TEXT PRIMARY KEY,subject TEXT UNIQUE,email TEXT NOT NULL,displayName TEXT NOT NULL DEFAULT '',platformRole TEXT NOT NULL DEFAULT 'customer' CHECK(platformRole IN ('customer','platform_admin')),businessQuota INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1,createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE ava_business_memberships(userId TEXT NOT NULL REFERENCES ava_users(id),businessId INTEGER NOT NULL REFERENCES instances(id),role TEXT NOT NULL CHECK(role IN ('hotel_owner','manager')),enabled INTEGER NOT NULL DEFAULT 1,createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,extra TEXT,PRIMARY KEY(userId,businessId));
            CREATE TABLE ava_invitations(id TEXT PRIMARY KEY,tokenHash TEXT NOT NULL UNIQUE,userId TEXT NOT NULL REFERENCES ava_users(id),businessId INTEGER REFERENCES instances(id),role TEXT NOT NULL CHECK(role IN ('hotel_owner','manager')),expiresAt INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','redeeming','consumed','revoked')),leaseToken TEXT,leasedUntil INTEGER,createdBy TEXT NOT NULL,createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,extra TEXT);
            CREATE TABLE legacy_child(id TEXT PRIMARY KEY,invitationId TEXT REFERENCES ava_invitations(id));
            CREATE TABLE migration_witness(id TEXT);
            CREATE INDEX legacy_custom_idx ON ava_invitations(extra);
            CREATE TRIGGER legacy_custom_trigger AFTER UPDATE OF role ON ava_business_memberships BEGIN INSERT INTO migration_witness(id) VALUES (new.userId); END;
            INSERT INTO ava_users(id,email,subject) VALUES ('legacy-owner','legacy@example.test','legacy-subject'),('legacy-manager','manager@example.test',NULL);
            INSERT INTO ava_business_memberships(userId,businessId,role,extra) VALUES ('legacy-owner',1,'hotel_owner','drift'),('legacy-manager',1,'manager','keep');`);
        for(const state of ['pending','redeeming','consumed','revoked']) {
            DB.run('INSERT INTO ava_invitations(id,tokenHash,userId,businessId,role,expiresAt,state,createdBy,extra) VALUES (?,?,?,?,?,?,?,?,?)',[state,I.hash(state),'legacy-manager',1,'manager',Date.now()+60000,state,'legacy-operator',state]);
            DB.run('INSERT INTO legacy_child VALUES (?,?)',[state,state]);
        }
        const before=DB.all('SELECT * FROM ava_invitations ORDER BY id'),members=DB.all('SELECT * FROM ava_business_memberships ORDER BY userId');
        const concurrentDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'ava-team-concurrent-')),concurrentFile=path.join(concurrentDirectory,'fixture.db');
        await db.backup(concurrentFile);
        const spawn=require('child_process').spawn;
        const source=`const path=require('path');const base=process.argv[2];const DB=require(path.join(base,'src/services/database.service'));const Database=require(path.join(base,'node_modules/better-sqlite3'));const Identity=require(path.join(base,'src/services/identity/identity-store'));DB.db=new Database(process.argv[1]);DB.db.pragma('foreign_keys=ON');process.stdout.write('READY\\n');process.stdin.once('data',()=>{try{Identity.ensureSchema();Identity.ensureSchema();if(DB.all('PRAGMA foreign_key_check').length)throw new Error('FK');DB.db.close();process.exit(0);}catch(e){process.stderr.write(e.stack);process.exit(1);}});`;
        const children=[0,1].map(()=>{
            const child=spawn(process.execPath,['-e',source,concurrentFile,path.join(__dirname,'..')]);let readyResolve;
            const ready=new Promise(resolve=>readyResolve=resolve);let output='';
            child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('READY'))readyResolve();});
            const done=new Promise((resolve,reject)=>{let errors='';child.stderr.on('data',chunk=>errors+=chunk);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(errors || `concurrent migration exit ${code}`)));});
            return {child,ready,done};
        });
        try {await Promise.all(children.map(c=>c.ready));for(const {child} of children)child.stdin.end('start');await Promise.all(children.map(c=>c.done));
            const check=new Database(concurrentFile);assert.equal(check.prepare('SELECT COUNT(*) AS n FROM ava_invitations').get().n,4);assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check,'ok');check.close();
        } finally {for(const {child} of children)child.kill();fs.rmSync(concurrentDirectory,{recursive:true,force:true});}
        I.ensureSchema();I.ensureSchema();
        assert.deepEqual(DB.all('SELECT * FROM ava_invitations ORDER BY id').map(({acceptanceMode,...row})=>row),before);
        assert.deepEqual(DB.all('SELECT * FROM ava_business_memberships ORDER BY userId'),members);
        assert.equal(DB.all('SELECT * FROM legacy_child').length,4);assert.deepEqual(DB.all('PRAGMA foreign_key_check'),[]);
        assert.equal(db.pragma('foreign_keys',{simple:true}),1);
        assert(DB.get("SELECT name FROM sqlite_master WHERE name='legacy_custom_idx'"));
        DB.run("UPDATE ava_business_memberships SET role='sales_lead' WHERE userId='legacy-manager'");
        assert.equal(DB.get('SELECT COUNT(*) AS n FROM migration_witness').n,1);
        const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ava-team-migration-')),filename=path.join(directory,'fixture.db');
        await db.backup(filename);db.close();DB.db=new Database(filename);DB.db.pragma('foreign_keys=ON');I.ensureSchema();
        assert.equal(DB.get("SELECT role FROM ava_business_memberships WHERE userId='legacy-manager'").role,'sales_lead');
        assert.deepEqual(DB.all('PRAGMA foreign_key_check'),[]);assert.equal(DB.get('PRAGMA integrity_check').integrity_check,'ok');
        DB.db.close();fs.rmSync(directory,{recursive:true,force:true});
    });
});
