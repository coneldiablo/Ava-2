// Built React -> actual Express -> actual SQLite/auth/roles. No API fulfills.
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output = new URL('../docs/customer-completion-20261018/ui/automation-runtime/', import.meta.url);
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
  for(const [type,label] of [['silence','Клиент молчит'],['keyword','Ключевое слово'],['status_change','Смена статуса'],['new_lead','Новый лид'],['time_based','По расписанию'],['sentiment','Плохое настроение']]) {
   await action('AUTO-TRIGGER-'+type.toUpperCase(),'owner',width,page,async()=>{
    const name='UI '+type+' '+width;await page.goto(ready.origin+'/triggers');await page.getByRole('button',{name:'Новый триггер',exact:true}).click();const wizard=page.getByRole('dialog');
    await wizard.getByRole('button',{name:new RegExp('^'+label)}).click();await wizard.getByRole('button',{name:'Далее →',exact:true}).click();
    if(type==='keyword'){await wizard.getByPlaceholder('Введите слово и нажмите Enter или +').fill('цена');await wizard.getByPlaceholder('Введите слово и нажмите Enter или +').press('Enter');}
    if(type==='silence') await wizard.getByRole('slider').press('Home');
    if(type==='sentiment') await wizard.getByRole('slider').press('End');
    if(type==='status_change')await wizard.getByRole('button',{name:'Квалификация',exact:true}).click();
    if(type==='time_based'){await wizard.getByRole('slider').press('Home');for(const day of ['Будни','Выходные','Каждый день'])await wizard.getByRole('button',{name:day,exact:true}).click();}
    await wizard.getByRole('button',{name:'Далее →',exact:true}).click();await wizard.getByRole('button',{name:/^Уведомить менеджера/}).click();await wizard.getByRole('button',{name:'Далее →',exact:true}).click();
    await wizard.getByLabel('Название триггера (необязательно)',{exact:true}).fill(name);const cooldown=wizard.getByLabel('Не чаще чем раз в...',{exact:true});for(const value of ['0','5','15','30','60','180','360','720','1440','10080'])await cooldown.selectOption(value);
    await wizard.getByLabel('Максимум срабатываний на клиента',{exact:true}).selectOption('3');await wizard.getByRole('button',{name:'Создать триггер',exact:true}).click();await page.getByRole('button',{name:'Редактировать триггер '+name,exact:true}).waitFor();
    await page.reload();const stored=await page.evaluate(async name=>(await (await fetch('/api/triggers/1')).json()).triggers.find(item=>item.name===name),name);assert.equal(stored.triggerType,type);assert.equal(stored.actionType,'notify_manager');assert.equal(stored.cooldownMinutes,10080);assert.equal(stored.maxExecutions,3);
    await page.getByRole('button',{name:'Редактировать триггер '+name,exact:true}).click();await page.getByRole('button',{name:'Закрыть мастер триггера',exact:true}).click();
    const disable=page.getByRole('button',{name:'Выключить триггер '+name,exact:true}),enable=page.getByRole('button',{name:'Включить триггер '+name,exact:true});if(await disable.count()) {await disable.click();await enable.waitFor();} else {await enable.click();await disable.waitFor();}
    await page.getByRole('button',{name:'Удалить триггер '+name,exact:true}).click();await page.reload();assert.equal(await page.getByRole('button',{name:'Редактировать триггер '+name,exact:true}).count(),0);await shot(page,'trigger-'+type+'-removed',width);
   });
  }
  for(const [type,label] of [['send_message','Отправить сообщение'],['change_status','Сменить статус'],['start_sequence','Запустить цепочку'],['send_offer','Сгенерировать КП']]) {
   await action('AUTO-ACTION-'+type.toUpperCase(),'owner',width,page,async()=>{
    const name='Action '+type+' '+width;await page.goto(ready.origin+'/triggers');
    if(type==='start_sequence')await page.evaluate(async()=>{const r=await fetch('/api/sequences/1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Controlled target sequence',description:'Local fixture'})});if(!r.ok)throw new Error('sequence precondition');});
    if(type==='start_sequence')await page.reload();
    await page.getByRole('button',{name:'Новый триггер',exact:true}).click();const wizard=page.getByRole('dialog');await wizard.getByRole('button',{name:/^Новый лид/}).click();await wizard.getByRole('button',{name:'Далее →',exact:true}).click();await wizard.getByRole('button',{name:'Далее →',exact:true}).click();await wizard.getByRole('button',{name:new RegExp('^'+label)}).click();
    if(type==='send_message')await wizard.getByPlaceholder('Здравствуйте! Остались ли у вас вопросы? Буду рад помочь 😊').fill('Контрольное сообщение {clientName}.');
    if(type==='change_status')await wizard.getByRole('button',{name:'Квалификация',exact:true}).click();
    if(type==='start_sequence')await wizard.getByRole('button',{name:/Controlled target sequence/}).first().click();
    await wizard.getByRole('button',{name:'Далее →',exact:true}).click();await wizard.getByLabel('Название триггера (необязательно)',{exact:true}).fill(name);await wizard.getByRole('button',{name:'Создать триггер',exact:true}).click();await page.getByRole('button',{name:'Редактировать триггер '+name,exact:true}).waitFor();await page.reload();
    const stored=await page.evaluate(async name=>(await (await fetch('/api/triggers/1')).json()).triggers.find(item=>item.name===name),name);assert.equal(stored.actionType,type);await page.getByRole('button',{name:'Удалить триггер '+name,exact:true}).click();
   });
  }
  await action('AUTO-CATALOG-EDIT-CURRENCIES','owner',width,page,async()=>{
   const name='Manual UI '+width;await page.goto(ready.origin+'/autopilot?tab=catalog');const panel=page.locator('section.aw-settings').filter({has:page.getByRole('heading',{name:'Каталог предложений',exact:true})});
   await panel.getByRole('button',{name:'Добавить',exact:true}).click();const form=page.locator('form.aw-catalog-form');await form.getByLabel('Название',{exact:true}).fill(name);await form.getByLabel('Цена',{exact:true}).fill('17.55');await form.getByLabel('Описание',{exact:true}).fill('Тестовое описание');await form.getByLabel('Условия предложения',{exact:true}).fill('Условия проверяет менеджер.');await form.getByRole('button',{name:'Сохранить черновик',exact:true}).click();await page.getByText('Предложение сохранено в черновик. Опубликуйте его для отправки клиентам.',{exact:true}).waitFor();
   const card=page.locator('article.aw-offer').filter({hasText:name});
   for(const currency of ['USD','EUR','KZT','BYN','RUB']) {await card.getByRole('button',{name:'Изменить',exact:true}).click();await form.getByRole('combobox').selectOption(currency);const changed=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().includes('/catalog/'));await form.getByRole('button',{name:'Сохранить черновик',exact:true}).click();assert.equal((await changed).status(),200);await page.reload();const stored=await page.evaluate(async name=>(await (await fetch('/api/businesses/1/catalog')).json()).offers.find(item=>item.name===name),name);assert.equal(stored.currency,currency);}
   await card.getByRole('button',{name:'Опубликовать',exact:true}).click();await page.reload();assert.ok((await rpc('snapshot')).catalog.some(item=>item.name===name && item.amountMinor===1755));await shot(page,'manual-catalog-published',width);
  });
  await action('AUTO-WHATSAPP-TYPING-READBACK','owner',width,page,async()=>{
   await page.goto(ready.origin+'/channels?channel=whatsapp');const checkbox=page.getByRole('checkbox',{name:'Показывать «печатает», пока помощник готовит ответ',exact:true});await checkbox.waitFor();await checkbox.check();await page.getByRole('button',{name:'Сохранить время ответа',exact:true}).click();await page.getByText('Сохранено. AVA отвечает без дополнительной задержки.',{exact:true}).waitFor();await page.reload();assert.equal(await checkbox.isChecked(),true);assert.equal((await rpc('snapshot')).settings.typingEnabled,true);
   await checkbox.uncheck();await page.getByRole('button',{name:'Сохранить время ответа',exact:true}).click();await page.getByText('Сохранено. AVA отвечает без дополнительной задержки.',{exact:true}).waitFor();await page.reload();assert.equal(await checkbox.isChecked(),false);await shot(page,'typing-disabled-readback',width);
  });
  await action('AUTO-POLICY-SAVE-SIMULATE-PUBLISH-PAUSE','owner',width,page,async()=>{
   await page.goto(ready.origin+'/autopilot');await page.getByRole('checkbox',{name:/Разрешить самостоятельную работу/}).check();
   for(const [label,value]of [['Сообщения','50'],['Токены','50000'],['Голос, секунд','600'],['Ответить клиенту в течение, минут','12']])await page.getByLabel(label,{exact:true}).fill(value);
   await page.getByLabel('Часовой пояс',{exact:true}).fill('Europe/Moscow');await page.getByLabel('Начало',{exact:true}).fill('09:00');await page.getByLabel('Конец',{exact:true}).fill('18:00');
   const routing=page.getByRole('checkbox',{name:'Назначать доступному сотруднику с минимальной нагрузкой',exact:true});await routing.check();await page.getByRole('checkbox',{name:'Менеджер',exact:true}).check();
   const saved=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/autopilot/policy'));await page.getByRole('button',{name:'Сохранить правила',exact:true}).click();assert.equal((await saved).status(),200);await page.reload();assert.equal(await page.getByLabel('Сообщения',{exact:true}).inputValue(),'50');
   await page.getByRole('button',{name:'Проверить текущую версию',exact:true}).click();await page.getByText('Проверка пройдена',{exact:true}).waitFor();await page.getByRole('button',{name:'Опубликовать и включить',exact:true}).click();await page.getByRole('button',{name:'Пауза',exact:true}).waitFor();await page.reload();await page.getByRole('button',{name:'Пауза',exact:true}).click();await page.reload();await page.getByText(/Автопилот приостановлен/).first().waitFor();
   const versions=page.getByLabel('Версия правил',{exact:true});const values=await versions.locator('option').evaluateAll(items=>items.map(item=>item.value).filter(Boolean));assert.ok(values.length);await versions.selectOption(values[0]);await page.getByRole('button',{name:'Восстановить черновик',exact:true}).click();await page.reload();assert.equal(await page.getByRole('checkbox',{name:/Разрешить самостоятельную работу/}).isChecked(),false);await shot(page,'policy-restored-disabled',width);
  });
  await action('AUTO-SEQUENCE-STEP-CRUD','owner',width,page,async()=>{
   const name='UI sequence '+width;await page.goto(ready.origin+'/triggers');await page.getByRole('navigation',{name:'Разделы автоматизации',exact:true}).getByRole('button',{name:/^Цепочки/}).click();await page.getByRole('button',{name:'Новая цепочка',exact:true}).click();await page.getByLabel('Название',{exact:true}).fill(name);await page.getByLabel('Описание',{exact:true}).fill('Контрольная линейная цепочка');await page.getByRole('button',{name:'Создать',exact:true}).click();
   await page.getByRole('button',{name:new RegExp(name)}).first().click();await page.getByPlaceholder('Привет, {clientName}! Как дела? Остались вопросы?').fill('Контрольное сообщение {clientName}.');const delay=page.locator('select').last();for(const minutes of ['5','15','30','60','180','360','720','1440','2880'])await delay.selectOption(minutes);await page.getByRole('checkbox',{name:'AI-персонализация',exact:true}).check();await page.getByRole('button',{name:'Добавить шаг в цепочку '+name,exact:true}).click();
   await page.getByRole('button',{name:'Удалить шаг 1 цепочки '+name,exact:true}).waitFor();await page.reload();await page.getByRole('navigation',{name:'Разделы автоматизации',exact:true}).getByRole('button',{name:/^Цепочки/}).click();await page.getByRole('button',{name:new RegExp(name)}).first().click();await page.getByRole('button',{name:'Удалить шаг 1 цепочки '+name,exact:true}).click();await page.getByRole('button',{name:'Выключить цепочку '+name,exact:true}).click();await page.getByRole('button',{name:'Включить цепочку '+name,exact:true}).click();await page.getByRole('button',{name:'Удалить цепочку '+name,exact:true}).click();await page.reload();await page.getByRole('navigation',{name:'Разделы автоматизации',exact:true}).getByRole('button',{name:/^Цепочки/}).click();assert.equal(await page.getByRole('button',{name:'Удалить цепочку '+name,exact:true}).count(),0);await shot(page,'sequence-removed',width);
  });
  await action('AUTO-MASTER-TOGGLE','owner',width,page,async()=>{
   await page.goto(ready.origin+'/triggers');await page.getByRole('button',{name:'Новый триггер',exact:true}).waitFor();const section=page.getByRole('region',{name:'Состояние автоматизации',exact:true});const toggle=section.getByRole('button');const before=await toggle.getAttribute('aria-pressed');await toggle.click();await page.waitForFunction(before=>document.querySelector('[aria-label="Состояние автоматизации"] button')?.getAttribute('aria-pressed')!==before,before);await page.reload();assert.notEqual(await toggle.getAttribute('aria-pressed'),before);await toggle.click();await page.waitForFunction(before=>document.querySelector('[aria-label="Состояние автоматизации"] button')?.getAttribute('aria-pressed')===before,before);await page.reload();assert.equal(await toggle.getAttribute('aria-pressed'),before);await shot(page,'automation-master-restored',width);
  });
  await ctx.close();
 }

} finally {
    const snapshot = await rpc('snapshot').catch(error => ({ error: error.message }));
    await writeFile(new URL('results.json', output), JSON.stringify({ generatedAt: new Date().toISOString(), level: 'integrated_local_external_boundary_fixtures', apiIntercepts: false, builtIndexSha256: ready.builtIndexSha256, sourceHead: ready.sourceHead, sourceDigests: ready.sourceDigests, results, pageErrors, apiResponses, screenshots, snapshot }, null, 2));
    await writeFile(new URL('harness.log', output), (stdout + '\n' + stderr).replace(/VAPID_(?:PRIVATE|PUBLIC)_KEY=[^\n]*/g, 'VAPID_KEY=[REDACTED]'));
    await browser.close(); child.send({ op: 'close' }); setTimeout(() => child.kill(), 2000).unref();
}
console.log(JSON.stringify({ passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status === 'FAIL').length, results: results.map(({ id, role,width,status,error }) => ({ id,role,width,status,error })) }, null, 2));
if (results.some(r => r.status === 'FAIL')) process.exitCode = 1;
