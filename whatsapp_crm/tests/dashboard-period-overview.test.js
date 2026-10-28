'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Store = require('../src/services/dashboard/overview.store');
const Facts = require('../src/services/dashboard/facts');
const SQLite = require('better-sqlite3');
const fs = require('fs'), os = require('os'), path = require('path');
const window = { kind: 'overnight', start: '2026-10-13T17:00:00Z', endExclusive: '2026-10-14T06:00:00Z' };
const report = { answerStatus: 'answered', summary: 'За ночь поступило обращение. Сегодня уточните детали.', generatedAt: 'saved-once' };
function fixture() { createTestDB(); DB.run("INSERT INTO instances(id,name,hotelTimezone) VALUES (1,'A','Europe/Moscow'),(2,'B','Europe/Moscow')"); }
describe('Dashboard durable completed-period reports', () => {
    it('includes the client request in event facts and excludes internal notes and drafts', () => {
        fixture();
        for (const [id,direction,content] of [['in','inbound','Хочу забронировать номер'],['internal','internal','PRIVATE_NOTE'],['draft','draft','UNSENT_DRAFT']]) {
            DB.run('INSERT INTO conversation_events(eventId,instanceId,channel,direction,role,content,createdAt) VALUES (?,?,?,?,?,?,?)',
                [id,1,'whatsapp',direction,'user',content,'2026-10-14T01:00:00Z']);
        }
        const facts=Facts.getFactPacket(1,{window:'overnight',now:new Date('2026-10-14T08:00:00Z'),completeOnly:true}).facts;
        assert.ok(facts.some(f=>f.summary.includes('Хочу забронировать номер')));
        assert.ok(!JSON.stringify(facts).includes('PRIVATE_NOTE'));
        assert.ok(!JSON.stringify(facts).includes('UNSENT_DRAFT'));
    });
    it('reports only completed business nights before dawn and after evening starts', () => {
        for (const [now, start, end] of [
            ['2026-10-14T02:00:00Z','2026-10-12T17:00:00.000Z','2026-10-13T06:00:00.000Z'],
            ['2026-10-14T06:00:00Z','2026-10-13T17:00:00.000Z','2026-10-14T06:00:00.000Z'],
            ['2026-10-14T19:32:48Z','2026-10-13T17:00:00.000Z','2026-10-14T06:00:00.000Z'],
        ]) {
            const result = Facts.windowFor('overnight', new Date(now), 'Europe/Moscow', true);
            assert.equal(result.start,start); assert.equal(result.endExclusive,end); assert.equal(result.complete,true);
        }
        const dst = Facts.windowFor('overnight',new Date('2026-10-25T10:00:00Z'),'Europe/Berlin',true);
        assert.equal((Date.parse(dst.endExclusive)-Date.parse(dst.start))/3600000,14);
    });
    it('shares concurrent generation, persists one success and isolates businesses and periods', async () => {
        fixture(); let calls=0;
        const produce=async()=>{ calls++; await new Promise(r=>setTimeout(r,10)); return report; };
        const results=await Promise.all(Array.from({length:8},()=>Store.once(1,window,produce)));
        assert.equal(calls,1); assert.ok(results.every(r=>r.generatedAt==='saved-once'));
        await Store.once(1,window,produce); assert.equal(calls,1);
        await Store.once(2,window,produce); assert.equal(calls,2);
        await Store.once(1,{...window,kind:'yesterday'},produce); assert.equal(calls,3);
        await Store.once(1,{...window,start:'2026-10-14T17:00:00Z',endExclusive:'2026-10-15T06:00:00Z'},produce); assert.equal(calls,4);
    });
    it('survives subscriber cancellation and retries a failed generation', async () => {
        fixture(); const abort=new AbortController(); let calls=0, release;
        const pending=Store.once(1,window,()=>{calls++;return new Promise(r=>{release=r;});},abort.signal);
        await new Promise(r=>setImmediate(r)); abort.abort();
        await assert.rejects(pending,e=>e.code==='DASHBOARD_MODEL_CANCELED');
        release(report);
        await Store.once(1,window,()=>{calls++;return report;}); assert.equal(calls,1);
        const another={...window,kind:'yesterday'};
        await assert.rejects(Store.once(1,another,async()=>{throw Error('temporary');}));
        assert.deepEqual(await Store.once(1,another,async()=>report),report);
    });
    it('uses a durable cross-connection lease and survives database reopen', async () => {
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ava-report-'));
        const file=path.join(dir,'reports.db');let a,b,c;
        try {
            a=new SQLite(file);a.exec("CREATE TABLE instances(id INTEGER PRIMARY KEY);INSERT INTO instances VALUES(1)");DB.db=a;
            let release,calls=0;
            const first=Store.once(1,window,()=>{calls++;return new Promise(r=>{release=r;});});
            await new Promise(r=>setImmediate(r));
            b=new SQLite(file);DB.db=b;
            const second=Store.once(1,window,async()=>{calls++;return report;});
            await new Promise(r=>setTimeout(r,20));release(report);
            assert.deepEqual(await first,report);assert.deepEqual(await second,report);assert.equal(calls,1);
            a.close();b.close();c=new SQLite(file);DB.db=c;
            assert.deepEqual(await Store.once(1,window,async()=>{throw Error('must not regenerate');}),report);
        } finally { for(const db of [a,b,c])if(db?.open)db.close();fs.rmSync(dir,{recursive:true,force:true}); }
    });
});
