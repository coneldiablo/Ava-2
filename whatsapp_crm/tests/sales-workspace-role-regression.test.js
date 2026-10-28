'use strict';
const {describe, it, assert, createTestDB} = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Sales = require('../src/services/sales-workspace.service');
const routes = require('../src/routes/sales-workspace.routes');
const express = require('express');

function setup() {
    createTestDB(); Identity.ensureSchema(); DB.createSalesWorkspaceTables();
    DB.run("INSERT INTO instances(id,name) VALUES(1,'One'),(2,'Two')");
    for (const [id, role, business] of [['owner','hotel_owner',1], ['lead','sales_lead',1], ['one','manager',1], ['two','manager',1], ['read','observer',1], ['foreign','manager',2]]) {
        DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)', [id, id + '@example.test', 'Same name']);
        DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [id, business, role]);
    }
    DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,'assigned','Assigned','one'),(1,'queue','Queue',NULL),(2,'assigned','Foreign','foreign')");
    const own = DB.createManagerTask({instanceId:1, chatId:'assigned', summary:'Assigned work', assigneeUserId:'one'});
    const free = DB.createManagerTask({instanceId:1, chatId:'queue', summary:'Free work'});
    DB.createManagerTask({instanceId:2, chatId:'assigned', summary:'Foreign work', assigneeUserId:'foreign'});
    DB.createFollowupDraft({instanceId:1, chatId:'assigned', managerTaskId:own.taskId, text:'Draft'});
    DB.createFollowupDraft({instanceId:2, chatId:'assigned', text:'Foreign draft'});
    return {auth: Object.fromEntries(['owner','lead','one','two','read','foreign'].map(id => [id, Identity.actor(id)])), own, free};
}
const denied = (fn, code) => assert.throws(fn, error => error.code === code);

describe('Sales workspace observer overview and unchanged assignment authority', () => {
    it('defaults the observer to all tenant-readable clients/tasks without mutation capabilities', () => {
        const {auth, own, free} = setup(), result = Sales.workspace(auth.read, 1);
        assert.strictEqual(result.view, 'overview');
        assert.deepStrictEqual(result.clients.map(client => client.chatId).sort(), ['assigned','queue']);
        assert.deepStrictEqual(result.tasks.map(task => task.taskId).sort(), [own.taskId,free.taskId].sort());
        assert.strictEqual(result.summary.openTasks, 2);
        assert.strictEqual(result.summary.pendingFollowups, 1);
        assert.strictEqual(result.summary.unassignedClients, 1);
        assert.ok(!result.capabilities.includes('sales.assign'));
        assert.ok(!result.capabilities.includes('sales.write'));
        assert.strictEqual(Sales.workspace(auth.read, 1, {view:'mine'}).tasks.length, 0);
        assert.strictEqual(Sales.workspace(auth.read, 1, {view:'queue'}).tasks.length, 1);
        denied(() => Sales.workspace(auth.read, 1, {view:'team'}), 'SALES_TEAM_VIEW_DENIED');
        denied(() => Sales.workspace(auth.read, 2, {view:'overview'}), 'BUSINESS_ACCESS_DENIED');
        denied(() => Sales.claimTask(auth.read, 1, free.taskId), 'CAPABILITY_DENIED');
        denied(() => Sales.assignClient(auth.read, 1, 'queue', {assigneeUserId:'read'}), 'CAPABILITY_DENIED');
        denied(() => Sales.updateTask(auth.read, 1, own.taskId, {status:'done'}), 'CAPABILITY_DENIED');
        denied(() => Sales.createTask(auth.read, 1, {chatId:'queue', summary:'Forbidden'}), 'CAPABILITY_DENIED');
    });
    it('keeps manager mine default, atomic free claims and assigned-only mutations after an overview read', () => {
        const {auth, own, free} = setup();
        assert.strictEqual(Sales.workspace(auth.one, 1).view, 'mine');
        assert.strictEqual(Sales.workspace(auth.one, 1, {view:'overview'}).tasks.length, 2);
        Sales.claimTask(auth.two, 1, free.taskId);
        assert.strictEqual(Sales.claimTask(auth.two, 1, free.taskId).idempotent, true);
        denied(() => Sales.claimTask(auth.one, 1, free.taskId), 'SALES_TASK_ASSIGNED');
        denied(() => Sales.updateTask(auth.two, 1, own.taskId, {status:'done'}), 'SALES_TASK_SCOPE_DENIED');
        denied(() => Sales.updateTask(auth.one, 1, own.taskId, {assigneeUserId:'two'}), 'CAPABILITY_DENIED');
        Sales.updateTask(auth.two, 1, free.taskId, {status:'in_progress'});
        Sales.assignClient(auth.two, 1, 'queue', {assigneeUserId:'two'});
        denied(() => Sales.assignClient(auth.one, 1, 'queue', {assigneeUserId:'one'}), 'SALES_CLIENT_ASSIGNED');
        denied(() => Sales.authorizeClientMutation(auth.one, 1, 'queue'), 'SALES_CLIENT_SCOPE_DENIED');
        Sales.assignClient(auth.lead, 1, 'queue', {assigneeUserId:'one'});
        Sales.updateTask(auth.lead, 1, free.taskId, {assigneeUserId:'one'});
        Sales.authorizeClientMutation(auth.one, 1, 'queue');
        Sales.updateTask(auth.one, 1, free.taskId, {status:'done'});
        DB.run("UPDATE ava_business_memberships SET role='observer' WHERE businessId=1 AND userId='one'");
        assert.strictEqual(Sales.workspace(auth.one, 1).view, 'overview');
        denied(() => Sales.updateTask(auth.one, 1, own.taskId, {status:'done'}), 'CAPABILITY_DENIED');
    });
    it('serves populated observer overview over the real route and rejects direct HTTP mutations', async () => {
        const {auth, own, free} = setup(), app = express();
        app.use(express.json()); app.use((req, _res, next) => {req.auth = auth.read; next();}); app.use('/api', routes);
        const server = await new Promise(resolve => {const value = app.listen(0, '127.0.0.1', () => resolve(value));});
        const origin = 'http://127.0.0.1:' + server.address().port, previous = process.env.WHATSAPP_CRM_PUBLIC_URL;
        process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
        const url = origin + '/api/businesses/1/sales-workspace';
        const request = (method, path, body) => fetch(url + path, {method, headers:{Origin:origin, 'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
        try {
            const response = await request('GET', ''), view = await response.json();
            assert.strictEqual(response.status, 200); assert.strictEqual(view.view, 'overview');
            assert.strictEqual(view.clients.length, 2); assert.strictEqual(view.tasks.length, 2);
            for (const [method, path, body] of [['PATCH','/tasks/' + own.taskId,{status:'done'}], ['POST','/tasks/' + free.taskId + '/claim',{}], ['PUT','/clients/queue/assignee',{assigneeUserId:'one'}]]) {
                const deniedResponse = await request(method, path, body);
                assert.strictEqual(deniedResponse.status, 403); assert.strictEqual((await deniedResponse.json()).code, 'CAPABILITY_DENIED');
            }
            assert.strictEqual(DB.getManagerTask(1, own.taskId).status, 'new');
            assert.strictEqual(DB.getManagerTask(1, free.taskId).assigneeUserId, null);
        } finally {
            await new Promise(resolve => server.close(resolve));
            if (previous === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL; else process.env.WHATSAPP_CRM_PUBLIC_URL = previous;
        }
    });
});
