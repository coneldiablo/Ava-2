// Synthetic local browser QA; this does not prove mail delivery or production enrollment.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AVA_PLAYWRIGHT_PATH || '/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = process.env.AVA_PUBLIC_UI_URL || 'http://127.0.0.1:5188';
const output = new URL('./evidence/public-identity/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({headless:true,executablePath:process.env.AVA_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const results = [];
const proof = 'a'.repeat(43), user = '11111111-1111-4111-8111-111111111111';
try {
for (const width of [320,375,390,768,1440]) {
 const page = await browser.newPage({ viewport:{width,height:900},reducedMotion:'reduce' });
 const errors = [], mutations = []; let recoveryFail = false, policyRejected = false;
 page.on('pageerror', e => errors.push(e.message));
 await page.route('**/api/**', async route => {
  const req=route.request(), path=new URL(req.url()).pathname;
  if(req.method()!=='GET') mutations.push({path,keys:Object.keys(req.postDataJSON() || {})});
  let data; let status = 200;
  if(path==='/api/auth/me') data={authenticated:false};
  else if(path==='/api/auth/config') data={sso_enabled:true};
  else if(path.endsWith('/config')) data={success:true,sso_enabled:true,registration_enabled:true,recovery_enabled:true,minPasswordLength:12,maxPasswordLength:256,verification_method:'email_code',invitation_required:false};
  else if(path.endsWith('/registration/start')) data={success:true,status:'verification_requested',verification_id:proof,masked_email:'t***@example.com',resend_after_ms:60000,expires_in_ms:900000};
  else if(path.endsWith('/registration/verify')) {
   if(!policyRejected) { policyRejected=true; status=400; data={success:false,error_code:'PASSWORD_POLICY'}; }
   else { const body=req.postDataJSON(); if(body.verification_id!==proof || body.code!=='123456' || body.password!=='replacement-password-123') throw new Error('Password correction changed proof or code'); data={success:true,status:'completed',user_id:user,business_id:7,login_url:`/api/auth/sso/start?enrolled_user=${user}`}; }
  }
  else if(path.endsWith('/password/recovery')) data=recoveryFail?{success:false,error_code:'REGISTRATION_UNAVAILABLE'}:{success:true,message:'generic'};
  else throw new Error(`Unexpected API: ${path}`);
  await route.fulfill({status:recoveryFail && path.endsWith('/password/recovery')?503:status,contentType:'application/json',body:JSON.stringify(data)});
 });
 const overflow = async (screen) => { if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) throw new Error(`${screen} overflow at ${width}`); };
 await page.goto(base); await page.getByRole('heading',{name:/Ваш бизнес/}).waitFor(); await overflow('welcome');
 await page.keyboard.press('Tab'); if(!(await page.locator('.public-skip').evaluate(el=>el===document.activeElement))) throw new Error('Skip link not first keyboard control');
 await page.locator('h1').click(); await page.screenshot({path:new URL(`welcome-${width}.png`,output).pathname,fullPage:true});
 await page.getByRole('link',{name:'Создать бизнес',exact:true}).click();
 await page.getByLabel('Как вас зовут').fill('Анна'); await page.getByLabel('Название бизнеса').fill('Студия Анны'); await page.getByRole('button',{name:'Продолжить',exact:true}).click();
 await page.getByLabel('Электронная почта').fill('test@example.com'); await page.getByLabel('Пароль',{exact:true}).fill('long-password-123'); await page.getByLabel('Повторите пароль').fill('long-password-123');
 await overflow('account'); await page.screenshot({path:new URL(`account-${width}.png`,output).pathname,fullPage:true}); await page.getByRole('button',{name:'Получить код'}).click(); await page.getByLabel('Код из письма').waitFor();
 const saved = await page.evaluate(()=>JSON.stringify(sessionStorage)); if(saved.includes('long-password')||saved.includes('123456')) throw new Error('Credentials in storage');
 await page.reload(); await page.getByLabel('Код из письма').waitFor(); await page.getByLabel('Код из письма').fill('123456'); await overflow('otp');
 await page.screenshot({path:new URL(`otp-${width}.png`,output).pathname,fullPage:true}); await page.getByRole('button',{name:'Подтвердить почту'}).click();
 await page.getByLabel('Новый пароль',{exact:true}).waitFor();
 await page.getByLabel('Новый пароль',{exact:true}).fill('replacement-password-123'); await page.getByLabel('Повторите новый пароль').fill('replacement-password-123');
 if((await page.evaluate(()=>JSON.stringify(sessionStorage))).includes('replacement-password')) throw new Error('Replacement persisted');
 await overflow('password correction'); await page.screenshot({path:new URL(`password-correction-${width}.png`,output).pathname,fullPage:true});
 await page.getByRole('button',{name:'Подтвердить почту'}).click();
 await page.getByRole('heading',{name:'Почта подтверждена'}).waitFor(); await page.reload(); await page.getByRole('heading',{name:'Почта подтверждена'}).waitFor();
 if(await page.getByRole('link',{name:'Перейти в AVA'}).getAttribute('href')!==`/api/auth/sso/start?enrolled_user=${user}`) throw new Error('First login lost subject binding');
 await page.goto(`${base}/forgot-password`); await page.getByLabel('Электронная почта').fill('unknown@example.com'); recoveryFail=true;
 await page.getByRole('button',{name:'Восстановить доступ'}).click(); await page.getByRole('alert').waitFor(); if(await page.getByRole('heading',{name:'Проверьте почту'}).count()) throw new Error('Failed recovery shown as success');
 recoveryFail=false; await page.getByRole('button',{name:'Восстановить доступ'}).click(); await page.getByRole('heading',{name:'Проверьте почту'}).waitFor(); await overflow('recovery');
 await page.screenshot({path:new URL(`recovery-${width}.png`,output).pathname,fullPage:true});
 await page.goto(`${base}/login`); await page.getByRole('link',{name:'Продолжить вход'}).waitFor(); if(page.url()!==`${base}/login`) throw new Error('Login auto redirects'); await overflow('login');
 if(await page.getByRole('link',{name:'Продолжить вход'}).getAttribute('href')!==`/api/auth/sso/start?enrolled_user=${user}`) throw new Error('Login reload lost verified account binding');
 await page.screenshot({path:new URL(`login-${width}.png`,output).pathname,fullPage:true});
 if(errors.length) throw new Error(errors.join('\n'));
 results.push({width,registration:true,passwordCorrection:true,reloadOtp:true,subjectBoundLogin:true,recoveryFailureHonest:true,recoveryNeutral:true,noAutoSso:true,keyboardSkip:true,noOverflow:true,mutations,pageErrors:errors});
 await page.close();
}
} finally { await browser.close(); }
await writeFile(new URL('results.json',output),JSON.stringify({synthetic:true,mailDelivery:'not tested',results},null,2)+'\n');
console.log(JSON.stringify(results.map(({width,...r})=>({width,...r,mutations:r.mutations.length}))));
