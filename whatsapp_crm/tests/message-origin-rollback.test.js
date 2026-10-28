'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Identity=require('../src/services/client-identity.service');
async function seed(){createTestDB();const instance=await DB.createInstance({name:'Rollback fixture'});await DB.getOrCreateClient(instance.id,'79990000111@c.us','Primary');await DB.getOrCreateClient(instance.id,'tg_12345','Dialog');return instance.id;}
const insert=(business,chat,text='fixture')=>DB.run(`INSERT OR IGNORE INTO messages(instanceId,chatId,senderName,messageType,content,role,channel,sourceMessageId)
 VALUES(?,?,'Fixture','text',?,'user','telegram','old-provider-id')`,[business,chat,text]);
describe('Message origin rollback compatibility',()=>{
 it('deduplicates old INSERT shapes and retains distinct provider origins across merge and restart',async()=>{
  const business=await seed();
  assert.equal(insert(business,'79990000111@c.us').changes,1);
  assert.equal(insert(business,'79990000111@c.us').changes,0);
  assert.equal(DB.get('SELECT originChatId FROM messages').originChatId,'79990000111@c.us');
  assert.equal(insert(business,'tg_12345','second origin').changes,1);
  Identity.attach(business,'79990000111@c.us',{kind:'telegram',value:'12345',mergeChatId:'tg_12345',confirmMerge:true});
  assert.equal(DB.get('SELECT COUNT(*) AS n FROM messages').n,2);
  // Truly unpatched old startup cannot recreate its canonical unique index;
  // SQLite refuses atomically, without deleting the legitimate merged rows.
  assert.throws(()=>DB.db.exec(`CREATE UNIQUE INDEX idx_messages_source_message ON messages(instanceId,chatId,channel,sourceMessageId) WHERE sourceMessageId IS NOT NULL`),/UNIQUE/);
  assert.equal(DB.get('SELECT COUNT(*) AS n FROM messages').n,2);
  DB.ensureColumns();DB.ensureMessageOriginSchema();DB.ensureColumns();
  assert.equal(insert(business,'79990000111@c.us').changes,0);
  assert.equal(insert(business,'tg_12345').changes,0);
  assert.equal(DB.get('SELECT COUNT(*) AS n FROM messages').n,2);
  const replay=await DB.saveMessageWithChannel(business,'tg_12345','Fixture','replay','user','telegram',null,'old-provider-id');
  assert.equal(replay.inserted,false);
  assert.equal(DB.get("SELECT sql FROM sqlite_master WHERE name='idx_messages_origin_source'").sql.includes('COALESCE(originChatId,chatId)'),true);
 });
 it('protects the pre-trigger NULL origin and fails legacy duplicate migration without losing any row',async()=>{
  const business=await seed();
  DB.db.exec('DROP TRIGGER trg_messages_origin_insert');
  assert.equal(insert(business,'tg_12345').changes,1);
  assert.equal(insert(business,'tg_12345').changes,0,'expression index protects NULL before any trigger');
  DB.db.exec('DROP INDEX idx_messages_origin_source');
  assert.equal(insert(business,'tg_12345','second stored delivery').changes,1);
  assert.throws(()=>DB.ensureMessageOriginSchema(),/UNIQUE/);
  assert.equal(DB.get('SELECT COUNT(*) AS n FROM messages').n,2);
  assert.equal(DB.get('SELECT COUNT(*) AS n FROM messages WHERE originChatId IS NULL').n,2,'failed transaction rolls back origin backfill too');
 });
});
