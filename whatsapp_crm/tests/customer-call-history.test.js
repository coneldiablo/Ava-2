const { describe, it, assert, createTestDB } = require('./test-helper');
const axios = require('axios');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const config = require('../src/config');
const app = require('../src/app').app;

function fixture() {
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Own hotel'),(2,'Foreign hotel')");
    const invitation = Identity.createInvitation({ platformRole: 'platform_admin' },
        { email: 'calls@example.test', businessId: 1, role: 'manager' });
    const member = Identity.completeInvitation(Identity.claimInvitation(invitation.token), 'calls-subject');
    return Identity.createSession(member.subject, 'calls-native-session');
}

describe('Customer call history bridge', () => {
    it('scopes analytics to the member business and emits only aggregate fields', async () => {
        const token = fixture();
        const oldEnabled = Auth.config.enabled;
        const oldCustomer = process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        const oldUrl = config.avaAdmin.apiUrl;
        const oldToken = config.avaAdmin.serviceToken;
        const oldGet = axios.get;
        Auth.config.enabled = true;
        process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
        config.avaAdmin.apiUrl = 'http://ava.internal';
        config.avaAdmin.serviceToken = 'unit-service-token';
        let requests = 0;
        axios.get = async (url, options) => {
            requests++;
            assert.strictEqual(url, 'http://ava.internal/api/internal/calls/business/1/stats');
            assert.deepStrictEqual(options.params, { days: 30 });
            assert.strictEqual(options.headers.Authorization, 'Bearer unit-service-token');
            return { data: { business_id: 1, period_days: 30, generated_at: '2026-09-23T00:00:00Z',
                total_calls: 2, avg_duration_seconds: 15, total_duration_seconds: 30,
                outcomes: { completed: 2 }, providers: { sip: 2 }, directions: { inbound: 1, outbound: 1 },
                calls_per_day: [{ date: '2026-09-22', count: 2 }],
                caller_number: '+79990000000', outbound_opener: 'secret prompt',
                error_message: 'secret diagnostic', active_calls: 100 } };
        };
        const server = await new Promise(resolve => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        try {
            const base = `http://127.0.0.1:${server.address().port}`;
            const headers = { Cookie: `crm_session=ava2:${token}` };
            const denied = await fetch(`${base}/api/calls/stats/2?days=30`, { headers });
            assert.strictEqual(denied.status, 403);
            assert.strictEqual(requests, 0);
            const invalid = await fetch(`${base}/api/calls/stats/1?days=31`, { headers });
            assert.strictEqual(invalid.status, 400);
            const allowed = await fetch(`${base}/api/calls/stats/1?days=30`, { headers });
            assert.strictEqual(allowed.status, 200);
            const result = await allowed.json();
            assert.strictEqual(result.business_id, 1);
            assert.strictEqual(result.period_days, 30);
            assert.strictEqual(result.stats.total_calls, 2);
            assert.deepStrictEqual(result.stats.directions, { inbound: 1, outbound: 1 });
            assert(!JSON.stringify(result).includes('secret'));
            assert(!JSON.stringify(result).includes('+79990000000'));
            assert.strictEqual(Object.hasOwn(result, 'active_calls'), false);
            assert.strictEqual(requests, 1);
            axios.get = async () => ({ data: { business_id: 2, period_days: 30, total_calls: 999 } });
            const mismatch = await fetch(`${base}/api/calls/stats/1?days=30`, { headers });
            assert.strictEqual(mismatch.status, 503);
            assert.strictEqual((await mismatch.json()).stats, undefined);
            axios.get = async () => {
                DB.run('UPDATE ava_business_memberships SET enabled=0 WHERE businessId=1');
                return { data: { business_id: 1, period_days: 30, total_calls: 2 } };
            };
            const revokedDuringRead = await fetch(`${base}/api/calls/stats/1?days=30`, { headers });
            assert.strictEqual(revokedDuringRead.status, 403);
            assert.strictEqual((await revokedDuringRead.json()).stats, undefined);
        } finally {
            await new Promise(resolve => server.close(resolve));
            axios.get = oldGet;
            config.avaAdmin.apiUrl = oldUrl;
            config.avaAdmin.serviceToken = oldToken;
            Auth.config.enabled = oldEnabled;
            if (oldCustomer === undefined) delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;
            else process.env.AVA_CUSTOMER_ACCESS_ENABLED = oldCustomer;
        }
    });

    it('reads only the authenticated business and returns summary fields without diagnostics', async () => {
        const token = fixture();
        const oldEnabled = Auth.config.enabled;
        const oldCustomer = process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        const oldUrl = config.avaAdmin.apiUrl;
        const oldToken = config.avaAdmin.serviceToken;
        const oldGet = axios.get;
        Auth.config.enabled = true;
        process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
        config.avaAdmin.apiUrl = 'http://ava.internal';
        config.avaAdmin.serviceToken = 'unit-service-token';
        let requests = 0;
        axios.get = async (url, options) => {
            requests++;
            assert.strictEqual(url, 'http://ava.internal/api/internal/calls/business/1');
            assert.strictEqual(options.params.page, 1);
            assert.strictEqual(options.headers.Authorization, 'Bearer unit-service-token');
            return { data: { calls: [{ id: 'record-1', call_id: 'call-1', business_id: 1,
                caller_number: '+79990000000', caller_name: 'Клиент', direction: 'inbound', outcome: 'abandoned',
                error_message: 'secret diagnostic', outbound_opener: 'private prompt' }],
                total: 1, total_pages: 1 } };
        };
        const server = await new Promise(resolve => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        try {
            const base = `http://127.0.0.1:${server.address().port}`;
            const headers = { Cookie: `crm_session=ava2:${token}` };
            const denied = await fetch(`${base}/api/calls/2`, { headers });
            assert.strictEqual(denied.status, 403);
            assert.strictEqual(requests, 0);
            const allowed = await fetch(`${base}/api/calls/1`, { headers });
            assert.strictEqual(allowed.status, 200);
            const result = await allowed.json();
            assert.strictEqual(result.business_id, 1);
            assert.strictEqual(result.calls[0].caller_number, '+79990000000');
            assert.strictEqual(result.calls[0].caller_name, 'Клиент');
            assert.strictEqual(result.calls[0].outcome, 'abandoned');
            assert.strictEqual(Object.hasOwn(result.calls[0], 'error_message'), false);
            assert.strictEqual(Object.hasOwn(result.calls[0], 'outbound_opener'), false);
            assert.strictEqual(requests, 1);
        } finally {
            await new Promise(resolve => server.close(resolve));
            axios.get = oldGet;
            config.avaAdmin.apiUrl = oldUrl;
            config.avaAdmin.serviceToken = oldToken;
            Auth.config.enabled = oldEnabled;
            if (oldCustomer === undefined) delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;
            else process.env.AVA_CUSTOMER_ACCESS_ENABLED = oldCustomer;
        }
    });

    it('fails closed if the upstream includes another business', async () => {
        const token = fixture();
        const oldEnabled = Auth.config.enabled;
        const oldCustomer = process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        const oldUrl = config.avaAdmin.apiUrl;
        const oldToken = config.avaAdmin.serviceToken;
        const oldGet = axios.get;
        Auth.config.enabled = true;
        process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
        config.avaAdmin.apiUrl = 'http://ava.internal';
        config.avaAdmin.serviceToken = 'unit-service-token';
        axios.get = async () => ({ data: { calls: [{ id: 'foreign', call_id: 'foreign', business_id: 2 }], total: 1 } });
        const server = await new Promise(resolve => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        try {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/calls/1`,
                { headers: { Cookie: `crm_session=ava2:${token}` } });
            assert.strictEqual(response.status, 503);
            assert.strictEqual((await response.json()).calls, undefined);
        } finally {
            await new Promise(resolve => server.close(resolve));
            axios.get = oldGet;
            config.avaAdmin.apiUrl = oldUrl;
            config.avaAdmin.serviceToken = oldToken;
            Auth.config.enabled = oldEnabled;
            if (oldCustomer === undefined) delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;
            else process.env.AVA_CUSTOMER_ACCESS_ENABLED = oldCustomer;
        }
    });
});
describe('Tenant recording playback bridge',()=>{
    it('checks tenant, fresh membership and WAV, and never exposes upstream paths or tokens',async()=>{
        const token=fixture(),oldEnabled=Auth.config.enabled,oldCustomer=process.env.AVA_CUSTOMER_ACCESS_ENABLED,
            oldUrl=config.avaAdmin.apiUrl,oldToken=config.avaAdmin.serviceToken,oldGet=axios.get;
        Auth.config.enabled=true;process.env.AVA_CUSTOMER_ACCESS_ENABLED='true';
        config.avaAdmin.apiUrl='http://ava.internal';config.avaAdmin.serviceToken='unit-service-token';
        let requests=0,scenario='ready';
        const bytes=Buffer.alloc(64);bytes.write('RIFF',0);bytes.write('WAVE',8);
        axios.get=async(url,options)=>{
            requests++;assert.strictEqual(options.maxRedirects,0);assert.strictEqual(options.headers.Authorization,'Bearer unit-service-token');
            assert.ok(url.startsWith('http://ava.internal/api/internal/calls/business/1/record-1/recording'));
            if(url.endsWith('.wav')) {
                if(scenario==='revoke') DB.run('UPDATE ava_business_memberships SET enabled=0 WHERE businessId=1');
                return {data:scenario==='invalid'?Buffer.from('not a wav'):bytes};
            }
            return {data:{business_id:scenario==='foreign'?2:1,has_recording:scenario!=='missing',filename:scenario==='path'?'/mnt/secret.wav':'ava-1-123.45.wav',file_path:'/mnt/private',url:'http://private'}};
        };
        const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
        const base=`http://127.0.0.1:${server.address().port}`,headers={Cookie:`crm_session=ava2:${token}`};
        try {
            assert.strictEqual((await fetch(base+'/api/calls/2/record-1/recording',{headers})).status,403);assert.strictEqual(requests,0);
            let response=await fetch(base+'/api/calls/1/record-1/recording',{headers});assert.strictEqual(response.status,200);
            const metadata=await response.json();assert.strictEqual(metadata.has_recording,true);assert(!JSON.stringify(metadata).includes('/mnt/'));
            response=await fetch(base+'/api/calls/1/record-1/recording.wav',{headers});assert.strictEqual(response.status,200);
            assert.strictEqual(response.headers.get('content-type'),'audio/wav');assert.strictEqual((await response.arrayBuffer()).byteLength,64);
            for(const [mode,status] of [['foreign',503],['missing',404],['path',404],['invalid',503],['revoke',403]]) {
                scenario=mode;response=await fetch(base+'/api/calls/1/record-1/recording.wav',{headers});assert.strictEqual(response.status,status,mode);
                const output=await response.text();assert(!output.includes('unit-service-token'));assert(!output.includes('/mnt/'));
            }
        } finally {
            await new Promise(resolve=>server.close(resolve));axios.get=oldGet;config.avaAdmin.apiUrl=oldUrl;config.avaAdmin.serviceToken=oldToken;Auth.config.enabled=oldEnabled;
            if(oldCustomer===undefined)delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;else process.env.AVA_CUSTOMER_ACCESS_ENABLED=oldCustomer;
        }
    });
});
