// Built React -> actual Express -> actual SQLite/auth/roles. No API fulfills.
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output = new URL('../docs/customer-completion-20261018/ui/business-runtime/', import.meta.url);
await mkdir(output, { recursive: true });
const child = fork(new URL('./customer-completion-ui-server.cjs', import.meta.url), [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, AVA_UI_HTTPS: '1', NODE_PATH: '/tmp/ava-product-deps-20261017/node_modules' },
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
    const ctx = await browser.newContext({ ignoreHTTPSErrors:true, viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
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
    try { await fn(); console.log(id,width,'PASS'); results.push({ id, role, width, status: 'PASS', level: 'integrated_local_external_boundary_fixtures', durationMs: Date.now() - start }); }
    catch (error) { console.log(id,width,'FAIL',error.message.slice(0,150)); const shot = `${id}-${role || 'anonymous'}-${width}-FAIL.png`; await page.screenshot({ path: new URL(shot, output).pathname, fullPage: true }).catch(() => {}); results.push({ id, role, width, status: 'FAIL', error: error.message.slice(0, 1200), body: (await page.locator('body').innerText()).slice(0, 1800), screenshot: shot, durationMs: Date.now() - start }); }
}
async function shot(page, id, width) {
    const name = `${id}-${width}.png`;
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `horizontal overflow on ${id}`);
    await page.screenshot({ path: new URL(name, output).pathname, fullPage: true }); screenshots.push(name);
}
try {
 for(const width of widths) {
  const {ctx,page}=await context('owner',width);
  await action('BIZ-QUICK-REPLY-CRUD','owner',width,page,async()=>{
   await page.goto(ready.origin+'/quick-replies');await page.getByLabel('Название',{exact:true}).fill('Приветствие '+width);await page.getByLabel('Текст ответа',{exact:true}).fill('Здравствуйте, тестовый покупатель.');
   await page.getByRole('button',{name:'Сохранить шаблон',exact:true}).press('Enter');await page.getByRole('heading',{name:'Приветствие '+width,exact:true}).waitFor();await page.reload();await page.getByRole('heading',{name:'Приветствие '+width,exact:true}).waitFor();
   await page.getByLabel('Найти быстрый ответ',{exact:true}).fill('несуществующий');await page.getByText(/не найден/i).waitFor();await page.getByLabel('Найти быстрый ответ',{exact:true}).fill('');
   await page.getByRole('button',{name:'Удалить шаблон «Приветствие '+width+'»',exact:true}).click();await page.reload();assert.equal(await page.getByRole('heading',{name:'Приветствие '+width,exact:true}).count(),0);await shot(page,'quick-reply-removed',width);
  });
  await action('BIZ-DEAL-CURRENCIES-STAGES-VIEWS','owner',width,page,async()=>{
   const title='Сделка UI '+width;
   await page.goto(ready.origin+'/deals');await page.getByRole('button',{name:'Новая сделка',exact:true}).click();
   const form=page.getByRole('region',{name:'Новая сделка',exact:true});await form.getByLabel('Название сделки *',{exact:true}).fill(title);await form.getByLabel('Сумма',{exact:true}).fill('123.45');
   await form.getByLabel('Клиент',{exact:true}).selectOption(ready.chatId);await form.getByLabel('Ответственный',{exact:true}).fill('Менеджер');await form.getByLabel('Следующее действие',{exact:true}).fill('Позвонить после проверки');await form.getByLabel('Дата действия',{exact:true}).fill('2026-10-20');await form.getByLabel('Заметка',{exact:true}).fill('Тестовая заметка');
   await form.getByRole('button',{name:'Создать сделку',exact:true}).click();await page.getByText('Сделка создана.',{exact:true}).waitFor();
   for(const [currency,stage] of [['USD','qualified'],['EUR','proposal'],['KZT','negotiation'],['RUB','won'],['RUB','lost'],['RUB','new']]) {
    await page.getByRole('button',{name:'Изменить сделку '+title,exact:true}).click();const editor=page.getByRole('region',{name:'Изменить сделку',exact:true});
    await editor.getByLabel('Валюта',{exact:true}).selectOption(currency);await editor.getByLabel('Этап',{exact:true}).selectOption(stage);
    if(stage==='lost') await editor.getByLabel('Причина потери',{exact:true}).fill('Контрольный отказ');
    await editor.getByRole('button',{name:'Сохранить',exact:true}).click();await page.getByText('Сделка обновлена.',{exact:true}).waitFor();await page.reload();
    const stored=await page.evaluate(async title=>(await (await fetch('/api/deals/1')).json()).deals.find(deal=>deal.title===title),title);assert.equal(stored.currency,currency);assert.equal(stored.stage,stage);assert.equal(stored.amount,123.45);
   }
   for(const view of ['Список','План по датам','Прогноз','Канбан']) {await page.getByRole('button',{name:view,exact:true}).click();assert.equal(await page.getByRole('button',{name:view,exact:true}).getAttribute('aria-pressed'),'true');}
   await page.getByLabel('Поиск сделок',{exact:true}).fill('ничего');assert.equal(await page.getByRole('button',{name:'Изменить сделку '+title,exact:true}).count(),0);await page.getByLabel('Поиск сделок',{exact:true}).fill('');
   await page.getByRole('button',{name:'Изменить сделку '+title,exact:true}).click();await page.getByRole('button',{name:'Отмена',exact:true}).click();await page.getByRole('button',{name:'Удалить сделку '+title,exact:true}).click();await page.getByText('Сделка удалена.',{exact:true}).waitFor();await page.reload();assert.equal(await page.getByRole('link',{name:title,exact:true}).count(),0);await shot(page,'deal-removed',width);
  });
  await action('BIZ-ALL-LEADS-STATUS-TAG-EXPORT','owner',width,page,async()=>{
   await page.goto(ready.origin+'/all-leads');const status=page.getByRole('combobox',{name:'Статус клиента Тестовый покупатель',exact:true});await status.waitFor();
   const values=await status.locator('option').evaluateAll(items=>items.map(item=>item.value));
   for(const value of values){if(await status.inputValue()!==value){const change=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().includes('/status'));await status.selectOption(value);await change;}await page.reload();assert.equal(await status.inputValue(),value);}
   await page.getByRole('button',{name:'Подробнее',exact:true}).first().click();const tag='ui-tag-'+width;const tagResponse=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().includes('/tags'));await page.getByLabel('Добавить тег клиенту',{exact:true}).fill(tag);await page.getByLabel('Добавить тег клиенту',{exact:true}).press('Enter');await tagResponse;await page.reload();await page.getByRole('button',{name:'Подробнее',exact:true}).first().click();await page.getByText('#'+tag,{exact:true}).first().waitFor();
   await page.getByLabel('Добавить тег клиенту',{exact:true}).fill(tag);await page.getByLabel('Добавить тег клиенту',{exact:true}).press('Enter');
   const storedTags=await page.evaluate(async chatId=>JSON.parse((await (await fetch('/api/clients/1')).json()).clients.find(client=>client.chatId===chatId).tags),ready.chatId);assert.equal(storedTags.filter(item=>item===tag).length,1);
   const download=page.waitForEvent('download');await page.getByRole('button',{name:'CSV',exact:true}).click();await (await download).saveAs(new URL('clients-'+width+'.csv',output).pathname);
   await page.getByLabel('Поиск клиентов',{exact:true}).fill('ничего');await page.getByRole('button',{name:'Очистить поиск',exact:true}).click();await status.waitFor();await shot(page,'clients-status-tag',width);
  });
  await action('BIZ-SETTINGS-PERSIST','owner',width,page,async()=>{
   await page.goto(ready.origin+'/integrations');await page.getByLabel('Тон общения',{exact:true}).fill('Кратко, спокойно и по делу '+width);await page.getByLabel('Часовой пояс',{exact:true}).fill('Europe/Moscow');
   await page.getByLabel('Инструкции для ответов клиентам',{exact:true}).fill('Тестовая инструкция: подтверждай наличие у менеджера. '+width);
   await page.getByLabel('Приветствие при входящем звонке',{exact:true}).fill('Здравствуйте! Контрольный бизнес.');await page.getByLabel('Начало исходящего звонка',{exact:true}).fill('Добрый день, контрольный звонок.');
   for(const day of ['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье']) {await page.getByLabel(day,{exact:true}).check();await page.getByLabel(day+': начало работы',{exact:true}).fill('10:00');await page.getByLabel(day+': конец работы',{exact:true}).fill('19:00');}
   await page.getByRole('button',{name:'Сохранить настройки',exact:true}).click();await page.getByText('Настройки сохранены и проверены. Новые звонки этого бизнеса используют сохранённые инструкции.',{exact:true}).waitFor();await page.reload();assert.equal(await page.getByLabel('Тон общения',{exact:true}).inputValue(),'Кратко, спокойно и по делу '+width);
   assert.equal(await page.getByLabel('Воскресенье: конец работы',{exact:true}).inputValue(),'19:00');await shot(page,'settings-persisted',width);
  });
  await action('BIZ-REPORTS-PERIODS-EXPORT','owner',width,page,async()=>{
   await page.goto(ready.origin+'/reports');
   for(const report of ['Сделки','Клиенты','Сообщения','Звонки']) {const button=page.getByRole('group',{name:'Тип отчёта',exact:true}).getByRole('button',{name:new RegExp('^'+report)});await button.click();for(const period of ['7','30','90']) {await page.getByLabel('Период',{exact:true}).selectOption(period);await page.getByRole('heading',{name:report+' · последние '+period+' дней',exact:true}).waitFor();}assert.equal(await button.getAttribute('aria-pressed'),'true');}
   await page.getByRole('group',{name:'Тип отчёта',exact:true}).getByRole('button',{name:/^Клиенты/}).click();
   for(const format of ['csv','xlsx']) {await page.getByLabel('Формат',{exact:true}).selectOption(format);const dl=page.waitForEvent('download');await page.getByRole('button',{name:'Скачать',exact:true}).click();const item=await dl;const target=new URL('report-'+width+'.'+format,output).pathname;await item.saveAs(target);const bytes=await readFile(target);assert.ok(bytes.length>20);if(format==='xlsx')assert.equal(bytes.subarray(0,2).toString(),'PK');}
   await shot(page,'reports-exports',width);
  });
  await action('BIZ-ACTIVITY-FILTERS','owner',width,page,async()=>{
   await page.goto(ready.origin+'/activity');
   for(const label of ['Всё','Сообщения','Звонки','Задачи','Повторные контакты','Статусы']) {const b=page.getByRole('group',{name:'Фильтр активности',exact:true}).getByRole('button',{name:label,exact:true});await b.click();assert.equal(await b.getAttribute('aria-pressed'),'true');}
   await shot(page,'activity-filters',width);
  });
  await action('BIZ-GPT-CRM-HISTORY','owner',width,page,async()=>{
   await page.goto(ready.origin+'/business-gpt');await page.getByRole('button',{name:'Новый диалог',exact:true}).click();await page.getByLabel('Вопрос по базе знаний',{exact:true}).fill('Как идут продажи в моём бизнесе?');await page.getByRole('button',{name:'Отправить вопрос',exact:true}).click();
   await page.getByRole('log',{name:'Сообщения диалога',exact:true}).getByText(/CRM:|Сохранённые|Клиентов/i).first().waitFor();await page.reload();await page.getByRole('log',{name:'Сообщения диалога',exact:true}).getByText('Как идут продажи в моём бизнесе?',{exact:true}).waitFor();await shot(page,'business-gpt-history',width);
  });
  await ctx.close();
  for(const role of ['lead','manager','observer']) {
   const scoped=await context(role,width),q=scoped.page;
   await action('BIZ-ROLE-DEAL-TEMPLATE-'+role.toUpperCase(),role,width,q,async()=>{
    const title='Role deal '+role+' '+width;await q.goto(ready.origin+'/deals');await q.getByRole('heading',{name:'Сделки',exact:true}).waitFor();
    if(role==='observer'){assert.equal(await q.getByRole('button',{name:'Новая сделка',exact:true}).count(),0);const denied=await q.evaluate(async()=> (await fetch('/api/deals/1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'forbidden'})})).status);assert.equal(denied,403);}
    else {await q.getByRole('button',{name:'Новая сделка',exact:true}).click();const form=q.getByRole('region',{name:'Новая сделка',exact:true});await form.getByLabel('Название сделки *',{exact:true}).fill(title);await form.getByLabel('Клиент',{exact:true}).selectOption(ready.chatId);await form.getByRole('button',{name:'Создать сделку',exact:true}).click();await q.getByText('Сделка создана.',{exact:true}).waitFor();await q.reload();await q.getByRole('button',{name:'Удалить сделку '+title,exact:true}).click();await q.getByText('Сделка удалена.',{exact:true}).waitFor();}
    const foreign=await q.evaluate(async()=> (await fetch('/api/deals/3')).status);assert.equal(foreign,403);
    await q.goto(ready.origin+'/quick-replies');await q.getByRole('heading',{name:'Быстрые ответы',exact:true}).waitFor();assert.equal(await q.getByRole('button',{name:'Сохранить шаблон',exact:true}).count(),0);
    const deniedTemplate=await q.evaluate(async()=> (await fetch('/api/templates/1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:'forbidden',text:'forbidden'})})).status);assert.equal(deniedTemplate,403);await shot(q,'business-role-'+role,width);
   });await scoped.ctx.close();
  }
 }

} finally {
    const snapshot = await rpc('snapshot').catch(error => ({ error: error.message }));
    await writeFile(new URL('results.json', output), JSON.stringify({ generatedAt: new Date().toISOString(), level: 'integrated_local_external_boundary_fixtures', apiIntercepts: false, builtIndexSha256: ready.builtIndexSha256, sourceHead: ready.sourceHead, sourceDigests: ready.sourceDigests, results, pageErrors, apiResponses, screenshots, snapshot }, null, 2));
    await writeFile(new URL('harness.log', output), (stdout + '\n' + stderr).replace(/VAPID_(?:PRIVATE|PUBLIC)_KEY=[^\n]*/g, 'VAPID_KEY=[REDACTED]'));
    await browser.close(); child.send({ op: 'close' }); setTimeout(() => child.kill(), 2000).unref();
}
console.log(JSON.stringify({ passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status === 'FAIL').length, results: results.map(({ id, role,width,status,error }) => ({ id,role,width,status,error })) }, null, 2));
if (results.some(r => r.status === 'FAIL')) process.exitCode = 1;
