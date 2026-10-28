'use strict';
// Real opaque/HMAC cookies + current SQLite identity; only the owner endpoint and
// callback bodies are fixtures. No customer operation or external provider call.
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.env.AVA_CHECK_ROOT || path.resolve(__dirname, '../whatsapp_crm');
const express = require(path.join(root, 'node_modules/express'));
const { createTestDB } = require(path.join(root, 'tests/test-helper'));
const DB = require(path.join(root, 'src/services/database.service'));
const Identity = require(path.join(root, 'src/services/identity/identity-store'));
const { AuthService } = require(path.join(root, 'src/services/auth.service'));
const createGuard = require(process.env.AVA_EMERGENCY_GUARD_PATH || './team-sales-emergency-guard');

async function main() {
  process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
  process.env.CRM_SERVICE_API_TOKEN = crypto.randomBytes(32).toString('hex');
  createTestDB();
  Identity.ensureSchema();
  DB.createSalesWorkspaceTables();
  DB.run("INSERT INTO instances(id,name) VALUES (1,'Fixture A'),(2,'Fixture B'),(3,'Fixture C')");
  const auth = new AuthService({ enabled: true, adminLogin: 'fixture-operator',
    sessionSecret: crypto.randomBytes(32).toString('hex'), sessionTtlHours: 1 });
  const tokens = {};
  for (const [id, role] of [['owner', 'hotel_owner'], ['manager', 'manager'],
      ['lead', 'sales_lead'], ['observer', 'observer'], ['mixed', 'hotel_owner'],
      ['none', null], ['admin', null], ['live', 'hotel_owner']]) {
    DB.run('INSERT INTO ava_users(id,subject,email,platformRole) VALUES (?,?,?,?)',
      [id, `subject-${id}`, `${id}@example.test`, id === 'admin' ? 'platform_admin' : 'customer']);
    if (role) DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES (?,1,?)', [id, role]);
    tokens[id] = `ava2:${Identity.createSession(`subject-${id}`, null)}`;
  }
  DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES ('mixed',2,'manager')");
  tokens.legacy = auth.createSession();
  tokens.forged = 'ava2:forged';
  tokens.malformed = '%xx';

  const app = express();
  app.use('/api', createGuard({ auth, identity: Identity }));
  app.use(express.json());
  app.get('/api/auth/me', (req, res) => auth.me(req, res));
  app.get('/api/auth/config', (_req, res) => res.json({ success: true }));
  app.get('/api/health', (_req, res) => res.json({ success: true }));
  // Simulate early native and public routers located before old generic auth.
  app.post('/api/modules/fixture/grants', (_req, res) => res.json({ success: true }));
  const providerPaths = [...createGuard.PROVIDER_ROUTES]
    .filter(key => key.startsWith('post ')).map(key => key.slice(5));
  providerPaths.push('/integrations/bnovo/webhooks/fixture-token', '/integrations/twenty/webhooks/fixture-token');
  for (const route of providerPaths) {
    app.post(`/api${route}`, (req, res) => {
      // This proof fixture checks exact handler invocation, not provider crypto.
      if (req.headers['x-fixture-provider-proof'] !== 'valid') return res.sendStatus(401);
      assert.equal(req.emergencyProviderCallback, true);
      res.json({ success: true });
    });
  }
  for (const key of createGuard.PROVIDER_ROUTES) {
    if (key.startsWith('get ')) app.get(`/api${key.slice(4)}`, (req, res) => {
      if (req.headers['x-fixture-provider-proof'] !== 'valid') return res.sendStatus(401);
      res.json({ success: true });
    });
  }
  app.use('/api/ml', auth.requireServiceToken.bind(auth), (_req, res) => res.json({ success: true }));
  app.use('/api', (req, res, next) => req.emergencyProviderCallback ? next() : auth.requireAuth(req, res, next));
  app.all('/api/businesses/:businessId/write', (req, res) => {
    try {
      if (req.auth?.userId) Identity.authorizeBusiness(req.auth, req.params.businessId);
      res.json({ success: true });
    }
    catch (error) { res.status(error.statusCode || 403).json({ code: error.code }); }
  });
  app.use('/api', (_req, res) => res.json({ success: true }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  let checks = 0;
  async function check(method, route, token, status, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method, headers: { ...(token ? { Cookie: `crm_session=${tokens[token] || token}` } : {}), ...headers },
    });
    assert.equal(response.status, status, `${method} ${route}: ${token || 'anonymous'}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    await response.text();
    checks++;
  }
  try {
    for (const token of ['manager', 'lead', 'observer', 'mixed', 'none']) {
      for (const [method, route] of [['GET', '/businesses/1/write'], ['POST', '/businesses/1/write'],
          ['POST', '/modules/fixture/grants'], ['POST', '/leads/1/messages'],
          ['DELETE', '/deals/1'], ['POST', '/clients/1/identities'], ['POST', '/followup/1/send'],
          ['POST', '/businesses/1/assistant-builder']]) await check(method, route, token, 403);
      await check('GET', '/auth/me', token, 200);
    }
    for (const token of ['owner', 'admin', 'legacy']) {
      await check('POST', '/businesses/1/write', token, 200);
      await check('GET', '/auth/me', token, 200);
      for (const route of ['/invitations', '/invitations/token/accept', '/owner-invitations',
        '/team-invitations/token/verify', '/businesses/1/team', '/modules/fixture/access']) {
        await check('POST', route, token, 503);
      }
      await check('POST', '/payments/webhook', token, 503);
    }
    await check('POST', '/businesses/2/write', 'owner', 403);
    for (const token of ['forged', 'malformed', undefined]) await check('POST', '/businesses/1/write', token, 401);
    await check('GET', '/health', undefined, 200);
    await check('GET', '/auth/config', undefined, 200);
    for (const route of providerPaths) {
      await check('POST', route, undefined, 401);
      await check('POST', route, undefined, 200, { 'x-fixture-provider-proof': 'valid' });
    }
    await check('POST', '/integrations/bnovo', undefined, 401);
    await check('POST', '/integrations/twenty/webhooks/token/extra', undefined, 401);
    await check('POST', '/webhook/other', undefined, 401);
    await check('POST', '/mlfake', undefined, 401);
    for (const token of ['admin', 'owner', undefined]) await check('POST', '/ml/write', token, 401);
    await check('POST', '/ml/write', undefined, 200, { 'x-service-token': process.env.CRM_SERVICE_API_TOKEN });
    await check('POST', '/businesses/1/write', 'live', 200);
    DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId='live'");
    await check('POST', '/businesses/1/write', 'live', 403);
    DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='owner'");
    await check('POST', '/businesses/1/write', 'owner', 403);
    DB.run("UPDATE ava_users SET enabled=0 WHERE id='live'");
    await check('POST', '/businesses/1/write', 'live', 401);
    DB.run("UPDATE ava_users SET platformRole='customer' WHERE id='admin'");
    await check('POST', '/businesses/1/write', 'admin', 403);
    auth.config.enabled = false;
    await check('POST', '/businesses/1/write', 'legacy', 503);
    console.log(JSON.stringify({ phase: 'emergency_http_verified', checks,
      genuineOpaqueCookies: true, liveSqliteRoles: true, earlyNativeDenied: true,
      providerBodies: 'fixtures; original signature/token implementations inspected separately' }));
  } finally {
    await new Promise(resolve => server.close(resolve));
    DB.db.close();
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
