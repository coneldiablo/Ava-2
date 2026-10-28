const {describe,it,assert,createTestDB}=require('./test-helper');
const Connection=require('../src/services/whatsapp-connection.service');const DB=require('../src/services/database.service');
const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
describe('Scoped GreenAPI callback authentication and migration',()=>{
    it('rejects unsigned, other-business and altered provider binding before accepting a callback',()=>{
        const a={id:1,greenApiInstance:'provider-a',greenApiToken:'fixture-token-at-least-16-chars'};
        const b={...a,id:2,greenApiInstance:'provider-b'};
        const req={body:{instanceData:{idInstance:'provider-a'}},headers:{authorization:`Bearer ${Connection.greenWebhookToken(a)}`}};
        assert.strictEqual(Connection.verifyGreenWebhook(req,a),true);
        assert.strictEqual(Connection.verifyGreenWebhook({...req,headers:{}},a),false);
        assert.strictEqual(Connection.verifyGreenWebhook(req,b),false);
        assert.strictEqual(Connection.verifyGreenWebhook({...req,body:{instanceData:{idInstance:'provider-b'}}},a),false);
    });
    it('migration dry-run/verify/apply/rollback preserve callback/events and never log tokens',async()=>{
        createTestDB();const i=await DB.createInstance({name:'Green migration fixture'});
        await DB.updateInstance(i.id,{isActive:1,greenApiInstance:'fixture-provider',greenApiToken:'fixture-private-provider-token',greenApiUrl:'https://api.green-api.com'});
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'green-migration-')),dbFile=path.join(dir,'crm.db'),stateFile=path.join(dir,'provider.json'),backup=path.join(dir,'backup.json'),preload=path.join(dir,'provider.cjs');
        await DB.db.backup(dbFile);
        const before={webhookUrl:'https://crm.fixture.test/api/webhook',webhookUrlToken:'fixture-original-token',incomingWebhook:'yes',outgoingWebhook:'no',stateWebhook:'yes'};
        fs.writeFileSync(stateFile,JSON.stringify(before));
        fs.writeFileSync(preload,`const fs=require('fs');global.fetch=async(_url,opts={})=>{let state=JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE));if(opts.method==='POST'){const body=JSON.parse(opts.body);require('assert').deepStrictEqual(Object.keys(body),['webhookUrlToken']);state=process.env.FIXTURE_PENDING==='1'?{...state,pendingToken:body.webhookUrlToken}:{...state,...body};fs.writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(state));return {ok:true,json:async()=>({saveSettings:true})};}if(state.pendingToken&&process.env.FIXTURE_PENDING!=='1'){state.webhookUrlToken=state.pendingToken;delete state.pendingToken;fs.writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(state));}return {ok:true,json:async()=>state};};`);
        const script=path.resolve(__dirname,'../scripts/whatsapp-green-webhook-migration.js');
        let delayed=false;
        const run=(...args)=>spawnSync(process.execPath,['-r',preload,script,...args],{env:{...process.env,DB_PATH:dbFile,FIXTURE_STATE:stateFile,FIXTURE_PENDING:delayed?'1':'',GREEN_API_WEBHOOK_MASTER_KEY:''},encoding:'utf8'});
        try{
            const dry=run('--dry-run');assert.strictEqual(dry.status,0);assert.strictEqual(JSON.parse(dry.stdout).needsMigration,1);
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile)),before);assert.ok(!fs.existsSync(backup));
            assert.strictEqual(run('--verify').status,1);
            const apply=run('--apply',backup);assert.strictEqual(apply.status,0);assert.ok(!(fs.statSync(backup).mode&0o077));
            const after=JSON.parse(fs.readFileSync(stateFile));assert.strictEqual(after.webhookUrl,before.webhookUrl);assert.strictEqual(after.incomingWebhook,'yes');assert.notStrictEqual(after.webhookUrlToken,before.webhookUrlToken);
            assert.strictEqual(run('--verify').status,0);
            const second=run('--apply',path.join(dir,'second.json'));assert.strictEqual(second.status,0);assert.strictEqual(JSON.parse(second.stdout).changed,0);
            assert.strictEqual(run('--rollback',backup).status,0);assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile)),before);
            delayed=true;const pendingBackup=path.join(dir,'pending.json');const pending=run('--apply',pendingBackup);
            assert.strictEqual(pending.status,2);assert.strictEqual(JSON.parse(pending.stdout).verified,false);
            delayed=false;assert.strictEqual(run('--verify').status,0);assert.strictEqual(run('--rollback',pendingBackup).status,0);
            assert.ok(!dry.stdout.includes('fixture-private-provider-token'));assert.ok(!apply.stdout.includes(after.webhookUrlToken));
        }finally{fs.rmSync(dir,{recursive:true,force:true});}
    });
});
