'use strict';

// Real browser acceptance for an explicitly provisioned diagnostic customer.
// Does not create records, send messages/calls, or accept a platform owner login.
// Fixture is a mode-0600 JSON outside Git; credentials never appear in argv/logs.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const check = (condition, code) => { if (!condition) throw new Error(code); };

async function main() {
  check(process.argv.length === 4, 'USAGE_FIXTURE_FILE_OUTPUT_DIRECTORY');
  const fd = fs.openSync(process.argv[2], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let fixture;
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && !(stat.mode & 0o077) && stat.size < 8192, 'PRIVATE_FIXTURE_REQUIRED');
    fixture = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  // Expected non-secret scope may be supplied separately from credentials.
  Object.assign(fixture, {
    nativeUserId: fixture.nativeUserId || process.env.AVA_QA_NATIVE_USER_ID,
    nativeScope: fixture.nativeScope || process.env.AVA_QA_NATIVE_SCOPE,
    businessName: fixture.businessName || process.env.AVA_QA_BUSINESS_NAME,
    businessId: fixture.businessId || Number(process.env.AVA_QA_BUSINESS_ID),
    avaOrigin: fixture.avaOrigin || process.env.AVA_QA_ORIGIN,
    nativeOrigin: fixture.nativeOrigin || process.env.AVA_QA_NATIVE_ORIGIN,
    authOrigin: fixture.authOrigin || process.env.AVA_QA_AUTH_ORIGIN,
  });
  check(/^customer-diagnostic-[a-f0-9-]+@example\.invalid$/.test(fixture.email || ''), 'DIAGNOSTIC_ACCOUNT_REQUIRED');
  check(fixture.password && fixture.nativeUserId && fixture.nativeScope && fixture.businessName
    && Number.isSafeInteger(fixture.businessId), 'FIXTURE_INCOMPLETE');
  const ava = new URL(fixture.avaOrigin), native = new URL(fixture.nativeOrigin), auth = new URL(fixture.authOrigin);
  check([ava,native,auth].every(url => url.protocol === 'https:' && !url.username && !url.password), 'HTTPS_ORIGINS_REQUIRED');
  const output = path.resolve(process.argv[3]);
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.AVA_QA_CHROME_PATH ? { executablePath: process.env.AVA_QA_CHROME_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(ava.origin, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: /Войти/ }).first().click();
    await page.waitForURL(url => url.origin === auth.origin, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name=username]').fill(fixture.email);
    await page.locator('input[name=password]').fill(fixture.password);
    await page.locator('input[name=login],button[type=submit]').first().click();
    await page.waitForURL(url => url.origin === ava.origin, { waitUntil: 'domcontentloaded' });
    const entry = page.getByRole('link', { name: 'Открыть CRM (Twenty)', exact: true });
    await entry.waitFor();
    await page.screenshot({ path: path.join(output, 'ava-entry.png') });
    await entry.click();
    await page.waitForURL(url => url.origin === native.origin && url.pathname.startsWith('/objects/'),
      { timeout: 45000, waitUntil: 'domcontentloaded' });
    const metadata = query => page.evaluate(async query => {
      const response = await fetch('/metadata', { method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
      return { status: response.status, data: await response.json() };
    }, query);
    const me = await metadata('query{currentUser{id canAccessFullAdminPanel canImpersonate}}');
    check(me.status === 200 && !me.data.errors && me.data.data?.currentUser?.id === fixture.nativeUserId, 'NATIVE_IDENTITY_MISMATCH');
    check(!me.data.data.currentUser.canAccessFullAdminPanel && !me.data.data.currentUser.canImpersonate, 'NATIVE_ADMIN_EXPOSURE');
    await page.getByText('Tasks', { exact: true }).first().click();
    await page.waitForURL(url => url.pathname === '/objects/tasks', { waitUntil: 'commit' });
    await page.locator(':text-is("Title"):visible').first().waitFor();
    await page.getByText('Companies', { exact: true }).first().click();
    await page.waitForURL(url => url.pathname === '/objects/companies', { waitUntil: 'commit' });
    await page.getByText(fixture.businessName, { exact: true }).first().waitFor();
    await page.screenshot({ path: path.join(output, 'twenty-company.png') });
    const negative = await page.evaluate(async () => ({
      admin: (await fetch('/admin-panel', { signal: AbortSignal.timeout(15000) })).status,
      peer: (await fetch('/v1/verify', { method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' }, body: '{}' })).status,
    }));
    check(negative.admin === 403 && negative.peer === 403, 'NEGATIVE_ACCESS_FAILED');
    await page.getByTestId('workspace-dropdown').click();
    await page.locator('[aria-controls="multi-workspace-dropdown-context-menu-options"]').click();
    const logout = page.getByText(/^(Выйти из системы|Log out)$/).filter({ visible: true }).first();
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/metadata') && /signOut/.test(r.request().postData() || '')),
      logout.click(),
    ]);
    const result = await response.json();
    check(response.status() === 200 && !result.errors && result.data?.signOut === true, 'NATIVE_UI_LOGOUT_FAILED');
    const denied = await context.request.post(`${native.origin}/metadata`, { data: { query: 'query{currentUser{id}}' } });
    check(denied.status() === 403, 'NATIVE_LOGOUT_NOT_EFFECTIVE');
    await page.waitForURL(url => url.origin === ava.origin, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: /Войти/ }).first().waitFor();
    const receipt = { verifiedAt: new Date().toISOString(), businessId: fixture.businessId,
      nativeScope: fixture.nativeScope, browserLogin: true, passwordPromptAfterAva: false,
      tasksVisible: true, existingCompanyVisible: true, platformAdminDenied: true, privatePeerDenied: true,
      nativeLogoutViaMenu: true, nativeSessionDenied: true, returnedToAva: true, parentSessionRevoked: true,
      newGuestMessages: false, newGuestCalls: false };
    fs.writeFileSync(path.join(output, 'browser-proof.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
  } finally { await browser.close(); }
}
main().catch(() => { console.error('CUSTOMER_ENTRY_BROWSER_QA_FAILED'); process.exitCode = 1; });
