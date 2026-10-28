// Built React -> actual Express -> actual SQLite/auth/roles. No API fulfills.
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output = new URL('../docs/customer-path-20261017/acceptance-integrated/', import.meta.url);
await mkdir(output, { recursive: true });
const child = fork(new URL('./customer-path-20261017-integrated-browser.server.cjs', import.meta.url), [], {
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
    for (const width of widths) {
        const anon = await context(null, width), p = anon.page;
        await action('INT-REG-SAFE-STATUS', 'anonymous', width, p, async () => {
            await p.goto(ready.origin + '/'); await p.getByRole('link', { name: 'Создать бизнес' }).click();
            await p.getByLabel('Как вас зовут').fill('Тестовый пользователь'); await p.getByLabel('Название бизнеса').fill('Новый тестовый бизнес');
            const email = width === widths[0] ? 'owner@example.test' : 'lead@example.test';
            await p.getByRole('button', { name: 'Продолжить', exact: true }).click(); await p.getByLabel('Электронная почта').fill(email);
            await p.reload(); assert.equal(await p.getByLabel('Электронная почта').inputValue(), email);
            await p.getByLabel('Пароль', { exact: true }).fill('fixture-private-password-123'); await p.getByLabel('Повторите пароль').fill('fixture-private-password-123');
            await p.getByRole('button', { name: 'Получить код' }).click(); await p.getByLabel('Код из письма').waitFor();
            await p.reload(); await p.getByLabel('Код из письма').fill('000000'); await p.getByRole('button', { name: 'Подтвердить почту' }).click();
            await p.getByText('Код не подошёл. Проверьте письмо и попробуйте ещё раз.', { exact: true }).waitFor();
            await p.getByLabel('Код из письма').fill(await rpc('code')); await p.getByRole('button', { name: 'Подтвердить почту' }).click();
            await p.getByRole('heading', { name: 'У вас уже есть аккаунт' }).waitFor(); await shot(p, 'registration-existing', width);
            assert.equal(await p.evaluate(() => Object.values(sessionStorage).some(value => value.includes('fixture-private-password-123'))), false);
        }); await anon.ctx.close();

        const owner = await context('owner', width), page = owner.page;
        await action('INT-ROOT-TODAY', 'owner', width, page, async () => {
            await page.goto(ready.origin + '/'); await page.getByRole('heading', { name: 'Главная', exact: true }).waitFor();
            assert.equal(await page.getByRole('navigation', { name: 'Первичная настройка бизнеса' }).count(), 0);
            await page.goto(ready.origin + '/today'); await page.getByRole('heading', { name: 'Сегодня', exact: true }).waitFor();
            await page.getByRole('button', { name: /Тестовый покупатель/ }).first().waitFor(); await shot(page, 'owner-today', width);
        });
        await action('INT-HOME-ASK-CACHED-OVERVIEWS', 'owner', width, page, async () => {
            await page.goto(ready.origin + '/');
            const waitOverviews = async () => {
                for (const title of ['Что произошло за ночь', 'Итоги вчерашнего дня']) {
                    const card = page.getByRole('region', { name: title, exact: true });
                    await card.waitFor(); await page.waitForFunction(title => document.querySelector(`[aria-label="${title}"]`)?.getAttribute('aria-busy') === 'false', title);
                    assert.equal(await card.getByRole('button', { name: 'Повторить обзор' }).count(), 0);
                }
            };
            await waitOverviews();
            await page.getByLabel('Вопрос для AVA', { exact: true }).fill('Как идёт мой бизнес?');
            const response = page.waitForResponse(r => r.url().includes('/dashboard/1/ai/ask') && r.request().method() === 'POST');
            await page.getByRole('button', { name: 'Отправить вопрос', exact: true }).click();
            const answer = await response; assert.equal(answer.status(), 200); const body = await answer.json();
            assert.equal(body.grounded, true); assert.equal(body.answerStatus, 'answered'); assert.ok(body.answer.trim()); assert.ok(body.sources.length);
            await page.getByText('Ответ AVA', { exact: true }).waitFor(); await shot(page, 'home-grounded-answer', width);
            const calls = (await rpc('snapshot')).external.modelCalls;
            await page.reload(); await waitOverviews(); assert.equal((await rpc('snapshot')).external.modelCalls, calls, 'Reload regenerated an already persisted daily overview');
            await shot(page, 'home-cached-overviews', width);
        });
        await action('INT-SETUP-MANUAL', 'owner', width, page, async () => {
            await page.goto(ready.origin + '/assistant-builder');
            const sourceStep = page.getByRole('button', { name: /Добавьте ссылки/ }); await sourceStep.waitFor(); await sourceStep.click();
            await page.getByLabel('Ссылки на страницы бизнеса').fill('https://example.test/business');
            if (!await page.getByLabel('Описание бизнеса (необязательно)').isVisible()) await page.getByText('Добавить описание бизнеса', { exact: true }).click(); await page.getByLabel('Описание бизнеса (необязательно)').fill('Продаём оборудование для хозяйства.');
            await page.getByRole('button', { name: 'Сохранить ссылки и описание' }).click(); await page.getByText(/Ссылки и описание сохранены/).waitFor();
            await page.reload(); assert.equal(await page.getByLabel('Ссылки на страницы бизнеса').inputValue(), 'https://example.test/business');
            await page.getByText('Написать инструкции самостоятельно', { exact: true }).click(); await page.getByLabel('Ваши инструкции ассистенту').fill('Помогай подобрать оборудование. Не обещай доставку без проверки менеджера.');
            await page.getByRole('button', { name: 'Проверить ручные инструкции' }).click(); await page.getByLabel('Инструкции ассистента', { exact: true }).waitFor();
            await page.getByRole('button', { name: 'Подтвердить и сохранить' }).click(); await page.getByRole('button', { name: 'Сохранено', exact: true }).waitFor();
            assert.match((await rpc('snapshot')).businesses.find(b => b.id === 1).systemPrompt, /Не обещай доставку/); await shot(page, 'manual-approved', width);
        });
        await action('INT-CATALOG-IMPORT', 'owner', width, page, async () => {
            await page.goto(ready.origin + '/autopilot?tab=catalog'); await page.getByRole('button', { name: 'Загрузить таблицу' }).click();
            await page.getByLabel('Таблица товаров').setInputFiles({ name: `products-${width}.csv`, mimeType: 'text/csv', buffer: Buffer.from(`Название,Цена,Артикул\nКомплект для браузера ${width},2500.50,UI-${width}`) });
            await page.getByRole('button', { name: 'Открыть предпросмотр' }).click(); await page.getByLabel('Название *', { exact: true }).selectOption('0'); await page.getByLabel('Цена *', { exact: true }).selectOption('1'); await page.getByLabel('Артикул', { exact: true }).selectOption('2');
            await page.getByLabel(/Опубликовать товары/).check(); await page.getByRole('button', { name: 'Проверить строки' }).click(); await page.getByRole('button', { name: 'Импортировать и опубликовать' }).click();
            await page.getByRole('heading', { name: 'Импорт завершён' }).waitFor(); await page.reload(); await page.getByRole('heading', { name: 'Импорт завершён' }).waitFor();
            assert.ok((await rpc('snapshot')).catalog.some(offer => offer.name === `Комплект для браузера ${width}` && offer.amountMinor === 250050)); await shot(page, 'catalog-persisted', width);
        });
        await action('INT-WA-DELAY', 'owner', width, page, async () => {
            await page.goto(ready.origin + '/channels?channel=whatsapp'); await page.getByLabel('Пауза перед ответом WhatsApp').selectOption('delay'); await page.getByLabel('Секунд ожидания').fill('17');
            await page.getByRole('button', { name: 'Сохранить время ответа' }).click(); await page.getByText(/Время ожидания сохранено/).waitFor(); await page.reload();
            assert.equal(await page.getByLabel('Секунд ожидания').inputValue(), '17'); assert.equal((await rpc('snapshot')).settings.delaySeconds, 17); await shot(page, 'whatsapp-delay-persisted', width);
        });
        await action('INT-CALL-CONTEXT', 'owner', width, page, async () => {
            await page.goto(ready.origin + '/calls'); await page.getByRole('button', { name: 'Итог и расшифровка' }).click(); await page.getByText('Пришлите подборку в WhatsApp.', { exact: true }).waitFor();
            await page.getByRole('link', { name: 'Проверить сообщение', exact: true }).waitFor(); const client = page.getByRole('link', { name: 'Тестовый покупатель', exact: true }); assert.ok((await client.getAttribute('href')).includes(encodeURIComponent(ready.chatId))); await shot(page, 'call-summary-transcript', width);
        });
        await action('INT-CAMPAIGN-DRAFT-UNKNOWN', 'owner', width, page, async () => {
            await page.goto(ready.origin + '/outbound'); await page.getByRole('button', { name: 'Новая кампания' }).click(); await page.getByRole('button', { name: 'Таблица CSV', exact: true }).click();
            await page.getByLabel('Или вставьте CSV').fill('phone;name\n79990000002;Тестовый клиент\ninvalid;Ошибка'); await page.getByRole('button', { name: 'Проверить контакты' }).click();
            await page.getByText(/Готово к добавлению: 1/).waitFor(); await page.getByLabel('Название кампании').fill('Проверочная кампания ' + width); await page.getByLabel(/Добавить только подходящие/).check();
            await page.getByRole('button', { name: 'Сохранить черновик' }).click(); const card = page.locator('article').filter({ hasText: 'Проверочная кампания ' + width });
            await card.getByRole('button', { name: 'Запустить звонки' }).click();
            if (width === widths[0]) { await card.getByRole('button', { name: 'Уточнить состояние' }).waitFor(); await page.reload(); const next = page.locator('article').filter({ hasText: 'Проверочная кампания ' + width }); await next.getByRole('button', { name: 'Уточнить состояние' }).click(); }
            await page.locator('article').filter({ hasText: 'Проверочная кампания ' + width }).getByRole('button', { name: 'Пауза', exact: true }).waitFor(); await shot(page, 'campaign-runtime-readback', width);
            assert.ok((await rpc('snapshot')).campaigns.some(c => c.status === 'running'));
        });
        await action('INT-STUDIO-INVOICE-PDF', 'owner', width, page, async () => {
            await page.goto(ready.origin + '/studio?dealId=' + ready.dealId); await page.getByLabel('Сделка', { exact: true }).selectOption(ready.dealId); await page.getByRole('button', { name: 'Подготовить черновик' }).click();
            await page.getByRole('button', { name: /Выставить счёт|Подготовить новую версию счёта/ }).click(); await page.getByLabel('Номер счёта', { exact: true }).fill('TEST-' + width);
            for (const [label, value] of Object.entries({ 'Юридическое имя': 'ООО Тест', 'ИНН': '7701234567', 'Адрес': 'Москва', 'Название банка': 'Тестовый банк', 'БИК': '044525225', 'Расчётный счёт': '40702810900000000001' })) await page.getByLabel(`Поставщик: ${label}`, { exact: true }).fill(value);
            await page.getByLabel('Плательщик: Имя или название плательщика', { exact: true }).fill('Тестовый покупатель'); await page.getByLabel('Реквизиты, позиции и сумма проверены').check(); await page.getByRole('button', { name: 'Выпустить счёт' }).click(); await page.getByText(/Счёт выпущен/).waitFor();
            const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Скачать PDF', exact: true }).last().click(); const file = await download; const target = new URL(`invoice-${width}.pdf`, output); await file.saveAs(target.pathname); assert.equal(await file.failure(), null); assert.equal((await readFile(target)).subarray(0, 5).toString(), '%PDF-');
            await page.getByRole('button', { name: 'Отправить PDF в WhatsApp' }).last().click(); await page.getByText(/Документ принят WhatsApp/).waitFor();
            const before = (await rpc('snapshot')).external.documentSends; await page.reload(); await page.getByRole('button', { name: 'Подготовить черновик' }).click(); await page.getByLabel('Версия счёта PDF', { exact: true }).waitFor(); await page.getByText('WhatsApp принял документ. Доставка пока не подтверждена.', { exact: true }).waitFor();
            assert.equal(await page.getByRole('button', { name: 'Отправить PDF в WhatsApp' }).last().isDisabled(), true); assert.equal((await rpc('snapshot')).external.documentSends, before); await shot(page, 'invoice-accepted', width);
        });
        await action('INT-BUSINESS-SWITCH', 'owner', width, page, async () => {
            await page.goto(ready.origin + '/today?client=' + encodeURIComponent(ready.chatId));
            const menu = page.getByRole('button', { name: 'Открыть меню', exact: true }); if (await menu.isVisible()) await menu.click();
            await page.getByLabel('Текущий бизнес').selectOption('2'); await page.getByRole('heading', { name: 'Сегодня', exact: true }).waitFor();
            assert.equal(new URL(page.url()).searchParams.has('client'), false); assert.equal(await page.getByRole('heading', { name: 'Тестовый покупатель', exact: true }).count(), 0);
            const result = await page.evaluate(async () => (await fetch('/api/businesses/3/workspace')).status); assert.equal(result, 403); await shot(page, 'business-switched', width);
        }); await owner.ctx.close();

        for (const role of ['lead', 'manager', 'observer']) {
            const scoped = await context(role, width), q = scoped.page;
            await action('INT-ROLE-WORKSPACE-' + role.toUpperCase(), role, width, q, async () => {
                await q.goto(ready.origin + '/today?client=' + encodeURIComponent(ready.chatId)); await q.getByRole('heading', { name: 'Тестовый покупатель', exact: true }).waitFor();
                await q.getByText('Договорились в звонке: нужен комплект для овец.', { exact: true }).waitFor();
                await q.getByText(/По расшифровке: Пришлите подборку электропастухов в WhatsApp, пожалуйста\./).first().waitFor();
                if (role === 'manager' && width === widths[0]) {
                    const contextButton = q.getByRole('button', { name: 'Открыть контекст клиента', exact: true }); if (await contextButton.isVisible()) await contextButton.click();
                    await q.getByRole('button', { name: 'Завершить задачу', exact: true }).first().click(); await q.getByText(/Задача завершена/).waitFor(); assert.equal((await rpc('snapshot')).tasks.find(t => t.taskId === ready.taskId).status, 'done');
                }
                if (role === 'observer') { assert.equal(await q.getByRole('button', { name: 'Взять разговор', exact: true }).count(), 0); assert.equal(await q.getByRole('button', { name: 'Завершить задачу', exact: true }).count(), 0); }
                const deny = await q.evaluate(async () => { const response = await fetch('/api/businesses/1/whatsapp/response-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delaySeconds: 99, revision: 0 }) }); return response.status; }); assert.equal(deny, 403); await shot(q, `role-${role}`, width);
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
