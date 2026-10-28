'use strict';
const {describe, it, assert, createTestDB} = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Flags = require('../src/services/ava-improvements-flags.service');
const Release = require('../src/services/ava-release-flags.service');
const express = require('express');
function setup() {
    createTestDB(); Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES(1,'One'),(2,'Two')");
    for (const [id, role, business] of [['owner','hotel_owner',1],['manager','manager',1],['observer','observer',1],['foreign','hotel_owner',2]]) {
        DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)', [id,id+'@test.example',id]);
        DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)',[id,business,role]);
    }
    return Object.fromEntries(['owner','manager','observer','foreign'].map(id => [id,Identity.actor(id)]));
}
async function allow(value, fn) {
    const previous = process.env.AVA_IMPROVEMENTS_BUSINESSES;
    if (value === undefined) delete process.env.AVA_IMPROVEMENTS_BUSINESSES; else process.env.AVA_IMPROVEMENTS_BUSINESSES = value;
    try { await fn(); } finally { if (previous === undefined) delete process.env.AVA_IMPROVEMENTS_BUSINESSES; else process.env.AVA_IMPROVEMENTS_BUSINESSES = previous; }
}
function denied(fn, code) { assert.throws(fn, error => error.code === code); }
describe('Additive improvement flags and customer access', () => {
    it('leaves improvements off by default while preserving existing workspace flags', () => allow(undefined, () => {
        const a = setup(); const view = Flags.overview(a.owner,1);
        assert.strictEqual(view.available,false); assert.ok(Object.values(view.flags).every(flag => flag === false));
        assert.strictEqual(Release.getFlags(1).workspace,true);
    }));
    it('rolls out only the allowlisted business and supports independent revisioned toggles', () => allow('1', () => {
        const a = setup(); assert.ok(Object.values(Flags.overview(a.owner,1).flags).every(Boolean));
        assert.strictEqual(Flags.overview(a.foreign,2).available,false);
        const changed = Flags.update(a.owner,1,{revision:0,flags:{copilot:false}});
        assert.strictEqual(changed.revision,1); assert.strictEqual(changed.flags.copilot,false); assert.strictEqual(changed.flags.collaboration,true);
        denied(() => Flags.update(a.owner,1,{revision:0,flags:{attention:false}}),'WORKSPACE_FEATURES_REVISION_CONFLICT');
    }));
    it('rejects unauthorized scope and manager/observer owner settings changes', () => allow('*', () => {
        const a = setup(); assert.ok(Flags.overview(a.manager,1).flags.queueFlow);
        assert.throws(() => Flags.overview(a.foreign,1));
        assert.throws(() => Flags.update(a.manager,1,{revision:0,flags:{copilot:false}}));
        assert.throws(() => Flags.update(a.observer,1,{revision:0,flags:{copilot:false}}));
    }));
    it('cannot turn improvements on outside deployment allowlist or disabled workspace', () => allow('1', () => {
        const a = setup(); denied(() => Flags.update(a.foreign,2,{revision:0,flags:{attention:true}}),'WORKSPACE_FEATURE_DISABLED');
        Release.update(a.owner,1,{revision:0,flags:{workspace:false}});
        assert.strictEqual(Flags.overview(a.owner,1).available,false);
        denied(() => Flags.assertEnabled(1,'collaboration'),'WORKSPACE_FEATURE_DISABLED');
    }));
    it('fails closed on malformed stored settings and rejects extra fields', () => allow('*', () => {
        const a = setup(); denied(() => Flags.update(a.owner,1,{revision:0,flags:{alien:true}}),'WORKSPACE_FEATURES_INPUT_INVALID');
        Flags.update(a.owner,1,{revision:0,flags:{copilot:false}});
        DB.run("UPDATE ava_improvement_flags SET flagsJson='null' WHERE businessId=1");
        denied(() => Flags.snapshot(1),'WORKSPACE_FEATURES_UNAVAILABLE');
    }));
    it('enforces actual mounted customer boundary, scope and origin', () => allow('*', async () => {
        const a = setup(), app = express(); app.use(express.json());
        app.use((req,_res,next) => { req.auth = a.owner; next(); });
        app.use('/api',require('../src/services/identity/customer-role-boundary'));
        app.use('/api',require('../src/routes/ava-improvements-flags.routes'));
        const server = await new Promise(resolve => { const s = app.listen(0,'127.0.0.1',()=>resolve(s)); });
        const origin = 'http://127.0.0.1:' + server.address().port;
        const previous = process.env.WHATSAPP_CRM_PUBLIC_URL; process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
        try {
            const path = origin+'/api/businesses/1/workspace/features';
            const read = await fetch(path); assert.strictEqual(read.status,200);
            const cross = await fetch(path,{method:'PATCH',headers:{Origin:'https://foreign.test','Content-Type':'application/json'},body:JSON.stringify({revision:0,flags:{copilot:false}})});
            assert.strictEqual(cross.status,403);
            const wrongScope = await fetch(path+'?businessId=2'); assert.strictEqual(wrongScope.status,403);
            const own = await fetch(path,{method:'PATCH',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({revision:0,flags:{copilot:false}})});
            assert.strictEqual(own.status,200); assert.strictEqual((await own.json()).flags.copilot,false);
        } finally {
            await new Promise(resolve => server.close(resolve));
            if (previous === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL; else process.env.WHATSAPP_CRM_PUBLIC_URL = previous;
        }
    }));
});
