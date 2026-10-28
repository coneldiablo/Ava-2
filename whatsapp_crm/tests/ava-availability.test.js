'use strict';
const assert = require('node:assert/strict');
const {it:test,createTestDB} = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Flags = require('../src/services/ava-improvements-flags.service');
const Store = require('../src/services/ava-autopilot.store');
const Availability = require('../src/services/ava-availability.service');
const Routes = require('../src/routes/ava-availability.routes');
const express = require('express');
const initialAllowlist = process.env.AVA_IMPROVEMENTS_BUSINESSES;

function setup() {
    if (DB.db?.open) DB.db.close();
    createTestDB();
    Identity.ensureSchema();
    DB.createSalesWorkspaceTables();
    DB.run("INSERT INTO instances(id,name,isActive) VALUES(1,'One',1),(2,'Two',1)");
    for (const [id, role, businessId] of [['owner','hotel_owner',1], ['lead','sales_lead',1],
        ['manager','manager',1], ['second','manager',1], ['observer','observer',1], ['other','hotel_owner',2]]) {
        DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)', [id,id+'@example.test',id]);
        DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [id,businessId,role]);
    }
    DB.run("INSERT INTO clients(instanceId,chatId,senderName,leadStatus,assigneeUserId) VALUES(1,'open','Client','new','manager'),(1,'null-status','Client',NULL,'manager'),(2,'foreign','Client','new','manager')");
    process.env.AVA_IMPROVEMENTS_BUSINESSES = '*';
    Availability.ensureSchema();
    return Object.fromEntries(['owner','lead','manager','second','observer','other'].map(id => [id,Identity.actor(id)]));
}
function published(extra = {}) {
    const policy = {id:'policy', revision:1, state:'published', enabled:true,
        timezone:'Europe/Moscow', workDays:[1,2,3,4,5,6,7], workHours:{start:'00:00',end:'00:00'},
        routing:{enabled:true,memberIds:['manager','second']}, ...extra};
    Store.savePolicy(1,policy,'owner',Store.policy(1)?.revision || 0);
    return policy;
}
function code(fn, expected) { assert.throws(fn,error => error.code === expected); }
function member(auth, id) { return Availability.list(auth,1).members.find(row => row.userId === id); }

test('availability reads active live team with configured defaults and tenant-scoped open load', () => {
    const auth = setup();
    for (const status of ['won','lost','junk','booked'])
        DB.run("INSERT INTO clients(instanceId,chatId,senderName,leadStatus,assigneeUserId) VALUES(1,?,'Client',?,?)",[status,status,'manager']);
    assert.deepEqual(member(auth.owner,'manager'), {userId:'manager',name:'manager',status:'available',capacity:null,
        currentLoad:2,revision:0,configured:false});
    assert.deepEqual(Availability.list(auth.observer,1).members.map(row => row.userId),['lead','manager','owner','second']);
    code(() => Availability.list(auth.other,1),'BUSINESS_ACCESS_DENIED');
    DB.run("UPDATE ava_users SET enabled=0 WHERE id='second'");
    assert.equal(member(auth.owner,'second'),undefined);
});

test('managers change own status only; owner and lead manage active team capacities', () => {
    const auth = setup();
    const changed = Availability.patch(auth.manager,1,'manager',{revision:0,status:'break'}).member;
    assert.equal(changed.revision,1);
    assert.equal(changed.configured,true);
    assert.equal(changed.currentLoad,2);
    code(() => Availability.patch(auth.manager,1,'second',{revision:0,status:'off'}),'CAPABILITY_DENIED');
    code(() => Availability.patch(auth.manager,1,'manager',{revision:1,capacity:null}),'CAPABILITY_DENIED');
    code(() => Availability.patch(auth.observer,1,'observer',{revision:0,status:'off'}),'CAPABILITY_DENIED');
    assert.equal(Availability.patch(auth.lead,1,'manager',{revision:1,capacity:3}).member.capacity,3);
    assert.equal(Availability.patch(auth.owner,1,'manager',{revision:2,status:'available',capacity:null}).member.capacity,null);
    for (const userId of ['other','observer','missing'])
        code(() => Availability.patch(auth.owner,1,userId,{revision:0,status:'off'}),'AVAILABILITY_MEMBER_NOT_FOUND');
    DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId='lead'");
    code(() => Availability.patch(auth.lead,1,'manager',{revision:3,status:'off'}),'CAPABILITY_DENIED');
    code(() => Availability.patch({...auth.owner,platformRole:'platform_admin'},1,'manager',{revision:3,status:'off'}),'BUSINESS_ACCESS_DENIED');
});

