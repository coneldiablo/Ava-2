// Synthetic local browser QA only. No provider credentials, production APIs or calls.
// Run against Vite: node tests/VoiceSettings.browser.mjs (default http://127.0.0.1:4189).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AVA_PLAYWRIGHT_PATH || '/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.AVA_VOICE_QA_URL || 'http://127.0.0.1:4189';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Browser QA is restricted to localhost');
const output = new URL('./evidence/neuro-voice/', import.meta.url);
await mkdir(output, { recursive: true });
const caps = ['business.read', 'business.manage', 'sales.read', 'sales.write', 'sales.assign', 'messages.send', 'tasks.claim', 'tasks.manage', 'ai.use', 'team.read', 'team.manage'];
const google = { model: 'gemini-live-2.5', voiceName: 'Kore' };
const neuro = { model: 'gemini-3.8-flash', voiceName: 'edsel' };
const providers = [
  { id: 'google_live', label: 'Google Live', available: true, models: [{ id: google.model, label: 'Gemini Live' }], voices: [{ id: 'Kore', label: 'Kore' }, { id: 'Puck', label: 'Puck' }], defaultModel: google.model, defaultVoiceName: google.voiceName },
  { id: 'neuro_gemini', label: 'Neuro + Gemini', available: true, models: [{ id: neuro.model, label: 'Gemini 3.8 Flash' }, { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' }], voices: [{ id: 'edsel', label: 'Эдсел', language: 'ru' }, { id: 'sarah', label: 'Сара', language: 'ru' }], defaultModel: neuro.model, defaultVoiceName: neuro.voiceName },
];
function profile(id, provider = 'google_live', selected = provider === 'google_live' ? google : neuro) {
  return { businessId: id, name: id === 7 ? 'Аллея · локальная проверка' : 'Кофейня · локальная проверка', hotelTimezone: 'Europe/Moscow', hotelTone: 'Дружелюбно и по делу', hotelWorkingHours: {}, sipAliases: [], sipCallerId: '', systemPrompt: `Инструкции бизнеса ${id}`, voiceGreetingTemplate: `Здравствуйте, бизнес ${id}!`, outboundOpenerTemplate: `Вам звонит бизнес ${id}.`, voiceAiProvider: provider, voiceModel: selected.model, voiceName: selected.voiceName, voiceSettings: { google_live: { ...google }, neuro_gemini: { ...neuro }, [provider]: { ...selected } } };
}
// A real short PCM WAV, generated entirely in memory; this is a tone, not provider speech.
function wavFixture() {
  const rate = 16000, samples = rate / 2, body = Buffer.alloc(44 + samples * 2);
  body.write('RIFF', 0); body.writeUInt32LE(body.length - 8, 4); body.write('WAVEfmt ', 8); body.writeUInt32LE(16, 16); body.writeUInt16LE(1, 20); body.writeUInt16LE(1, 22); body.writeUInt32LE(rate, 24); body.writeUInt32LE(rate * 2, 28); body.writeUInt16LE(2, 32); body.writeUInt16LE(16, 34); body.write('data', 36); body.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) body.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 1000), 44 + i * 2);
  return body;
}
const wav = wavFixture();
const report = { synthetic: true, local: true, productionAcceptance: false, source: 'Actual Vite routes with synthetic business-scoped browser API fixtures; preview is a generated PCM tone, not Neuro speech.', panelCaptureMethod: 'Measure at original viewport. Capture panel inside a temporarily taller viewport at unchanged width to avoid Chromium captureBeyondViewport painting offscreen fixed layers. Restore original viewport; actual viewport PNGs retain original dimensions.', base, checks: [], layouts: [], failures: [] };
const browser = await chromium.launch({ headless: true, executablePath: process.env.AVA_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

async function scenario(options = {}) {
  const context = await browser.newContext({ viewport: options.viewport || { width: 1440, height: 1000 }, reducedMotion: options.reducedMotion || 'no-preference', serviceWorkers: 'block' });
  const state = { role: options.role || 'hotel_owner', stored: new Map([[7, profile(7)], [8, profile(8, 'neuro_gemini', { model: 'gemini-3.7-flash', voiceName: 'edsel' })]]), requests: [], errors: [], consoleErrors: [], unmatched: [], blockedExternal: [], failSave: false, failPreview: false, failCatalog: false, previewGate: null };
  await context.addInitScript(() => {
    window.__voiceQa = { playCalls: 0, pauseCalls: 0, playedSources: [] };
    const play = HTMLMediaElement.prototype.play, pause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.play = function (...args) { window.__voiceQa.playCalls++; window.__voiceQa.playedSources.push(this.src.split(':')[0]); return play.apply(this, args); };
    HTMLMediaElement.prototype.pause = function (...args) { window.__voiceQa.pauseCalls++; return pause.apply(this, args); };
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { state.blockedExternal.push(url.origin); await route.abort(); return; }
    if (!path.startsWith('/api/')) { await route.continue(); return; }
    let body = null; try { body = req.postDataJSON(); } catch { /* GET has no JSON body. */ }
    state.requests.push({ method: req.method(), path, body });
    const id = Number(path.match(/(?:hotel-profiles|businesses|models)\/(\d+)/)?.[1]);
    const canEdit = state.role === 'hotel_owner';
    let data = { success: true };
    if (path === '/api/auth/me') data = { authenticated: true, userId: `synthetic-${state.role}`, login: 'local-fixture', displayName: 'Локальная проверка', role: 'customer', canCreateBusiness: false, memberships: [7, 8].map(businessId => ({ businessId, role: state.role, capabilities: canEdit ? caps : ['business.read', 'sales.read', 'team.read'] })) };
    else if (path === '/api/instances') data = { success: true, instances: [7, 8].map(businessId => ({ id: businessId, name: state.stored.get(businessId).name, isActive: 1, yandexGptModelUri: 'text-fixture-model' })) };
    else if (/\/onboarding$/.test(path)) data = { success: true, onboarding: { businessId: id, status: 'completed', confirmedSteps: ['business', 'voice', 'knowledge', 'channels', 'review'], completedAt: '2026-10-14T10:00:00Z' } };
    else if (/\/release-flags$/.test(path)) data = { success: true, businessId: id, revision: 1, flags: { workspace: true, analytics: true, autopilot: true } };
    else if (/\/voice-options$/.test(path)) {
      if (state.failCatalog) { await route.fulfill({ status: 503, json: { success: false } }); return; }
      data = { success: true, businessId: id, providers, defaultProvider: 'google_live' };
    } else if (/\/voice-preview$/.test(path)) {
      assert.equal(req.method(), 'POST'); assert.deepEqual(Object.keys(body).sort(), ['provider', 'voiceName']); assert(['neuro_gemini', 'google_live'].includes(body.provider));
      if (!canEdit) { await route.fulfill({ status: 403, json: { success: false } }); return; }
      if (state.failPreview) { state.failPreview = false; await route.fulfill({ status: 503, json: { success: false } }); return; }
      if (state.previewGate) await state.previewGate;
      await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav }); return;
    } else if (/\/assistant-draft$/.test(path)) data = { success: true, businessId: id, draft: null };
    else if (/^\/api\/hotel-profiles\/\d+$/.test(path)) {
      assert(state.stored.has(id), 'Foreign business profile request');
      if (req.method() === 'PUT') {
        if (!canEdit) { await route.fulfill({ status: 403, json: { success: false } }); return; }
        if (state.failSave) { state.failSave = false; await route.fulfill({ status: 503, json: { success: false } }); return; }
        const current = state.stored.get(id), provider = body.voiceAiProvider ?? current.voiceAiProvider;
        if (Object.keys(body).some(key => ['voiceAiProvider', 'voiceModel', 'voiceName'].includes(key))) {
          const defaults = providers.find(p => p.id === (provider || 'google_live'));
          const previous = current.voiceSettings[provider || 'google_live'];
          const selected = { model: body.voiceModel ?? previous?.model ?? defaults?.defaultModel ?? '', voiceName: body.voiceName ?? previous?.voiceName ?? defaults?.defaultVoiceName ?? '' };
          state.stored.set(id, { ...current, ...body, voiceAiProvider: provider, voiceModel: selected.model, voiceName: selected.voiceName, voiceSettings: { ...current.voiceSettings, [provider || 'google_live']: selected } });
        } else state.stored.set(id, { ...current, ...body });
      }
      data = { success: true, profile: state.stored.get(id) };
    } else if (/^\/api\/ai\/models\/\d+$/.test(path)) data = { success: true, models: [{ id: 'text-fixture-model', name: 'Модель переписки' }] };
    else if (/\/telephony$/.test(path)) data = { success: true, canManage: canEdit, canPurchase: false, canImport: false, managedMode: false, pilotEnabled: false, balanceReady: false, numbers: [], orders: [], remainingSeconds: 0, limits: { numbers: 3, dailySeconds: 1800 }, notices: [] };
    else { state.unmatched.push(path); }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('net::ERR_FAILED') && !message.text().includes('503 (Service Unavailable)')) state.consoleErrors.push(message.text()); });
  return { context, page, state };
}
async function ready(page, path = '/integrations') {
  await page.goto(`${base}${path}`);
  const panel = page.locator('.voice-settings');
  await panel.getByLabel('Режим голоса', { exact: true }).waitFor();
  await page.waitForFunction(() => { const p = document.querySelector('.voice-settings'); return p && p.getAttribute('aria-busy') === 'false' && !p.textContent.includes('Загружаем каталог'); });
  return panel;
}
async function values(panel) { return { provider: await panel.getByLabel('Режим голоса', { exact: true }).inputValue(), model: await panel.getByLabel('Модель для звонков', { exact: true }).inputValue(), voiceName: await panel.getByLabel('Голос', { exact: true }).inputValue() }; }
async function save(panel) { await panel.getByRole('button', { name: 'Сохранить голос', exact: true }).click(); await panel.getByText('Голос сохранён и проверен.', { exact: true }).waitFor(); }
async function switchBusiness(page, id) {
  const selector = page.getByLabel('Текущий бизнес', { exact: true });
  if (!await selector.isVisible()) await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
  await selector.selectOption(String(id));
  await page.locator('.voice-settings').getByLabel('Режим голоса', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.voice-settings')?.getAttribute('aria-busy') === 'false');
}
async function diagnostics(page, panel) {
  return page.evaluate(() => {
    const panel = document.querySelector('.voice-settings');
    const controls = [...panel.querySelectorAll('select,button')].map(element => { const box = element.getBoundingClientRect(); return { label: element.labels?.[0]?.textContent || element.textContent.trim(), width: box.width, height: box.height, disabled: element.disabled }; });
    const overflow = document.documentElement.scrollWidth > innerWidth + 1;
    const offenders = overflow ? [...document.querySelectorAll('main *')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1 && getComputedStyle(el).position !== 'fixed'; }).slice(0, 12).map(el => ({ tag: el.tagName, className: typeof el.className === 'string' ? el.className : '', text: el.textContent.slice(0, 60), right: el.getBoundingClientRect().right })) : [];
    const skip = document.querySelector('.crm-skip-link'), skipStyle = getComputedStyle(skip), skipRect = skip.getBoundingClientRect();
    return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, overflow, offenders, controls, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, fadeTransition: getComputedStyle(panel.querySelector('.react-bits-fade-content')).transitionDuration, activeElement: document.activeElement?.id, skipLink: { focused: document.activeElement === skip, transform: skipStyle.transform, position: skipStyle.position, top: skipRect.top, bottom: skipRect.bottom } };
  });
}
async function capturePanel(page, panel, path) {
  const viewport = page.viewportSize();
  const height = Math.ceil(await panel.evaluate(element => element.getBoundingClientRect().height)) + 32;
  try {
    await page.evaluate(() => scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, height) });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await panel.evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box = await panel.boundingBox();
    assert(box && box.y >= -1 && box.y + box.height <= page.viewportSize().height + 1, `Panel capture must fit inside the visible viewport: ${JSON.stringify({ box, captureViewport: page.viewportSize() })}`);
    await page.screenshot({ path, clip: box });
  } finally { await page.setViewportSize(viewport); }
}
async function finish(s, name) {
  assert.deepEqual(s.state.errors, [], `${name}: page errors`);
  assert.deepEqual(s.state.consoleErrors, [], `${name}: console errors`);
  assert.deepEqual(s.state.unmatched, [], `${name}: missing API fixtures`);
  report.checks.push({ name, passed: true, pageErrors: s.state.errors, consoleErrors: s.state.consoleErrors, blockedExternalOrigins: [...new Set(s.state.blockedExternal)] });
  await s.context.close();
}

