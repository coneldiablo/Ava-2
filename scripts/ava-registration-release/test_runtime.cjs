'use strict';
// Synthetic application-DDL preservation/idempotency check; no production DB.
const path=require('path'),fs=require('fs'),os=require('os'),cp=require('child_process'),assert=require('assert'),crypto=require('crypto');
const app=process.env.AVA_RELEASE_APP_ROOT;
assert.ok(app&&path.isAbsolute(app),'AVA_RELEASE_APP_ROOT absolute candidate runtime required');
const baseline=process.env.AVA_RELEASE_BASELINE_APP_ROOT;
assert.ok(baseline&&path.isAbsolute(baseline)&&path.resolve(baseline)!==path.resolve(app),'Distinct immutable baseline runtime required');
const {createRequire}=require('module'),r=createRequire(path.join(app,'package.json'));
const baselineRequire=createRequire(path.join(baseline,'package.json'));
const output=process.stdout.write.bind(process.stdout);process.stdout.write=()=>true;
for(const key of ['log','info','warn','error','debug'])console[key]=()=>{};
const script=path.join(__dirname,'migrations.cjs');
(async()=>{
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ava-reg-migration-')),target=path.join(dir,'fixture.db');
const db=baselineRequire('./tests/test-helper').createTestDB();baselineRequire('./src/services/identity/identity-store').ensureSchema();
db.exec("CREATE TABLE production_only(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO production_only VALUES(1,'retained fixture'); CREATE INDEX production_only_idx ON production_only(body); CREATE TRIGGER production_only_trigger AFTER INSERT ON production_only BEGIN SELECT 1; END;");
await db.backup(target);db.close();
const SQLite=r('better-sqlite3');
function snap(){const d=new SQLite(target);let objects={},tables={};for(const row of d.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all()){objects[row.name]=row; if(row.type==='table')tables[row.name]=d.prepare('SELECT * FROM "'+row.name.replaceAll('"','""')+'"').raw().all()}d.close();return {objects,tables}}
function migrate(){const out=cp.spawnSync(process.execPath,[script,'migrate'],{env:{...process.env,AVA_RELEASE_APP_ROOT:app,DB_PATH:target},encoding:'utf8'});assert.strictEqual(out.status,0,out.stderr);assert.strictEqual(JSON.parse(out.stdout).schemaVerified,true)}
const before=snap();migrate();let after=snap();for(const [n,v]of Object.entries(before.objects))assert.deepStrictEqual(after.objects[n],v);for(const [n,v]of Object.entries(before.tables))assert.deepStrictEqual(after.tables[n],v);migrate();assert.deepStrictEqual(snap(),after);
const d=new SQLite(target);d.prepare("INSERT INTO ava_self_registrations(id,tokenHash,codeHash,email,displayName,businessName,passwordEncrypted,state,createdAtMs,expiresAtMs,resendAfterMs,childTokenEncrypted) VALUES('fixture','fixture','fixture','fixture@example.test','Fixture','Fixture','retained-ciphertext','completed',0,1,0,'retained-child')").run();d.close();after=snap();migrate();assert.deepStrictEqual(snap(),after);
fs.rmSync(dir,{recursive:true});output(JSON.stringify({migrationVerified:true,originalObjectsAndRowsPreserved:true,idempotent:true,existingCompletedRegistrationRowsPreserved:true,productionDatabaseUsed:false})+'\n');
})().catch(()=>{process.stderr.write('SYNTHETIC_MIGRATION_FAILED\n');process.exit(1)});
