// Local production React render with controlled HTTP fixtures. Not live provider acceptance.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const output = new URL('../../../docs/customer-path-20261017/frontend-ui-evidence/', import.meta.url);
await mkdir(output, { recursive: true });
const base = process.env.AVA_CUSTOMER_UI_URL || 'http://127.0.0.1:5187';
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const proof='v'.repeat(43), user='11111111-1111-4111-8111-111111111111';
const caps=['business.read','business.manage','sales.read','sales.write','sales.assign','messages.send','tasks.claim','tasks.manage','ai.use','team.read','team.manage'];
const results=[];
try { for (const width of (process.env.AVA_BROWSER_WIDTH ? [Number(process.env.AVA_BROWSER_WIDTH)] : [320,390,1440])) {
 const page=await browser.newPage({ viewport:{width,height:900},reducedMotion:'reduce' }); const errors=[],requests=[];let authenticated=false, committed=false, completed=false, ambient=null;
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname; if(!path.startsWith('/api/')){await route.continue();return;} requests.push({method:req.method(),path});
  let data={success:true};
  if(path==='/api/auth/me') data=authenticated?{authenticated:true,userId:'owner',role:'customer',login:'owner',memberships:[{businessId:7,role:'hotel_owner',capabilities:caps}]}:{authenticated:false};
  else if(path.endsWith('/identity/config'))data={success:true,sso_enabled:true,registration_enabled:true,recovery_enabled:true,minPasswordLength:12,maxPasswordLength:256,verification_method:'email_code',invitation_required:false};
  else if(path.endsWith('/registration/start'))data={success:true,status:'verification_requested',verification_id:proof,masked_email:'o***@example.test',resend_after_ms:0,expires_in_ms:900000};
  else if(path.endsWith('/registration/status'))data={success:true,status:'verification_requested',verification_id:proof,masked_email:'o***@example.test',resend_after_ms:0,expires_in_ms:900000};
  else if(path.endsWith('/registration/verify'))data={success:true,status:'existing_account',next_action:'sign_in_or_recover',login_url:'/api/auth/sso/start',recovery_url:'/forgot-password'};
  else if(path==='/api/instances')data={success:true,instances:[{id:7,name:'Проверочный бизнес',businessType:'standard',isActive:1}]};
  else if(path.endsWith('/onboarding'))data={success:true,onboarding:{businessId:7,status:completed?'completed':'pending',confirmedSteps:completed?['business','voice','knowledge','channels','review']:['business'],completedAt:completed?'2026-10-17T10:00:00Z':null}};
  else if(path.endsWith('/release-flags'))data={success:true,businessId:7,revision:1,flags:{workspace:true,analytics:true,autopilot:true}};
  else if(path.endsWith('/autopilot'))data={success:true,businessId:7,capabilities:caps,policy:null,usage:{requests:0,tokens:0,voiceSeconds:0,estimatedCost:0,currency:'RUB',actions:0,handovers:0,periodStart:'2026-10-01T00:00:00Z'},actions:[],templates:[]};
  else if(path.endsWith('/catalog'))data={success:true,businessId:7,offers:[]};
  else if(path.includes('/catalog-imports')) {
   const value={id:user,businessId:7,status:committed?'committed':'preview',filename:'products.csv',columns:[{index:0,name:'Название'},{index:1,name:'Цена'}],rowCount:1,preview:[{row:2,cells:['Электропастух','5000']}],expiresAt:'2026-10-18T12:00:00Z',...(committed?{receipt:{status:'completed',added:1,updated:0,skipped:[],errors:[],published:true}}:{})};
   if(path.endsWith('/validate'))data={success:true,validation:{validCount:1,errorCount:0,skippedCount:0,errors:[],products:[{row:2,name:'Электропастух',amountMinor:500000,currency:'RUB',operation:'add'}]}};
   else { if(path.endsWith('/commit')){committed=true;value.status='committed';value.receipt={status:'completed',added:1,updated:0,skipped:[],errors:[],published:true};}data={success:true,import:value}; }
  }
  else if(path.endsWith('/voice-options'))data={success:true,businessId:7,defaultProvider:'neuro_gemini',providers:[{id:'neuro_gemini',label:'Neuro + Gemini',available:true,models:[{id:'gemini-3.8-flash',label:'Gemini Flash'}],voices:[{id:'edsel',label:'Эдсель'}]}],ambientAudio:{available:true,presets:[{id:'office',label:'Офис'}],effective:ambient||{enabled:true,preset:'office',volume:1},previewAvailable:true}};
  else if(path==='/api/hotel-profiles/7'){if(req.method()==='PUT')ambient=req.postDataJSON().voiceAmbient;data={success:true,profile:{businessId:7,name:'Проверочный бизнес',businessType:'standard',systemPrompt:'Помогайте клиенту выбрать товар. Передайте сложный запрос менеджеру.',voiceAiProvider:'neuro_gemini',voiceModel:'gemini-3.8-flash',voiceName:'edsel',voiceAmbient:ambient}};}
  else if(path.endsWith('/assistant-draft'))data={success:true,businessId:7,draft:null};
  else if(path.endsWith('/onboarding/preparation'))data={success:true,preparation:{businessId:7,revision:0,links:[],supplement:''}};
  else if(path.includes('/knowledge-base'))data={success:true,businessId:7,stats:{totalDocuments:0},files:[]};
  else if(path.includes('/status'))data={success:true,channels:{}};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto(base+'/register'); await page.getByLabel('Как вас зовут').fill('Анна'); await page.getByLabel('Название бизнеса').fill('Проверочный бизнес'); await page.getByRole('button',{name:'Продолжить',exact:true}).click(); await page.getByLabel('Электронная почта').fill('owner@example.test');await page.reload();
 await page.getByLabel('Электронная почта').waitFor(); if(await page.getByLabel('Электронная почта').inputValue()!=='owner@example.test')throw Error('Safe form lost after reload');
 await page.getByLabel('Пароль',{exact:true}).fill('a-long-password-123');await page.getByLabel('Повторите пароль').fill('a-long-password-123'); await page.getByRole('button',{name:'Получить код'}).click();await page.getByLabel('Код из письма').waitFor();await page.reload();await page.getByLabel('Код из письма').fill('123456');await page.getByRole('button',{name:'Подтвердить почту'}).click();await page.getByRole('heading',{name:'У вас уже есть аккаунт'}).waitFor();
 if(await page.getByRole('link',{name:'Войти в AVA'}).getAttribute('href')!=='/api/auth/sso/start')throw Error('Existing account binding changed');
 await page.screenshot({path:new URL(`registration-existing-${width}.png`,output).pathname,fullPage:true});
 authenticated=true;await page.goto(base+'/autopilot?tab=catalog');await page.getByRole('button',{name:'Загрузить таблицу'}).click();await page.getByLabel('Таблица товаров').setInputFiles({name:'products.csv',mimeType:'text/csv',buffer:Buffer.from('Название,Цена\nЭлектропастух,5000')});await page.getByRole('button',{name:'Открыть предпросмотр'}).click();await page.getByLabel('Название *',{exact:true}).waitFor({timeout:5000}).catch(async error=>{console.log(await page.locator('main').innerText());console.log(JSON.stringify(requests));throw error;});await page.getByLabel('Название *',{exact:true}).selectOption('0');await page.getByLabel('Цена *',{exact:true}).selectOption('1');await page.getByLabel(/Опубликовать товары/).check();await page.getByRole('button',{name:'Проверить строки'}).click();await page.getByRole('button',{name:'Импортировать и опубликовать'}).waitFor();
 await page.screenshot({path:new URL(`catalog-preview-${width}.png`,output).pathname,fullPage:true});await page.getByRole('button',{name:'Импортировать и опубликовать'}).click();await page.getByRole('heading',{name:'Импорт завершён'}).waitFor({timeout:5000}).catch(async error=>{console.log(await page.locator('main').innerText());console.log(JSON.stringify(requests));throw error;});await page.reload();await page.getByRole('heading',{name:'Импорт завершён'}).waitFor({timeout:5000}).catch(async error=>{console.log('AFTER RELOAD');console.log(await page.locator('main').innerText());console.log(await page.evaluate(()=>JSON.stringify(sessionStorage)));console.log(JSON.stringify(requests));throw error;});
 await page.goto(base+'/getting-started');await page.getByRole('button',{name:/Шаг 2 Голос/}).click();await page.getByRole('button',{name:'Настроить позже'}).waitFor();await page.screenshot({path:new URL(`onboarding-${width}.png`,output).pathname,fullPage:true});
 await page.goto(base+'/assistant-builder');await page.getByRole('navigation',{name:'Первичная настройка бизнеса'}).waitFor();await page.getByText('Написать инструкции самостоятельно',{exact:true}).click();await page.getByLabel('Ваши инструкции ассистенту').waitFor();
 await page.screenshot({path:new URL(`manual-${width}.png`,output).pathname,fullPage:true});
 await page.getByLabel(/Громкость фона/).press('Home');for(let n=0;n<7;n++)await page.getByLabel(/Громкость фона/).press('ArrowRight');await page.getByRole('button',{name:'Сохранить фон'}).click();await page.getByText(/Фон сохранён/).waitFor();await page.getByRole('region',{name:'Фон звонка'}).screenshot({path:new URL(`ambient-${width}.png`,output).pathname});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth); if(overflow)throw Error(`Overflow ${width}`);
 completed=true;await page.reload();await page.getByLabel('Ссылки на страницы бизнеса').waitFor();if(await page.getByRole('navigation',{name:'Первичная настройка бизнеса'}).count())throw Error('Wizard banner survived completion');
 if(errors.length)throw Error(errors.join('\n'));results.push({width,local_ui:'PASS',synthetic:true,registrationSafeRefresh:true,existingAccountOtp:true,catalogReadback:true,catalogRefresh:true,optionalSteps:true,manualInstructionsVisible:true,ambientSaveReadback:true,completionHidesWizard:true,noOverflow:!overflow,pageErrors:errors,requestCount:requests.length});await page.close();
}}finally{await browser.close();}
await writeFile(new URL('results.json',output),JSON.stringify({level:'local_ui_controlled_http',live_provider:'NOT_TESTED',customer_acceptance:'NOT_TESTED',results},null,2)+'\n');console.log(JSON.stringify(results));
