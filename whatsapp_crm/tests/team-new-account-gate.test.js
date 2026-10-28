'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Gate = require('../src/services/identity/customer-access');
const TeamVerification = require('../src/services/identity/team-verification-store');
const Mailer = require('../src/services/identity/system-mailer.service');
const Sso = require('../src/services/identity/oidc.service');
const routes = require('../src/routes/identity.routes');
const platform = { userId: 'fixture-operator', platformRole: 'platform_admin' };
let fixtureAddress = 10;

async function fixture(fn) {
    const names = ['AVA_TEAM_NEW_ACCOUNT_ENABLED', 'AVA_CUSTOMER_ACCESS_ENABLED', 'WHATSAPP_CRM_PUBLIC_URL', 'SESSION_SECRET'];
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    Object.assign(process.env, { AVA_TEAM_NEW_ACCOUNT_ENABLED: 'false', AVA_CUSTOMER_ACCESS_ENABLED: 'true',
        WHATSAPP_CRM_PUBLIC_URL: 'https://ava.example.test', SESSION_SECRET: crypto.randomBytes(32).toString('hex') });
    createTestDB(); Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Fixture A'),(2,'Fixture B')");
    const enrolled = (email, businessId = 1) => {
        const invitation = Identity.createInvitation(platform, { email, businessId, role: 'hotel_owner' });
        return Identity.completeInvitation(Identity.claimInvitation(invitation.token), `subject-${email}`);
    };
    const owner = enrolled('owner@example.test'), existing = enrolled('existing@example.test', 2);
    const enabled = Sso.enabled, send = Mailer.sendVerificationCodeEmail, post = axios.post;
    const calls = { mail: 0, provider: 0 };
    Sso.enabled = () => true;
    Mailer.sendVerificationCodeEmail = async () => { calls.mail++; };
    axios.post = async () => { calls.provider++; return { status: 200, data: { success: true } }; };
    const app = express(); app.set('trust proxy', true); app.use(express.json()); app.use('/api', routes);
    const address = `192.0.2.${fixtureAddress++}`;
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); listener.on('error', reject);
    });
    const request = async (route, body, cookie) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: process.env.WHATSAPP_CRM_PUBLIC_URL,
                'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-For': address, ...(cookie ? { Cookie: `crm_session=ava2:${cookie}` } : {}) },
            body: JSON.stringify(body),
        });
        return { status: response.status, data: await response.json(), headers: response.headers };
    };
    try { await fn({ owner, existing, enrolled, calls, request }); }
    finally {
        await new Promise(resolve => server.close(resolve));
        Sso.enabled = enabled; Mailer.sendVerificationCodeEmail = send; axios.post = post;
        DB.db.close();
        for (const name of names) previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name];
    }
}

