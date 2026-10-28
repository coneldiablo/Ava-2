// Built React -> actual Express -> actual SQLite/auth/roles. No API fulfills.
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output = process.env.AVA_UI_OUTPUT_DIR ? new URL('file://'+process.env.AVA_UI_OUTPUT_DIR.replace(/\/$/,'')+'/') : new URL('../docs/customer-completion-20261018/ui/amo-full/runtime/', import.meta.url);
await mkdir(output, { recursive: true });
const child = fork(new URL('./customer-completion-ui-amo-products-server.cjs', import.meta.url), [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, AVA_UI_HTTPS: '1', NODE_PATH: '/tmp/ava-product-deps-20261017/node_modules' },
});
let stderr = '', stdout = ''; child.stderr.on('data', value => { stderr += value; }); child.stdout.on('data', value => { stdout += value; });
const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Integration fixture startup timeout')), 15000);
    child.on('message', message => { if (message.ready) { clearTimeout(timeout); resolve(message); } else if (message.fatal) { clearTimeout(timeout); reject(new Error(message.stack || message.fatal)); } });
    child.once('exit', code => reject(new Error(`Fixture exited ${code}: ${stderr.slice(-1500)}`)));
});
let rpcId = 0;
const rpc = (op,payload={}) => new Promise((resolve, reject) => {
    const id = ++rpcId, timeout = setTimeout(() => reject(new Error('Fixture RPC timeout')), 3000);
    const handler = message => { if (message.id !== id) return; clearTimeout(timeout); child.off('message', handler); message.error ? reject(new Error(message.error)) : resolve(message.result); };
    child.on('message', handler); child.send({ id, op,...payload });
});
const results = [], pageErrors = [], apiResponses = [], apiRequests = [], screenshots = [];
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const widths = process.env.AVA_INTEGRATED_WIDTH ? [Number(process.env.AVA_INTEGRATED_WIDTH)] : [1440, 390];
const context = async (role, width) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors:true, viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    if (role) await ctx.addCookies([{ name: 'crm_session', value: ready.sessions[role], url: ready.origin, httpOnly: true, sameSite: 'Lax' }]);
    await ctx.route('**/*', route => { const url = new URL(route.request().url()); return url.origin === ready.origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort(); });
    const page = await ctx.newPage(); page.setDefaultTimeout(6500);
    page.on('request',r=>{const u=new URL(r.url());if(u.pathname.startsWith('/api/'))apiRequests.push({role,width,method:r.method(),path:u.pathname,...(u.pathname==='/api/simulate'?{body:r.postData()}: {})});});
    page.on('pageerror', error => pageErrors.push({ role, width, error: error.message }));
    page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/')) apiResponses.push({ role, width, method: response.request().method(), path: url.pathname, status: response.status() }); });
    page.on('dialog', dialog => dialog.accept());
    return { ctx, page };
};
async function action(id, role, width, page, fn) {
    if(process.env.AVA_UI_CASE&&!new RegExp(process.env.AVA_UI_CASE).test(id))return;
    if((process.env.AVA_UI_SKIP_CASES||'').split('|').includes(id+':'+width))return;
    const start = Date.now();
    try { await fn(); console.log(id,width,'PASS'); results.push({ id, role, width, status: 'PASS', level: 'integrated_local_external_boundary_fixtures', durationMs: Date.now() - start }); }
    catch (error) { console.log(id,width,'FAIL',error.message.slice(0,150)); const shot = `${id}-${role || 'anonymous'}-${width}-FAIL.png`; await page.screenshot({ path: new URL(shot, output).pathname, fullPage: true }).catch(() => {}); results.push({ id, role, width, status: 'FAIL', error: error.message.slice(0, 1200), body: (await page.locator('body').innerText()).slice(0, 1800), screenshot: shot, durationMs: Date.now() - start }); }
}
async function shot(page, id, width) {
    const name = `${id}-${width}.png`;
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `horizontal overflow on ${id}`);
    await page.screenshot({ path: new URL(name, output).pathname, fullPage: true }); screenshots.push(name);
}
const today=chat=>ready.origin+'/today?client='+encodeURIComponent(chat);
const base=chat=>'/api/businesses/1/workspace/clients/'+encodeURIComponent(chat);
async function request(page,path,method='GET',body){return page.evaluate(async({path,method,body})=>{const r=await fetch(path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};},{path,method,body});}
function waitResponse(p,match){const pending=p.waitForResponse(match);pending.catch(()=>{});return pending;}
async function snapshotUntil(test){for(let i=0;i<70;i++){const s=await rpc('snapshot');if(test(s))return s;await new Promise(r=>setTimeout(r,100));}throw new Error('Canonical SQLite readback timeout');}
async function openContext(p,width,chat=ready.chatId){await p.goto(today(chat));await p.locator('#aw-client-title').waitFor();if(width===390)await p.getByRole('button',{name:'Открыть контекст клиента',exact:true}).click();}
const future=new Date(Date.now()+2*86400000).toISOString().slice(0,16);
try{for(const width of widths){const{ctx,page}=await context('owner',width);
 await action('AMO-PREVIEW-PUBLISH-REFRESH','owner',width,page,async()=>{
  await rpc('mode',{value:{amoPrice:'2499.90',amoFail:0}});
  await page.goto(ready.origin+'/channels?channel=amocrm');
  const panel=page.locator('.amo-catalog');await panel.getByRole('heading',{name:'Каталог amoCRM',exact:true}).waitFor();
  const prepare=panel.getByRole('button',{name:'Загрузить актуальные товары и цены',exact:true});await panel.getByLabel('Валюта, если источник её не передаёт',{exact:true}).selectOption('');await prepare.click();
  await panel.getByText('Подтвердите валюту цены',{exact:true}).waitFor();
  await panel.getByLabel('Валюта, если источник её не передаёт',{exact:true}).selectOption('RUB');
  await prepare.click();await panel.getByRole('cell',{name:'Готов к публикации',exact:true}).waitFor();
  await shot(page,'amo-preview-source-prices',width);
  const state=(await request(page,'/api/external-integrations/1/amocrm/catalog')).data.catalog;
  assert.equal(state.preview.items[0].offer.amountMinor,249990);assert.equal(state.preview.items[0].offer.currency,'RUB');
  await panel.getByRole('button',{name:'Опубликовать товары и цены',exact:true}).click();
  await panel.getByRole('button',{name:'Этот предпросмотр опубликован',exact:true}).waitFor();
  const offerId=state.preview.items[0].offerId;
  const catalog=(await request(page,'/api/businesses/1/catalog')).data;
  assert.ok(catalog.offers.some(o=>o.id===offerId&&o.amountMinor===249990&&o.publishedAt));
  const quote=await request(page,'/api/businesses/1/quotes','POST',{chatId:ready.chatId,offerId,quantity:2});
  assert.equal(quote.status,201);assert.equal(quote.data.quote.totalMinor,499980);
  await panel.getByLabel('Обновлять цены автоматически',{exact:true}).check();
  await panel.getByRole('button',{name:'Сохранить расписание',exact:true}).click();
  await panel.getByText('Расписание обновления сохранено.',{exact:true}).waitFor();
  await page.reload();await panel.getByLabel('Обновлять цены автоматически',{exact:true}).waitFor();assert.ok(await panel.getByLabel('Обновлять цены автоматически',{exact:true}).isChecked());
  await rpc('mode',{value:{amoPrice:'2799.25'}});await prepare.click();await panel.getByRole('cell',{name:/2.*799/}).waitFor();
  await panel.getByRole('button',{name:'Опубликовать товары и цены',exact:true}).click();await panel.getByRole('button',{name:'Этот предпросмотр опубликован',exact:true}).waitFor();
  assert.ok((await request(page,'/api/businesses/1/catalog')).data.offers.some(o=>o.id===offerId&&o.amountMinor===279925));
  await shot(page,'amo-published-source-freshness',width);
  await page.goto(ready.origin+'/autopilot?tab=catalog');await page.locator('.amo-catalog h3').waitFor();
  await page.getByText('Катушка из amoCRM',{exact:true}).first().waitFor();assert.ok(await page.getByText('Катушка из amoCRM',{exact:true}).count());
  assert.ok(await page.getByText('Комплект электропастуха',{exact:true}).count());
  await shot(page,'amo-canonical-catalog',width);
 });
 await action('AMO-PROVIDER-FAILURE-READBACK-RETRY','owner',width,page,async()=>{
  await page.goto(ready.origin+'/autopilot?tab=catalog');const panel=page.locator('.amo-catalog');
  await panel.getByLabel('Валюта, если источник её не передаёт',{exact:true}).waitFor();
  const before=(await request(page,'/api/businesses/1/catalog')).data.offers;
  await rpc('mode',{value:{amoFail:1}});await panel.getByRole('button',{name:'Загрузить актуальные товары и цены',exact:true}).click();
  await panel.getByRole('button',{name:'Проверить результат операции',exact:true}).waitFor();
  assert.deepEqual((await request(page,'/api/businesses/1/catalog')).data.offers,before);
  await panel.getByRole('button',{name:'Проверить результат операции',exact:true}).click();
  await panel.getByText('Сохранённое состояние проверено.',{exact:true}).waitFor();
  await panel.getByRole('button',{name:'Загрузить актуальные товары и цены',exact:true}).click();
  await panel.getByRole('button',{name:'Опубликовать товары и цены',exact:true}).waitFor();
  await shot(page,'amo-retry-preserved-catalog',width);
 });await ctx.close();
 for(const role of ['manager','observer','foreign']){const{ctx:rc,page:p}=await context(role,width);await action('AMO-ROLE-TENANT-'+role.toUpperCase(),role,width,p,async()=>{
  await p.goto(ready.origin+'/autopilot?tab=catalog');await p.locator('h1').waitFor();if(role!=='foreign')assert.equal(await p.locator('.amo-catalog').count(),0);else await p.getByText('Для загрузки товаров подключите amoCRM.',{exact:false}).waitFor();
  for(const [method,suffix,body] of [['POST','/preview',{}],['POST','/publish',{previewId:'foreign'}],['PUT','/settings',{enabled:true,intervalMinutes:60}]])assert.equal((await request(p,'/api/external-integrations/1/amocrm/catalog'+suffix,method,body)).status,403);
  if(role==='foreign')assert.equal((await request(p,'/api/external-integrations/1/amocrm/catalog')).status,403);
 });await rc.close();}
}}
finally{const snapshot=await rpc('snapshot').catch(e=>({error:e.message}));await writeFile(new URL('results.json',output),JSON.stringify({generatedAt:new Date().toISOString(),level:'actual_React_Express_SQLite_Auth_external_boundary_fixtures',internalApiFulfill:false,sourceHead:ready.sourceHead,sourceDigests:ready.sourceDigests,builtIndexSha256:ready.builtIndexSha256,results,pageErrors,apiRequests,apiResponses,screenshots,snapshot},null,2));await writeFile(new URL('harness.log',output),(stdout+'\n'+stderr).replace(/VAPID_(?:PRIVATE|PUBLIC)_KEY=[^\n]*/g,'VAPID_KEY=[REDACTED]'));await browser.close();child.send({op:'close'});setTimeout(()=>child.kill(),2000).unref();}
console.log(JSON.stringify({passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length}));if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
