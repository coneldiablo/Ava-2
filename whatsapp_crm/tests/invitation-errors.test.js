const { describe, it, assert, createTestDB } = require('./test-helper');
const { invitationFailure } = require('../src/services/identity/invitation-errors');

describe('Safe invitation failure diagnostics', () => {
    it('distinguishes invalid links, pending revocations, password policy and outages', () => {
        for (const [code, status] of [['INVITATION_INVALID',400], ['PASSWORD_POLICY',400],
            ['PREVIOUS_ACCESS_REVOCATION_PENDING',409], ['INVITATION_IN_PROGRESS',409], ['TEAM_ENROLLMENT_RECONCILIATION_REQUIRED',409],
            ['IDENTITY_ORIGIN_REQUIRED',403], ['IDENTITY_PROVIDER_UNAVAILABLE',503]]) {
            const result = invitationFailure({ response:{data:{error:code}} }, 'correlation-test');
            assert.strictEqual(result.status, status);
            assert.strictEqual(result.body.success, false);
            assert.strictEqual(result.body.request_id, 'correlation-test');
        }
    });
    it('never reflects unknown error bodies, credentials or exception messages', () => {
        const secret = 'Bearer secret-password-token';
        for (const error of [undefined, new Error(secret), {code:secret}, {response:{data:{error:secret}}},
            {response:{data:{error:'toString'}}}, {response:{data:{error:'__proto__'}}},
            {response:{data:{error:{toString:null}}}}]) {
            const result = invitationFailure(error, 'request-id');
            assert.strictEqual(result.status, 503);
            assert.ok(!JSON.stringify(result).includes(secret));
            assert.strictEqual(result.body.error_code, 'IDENTITY_ENROLLMENT_UNAVAILABLE');
        }
    });
    it('returns safe broker diagnostics through the public HTTP route without changing the token', async () => {
        createTestDB();
        const Identity=require('../src/services/identity/identity-store');
        const DB=require('../src/services/database.service');
        for (const [prefix,email] of [['a','a@example.test'],['b','b@example.test']]) {
            const invitation=Identity.createInvitation({platformRole:'platform_admin',userId:'operator'},{email});
            DB.run('UPDATE ava_invitations SET tokenHash=? WHERE id=?',[Identity.hash(prefix.repeat(43)),invitation.invitationId]);
        }
        const express = require('express');
        const axios = require('axios');
        const Logger = require('../src/utils/logger');
        const oldPost = axios.post, oldWarn = Logger.warn;
        const keys = ['AVA_CUSTOMER_ACCESS_ENABLED','WHATSAPP_CRM_PUBLIC_URL','AVA_IDENTITY_BROKER_TOKEN'];
        const previous = Object.fromEntries(keys.map(key => [key,process.env[key]]));
        Object.assign(process.env,{AVA_CUSTOMER_ACCESS_ENABLED:'true',WHATSAPP_CRM_PUBLIC_URL:'https://wh.example.test',AVA_IDENTITY_BROKER_TOKEN:'fixture-broker'});
        const seen = [], logs = [];
        Logger.warn = message => logs.push(message);
        axios.post = async (url, body) => {
            seen.push({url, token:body.token});
            throw {response:{data:{error:body.token.startsWith('a')?'INVITATION_INVALID':'PREVIOUS_ACCESS_REVOCATION_PENDING'}}};
        };
        const app = express(); app.use(express.json()); app.use('/api',require('../src/routes/identity.routes'));
        const server = await new Promise(resolve => {const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
        try {
            for (const [token,status,code] of [['a'.repeat(43),400,'INVITATION_INVALID'],['b'.repeat(43),409,'PREVIOUS_ACCESS_REVOCATION_PENDING']]) {
                const response = await fetch(`http://127.0.0.1:${server.address().port}/api/invitations/redeem`,{
                    method:'POST',headers:{'Content-Type':'application/json',Origin:'https://wh.example.test'},
                    body:JSON.stringify({token,password:'fixture-password-please-do-not-log'}),
                });
                const data=await response.json();
                assert.strictEqual(response.status,status); assert.strictEqual(data.error_code,code);
                assert.strictEqual(response.headers.get('cache-control'),'no-store');
                assert.match(data.request_id,/^[a-f0-9-]{36}$/);
                assert.strictEqual(seen.at(-1).token,token);
                assert.ok(!JSON.stringify(logs).includes(token));
                assert.ok(!JSON.stringify(logs).includes('fixture-password'));
            }
        } finally {
            server.closeAllConnections?.(); await new Promise(resolve=>server.close(resolve));
            axios.post=oldPost;Logger.warn=oldWarn;
            for(const key of keys) if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
        }
    });
});