test('strict inputs and optimistic revisions prevent lost updates without changing saved state', () => {
    const auth = setup();
    for (const body of [null,[],{}, {revision:0}, {revision:'0',status:'off'}, {revision:0,status:'busy'},
        {revision:0,status:null}, {revision:0,capacity:0}, {revision:0,capacity:1.5},
        {revision:0,capacity:'2'}, {revision:0,capacity:Number.MAX_SAFE_INTEGER+1}, {revision:0,status:'off',userId:'manager'}])
        code(() => Availability.patch(auth.owner,1,'manager',body),'AVAILABILITY_INPUT_INVALID');
    Availability.patch(auth.manager,1,'manager',{revision:0,status:'break'});
    code(() => Availability.patch(auth.owner,1,'manager',{revision:0,status:'off'}),'AVAILABILITY_REVISION_CONFLICT');
    assert.equal(member(auth.owner,'manager').status,'break');
});

test('the same authenticated user has independent status, capacity, load and revisions in each business', () => {
    const auth = setup();
    DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('manager',2,'manager')");
    Availability.patch(auth.owner,1,'manager',{revision:0,status:'break',capacity:2});
    const second = Availability.patch(auth.manager,2,'manager',{revision:0,status:'off'}).member;
    assert.deepEqual(second,{userId:'manager',name:'manager',status:'off',capacity:null,currentLoad:1,revision:1,configured:true});
    assert.equal(member(auth.owner,'manager').status,'break');
    assert.equal(member(auth.owner,'manager').capacity,2);
    Availability.patch(auth.other,2,'manager',{revision:1,status:'available',capacity:5});
    assert.equal(Availability.list(auth.manager,2).members.find(row => row.userId==='manager').revision,2);
    assert.equal(member(auth.owner,'manager').revision,1);
});

test('configured routing filters status and capacity while unconfigured members preserve legacy behavior', () => {
    const auth = setup();
    published();
    Availability.patch(auth.owner,1,'manager',{revision:0,status:'available',capacity:2});
    let snapshot = Availability.routingSnapshot(1);
    assert.equal(snapshot.state,'available');
    assert.deepEqual(snapshot.eligibleMembers.map(row => row.userId),['second']);
    Availability.patch(auth.owner,1,'second',{revision:0,status:'off'});
    assert.equal(Availability.routingSnapshot(1).state,'no_available_members');
    Availability.patch(auth.owner,1,'manager',{revision:1,capacity:3});
    snapshot = Availability.routingSnapshot(1);
    assert.deepEqual(snapshot.eligibleMembers.map(row => [row.userId,row.currentLoad]),[['manager',2]]);
    Availability.patch(auth.manager,1,'manager',{revision:2,status:'break'});
    assert.equal(Availability.routingSnapshot(1).eligibleMembers.length,0);
    Flags.update(auth.owner,1,{revision:0,flags:{shifts:false}});
    snapshot = Availability.routingSnapshot(1);
    assert.equal(snapshot.enabled,false);
    assert.equal(snapshot.state,'disabled');
    assert.deepEqual(snapshot.eligibleMembers.map(row => row.userId),['manager','second']);
    code(() => Availability.list(auth.owner,1),'WORKSPACE_FEATURE_DISABLED');
});

