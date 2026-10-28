'use strict';
// Runs only explicit synthetic acceptance tests against fresh in-memory databases.
// Docker caller supplies --network none; no live credentials/environment are passed.
const path = require('path'), fs = require('fs'), assert = require('assert'), { createRequire } = require('module');
const output = process.stdout.write.bind(process.stdout);
let transcript = '';
process.stdout.write = value => { if (transcript.length < 1048576) transcript += String(value); return true; };
for (const key of ['info', 'warn', 'error', 'debug']) console[key] = () => {};
const files = ['self-registration', 'keycloak-recovery', 'identity-protocol', 'owner-invitations',
    'team-identity-v2', 'identity-only-worker', 'registration-revocation-barrier', 'worker-startup-safety',
    'team-enrollment-proof', 'staff-native-enrollment-http', 'team-email-reconciliation',
    'team-invitation-delivery', 'system-mailer', 'team-enrollment-lease-recovery', 'team-invitation-session',
    'invitation-errors', 'assistant-draft', 'assistant-public-pages', 'assistant-ai-options',
    'assistant-draft-access', 'hotel-profile'];
(async () => {
    if (process.env.AVA_RELEASE_OFFLINE !== '1' || process.argv[2] !== 'smoke') throw Error('OFFLINE_REQUIRED');
    // These must never be inherited from a production runtime's Config.Env.
    for (const key of Object.keys(process.env)) {
        if (/SECRET|TOKEN|PASSWORD|SMTP|API_KEY|MASTER_KEY/.test(key)) delete process.env[key];
    }
    process.env.NODE_ENV = 'test';
    process.env.DB_PATH = '/tmp/ava-registration-synthetic.db';
    const appRoot = process.env.AVA_RELEASE_APP_ROOT || '/app';
    const appRequire = createRequire(path.join(appRoot, 'package.json'));
    const onboarding = fs.existsSync(path.join(appRoot, 'src/services/onboarding-state.service.js'));
    if (onboarding !== fs.existsSync(path.join(appRoot, 'tests/onboarding-state.test.js'))) throw Error('INCOMPLETE_ONBOARDING_CONTRACT');
    if (onboarding) files.push('onboarding-state');
    const helper = appRequire('./tests/test-helper');
    for (const name of files.sort()) appRequire('./tests/' + name + '.test.js');
    const ok = await helper.runAll();
    const count = Number(transcript.match(/Total: (\d+) \|/)?.[1] || 0);
    if (!ok || count < 40) throw Error('CONTRACT_FAILED_OR_EMPTY');
    let noRedirectRecoveryContractVerified = false;
    if (process.env.AVA_RELEASE_RECOVERY_NO_REDIRECT === '1') {
        process.env.AVA_PASSWORD_RECOVERY_NO_REDIRECT = 'true';
        process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        process.env.AVA_OIDC_ISSUER = 'https://identity.example.test/realms/ava';
        delete process.env.AVA_IDENTITY_ADMIN_ORIGIN;
        delete process.env.AVA_OIDC_CLIENT_ID;
        delete process.env.WHATSAPP_CRM_PUBLIC_URL;
        const {KeycloakAdmin} = appRequire('./src/services/identity/keycloak-admin');
        const target = {userId:'fixture-release',subject:'fixture-native',email:'fixture@example.test'};
        const native = {id:target.subject,username:'ava-'+target.userId,email:target.email,
            enabled:true,emailVerified:true,attributes:{avaUserId:[target.userId]}};
        const calls = [];
        const admin = new KeycloakAdmin({request: async req => {
            calls.push(req);
            if(req.url.endsWith('/token')) return {data:{access_token:'fixture',expires_in:300}};
            return {data:req.url.includes('/users?')?[native]:req.method==='GET'?native:null};
        }});
        let leaseChecks = 0;
        await admin.sendPasswordRecovery(target, () => {leaseChecks++;});
        const writes = calls.filter(req => req.method !== 'GET' && !req.url.endsWith('/token'));
        assert.strictEqual(writes.length,1);
        assert.strictEqual(writes[0].method,'PUT');
        assert.deepStrictEqual(writes[0].data,['UPDATE_PASSWORD']);
        const url = new URL(writes[0].url);
        assert.strictEqual(url.pathname,'/admin/realms/ava/users/fixture-native/execute-actions-email');
        assert.deepStrictEqual([...url.searchParams],[['lifespan','600']]);
        assert.ok(leaseChecks > 0);
        noRedirectRecoveryContractVerified = true;
    }
    output(JSON.stringify({ contractVerified: true, testCount: count, providers: 'synthetic',
        productionDatabaseUsed: false, liveMailSent: false, onboardingContractIncluded: onboarding,
        teamEnrollmentContractIncluded: true, assistantContractIncluded: true,
        noRedirectRecoveryContractVerified }) + '\n');
})().then(() => process.exit(0)).catch(() => {
    process.stderr.write('CONTRACT_SMOKE_FAILED\n'); process.exit(1);
});
