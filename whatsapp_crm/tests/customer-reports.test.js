const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const app = require('../src/app').app;

describe('Customer reports data sources', () => {
    it('returns only selected-business lead and message rows, and restricts lead downloads', async () => {
        createTestDB();
        Identity.ensureSchema();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'Own business'),(2,'Foreign business')");
        const invitation = Identity.createInvitation({ platformRole: 'platform_admin' },
            { email: 'reports@example.test', businessId: 1, role: 'manager' });
        const actor = Identity.completeInvitation(Identity.claimInvitation(invitation.token), 'reports-subject');
        const token = Identity.createSession(actor.subject, 'reports-session');
        DB.run(`INSERT INTO clients(instanceId,chatId,senderName,createdAt) VALUES
            (1,'own','Own lead',datetime('now')),
            (1,'older','Older lead',datetime('now','-15 days')),
            (2,'foreign','Foreign lead',datetime('now'))`);
        DB.run(`INSERT INTO messages(instanceId,chatId,senderName,content,role,timestamp) VALUES
            (1,'own','Own lead','own incoming','user',datetime('now')),
            (1,'own','AVA','own outgoing','assistant',datetime('now')),
            (1,'older','Older lead','old incoming','user',datetime('now','-15 days')),
            (2,'foreign','Foreign lead','foreign incoming','user',datetime('now'))`);
        const oldEnabled = Auth.config.enabled;
        const oldCustomer = process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        Auth.config.enabled = true;
        process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
        const server = await new Promise(resolve => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        try {
            const base = `http://127.0.0.1:${server.address().port}`;
            const headers = { Cookie: `crm_session=ava2:${token}` };
            const leads = await fetch(`${base}/api/analytics/leads-over-time/1?days=7`, { headers });
            assert.strictEqual(leads.status, 200);
            const leadBody = await leads.json();
            assert.strictEqual(leadBody.success, true);
            assert.strictEqual(leadBody.data.reduce((sum, row) => sum + row.count, 0), 1);
            const leads30 = await (await fetch(`${base}/api/analytics/leads-over-time/1?days=30`, { headers })).json();
            assert.strictEqual(leads30.data.reduce((sum, row) => sum + row.count, 0), 2);
            const messages = await fetch(`${base}/api/analytics/messages-over-time/1?days=7`, { headers });
            assert.strictEqual(messages.status, 200);
            const messageBody = await messages.json();
            assert.strictEqual(messageBody.success, true);
            assert.strictEqual(messageBody.data.reduce((sum, row) => sum + row.incoming, 0), 1);
            assert.strictEqual(messageBody.data.reduce((sum, row) => sum + row.outgoing, 0), 1);
            const messages30 = await (await fetch(`${base}/api/analytics/messages-over-time/1?days=30`, { headers })).json();
            assert.strictEqual(messages30.data.reduce((sum, row) => sum + row.incoming, 0), 2);
            for (const path of ['leads-over-time', 'messages-over-time', 'export']) {
                const url = path === 'export' ? `${base}/api/analytics/export/2?format=csv` : `${base}/api/analytics/${path}/2?days=7`;
                assert.strictEqual((await fetch(url, { headers })).status, 403, path);
            }
            const today = new Date().toISOString().slice(0, 10);
            const exported = await fetch(`${base}/api/analytics/export/1?format=csv&from=${today}&to=${today}`, { headers });
            assert.strictEqual(exported.status, 200);
            assert.match(exported.headers.get('content-type'), /text\/csv/);
            const csv = await exported.text();
            assert.match(csv, /Own lead/);
            assert(!csv.includes('Older lead'));
            assert(!csv.includes('Foreign lead'));
            DB.run("UPDATE clients SET senderName = ? WHERE instanceId = 1 AND chatId = 'own'",
                ['=HYPERLINK("https://example.test", "open")']);
            const formulaExport = await fetch(`${base}/api/analytics/export/1?format=csv&from=${today}&to=${today}`, { headers });
            const safeCsv = await formulaExport.text();
            assert.strictEqual(formulaExport.status, 200);
            assert.match(safeCsv, /"'=HYPERLINK\(""https:\/\/example\.test"", ""open""\)"/);
        } finally {
            await new Promise(resolve => server.close(resolve));
            Auth.config.enabled = oldEnabled;
            if (oldCustomer === undefined) delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;
            else process.env.AVA_CUSTOMER_ACCESS_ENABLED = oldCustomer;
        }
    });
});
