'use strict';
// Offline schema initializers only: no DB.init(), app, worker, cleanup or timers.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const quote=value=>'"'+value.replace(/"/g,'""')+'"';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const assert=(test,code)=>{if(!test)throw Error(code);};
function rows(db,name,columns,rowid){
    const selected=columns.filter(c=>c.hidden!==1).map(c=>quote(c.name));
    if(rowid)selected.unshift('_rowid_');
    const values=[];
    for(const row of db.prepare(`SELECT ${selected.join(',')} FROM ${quote(name)}`).raw().safeIntegers().iterate()){
        const digest=crypto.createHash('sha256');
        for(const v of row){const bytes=v===null?Buffer.alloc(0):Buffer.isBuffer(v)?v:Buffer.from(String(v));
            digest.update(`${v===null?'null':Buffer.isBuffer(v)?'blob':typeof v}:${bytes.length}:`);digest.update(bytes);digest.update(';');}
        values.push(digest.digest('hex'));
    }
    return{count:values.length,digest:hash(values.sort().join('\n'))};
}
function snapshot(db,projection){
    return db.transaction(()=>{
        const objects=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
        const tables={};
        for(const item of objects.filter(x=>x.type==='table')){
            const columns=db.prepare(`PRAGMA table_xinfo(${quote(item.name)})`).all();
            const previous=projection?.tables[item.name];
            const table=db.prepare('PRAGMA table_list').all().find(x=>x.schema==='main'&&x.name===item.name);
            const rowid=previous?previous.rowid:!table?.wr&&!columns.some(c=>c.name.toLowerCase()==='_rowid_')&&
                !(/^CREATE\s+VIRTUAL\s+TABLE/i.test(item.sql||'')&&columns.some(c=>c.name.toLowerCase()==='rowid'));
            tables[item.name]={columns,rowid,...rows(db,item.name,previous?.columns||columns,rowid)};
        }
        return{objects,tables,metadata:{userVersion:db.pragma('user_version',{simple:true}),
            applicationId:db.pragma('application_id',{simple:true}),encoding:db.pragma('encoding',{simple:true})}};
    })();
}
function compare(SQLite,before,after,contract){
    const exact=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    assert(exact(before.metadata,after.metadata),'MIGRATION_METADATA_CHANGED');
    const additions=[];
    for(const old of before.objects){
        const next=after.objects.find(x=>x.name===old.name);
        assert(next&&old.type===next.type&&old.tbl_name===next.tbl_name,'MIGRATION_OBJECT_REMOVED');
        const changes=(contract.columns[old.name]||[]).filter(c=>!before.tables[old.name].columns.some(x=>x.name===c.name));
        const replacement=contract.triggerReplacements.find(x=>x.name===old.name);
        if(replacement){assert(next.type==='trigger'&&next.tbl_name===replacement.table&&
            [replacement.baseSqlHash,replacement.sqlHash].includes(hash(old.sql||''))&&hash(next.sql||'')===replacement.sqlHash,
            'MIGRATION_TRIGGER_SCOPE_CHANGED');continue;}
        if(old.type==='table'&&changes.length){
            const model=new SQLite(':memory:');
            try {model.exec(old.sql);for(const c of changes)model.exec(`ALTER TABLE ${quote(old.name)} ADD COLUMN ${quote(c.name)} ${c.definition}`);
                const expected=model.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(old.name).sql;
                // SQLite retains the identifier quoting used in ALTER. The
                // production initializer uses bare reviewed identifiers.
                const alternate=new SQLite(':memory:');try{alternate.exec(old.sql);for(const c of changes)alternate.exec(`ALTER TABLE ${old.name} ADD COLUMN ${c.name} ${c.definition}`);
                    assert(next.sql===expected||next.sql===alternate.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(old.name).sql,'MIGRATION_TABLE_REWRITTEN');
                }finally{alternate.close();}
            }finally{model.close();}
        }else assert(next.sql===old.sql,'MIGRATION_EXISTING_DDL_CHANGED');
    }
    for(const item of after.objects.filter(x=>!before.objects.some(b=>b.name===x.name))){
        assert(['table','index'].includes(item.type)&&contract.newTables.includes(item.tbl_name),'MIGRATION_UNREVIEWED_SCHEMA');
        additions.push({name:item.name,type:item.type,tbl_name:item.tbl_name,sqlHash:hash(item.sql||'')});
    }
    for(const [name,old]of Object.entries(before.tables)){
        const next=after.tables[name];
        assert(next&&old.count===next.count&&old.digest===next.digest,'MIGRATION_EXISTING_ROWS_CHANGED');
        const changes=(contract.columns[name]||[]).filter(c=>!old.columns.some(x=>x.name===c.name));
        assert(exact(old.columns,next.columns.slice(0,old.columns.length))&&next.columns.length===old.columns.length+changes.length,'MIGRATION_EXISTING_COLUMNS_CHANGED');
        for(const [index,c]of changes.entries())assert(next.columns[old.columns.length+index].name===c.name,'MIGRATION_NEW_COLUMN_INVALID');
    }
    return additions;
}
function prohibitActivity(){
    const denied=()=>{throw Error('MIGRATION_NETWORK_OR_PROCESS_DENIED');};
    globalThis.fetch=denied;
    // Some imported singleton constructors install intervals. Return inert
    // handles; callbacks never execute, not even after the migration completes.
    globalThis.setInterval=()=>({unref(){return this;},ref(){return this;}});
    globalThis.setTimeout=()=>({unref(){return this;},ref(){return this;}});
    globalThis.clearInterval=()=>{};globalThis.clearTimeout=()=>{};
    require('node:net').Socket.prototype.connect=denied;require('node:net').Server.prototype.listen=denied;
    require('node:tls').connect=denied;
    for(const mod of ['node:http','node:https'])for(const method of ['request','get'])require(mod)[method]=denied;
    require('node:dgram').createSocket=denied;
    for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[method]=denied;
}
function rollbackBarriers(db){
    const table=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const exists=(name,condition)=>table(name)&&!!db.prepare(`SELECT 1 FROM ${quote(name)} WHERE ${condition} LIMIT 1`).get();
    return {
        existingAccountChallenge:exists('ava_self_registrations',"flow!='registration' AND state NOT IN ('completed','expired','superseded')"),
        registrationLease:exists('ava_invitations',"createdBy LIKE 'self-registration:%' AND leaseToken IS NOT NULL"),
        registrationEnrolling:exists('ava_self_registrations',"state='enrolling'"),
        unknownWhatsapp:exists('whatsapp_reply_jobs',"state IN ('sending','uncertain')"),
        unknownDocument:exists('whatsapp_document_deliveries',"status IN ('dispatching','unknown')"),
        unknownCampaign:exists('ava_campaign_commands',"state IN ('dispatching','unknown')"),
        unknownWorkspace:exists('ava_workspace_reply_actions',"status IN ('dispatching','unknown','sending')")
    };
}
async function run(mode,env=process.env){
    assert(env.AVA_RELEASE_OFFLINE==='1'&&['migrate','snapshot','barriers'].includes(mode),'MIGRATION_INPUT_INVALID');
    const appRoot=env.AVA_APP_ROOT||'/app',target=env.DB_PATH;
    assert(path.isAbsolute(target||'')&&fs.statSync(target).isFile()&&!fs.lstatSync(target).isSymbolicLink(),'MIGRATION_INPUT_INVALID');
    const appRequire=createRequire(path.join(appRoot,'package.json')),SQLite=appRequire('better-sqlite3');
    const db=new SQLite(target,{readonly:mode!=='migrate',fileMustExist:true});
    appRequire('sqlite-vec').load(db);db.pragma('busy_timeout=10000');db.pragma('foreign_keys=ON');
    // The online-backup copy is standalone DELETE mode. Exercise the same WAL
    // writer/sidecar path as production, using the database owner's UID.
    if(mode==='migrate')assert(db.pragma('journal_mode=WAL',{simple:true})==='wal','MIGRATION_WAL_REQUIRED');
    try {
        if(mode==='barriers')return{ok:true,mode,barriers:rollbackBarriers(db)};
        const before=snapshot(db);
        if(mode==='snapshot')return{ok:true,mode,snapshot:before};
        const contract=JSON.parse(fs.readFileSync(env.AVA_SCHEMA_CONTRACT||path.join(__dirname,'schema-contract.json'),'utf8'));
        const DB=appRequire('./src/services/database.service');DB.db=db;
        let after,additions;
        db.transaction(()=>{
            if(!db.prepare('PRAGMA table_info(instances)').all().some(c=>c.name==='voiceAmbient'))db.exec('ALTER TABLE instances ADD COLUMN voiceAmbient TEXT');
            for(const [name,method,args]of contract.initializers){
                assert(/^[a-z][a-z0-9/-]*(?:\.(?:service|store))?$/.test(name)&&!name.includes('..'),'MIGRATION_MODULE_INVALID');
                const module=appRequire('./src/services/'+name);assert(typeof module[method]==='function','MIGRATION_INITIALIZER_MISSING');
                module[method](args);
            }
            assert(db.pragma('integrity_check',{simple:true})==='ok'&&!db.pragma('foreign_key_check').length,'MIGRATION_INTEGRITY_FAILED');
            after=snapshot(db,before);additions=compare(SQLite,before,after,contract);
            for(const [name,columns]of Object.entries(contract.columns))for(const c of columns){
                if(before.tables[name].columns.some(old=>old.name===c.name))continue;
                assert(!db.prepare(`SELECT 1 FROM ${quote(name)} WHERE ${quote(c.name)} IS NOT ? LIMIT 1`).get(c.defaultValue),'MIGRATION_UNEXPECTED_BACKFILL');
            }
        }).immediate();
        return{ok:true,mode,existingRowsPreserved:true,existingColumnsPreserved:true,
            beforeDigest:hash(JSON.stringify(before)),newObjects:additions,
            afterSchema:after.objects.map(x=>({name:x.name,type:x.type,tbl_name:x.tbl_name,sqlHash:hash(x.sql||'')})),
            afterSnapshot:snapshot(db)};
    }finally{db.close();}
}
if(require.main===module){
    const output=process.stdout.write.bind(process.stdout);
    process.stdout.write=()=>true;process.stderr.write=()=>true;
    for(const method of ['log','info','warn','error','debug'])console[method]=()=>{};
    prohibitActivity();
    run(process.argv[2]).then(value=>output(JSON.stringify(value)+'\n',()=>process.exit(0)),error=>output(JSON.stringify({ok:false,
        code:/^MIGRATION_[A-Z_]+$/.test(error.message||'')?error.message:'MIGRATION_FAILED'})+'\n',()=>process.exit(1)));
}
module.exports={rows,snapshot,compare,prohibitActivity,rollbackBarriers,run};
