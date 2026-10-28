'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service'),SQLite=require('better-sqlite3');
const snapshots=require('../../scripts/customer-completion-release/migrations.cjs');
const {migrate}=require('../../scripts/instagram-login-context-migration.cjs');
describe('Instagram pending login migration',()=>{
 it('adds only the empty login context table and preserves an existing customer and account',async()=>{
  createTestDB();const business=await DB.createInstance({name:'Migration fixture'});
  const modulePath=require.resolve('../instagram_private/server');let service=require(modulePath);service.ensureSchema();
  DB.run("INSERT INTO instagram_private_accounts(businessId,accountId,username,state,connectedAt,updatedAt) VALUES(?,'1001','private-name','paused',1,1)",[business.id]);
  DB.db.exec('DROP TABLE instagram_private_login_contexts');delete require.cache[modulePath];service=require(modulePath);
  const before=snapshots.snapshot(DB.db);let result=migrate(SQLite,DB.db,()=>service.ensureSchema(),snapshots);
  assert.deepStrictEqual(result.newTables,['instagram_private_login_contexts']);assert.equal(result.existingRowsPreserved,true);
  const after=snapshots.snapshot(DB.db,before);for(const [name,table]of Object.entries(before.tables))assert.equal(after.tables[name].digest,table.digest);
  result=migrate(SQLite,DB.db,()=>service.ensureSchema(),snapshots);assert.deepStrictEqual(result.newTables,[]);
 });
 it('rolls back an initializer which changes existing data',async()=>{
  createTestDB();const b=await DB.createInstance({name:'Must remain'});
  assert.throws(()=>migrate(SQLite,DB.db,()=>{require('../instagram_private/server').ensureSchema();DB.run("UPDATE instances SET name='Wrong' WHERE id=?",[b.id]);},snapshots));
  assert.equal(DB.get('SELECT name FROM instances WHERE id=?',[b.id]).name,'Must remain');
 });
});
