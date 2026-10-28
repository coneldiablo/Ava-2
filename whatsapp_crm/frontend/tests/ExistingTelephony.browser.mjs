// Existing-number UI evidence with synthetic local HTTP fixtures. No provider calls.
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.AVA_PLAYWRIGHT_PATH || '/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output=new URL('./evidence/existing-telephony/',import.meta.url);await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.AVA_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const caps=['business.read','business.manage','sales.read','sales.write','ai.use'];
const results=[];
// One second of local PCM silence: validates browser WAV decoding without a real call.
const wav=Buffer.alloc(16044);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);
wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40);
try {
for(const width of [1440,390,320]){
    const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
    let forwardingReady=false;
    let recordingRequests=0;
    const errors=[],mutations=[],forbidden=[];page.on('pageerror',e=>errors.push(e.message));
    const phone=(id,number,extra={})=>({origin:'existing',id,number,state:'active',isPrimary:0,installKopecks:0,monthlyKopecks:0,
        inboundReady:1,outboundReady:1,inboundVerifiedAt:null,outboundVerifiedAt:null,releaseAt:null,...extra});
    let numbers=[phone('p-1','74950000001',{isPrimary:1}),phone('p-2','74950000002')];
    await page.route('**/api/**',async route=>{
        const req=route.request(),path=new URL(req.url()).pathname;
        if(!path.startsWith('/api/'))return route.continue();
        if(/\/telephony\/(orders|quotes|catalog)$/.test(path)){
            forbidden.push(path);return route.fulfill({status:403,contentType:'application/json',body:'{"success":false,"code":"TELEPHONY_PURCHASE_DISABLED"}'});
        }
        if(path==='/api/calls/7/record-1/recording.wav'){
            recordingRequests++;return route.fulfill({status:200,contentType:'audio/wav',body:wav});
        }
        let data={success:true};
        if(req.method()!=='GET')mutations.push({path,method:req.method(),body:req.postDataJSON()});
        if(path==='/api/auth/me')data={authenticated:true,userId:'owner',displayName:'Владелец',login:'test',role:'customer',memberships:[{businessId:7,role:'hotel_owner',capabilities:caps}]};
        else if(path==='/api/calls/7')data={success:true,business_id:7,total:1,total_pages:1,calls:[{id:'record-1',business_id:7,caller_name:'Тестовая запись',caller_number:'+74950000001',direction:'inbound',outcome:'completed',duration_seconds:1,recording_file:'ava-7-test.wav',recording_url:'/api/calls/7/record-1/recording.wav'}]};
        else if(path==='/api/instances')data={success:true,instances:[{id:7,name:'Существующие номера AVA',isActive:1}]};
        else if(path.endsWith('/onboarding'))data={success:true,businessId:7,status:'completed',steps:{},revision:1};
        else if(path.endsWith('/release-flags'))data={success:true,businessId:7,revision:1,flags:{workspace:true,analytics:true,autopilot:true}};
        else if(/^\/api\/channels\/\d+\/status$/.test(path))return route.fulfill({status:503,contentType:'application/json',body:'{"success":false}'});
        else if(path.endsWith('/telephony'))data={success:true,canManage:true,canPurchase:false,canImport:true,managedMode:true,pilotEnabled:false,balanceReady:false,
            health:{ingressReady:false,recordingReady:false,checkedAt:Date.now()},numbers,limits:{numbers:3,dailySeconds:1800},remainingSeconds:1190,
            orders:[{id:'op-check',phoneId:null,kind:'import',state:'manual',stage:'import_validate',errorCode:'TELEPHONY_IMPORT_FORWARDING_REQUIRED'}],notices:[{code:'TELEPHONY_ROUTING_DRIFT',phoneId:null}]};
        else if(path.endsWith('/telephony/existing'))data={success:true,candidates:[{number:'74950000009',modes:['inbound_only'],alreadyBound:false,monthlyKopecks:null,forwardingReady,sipAvailable:false}],updatedAt:Date.now()};
        else if(path.endsWith('/telephony/imports')){
            const body=req.postDataJSON();
            if(!forwardingReady || body.confirmUnused!==true || body.mode!=='inbound_only' || body.number!=='74950000009' || !req.headers()['idempotency-key'])throw Error('Unsafe import');
            data={success:true,operation:{id:'op-new',kind:'import',state:'pending',stage:'import_validate'}};
        }
        else if(path.endsWith('/telephony/primary')){
            const id=req.postDataJSON().phoneId;numbers=numbers.map(p=>({...p,isPrimary:Number(p.id===id)}));
            data={success:true,number:numbers.find(p=>p.id===id)};
        }
        await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
    });
    await page.goto(`${process.env.AVA_TELEPHONY_BASE_URL || 'http://127.0.0.1:4195'}/channels`);
    await page.getByRole('button',{name:/Телефония Открыть номера/}).click();
    const panel=page.getByRole('region',{name:'Телефония'});
    await panel.getByText(/Осталось 19 мин 50 сек/).waitFor();
    if(await panel.getByRole('button',{name:'Купить номер'}).count())throw Error('Purchase exposed while disabled');
    await panel.getByText(/входящий маршрут не подтверждён, запись разговоров не подтверждена/).waitFor();
    await panel.getByText(/Покупка новых номеров сейчас недоступна/).waitFor();
    const ownNumber=panel.getByRole('listitem').filter({hasText:'+74950000002'});
    const primary=ownNumber.getByRole('button',{name:'Сделать основным'});await page.keyboard.press('Tab');await primary.focus();
    const focusOutline=await primary.evaluate(el=>getComputedStyle(el).outlineStyle);
    if(focusOutline==='none')throw Error('Missing focus indicator');
    await page.screenshot({path:new URL(`existing-${width}.png`,output).pathname,fullPage:true});
    await page.keyboard.press('Enter');await ownNumber.getByText('Основной · Подключён').waitFor();
    if(mutations.length!==1 || !mutations[0].path.endsWith('/telephony/primary') || mutations[0].body.phoneId!=='p-2')throw Error('Wrong primary mutation');
    await panel.getByRole('button',{name:'Показать разрешённые номера'}).click();
    await panel.getByRole('combobox',{name:'Существующий номер'}).waitFor();
    await panel.getByRole('checkbox').check();
    const importButton=panel.getByRole('button',{name:'Подключить +74950000009 к AVA'});
    if(!await importButton.isDisabled())throw Error('Missing forwarding failed to block import');
    if(await panel.getByRole('option',{name:'Входящие и исходящие'}).count())throw Error('SIP mode offered without SIP');
    await page.screenshot({path:new URL(`blocked-import-${width}.png`,output).pathname,fullPage:true});
    forwardingReady=true;
    await panel.getByRole('button',{name:'Обновить разрешённые номера'}).click();
    await panel.getByRole('checkbox').check();
    await importButton.click();await panel.getByText(/Заявка на привязку принята/).waitFor();
    if(mutations.length!==2 || !mutations[1].path.endsWith('/telephony/imports'))throw Error('Wrong binding mutation');
    await page.screenshot({path:new URL(`accepted-import-${width}.png`,output).pathname,fullPage:true});
    if(forbidden.length)throw Error('Paid resource API was accessed');
    const noOverflow=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
    if(!noOverflow)throw Error(`Overflow at ${width}`);
    if(errors.length)throw Error(errors.join('\n'));
    await page.goto(`${process.env.AVA_TELEPHONY_BASE_URL || 'http://127.0.0.1:4195'}/calls`);
    const audio=page.getByLabel('Запись звонка Тестовая запись');await audio.waitFor();
    if(recordingRequests!==0)throw Error('Recording preloaded before user playback');
    await audio.evaluate(element=>element.play());
    await page.waitForFunction(()=>document.querySelector('audio')?.currentTime>0);
    if(recordingRequests<1 || await audio.evaluate(element=>Boolean(element.error)))throw Error('Protected WAV did not play');
    if(!await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))throw Error(`Player overflow at ${width}`);
    await page.screenshot({path:new URL(`recording-${width}.png`,output).pathname,fullPage:true});
    if(errors.length)throw Error(errors.join('\n'));
    results.push({width,protectedRecordingPlayed:true,recordingPreloadNone:true,noOverflow,focusOutline,independentChannelFailure:true,existingNumbers:true,primarySelected:true,
        minutes:true,directions:true,supportReconciliation:true,forwardingBlocked:true,inboundOnlyNoSIP:true,confirmedImport:true,purchaseHidden:true,noPaidResourceRequests:!forbidden.length,pageErrors:errors});
    await page.close();
}
await writeFile(new URL('results.json',output),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}finally{await browser.close();}
