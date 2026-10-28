'use strict';
// Execute the exact schema contract with separate baseline/candidate module graphs.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert'),crypto=require('crypto');
const source=fs.readFileSync(path.join(__dirname,'schema_contract.cjs'),'utf8');
function run({baseline='/baseline',candidate='/candidate',assistantExport=true}={}){
    let stdout='',stderr='',closed=false;const events=[],objects=new Map(),candidateDB={};
    const add=name=>objects.set(name,{name,type:'table',tbl_name:name,sql:'CREATE TABLE '+name+'(id TEXT)'});
    const db={close(){closed=true;},prepare(sql){assert.ok(sql.startsWith('SELECT '),'DDL derivation never writes data');return {all(){events.push('snapshot');return [...objects.values()];}};}};
    const helper={createTestDB(){events.push('baseline-helper');add('instances');return db;}};
    const ensure=name=>({ensureSchema(){assert.strictEqual(candidateDB.db,db);events.push(name);add(name);}});
    function createRequire(packagePath){
        const isBaseline=packagePath==='/baseline/package.json';
        return name=>{
            if(isBaseline){
                if(name==='./tests/test-helper')return helper;
                if(name==='./src/services/identity/identity-store')return {ensureSchema(){events.push('baseline-identity');add('ava_users');}};
                throw Error('Unexpected baseline import');
            }
            if(name==='./src/services/database.service')return candidateDB;
            if(name==='./src/services/identity/identity-store')return ensure('ava_staff_mail_delivery');
            if(name==='./src/services/identity/self-registration.service')return ensure('ava_self_registrations');
            if(name==='./src/services/identity/password-recovery.service')return ensure('ava_password_recovery');
            if(name==='./src/services/onboarding-state.service')return ensure('ava_business_onboarding');
            if(name==='./src/services/assistant-draft.service')return assistantExport?ensure('assistant_drafts'):{};
            throw Error('Unexpected candidate import');
        };
    }
    const process={env:{AVA_RELEASE_APP_ROOT:candidate,AVA_RELEASE_BASELINE_APP_ROOT:baseline},stdout:{write:value=>{stdout+=value;}},stderr:{write:value=>{stderr+=value;}},exitCode:0};
    vm.runInNewContext(source,{process,console:{},require:name=>({path,fs:{existsSync:()=>true},crypto,module:{createRequire}})[name]});
    return {stdout,stderr,events,closed,code:process.exitCode};
}
const valid=run();assert.strictEqual(valid.code,0);assert.strictEqual(valid.closed,true);
const additions=JSON.parse(valid.stdout);assert.deepStrictEqual(additions.map(x=>x.name),['ava_staff_mail_delivery','ava_self_registrations','ava_password_recovery','ava_business_onboarding','assistant_drafts']);
assert.ok(valid.events.indexOf('baseline-identity')<valid.events.indexOf('snapshot'));
assert.ok(valid.events.indexOf('ava_staff_mail_delivery')>valid.events.indexOf('snapshot'));
assert.ok(!additions.some(x=>['instances','ava_users'].includes(x.name)));
for(const options of [{baseline:null},{baseline:'/candidate'},{assistantExport:false}]){
    const r=run(options);assert.strictEqual(r.code,1);assert.strictEqual(r.stdout,'');assert.strictEqual(r.stderr,'SCHEMA_CONTRACT_FAILED\n');
}
process.stdout.write('Schema boundary: 4 cases passed (no providers/database/network)\n');
