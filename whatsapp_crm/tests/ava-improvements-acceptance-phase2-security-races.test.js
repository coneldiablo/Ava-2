'use strict';

// Opt in before loading services: ordinary legacy test runs do not require the
// phase-two modules or pay the real presence-lease waiting time.
if (process.env.AVA_ACCEPTANCE_PHASE2 !== '1') return;

const { describe, it, assert, createTestDB } = require('./test-helper');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const Sqlite = require('better-sqlite3');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Canonical = require('../src/services/client-identity.service');
const Workspace = require('../src/services/ava-workspace.service');
const Control = require('../src/services/ava-workspace.store');
const Collaboration = require('../src/services/ava-collaboration.service');
const Availability = require('../src/services/ava-availability.service');
const Autopilot = require('../src/services/ava-autopilot.service');
const Policy = require('../src/services/ava-autopilot.store');
const Flags = require('../src/services/ava-improvements-flags.service');
const Green = require('../src/services/green-api.service');

const CHAT = '79990001101@c.us';
const ALIAS = 'tg_99112233';
const owner = { userId: 'phase2-owner' };
const manager = { userId: 'phase2-manager' };
const peer = { userId: 'phase2-peer' };

function connect(file) {
    DB.db = new Sqlite(file);
    DB.db.pragma('foreign_keys=ON');
    DB.db.pragma('busy_timeout=10000');
}

async function ingest(job) {
    const businessId = job.businessId || 1;
    const chatId = job.chatId || CHAT;
    if (job.kind === 'message') {
        const saved = await DB.saveMessageWithChannel(businessId, chatId, 'Synthetic client',
            'Synthetic incoming context', 'user', 'whatsapp', null, job.eventId);
        return { id: saved.id };
    }
    const event = DB.createConversationEvent({ instanceId: businessId, chatId,
        eventId: job.eventId, callId: job.eventId + '-call', channel: 'voice',
        content: 'Synthetic call summary', direction: 'inbound' });
    if (job.transcript) Control.recordCallTranscript({ businessId, chatId,
        sourceId: event.eventId, text: 'user: Synthetic call update', timestamp: new Date().toISOString() });
    return { eventId: event.eventId };
}

// Each subprocess loads the real application services against its own SQLite
// connection. Only Green API provider state and provider send are replaced.
async function childMain(job) {
    connect(job.file);
    function command(type) {
        return new Promise(resolve => {
            const listener = message => {
                if (message?.type === type) { process.off('message', listener); resolve(); }
            };
            process.on('message', listener);
        });
    }
    Green.getStateInstance = async () => {
        if (job.holdPreparation) {
            const permit = command('releasePreparation');
            process.send({ type: 'preparing' });
            await permit;
        }
        return { success: true, data: { stateInstance: 'authorized' } };
    };
    Green.sendMessage = async () => {
        if (job.holdTransport) {
            const permit = command('releaseTransport');
            process.send({ type: 'dispatch' });
            await permit;
        } else process.send({ type: 'dispatch' });
        return { success: true, data: job.partialAck ? {} : { idMessage: 'phase2-provider-ack' } };
    };
    const start = command('run');
    process.send({ type: 'ready' });
    await start;
    let result;
    try {
        switch (job.operation) {
            case 'reply': result = await Workspace.reply({ userId: job.userId || owner.userId },
                1, job.chatId || CHAT, { text: 'Synthetic manager answer',
                    idempotencyKey: job.key, ...(job.expected ? { expectedDialogueRevision: job.expected } : {}) }); break;
            case 'route': result = { assignee: Autopilot.routeCustomer(1, job.chatId, Policy.policy(1)) }; break;
            case 'patch': result = Availability.patch(owner, 1, manager.userId, job.body); break;
            case 'ingest': result = await ingest(job); break;
            case 'presence': result = Collaboration.presence(owner, 1, CHAT); break;
            case 'unknownProbe': {
                const retry = await Workspace.reply(owner, 1, job.chatId,
                    { text: 'Synthetic manager answer', idempotencyKey: job.key });
                const route = Autopilot.routeCustomer(1, job.chatId, Policy.policy(1));
                let resendCode;
                try { await Workspace.reply(owner, 1, job.chatId,
                    { text: 'Another answer', idempotencyKey: job.key + '-different' }); }
                catch (error) { resendCode = error.code; }
                result = { retryStatus: retry.status, route, resendCode,
                    control: Control.getControl(1, job.chatId) };
                break;
            }
            default: throw new Error('Unknown acceptance child operation');
        }
        result = { type: 'result', ok: true, result };
    } catch (error) { result = { type: 'result', ok: false, code: error.code, statusCode: error.statusCode, detail: error.message }; }
    DB.db.close();
    process.send(result, () => process.exit(0));
}

