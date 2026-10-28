// Read/navigation-only route sweep through the actual app/SQLite harness.
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output = new URL('../docs/customer-path-20261017/acceptance-routing/', import.meta.url);
await mkdir(output, { recursive: true });
const previous = process.env.AVA_ROUTING_RECHECK ? JSON.parse(await readFile(new URL('results.json',output),'utf8')) : null;
const child = fork(new URL('./customer-path-20261017-integrated-browser.server.cjs', import.meta.url), [], { stdio: ['ignore','pipe','pipe','ipc'], env: { ...process.env, NODE_PATH: '/tmp/ava-product-deps-20261017/node_modules' } });
let logs = ''; child.stdout.on('data', x => { logs += x; }); child.stderr.on('data', x => { logs += x; });
const ready = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Startup timeout')),15000); child.on('message', x => { if (x.ready) {clearTimeout(timer);resolve(x);} if (x.fatal) {clearTimeout(timer);reject(new Error(x.stack || x.fatal));} }); child.once('exit',code => reject(new Error('Fixture exit '+code))); });
let rpcId = 0;
const snapshot = () => new Promise((resolve,reject) => { const id=++rpcId,t=setTimeout(()=>reject(new Error('RPC timeout')),3000); const fn=x=>{if(x.id!==id)return;child.off('message',fn);clearTimeout(t);x.error?reject(new Error(x.error)):resolve(x.result);};child.on('message',fn);child.send({id,op:'snapshot'}); });
const appSource = await readFile(new URL('../whatsapp_crm/frontend/src/App.tsx',import.meta.url),'utf8');
const routeTemplates = [...new Set([...appSource.matchAll(/<Route path="([^"/][^"]*)"/g)].map(x=>'/'+x[1]))].filter(x=>!['/today','/*'].includes(x));
const routes = routeTemplates.map(x=>x.replace(':chatId',encodeURIComponent(ready.chatId)));
const needsRecheck = previous?.results.filter(x=>x.status!=='PASS'||x.api.some(r=>r.status>=500));
const key = x => JSON.stringify([x.id,x.role,x.width]);
const results=previous?.results.filter(x=>!needsRecheck.some(t=>key(t)===key(x)))||[], pageErrors=[], responses=[], requests=[], screenshots=[];
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
function allowed(auth,path) {
    const member=auth.memberships?.find(x=>x.businessId===1),cap=x=>member?.capabilities?.includes(x);
    if(!cap('business.read'))return false;
    if(['/','/today','/integrations','/assistant-builder'].includes(path))return true;
    if(/^\/(client|customers)\//.test(path)||['/clients','/autopilot','/sales','/conversations','/leads','/deals','/opportunities','/all-leads','/calls','/activity','/outbound','/quick-replies'].includes(path))return cap('sales.read');
    if(path==='/team')return cap('team.read');
    if(['/channels','/instances','/triggers','/simulator','/getting-started'].includes(path))return cap('business.manage');
    if(['/business-gpt','/studio','/knowledge-base'].includes(path))return cap('ai.use');
    if(path==='/workspace-analytics')return cap('sales.assign');
    if(['/analytics','/reports'].includes(path))return ['hotel_owner','sales_lead'].includes(member?.role)&&cap('sales.read');
    return false;
}
async function makeContext(role,width) {
    const ctx=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
    await ctx.addCookies([{name:'crm_session',value:ready.sessions[role],url:ready.origin,httpOnly:true,sameSite:'Lax'}]);
    await ctx.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===ready.origin||['data:','blob:'].includes(url.protocol)?route.continue():route.abort();});
    const page=await ctx.newPage();page.setDefaultTimeout(5000);
    page.on('pageerror',error=>pageErrors.push({role,width,path:new URL(page.url()).pathname,error:error.message}));
    page.on('request',r=>{const url=new URL(r.url());if(url.pathname.startsWith('/api/'))requests.push({role,width,route:new URL(page.url()).pathname,path:url.pathname,method:r.method()});});
    page.on('response',async r=>{const url=new URL(r.url());if(!url.pathname.startsWith('/api/'))return;const item={role,width,route:new URL(page.url()).pathname,path:url.pathname,method:r.request().method(),status:r.status()};if(r.status()>=400){try{const b=await r.json();item.code=b.code||b.error||b.detail;}catch{}}responses.push(item);});
    const auth=await (await ctx.request.get(ready.origin+'/api/auth/me')).json();
    return {ctx,page,auth};
}
async function settle(page){await page.waitForLoadState('networkidle',{timeout:2500}).catch(()=>{});await page.locator('#main-content').waitFor();await page.waitForFunction(()=>!['Проверяем доступ к бизнесу…','Проверка доступа...'].includes(document.querySelector('#main-content')?.innerText?.trim()),null,{timeout:5000});}
async function shot(page,name){await page.screenshot({path:new URL(name+'.png',output).pathname,fullPage:true});screenshots.push(name+'.png');}
async function test(id,role,width,path,page,fn){if(needsRecheck&&!needsRecheck.some(x=>key(x)===key({id,role,width})))return;const before=responses.length,errors=pageErrors.length,start=Date.now();try{await fn();results.push({id,role,width,path,status:'PASS',durationMs:Date.now()-start,api:responses.slice(before),pageErrors:pageErrors.slice(errors)});}catch(error){await shot(page,(id+'-'+role+'-'+width+'-FAIL').replace(/[^a-zA-Z0-9_-]/g,'_')).catch(()=>{});results.push({id,role,width,path,status:'FAIL',error:error.message,body:(await page.locator('body').innerText()).slice(0,2000),api:responses.slice(before),pageErrors:pageErrors.slice(errors),durationMs:Date.now()-start});console.log(id,role,width,error.message);}}
try{
    for(const role of ['owner','lead','manager','observer']){
        const {ctx,page,auth}=await makeContext(role,1440);
        for(const path of routes){
            await test('ROUTE-'+path,role,1440,path,page,async()=>{
                await page.goto(ready.origin+path);await settle(page);
                const body=await page.locator('#main-content').innerText();const finalPath=new URL(page.url()).pathname;
                const redirectedGuide=path==='/getting-started'&&['/integrations','/today','/'].includes(finalPath);
                const expectAllowed=redirectedGuide?allowed(auth,finalPath):allowed(auth,path);
                assert.ok(finalPath===path||redirectedGuide,'Unexpected route redirect '+finalPath);
                assert.equal(body.includes('Не удалось открыть раздел'),false,'Route error boundary');
                assert.equal(body.includes('Чужой бизнес'),false,'Foreign business visible');
                assert.equal(body.includes('Раздел недоступен'),!expectAllowed,'Route capability mismatch');
                assert.ok(body.trim().length>20,'Blank main');
                assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Desktop overflow');
            });
        }
        await ctx.close();
    }
    for(const role of ['owner','lead','manager','observer']){
        const {ctx,page,auth}=await makeContext(role,390);
        await test('MOBILE-MENU',role,390,'/conversations',page,async()=>{
            await page.goto(ready.origin+'/conversations');await settle(page);
            await page.getByRole('button',{name:'Открыть меню',exact:true}).click();
            const sidebar=page.getByRole('complementary',{name:'Основная навигация'});await sidebar.waitFor();
            const more=sidebar.getByRole('button',{name:'Ещё',exact:true});if(await more.getAttribute('aria-expanded')==='false')await more.click();
            const hrefs=await sidebar.getByRole('link').evaluateAll(items=>items.map(x=>x.getAttribute('href')));
            assert.equal(hrefs.includes('/channels'),allowed(auth,'/channels'));assert.equal(hrefs.includes('/team'),allowed(auth,'/team'));
            await sidebar.getByRole('button',{name:'Выйти',exact:true}).focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Закрыть меню');
            await shot(page,'mobile-menu-'+role);
            await sidebar.getByRole('link',{name:'История звонков',exact:true}).click();await settle(page);
            assert.equal(new URL(page.url()).pathname,'/calls');await page.waitForFunction(()=>document.querySelector('.crm-sidebar')?.getAttribute('aria-hidden')==='true');
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
        });
        if(role==='owner'){
            for(const [id,path,fn] of [
                ['MOBILE-CATALOG-FORM','/autopilot?tab=catalog',async()=>{await page.getByRole('button',{name:'Загрузить таблицу',exact:true}).click();await page.getByLabel('Таблица товаров').waitFor();await page.getByRole('button',{name:'Открыть предпросмотр',exact:true}).waitFor();}],
                ['MOBILE-CAMPAIGN-FORM','/outbound',async()=>{await page.getByRole('button',{name:'Новая кампания',exact:true}).click();await page.getByRole('button',{name:'Таблица CSV',exact:true}).click();await page.getByLabel('Или вставьте CSV').fill('phone;name\n79990000002;Черновик');await page.getByLabel('Название кампании').fill('Несохранённая форма');}],
                ['MOBILE-STUDIO-FORM','/studio?dealId='+ready.dealId,async()=>{await page.getByLabel('Сделка',{exact:true}).selectOption(ready.dealId);await page.getByRole('button',{name:'Подготовить черновик',exact:true}).click();await page.getByRole('button',{name:'Выставить счёт',exact:true}).click();await page.getByLabel('Номер счёта',{exact:true}).fill('UNSAVED');}],
                ['MOBILE-MANUAL-PROMPT','/assistant-builder',async()=>{await page.getByRole('button',{name:/Добавьте ссылки/}).waitFor();await page.getByText('Написать инструкции самостоятельно',{exact:true}).click();await page.getByLabel('Ваши инструкции ассистенту').fill('Не сохранено');}],
                ['MOBILE-CHANNEL-PANELS','/channels',async()=>{for(const name of ['WhatsApp','amoCRM','Авито']){await page.getByRole('button',{name:new RegExp('^'+name+' ')}).click();await page.locator('#ava-channel-panel').waitFor();}}],
                ['MOBILE-TEAM-FORM','/team',async()=>{await page.getByRole('heading',{name:'Команда',exact:true}).waitFor();await page.locator('input[type=email]').fill('unsent@example.test');}],
            ])await test(id,role,390,path,page,async()=>{await page.goto(ready.origin+path);await settle(page);await fn();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Mobile form overflow');await shot(page,id.toLowerCase());});
        }
        await ctx.close();
    }
}finally{
    const state=await snapshot();await writeFile(new URL('results.json',output),JSON.stringify({generatedAt:new Date().toISOString(),sourceHead:ready.sourceHead,builtIndexSha256:ready.builtIndexSha256,routeTemplates,level:'actual React/Express/SQLite, external-boundary fixtures',apiIntercepts:false,recheckCount:needsRecheck?.length||0,results,pageErrors,responses:results.flatMap(x=>x.api),requests,requestsScope:'Last targeted execution only; complete per-case response traces are in results[].api',screenshots,snapshot:state},null,2));
    await writeFile(new URL('harness.log',output),logs.replace(/VAPID_(?:PRIVATE|PUBLIC)_KEY=[^\n]*/g,'VAPID_KEY=[REDACTED]'));await browser.close();child.send({op:'close'});setTimeout(()=>child.kill(),2000).unref();
}
console.log(JSON.stringify({passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL'),pageErrors,api5xx:responses.filter(x=>x.status>=500)},null,2));
if(results.some(x=>x.status==='FAIL')||pageErrors.length)process.exitCode=1;
