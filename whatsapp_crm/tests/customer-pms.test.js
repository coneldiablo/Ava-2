'use strict';

const http = require('http');
const { describe, it:registerTest, assert, createTestDB } = require('./test-helper');
let setup=()=>{},cleanup=()=>{};
const beforeEach=fn=>{setup=fn;},afterEach=fn=>{cleanup=fn;};
const it=(name,fn)=>registerTest(name,async()=>{try{await setup();await fn();}finally{await cleanup();}});
const DB = require('../src/services/database.service');
const App = require('../src/app');
const AuthService = require('../src/services/auth.service');
const Identity = require('../src/services/identity/identity-store');
const PmsService = require('../src/services/pms/pms.service');
const Store = require('../src/services/pms/pms-store.service');

process.env.PMS_CREDENTIALS_MASTER_KEY = '22'.repeat(32);
process.env.SESSION_SECRET = 'test-session-secret-for-pms-integration-tests';

function doRequest(server, path, { body, method = 'GET', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? '' : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1',
            port: server.address().port,
            path,
            method,
            headers: {
                Origin:`http://127.0.0.1:${server.address().port}`,
                ...(body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
                ...headers,
            },
        }, res => {
            let text = '';
            res.on('data', part => text += part);
            res.on('end', () => {
                let json;
                try { json = JSON.parse(text); } catch (_) { json = null; }
                resolve({ status: res.statusCode, headers: res.headers, json, text });
            });
        });
        req.on('error', reject);
        req.end(data);
    });
}