if (process.env.AVA_PHASE2_SECURITY_CHILD === '1') {
    childMain(JSON.parse(process.argv[2])).catch(error => {
        process.send({ type: 'result', ok: false, detail: error.stack }, () => process.exit(1));
    });
    return;
}

function launch(fixture, job) {
    const child = fork(__filename, [JSON.stringify({ ...job, file: fixture.file })], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, AVA_PHASE2_SECURITY_CHILD: '1' },
    });
    fixture.children.push(child);
    const messages = [];
    const waiters = [];
    let diagnostic = '', exited = false;
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-3000); });
    child.on('message', message => {
        const index = waiters.findIndex(item => item.types.includes(message.type));
        if (index < 0) messages.push(message);
        else { const item = waiters.splice(index, 1)[0]; clearTimeout(item.timer); item.resolve(message); }
    });
    const closed = new Promise(resolve => child.once('exit', code => {
        exited = true;
        for (const item of waiters.splice(0)) { clearTimeout(item.timer); item.reject(new Error('Child exited ' + code + ': ' + diagnostic)); }
        resolve(code);
    }));
    child.once('error', error => {
        for (const item of waiters.splice(0)) { clearTimeout(item.timer); item.reject(error); }
    });
    return {
        child, closed,
        send(type) { child.send({ type }); },
        next(...types) {
            const index = messages.findIndex(message => types.includes(message.type));
            if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
            if (exited) return Promise.reject(new Error('Child exited before ' + types.join('/') + ': ' + diagnostic));
            return new Promise((resolve, reject) => {
                const item = { types, resolve, reject };
                item.timer = setTimeout(() => {
                    const index = waiters.indexOf(item); if (index >= 0) waiters.splice(index, 1);
                    reject(new Error('Child IPC timeout for ' + types.join('/') + ': ' + diagnostic));
                }, 15000);
                waiters.push(item);
            });
        },
    };
}

async function childResult(fixture, job) {
    const worker = launch(fixture, job);
    await worker.next('ready');
    worker.send('run');
    const result = await worker.next('result');
    assert.strictEqual(await worker.closed, 0, JSON.stringify(result));
    return result;
}

async function fixture(run) {
    const previousDB = DB.db, previousAllowlist = process.env.AVA_IMPROVEMENTS_BUSINESSES;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-phase2-independent-'));
    const context = { file: path.join(directory, 'fixture.sqlite'), children: [] };
    let seed;
    try {
        seed = createTestDB();
        await seed.backup(context.file);
        seed.close();
        connect(context.file);
        DB.db.pragma('journal_mode=WAL');
        process.env.AVA_IMPROVEMENTS_BUSINESSES = '1,2';
        Identity.ensureSchema();
        DB.run("INSERT INTO instances(id,name,isActive,whatsappProvider,greenApiInstance,greenApiToken) VALUES(1,'Synthetic One',1,'green_api','fixture','fixture'),(2,'Synthetic Two',1,'green_api','foreign-fixture','foreign-fixture')");
        for (const [id, role, businessId] of [[owner.userId,'hotel_owner',1],
            [manager.userId,'manager',1],[peer.userId,'manager',1],['phase2-observer','observer',1],['phase2-foreign','hotel_owner',2]]) {
            DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)', [id, id + '@example.test', 'Same synthetic name']);
            DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [id,businessId,role]);
        }
        DB.createSalesWorkspaceTables();
        DB.run("INSERT INTO clients(instanceId,chatId,senderName,leadStatus,assigneeUserId) VALUES(1,?,'Synthetic client','new',?),(1,'peer-client','Synthetic peer','new',?),(2,?,'Synthetic foreign','new','phase2-foreign')", [CHAT,manager.userId,peer.userId,CHAT]);
        for (const chat of ['queue-a','queue-b','queue-c']) DB.run("INSERT INTO clients(instanceId,chatId,senderName,leadStatus) VALUES(1,?,'Synthetic queue','new')", [chat]);
        Canonical.attach(1, CHAT, { kind: 'telegram', value: '99112233' });
        Control.ensureSchema();
        Policy.ensureSchema();
        Collaboration.ensureSchema();
        Availability.ensureSchema();
        Flags.ensureSchema();
        // Initialise existing control before measuring a context revision.
        for (const chat of [CHAT,'peer-client','queue-a','queue-b','queue-c']) Control.getControl(1,chat);
        Policy.savePolicy(1, { revision:1, enabled:true, state:'published', activated:true,
            timezone:'Europe/Moscow', workDays:[1,2,3,4,5,6,7], workHours:{start:'00:00',end:'00:00'},
            routing:{enabled:true,memberIds:[manager.userId,peer.userId]} }, owner.userId, 0);
        Availability.patch(owner,1,manager.userId,{revision:0,status:'available',capacity:2});
        Availability.patch(owner,1,peer.userId,{revision:0,status:'off',capacity:1});
        await run(context);
    } finally {
        const active = context.children.filter(child => child.exitCode === null && child.signalCode === null);
        await Promise.all(active.map(child => new Promise(resolve => { child.once('exit',resolve); child.kill('SIGKILL'); })));
        if (DB.db && DB.db !== previousDB && DB.db.open) DB.db.close();
        if (seed?.open) seed.close();
        DB.db = previousDB;
        if (previousAllowlist === undefined) delete process.env.AVA_IMPROVEMENTS_BUSINESSES;
        else process.env.AVA_IMPROVEMENTS_BUSINESSES = previousAllowlist;
        fs.rmSync(directory,{recursive:true,force:true});
    }
}

