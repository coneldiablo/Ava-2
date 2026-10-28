// Built React -> actual Express -> actual SQLite/auth/roles. No API fulfills.
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output = new URL('../docs/customer-completion-20261018/ui/utf8/', import.meta.url);
await mkdir(output, { recursive: true });
const child = fork(new URL('./customer-completion-ui-server.cjs', import.meta.url), [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, NODE_PATH: '/tmp/ava-product-deps-20261017/node_modules' },
});
let stderr = '', stdout = ''; child.stderr.on('data', value => { stderr += value; }); child.stdout.on('data', value => { stdout += value; });
const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Integration fixture startup timeout')), 15000);
    child.on('message', message => { if (message.ready) { clearTimeout(timeout); resolve(message); } else if (message.fatal) { clearTimeout(timeout); reject(new Error(message.stack || message.fatal)); } });
    child.once('exit', code => reject(new Error(`Fixture exited ${code}: ${stderr.slice(-1500)}`)));
});
let rpcId = 0;
const rpc = op => new Promise((resolve, reject) => {
    const id = ++rpcId, timeout = setTimeout(() => reject(new Error('Fixture RPC timeout')), 3000);
    const handler = message => { if (message.id !== id) return; clearTimeout(timeout); child.off('message', handler); message.error ? reject(new Error(message.error)) : resolve(message.result); };
    child.on('message', handler); child.send({ id, op });
});
const results = [], pageErrors = [], apiResponses = [], screenshots = [];
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const widths = process.env.AVA_INTEGRATED_WIDTH ? [Number(process.env.AVA_INTEGRATED_WIDTH)] : [1440, 390];
const context = async (role, width) => {
    const ctx = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    if (role) await ctx.addCookies([{ name: 'crm_session', value: ready.sessions[role], url: ready.origin, httpOnly: true, sameSite: 'Lax' }]);
    await ctx.route('**/*', route => { const url = new URL(route.request().url()); return url.origin === ready.origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort(); });
    const page = await ctx.newPage(); page.setDefaultTimeout(6500);
    page.on('pageerror', error => pageErrors.push({ role, width, error: error.message }));
    page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/')) apiResponses.push({ role, width, method: response.request().method(), path: url.pathname, status: response.status() }); });
    page.on('dialog', dialog => dialog.accept());
    return { ctx, page };
};
async function action(id, role, width, page, fn) {
    const start = Date.now();
    try { await fn(); results.push({ id, role, width, status: 'PASS', level: 'integrated_local_external_boundary_fixtures', durationMs: Date.now() - start }); }
    catch (error) { const shot = `${id}-${role || 'anonymous'}-${width}-FAIL.png`; await page.screenshot({ path: new URL(shot, output).pathname, fullPage: true }).catch(() => {}); results.push({ id, role, width, status: 'FAIL', error: error.message.slice(0, 1200), body: (await page.locator('body').innerText()).slice(0, 1800), screenshot: shot, durationMs: Date.now() - start }); }
}
async function shot(page, id, width) {
    const name = `${id}-${width}.png`;
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `horizontal overflow on ${id}`);
    await page.screenshot({ path: new URL(name, output).pathname, fullPage: true }); screenshots.push(name);
}
try {
 const {ctx,page}=await context('owner',390);
 await action('UI-KNOWLEDGE-UTF8-NAME','owner',390,page,async()=>{
  await page.goto(ready.origin+'/knowledge-base'); await page.getByLabel('Название заметки',{exact:true}).fill('Правила возврата');await page.getByLabel('Содержание',{exact:true}).fill('Контрольный UTF8 текст. Правила возврата оборудования: в течение четырнадцати дней обратитесь к менеджеру, сохранив документы.');
  const response=page.waitForResponse(r=>r.url().endsWith('/knowledge-base/1/upload') && r.request().method()==='POST');
  await page.getByRole('button',{name:'Добавить текст',exact:true}).click();const uploaded=await response;assert.equal(uploaded.status(),200,JSON.stringify(await uploaded.json()));
  const names=await page.evaluate(async()=> (await (await fetch('/api/knowledge-base/1')).json()).files.map(file=>file.originalName));
  assert.ok(names.includes('Правила возврата.txt'),'UTF8 filename did not roundtrip: '+JSON.stringify(names));await page.getByRole('button',{name:'Удалить Правила возврата.txt',exact:true}).waitFor();await shot(page,'utf8-name-persisted',390);
 }); await ctx.close();

} finally {
    const snapshot = await rpc('snapshot').catch(error => ({ error: error.message }));
    await writeFile(new URL('results.json', output), JSON.stringify({ generatedAt: new Date().toISOString(), level: 'integrated_local_external_boundary_fixtures', apiIntercepts: false, builtIndexSha256: ready.builtIndexSha256, sourceHead: ready.sourceHead, sourceDigests: ready.sourceDigests, results, pageErrors, apiResponses, screenshots, snapshot }, null, 2));
    await writeFile(new URL('harness.log', output), (stdout + '\n' + stderr).replace(/VAPID_(?:PRIVATE|PUBLIC)_KEY=[^\n]*/g, 'VAPID_KEY=[REDACTED]'));
    await browser.close(); child.send({ op: 'close' }); setTimeout(() => child.kill(), 2000).unref();
}
console.log(JSON.stringify({ passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status === 'FAIL').length, results: results.map(({ id, role,width,status,error }) => ({ id,role,width,status,error })) }, null, 2));
if (results.some(r => r.status === 'FAIL')) process.exitCode = 1;
