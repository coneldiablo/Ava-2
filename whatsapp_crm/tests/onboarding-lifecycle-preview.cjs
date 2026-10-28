'use strict';
// Loopback-only fixture. No SSO, mail, AI, channel or customer operations run.
if (process.env.NODE_ENV !== 'test') throw new Error('LOCAL_TEST_ENV_REQUIRED');
const express = require('express');
const path = require('path');
const { createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const Profiles = require('../src/services/hotel-profile.service');
const Drafts = require('../src/services/assistant-draft.service');
const Access = require('../src/services/identity/customer-access');
// Deterministic provider fixtures exercise the production draft service, never external AI/pages.
require('../src/services/assistant-public-pages.service').extractPages = async links => links.map(url => ({ url, title: 'Страница бизнеса', status: 'read', text: 'Отель Север принимает гостей. Стойка регистрации работает круглосуточно.' }));
require('../src/services/ai.service').generatePlainText = async () => JSON.stringify({ systemPrompt: 'Вы — ассистент отеля Север. Помогайте гостям, уточняйте даты проживания. Неизвестные цены и свободные номера уточняйте у сотрудника.', suggestedSettings: { hotelTone: 'Доброжелательный и спокойный', voiceGreetingTemplate: 'Здравствуйте! Чем можем помочь?' } });
createTestDB(); Identity.ensureSchema();
DB.run("INSERT INTO instances(id,name) VALUES(1,'Отель Север'),(2,'Отель Юг')");
const tokens = {};
for (const [user, role] of [['owner', 'hotel_owner'], ['second', 'hotel_owner'], ['manager', 'manager']]) {
    DB.run('INSERT INTO ava_users(id,subject,email,displayName) VALUES(?,?,?,?)', [user, user, `${user}@example.test`, user]);
    for (const businessId of [1, 2]) DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [user, businessId, role]);
    tokens[user] = Identity.createSession(user, `fixture-${user}`);
}
Auth.config.enabled = true;
process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
let selected = 'owner';
const app = express(); app.use(express.json());
app.post('/fixture/actor/:user', (req, res) => {
    if (!tokens[req.params.user]) return res.sendStatus(400);
    selected = req.params.user; return res.json({ success: true });
});
// Fixture session injection uses real signed-in users and the production session lookup.
app.use('/api', (req, _res, next) => { req.headers.cookie = `crm_session=ava2:${tokens[selected]}`; next(); });
app.get('/api/auth/me', Auth.me.bind(Auth));
app.use('/api', Auth.requireAuth.bind(Auth));
app.use('/api', require('../src/routes/onboarding-state.routes'));
app.get('/api/instances', (req, res) => res.json({ success: true, instances: DB.all('SELECT id,name FROM instances')
    .filter(row => req.auth.memberships.some(member => member.businessId === row.id)) }));
app.get('/api/hotel-profiles/:id', (req, res) => res.json({ success: true,
    profile: Profiles.toProfile(DB.get('SELECT * FROM instances WHERE id=?', [req.params.id])) }));
for (const [method, suffix, operation] of [['get', '', 'get'], ['post', '', 'generate'], ['post', '/approve', 'approve']]) {
    const route = '/hotel-profiles/:id/assistant-draft' + suffix;
    app[method]('/api' + route, Access.forRoute(method, route), async (req, res) => {
        try { const result = await Drafts[operation](Number(req.params.id), req.body);
            res.json({ success: true, businessId: Number(req.params.id), ...(operation === 'approve' ? result : { draft: result }) }); }
        catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.publicMessage || 'Повторите попытку.' }); }
    });
}
app.get('/api/knowledge-base/:id/stats', (_req, res) => res.json({ success: true, stats: { totalDocuments: 0 } }));
app.get('/api/channels/:id/status', (_req, res) => res.json({ success: true, channels: { telegramConfigured: true, telegram: false } }));
app.get('/api/businesses/:id/workspace/features', (_req, res) => res.json({ success: true, flags: { workspace: false } }));
app.use('/api', (_req, res) => res.status(404).json({ success: false }));
(async () => {
    const frontend = path.resolve(__dirname, '../frontend');
    const { createServer } = await import(require.resolve('vite', { paths: [frontend] }));
    const react = (await import(require.resolve('@vitejs/plugin-react', { paths: [frontend] }))).default;
    const vite = await createServer({ configFile: false, root: frontend, plugins: [react()], appType: 'custom',
        server: { middlewareMode: true, hmr: false } });
    app.use(vite.middlewares);
    app.get('*', async (req, res) => res.type('html').send(await vite.transformIndexHtml(req.url,
        '<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Local onboarding QA</title></head><body><div id="root"></div><script type="module" src="/tests/onboarding-lifecycle-preview.tsx"></script></body></html>')));
    const server = app.listen(Number(process.env.LOCAL_PREVIEW_PORT || 4208), '127.0.0.1', () => process.stdout.write(`LOCAL_FIXTURE_ONLY http://127.0.0.1:${server.address().port}\n`));
    process.on('SIGTERM', () => server.close(async () => { await vite.close(); DB.db.close(); process.exit(0); }));
})().catch(error => { process.stderr.write(error.message + '\n'); process.exit(1); });
