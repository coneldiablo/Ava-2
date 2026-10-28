const express = require('express');
const axios = require('axios');
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Provisioning = require('../src/services/provisioning/business-provisioning-store.service');
const Auth = require('../src/services/auth.service');
const Sso = require('../src/services/identity/oidc.service');
const { KeycloakAdmin } = require('../src/services/identity/keycloak-admin');
const SystemMailer = require('../src/services/identity/system-mailer.service');
const admin = { userId: 'operator', platformRole: 'platform_admin' };

function use(link, email) {
    const child = Identity.beginOwnerInvitationUse(link.token, { email, displayName: email });
    const claim = Identity.claimInvitation(child.childToken);
    const customer = Identity.completeInvitation(claim, `native-${claim.userId}`);
    assert.strictEqual(Identity.finishOwnerInvitationUse(child.invitationId), true);
    return { child, customer };
}

describe('Reusable owner invitation links', () => {
    it('stores only token hashes, limits active links to twenty, and revokes explicitly', () => {
        createTestDB();
        const links = Array.from({ length: 20 }, (_, n) => Identity.createOwnerInvitationLink(admin, { label: `Owner ${n + 1}` }));
        assert.strictEqual(Identity.listOwnerInvitationLinks(admin).length, 20);
        assert.throws(() => Identity.createOwnerInvitationLink(admin, { label: 'Twenty-first' }), { code: 'OWNER_INVITATION_LIMIT' });
        assert.strictEqual(JSON.stringify(DB.all('SELECT * FROM ava_owner_invitation_links')).includes(links[0].token), false);
        assert.strictEqual(Identity.validOwnerLink(links[0].token).id, links[0].id);
        assert.throws(() => Identity.createOwnerInvitationLink({ platformRole: 'customer' }, { label: 'Bad' }), { code: 'PLATFORM_ADMIN_REQUIRED' });
        Identity.revokeOwnerInvitationLink(admin, links[0].id);
        assert.throws(() => Identity.validOwnerLink(links[0].token), { code: 'INVITATION_INVALID' });
        assert.ok(Identity.createOwnerInvitationLink(admin, { label: 'Replacement' }).token);
    });

    it('creates a new user per use, with one-business quota and no inherited tenant rights', () => {
        createTestDB();
        const link = Identity.createOwnerInvitationLink(admin, { label: 'Owners' });
        const first = use(link, 'one@example.test');
        const second = use(link, 'two@example.test');
        assert.notStrictEqual(first.customer.userId, second.customer.userId);
        assert.deepStrictEqual(first.customer.memberships, []);
        assert.deepStrictEqual(second.customer.memberships, []);
        assert.strictEqual(first.customer.businessQuota, 1);
        assert.strictEqual(second.customer.businessQuota, 1);
        assert.throws(() => Identity.beginOwnerInvitationUse(link.token, { email: 'one@example.test' }), { code: 'ACCOUNT_ALREADY_EXISTS' });
        const a = Provisioning.createBusinessAtomic({ name: 'One' }, { ownerUserId: first.customer.userId }).instance;
        const b = Provisioning.createBusinessAtomic({ name: 'Two' }, { ownerUserId: second.customer.userId }).instance;
        assert.notStrictEqual(a.id, b.id);
        assert.throws(() => Identity.authorizeBusiness(first.customer, b.id), { code: 'BUSINESS_ACCESS_DENIED' });
        assert.throws(() => Identity.authorizeBusiness(second.customer, a.id), { code: 'BUSINESS_ACCESS_DENIED' });
        assert.throws(() => Provisioning.createBusinessAtomic({ name: 'Extra' }, { ownerUserId: first.customer.userId }), { code: 'BUSINESS_QUOTA_EXCEEDED' });
        assert.strictEqual(Identity.listOwnerInvitationLinks(admin)[0].useCount, 2);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_owner_invitation_uses WHERE state=?', ['completed']).n, 2);
        assert.throws(() => Identity.claimInvitation(first.child.childToken), { code: 'INVITATION_INVALID' });
    });

    it('blocks an in-flight child invite on link revocation and audits failed/retried attempts', () => {
        createTestDB();
        const link = Identity.createOwnerInvitationLink(admin, { label: 'Owners' });
        const child = Identity.beginOwnerInvitationUse(link.token, { email: 'retry@example.test' });
        assert.throws(() => Identity.beginOwnerInvitationUse(link.token, { email: 'retry@example.test' }), { code: 'INVITATION_IN_PROGRESS' });
        const originalUserId = DB.get('SELECT userId FROM ava_owner_invitation_uses WHERE invitationId=?', [child.invitationId]).userId;
        Identity.failOwnerInvitationUse(child.invitationId);
        const retry = Identity.beginOwnerInvitationUse(link.token, { email: 'retry@example.test' });
        assert.strictEqual(DB.get('SELECT userId FROM ava_owner_invitation_uses WHERE invitationId=?', [retry.invitationId]).userId, originalUserId);
        const claim = Identity.claimInvitation(retry.childToken);
        Identity.revokeOwnerInvitationLink(admin, link.id);
        assert.throws(() => Identity.completeInvitation(claim, 'native-retry'), { code: 'INVITATION_LEASE_LOST' });
        assert.strictEqual(DB.get('SELECT enabled FROM ava_users WHERE id=?', [originalUserId]).enabled, 0);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_owner_invitation_uses WHERE state=?', ['failed']).n, 2);
    });

    it('rate limits per link without setting a lifetime expiration', () => {
        createTestDB();
        const link = Identity.createOwnerInvitationLink(admin, { label: 'Owners' });
        for (let n = 0; n < 20; n++) Identity.beginOwnerInvitationUse(link.token, { email: `guest${n}@example.test` });
        assert.throws(() => Identity.beginOwnerInvitationUse(link.token, { email: 'overflow@example.test' }), { code: 'IDENTITY_RATE_LIMITED' });
        DB.run('UPDATE ava_owner_invitation_uses SET createdAtMs=?', [Date.now() - 3600001]);
        assert.ok(Identity.beginOwnerInvitationUse(link.token, { email: 'later@example.test' }).invitationId);
    });

    it('repairs the audit when an older worker committed but its HTTP reply was lost', () => {
        createTestDB();
        const link = Identity.createOwnerInvitationLink(admin, { label: 'Owners' });
        const child = Identity.beginOwnerInvitationUse(link.token, { email: 'lost-reply@example.test' });
        const userId = DB.get('SELECT userId FROM ava_owner_invitation_uses WHERE invitationId=?', [child.invitationId]).userId;
        DB.run('UPDATE ava_users SET subject=?,enabled=1 WHERE id=?', ['native-lost-reply', userId]);
        DB.run("UPDATE ava_invitations SET state='consumed' WHERE id=?", [child.invitationId]);
        assert.strictEqual(Identity.listOwnerInvitationLinks(admin)[0].useCount, 1);
        assert.strictEqual(DB.get('SELECT state FROM ava_owner_invitation_uses WHERE invitationId=?', [child.invitationId]).state, 'completed');
    });

    it('keeps the existing Keycloak one-time worker contract for each child invite', async () => {
        createTestDB();
        const oldRole = process.env.AVA_PROCESS_ROLE, oldIssuer = process.env.AVA_OIDC_ISSUER;
        process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        process.env.AVA_OIDC_ISSUER = 'https://identity.example.test/realms/ava';
        try {
            const link = Identity.createOwnerInvitationLink(admin, { label: 'Owners' });
            const child = Identity.beginOwnerInvitationUse(link.token, { email: 'new@example.test' });
            let native;
            const worker = new KeycloakAdmin({ request: async ({ method, url, data }) => {
                if (url.endsWith('/token')) return { data: { access_token: 'fixture-admin', expires_in: 300 } };
                if (method === 'GET' && url.includes('?username=')) return { data: native ? [native] : [] };
                if (method === 'GET' && url.includes('?email=')) return { data: native ? [native] : [] };
                if (method === 'POST' && url.endsWith('/users')) { native = { ...data, id: 'native-new' }; return { data: null }; }
                if (url.endsWith('/reset-password')) { assert.strictEqual(data.value, 'fixture-long-password'); return { data: null }; }
                if (method === 'PUT') { native = { ...native, ...data }; return { data: null }; }
                return { data: native };
            } });
            assert.deepStrictEqual(await worker.redeem(child.childToken, 'fixture-long-password'), { success: true });
            assert.strictEqual(native.emailVerified, true);
            assert.deepStrictEqual(native.requiredActions, []);
            assert.strictEqual(Identity.finishOwnerInvitationUse(child.invitationId), true);
            assert.strictEqual(Identity.actor(DB.get('SELECT userId FROM ava_owner_invitation_uses').userId).businessQuota, 1);
            await assert.rejects(worker.redeem(child.childToken, 'fixture-long-password'), { code: 'INVITATION_INVALID' });
        } finally {
            if (oldRole === undefined) delete process.env.AVA_PROCESS_ROLE; else process.env.AVA_PROCESS_ROLE = oldRole;
            if (oldIssuer === undefined) delete process.env.AVA_OIDC_ISSUER; else process.env.AVA_OIDC_ISSUER = oldIssuer;
        }
    });

    it('enforces admin origin and public Origin on the HTTP routes', async () => {
        createTestDB();
        const priorUrl = process.env.WHATSAPP_CRM_PUBLIC_URL;
        const priorSecret = process.env.SESSION_SECRET;
        const priorAuth = Auth.config.enabled, priorGetSession = Auth.getSession, priorSso = Sso.enabled,
            priorBegin = Sso.begin, priorPost = axios.post;
        const priorSend = SystemMailer.sendVerificationCodeEmail;
        let code;
        process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
        process.env.SESSION_SECRET = 'fixture-owner-invitation-secret-at-least-32-chars';
        Auth.config.enabled = true;
        Auth.getSession = () => admin;
        Sso.enabled = () => true;
        let expectedLoginUser;
        Sso.begin = async userId => {
            expectedLoginUser = userId;
            return { url: 'https://identity.example.test/login', cookie: 'sealed-flow' };
        };
        SystemMailer.sendVerificationCodeEmail = async message => { code = message.code; return { success: true }; };
        axios.post = async (_url, body) => {
            const claim = Identity.claimInvitation(body.token);
            Identity.completeInvitation(claim, `native-${claim.userId}`);
            return { data: { success: true } };
        };
        const app = express();
        app.set('trust proxy', true);
        app.use(express.json());
        app.use('/api', require('../src/routes/identity.routes'));
        const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
        const base = `http://127.0.0.1:${server.address().port}`;
        const post = (path, body, origin = 'https://ava.example.test') => fetch(`${base}/api${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin,
                'X-Forwarded-For': '198.51.100.26' }, body: JSON.stringify(body),
        });
        try {
            assert.strictEqual((await post('/owner-invitations', { label: 'A' }, 'https://foreign.example.test')).status, 403);
            const created = await (await post('/owner-invitations', { label: 'A' })).json();
            assert.strictEqual(created.success, true);
            assert.ok(created.url.startsWith('https://ava.example.test/owner-invite#'));
            const token = new URL(created.url).hash.slice(1);
            assert.strictEqual((await post('/owner-invitations/verify', { token })).status, 200);
            assert.strictEqual((await post('/owner-invitations/verify', { token }, 'https://foreign.example.test')).status, 403);
            const verification = await post('/owner-invitations/request-verification', {
                token, email: 'web@example.test', displayName: 'Web', password: 'fixture-long-password',
            });
            assert.strictEqual(verification.status, 200);
            const verificationId = (await verification.json()).verification_id;
            const accepted = await (await post('/owner-invitations/redeem', {
                token, verificationId, code,
            })).json();
            assert.strictEqual(accepted.success, true);
            assert.match(accepted.user_id, /^[a-f0-9-]{36}$/);
            const start = await fetch(`${base}/api/auth/sso/start?enrolled_user=${accepted.user_id}`, {
                redirect: 'manual', headers: { Cookie: 'crm_session=old', 'X-Forwarded-Proto': 'https' },
            });
            assert.strictEqual(start.status, 302);
            assert.strictEqual(expectedLoginUser, accepted.user_id);
            assert.match(start.headers.get('set-cookie'), /crm_session=;/);
            assert.strictEqual((await fetch(`${base}/api/auth/sso/start?enrolled_user=invalid`,
                { redirect: 'manual' })).status, 400);
            const duplicate = await post('/owner-invitations/redeem', {
                token, verificationId, code,
            });
            assert.strictEqual(duplicate.status, 404);
            assert.strictEqual((await duplicate.json()).error_code, 'VERIFICATION_NOT_FOUND');
            const list = await (await fetch(`${base}/api/owner-invitations`)).json();
            assert.strictEqual(list.links[0].useCount, 1);
            assert.strictEqual(JSON.stringify(list).includes(token), false);
            assert.strictEqual((await post(`/owner-invitations/${created.id}/revoke`, {})).status, 200);
            assert.strictEqual((await post('/owner-invitations/verify', { token })).status, 400);
        } finally {
            await new Promise(resolve => server.close(resolve));
            if (priorUrl === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL; else process.env.WHATSAPP_CRM_PUBLIC_URL = priorUrl;
            if (priorSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = priorSecret;
            Auth.config.enabled = priorAuth; Auth.getSession = priorGetSession;
            Sso.enabled = priorSso; Sso.begin = priorBegin; axios.post = priorPost;
            SystemMailer.sendVerificationCodeEmail = priorSend;
        }
    });
});
