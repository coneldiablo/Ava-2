const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Access = require('../src/services/identity/customer-access');

function owner() {
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Own hotel'),(2,'Other hotel')");
    const invite = Identity.createInvitation({ platformRole: 'platform_admin' },
        { email: 'template-owner@example.test', businessId: 1, role: 'hotel_owner' });
    return Identity.completeInvitation(Identity.claimInvitation(invite.token), 'template-owner');
}

function check(auth, method, path, params, origin = 'https://ava.example.test') {
    const previous = process.env.WHATSAPP_CRM_PUBLIC_URL;
    process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
    let passed = false, status = 200;
    try {
        Access.forRoute(method, path)({ auth, params, body: {}, query: {}, headers: origin ? { origin } : {} }, {
            status(value) { status = value; return this; }, json() {},
        }, () => { passed = true; });
    } finally {
        if (previous === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
        else process.env.WHATSAPP_CRM_PUBLIC_URL = previous;
    }
    return { passed, status };
}

describe('Customer quick reply template access', () => {
    it('scopes template deletion to both business and template id', async () => {
        owner();
        const first = await DB.createTemplate(1, 'Own', 'Own content');
        const second = await DB.createTemplate(2, 'Other', 'Other content');

        const wrongTenant = await DB.deleteTemplate(1, second.id);
        assert.strictEqual(wrongTenant.changes, 0);
        assert.ok(DB.get('SELECT id FROM templates WHERE id = ?', [second.id]));

        const own = await DB.deleteTemplate(1, first.id);
        assert.strictEqual(own.changes, 1);
        assert.strictEqual(DB.get('SELECT id FROM templates WHERE id = ?', [first.id]), undefined);
    });

    it('allows members to read only their business and reserves template changes for owners', () => {
        const auth = owner();
        assert.ok(check(auth, 'get', '/templates/:instanceId', { instanceId: '1' }).passed);
        assert.strictEqual(check(auth, 'get', '/templates/:instanceId', { instanceId: '2' }).status, 403);
        assert.ok(check(auth, 'post', '/templates/:instanceId', { instanceId: '1' }).passed);
        assert.strictEqual(check(auth, 'delete', '/templates/:instanceId/:templateId',
            { instanceId: '1', templateId: '99' }).passed, true);
        assert.strictEqual(check(auth, 'delete', '/templates/:instanceId/:templateId',
            { instanceId: '2', templateId: '99' }).status, 403);
        assert.strictEqual(check(auth, 'post', '/templates/:instanceId',
            { instanceId: '1' }, 'https://other.example.test').status, 403);
        assert.strictEqual(check(auth, 'delete', '/templates/:instanceId/:templateId',
            { instanceId: '1', templateId: '99' }, null).status, 403);
    });
});
