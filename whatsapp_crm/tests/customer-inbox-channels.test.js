const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');

function fixture() {
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id, name) VALUES (1, 'Own business'), (2, 'Other business')");
    DB.run(`INSERT INTO clients(instanceId, chatId, senderName, leadStatus, preferredChannel)
        VALUES (1, 'same-chat', 'Own guest', 'qualified', 'telegram'),
               (1, 'no-history', 'New guest', 'new', 'whatsapp'),
               (2, 'same-chat', 'Other guest', 'booked', 'email')`);
    DB.run(`INSERT INTO messages(instanceId, chatId, senderName, content, role, channel)
        VALUES (1, 'same-chat', 'Own guest', 'WA inbound', 'user', 'whatsapp'),
               (1, 'same-chat', 'AVA', 'TG outbound', 'assistant', 'telegram'),
               (1, 'same-chat', 'AVA', 'TG again', 'assistant', 'telegram'),
               (2, 'same-chat', 'Other guest', 'Foreign email', 'user', 'email')`);
}

describe('Customer inbox conversation channels', () => {
    it('derives every actual channel from scoped message history without changing client status or outbound preference', async () => {
        fixture();
        const own = await DB.getClients(1);
        const guest = own.find(client => client.chatId === 'same-chat');
        assert.deepStrictEqual([...guest.channels].sort(), ['telegram', 'whatsapp']);
        assert.strictEqual(guest.leadStatus, 'qualified');
        assert.strictEqual(guest.preferredChannel, 'telegram');
        assert.deepStrictEqual(own.find(client => client.chatId === 'no-history').channels, []);
        const other = await DB.getClients(2);
        assert.deepStrictEqual(other[0].channels, ['email']);
        assert.strictEqual(other[0].leadStatus, 'booked');
        assert.ok(!own.some(client => client.senderName === 'Other guest'));
    });

    it('serves the multi-channel list to an authenticated owner without exposing another tenant with the same chatId', async () => {
        fixture();
        const invitation = Identity.createInvitation({ platformRole: 'platform_admin' },
            { email: 'inbox-owner@example.test', businessId: 1, role: 'hotel_owner' });
        const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), 'inbox-owner');
        const Auth = require('../src/services/auth.service');
        const app = require('../src/app').app;
        const oldEnabled = Auth.config.enabled;
        const oldCustomer = process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        const oldOrigin = process.env.WHATSAPP_CRM_PUBLIC_URL;
        Auth.config.enabled = true;
        process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
        const token = Identity.createSession(user.subject, 'qa-inbox-channels');
        const server = await new Promise(resolve => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        const origin = `http://127.0.0.1:${server.address().port}`;
        process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
        const headers = { Cookie: `crm_session=ava2:${token}`, Origin: origin };
        try {
            const response = await fetch(`${origin}/api/clients/1`, { headers });
            assert.strictEqual(response.status, 200);
            const { clients } = await response.json();
            assert.strictEqual(clients.length, 2);
            const guest = clients.find(client => client.chatId === 'same-chat');
            assert.deepStrictEqual([...guest.channels].sort(), ['telegram', 'whatsapp']);
            assert.strictEqual(guest.leadStatus, 'qualified');
            assert.strictEqual(guest.preferredChannel, 'telegram');
            assert.strictEqual((await fetch(`${origin}/api/clients/2`, { headers })).status, 403);
            const messages = await fetch(`${origin}/api/messages/1/same-chat`, { headers });
            assert.strictEqual(messages.status, 200);
            assert.deepStrictEqual((await messages.json()).messages.map(message => message.channel),
                ['whatsapp', 'telegram', 'telegram']);
        } finally {
            Auth.config.enabled = oldEnabled;
            if (oldCustomer === undefined) delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;
            else process.env.AVA_CUSTOMER_ACCESS_ENABLED = oldCustomer;
            if (oldOrigin === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
            else process.env.WHATSAPP_CRM_PUBLIC_URL = oldOrigin;
            await new Promise(resolve => server.close(resolve));
        }
    });
});
