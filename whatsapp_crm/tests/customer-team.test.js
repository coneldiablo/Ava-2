const { describe, it, assert, createTestDB } = require('./test-helper');
const express = require('express');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const routes = require('../src/routes/customer-team.routes');

function setup() {
    process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Hotel A'),(2,'Hotel B')");
    const platform = { platformRole: 'platform_admin', userId: 'operator' };
    function member(email, businessId, role) {
        const invitation = Identity.createInvitation(platform, { email, businessId, role });
        return Identity.completeInvitation(Identity.claimInvitation(invitation.token), `subject-${email}`);
    }
    return { platform, owner: member('owner@example.test', 1, 'hotel_owner'),
        manager: member('manager@example.test', 1, 'manager'),
        foreignOwner: member('foreign@example.test', 2, 'hotel_owner') };
}

async function serverFor(auth) {
    const app = express();
    app.use(express.json());
    app.use('/api', (req, _res, next) => { req.auth = auth; next(); });
    app.use('/api', routes);
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
        server.fixtureCookie = `crm_session=ava2:${Identity.createSession(auth.subject)}`;
    });
}

async function request(server, method, path, body, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
        method, headers: { 'Content-Type': 'application/json', Cookie: server.fixtureCookie, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
}

describe('Customer team identity boundary', () => {
    it('lists only active scoped members and pending invitations without credentials', async () => {
        const { owner, platform } = setup();
        const invitation = Identity.createInvitation(platform,
            { email: 'pending@example.test', businessId: 1, role: 'manager' });
        const server = await serverFor(owner);
        try {
            const result = await request(server, 'GET', '/businesses/1/team');
            assert.strictEqual(result.status, 200);
            assert.deepStrictEqual(result.data.members.map(item => item.email),
                ['owner@example.test', 'manager@example.test']);
            assert.deepStrictEqual(result.data.invitations.map(item => item.email), ['pending@example.test']);
            assert.strictEqual(result.data.invitations[0].id, invitation.invitationId);
            assert.strictEqual(typeof result.data.invitations[0].expiresAt, 'number');
            assert.strictEqual(result.headers.get('cache-control'), 'no-store');
            assert.strictEqual(JSON.stringify(result.data).includes(invitation.token), false);
            assert.strictEqual(JSON.stringify(result.data).includes('tokenHash'), false);
            assert.strictEqual(JSON.stringify(result.data).includes('foreign@example.test'), false);
            assert.strictEqual((await request(server, 'GET', '/businesses/2/team')).status, 403);
        } finally { await new Promise(resolve => server.close(resolve)); }
    });

    it('lets only the live owner invite a hotel manager with same-origin proof', async () => {
        const { owner, manager, foreignOwner } = setup();
        const oldUrl = process.env.WHATSAPP_CRM_PUBLIC_URL;
        process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
        const servers = await Promise.all([serverFor(owner), serverFor(manager), serverFor(foreignOwner)]);
        const [ownerServer, managerServer, foreignServer] = servers;
        const good = { Origin: 'https://ava.example.test', 'Sec-Fetch-Site': 'same-origin' };
        try {
            assert.strictEqual((await request(managerServer, 'POST', '/businesses/1/team/invitations',
                { email: 'no@example.test' }, good)).status, 403);
            assert.strictEqual((await request(foreignServer, 'POST', '/businesses/1/team/invitations',
                { email: 'no@example.test' }, good)).status, 403);
            assert.strictEqual((await request(ownerServer, 'POST', '/businesses/1/team/invitations',
                { email: 'no@example.test' }, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
            assert.strictEqual((await request(ownerServer, 'POST', '/businesses/1/team/invitations',
                { email: 'no@example.test' }, { Origin: 'https://ava.example.test', 'Sec-Fetch-Site': 'same-site' })).status, 403);
            assert.strictEqual((await request(ownerServer, 'POST', '/businesses/1/team/invitations',
                { email: 'no@example.test', role: 'hotel_owner' }, good)).status, 400);
            const created = await request(ownerServer, 'POST', '/businesses/1/team/invitations',
                { email: 'New.Manager@Example.Test', displayName: 'Manager' }, good);
            assert.strictEqual(created.status, 201);
            assert.match(created.data.inviteUrl, /^https:\/\/ava\.example\.test\/invite#[\w-]{43}$/);
            assert.strictEqual(typeof created.data.expiresAt, 'number');
            assert.strictEqual(created.headers.get('cache-control'), 'no-store');
            const stored = DB.get('SELECT i.*,u.email FROM ava_invitations i JOIN ava_users u ON u.id=i.userId WHERE u.email=?',
                ['new.manager@example.test']);
            assert.strictEqual(stored.businessId, 1);
            assert.strictEqual(stored.role, 'manager');
            assert.strictEqual(stored.expiresAt, created.data.expiresAt);
            assert.strictEqual(JSON.stringify(stored).includes(created.data.inviteUrl.split('#')[1]), false);
            assert.strictEqual((await request(ownerServer, 'POST', '/businesses/1/team/invitations',
                { email: 'new.manager@example.test' }, good)).status, 409);
        } finally {
            await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
            if (oldUrl === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
            else process.env.WHATSAPP_CRM_PUBLIC_URL = oldUrl;
        }
    });

    it('rechecks revoked owner access and never exposes a team removal endpoint', async () => {
        const { owner, platform } = setup();
        const server = await serverFor(owner);
        try {
            Identity.revokeUser(platform, owner.userId);
            assert.strictEqual((await request(server, 'GET', '/businesses/1/team')).status, 403);
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/businesses/1/team/${owner.userId}`,
                { method: 'DELETE' });
            assert.strictEqual(response.status, 404);
        } finally { await new Promise(resolve => server.close(resolve)); }
    });
});
