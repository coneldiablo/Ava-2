// Synthetic HTTP fixtures for browser UX evidence. No provider or real calls are used.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.AVA_PLAYWRIGHT_PATH || '/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output=new URL('./evidence/telephony/',import.meta.url);await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.AVA_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const caps=['business.read','business.manage','sales.read','sales.write','ai.use'];
const results=[];
try {
for(const width of [1440,390,320]){
    const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const posts=[];let failPurchase=true;
    const quote={id:'q-1',number:'74950000003',installKopecks:10000,monthlyKopecks:5000,expiresAt:Date.now()+120000};
    const numbers=[{id:'p-1',number:'74950000001',state:'active',isPrimary:1,installKopecks:10000,monthlyKopecks:5000,
        inboundReady:1,outboundReady:1,inboundVerifiedAt:null,outboundVerifiedAt:null,releaseAt:null},
        {id:'p-2',number:'74950000002',state:'grace',isPrimary:0,installKopecks:10000,monthlyKopecks:5000,
        inboundReady:0,outboundReady:0,inboundVerifiedAt:null,outboundVerifiedAt:null,releaseAt:Date.now()+2*86400000}];
    await page.route('**/api/**',async route=>{
        const req=route.request(),url=new URL(req.url()),path=url.pathname;
        if(!path.startsWith('/api/'))return route.continue();
        let data={success:true};
        if(req.method()!=='GET')posts.push({path,body:req.postDataJSON(),key:req.headers()['idempotency-key']});
        if(path==='/api/auth/me')data={authenticated:true,userId:'owner',displayName:'Владелец',login:'test',role:'customer',memberships:[{businessId:7,role:'hotel_owner',capabilities:caps}]};
        else if(path==='/api/instances')data={success:true,instances:[{id:7,name:'Тест телефонии AVA',isActive:1}]};
        else if(path.endsWith('/onboarding'))data={success:true,businessId:7,status:'completed',steps:{},revision:1};
        else if(path.endsWith('/release-flags'))data={success:true,businessId:7,revision:1,flags:{workspace:true,analytics:true,autopilot:true}};
        else if(/^\/api\/channels\/\d+\/status$/.test(path))return route.fulfill({status:503,contentType:'application/json',body:'{"success":false}'});
        else if(path.endsWith('/telephony'))data={success:true,canManage:true,canPurchase:true,managedMode:true,pilotEnabled:true,balanceReady:true,numbers,
            limits:{numbers:3,dailySeconds:1800},remainingSeconds:1790,orders:[],notices:[{code:'TELEPHONY_RELEASE_WARNING',phoneId:'p-2'}]};
        else if(path.endsWith('/telephony/catalog'))data={success:true,types:[{type_id:1105,type_name:'Городской'}],regions:[{id:77,name:'Москва'}]};
        else if(path.endsWith('/telephony/quotes'))data={success:true,operation:{id:'quotes',kind:'quotes',state:'done',stage:'done',result:{quotes:[quote]}}};
        else if(path.endsWith('/telephony/orders')){
            if(failPurchase){failPurchase=false;return route.abort('failed');}
            data={success:true,operation:{id:'purchase',kind:'purchase',state:'pending',stage:'validate'}};
        }
        await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
    });
    await page.goto(`${process.env.AVA_TELEPHONY_BASE_URL || 'http://127.0.0.1:4193'}/channels`);
    await page.getByRole('button',{name:/Телефония Открыть номера/}).click({timeout:8000}).catch(async e=>{console.log(await page.locator('body').innerText());console.log(errors);await page.screenshot({path:new URL(`failure-${width}.png`,output).pathname,fullPage:true});throw e;});
    const panel=page.getByRole('region',{name:'Телефония'});
    await panel.getByText(/Осталось 29 мин 50 сек/).waitFor();
    await panel.screenshot({path:new URL(`overview-${width}.png`,output).pathname});
    const buy=panel.getByRole('button',{name:'Купить номер'});await buy.focus();await page.keyboard.press('Enter');
    const type=panel.getByLabel('Тип номера');await type.waitFor();
    if(await type.inputValue()!=='1105')throw Error('City type not selected');
    if(!await type.evaluate(el=>document.activeElement===el))throw Error('Catalog focus not on type');
    const focusOutline=await type.evaluate(el=>getComputedStyle(el).outlineStyle);
    if(focusOutline==='none')throw Error('No keyboard focus indicator');
    await panel.getByRole('button',{name:'Найти номера'}).focus();await page.keyboard.press('Enter');
    const radio=panel.getByRole('radio');await radio.waitFor();await radio.focus();await page.keyboard.press('Space');
    const confirm=panel.getByRole('button',{name:'Подтвердить покупку +74950000003'});await confirm.waitFor();
    if(posts.some(p=>p.path.endsWith('/orders')))throw Error('Purchase sent before explicit confirmation');
    if(!await panel.getByText(/Подключение и первый месяц: 150,00/).count())throw Error('Missing full price');
    await confirm.focus();await page.screenshot({path:new URL(`confirm-${width}.png`,output).pathname,fullPage:true});
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    if(overflow)throw Error(`Overflow at ${width}`);
    const contrast=await panel.evaluate(el=>{
        const rgb=value=>value.match(/[\d.]+/g).map(Number);
        const luminance=values=>values.slice(0,3).map(v=>{const x=v/255;return x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4;}).reduce((sum,x,i)=>sum+x*[0.2126,0.7152,0.0722][i],0);
        const ratio=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
        // Conservative bound: the darkest body gradient stop, under the panel's white surface.
        const surface=rgb(getComputedStyle(el).backgroundColor),alpha=surface[3]??1;
        const background=[190,198,210].map((c,i)=>surface[i]*alpha+c*(1-alpha));
        return {primary:ratio(rgb(getComputedStyle(el).color),background),
            secondary:ratio(rgb(getComputedStyle(el.querySelector('.ava-channel-hint')).color),background),
            kicker:ratio(rgb(getComputedStyle(el.querySelector('.ava-channels-kicker')).color),background),
            purchaseButton:ratio(rgb(getComputedStyle(el.querySelector('.ava-channel-primary')).color),rgb(getComputedStyle(el.querySelector('.ava-channel-primary')).backgroundColor)),
            backgroundBound:background};
    });
    if(contrast.primary<4.5 || contrast.secondary<4.5 || contrast.kicker<4.5 || contrast.purchaseButton<4.5)throw Error('Insufficient text contrast');
    const columns=await panel.evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);
    if(columns!==1)throw Error('Panel inherited multiple configuration columns');
    await page.keyboard.press('Enter');
    const retry=panel.getByRole('button',{name:'Проверить тот же заказ'});await retry.waitFor();
    await page.waitForFunction(()=>document.activeElement?.textContent==='Проверить тот же заказ');
    await page.screenshot({path:new URL(`lost-response-${width}.png`,output).pathname,fullPage:true});
    await page.keyboard.press('Enter');await panel.getByText(/Заказ принят/).waitFor();
    const orders=posts.filter(p=>p.path.endsWith('/orders'));
    if(orders.length!==2 || !orders[0].key || orders[0].key!==orders[1].key || orders[1].body.quoteId!=='q-1')throw Error('Unstable purchase retry');
    if(errors.length)throw Error(errors.join('\n'));
    results.push({width,noOverflow:!overflow,cityType:1105,keyboardCatalog:true,keyboardRadio:true,keyboardConfirmation:true,focusOutline,
        fullPrice:true,stableRetry:true,independentChannelFailure:true,columns,pageErrors:errors,contrast});
    await page.close();
}
await writeFile(new URL('results.json',output),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}finally{await browser.close();}