describe('New account team invitation release gate', () => {
    it('pauses only team new accounts and keeps default compatibility and existing/legacy paths', () => {
        const previous = process.env.AVA_TEAM_NEW_ACCOUNT_ENABLED;
        try {
            delete process.env.AVA_TEAM_NEW_ACCOUNT_ENABLED;
            assert.equal(Gate.teamNewAccountEnabled(), true);
            process.env.AVA_TEAM_NEW_ACCOUNT_ENABLED = 'true';
            assert.doesNotThrow(() => Gate.assertTeamNewAccountEnabled({ acceptanceMode: 'team', userEnabled: 0, subject: null }));
            process.env.AVA_TEAM_NEW_ACCOUNT_ENABLED = ' false ';
            assert.throws(() => Gate.assertTeamNewAccountEnabled({ acceptanceMode: 'team', userEnabled: 0, subject: null }), { code: 'TEAM_NEW_ACCOUNT_UNAVAILABLE' });
            for (const invitation of [{ acceptanceMode: 'legacy', userEnabled: 0, role: 'hotel_owner' },
                { acceptanceMode: 'team', userEnabled: 1, subject: 'verified-same-subject' }]) {
                assert.doesNotThrow(() => Gate.assertTeamNewAccountEnabled(invitation));
            }
        } finally { previous === undefined ? delete process.env.AVA_TEAM_NEW_ACCOUNT_ENABLED : process.env.AVA_TEAM_NEW_ACCOUNT_ENABLED = previous; }
    });

    it('exposes availability and rejects direct new account requests before password, mail, proof or broker effects', () => fixture(async ({ owner, calls, request }) => {
        const invite = Identity.inviteBusinessMember(owner, 1, { email: 'new@example.test', role: 'manager' });
        const row = Identity.pendingTeamInvitation(invite.token);
        DB.run(`INSERT INTO ava_team_email_verifications(id,invitationId,invitationTokenHash,email,passwordEncrypted,codeHash,
            resendAfterMs,expiresAtMs,createdAtMs) VALUES ('fixture-proof',?,?,?,'not-decryptable-fixture','fixture-code',0,?,?)`,
            [row.id, row.tokenHash, row.email, Date.now() + 600000, Date.now()]);
        const before = { user: DB.get('SELECT * FROM ava_users WHERE id=?', [row.userId]),
            proof: DB.get('SELECT * FROM ava_team_email_verifications WHERE id=?', ['fixture-proof']),
            invite: DB.get('SELECT * FROM ava_invitations WHERE id=?', [row.id]) };
        const counters = { request: 0, resend: 0, verify: 0 };
        const previous = { initiateVerification: TeamVerification.initiateVerification,
            resendVerificationCode: TeamVerification.resendVerificationCode, verifyCode: TeamVerification.verifyCode };
        TeamVerification.initiateVerification = async () => { counters.request++; throw new Error('Should not validate password'); };
        TeamVerification.resendVerificationCode = async () => { counters.resend++; throw new Error('Should not generate code'); };
        TeamVerification.verifyCode = () => { counters.verify++; throw new Error('Should not decrypt password'); };
        try {
            const inspected = await request('/invitations/inspect', { token: invite.token });
            assert.equal(inspected.status, 200); assert.equal(inspected.data.acceptance, 'new_account');
            assert.equal(inspected.data.newAccountEnabled, false);
            for (const route of ['request-verification', 'resend-code', 'redeem']) {
                const blocked = await request(`/invitations/${route}`, { token: invite.token, password: 'bad',
                    verificationId: 'fixture-proof', code: '123456', acceptanceMode: 'legacy', role: 'hotel_owner' });
                assert.equal(blocked.status, 503); assert.equal(blocked.data.error_code, 'TEAM_NEW_ACCOUNT_UNAVAILABLE');
                assert(blocked.data.error.includes('Войдите') || blocked.data.error.includes('войдите'));
                assert(!blocked.data.error.includes('Keycloak')); assert.equal(blocked.headers.get('cache-control'), 'no-store');
            }
            assert.deepEqual(counters, { request: 0, resend: 0, verify: 0 }); assert.deepEqual(calls, { mail: 0, provider: 0 });
            assert.deepEqual(DB.get('SELECT * FROM ava_users WHERE id=?', [row.userId]), before.user);
            assert.deepEqual(DB.get('SELECT * FROM ava_team_email_verifications WHERE id=?', ['fixture-proof']), before.proof);
            assert.deepEqual(DB.get('SELECT * FROM ava_invitations WHERE id=?', [row.id]), before.invite);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM ava_business_memberships WHERE userId=?', [row.userId]).n, 0);
        } finally { Object.assign(TeamVerification, previous); }
    }));

    it('keeps exact-subject existing-account joining while rejecting another logged-in account', () => fixture(async ({ owner, existing, calls, request }) => {
        const invite = Identity.inviteBusinessMember(owner, 1, { email: existing.email, role: 'observer' });
        const before = DB.get('SELECT * FROM ava_users WHERE id=?', [existing.userId]);
        const inspected = await request('/invitations/inspect', { token: invite.token });
        assert.equal(inspected.data.acceptance, 'existing_account'); assert.equal(inspected.data.newAccountEnabled, true);
        const wrong = await request('/invitations/accept', { token: invite.token }, Identity.createSession(owner.subject));
        assert.equal(wrong.status, 403);
        const joined = await request('/invitations/accept', { token: invite.token }, Identity.createSession(existing.subject));
        assert.equal(joined.status, 200); assert.equal(joined.data.user_id, existing.userId);
        assert.equal(joined.headers.get('set-cookie'), null);
        assert.deepEqual(DB.get('SELECT * FROM ava_users WHERE id=?', [existing.userId]), before);
        assert.equal(Identity.actor(existing.userId).memberships.find(m => m.businessId === 1).role, 'observer');
        assert.deepEqual(calls, { mail: 0, provider: 0 });
    }));

    it('keeps reusable owner code registration and legacy platform owner activation separate', () => fixture(async ({ calls, request }) => {
        const ownerLink = Identity.createOwnerInvitationLink(platform, { label: 'Fixture owner enrollment' });
        const ownerCode = await request('/owner-invitations/request-verification', { token: ownerLink.token,
            email: 'owner-new@example.test', displayName: 'Fixture', password: 'a-valid-owner-password' });
        assert.equal(ownerCode.status, 200); assert(ownerCode.data.verification_id); assert.equal(calls.mail, 1);
        const legacy = Identity.createInvitation(platform, { email: 'platform-new@example.test', role: 'hotel_owner' });
        const inspected = await request('/invitations/inspect', { token: legacy.token });
        assert.equal(inspected.data.acceptance, 'legacy'); assert.equal(inspected.data.newAccountEnabled, true);
        const activated = await request('/invitations/redeem', { token: legacy.token, password: 'a-valid-platform-password' });
        assert.equal(activated.status, 200); assert.equal(calls.provider, 1);
    }));
});
