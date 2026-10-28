#!/usr/bin/env node
// Controlled local UI only: every API request is intercepted; no provider/business mutation.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.AVA_PLAYWRIGHT_PATH || '/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base=process.env.AVA_UI_BASE || 'http://127.0.0.1:5187';
const out=path.resolve('docs/customer-path-20261017/acceptance-ui-evidence');fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.AVA_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const capabilities=['business.read','business.manage','team.read','team.manage','sales.read','sales.write','sales.assign','tasks.claim','tasks.manage','messages.send','ai.use'];
const report={at:new Date().toISOString(),level:'local UI with controlled API responses, NOT integrated/provider acceptance',base,routes:[],checks:[],outboundRequests:[]};
let role='hotel_owner';
const context=await browser.newContext({viewport:{width:1440,height:1000}});
await context.route('**/*',async route=>{
 const u=new URL(route.request().url());
 if(u.origin!==base && !['data:','blob:'].includes(u.protocol)){report.outboundRequests.push({origin:u.origin,method:route.request().method()});return route.abort();}
 if(!u.pathname.startsWith('/api/'))return route.continue();
 const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 if(u.pathname==='/api/auth/me')return json(role==='public'?{authenticated:false}:{authenticated:true,userId:'acceptance-user',login:'acceptance',displayName:'Проверка',role:role==='platform_admin'?'platform_admin':'customer',canCreateBusiness:role==='bootstrap',memberships:role==='bootstrap'?[]:[9,19].map(businessId=>({businessId,role,capabilities:role==='manager'?['business.read','sales.read','sales.write','messages.send','tasks.claim','ai.use']:role==='observer'?['business.read','sales.read']:capabilities}))});
 if(u.pathname==='/api/auth/config')return json({success:true,sso_enabled:true});
 if(u.pathname==='/api/public/identity/config')return json({success:true,sso_enabled:true,registration_enabled:true,recovery_enabled:true,minPasswordLength:12,maxPasswordLength:256,verification_method:'email_code',invitation_required:false});
 if(u.pathname==='/api/instances')return json({success:true,instances:role==='bootstrap'?[]:[{id:9,name:'Проверочный бизнес',isActive:1},{id:19,name:'Второй проверочный бизнес',isActive:1}]});
 if(/\/onboarding$/.test(u.pathname))return json({success:true,onboarding:{businessId:Number(u.pathname.split('/')[3]),status:'completed',confirmedSteps:['business','voice','knowledge','channels','review'],completedAt:'2026-10-17T00:00:00Z'}});
 if(/\/release-flags$/.test(u.pathname))return json({success:true,businessId:Number(u.pathname.split('/')[3]),revision:1,flags:{workspace:true,analytics:true,autopilot:true}});
 return json({success:false,code:'CONTROLLED_UNAVAILABLE',error:'Controlled service unavailable'},503);
});
const page=await context.newPage();let errors=[];page.on('pageerror',e=>errors.push(e.message));
const routes=['/','/today','/sales','/integrations','/getting-started','/simulator','/instances','/conversations','/leads','/deals','/opportunities','/clients','/autopilot','/workspace-analytics','/all-leads','/analytics','/reports','/coffee','/triggers','/assistant-builder','/channels','/client/acceptance-client','/customers/acceptance-client','/knowledge-base','/outbound','/calls','/quick-replies','/team','/activity','/business-gpt','/studio'];
try{
 for(const r of routes){errors=[];await page.goto(base+r);await page.waitForTimeout(380);const state=await page.evaluate(()=>({url:location.pathname,text:document.querySelector('main')?.innerText||document.body.innerText,controls:Array.from(document.querySelectorAll('main button,main a,main input,main select,main textarea')).map(x=>({tag:x.tagName,label:x.getAttribute('aria-label')||x.textContent||x.getAttribute('placeholder')||'',disabled:x.disabled||false})),overflow:document.documentElement.scrollWidth>innerWidth,headings:[...document.querySelectorAll('main h1,main h2')].map(x=>x.textContent)}));report.routes.push({role,requested:r,...state,errors:[...errors]});}
 await page.goto(base+'/channels');await page.waitForTimeout(300);
 await page.screenshot({path:path.join(out,'owner-channels-controlled-unavailable.png'),fullPage:true});
 const before=await page.locator('.crm-sidebar').evaluate(x=>({inert:x.inert,rect:x.getBoundingClientRect().toJSON()}));
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);
 const after=await page.locator('.crm-sidebar').evaluate(x=>({inert:x.inert,rect:x.getBoundingClientRect().toJSON(),links:[...x.querySelectorAll('a')].filter(a=>a.tabIndex>=0).length}));
 report.checks.push({name:'desktop-to-mobile closed navigation keyboard isolation',before,after,status:after.inert?'PASS':'FAIL'});
 await page.screenshot({path:path.join(out,'mobile-channels-controlled-unavailable.png'),fullPage:true});
 await page.keyboard.press('Control+k');await page.waitForTimeout(100);report.checks.push({name:'quick jump opens by keyboard',dialogs:await page.getByRole('dialog').count()});await page.keyboard.press('Escape');
 for(const r of ['manager','observer','platform_admin','bootstrap']){role=r;for(const url of ['/','/today','/channels','/team','/integrations']){await page.goto(base+url);await page.waitForTimeout(220);report.routes.push({role:r,requested:url,url:new URL(page.url()).pathname,text:await page.locator('body').innerText(),errors:[...errors]});}}
 role='public';for(const url of ['/','/login','/register','/verify-email','/forgot-password','/invite','/owner-invite','/module-access']){errors=[];await page.goto(base+url);await page.waitForTimeout(250);report.routes.push({role,requested:url,url:new URL(page.url()).pathname,text:await page.locator('body').innerText(),errors:[...errors],overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});}
}finally{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2)+'\n');await browser.close();}
console.log(JSON.stringify({routes:report.routes.length,checks:report.checks,errors:report.routes.filter(r=>r.errors?.length).map(r=>({role:r.role,route:r.requested,errors:r.errors})),evidence:out},null,2));