describe('Customer PMS / Bnovo routes', () => {
    let server;

    beforeEach(async () => {
        if(DB.db?.open)DB.db.close();
        createTestDB();
        AuthService.config.enabled=true;process.env.AVA_CUSTOMER_ACCESS_ENABLED='true';
        Identity.ensureSchema();
        server = http.createServer(App.app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    });

    afterEach(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        if(DB.db?.open)DB.db.close();
    });

    it('allows hotel owner to configure, test, sync, and read Bnovo integration', async () => {
        const business = await DB.createInstance({ name: 'Bnovo Pilot Hotel', businessType: 'hotel', salesGoal: 'call' });
        const user={id:'owner'};
        DB.run("INSERT INTO ava_users(id,subject,email,displayName) VALUES('owner','owner','owner@example.test','Owner')");
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('owner',?,'hotel_owner')",[business.id]);
        const token=Identity.createSession(user.id,'owner-session');
        const headers={Cookie:`crm_session=ava2:${token}`};

        // 1. Initial read - not configured
        const resInit = await doRequest(server, `/api/businesses/${business.id}/pms`, { headers });
        assert.strictEqual(resInit.status, 200);
        assert.strictEqual(resInit.json.success, true);
        assert.strictEqual(resInit.json.pms, null);

        // 2. Configure Bnovo
        const resConfig = await doRequest(server, `/api/businesses/${business.id}/pms`, {
            method: 'PUT',
            headers,
            body: {
                account_id: 998877,
                api_password: 'test-api-secret',
                currency: 'RUB',
                enabled: true,
            },
        });
        assert.strictEqual(resConfig.status, 200);
        assert.strictEqual(resConfig.json.success, true);
        assert.strictEqual(resConfig.json.pms.business_id, business.id);
        assert.strictEqual(resConfig.json.pms.masked_account, '••••8877');
        assert.strictEqual(resConfig.json.pms.credentials_configured, true);

        // 3. Test Bnovo connection (mock provider)
        const row = Store.getIntegration(business.id);
        const originalProvider = PmsService._provider;
        PmsService._provider = () => ({
            row,
            client: {
                testConnection: async () => ({ id: 998877, name: 'Bnovo Test Hotel' }),
                listRoomTypes: async () => [{ id: 101, hotel_id: 'hotel-bnovo-1', name: 'Люкс с видом на море' }],
                listTariffs: async () => [{ id: 501, name: 'Тариф Стандартный' }],
            },
        });

        try {
            const resTest = await doRequest(server, `/api/businesses/${business.id}/pms/test`, {
                method: 'POST',
                headers,
            });
            assert.strictEqual(resTest.status, 200);
            assert.strictEqual(resTest.json.success, true);
            assert.strictEqual(resTest.json.pms.external_hotel_id, 'hotel-bnovo-1');
            assert.deepStrictEqual(resTest.json.pms.mappings.available_room_types, [{ id: '101', name: 'Люкс с видом на море' }]);
        } finally {
            PmsService._provider = originalProvider;
        }

        // 4. Initial Sync queue
        const resSync = await doRequest(server, `/api/businesses/${business.id}/pms/sync`, {
            method: 'POST',
            headers,
        });
        assert.strictEqual(resSync.status, 200);
        assert.strictEqual(resSync.json.success, true);
        assert.ok(resSync.json.queued > 0);

        // 5. Read bookings list
        const resBookings = await doRequest(server, `/api/businesses/${business.id}/pms/bookings`, { headers });
        assert.strictEqual(resBookings.status, 200);
        assert.strictEqual(resBookings.json.success, true);
        assert.ok(Array.isArray(resBookings.json.bookings));

        // 6. Test hotel-profiles alias route
        const resAlias = await doRequest(server, `/api/hotel-profiles/${business.id}/pms`, { headers });
        assert.strictEqual(resAlias.status, 200);
        assert.strictEqual(resAlias.json.success, true);
        assert.strictEqual(resAlias.json.pms.masked_account, '••••8877');

        // 7. Check channel status includes bnovo
        const resChannel = await doRequest(server, `/api/channels/${business.id}/status`, { headers });
        assert.strictEqual(resChannel.status, 200);
        assert.strictEqual(resChannel.json.success, true);
        assert.strictEqual(resChannel.json.channels.bnovoConfigured, true);

        // 8. Disconnect Bnovo
        const resDisconnect = await doRequest(server, `/api/businesses/${business.id}/pms`, {
            method: 'DELETE',
            headers,
        });
        assert.strictEqual(resDisconnect.status, 200);
        assert.strictEqual(resDisconnect.json.success, true);
        assert.strictEqual(resDisconnect.json.deleted, true);

        // 9. Read after disconnect
        const resAfter = await doRequest(server, `/api/businesses/${business.id}/pms`, { headers });
        assert.strictEqual(resAfter.status, 200);
        assert.strictEqual(resAfter.json.pms, null);
    });

    it('denies access to PMS endpoints for non-member user', async () => {
        const business = await DB.createInstance({ name: 'Private Hotel', businessType: 'hotel', salesGoal: 'call' });
        DB.run("INSERT INTO ava_users(id,subject,email,displayName) VALUES('stranger','stranger','stranger@example.test','Stranger')");
        const token=Identity.createSession('stranger','stranger-session');
        const headers={Cookie:`crm_session=ava2:${token}`};

        const resGet = await doRequest(server, `/api/businesses/${business.id}/pms`, { headers });
        assert.strictEqual(resGet.status, 403);

        const resPut = await doRequest(server, `/api/businesses/${business.id}/pms`, {
            method: 'PUT',
            headers,
            body: { account_id: 111, api_password: 'pass' },
        });
        assert.strictEqual(resPut.status, 403);
    });
    it('blocks cross-origin changes, restricts booking access and hides provider secrets', async () => {
        const business = await DB.createInstance({name:'Private hotel'});
        for(const [id,role] of [['owner','hotel_owner'],['manager','manager']]) {
            DB.run('INSERT INTO ava_users(id,subject,email,displayName) VALUES(?,?,?,?)',[id,id,id+'@example.test',id]);
            DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)',[id,business.id,role]);
        }
        const headers={Cookie:`crm_session=ava2:${Identity.createSession('owner','owner-session')}`};
        const manager={Cookie:`crm_session=ava2:${Identity.createSession('manager','manager-session')}`};
        const path=`/api/businesses/${business.id}/pms`;
        const body={account_id:12345,api_password:'private-synthetic-secret'};
        assert.equal((await doRequest(server,path,{method:'PUT',headers:{...headers,Origin:'https://foreign.test'},body})).status,403);
        assert.equal((await doRequest(server,path,{method:'PUT',headers:{...headers,Origin:''},body})).status,403);
        assert.equal((await doRequest(server,path,{method:'PUT',headers:manager,body})).status,403);
        assert.equal((await doRequest(server,path,{method:'PUT',headers,body})).status,200);
        assert.equal((await doRequest(server,path+'/bookings',{headers:manager})).status,403);
        const old=PmsService.test;
        try {
            PmsService.test=async()=>{throw Object.assign(new Error('Bearer private-synthetic-secret https://provider.test/?password=secret'),{code:'BNOVO_PROVIDER_FAILED',statusCode:502});};
            const failure=await doRequest(server,path+'/test',{method:'POST',headers});
            assert.equal(failure.status,502);assert(!failure.text.includes('private-synthetic-secret'));assert(!failure.text.includes('provider.test'));
        } finally {PmsService.test=old;}
        const state=await doRequest(server,path,{headers});assert(!state.text.includes('private-synthetic-secret'));assert(!state.text.includes('diagnostics'));
    });
    it('fences a revoked owner before writing provider test results', async () => {
        const business = await DB.createInstance({name:'Guarded hotel'});
        DB.run("INSERT INTO ava_users(id,subject,email,displayName) VALUES('owner','owner','owner@example.test','Owner')");
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('owner',?,'hotel_owner')",[business.id]);
        const headers={Cookie:`crm_session=ava2:${Identity.createSession('owner','owner-session')}`};
        const path=`/api/businesses/${business.id}/pms`;
        await doRequest(server,path,{method:'PUT',headers,body:{account_id:12345,api_password:'private-synthetic-secret',external_hotel_id:'hotel-one'}});
        const old=PmsService._provider;
        try {
            PmsService._provider=()=>({row:Store.getIntegration(business.id),client:{
                testConnection:async()=>{DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='owner'");return {};},
                listRoomTypes:async()=>[{id:1,hotel_id:'hotel-one',name:'Room'}],listTariffs:async()=>[]}});
            assert.equal((await doRequest(server,path+'/test',{method:'POST',headers})).status,403);
            assert.equal(Store.getIntegration(business.id).connectionStatus,'not_tested');
        } finally {PmsService._provider=old;}
    });

});
