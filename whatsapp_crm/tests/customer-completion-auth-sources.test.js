'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const { EventEmitter } = require('node:events');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Onboarding = require('../src/services/onboarding-state.service');
const Draft = require('../src/services/assistant-draft.service');
const Pages = require('../src/services/assistant-public-pages.service');
const AI = require('../src/services/ai.service');
async function fixture(run) {
    createTestDB(); Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name,systemPrompt) VALUES (1,'Own','Original'),(2,'Other','Other instruction')");
    const invite = Identity.createInvitation({ platformRole: 'platform_admin' }, { email: 'source-owner@example.test', businessId: 1, role: 'hotel_owner' });
    const owner = Identity.completeInvitation(Identity.claimInvitation(invite.token), 'source-owner');
    const extract = Pages.extractPages, generate = AI.generatePlainText;
    try { await run(owner, extract); }
    finally { Pages.extractPages = extract; AI.generatePlainText = generate; DB.db.close(); }
}
function pageRequest(html) {
    return (_url, _options, callback) => {
        const req = new EventEmitter();
        req.destroy = error => { req.emit('error', error); req.emit('close'); };
        req.end = () => queueMicrotask(() => {
            const res = new EventEmitter(); res.statusCode = 200; res.headers = { 'content-type': 'text/html' }; res.destroy = () => {};
            callback(res); res.emit('data', Buffer.from(html)); res.emit('end'); req.emit('close');
        });
        return req;
    };
}
describe('Customer completion source preparation resume', () => {
    it('uses actual extracted public facts and persists source provenance before explicit approval', () => fixture(async (owner, extract) => {
        const source = 'https://public.example.test/';
        Onboarding.savePreparation(owner, 1, { revision: 0, links: [source], supplement: '' });
        Pages.extractPages = links => extract(links, { lookup: async () => [{ address: '8.8.8.8', family: 4 }],
            request: pageRequest('<title>Repair workshop</title><h1>We repair coffee machines. Diagnostics cost 500 RUB. Repairs are quoted after diagnostics; ask an employee about availability.</h1><script>HIDDEN_FAKE_PRICE_1</script>') });
        AI.generatePlainText = async messages => {
            const material = JSON.parse(messages[1].content);
            assert.match(material.sources[0].text, /500 RUB/);
            assert.ok(!material.sources[0].text.includes('HIDDEN_FAKE_PRICE_1'));
            return JSON.stringify({ systemPrompt: 'Diagnostics cost 500 RUB. Ask an employee about repairs.' });
        };
        const preparation = Onboarding.preparation(owner, 1);
        const draft = await Draft.generate(1, { links: preparation.links, supplement: preparation.supplement });
        assert.strictEqual(draft.sources[0].status, 'read');
        assert.strictEqual(DB.get('SELECT systemPrompt FROM instances WHERE id=1').systemPrompt, 'Original');
        delete require.cache[require.resolve('../src/services/assistant-draft.service')];
        const resumed = require('../src/services/assistant-draft.service');
        assert.strictEqual(resumed.get(1).id, draft.id);
        resumed.approve(1, { draftId: draft.id, systemPrompt: 'Owner confirmed diagnostics 500 RUB.' });
        assert.strictEqual(DB.get('SELECT systemPrompt FROM instances WHERE id=1').systemPrompt, 'Owner confirmed diagnostics 500 RUB.');
        assert.strictEqual(DB.get('SELECT systemPrompt FROM instances WHERE id=2').systemPrompt, 'Other instruction');
        assert.strictEqual(Onboarding.get(owner, 1).status, 'pending');
    }));
    it('closed pages expose no invented facts, preserve manual fallback and reject stale preparation edits', () => fixture(async (owner, extract) => {
        const source = 'https://closed.example.test/';
        const saved = Onboarding.savePreparation(owner, 1, { revision: 0, links: [source], supplement: '' });
        Pages.extractPages = links => extract(links, { lookup: async () => [{ address: '8.8.8.8', family: 4 }],
            request: pageRequest('<title>Log in</title><input type="password"><p>Unverified product costs 999999 RUB. Log in to view details and prices.</p>') });
        AI.generatePlainText = async () => { throw new Error('closed page must not call the model'); };
        await assert.rejects(Draft.generate(1, { links: [source] }), { code: 'NO_USABLE_MATERIAL', statusCode: 422 });
        assert.strictEqual(Draft.get(1), null);
        assert.deepStrictEqual(Onboarding.preparation(owner, 1), saved);
        const confirmed = Onboarding.savePreparation(owner, 1, { revision: 1, links: [source], supplement: 'Confirmed by owner: repair service, quote after diagnostics.' });
        assert.throws(() => Onboarding.savePreparation(owner, 1, { revision: 1, links: [], supplement: 'stale tab' }), { code: 'ONBOARDING_PREPARATION_CHANGED' });
        const manual = Draft.manual(1, { links: confirmed.links, supplement: confirmed.supplement, systemPrompt: 'Offer repairs, quote after diagnostics. Clarify unknown prices with an employee.' });
        assert.strictEqual(manual.mode, 'manual');
        assert.strictEqual(Draft.get(1).supplement, confirmed.supplement);
        assert.ok(!JSON.stringify(manual).includes('999999'));
        Draft.approve(1, { draftId: manual.id, systemPrompt: manual.systemPrompt });
        assert.strictEqual(DB.get('SELECT systemPrompt FROM instances WHERE id=1').systemPrompt, manual.systemPrompt);
    }));
});
