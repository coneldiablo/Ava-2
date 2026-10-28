// Built assets + synthetic API fixtures, in separate headless browsers only.
// No real account, provider request, customer message or production API write.
const { createServer } = require('node:http');
const fs = require('node:fs'), path = require('node:path');
const { webkit, chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(process.env.AVA_FRONTEND_DIST || 'dist');
const caps = ['business.read','business.manage','team.read','team.manage','sales.read','sales.write','sales.assign','tasks.claim','tasks.manage','messages.send','ai.use'];
const server = createServer((req,res) => {
    const name = new URL(req.url, 'http://local').pathname;
    let file = path.resolve(root, '.' + decodeURIComponent(name));
    if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(400).end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        if (name.startsWith('/assets/')) { res.writeHead(404).end(); return; }
        file = path.join(root, 'index.html');
    }
    res.setHeader('Content-Type', ({'.js':'application/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
});
(async () => {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const origin = `http://127.0.0.1:${server.address().port}`, results=[];
    try {
        for (const engine of [webkit,chromium]) {
            const browser = await engine.launch({headless:true,...(engine===chromium&&process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
            try { for (const role of ['hotel_owner','sales_lead','manager','observer']) for (const route of ['/today','/conversations']) {
                const context=await browser.newContext(), page=await context.newPage(), errors=[];
                page.on('pageerror',e=>errors.push(e.message));
                await page.route('**/*',async intercepted=>{
                    const request=intercepted.request(), url=new URL(request.url()), p=url.pathname;
                    if (url.origin!==origin) return intercepted.abort();
                    if (/\/assets\/TodayWorkspace-[^/]+\.js$/.test(p)) return intercepted.abort('failed');
                    if (!p.startsWith('/api/')) return intercepted.continue();
                    if (request.method()!=='GET') return intercepted.fulfill({status:405,body:'{}'});
                    let body={success:true,businessId:1,capabilities:caps};
                    if(p==='/api/auth/me') body={authenticated:true,success:true,userId:'fixture-user',role:'customer',memberships:[{businessId:1,role,capabilities:caps}]};
                    else if(p==='/api/instances') body={success:true,instances:[{id:1,name:'Тестовый бизнес',isActive:1}]};
                    else if(p.endsWith('/onboarding')) body={success:true,onboarding:{businessId:1,status:'completed',confirmedSteps:['business','voice','knowledge','channels','review'],completedAt:'2026-10-20T00:00:00Z'}};
                    else if(p.endsWith('/release-flags')) body={...body,revision:1,flags:{workspace:true,analytics:true,autopilot:true}};
                    else if(p.endsWith('/workspace/features')) body={...body,available:false,revision:1,flags:{queueFlow:false,collaboration:false,shifts:false,attention:false,copilot:false,knowledgeReview:false}};
                    else if(p.endsWith('/workspace')) body={...body,view:url.searchParams.get('view'),items:[],summary:{needsHuman:0,overdue:0,unassigned:0,aiActive:0},pagination:{page:1,pageSize:30,total:0}};
                    else if(p.endsWith('/saved-views')) body={...body,views:[]};
                    return intercepted.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
                });
                await page.goto(origin+route,{waitUntil:'domcontentloaded'});
                const heading=route==='/conversations'?'Обращения':role==='sales_lead'?'Отдел продаж':role==='manager'?'Мой день':role==='observer'?'Обзор обращений':'Сегодня';
                await Promise.race([page.getByRole('heading',{name:heading,exact:true}).waitFor(),page.getByText('Не удалось открыть раздел',{exact:true}).waitFor()]);
                const passed=await page.getByRole('heading',{name:heading,exact:true}).count()===1&&errors.length===0;
                results.push({browser:engine.name(),role,route,passed,errors});await context.close();
            } } finally { await browser.close(); }
        }
        const output={ok:results.every(r=>r.passed),lostWorkspaceModuleSimulated:true,fixturesOnly:true,customerSend:false,results};
        if(process.env.AVA_STARTUP_RECEIPT)fs.writeFileSync(process.env.AVA_STARTUP_RECEIPT,JSON.stringify(output,null,2)+'\n');
        console.log(JSON.stringify(output));if(!output.ok)process.exitCode=1;
    } finally {await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
