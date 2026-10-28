'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {createRequire}=require('node:module');
const appRequire=createRequire(path.resolve(__dirname,'../../whatsapp_crm/package.json'));
const SQLite=appRequire('better-sqlite3');
const {snapshot,compare,rollbackBarriers}=require('./migrations.cjs');
function fixture(){
    const db=new SQLite(':memory:');
    db.exec("CREATE TABLE instances(id INTEGER PRIMARY KEY,name TEXT);INSERT INTO instances VALUES(1,'business');CREATE TABLE ava_self_registrations(id TEXT PRIMARY KEY,state TEXT);INSERT INTO ava_self_registrations VALUES('original','verification');CREATE TABLE unrelated(id INTEGER PRIMARY KEY,value BLOB);INSERT INTO unrelated VALUES(1,X'0001');");
    const before=snapshot(db);
    db.exec("ALTER TABLE instances ADD COLUMN voiceAmbient TEXT;ALTER TABLE ava_self_registrations ADD COLUMN flow TEXT NOT NULL DEFAULT 'registration';CREATE TABLE new_product(id INTEGER PRIMARY KEY,businessId INTEGER);CREATE INDEX new_product_business ON new_product(businessId);");
    const contract={columns:{instances:[{name:'voiceAmbient',definition:'TEXT'}],ava_self_registrations:[{name:'flow',definition:"TEXT NOT NULL DEFAULT 'registration'"}]},newTables:['new_product'],triggerReplacements:[]};
    return{db,before,contract};
}
function check(f){return compare(SQLite,f.before,snapshot(f.db,f.before),f.contract);}
test('nullable ambient/default registration and new table retain exact prior row projection',()=>{
    const f=fixture();try{assert.equal(check(f).length,2);assert.equal(f.db.prepare('SELECT flow FROM ava_self_registrations').get().flow,'registration');}finally{f.db.close();}
});
test('unexpected old row mutation rolls back the transaction',()=>{
    const f=fixture();try{assert.throws(()=>f.db.transaction(()=>{f.db.exec("UPDATE instances SET name='lost'");check(f);})(),/MIGRATION_EXISTING_ROWS_CHANGED/);assert.equal(f.db.prepare('SELECT name FROM instances').get().name,'business');}finally{f.db.close();}
});
test('added unrelated columns rejected even if old row values preserved',()=>{
    const f=fixture();try{f.db.exec('ALTER TABLE unrelated ADD COLUMN extra TEXT');assert.throws(()=>check(f),/MIGRATION_EXISTING_DDL_CHANGED|MIGRATION_EXISTING_COLUMNS_CHANGED/);}finally{f.db.close();}
});
test('unreviewed table rejected',()=>{
    const f=fixture();try{f.db.exec('CREATE TABLE surprise(id INTEGER)');assert.throws(()=>check(f),/MIGRATION_UNREVIEWED_SCHEMA/);}finally{f.db.close();}
});
test('changed constraint rejected despite matching column metadata',()=>{
    const f=fixture();try{const after=snapshot(f.db,f.before),row=after.objects.find(x=>x.name==='instances');row.sql=row.sql.slice(0,-1)+',CHECK(1))';assert.throws(()=>compare(SQLite,f.before,after,f.contract),/MIGRATION_TABLE_REWRITTEN/);}finally{f.db.close();}
});
test('snapshot keeps integers blobs row multiplicity and vec physical storage',()=>{
    const f=fixture();try{appRequire('sqlite-vec').load(f.db);f.db.exec('CREATE VIRTUAL TABLE vectors USING vec0(embedding float[2]);');f.db.prepare('INSERT INTO vectors(rowid,embedding) VALUES(?,?)').run(1n,Buffer.from(new Float32Array([1,2]).buffer));const snap=snapshot(f.db);assert.equal(snap.tables.vectors.count,1);assert.ok(Object.keys(snap.tables).some(x=>x.startsWith('vectors_')));f.db.exec("UPDATE unrelated SET value='0001'");assert.notEqual(snapshot(f.db).tables.unrelated.digest,snap.tables.unrelated.digest);}finally{f.db.close();}
});
test('existing-account challenge and unknown sends are rollback barriers',()=>{
    const f=fixture();try{f.db.exec("UPDATE ava_self_registrations SET flow='access';CREATE TABLE whatsapp_document_deliveries(status TEXT);INSERT INTO whatsapp_document_deliveries VALUES('unknown');");const b=rollbackBarriers(f.db);assert.equal(b.existingAccountChallenge,true);assert.equal(b.unknownDocument,true);}finally{f.db.close();}
});
