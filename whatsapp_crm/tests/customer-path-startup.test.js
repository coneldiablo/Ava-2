'use strict';
const {describe,it,assert}=require('./test-helper');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');

// A separate process exercises the real exported App.start and DB.init. Only
// external consumers/pollers, timers and the listening socket are replaced.
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
    const Logger=require('./src/utils/logger');
    for(const name of ['info','warn','success','debug','chain'])Logger[name]=()=>{};
    Logger.error=(_message,error)=>{startupError=error?.message||'STARTUP_ERROR';};
    process.exit=code=>{throw Error('APP_START_EXIT_'+code);};
    const starts=[];
    for(const name of ['followup.service','smart-triggers.service','sequence.service','telegram.service',
        'email.service','vk.service','max.service','barista-bot.service','coffee-feedback.service',
        'pms/pms.service','twenty/twenty.service','crm-memory.service']){
        const service=require('./src/services/'+name);
        assert.equal(typeof service.start,'function',name+' startup export');
        service.start=()=>{starts.push(name);return Promise.resolve();};
    }
    for(const name of ['integrations/amocrm','avito.service']){
        const service=require('./src/services/'+name);
        assert.equal(typeof service.recoverPending,'function',name+' recovery export');
        service.recoverPending=()=>{starts.push(name);return Promise.resolve();};
    }
    (async()=>{
        const app=require('./src/app'),DB=require('./src/services/database.service');
        // Validate the exact require(...).method startup expressions before any
        // listener can hide a missing export behind a generic500/failed health.
        const startupSource=fs.readFileSync(require.resolve('./src/app'),'utf8').split('async start(')[1];
        let initializers=0;
        for(const match of startupSource.matchAll(/require\(['"](\.\/services\/[^'"]+)['"]\)\.([A-Za-z_][A-Za-z_0-9]*)\(/g)){
            const module=require('./src/'+match[1].slice(2));
            assert.equal(typeof module[match[2]],'function',match[1]+'.'+match[2]);
            if(['ensureSchema','schema','_ensureReplySchema'].includes(match[2]))initializers++;
        }
        app.app.listen=(_port,callback)=>{listenCalled=true;callback();return{close(){}};};
        await app.start(0);
        assert.equal(startupError,null);assert.equal(listenCalled,true);
        assert.ok(DB.db.open);assert.equal(DB.db.pragma('integrity_check',{simple:true}),'ok');
        assert.ok(fs.statSync(process.env.DB_PATH).size>0,'real file-backed SQLite was initialized');
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
        output(JSON.stringify({ok:true,initializers,tables:tables.length,externalConsumersStubbed:starts.length,realAppStart:true})+'\n');
        originalExit(0);
    })().catch(error=>{process.stderr.write(String(startupError||error.message)+'\n');originalExit(1);});
}

describe('Customer path actual application startup',()=>{
    it('executes every real schema initializer and reaches listen with file SQLite and no external IO',()=>{
        const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ava-app-startup-'));
        try{
            const result=spawnSync(process.execPath,['-e','('+startupProbe.toString()+')()'],{
                cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:30000,
                env:{...process.env,DB_PATH:path.join(directory,'crm.db'),AUTH_ENABLED:'false',
                    AVA_CUSTOMER_ACCESS_ENABLED:'false',WHATSAPP_CRM_PUBLIC_URL:'https://wh.meludtech.tech',
                    SESSION_SECRET:'synthetic-startup-secret-at-least-32-characters'}});
            assert.strictEqual(result.status,0,result.stderr||result.error?.message||result.stdout);
            const receipt=JSON.parse(result.stdout.trim());
            assert.strictEqual(receipt.ok,true);assert.strictEqual(receipt.realAppStart,true);
            assert.ok(receipt.initializers>=19);assert.strictEqual(receipt.tables,11);
        }finally{fs.rmSync(directory,{recursive:true,force:true});}
    });
});
