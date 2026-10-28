// Local synthetic browser QA; no production APIs, credentials or provider calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AVA_PLAYWRIGHT_PATH || '/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.AVA_TEXT_QA_URL || 'http://127.0.0.1:4193';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const output = new URL('./evidence/gemini-text/', import.meta.url);
await mkdir(output, { recursive: true });
const report = { synthetic: true, productionAcceptance: false, providerCalls: 0, checks: [], layouts: [] };
const browser = await chromium.launch({ headless: true, executablePath: process.env.AVA_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  for (const layout of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    for (const path of ['/integrations', '/assistant-builder']) {
      const context = await browser.newContext({ viewport: layout, reducedMotion: 'reduce', serviceWorkers: 'block' });
      const stored = { id: 7, name: 'Локальная проверка AVA', isActive: 1, aiProvider: 'aitunnel', yandexGptModelUri: 'text-existing', geminiModel: 'gemini-3.8-flash', voiceAiProvider: 'neuro_gemini', voiceModel: 'gemini-3.8-flash', voiceName: 'anna', systemPrompt: 'Keep instructions' };
      const writes = [], errors = [];
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), p = url.pathname;
        if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { await route.abort(); return; }
        if (!p.startsWith('/api/')) { await route.continue(); return; }
        let data = { success: true };
        if (p === '/api/auth/me') data = { authenticated: true, userId: 'synthetic-owner', login: 'fixture', displayName: 'Проверка', role: 'customer', memberships: [{ businessId: 7, role: 'hotel_owner', capabilities: ['business.read', 'business.manage', 'sales.read', 'ai.use', 'team.read'] }] };
        else if (p === '/api/instances/7' && request.method() === 'PUT') { const body = request.postDataJSON(); writes.push(body); Object.assign(stored, body); data = { success: true, instance: { ...stored } }; }
        else if (p === '/api/instances') data = { success: true, instances: [{ ...stored }] };
        else if (p === '/api/ai/providers/7') data = { success: true, provider: stored.aiProvider, model: stored.aiProvider === 'gemini' ? stored.geminiModel : stored.yandexGptModelUri, providers: [{ id: 'aitunnel', name: 'AITunnel', configured: true, defaultModel: 'text-existing' }, { id: 'gemini', name: 'Gemini', configured: true, defaultModel: 'gemini-3.8-flash' }] };
        else if (p === '/api/ai/models/7') { const provider = url.searchParams.get('provider'); data = { success: true, provider, models: provider === 'gemini' ? [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' }] : [{ id: 'text-existing' }] }; }
        else if (p.endsWith('/assistant-draft')) data = { success: true, businessId: 7, draft: null };
        else if (p.endsWith('/voice-options')) data = { success: true, businessId: 7, defaultProvider: 'neuro_gemini', providers: [{ id: 'neuro_gemini', label: 'Neuro + Gemini', available: true, models: [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }], voices: [{ id: 'anna', label: 'Анна' }], defaultModel: 'gemini-3.8-flash', defaultVoiceName: 'anna' }] };
        else if (p === '/api/hotel-profiles/7') data = { success: true, profile: { ...stored, businessId: 7, hotelTimezone: 'Europe/Moscow', hotelTone: 'Дружелюбно', hotelWorkingHours: {}, voiceSettings: { neuro_gemini: { model: stored.voiceModel, voiceName: stored.voiceName } } } };
        else if (p.endsWith('/onboarding')) data = { success: true, onboarding: { businessId: 7, status: 'completed', confirmedSteps: ['business', 'voice', 'knowledge', 'channels', 'review'], completedAt: '2026-10-14T00:00:00Z' } };
        else if (p.endsWith('/telephony')) data = { success: true, managedMode: true, settings: {}, numbers: [], capabilities: {}, credits: 0, limits: {}, notices: [] };
        else if (p.endsWith('/release-flags')) data = { success: true, businessId: 7, revision: 1, flags: {} };
        await route.fulfill({ status: 200, json: data });
      });
      const page = await context.newPage(); page.setDefaultTimeout(12000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + path);
      const panel = page.locator('#business-ai-model');
      const select = panel.getByLabel('AI для текстовых задач', { exact: true });
      await select.waitFor(); await page.waitForFunction(() => document.querySelector('#business-ai-model select')?.disabled === false);
      await select.selectOption('gemini');
      await panel.getByLabel('Модель Gemini', { exact: true }).selectOption('gemini-3.7-flash');
      await panel.getByRole('button', { name: 'Сохранить модель', exact: true }).click();
      await panel.getByText('Модель сохранена.', { exact: true }).waitFor();
      assert.deepEqual(writes, [{ aiProvider: 'gemini', geminiModel: 'gemini-3.7-flash' }]);
      assert.equal(stored.yandexGptModelUri, 'text-existing'); assert.equal(stored.voiceName, 'anna'); assert.equal(stored.systemPrompt, 'Keep instructions');
      assert.deepEqual(errors, []);
      const sizing = await panel.evaluate(element => ({ width: element.getBoundingClientRect().width, overflow: element.scrollWidth > element.clientWidth + 1, controls: [...element.querySelectorAll('select,button')].map(control => ({ width: control.getBoundingClientRect().width, height: control.getBoundingClientRect().height })) }));
      assert.equal(sizing.overflow, false); assert(sizing.controls.every(c => c.width >= 44 && c.height >= 44));
      const screenshot = `${layout.name}-${path.slice(1)}.png`;
      await panel.screenshot({ path: new URL(screenshot, output).pathname });
      report.layouts.push({ layout: layout.name, route: path, sizing, screenshot }); report.checks.push(`${layout.name} ${path}: switch/save/canonical-readback/voice-and-prompt-preservation/touch-layout PASS`);
      await context.close();
    }
  }
  report.pass = true;
} finally { await browser.close(); await writeFile(new URL('receipt.json', output), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report));
