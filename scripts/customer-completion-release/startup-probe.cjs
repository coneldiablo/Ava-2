'use strict';
const {createRequire}=require('node:module');
const path=require('node:path');
const requireApp=createRequire(path.join(process.env.AVA_APP_ROOT||'/app','package.json'));
function startupProbe(){
    const assert=require('node:assert/strict'),fs=require('node:fs');
    const originalExit=process.exit.bind(process);
    const output=process.stdout.write.bind(process.stdout);
    for(const method of ['log','info','warn','error','debug'])console[method]=()=>{};
    let startupError=null,listenCalled=false;
    const timer={unref(){return this;},ref(){return this;}};
    global.setInterval=()=>timer;global.setTimeout=()=>timer;
    global.clearInterval=()=>{};global.clearTimeout=()=>{};
    const denied=()=>{throw Error('UNEXPECTED_EXTERNAL_STARTUP_IO');};
    global.fetch=denied;
    require('node:net').Socket.prototype.connect=denied;
    require('node:net').Server.prototype.listen=denied;
    require('node:tls').connect=denied;
    for(const name of ['node:http','node:https'])for(const method of ['get','request'])require(name)[method]=denied;
    require('node:dgram').createSocket=denied;
    for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[method]=denied;
    const Logger=requireApp('./src/utils/logger');
    for(const name of ['info','warn','success','debug','chain'])Logger[name]=()=>{};
    Logger.error=(_message,error)=>{startupError=error?.message||'STARTUP_ERROR';};
    process.exit=code=>{throw Error('APP_START_EXIT_'+code);};
    const starts=[];
    for(const name of ['followup.service','smart-triggers.service','sequence.service','telegram.service',
        'email.service','vk.service','max.service','barista-bot.service','coffee-feedback.service',
        'pms/pms.service','twenty/twenty.service','crm-memory.service']){
        const service=requireApp('./src/services/'+name);
        assert.equal(typeof service.start,'function',name+' startup export');
        service.start=()=>{starts.push(name);return Promise.resolve();};
    }
    for(const name of ['integrations/amocrm','avito.service']){
        const service=requireApp('./src/services/'+name);
        assert.equal(typeof service.recoverPending,'function',name+' recovery export');
        service.recoverPending=()=>{starts.push(name);return Promise.resolve();};
    }
    (async()=>{
        const SQLite=requireApp('better-sqlite3');
        const baseline=new SQLite(process.env.DB_PATH,{readonly:true,fileMustExist:true});requireApp('sqlite-vec').load(baseline);
        const snapshots=require('./migrations.cjs');
        const before=snapshots.snapshot(baseline),critical={};
        const protectedTables=new Set(['clients','messages','leads','manager_tasks','ava_manager_tasks','conversation_events',
            'ava_conversation_events','identity_users','identity_principals','business_memberships','identity_memberships',
            'ava_catalog_offers','ava_catalog_versions','customer_commercial_invoice_versions']);
        const instanceColumns=new Set(['id','name','isActive','systemPrompt','aiProvider','geminiModel','voiceAiProvider',
            'voiceModel','voiceName','voiceSettings','voiceAmbient','hotelTone']);
        for(const [name,value] of Object.entries(before.tables))if(name==='instances'||protectedTables.has(name)){
            const columns=name==='instances'?value.columns.filter(c=>instanceColumns.has(c.name)):value.columns;
            critical[name]={columns,rowid:value.rowid,rows:snapshots.rows(baseline,name,columns,value.rowid)};
        }
        baseline.close();
        const app=requireApp('./src/app'),DB=requireApp('./src/services/database.service');
        // Validate the exact require(...).method startup expressions before any
        // listener can hide a missing export behind a generic500/failed health.
        const startupSource=fs.readFileSync(requireApp.resolve('./src/app'),'utf8').split('async start(')[1];
        let initializers=0;
        for(const match of startupSource.matchAll(/require\(['"](\.\/services\/[^'"]+)['"]\)\.([A-Za-z_][A-Za-z_0-9]*)\(/g)){
            const module=requireApp('./src/'+match[1].slice(2));
            assert.equal(typeof module[match[2]],'function',match[1]+'.'+match[2]);
            if(['ensureSchema','schema','_ensureReplySchema'].includes(match[2]))initializers++;
        }
        app.app.listen=(_port,callback)=>{listenCalled=true;callback();return{close(){}};};
        await app.start(0);
        assert.equal(startupError,null);assert.equal(listenCalled,true);
        assert.ok(DB.db.open);assert.equal(DB.db.pragma('integrity_check',{simple:true}),'ok');
        assert.ok(fs.statSync(process.env.DB_PATH).size>0,'real file-backed SQLite was initialized');
        const after=snapshots.snapshot(DB.db);
        assert.deepEqual(after.objects, before.objects, 'STARTUP_UNMIGRATED_SCHEMA');
        for(const [name,value] of Object.entries(critical)){
            const current=snapshots.rows(DB.db,name,value.columns,value.rowid);
            assert.deepEqual(current,value.rows,'STARTUP_CUSTOMER_DATA_CHANGED:'+name);
        }
        const tables=['customer_external_connections','customer_external_operations','customer_catalog_imports',
            'customer_catalog_keys','customer_commercial_invoice_versions','whatsapp_response_settings',
            'whatsapp_media_inputs','whatsapp_document_deliveries','whatsapp_reply_jobs',
            'ava_business_preparation','ava_workspace_document_actions'];
        for(const table of tables)assert.ok(DB.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?",[table]),table);
        assert.ok(DB.all('PRAGMA table_info(instances)').some(c=>c.name==='voiceAmbient'));
        assert.ok(DB.all('PRAGMA table_info(ava_self_registrations)').some(c=>c.name==='flow'));
        assert.match(DB.get("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='whatsapp_inbound_reply_job'").sql,/delaySeconds/);
        assert.equal(starts.length,14);assert.ok(initializers>=19);
        DB.db.close();
        output(JSON.stringify({ok:true,initializers,tables:tables.length,externalConsumersStubbed:starts.length,realAppStart:true,protectedTables:Object.keys(critical),customerRowsPreserved:true,schemaPreserved:true})+'\n');
        originalExit(0);
    })().catch(error=>{process.stderr.write(String(startupError||error.message)+'\n');originalExit(1);});
}
startupProbe();
