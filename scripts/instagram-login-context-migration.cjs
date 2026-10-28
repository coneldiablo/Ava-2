'use strict';
// Add exactly one empty, tenant-scoped table. Existing data and DDL are immutable.
const assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const table='instagram_private_login_contexts';
function migrate(SQLite,db,initialize,snapshots){
 return db.transaction(()=>{
  const before=snapshots.snapshot(db);
  initialize();
  const after=snapshots.snapshot(db,before);
  snapshots.compare(SQLite,before,after,{columns:{},triggerReplacements:[],newTables:[table]});
  const columns=db.prepare(`PRAGMA table_info(${table})`).all();
  assert.deepEqual(columns.map(c=>[c.name,c.type,c.notnull,c.pk]),[
   ['businessId','INTEGER',0,1],['usernameHash','TEXT',1,0],['settingsEncrypted','TEXT',0,0],
   ['expiresAt','INTEGER',1,0],['lastErrorCode','TEXT',1,0],['updatedAt','INTEGER',1,0],
  ],'LOGIN_CONTEXT_SCHEMA_INVALID');
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  if(!before.tables[table])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  return {ok:true,newTables:before.tables[table]?[]:[table],existingRowsPreserved:true,
   existingSchemaPreserved:true,onlyAllowedSchemaChanges:true,integrityOk:true};
 }).immediate();
}
if(require.main===module){
 assert.equal(process.env.AVA_LOGIN_CONTEXT_MIGRATION,'1','MIGRATION_OPT_IN_REQUIRED');
 const write=process.stdout.write.bind(process.stdout);
 for(const method of ['log','info','warn','error','debug'])console[method]=()=>{};
 const snapshots=require('/release/migrations.cjs');snapshots.prohibitActivity();
 const app=createRequire('/app/package.json'),SQLite=app('better-sqlite3');
 const db=new SQLite(process.env.DB_PATH,{fileMustExist:true});app('sqlite-vec').load(db);db.pragma('busy_timeout=10000');
 app('./src/services/database.service').db=db;
 try{const result=migrate(SQLite,db,()=>app('./instagram_private/server').ensureSchema(),snapshots);
  db.close();write(JSON.stringify(result)+'\n',()=>process.exit(0));
 }catch(error){db.close();write(JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(error.message)?error.message:'LOGIN_CONTEXT_MIGRATION_FAILED'})+'\n',()=>process.exit(1));}
}
module.exports={migrate};
