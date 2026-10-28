'use strict';
const {describe,it,assert}=require('./test-helper');
const {fork}=require('child_process');
const fs=require('fs'),os=require('os'),path=require('path');
const Sqlite=require('better-sqlite3');

describe('Canonical origin migration across independent processes',()=>{
    it('waits for a reserved writer before inspecting and upgrading the schema',async()=>{
        const folder=fs.mkdtempSync(path.join(os.tmpdir(),'ava-origin-race-'));
        const file=path.join(folder,'test.db'), script=path.join(folder,'probe.cjs');
        const db=new Sqlite(file);
        db.pragma('journal_mode=WAL');
        db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY,instanceId INTEGER,chatId TEXT,channel TEXT,sourceMessageId TEXT);
            INSERT INTO messages VALUES(1,1,'guest','whatsapp','provider-1');`);
        db.close();
        const databasePath=path.resolve(__dirname,'../src/services/database.service.js');
        fs.writeFileSync(script,`const Sqlite=require(${JSON.stringify(require.resolve('better-sqlite3'))});
            const db=new Sqlite(process.argv[2]);db.pragma('busy_timeout=5000');
            if(process.argv[3]==='writer'){
                db.exec('BEGIN IMMEDIATE'); process.send({ready:true});
                setTimeout(()=>{db.exec('COMMIT');db.close();process.exit(0)},300);
            }else{
                const DB=require(${JSON.stringify(databasePath)});DB.db=db;
                try{DB.ensureMessageOriginSchema();process.send({ok:db.prepare('SELECT originChatId FROM messages').get().originChatId==='guest'});db.close();}
                catch(error){process.send({ok:false,code:error.code});db.close();process.exitCode=1;}
            }`);
        const children=[];
        function launch(mode){const child=fork(script,[file,mode],{stdio:['ignore','ignore','ignore','ipc']});children.push(child);return child;}
        function outcome(child){return new Promise((resolve,reject)=>{
            let result;const timer=setTimeout(()=>reject(new Error('process race timed out')),7000);
            child.on('message',message=>{result=message;});
            child.once('error',error=>{clearTimeout(timer);reject(error);});
            child.once('exit',code=>{clearTimeout(timer);resolve({code,result});});
        });}
        try{
            const writer=launch('writer'), writerResult=outcome(writer);
            await new Promise((resolve,reject)=>{writer.once('message',resolve);writer.once('error',reject);});
            const reader=await outcome(launch('reader'));
            assert.strictEqual(reader.code,0,JSON.stringify(reader.result));
            assert.deepStrictEqual(reader.result,{ok:true});
            assert.strictEqual((await writerResult).code,0);
            const persisted=new Sqlite(file);
            assert.throws(()=>persisted.prepare(`INSERT INTO messages(instanceId,chatId,originChatId,channel,sourceMessageId) VALUES(1,'guest','guest','whatsapp','provider-1')`).run(),/UNIQUE/);
            persisted.close();
        }finally{for(const child of children)if(child.exitCode===null)child.kill();fs.rmSync(folder,{recursive:true,force:true});}
    });
});