try {
  const s = await scenario();
  let panel = await ready(s.page);
  await panel.getByLabel('Режим голоса', { exact: true }).focus(); await s.page.keyboard.press('Tab');
  assert.equal(await s.page.evaluate(() => document.activeElement?.id), await panel.getByLabel('Модель для звонков', { exact: true }).getAttribute('id'));
  await s.page.keyboard.press('Tab');
  assert.equal(await s.page.evaluate(() => document.activeElement?.id), await panel.getByLabel('Голос', { exact: true }).getAttribute('id'));
  await panel.getByLabel('Режим голоса').selectOption('neuro_gemini');
  await panel.getByLabel('Модель для звонков').selectOption('gemini-3.7-flash');
  await panel.getByLabel('Голос', { exact: true }).selectOption('sarah');
  assert.deepEqual(await values(panel), { provider: 'neuro_gemini', model: 'gemini-3.7-flash', voiceName: 'sarah' });
  await panel.getByRole('button', { name: 'Прослушать голос', exact: true }).click();
  await s.page.waitForFunction(() => window.__voiceQa.playCalls === 1);
  await panel.getByRole('button', { name: 'Прослушать голос', exact: true }).waitFor();
  assert.equal(await s.page.evaluate(() => window.__voiceQa.playedSources[0]), 'blob');
  assert.deepEqual(s.state.requests.find(r => r.path.endsWith('/voice-preview')).body, { provider: 'neuro_gemini', voiceName: 'sarah' });
  await save(panel);
  assert.deepEqual(s.state.requests.filter(r => r.method === 'PUT').at(-1).body, { voiceAiProvider: 'neuro_gemini', voiceModel: 'gemini-3.7-flash', voiceName: 'sarah' });
  await s.page.reload(); panel = s.page.locator('.voice-settings');
  await panel.getByText('Показаны сохранённые настройки', { exact: true }).waitFor();
  assert.deepEqual(await values(panel), { provider: 'neuro_gemini', model: 'gemini-3.7-flash', voiceName: 'sarah' });
  await panel.getByLabel('Режим голоса').selectOption('google_live'); assert.equal((await values(panel)).voiceName, 'Kore'); await save(panel);
  await panel.getByLabel('Режим голоса').selectOption('neuro_gemini');
  assert.deepEqual(await values(panel), { provider: 'neuro_gemini', model: 'gemini-3.7-flash', voiceName: 'sarah' }); await save(panel);
  await switchBusiness(s.page, 8); panel = s.page.locator('.voice-settings');
  assert.equal((await values(panel)).voiceName, 'edsel');
  await panel.getByLabel('Модель для звонков').selectOption('gemini-3.8-flash'); await save(panel);
  await switchBusiness(s.page, 7); panel = s.page.locator('.voice-settings');
  assert.deepEqual(await values(panel), { provider: 'neuro_gemini', model: 'gemini-3.7-flash', voiceName: 'sarah' });
  assert.equal(s.state.stored.get(8).voiceModel, 'gemini-3.8-flash');
  assert.equal(s.state.stored.get(7).systemPrompt, 'Инструкции бизнеса 7');
  assert.equal(s.state.stored.get(7).voiceGreetingTemplate, 'Здравствуйте, бизнес 7!');
  await panel.getByLabel('Голос', { exact: true }).selectOption('edsel'); s.state.failSave = true;
  await panel.getByRole('button', { name: 'Сохранить голос', exact: true }).click();
  await panel.getByText(/Сохранение не подтверждено/).waitFor(); assert.equal((await values(panel)).voiceName, 'edsel'); await save(panel);
  s.state.failPreview = true; await panel.getByRole('button', { name: 'Прослушать голос', exact: true }).click();
  await panel.getByText(/Не удалось прослушать голос/).waitFor();
  const playsBeforeRetry = await s.page.evaluate(() => window.__voiceQa.playCalls);
  await panel.getByRole('button', { name: 'Прослушать голос', exact: true }).click(); await s.page.waitForFunction(before => window.__voiceQa.playCalls === before + 1, playsBeforeRetry);
  await panel.getByRole('button', { name: 'Прослушать голос', exact: true }).waitFor();
  await panel.getByLabel('Голос', { exact: true }).selectOption('sarah'); s.state.failCatalog = true;
  await panel.getByRole('button', { name: 'Обновить каталог голосов', exact: true }).click();
  await panel.getByText(/Каталог голосов недоступен/).waitFor(); assert.equal((await values(panel)).voiceName, 'sarah');
  s.state.failCatalog = false; await panel.getByRole('button', { name: 'Повторить загрузку каталога', exact: true }).click();
  await panel.getByRole('button', { name: 'Сохранить голос', exact: true }).waitFor(); await save(panel);
  report.checks.push({ name: 'owner settings interactions', passed: true, keyboardControlOrder: true, dropdownSaveReadbackReload: true, previewPostAndRealWavPlayback: true, providerRestoration: true, twoBusinessIsolation: true, promptAndGreetingPreserved: true, saveFailureRetry: true, previewFailureRetry: true, catalogFailurePreservesDraft: true, mutations: s.state.requests.filter(r => r.method !== 'GET') });
  await finish(s, 'owner integrations workflow');

  const builder = await scenario(); const builderPanel = await ready(builder.page, '/assistant-builder');
  await builderPanel.getByLabel('Режим голоса').selectOption('neuro_gemini'); await builderPanel.getByLabel('Голос', { exact: true }).selectOption('sarah'); await save(builderPanel);
  await builder.page.reload(); await builder.page.locator('.voice-settings').getByText('Показаны сохранённые настройки', { exact: true }).waitFor();
  assert.equal((await values(builder.page.locator('.voice-settings'))).voiceName, 'sarah');
  assert.equal(await builder.page.getByLabel('Текущие инструкции', { exact: true }).inputValue(), 'Инструкции бизнеса 7');
  await finish(builder, 'assistant-builder save and reload preserves manual instructions');

  for (const route of ['/integrations', '/assistant-builder']) {
    const manager = await scenario({ role: 'manager' }), managerPanel = await ready(manager.page, route);
    for (const label of ['Режим голоса', 'Модель для звонков', 'Голос']) assert(await managerPanel.getByLabel(label, { exact: true }).isDisabled());
    assert(await managerPanel.getByRole('button', { name: 'Прослушать голос', exact: true }).isDisabled());
    assert.equal(await managerPanel.getByRole('button', { name: 'Сохранить голос', exact: true }).count(), 0);
    assert.equal(manager.state.requests.filter(r => r.method !== 'GET').length, 0);
    await capturePanel(manager.page, managerPanel, new URL(`manager-${route.slice(1)}.png`, output).pathname);
    await finish(manager, `manager readonly ${route}`);
  }

  const layouts = [
    { name: 'desktop-1440', viewport: { width: 1440, height: 1000 } },
    { name: 'mobile-375', viewport: { width: 375, height: 812 } },
    { name: 'tiny-320', viewport: { width: 320, height: 740 } },
    { name: 'landscape-812', viewport: { width: 812, height: 375 } },
    { name: 'reduced-motion', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' },
    { name: 'text-200', viewport: { width: 375, height: 812 }, textScale: 2 },
  ];
  for (const layout of layouts) for (const route of ['/integrations', '/assistant-builder']) {
    const s = await scenario(layout), panel = await ready(s.page, route);
    await panel.getByLabel('Режим голоса').selectOption('neuro_gemini');
    if (layout.textScale) await s.page.evaluate(scale => {
      const sizes = [...document.querySelectorAll('p,h1,h2,h3,label,summary,a,button,input,select,textarea,span,small,strong,kbd,legend')].map(element => [element, parseFloat(getComputedStyle(element).fontSize)]);
      for (const [element, size] of sizes) element.style.fontSize = `${size * scale}px`;
    }, layout.textScale);
    // Keep a natural focus target inside the reviewed panel. Do not capture the
    // separate keyboard skip-link focus overlay over unrelated form controls.
    await panel.getByLabel('Голос', { exact: true }).focus();
    const data = await diagnostics(s.page, panel);
    await capturePanel(s.page, panel, new URL(`${route.slice(1)}-${layout.name}-panel.png`, output).pathname);
    if (layout.name === 'text-200') await s.page.screenshot({ path: new URL(`${route.slice(1)}-${layout.name}-viewport.png`, output).pathname });
    if (['desktop-1440', 'mobile-375', 'text-200'].includes(layout.name)) {
      await s.page.evaluate(() => scrollTo({ top: 0, left: 0, behavior: 'instant' }));
      await s.page.screenshot({ path: new URL(`${route.slice(1)}-${layout.name}-page.png`, output).pathname, fullPage: true });
    }
    const smallControls = data.controls.filter(control => control.width < 44 || control.height < 44);
    const result = { name: layout.name, route, textScale: layout.textScale || 1, textScaleMethod: layout.textScale ? 'Computed font sizes doubled on text/form elements; not browser zoom' : null, ...data, smallControls, passed: !data.overflow && !smallControls.length };
    report.layouts.push(result);
    if (!result.passed) {
      report.failures.push({ ...result, name: `${route} ${layout.name}` });
      await s.page.screenshot({ path: new URL(`${route.slice(1)}-${layout.name}-overflow-page.png`, output).pathname, fullPage: true });
    }
    if (layout.reducedMotion === 'reduce') assert.equal(data.fadeTransition, '0s');
    await finish(s, `${route} ${layout.name}`);
  }
} catch (error) {
  report.failures.push({ name: 'browser suite exception', message: error.stack || String(error) });
  for (const [index, page] of browser.contexts().flatMap(context => context.pages()).entries()) {
    await page.screenshot({ path: new URL(`exception-${index}.png`, output).pathname, fullPage: true }).catch(() => {});
    report.failures.push({ name: `exception page ${index}`, url: page.url(), text: await page.locator('main').innerText().catch(() => ''), audio: await page.evaluate(() => window.__voiceQa).catch(() => null) });
  }
} finally {
  await browser.close();
  report.passed = report.failures.length === 0;
  await writeFile(new URL('browser-results.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checkCount: report.checks.length, layoutCount: report.layouts.length, failures: report.failures, report: new URL('browser-results.json', output).pathname }, null, 2));
  if (!report.passed) process.exitCode = 1;
}