test('published policy controls hours and draft, stale caller policy, routing-off stay disabled', () => {
    const auth = setup();
    const now = new Date('2026-10-05T16:00:00Z'); // Monday 19:00 Moscow.
    const policy = published({workDays:[1],workHours:{start:'09:00',end:'18:00'}});
    Availability.patch(auth.manager,1,'manager',{revision:0,status:'available'});
    let snapshot = Availability.routingSnapshot(1,{now});
    assert.equal(snapshot.withinHours,false);
    assert.equal(snapshot.state,'available'); // An unconfigured member still uses legacy routing.
    assert.deepEqual(snapshot.eligibleMembers.map(row => row.userId),['second']);
    Availability.patch(auth.second,1,'second',{revision:0,status:'available'});
    snapshot = Availability.routingSnapshot(1,{now,policy:{...policy,workHours:{start:'00:00',end:'00:00'}}});
    assert.equal(snapshot.state,'outside_hours');
    assert.equal(snapshot.eligibleMembers.length,0);
    assert.deepEqual(Availability.routingAvailability(1,{now}),{eligibleUserIds:[],configured:true,isWorkingTime:false});
    Store.savePolicy(1,{...policy,state:'draft',revision:2},'owner',1);
    assert.equal(Availability.routingAvailability(1,{now}).configured,false);
    Store.savePolicy(1,{...policy,routing:{enabled:false,memberIds:['manager']},revision:3},'owner',2);
    assert.equal(Availability.routingSnapshot(1,{now}).state,'disabled');
});

test('overnight hours belong to the start weekday and honor timezone and exclusive end', () => {
    const policy = {timezone:'Europe/Moscow',workDays:[1],workHours:{start:'22:00',end:'06:00'}};
    assert.equal(Availability.inHours(policy,new Date('2026-10-05T00:00:00Z')),false); // Monday 03:00, Sunday window.
    assert.equal(Availability.inHours(policy,new Date('2026-10-05T19:00:00Z')),true); // Monday 22:00.
    assert.equal(Availability.inHours(policy,new Date('2026-10-05T23:00:00Z')),true); // Tuesday 02:00, Monday window.
    assert.equal(Availability.inHours(policy,new Date('2026-10-06T03:00:00Z')),false); // Tuesday 06:00.
    assert.equal(Availability.inHours(policy,new Date('2026-10-06T20:00:00Z')),false); // Tuesday 23:00.
    const sunday = {...policy,workDays:[7]};
    assert.equal(Availability.inHours(sunday,new Date('2026-10-05T00:00:00Z')),true);
});

test('membership removal, observer conversion, new membership timestamp and user disable reset persisted states', () => {
    const auth = setup();
    for (const change of [
        "UPDATE ava_business_memberships SET enabled=0 WHERE userId='manager'",
        "UPDATE ava_business_memberships SET role='observer' WHERE userId='manager'",
        "UPDATE ava_business_memberships SET createdAt='2030-01-01 00:00:00' WHERE userId='manager'",
        "UPDATE ava_users SET enabled=0 WHERE id='manager'",
        "DELETE FROM ava_business_memberships WHERE userId='manager'",
    ]) {
        Availability.patch(auth.owner,1,'manager',{revision:0,status:'off',capacity:1});
        DB.run(change);
        assert.equal(DB.get("SELECT COUNT(*) AS n FROM ava_member_availability WHERE userId='manager'").n,0);
        DB.run("UPDATE ava_users SET enabled=1 WHERE id='manager'");
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('manager',1,'manager') ON CONFLICT(userId,businessId) DO UPDATE SET enabled=1,role='manager'");
        assert.equal(member(auth.owner,'manager').configured,false);
        assert.equal(member(auth.owner,'manager').revision,0);
    }
    published();
    DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='second'");
    assert.deepEqual(Availability.routingSnapshot(1).members.map(row => row.userId),['manager']);
});

test('feature deployment-off rejects API; missing flag module keeps internal legacy routing', () => {
    const auth = setup();
    published();
    delete process.env.AVA_IMPROVEMENTS_BUSINESSES;
    code(() => Availability.list(auth.owner,1),'WORKSPACE_FEATURE_DISABLED');
    assert.equal(Availability.routingSnapshot(1).state,'disabled');
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function(request, ...args) {
        if (request === './ava-improvements-flags.service')
            throw Object.assign(new Error("Cannot find module './ava-improvements-flags.service'"),{code:'MODULE_NOT_FOUND'});
        return original.call(this,request,...args);
    };
    try {
        assert.equal(Availability.routingSnapshot(1).state,'disabled');
        assert.deepEqual(Availability.routingSnapshot(1).eligibleMembers.map(row => row.userId),['manager','second']);
        code(() => Availability.list(auth.owner,1),'WORKSPACE_FEATURE_DISABLED');
    } finally { Module._load = original; }
});

