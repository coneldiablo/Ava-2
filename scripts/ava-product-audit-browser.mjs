import { browserFixtureTls } from './browser-fixture-tls.mjs';
const fixtureTls = browserFixtureTls();
// Product audit: actual React + Express + isolated SQLite; external effects use the existing fixture.
// Mount/geometry coverage is reported separately from action acceptance.
import { fork, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const repo = new URL('../', import.meta.url);
const frontend = new URL('whatsapp_crm/frontend/', repo);
const output = new URL(`docs/ava-product-audit-20261024/evidence/${process.env.AVA_AUDIT_OUTPUT || process.argv[2] || 'before'}/`, repo);
const require = createRequire(import.meta.url);
const { chromium } = require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
await mkdir(output, { recursive: true });
const child = fork(new URL('scripts/ava-product-audit-browser.server.cjs', repo), [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let stderr = '';
child.stderr.on('data', value => { stderr += value; });
child.stdout.on('data', () => {});
let vite, browser, serial = 0;
const rpc = (op, extra = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { child.off('message', handler); reject(Error('RPC_TIMEOUT:' + op)); }, 5000);
    const handler = message => { if (message.id !== id) return; clearTimeout(timer); child.off('message', handler); message.error ? reject(Error(message.error)) : resolve(message.result); };
    child.on('message', handler); child.send({ id, op, ...extra });
});
const pages = [], errors = [], externalRequests = [], actions = [], accessibilityEvidence = [];
try {
    const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('START_TIMEOUT:' + stderr.slice(-1000))), 20000);
        child.on('message', message => { if (message.ready) { clearTimeout(timer); resolve(message); } else if (message.fatal) { clearTimeout(timer); reject(Error(message.stack || message.fatal)); } });
        child.once('exit', code => reject(Error('FIXTURE_EXIT:' + code + ':' + stderr.slice(-1000))));
    });
    await rpc('workspace-fallback', { enabled: false });
    const sourceHashes = { ...ready.sourceHashes };
    for (const path of execFileSync('rg', ['--files', 'whatsapp_crm/frontend/src'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(path => path.endsWith('.css'))) {
        sourceHashes[path] = createHash('sha256').update(await readFile(new URL(path, repo))).digest('hex');
    }
    process.chdir(frontend.pathname);
    const { createServer } = await import(new URL('node_modules/vite/dist/node/index.js', frontend));
    vite = await createServer({ root: frontend.pathname, logLevel: 'error', server: { https: fixtureTls.https, host: '127.0.0.1', port: 5317, strictPort: true, proxy: { '/api': { target: ready.origin, changeOrigin: true } } } });
    await vite.listen();
    const origin = 'https://127.0.0.1:5317';
    browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const routes = ['/', '/today', '/conversations', '/sales', '/clients', '/leads', '/deals', '/opportunities', '/calls', '/quick-replies', '/analytics', '/workspace-analytics', '/reports', '/activity', '/autopilot', '/knowledge-base', '/business-gpt', '/studio', '/simulator', '/outbound', '/triggers', '/getting-started', '/channels', '/integrations', '/team', '/instances', '/coffee', '/customers/' + ready.chatId, '/assistant-builder', '/all-leads'];
    const contexts = [['owner', [1440, 390], routes], ['manager', [1440, 390], ['/today', '/conversations', '/sales', '/clients', '/integrations', '/studio', '/customers/' + ready.chatId]], ['observer', [1440], ['/today', '/conversations', '/sales', '/clients', '/integrations', '/customers/' + ready.chatId]]];
    if (process.argv[2] === 'after') contexts.push(
        ['anonymous', [1440, 390], ['/', '/login', '/register', '/verify-email', '/forgot-password', '/owner-invite', '/invite', '/module-access']],
        ['admin', [1440, 390], ['/', '/today', '/conversations', '/clients', '/leads', '/deals', '/opportunities', '/calls', '/quick-replies', '/analytics', '/activity', '/knowledge-base', '/simulator', '/outbound', '/triggers', '/channels', '/integrations', '/team', '/instances', '/coffee', '/client/' + ready.chatId]]
    );
    contexts.push(['owner', [320], ['/', '/today', '/deals', '/leads', '/opportunities', '/analytics', '/workspace-analytics', '/reports', '/autopilot', '/business-gpt', '/channels', '/integrations']]);
    for (const [role, widths, paths] of (process.env.AVA_AUDIT_ACTIONS_ONLY ? [] : contexts)) {
        for (const width of widths) {
            const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
            if (role !== 'anonymous') await ctx.addCookies([{ name: 'crm_session', value: ready.sessions[role], url: origin, httpOnly: true, sameSite: 'Lax' }]);
            await ctx.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); externalRequests.push({ role, path: url.pathname, host: url.hostname }); return route.abort(); });
            const page = await ctx.newPage();
            page.setDefaultTimeout(8000);
            page.on('pageerror', error => errors.push({ role, width, path: new URL(page.url()).pathname, message: error.message }));
            for (const path of paths) {
                const failed = [];
                const onResponse = response => { if (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/api/')) failed.push({ path: new URL(response.url()).pathname, status: response.status() }); };
                page.on('response', onResponse);
                try {
                    await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
                    // Polling and authorization rechecks can keep a page active.
                    const settled = await page.waitForLoadState('networkidle', { timeout: 3000 }).then(() => true, () => false);
                    await page.locator('h1, [role="alert"], [role="status"]').first().waitFor().catch(() => {});
                    const name = path === '/' ? 'home' : /^\/(customers|client)\//.test(path) ? 'customer' : path.slice(1);
                    const screenshot = `${role}-${width}-${name}.png`;
                    await page.screenshot({ path: new URL(screenshot, output).pathname, fullPage: true });
                    const state = await page.locator('body').evaluate(body => {
                        const main = body.querySelector('main') || body;
                        const visible = element => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
                        return { text: main.innerText, headings: [...main.querySelectorAll('h1,h2,h3')].filter(visible).map(e => ({ tag: e.tagName, text: e.textContent.trim() })), controls: [...main.querySelectorAll('button,a,input,textarea,select,summary')].filter(visible).map(e => ({ tag: e.tagName, name: e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText || e.getAttribute('placeholder') || '', href: e.getAttribute('href'), disabled: e.disabled || false })), documentOverflow: document.documentElement.scrollWidth > innerWidth + 1, overflowElements: [...main.querySelectorAll('*')].filter(visible).filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > innerWidth + 2 || b.left < -2); }).slice(0, 12).map(e => ({ tag: e.tagName, class: String(e.className).slice(0, 100), text: e.textContent.slice(0, 90) })), height: main.scrollHeight };
                    });
                    pages.push({ role, width, path, destination: new URL(page.url()).pathname, screenshot, status: 'MOUNTED_ONLY', settled, failedRequests: failed, ...state });
                    console.log(`${role} ${width} ${path}: ${state.documentOverflow ? 'OVERFLOW' : 'mounted'}; ${failed.length} API errors; ${state.controls.length} controls`);
                } catch (error) { pages.push({ role, width, path, status: 'FAILED', error: error.message }); console.log(`${role} ${width} ${path}: FAILED ${error.message.slice(0, 100)}`); }
                page.off('response', onResponse);
            }
            await ctx.close();
        }
    }
    if (process.argv[2] === 'after') {
        const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
        await ctx.addCookies([{ name: 'crm_session', value: ready.sessions.owner, url: origin, httpOnly: true, sameSite: 'Lax' }]);
        await ctx.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const p = await ctx.newPage(); p.setDefaultTimeout(8000);
        const check = (condition, label) => { if (!condition) throw Error(label); };
        const step = async (name, run) => { if (process.env.AVA_AUDIT_ACTIONS && !new RegExp(process.env.AVA_AUDIT_ACTIONS).test(name)) return; try { await run(); actions.push({ name, status: 'PASS' }); } catch (error) { actions.push({ name, status: 'FAIL', error: error.message }); } console.log(name + ': ' + actions.at(-1).status); };
        await step('section-tabs-preserve-period-and-use-distinct-sales-views', async () => {
            await p.goto(origin + '/analytics?days=7', {waitUntil:'networkidle'});
            await p.getByRole('navigation',{name:'Результаты',exact:true}).getByRole('link',{name:'Отчёты',exact:true}).click();
            await p.waitForURL('**/reports?days=7');
            check(await p.getByLabel('Период',{exact:true}).inputValue() === '7', 'Report period not restored from URL');
            await p.goto(origin + '/deals?stage=proposal', {waitUntil:'networkidle'});
            await p.getByRole('navigation',{name:'Продажи',exact:true}).getByRole('link',{name:'Клиенты по этапам',exact:true}).click();
            await p.waitForURL('**/leads');
            check(!new URL(p.url()).searchParams.has('stage'), 'Deal filter leaked into the client entity');
        });
        await step('unified-inbox-alias-preserves-customer-source-query-hash', async () => {
            const suffix = `?client=${encodeURIComponent(ready.chatId)}&source=42&q=покупатель&view=team#aw-source-42`;
            await p.goto(origin + '/conversations' + suffix, { waitUntil: 'networkidle' });
            check(new URL(p.url()).pathname === '/today', 'Alias did not use canonical inbox');
            const expected = new URL(origin + '/today' + suffix), actual = new URL(p.url());
            check(JSON.stringify([...actual.searchParams]) === JSON.stringify([...expected.searchParams]) && actual.hash === expected.hash, 'Inbox navigation lost customer context');
            const nav = p.getByRole('navigation', { name: 'Разделы CRM', exact: true });
            check(await nav.getByRole('link', { name: 'Сегодня', exact: true }).count() === 1, 'Canonical inbox missing');
            check(await nav.getByRole('link', { name: 'Обращения', exact: true }).count() === 0, 'Duplicate inbox still shown');
        });
        await step('legacy-inbox-and-tasks-still-available-with-workspace-off', async () => {
            await rpc('workspace-fallback', { enabled: true });
            await p.goto(origin + '/today', { waitUntil: 'networkidle' });
            await p.getByRole('heading', { name: 'Задачи', exact: true }).first().waitFor();
            await p.goto(origin + '/conversations', { waitUntil: 'networkidle' });
            check(new URL(p.url()).pathname === '/conversations', 'Legacy inbox was redirected away');
            await p.getByRole('heading', { name: 'Диалоги', exact: true }).waitFor();
            await rpc('workspace-fallback', { enabled: false });
        });
        await rpc('workspace-fallback', { enabled: false });
        await step('settings-disclosures-keep-edits-and-hash-reveals-voice', async () => {
            await p.goto(origin + '/integrations', { waitUntil: 'networkidle' });
            const tone = p.getByLabel('Тон общения', { exact: true }); await tone.fill('Черновик для проверки сохранности');
            check(await p.locator('#business-instructions').evaluate(e => !e.open), 'Instructions unexpectedly expanded');
            await p.getByRole('link', { name: 'Инструкции и приветствие', exact: true }).click();
            const input = p.getByLabel('Инструкции для ответов клиентам', { exact: true }); await input.fill('Несохранённые инструкции проверки');
            await p.locator('#business-instructions > summary').click(); await p.locator('#business-instructions > summary').click();
            check(await input.inputValue() === 'Несохранённые инструкции проверки', 'Closing disclosure lost draft');
            await p.getByRole('link', { name: 'Голос и звонки', exact: true }).click();
            await p.locator('#business-voice').waitFor({ state: 'visible' });
            check(await p.locator('#business-voice').isVisible(), 'Hash did not reveal voice settings');
            check(await tone.inputValue() === 'Черновик для проверки сохранности', 'Opening voice lost profile edits');
            await p.getByLabel('Название бизнеса', { exact: true }).focus(); await p.keyboard.press('Tab');
            const focus = await p.evaluate(() => ({ style: getComputedStyle(document.activeElement).outlineStyle, width: getComputedStyle(document.activeElement).outlineWidth }));
            check(focus.style !== 'none' && parseFloat(focus.width) >= 2, 'Keyboard focus is not visible');
        });
        await step('analytics-uses-one-canonical-knowledge-editor', async () => {
            await p.goto(origin + '/analytics', { waitUntil: 'networkidle' });
            check(await p.getByRole('heading', { name: 'Улучшение ответов AVA', exact: true }).count() === 0, 'Duplicate editor still on analytics');
            await p.getByRole('link', { name: 'Улучшить ответы AVA по вопросам клиентов →', exact: true }).click();
            await p.getByRole('heading', { name: 'Улучшение ответов AVA', exact: true }).waitFor();
            check(new URL(p.url()).pathname === '/knowledge-base' && new URL(p.url()).hash === '#answer-improvements', 'Knowledge editor deep link failed');
        });
        await step('rendered-control-contrast-and-keyboard-focus', async () => {
            const contrast = (foreground, background) => {
                const luminance = value => { const channels = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { const c=v/255; return c<=.04045?c/12.92:((c+.055)/1.055)**2.4; }); return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722; };
                const a=luminance(foreground),b=luminance(background);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
            };
            await p.goto(origin+'/analytics?days=7',{waitUntil:'networkidle'});
            const tab=await p.locator('.ava-section-nav [aria-current="page"]').evaluate(e=>({foreground:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor}));
            tab.ratio=contrast(tab.foreground,tab.background);check(tab.ratio>=4.5,'Selected results label contrast');
            await p.goto(origin+'/business-gpt',{waitUntil:'networkidle'});
            const button=p.getByRole('button',{name:'Новый диалог',exact:true});await button.focus();await p.keyboard.press('Tab');await p.keyboard.press('Shift+Tab');
            const state=await button.evaluate(e=>({foreground:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor,outline:getComputedStyle(e).outlineColor,outlineWidth:getComputedStyle(e).outlineWidth,focusVisible:e.matches(':focus-visible'),surface:getComputedStyle(e.closest('.business-gpt__history')).backgroundColor}));
            state.ratio=contrast(state.foreground,state.background);state.focusRatio=contrast(state.outline,state.surface);
            check(state.ratio>=4.5&&state.focusRatio>=3&&state.focusVisible&&parseFloat(state.outlineWidth)>=2,'Assistant control contrast or focus');
            accessibilityEvidence.push({name:'selected-results-and-assistant-controls',tab,button:state});
        });
        await step('customer-timeline-is-independent-of-browser-timezone',async()=>{
            const snapshots=[];
            for(const timezoneId of ['Pacific/Honolulu','Asia/Tokyo']){
                const zone=await browser.newContext({ignoreHTTPSErrors:true,timezoneId,viewport:{width:1440,height:1000}});
                await zone.addCookies([{name:'crm_session',value:ready.sessions.owner,url:origin,httpOnly:true,sameSite:'Lax'}]);
                await zone.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
                const page=await zone.newPage();await page.goto(origin+'/customers/'+ready.chatId,{waitUntil:'networkidle'});
                await page.locator('.customer-intelligence time').first().waitFor();
                const times=await page.locator('.customer-intelligence time').evaluateAll(nodes=>nodes.map(e=>({instant:e.getAttribute('datetime'),label:e.textContent})));
                check(times.length>0,'No real timeline timestamps');snapshots.push({timezoneId,times});await zone.close();
            }
            accessibilityEvidence.push({name:'browser-timezones',snapshots});
            // The fixture produces a fresh call timestamp per GET. Compare the
            // persisted instants shared by both responses, rather than treating
            // different source records as a timezone change.
            const common=snapshots[0].times.filter(left=>snapshots[1].times.some(right=>right.instant===left.instant));
            check(common.length>0&&common.every(left=>snapshots[1].times.some(right=>right.instant===left.instant&&right.label===left.label)),'Browser timezone changed a persisted timeline instant');
        });
        await ctx.close();
        const adminContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 1000 } });
        await adminContext.addCookies([{ name: 'crm_session', value: ready.sessions.admin, url: origin, httpOnly: true, sameSite: 'Lax' }]);
        await adminContext.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        await step('operator-customer-card-has-no-roster-request-loop-or-mobile-overflow', async () => {
            const page = await adminContext.newPage(); let rosterRequests = 0;
            page.on('request', request => { if (new URL(request.url()).pathname.includes('/sales-workspace')) rosterRequests++; });
            await page.goto(origin + '/client/' + ready.chatId, { waitUntil: 'networkidle' });
            await page.getByRole('heading', { name: 'Профиль клиента', exact: true }).waitFor();
            check(rosterRequests === 0, 'Operator card still requests membership-only roster');
            check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Operator card still overflows on mobile');
        });
        await adminContext.close();
    }
    const fixture = await rpc('snapshot');
    const sourceChanged = [];
    for (const [path, hash] of Object.entries(sourceHashes)) if (createHash('sha256').update(await readFile(new URL(path, repo))).digest('hex') !== hash) sourceChanged.push(path);
    await writeFile(new URL('pages.json', output), JSON.stringify({ createdAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), gitDiffSha256: createHash('sha256').update(execFileSync('git', ['diff'], { cwd: repo })).digest('hex'), sourceHashes, sourceChanged, pages, actions, errors, accessibilityEvidence, externalRequests, externalEffects: fixture.external, limits: ['Isolated SQLite + actual current React/Express. External providers are fixtures.', 'MOUNTED_ONLY does not imply action acceptance, provider acceptance or production deployment.'] }, null, 2) + '\n');
    if (sourceChanged.length || pages.some(p => p.status === 'FAILED') || errors.length || actions.some(action => action.status === 'FAIL')) process.exitCode = 1;
    console.log(JSON.stringify({ mounts: pages.filter(p => p.status === 'MOUNTED_ONLY').length, failures: pages.filter(p => p.status === 'FAILED').length, errors, sourceChanged, externalEffects: fixture.external }));
} finally {
    await browser?.close();
    await vite?.close(); fixtureTls.cleanup();
    if (child.connected) { try { await rpc('close'); } catch { child.kill(); } }
}
