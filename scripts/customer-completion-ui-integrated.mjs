// Built React -> actual Express -> actual SQLite/auth/roles. No API fulfills.
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output = new URL(process.env.AVA_UI_OUTPUT_DIR || '../docs/customer-completion-20261018/ui/integrated/', import.meta.url);
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
    if (process.env.AVA_UI_CASE && !new RegExp(process.env.AVA_UI_CASE).test(id)) return;
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
 for (const width of widths) {
  const {ctx, page} = await context('owner', width);
  await action('UI-TASK-CREATE-EDIT-ASSIGN', 'owner', width, page, async () => {
   await page.goto(ready.origin + '/sales?view=team');
   await page.getByRole('button', {name:'Новая задача',exact:true}).click();
   await page.getByLabel('Клиент',{exact:true}).fill('Тестовый');
   await page.getByRole('list', {name:'Найденные клиенты'}).getByRole('button').first().click();
   await page.getByLabel('Что нужно сделать',{exact:true}).fill('Проверка UI ' + width);
   await page.getByRole('region',{name:'Новая задача',exact:true}).getByLabel('Приоритет',{exact:true}).selectOption('high');
   await page.getByRole('region',{name:'Новая задача',exact:true}).getByLabel('Ответственный',{exact:true}).selectOption('manager');
   await page.getByRole('button',{name:'Создать задачу',exact:true}).press('Enter');
   await page.getByText('Задача создана. Список обновлён.',{exact:true}).waitFor();
   await page.reload();
   await page.waitForFunction(()=>document.querySelector('[aria-labelledby="sales-tasks-title"]')?.getAttribute('aria-busy')==='false');
   const row=page.locator('li.sales-task').filter({hasText:'Проверка UI ' + width});
   if(await row.count()===0) { const pagination=page.getByRole('navigation',{name:'Страницы задач и клиентов',exact:true}); await pagination.getByRole('button',{name:'Далее',exact:true}).click(); await page.waitForURL(/page=2/); }
   await row.getByRole('button',{name:'Изменить',exact:true}).click();
   await row.getByLabel('Состояние задачи').selectOption('done');
   await row.getByRole('button',{name:'Сохранить',exact:true}).click();
   await page.getByText(/Задача завершена/).waitFor();
   assert.ok((await rpc('snapshot')).tasks.some(t=>t.status==='done' && t.assigneeUserId==='manager'));
   await shot(page,'tasks-completed',width);
  });
  await action('UI-SHIFT-SAVE-CANCEL-SEARCH', 'owner', width, page, async () => {
   await page.goto(ready.origin+'/team');
   await page.getByRole('button',{name:'Изменить смену · Менеджер',exact:true}).click();
   await page.getByLabel('Смена · Менеджер',{exact:true}).selectOption('break');
   await page.getByLabel('Лимит активных клиентов · Менеджер',{exact:true}).fill('8');
   await page.getByRole('button',{name:'Сохранить смену',exact:true}).press('Enter');
   await page.getByText('Смена для Менеджер сохранена.',{exact:true}).waitFor();
   await page.reload();
   await page.getByRole('button',{name:'Изменить смену · Менеджер',exact:true}).click();
   assert.equal(await page.getByLabel('Смена · Менеджер',{exact:true}).inputValue(),'break');
   assert.equal(await page.getByLabel('Лимит активных клиентов · Менеджер',{exact:true}).inputValue(),'8');
   await page.getByRole('button',{name:'Отмена',exact:true}).click();
   await page.getByLabel('Найти сотрудника',{exact:true}).fill('нет-совпадений');
   await page.getByText('Сотрудники не найдены.',{exact:true}).waitFor();
   await page.getByLabel('Найти сотрудника',{exact:true}).fill('');
   await shot(page,'shifts-readback',width);
  });
  await action('UI-INVITE-RENEW-REVOKE', 'owner', width, page, async () => {
   await page.goto(ready.origin+'/team');
   await page.getByLabel('Рабочая почта').fill('controlled-'+width+'@example.test');
   await page.getByRole('button',{name:'Пригласить',exact:true}).click();
   const link=page.getByLabel(/Личная ссылка/); await link.waitFor(); const before=await link.inputValue();
   const pending=page.getByRole('region',{name:'Приглашения',exact:true});
   const row=pending.locator('li').filter({hasText:'controlled-'+width+'@example.test'});
   await row.getByRole('button',{name:'Обновить ссылку',exact:true}).click();
   await page.waitForFunction(before=>document.querySelector('#invite-link')?.value!==before,before);
   await row.getByRole('button',{name:'Отозвать',exact:true}).click();
   await page.getByText(/Приглашение для .* отозвано/).waitFor();
   await page.reload(); assert.equal(await page.getByText('controlled-'+width+'@example.test',{exact:true}).count(),0);
   await shot(page,'invitation-revoked',width);
  });
  await action('UI-KNOWLEDGE-ADD-DELETE', 'owner', width, page, async () => {
   await page.goto(ready.origin+'/knowledge-base');
   await page.getByRole('heading',{name:'Добавить текст',exact:true}).waitFor();
   await page.getByLabel('Название заметки',{exact:true}).fill('Rules '+width);
   await page.getByLabel('Содержание',{exact:true}).fill('Возврат тестового оборудования в течение семи дней. ' + width);
   await page.getByRole('button',{name:'Добавить текст',exact:true}).click();
   const remove=page.getByRole('button',{name:'Удалить Rules '+width+'.txt',exact:true});
   await remove.waitFor(); await page.reload(); await remove.waitFor();
   await shot(page,'knowledge-added',width);
   await page.getByRole('button',{name:'Изменить текст Rules '+width+'.txt',exact:true}).click();
   await page.getByLabel('Текст документа',{exact:true}).fill('Обновлённые правила возврата: четырнадцать дней. '+width);
   await page.getByRole('button',{name:'Сохранить текст',exact:true}).click();
   await page.getByText('Текст сохранён. Готовность обновления для ответов показана в списке документов.',{exact:true}).waitFor();
   await page.reload();
   await page.getByRole('button',{name:'Изменить текст Rules '+width+'.txt',exact:true}).click();
   assert.equal(await page.getByLabel('Текст документа',{exact:true}).inputValue(),'Обновлённые правила возврата: четырнадцать дней. '+width);
   await shot(page,'knowledge-editor-readback',width);
   const edit=page.getByRole('button',{name:'Изменить текст Rules '+width+'.txt',exact:true});
   const documentId=await page.evaluate(async width=>{const response=await fetch('/api/knowledge-base/1');const data=await response.json();return data.files.find(file=>file.originalName==='Rules '+width+'.txt').id;},width);
   const competing=await page.evaluate(async id=>{
    const root='/api/businesses/1/knowledge/documents/'+id+'/chunks';const current=await (await fetch(root)).json();
    return (await fetch(root+'/'+current.chunks[0].id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'Concurrent saved version',section:null,expectedHash:current.hash})})).status;
   },documentId); assert.equal(competing,200);
   await page.getByLabel('Текст документа',{exact:true}).fill('Мой вариант после конфликта');
   await page.getByRole('button',{name:'Сохранить текст',exact:true}).click();
   await page.getByRole('alert').filter({hasText:'Документ уже изменил другой сотрудник'}).waitFor();
   assert.equal(await page.getByLabel('Текст документа',{exact:true}).inputValue(),'Мой вариант после конфликта'); assert.equal(await page.getByRole('button',{name:'Сохранить текст',exact:true}).isDisabled(),true);
   await shot(page,'knowledge-conflict',width);
   await page.getByRole('button',{name:'Закрыть редактор',exact:true}).click();
   await shot(page,'knowledge-edited',width);
   await remove.click(); await page.getByText('Документ удалён.',{exact:true}).waitFor();
   await page.reload(); assert.equal(await remove.count(),0);
   await shot(page,'knowledge-deleted',width);
  });
  await action('UI-CHANNEL-VOICE-READBACK', 'owner', width, page, async () => {
   await page.goto(ready.origin+'/channels?channel=telephony');
   const panel=page.getByRole('region',{name:'Голос вашего ассистента',exact:true}); await panel.waitFor();
   await page.getByLabel('Режим голоса',{exact:true}).selectOption('yandex_realtime');
   const voices=page.getByLabel('Голос',{exact:true});
   const awaitVoicePlaceholder=await voices.inputValue();
   const options=await voices.locator('option').evaluateAll(items=>items.map(item=>item.value).filter(Boolean));
   assert.ok(options.length>1); const chosen=options.find(value=>value!==awaitVoicePlaceholder); await voices.selectOption(chosen);
   await page.getByRole('button',{name:'Сохранить голос',exact:true}).click();
   await page.getByText(/Голос сохранён/).waitFor(); await page.reload();
   assert.equal(await voices.inputValue(),chosen); await shot(page,'channel-voice-saved',width);
  });
  await action('UI-CAMPAIGN-COMMANDS', 'owner', width, page, async () => {
   await page.goto(ready.origin+'/outbound'); await page.getByRole('button',{name:'Новая кампания',exact:true}).click(); await page.getByRole('button',{name:'Таблица CSV',exact:true}).click();
   await page.getByLabel('Или вставьте CSV').fill('phone;name\n79990000002;Controlled fixture'); await page.getByRole('button',{name:'Проверить контакты',exact:true}).click();
   await page.getByText(/Готово к добавлению: 1/).waitFor(); await page.getByLabel('Название кампании').fill('Commands '+width); await page.getByRole('button',{name:'Сохранить черновик',exact:true}).click();
   const card=page.locator('article').filter({hasText:'Commands '+width}); await card.getByRole('button',{name:'Запустить звонки',exact:true}).click();
   if(width===widths[0]) await card.getByRole('button',{name:'Уточнить состояние',exact:true}).click();
   await card.getByRole('button',{name:'Пауза',exact:true}).click(); await card.getByRole('button',{name:'Возобновить звонки',exact:true}).waitFor();
   await page.reload(); await card.getByRole('button',{name:'Возобновить звонки',exact:true}).click(); await card.getByRole('button',{name:'Пауза',exact:true}).waitFor();
   await card.getByRole('button',{name:'Остановить кампанию',exact:true}).click(); await page.reload(); await card.getByText('Остановлена',{exact:true}).waitFor();
   assert.ok((await rpc('snapshot')).campaigns.some(c=>c.status==='stopped')); await shot(page,'campaign-stopped',width);
  });
  await action('UI-OFFLINE-RECOVERY', 'owner', width, page, async () => {
   await page.goto(ready.origin+'/team'); await page.getByLabel('Рабочая почта').fill('preserved@example.test');
   await ctx.setOffline(true); await page.getByRole('button',{name:'Обновить команду',exact:true}).click();
   await page.getByRole('alert').filter({hasText:'Не удалось обновить команду'}).waitFor();
   assert.equal(await page.getByLabel('Рабочая почта').inputValue(),'preserved@example.test');
   await ctx.setOffline(false); await page.getByRole('button',{name:'Повторить',exact:true}).click();
   await page.getByLabel('Найти сотрудника',{exact:true}).waitFor();
   await shot(page,'offline-recovered',width);
  });
  await action('UI-CLIENT-ASSIGNMENT', 'owner', width, page, async () => {
   await page.goto(ready.origin+'/sales?view=team');
   const row=page.getByRole('region',{name:'Клиенты',exact:true}).locator('li').filter({hasText:'Тестовый покупатель'});
   await row.getByLabel('Ответственный',{exact:true}).selectOption('lead');
   await row.getByRole('button',{name:'Назначить',exact:true}).click();
   await page.getByText('Ответственный клиента сохранён.',{exact:true}).waitFor(); await page.reload();
   assert.equal(await row.getByLabel('Ответственный',{exact:true}).inputValue(),'lead');
   await row.getByLabel('Ответственный',{exact:true}).selectOption('manager'); await row.getByRole('button',{name:'Назначить',exact:true}).click();
   await page.getByText('Ответственный клиента сохранён.',{exact:true}).waitFor(); await shot(page,'client-assigned',width);
  });
  await action('UI-TASK-PAGINATION', 'owner', width, page, async () => {
   await page.goto(ready.origin+'/sales?view=team');
   if(width===widths[0]) {
    const statuses=await page.evaluate(async chatId=>{
     const result=[];for(let i=0;i<31;i++) result.push((await fetch('/api/businesses/1/sales-workspace/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chatId,summary:'Pagination fixture '+i,priority:'normal',assigneeUserId:'manager',dueAt:null})})).status);return result;
    },ready.chatId); assert.ok(statuses.every(status=>status===200||status===201)); await page.reload();
   }
   const nav=page.getByRole('navigation',{name:'Страницы задач и клиентов',exact:true}); await nav.getByRole('button',{name:'Далее',exact:true}).press('Enter');
   await page.waitForURL(/page=2/); await page.reload(); assert.equal(new URL(page.url()).searchParams.get('page'),'2');
   await nav.getByRole('button',{name:'Назад',exact:true}).click(); await page.waitForURL(url=>!url.searchParams.has('page')); await shot(page,'pagination',width);
  });
  await action('UI-QUICKJUMP-KEYBOARD', 'owner', width, page, async () => {
   await page.goto(ready.origin+'/'); await page.getByRole('heading',{name:'Главная',exact:true}).waitFor();
   await page.keyboard.press('Meta+k'); const search=page.getByRole('dialog'); await search.waitFor();
   await search.getByRole('textbox').fill('Тестовый');
   await search.getByRole('button').filter({hasText:'Тестовый покупатель'}).first().waitFor();
   await page.keyboard.press('Escape'); assert.equal(await search.count(),0);
   await shot(page,'quickjump-closed',width);
  });
  await action('UI-SESSION-REMOVED', 'owner', width, page, async () => {
   await page.goto(ready.origin+'/team'); await page.getByRole('button',{name:'Обновить команду',exact:true}).waitFor();
   await ctx.clearCookies(); await page.getByRole('button',{name:'Обновить команду',exact:true}).click();
   await page.getByRole('heading',{name:'С возвращением',exact:true}).waitFor();
   const status=await page.evaluate(async()=> (await fetch('/api/businesses/1/team')).status); assert.equal(status,401);
   assert.equal(await page.getByLabel('Рабочая почта',{exact:true}).count(),0); await shot(page,'session-removed',width);
  });
  await action('UI-CATALOG-IMPORT-ROLLBACK', 'owner', width, page, async () => {
   await ctx.addCookies([{name:'crm_session',value:ready.sessions.owner,url:ready.origin,httpOnly:true,sameSite:'Lax'}]);
   await page.goto(ready.origin+'/autopilot?tab=catalog'); await page.getByRole('button',{name:'Загрузить таблицу',exact:true}).click();
   await page.getByLabel('Таблица товаров').setInputFiles({name:'catalog.csv',mimeType:'text/csv',buffer:Buffer.from('Название,Цена,Артикул\nCatalog test '+width+',120.50,UI-ROLL-'+width)});
   await page.getByRole('button',{name:'Открыть предпросмотр',exact:true}).click();
   await page.getByLabel('Название *',{exact:true}).selectOption('0'); await page.getByLabel('Цена *',{exact:true}).selectOption('1'); await page.getByLabel('Артикул',{exact:true}).selectOption('2');
   await page.getByLabel(/Опубликовать товары/).check(); await page.getByRole('button',{name:'Проверить строки',exact:true}).click(); await page.getByRole('button',{name:'Импортировать и опубликовать',exact:true}).click();
   await page.getByRole('heading',{name:'Импорт завершён',exact:true}).waitFor(); await page.reload();
   assert.ok((await rpc('snapshot')).catalog.some(item=>item.name==='Catalog test '+width && item.amountMinor===12050));
   await page.getByRole('button',{name:'Обновить результат',exact:true}).click(); await page.getByRole('button',{name:'Отменить импорт',exact:true}).click();
   await page.getByText('Изменения импорта отменены. История предложений сохранена.',{exact:true}).waitFor();
   assert.equal((await rpc('snapshot')).catalog.some(item=>item.name==='Catalog test '+width),false); await shot(page,'catalog-rollback',width);
  });
  await ctx.close();
  for (const role of ['lead','manager','observer']) {
   const scoped=await context(role,width), q=scoped.page;
   await action('UI-ROLE-TASK-SHIFT-'+role.toUpperCase(),role,width,q,async()=>{
    await q.goto(ready.origin+'/sales');
    await q.getByRole('heading',{name:'Задачи',exact:true}).first().waitFor();
    assert.equal(await q.getByRole('button',{name:'Новая задача',exact:true}).count(),role==='observer'?0:1);
    if(role==='observer') {
     const status=await q.evaluate(async()=> (await fetch('/api/businesses/1/sales-workspace/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({summary:'forbidden'})})).status); assert.equal(status,403);
    }
    await q.goto(ready.origin+'/team'); await q.getByRole('heading',{name:'Смены и нагрузка',exact:true}).waitFor();
    if(role!=='observer') await q.getByRole('button',{name:'Моя смена',exact:true}).waitFor();
    assert.equal(await q.getByRole('button',{name:'Моя смена',exact:true}).count(),role==='observer'?0:1);
    if(role==='manager') {
     await q.getByRole('button',{name:'Моя смена',exact:true}).click();
     await q.getByLabel('Смена · Менеджер',{exact:true}).selectOption('available');
     await q.getByRole('button',{name:'Сохранить смену',exact:true}).click();
     await q.getByText('Смена для Менеджер сохранена.',{exact:true}).waitFor(); await q.reload();
     await q.getByRole('button',{name:'Моя смена',exact:true}).click(); assert.equal(await q.getByLabel('Смена · Менеджер',{exact:true}).inputValue(),'available');
    }
    await shot(q,'role-actions-'+role,width);
    await q.goto(ready.origin+'/knowledge-base'); if(role==='observer') await q.getByRole('heading',{name:'Раздел недоступен',exact:true}).waitFor(); else await q.getByRole('heading',{name:'База знаний',exact:true}).first().waitFor();
    assert.equal(await q.getByRole('button',{name:'Добавить текст',exact:true}).count(),0);
    const denyKnowledge=await q.evaluate(async()=> (await fetch('/api/businesses/1/knowledge/documents/999/chunks/999',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'forbidden'})})).status); assert.equal(denyKnowledge,403);

   }); await scoped.ctx.close();
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
