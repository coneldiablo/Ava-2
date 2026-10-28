// Rendered React QA with synthetic API boundaries. No production/provider calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.AVA_DASHBOARD_QA_URL || 'http://127.0.0.1:4197';
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname));
const output = process.env.AVA_DASHBOARD_QA_OUTPUT || '/tmp/ava-dashboard-journeys-20261020';
await mkdir(output, { recursive: true });
const report = { synthetic: true, integratedBackend: false, providerCalls: 0, productionAcceptance: false, checks: [] };
const daysIn = days => Array.from({length:days},(_,i)=>new Date(Date.UTC(2026,9,20-days+1+i)).toISOString().slice(0,10));
function metrics(id, days) {
  const dates=daysIn(days), leads=dates.map((date,i)=>({date,count:i%5===0?0:(i*7+3)%9})), closed=dates.map((date,i)=>({date,count:i%8===2?1:0,amounts:[]}));
  return { success:true,business_id:id,period:{days,timezone:'Europe/Moscow',start:dates[0]+'T00:00:00Z',endExclusive:'2026-10-21T00:00:00Z',asOf:'2026-10-20T12:00:00Z'},
    kpis:{leads:{created:leads.reduce((sum,p)=>sum+p.count,0),total:124,active:35},messages:{inbound:167,outbound:98,total:265},deals:{created:12,open:8,won:closed.reduce((sum,p)=>sum+p.count,0),lost:0,openAmounts:[],wonAmounts:[{currency:'RUB',amountMinor:12500000}]},ai:{recordedSuccessfulToolRuns:14,status:'partial'}},
    series:{leads,closedDeals:closed},
    dealFunnel:[{stage:'new',count:3,amounts:[]}],currentFunnel:{status:'available',scope:'all_open',totalOpen:17,items:[{stage:'new',count:7,amounts:[{currency:'RUB',amountMinor:18000000}]},{stage:'qualified',count:5,amounts:[{currency:'RUB',amountMinor:6500000}]},{stage:'proposal',count:3,amounts:[{currency:'RUB',amountMinor:12000000}]},{stage:'negotiation',count:2,amounts:[{currency:'RUB',amountMinor:5500000}]}]},
    sources:{closedDeals:{status:'partial',description:'fixture'},ai:{status:'partial',description:'fixture'}} };
}
const browser = await chromium.launch({headless:true,executablePath:process.env.AVA_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try {
  for (const viewport of [{width:1440,height:1000},{width:375,height:844}]) {
    const context=await browser.newContext({viewport,reducedMotion:'reduce',serviceWorkers:'block'}), seen=[], errors=[];
    await context.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url()),path=url.pathname;
      if(!['127.0.0.1','localhost'].includes(url.hostname))return route.abort();
      if(!path.startsWith('/api/'))return route.continue();
      seen.push({path,method:req.method(),query:url.search});
      let json={success:true};
      if(path==='/api/auth/me')json={authenticated:true,userId:'synthetic-owner',login:'Владелец',displayName:'Владелец',role:'customer',memberships:[{businessId:7,role:'hotel_owner',capabilities:['business.read','business.manage','team.read','team.manage','sales.read','sales.write','sales.assign','tasks.manage','messages.send','ai.use']}]};
      else if(path==='/api/instances')json={success:true,instances:[{id:7,name:'Локальный бизнес',isActive:1,businessType:'standard',hotelTimezone:'Europe/Moscow'}]};
      else if(path.endsWith('/onboarding'))json={success:true,onboarding:{businessId:7,status:'completed',confirmedSteps:['business','voice','knowledge','channels','review'],completedAt:'2026-10-01T00:00:00Z'}};
      else if(path.endsWith('/release-flags'))json={success:true,businessId:7,revision:1,flags:{workspace:true}};
      else if(path==='/api/stats/7')json={success:true,stats:{totalClients:124,activeLeads:35,booked:12,pickupConfirmed:0,conversion:9.7}};
      else if(path==='/api/dashboard/7/metrics')json=metrics(7,Number(url.searchParams.get('days')||30));
      else if(path==='/api/dashboard/7/intelligence')json={success:true,instanceId:7,generatedAt:'2026-10-20T12:00:00Z',priorities:[{id:'task1',kind:'task',score:4,title:'Ответить клиенту по предложению',reason:'Клиент ждёт уточнения комплектации',nextAction:'Проверить подготовленный ответ',target:{path:'/today?client=synthetic-client'}}],deals:{status:'available',items:[{id:'deal-1',source:'customer_deals',title:'Поставка оборудования',stage:'qualified',amount:125000,currency:'RUB',score:60,riskReasons:[{code:'next_action_missing',points:10,evidence:'Не назначено следующее действие'}],target:{path:'/deals?dealId=deal-1'}}]},dayPlan:{status:'available',date:'2026-10-20',items:[]},sentiment:{status:'insufficient_data',sampleSize:0,windowDays:30},agents:{status:'unavailable',items:[]}};
      else if(path==='/api/dashboard/7/ai/overview')json={success:true,overview:{businessId:7,window:{kind:url.searchParams.get('window'),timezone:'Europe/Moscow'},status:'available',answerStatus:'answered',grounded:true,summary:url.searchParams.get('window')==='overnight'?'Ночью пришли три обращения. Один клиент готов обсудить предложение — стоит связаться с ним в первую очередь.':'Команда обработала восемь обращений и закрыла две сделки. Сегодня важно вернуться к клиентам, которые ждут уточнения условий.'}};
      else if(path==='/api/dashboard/7/activity')json={success:true,instanceId:7,status:'available',sourceComplete:true,period:{timezone:'Europe/Moscow'},items:[]};
      else if(path==='/api/dashboard/7/ai/recommendations')json={success:true,recommendations:[]};
      else if(path==='/api/dashboard/7/ai/ask')json={success:true,grounded:true,answerStatus:'answered',answer:'В работе 17 сделок. Пять клиентов уточняют условия. Начните с предложения, где клиент ждёт ответ.',sources:[{type:'customer_deal',id:'deal-1'},{type:'client',id:'row-1'}]};
      else if(path==='/api/push/vapid-public-key')json={success:false};
      return route.fulfill({status:200,json});
    });
    const page=await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/');
    await page.getByRole('heading',{name:'Главная',exact:true}).waitFor();
    const chart=page.getByRole('region',{name:'Динамика бизнеса'}), funnel=page.getByRole('region',{name:'Воронка сделок'});
    await funnel.getByRole('link',{name:'Квалификация 5',exact:true}).waitFor();
    assert.equal(await funnel.getByRole('link',{name:'Квалификация 5',exact:true}).getAttribute('href'),'/deals?stage=qualified');
    await chart.getByRole('slider',{name:'Дата на графике'}).focus(); await page.keyboard.press('Home');
    assert((await chart.getByRole('slider').getAttribute('aria-valuetext')).includes('21 сент.'));
    await chart.getByRole('button',{name:'Следующий день на графике'}).click();
    await chart.getByText('Показать данные по дням',{exact:true}).click(); assert.equal(await chart.getByRole('row').count(),31);
    await chart.getByText('Показать данные по дням',{exact:true}).click();
    const overviewCalls=seen.filter(r=>r.path==='/api/dashboard/7/ai/overview').length;
    await page.getByRole('button',{name:'7 дн.',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.cc-trend-svg title')?.textContent?.includes('7 дней'));
    assert.equal(seen.filter(r=>r.path==='/api/dashboard/7/ai/overview').length,overviewCalls);
    await page.getByLabel('Вопрос для AVA').fill('Как идёт мой бизнес?'); await page.getByRole('button',{name:'Отправить вопрос',exact:true}).click();
    await page.getByText('В работе 17 сделок. Пять клиентов уточняют условия. Начните с предложения, где клиент ждёт ответ.',{exact:true}).waitFor();
    await page.getByText('На чём основан ответ',{exact:true}).click();
    assert.equal(await page.locator('.cc-answer-sources').getByRole('link',{name:'Сделки',exact:true}).getAttribute('href'),'/deals?dealId=deal-1');
    const sizing=await page.locator('.command-center').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth,overflow:el.scrollWidth>el.clientWidth+1,heroFirst:el.querySelector('.cc-ask-form').compareDocumentPosition(el.querySelector('.cc-period-toolbar')) & Node.DOCUMENT_POSITION_FOLLOWING,svgWidth:el.querySelector('svg.cc-trend-svg')?.getBoundingClientRect().width,buttons:[...el.querySelectorAll('.cc-series-toggle,.cc-chart-navigation button,.cc-period-toolbar .cc-chip')].map(x=>({w:x.getBoundingClientRect().width,h:x.getBoundingClientRect().height}))}));
    assert.equal(sizing.overflow,false); assert(sizing.heroFirst); assert(sizing.buttons.every(x=>x.w>=44&&x.h>=44),JSON.stringify(sizing)); assert.deepEqual(errors,[]);
    await page.waitForFunction(()=>{const el=document.querySelector('.cc-trend-svg'); return el && Math.abs(el.getBoundingClientRect().width-Number(el.getAttribute('viewBox').split(' ')[2]))<1;});
    await page.evaluate(()=>window.scrollTo(0,0)); await page.screenshot({path:`${output}/${viewport.width}-dashboard.png`,fullPage:true});
    await chart.screenshot({path:`${output}/${viewport.width}-chart.png`});
    report.checks.push({viewport,sizing,jsErrors:errors,overviewCalls,periods:[30,7],askAndExactSource:true,keyboardAndTable:true,status:'PASS'});
    await context.close();
  }
  report.pass=true;
} finally { await browser.close(); await writeFile(`${output}/receipt.json`,JSON.stringify(report,null,2)+'\n'); }
console.log(JSON.stringify(report));
