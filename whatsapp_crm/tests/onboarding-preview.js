'use strict';
// Local UI fixture only. No native SSO, telephony, messaging or AI is called.
// Not imported by run-tests.js and never copied as a production entrypoint.
if (process.env.NODE_ENV !== 'test') throw new Error('LOCAL_TEST_ENV_REQUIRED');
const express = require('express');
const path = require('path');
const { createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Store = require('../src/services/provisioning/business-provisioning-store.service');
const Hotel = require('../src/services/hotel-profile.service');
const Access = require('../src/services/identity/customer-access');

createTestDB();
const invitation = Identity.createInvitation({ platformRole: 'platform_admin' }, { email: 'buyer@example.test' });
const owner = Identity.completeInvitation(Identity.claimInvitation(invitation.token), 'fixture-subject');
DB.run('UPDATE ava_users SET businessQuota=3 WHERE id=?', [owner.userId]);
for (const [name, voice] of [['QA Отель Север', 'google_live'], ['QA Отель Юг', 'openai_realtime']]) {
    Store.createBusinessAtomic({ name, businessType: 'hotel', voiceAiProvider: voice }, { ownerUserId: owner.userId });
}
const app = express();
app.use(express.json());
app.get('/api/auth/me', (_req, res) => res.json({ authenticated: true, login: 'buyer@example.test', role: 'customer', memberships: Identity.actor(owner.userId).memberships }));
app.use('/api', (req, _res, next) => { req.auth = Identity.actor(owner.userId); next(); });
app.get('/api/instances', (_req, res) => res.json({ success: true, instances: Access.filterInstances(DB.all('SELECT * FROM instances'), Identity.actor(owner.userId)) }));
app.post('/api/instances', async (req, res) => {
    try {
        const result = Store.createBusinessAtomic(req.body, { ownerUserId: owner.userId, idempotencyKey: req.get('Idempotency-Key') });
        res.json({ success: true, instance: result.instance });
    } catch (_) { res.status(409).json({ success: false }); }
});
app.get('/api/hotel-profiles/:id', Access.forRoute('get','/hotel-profiles/:id'), async (req, res) => res.json({ success: true, profile: await Hotel.get(req.params.id) }));
app.put('/api/hotel-profiles/:id', Access.forRoute('put','/hotel-profiles/:id'), async (req, res) => {
    try { res.json({ success: true, profile: await Hotel.update(req.params.id, req.body) }); }
    catch (_) { res.status(400).json({ success: false }); }
});
app.get('/api/instances/:id/provisioning', Access.forRoute('get','/instances/:id/provisioning'), (req, res) => res.json({ success: true, provisioning: Store.getProvisioningStatus(Number(req.params.id)) }));
app.get('/api/knowledge-base/:instanceId', Access.forRoute('get','/knowledge-base/:instanceId'), (_req, res) => res.json({ success: true, files: [] }));
app.get('/api/openwa/status/:instanceId', Access.forRoute('get','/openwa/status/:instanceId'), (_req, res) => res.json({ success: true, state: { stateInstance: 'notConfigured' } }));
app.post('/api/openwa/connect/:instanceId', Access.forRoute('post','/openwa/connect/:instanceId'), (_req, res) => res.status(503).json({ success: false }));
app.get('/api/openwa/qr/:instanceId', (_req, res) => res.json({ success: true, type: 'pending' }));
app.use('/api', (_req, res) => res.sendStatus(404));
app.use(express.static(path.resolve(__dirname, '../frontend/dist')));
app.get('*', (_req, res) => res.sendFile(path.resolve(__dirname, '../frontend/dist/index.html')));
const server = app.listen(4117, '127.0.0.1', () => process.stdout.write('LOCAL_FIXTURE_ONLY http://127.0.0.1:4117\n'));
process.on('SIGTERM', () => server.close(() => { DB.db.close(); process.exit(0); }));
