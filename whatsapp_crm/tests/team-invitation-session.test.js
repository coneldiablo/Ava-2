'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const express = require('express');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const Mailer = require('../src/services/identity/system-mailer.service');

describe('Staff invitation live session boundary across SMTP await', () => {
    for (const action of ['create', 'renew', 'resend']) it(`withholds the ${action} token after cookie revocation and preserves SMTP acceptance`, async () => {
        createTestDB(); Identity.ensureSchema();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'QA business')");
        DB.run("INSERT INTO ava_users(id,subject,email,enabled) VALUES ('qa-owner','qa-native-owner','owner@example.test',1)");
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES ('qa-owner',1,'hotel_owner')");
        const token = Identity.createSession('qa-native-owner');
        const invitation = action === 'create' ? null : Identity.inviteBusinessMember(Identity.actor('qa-owner'), 1, { email: 'qa-new@example.test', role: 'observer' });
        const endpoint = action === 'create' ? '/invitations' : `/invitations/${invitation.invitationId}/${action}`;
        const previous = { enabled: Auth.config.enabled, mail: Mailer.sendTeamInvitationEmail,
            origin: process.env.WHATSAPP_CRM_PUBLIC_URL, access: process.env.AVA_CUSTOMER_ACCESS_ENABLED };
        Auth.config.enabled = true;
        process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
        process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
        let finishMail, startedMail;
        const started = new Promise(resolve => { startedMail = resolve; });
        const held = new Promise(resolve => { finishMail = resolve; });
        Mailer.sendTeamInvitationEmail = async () => { startedMail(); await held; };
        const app = express(); app.use(express.json());
        app.use('/api', Auth.requireAuth.bind(Auth));
        app.use('/api', require('../src/services/identity/customer-role-boundary'));
        app.use('/api', require('../src/routes/customer-team.routes'));
        const server = await new Promise(done => { const listener = app.listen(0, '127.0.0.1', () => done(listener)); });
        let failWait;
        const timeout = new Promise((_, reject) => { failWait = reject; });
        const timer = setTimeout(() => { finishMail(); failWait(new Error('SMTP hook was not reached')); }, 3000);
        try {
            const pending = fetch(`http://127.0.0.1:${server.address().port}/api/businesses/1/team${endpoint}`, {
                method: 'POST', headers: { Origin: 'https://ava.example.test', 'Content-Type': 'application/json', Cookie: `crm_session=ava2:${token}` },
                body: JSON.stringify(action === 'create' ? { email: 'qa-new@example.test', role: 'observer' } : {}),
            });
            await Promise.race([started, timeout]);
            Identity.revokeSession(token);
            assert.strictEqual(Identity.session(token), null);
            assert.strictEqual(Identity.authorizeCapability(Identity.actor('qa-owner'), 1, 'team.manage'), 1);
            finishMail();
            const response = await pending, result = await response.json();
            assert.ok(response.status === 401 || response.status === 403, `revoked cookie received HTTP ${response.status}`);
            assert.strictEqual(result.inviteUrl, undefined);
            assert.strictEqual(result.code, 'BUSINESS_ACCESS_DENIED');
            const delivery = DB.get('SELECT state, attempts FROM ava_team_invitation_delivery');
            assert.deepStrictEqual(delivery, { state: 'smtp_accepted', attempts: 1 });
            assert.strictEqual(Identity.listBusinessTeam(Identity.actor('qa-owner'), 1).invitations.length, 1);
        } finally {
            clearTimeout(timer); finishMail(); await new Promise(done => server.close(done));
            Auth.config.enabled = previous.enabled; Mailer.sendTeamInvitationEmail = previous.mail;
            for (const [name, value] of [['WHATSAPP_CRM_PUBLIC_URL', previous.origin], ['AVA_CUSTOMER_ACCESS_ENABLED', previous.access]]) {
                if (value === undefined) delete process.env[name]; else process.env[name] = value;
            }
            if (DB.db?.open) DB.db.close();
        }
    });
});