test('actual HTTP checks origins, strict scope, current actor roles, revision conflicts and feature-off', async () => {
    const auth = setup();
    let actor = auth.manager;
    const app = express();
    app.use(express.json());
    app.use((req,_res,next) => {req.auth=actor;next();});
    app.use('/api',Routes);
    const server = await new Promise(resolve => {const listening=app.listen(0,'127.0.0.1',()=>resolve(listening));});
    const origin = 'http://127.0.0.1:'+server.address().port;
    const previous = process.env.WHATSAPP_CRM_PUBLIC_URL;
    process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
    const request = (method,path='/manager',body={revision:0,status:'break'},headers={Origin:origin}) => fetch(
        origin+'/api/businesses/1/workspace/availability'+path, {method,
            headers:{'Content-Type':'application/json',...headers},...(method==='GET'?{}:{body:JSON.stringify(body)})});
    try {
        assert.equal((await request('GET','')).status,200);
        for (const headers of [{},{Origin:'https://foreign.example'},{Origin:origin,'Sec-Fetch-Site':'cross-site'}])
            assert.equal((await request('PATCH','/manager',{revision:0,status:'break'},headers)).status,403);
        assert.equal((await request('PATCH','/manager',{revision:0,status:'break',businessId:2})).status,403);
        const patched = await request('PATCH');
        assert.equal(patched.status,200);
        assert.equal((await patched.json()).member.revision,1);
        assert.equal((await request('PATCH')).status,409);
        assert.equal((await request('PATCH','/manager',{revision:1,capacity:3})).status,403);
        actor = auth.lead;
        assert.equal((await request('PATCH','/manager',{revision:1,capacity:3})).status,200);
        actor = auth.observer;
        assert.equal((await request('GET','')).status,200);
        assert.equal((await request('PATCH','/manager',{revision:2,status:'off'})).status,403);
        actor = auth.other;
        assert.equal((await request('GET','')).status,403);
        actor = auth.manager;
        DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='manager'");
        assert.equal((await request('PATCH','/manager',{revision:2,status:'off'})).status,403);
        actor = auth.owner;
        Flags.update(auth.owner,1,{revision:0,flags:{shifts:false}});
        assert.equal((await request('GET','')).status,409);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previous === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
        else process.env.WHATSAPP_CRM_PUBLIC_URL = previous;
    }
});

test('availability status, capacity and revisions survive independent process restart', async () => {
    const auth = setup();
    Availability.patch(auth.owner,1,'manager',{revision:0,status:'break',capacity:4});
    const fs = require('node:fs'), os=require('node:os'), path=require('node:path');
    const {spawnSync} = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'ava-availability-'));
    const file = path.join(dir,'fixture.db');
    try {
        await DB.db.backup(file);
        const script = `const DB=require(${JSON.stringify(require.resolve('../src/services/database.service'))});
            DB.db=new(require(${JSON.stringify(require.resolve('better-sqlite3'))}))(${JSON.stringify(file)});
            DB.db.pragma('foreign_keys=ON');
            const Availability=require(${JSON.stringify(require.resolve('../src/services/ava-availability.service'))});
            const member=Availability.list({userId:'owner'},1).members.find(row=>row.userId==='manager');
            if(member.status!=='break'||member.capacity!==4||member.revision!==1||!member.configured)process.exit(2);
            DB.db.close();`;
        const result = spawnSync(process.execPath,['-e',script],{encoding:'utf8',timeout:15000});
        assert.equal(result.status,0,result.stderr);
    } finally {
        fs.rmSync(dir,{recursive:true,force:true});
        if (initialAllowlist === undefined) delete process.env.AVA_IMPROVEMENTS_BUSINESSES;
        else process.env.AVA_IMPROVEMENTS_BUSINESSES = initialAllowlist;
    }
});