function acceptance(name, run) { it('phase2 security: ' + name, () => fixture(run)); }
function requireOk(outcome) { assert.strictEqual(outcome.ok,true,JSON.stringify(outcome)); return outcome.result; }
function revision() { return Workspace.clientWorkspace(manager,1,CHAT).dialogueRevision; }

describe('AVA improvements independent phase-two security and process races', () => {
    acceptance('separate humans and keys sharing a canonical client produce one provider dispatch', async f => {
        const workers = [launch(f,{operation:'reply',userId:manager.userId,key:'browser-manager',holdTransport:true}),
            launch(f,{operation:'reply',userId:owner.userId,chatId:ALIAS,key:'browser-owner',holdTransport:true})];
        await Promise.all(workers.map(worker => worker.next('ready')));
        workers.forEach(worker => worker.send('run'));
        const first = await Promise.all(workers.map(worker => worker.next('dispatch','result')));
        assert.strictEqual(first.filter(message => message.type==='dispatch').length,1,JSON.stringify(first));
        const loser = first.find(message => message.type==='result');
        assert.strictEqual(loser.ok,false);
        assert.strictEqual(loser.code,'WORKSPACE_SEND_IN_PROGRESS');
        const winner = workers[first.findIndex(message => message.type==='dispatch')];
        winner.send('releaseTransport');
        assert.strictEqual(requireOk(await winner.next('result')).status,'sent');
        await Promise.all(workers.map(worker => worker.closed));
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_workspace_reply_actions').n,1);
        assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM messages WHERE role='assistant'").n,1);
        assert.strictEqual(DB.get('SELECT chatId FROM ava_workspace_reply_actions').chatId,CHAT);
        assert.ok([owner.userId,manager.userId].includes(DB.get('SELECT userId FROM ava_workspace_message_authorship').userId));
    });

    acceptance('processes spend the final capacity slot once and availability revisions prevent lost updates', async f => {
        const workers = ['queue-a','queue-b'].map(chatId => launch(f,{operation:'route',chatId}));
        await Promise.all(workers.map(worker => worker.next('ready')));
        workers.forEach(worker => worker.send('run'));
        const routed = await Promise.all(workers.map(async worker => requireOk(await worker.next('result')).assignee));
        await Promise.all(workers.map(worker => worker.closed));
        assert.deepStrictEqual(routed.sort(),[null,manager.userId].sort());
        assert.strictEqual(Availability.list(owner,1).members.find(row=>row.userId===manager.userId).currentLoad,2);
        const changes = ['break','off'].map(status => launch(f,{operation:'patch',body:{revision:1,status}}));
        await Promise.all(changes.map(worker => worker.next('ready')));
        changes.forEach(worker => worker.send('run'));
        const changed = await Promise.all(changes.map(worker => worker.next('result')));
        await Promise.all(changes.map(worker => worker.closed));
        assert.strictEqual(changed.filter(result=>result.ok).length,1,JSON.stringify(changed));
        assert.strictEqual(changed.find(result=>!result.ok).code,'AVAILABILITY_REVISION_CONFLICT');
        assert.strictEqual(Availability.list(owner,1).members.find(row=>row.userId===manager.userId).revision,2);
        const pending = DB.get("SELECT chatId FROM clients WHERE instanceId=1 AND chatId IN ('queue-a','queue-b') AND assigneeUserId IS NULL").chatId;
        assert.strictEqual(requireOk(await childResult(f,{operation:'route',chatId:pending})).assignee,null);
        const stable = DB.get('SELECT assigneeUserId FROM clients WHERE instanceId=1 AND chatId=?',[CHAT]).assigneeUserId;
        assert.strictEqual(requireOk(await childResult(f,{operation:'route',chatId:CHAT})).assignee,stable);
    });

    acceptance('a concurrent break update and new assignment serialize, and no subsequent client spends the slot', async f => {
        const router=launch(f,{operation:'route',chatId:'queue-a'});
        const editor=launch(f,{operation:'patch',body:{revision:1,status:'break'}});
        await Promise.all([router.next('ready'),editor.next('ready')]);
        router.send('run'); editor.send('run');
        const [routed,changed]=await Promise.all([router.next('result'),editor.next('result')]);
        const assignee=requireOk(routed).assignee;
        assert.ok(assignee===null || assignee===manager.userId,JSON.stringify(routed));
        assert.strictEqual(requireOk(changed).member.status,'break');
        await Promise.all([router.closed,editor.closed]);
        const live=Availability.list(owner,1).members.find(row=>row.userId===manager.userId);
        assert.strictEqual(live.status,'break');
        assert.strictEqual(live.revision,2);
        assert.strictEqual(live.currentLoad,assignee===manager.userId?2:1);
        assert.strictEqual(requireOk(await childResult(f,{operation:'route',chatId:'queue-b'})).assignee,null);
        assert.strictEqual(requireOk(await childResult(f,{operation:'route',chatId:'queue-c'})).assignee,null);
    });

    for (const kind of ['message','call']) {
        acceptance(kind + ' ingestion respects tenant/client scope and invalidates a stale prepared reply', async f => {
            const expected = revision();
            requireOk(await childResult(f,{operation:'ingest',kind,businessId:2,eventId:kind+'-foreign'}));
            assert.strictEqual(revision(),expected);
            requireOk(await childResult(f,{operation:'ingest',kind,chatId:'peer-client',eventId:kind+'-peer'}));
            assert.strictEqual(revision(),expected);
            requireOk(await childResult(f,{operation:'ingest',kind,chatId:ALIAS,eventId:kind+'-canonical',transcript:kind==='call'}));
            assert.ok(BigInt(revision())>BigInt(expected));
            const beforeControl = Control.getControl(1,CHAT);
            const stale = await childResult(f,{operation:'reply',key:'stale-'+kind,expected,userId:manager.userId});
            assert.strictEqual(stale.ok,false);
            assert.strictEqual(stale.code,'WORKSPACE_DIALOGUE_CHANGED');
            assert.strictEqual(stale.statusCode,409);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_workspace_reply_actions').n,0);
            assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM messages WHERE role='assistant'").n,0);
            assert.deepStrictEqual(Control.getControl(1,CHAT),beforeControl);
        });

        for (const businessId of [1,2]) acceptance(kind + ' during provider preparation: ' + (businessId===1?'same dialogue blocks':'foreign tenant remains isolated'), async f => {
            const worker = launch(f,{operation:'reply',key:'awaited-'+kind,expected:revision(),holdPreparation:true,userId:manager.userId});
            await worker.next('ready'); worker.send('run'); await worker.next('preparing');
            requireOk(await childResult(f,{operation:'ingest',kind,businessId,eventId:kind+'-during-'+businessId}));
            worker.send('releasePreparation');
            const outcome = await worker.next('result');
            assert.strictEqual(await worker.closed,0);
            if (businessId===1) {
                assert.strictEqual(outcome.ok,false,JSON.stringify(outcome));
                assert.strictEqual(outcome.code,'WORKSPACE_DIALOGUE_CHANGED');
                assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM messages WHERE role='assistant'").n,0);
                assert.strictEqual(DB.get('SELECT status FROM ava_workspace_reply_actions').status,'failed');
                assert.strictEqual(Control.getControl(1,CHAT).sendInProgress,undefined);
            } else {
                assert.strictEqual(requireOk(outcome).status,'sent');
                assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM messages WHERE role='assistant' AND instanceId=1").n,1);
                assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM messages WHERE role='assistant' AND instanceId=2").n,0);
            }
        });
    }

    acceptance('live membership revocation hides leases immediately and actual 45-second TTL expires after restart', async f => {
        const startedAt = Date.now();
        Collaboration.heartbeat(manager,1,ALIAS,{sessionId:'manager-tab',typing:true});
        const live = Collaboration.heartbeat(owner,1,CHAT,{sessionId:'owner-tab',typing:false});
        assert.deepStrictEqual(live.participants.map(row=>row.userId),[manager.userId,owner.userId].sort());
        const expiry = Date.parse(live.participants.find(row=>row.userId===owner.userId).expiresAt);
        assert.ok(expiry>=startedAt+45000 && expiry<=Date.now()+45000);
        DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE businessId=1 AND userId=?",[manager.userId]);
        const afterRevocation = requireOk(await childResult(f,{operation:'presence'}));
        assert.deepStrictEqual(afterRevocation.participants.map(row=>row.userId),[owner.userId]);
        assert.throws(()=>Collaboration.heartbeat(manager,1,CHAT,{sessionId:'revoked',typing:false}),error=>error.code==='BUSINESS_ACCESS_DENIED');
        assert.throws(()=>Collaboration.presence({userId:'phase2-foreign'},1,CHAT),error=>error.code==='BUSINESS_ACCESS_DENIED');
        // No clock monkeypatch or row timestamp rewrite: wait for the genuine
        // exported contract lease, then read through a fresh OS process.
        await new Promise(resolve=>setTimeout(resolve,Math.max(1,expiry-Date.now()+25)));
        assert.deepStrictEqual(requireOk(await childResult(f,{operation:'presence'})).participants,[]);
    });

    for (const offMode of ['deployment','business']) acceptance(offMode + ' off retains legacy payload/reply and legacy routing despite configured unavailable members', async f => {
        Availability.patch(owner,1,manager.userId,{revision:1,status:'break',capacity:1});
        if(offMode==='deployment')process.env.AVA_IMPROVEMENTS_BUSINESSES='';
        else Flags.update(owner,1,{revision:0,flags:Object.fromEntries(Flags.FEATURES.map(key=>[key,false]))});
        assert.ok(Object.values(Flags.snapshot(1).flags).every(value=>value===false));
        assert.strictEqual(Workspace.clientWorkspace(manager,1,CHAT).dialogueRevision,undefined);
        assert.throws(()=>Collaboration.presence(owner,1,CHAT),error=>error.code==='WORKSPACE_FEATURE_DISABLED');
        assert.throws(()=>Availability.list(owner,1),error=>error.code==='WORKSPACE_FEATURE_DISABLED');
        const result=requireOk(await childResult(f,{operation:'reply',userId:manager.userId,key:'legacy-without-revision'}));
        assert.strictEqual(result.status,'sent');
        assert.strictEqual(result.dialogueRevision,undefined);
        assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM messages WHERE role='assistant'").n,1);
        assert.strictEqual(requireOk(await childResult(f,{operation:'route',chatId:'queue-a'})).assignee,manager.userId);
    });

    acceptance('partial provider ACK persists unknown across restart and prevents routing unassigned or inactive-assignee clients', async f => {
        // Keep an eligible alternate member so a missing unknown-send fence
        // would actually assign/reassign rather than pass for lack of capacity.
        Availability.patch(owner,1,peer.userId,{revision:1,status:'available',capacity:10});
        for (const [chatId,key] of [['queue-a','unknown-unassigned'],[CHAT,'unknown-removed-assignee']]) {
            assert.strictEqual(requireOk(await childResult(f,{operation:'reply',chatId,key,partialAck:true})).status,'unknown');
            if (chatId===CHAT) DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE businessId=1 AND userId=?",[manager.userId]);
            const original=DB.get('SELECT assigneeUserId FROM clients WHERE instanceId=1 AND chatId=?',[chatId]).assigneeUserId;
            const probe=requireOk(await childResult(f,{operation:'unknownProbe',chatId,key}));
            assert.strictEqual(probe.retryStatus,'unknown');
            assert.strictEqual(probe.route,null);
            assert.strictEqual(probe.resendCode,'WORKSPACE_SEND_IN_PROGRESS');
            assert.strictEqual(probe.control.sendStatus,'unknown');
            assert.strictEqual(DB.get('SELECT assigneeUserId FROM clients WHERE instanceId=1 AND chatId=?',[chatId]).assigneeUserId,original);
        }
        assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM messages WHERE role='assistant'").n,0);
        assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM ava_workspace_reply_actions WHERE status='unknown'").n,2);
    });
});
