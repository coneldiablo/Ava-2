'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service'),Identity=require('../src/services/identity/identity-store');
const Service=require('../src/services/catalog-import.service'),Store=require('../src/services/catalog.store');
const writeXlsx=require('write-excel-file/node');
const file=(text)=>({originalname:'catalog.csv',buffer:Buffer.from(text)});
const body=(overrides={})=>({mapping:{name:0,price:1,sku:2},mode:'add',publish:true,idempotencyKey:'commit-one',...overrides});
async function run(fn){const db=createTestDB();Identity.ensureSchema();DB.run("INSERT INTO instances(id,name) VALUES(1,'First'),(2,'Other')");for(const [u,b,r]of[['owner',1,'hotel_owner'],['other',2,'hotel_owner'],['manager',1,'manager']]){DB.run('INSERT INTO ava_users(id,subject,email) VALUES(?,?,?)',[u,u,u+'@example.test']);DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)',[u,b,r]);}try{await fn({owner:Identity.actor('owner'),other:Identity.actor('other'),manager:Identity.actor('manager')});}finally{db.close();}}
describe('Product catalogue import using canonical published offers',()=>{
 it('previews quoted CSV, maps columns, commits once and readback reaches Studio and published assistant reader',()=>run(async({owner})=>{
  const p=await Service.preview(owner,1,file('Название;Цена;Артикул\r\n"Стол; дуб";"1 250,99";A-1\r\nСтул;0;A-2'));
  assert.strictEqual(p.import.rowCount,2);assert.strictEqual(p.import.preview[0].cells[0],'Стол; дуб');assert.deepStrictEqual(Store.listPublished(1),[]);
  const check=Service.validate(owner,1,p.import.id,body());assert.strictEqual(check.validation.validCount,2);assert.strictEqual(check.validation.products[0].amountMinor,125099);
  const receipt=Service.commit(owner,1,p.import.id,body());assert.strictEqual(receipt.import.receipt.added,2);
  assert.strictEqual(Service.commit(owner,1,p.import.id,body()).replayed,true);assert.strictEqual(Store.listPublished(1).length,2);assert.strictEqual(Store.listPublished(2).length,0);
  assert.strictEqual(require('../src/services/customer-studio.service').catalog(1).find(o=>o.name==='Стол; дуб').amountMinor,125099);
  assert.strictEqual(Service.get(owner,1,p.import.id).import.receipt.changes.length,2);
  assert.throws(()=>Service.commit(owner,1,p.import.id,body({publish:false})),{code:'CATALOG_IDEMPOTENCY_CONFLICT'});
 }));
 it('reads real XLSX bytes through read-excel-file, with decimal prices and no product writes before confirmation',()=>run(async({owner})=>{
  const buffer=await writeXlsx([[{value:'Товар'},{value:'Цена'},{value:'Артикул'}],[{value:'Пастух'},{value:499.5},{value:'P-1'}]]).toBuffer();
  const p=await Service.preview(owner,1,{originalname:'price.xlsx',buffer});assert.strictEqual(p.import.rowCount,1);
  const r=Service.commit(owner,1,p.import.id,body());assert.strictEqual(r.import.receipt.added,1);assert.strictEqual(Store.listPublished(1)[0].amountMinor,49950);
 }));
 it('blocks invalid rows by default, explicit partial import keeps errors and add mode skips existing products',()=>run(async({owner})=>{
  const p=await Service.preview(owner,1,file('name,price,sku\nGood,12,A\nBad,unknown,B\nDuplicate,15,A'));
  assert.strictEqual(Service.validate(owner,1,p.import.id,body()).validation.errorCount,2);
  assert.throws(()=>Service.commit(owner,1,p.import.id,body()),{code:'CATALOG_ROWS_INVALID'});assert.strictEqual(Store.listPublished(1).length,0);
  const r=Service.commit(owner,1,p.import.id,body({allowPartial:true}));assert.strictEqual(r.import.receipt.status,'partial');assert.strictEqual(r.import.receipt.errors.length,2);
  const p2=await Service.preview(owner,1,file('name,price,sku\nGood,13,A'));
  const r2=Service.commit(owner,1,p2.import.id,body({idempotencyKey:'second'}));assert.strictEqual(r2.import.receipt.skipped.length,1);assert.strictEqual(Store.listPublished(1)[0].amountMinor,1200);
 }));
 it('upserts same SKU without duplicate, restores prior price on rollback and retains revisions',()=>run(async({owner})=>{
  const p=await Service.preview(owner,1,file('name,price,sku\nGood,12,A'));Service.commit(owner,1,p.import.id,body());const first=Store.listPublished(1)[0];
  const p2=await Service.preview(owner,1,file('name,price,sku\nRenamed,13,A'));Service.commit(owner,1,p2.import.id,body({mode:'upsert',idempotencyKey:'second'}));
  assert.strictEqual(Store.listPublished(1).length,1);assert.strictEqual(Store.listPublished(1)[0].id,first.id);assert.strictEqual(Store.listPublished(1)[0].amountMinor,1300);
  Service.rollback(owner,1,p2.import.id);assert.strictEqual(Store.listPublished(1)[0].amountMinor,1200);assert.strictEqual(Store.listPublished(1)[0].revision,3);
  assert.strictEqual(Service.rollback(owner,1,p2.import.id).replayed,true);
  assert.throws(()=>Service.rollback(owner,1,p.import.id),{code:'CATALOG_ROLLBACK_CONFLICT'});
 }));
 it('draft imports are not assistant facts; rollback of new products deactivates rather than erasing quote references',()=>run(async({owner})=>{
  const p=await Service.preview(owner,1,file('name,price,sku\nDraft,12,A'));const r=Service.commit(owner,1,p.import.id,body({publish:false}));assert.deepStrictEqual(Store.listPublished(1),[]);
  const id=r.import.receipt.changes[0].offerId;Service.rollback(owner,1,p.import.id);assert.strictEqual(Store.Catalog.offer(1,id).active,false);assert.strictEqual(Store.Catalog.offer(1,id).revision,2);
 }));
 it('fences edits after preview, cross-tenant reads, manager writes and revoked memberships',()=>run(async({owner,other,manager})=>{
  await assert.rejects(()=>Service.preview(manager,1,file('n,p\nA,1')),{code:'CAPABILITY_DENIED'});
  const p=await Service.preview(owner,1,file('n,p,s\nA,1,A'));Service.commit(owner,1,p.import.id,body());
  const p2=await Service.preview(owner,1,file('n,p,s\nA,2,A'));const old=Store.listPublished(1)[0];Store.Catalog.saveOffer(1,{...old,revision:old.revision+1},old.revision);
  assert.throws(()=>Service.commit(owner,1,p2.import.id,body({mode:'upsert',idempotencyKey:'second'})),{code:'CATALOG_ROWS_INVALID'});
  assert.throws(()=>Service.get(other,2,p.import.id),{code:'CATALOG_IMPORT_NOT_FOUND'});assert.throws(()=>Service.get(other,1,p.import.id),{code:'BUSINESS_ACCESS_DENIED'});
  DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='owner'");assert.throws(()=>Service.get(owner,1,p.import.id),{code:'BUSINESS_ACCESS_DENIED'});
 }));
 it('rechecks source session after asynchronous parsing before storing preview',()=>run(async({owner})=>{
  await assert.rejects(()=>Service.preview(owner,1,file('n,p,s\nA,1,A'),{beforeWrite:()=>{throw Object.assign(new Error('AUTHENTICATION_REQUIRED'),{code:'AUTHENTICATION_REQUIRED'});}}),{code:'AUTHENTICATION_REQUIRED'});
  Store.ensureSchema();assert.strictEqual(DB.get('SELECT COUNT(*) n FROM customer_catalog_imports').n,0);
 }));
 it('rejects compressed expansion bombs, legacy Excel, excessive columns/cells and missing mapping',()=>run(async({owner})=>{
  const zip=require('jszip');const archive=new zip();archive.file('xl/worksheets/sheet1.xml','A'.repeat(2*1024*1024));const buffer=await archive.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  await assert.rejects(()=>Service.preview(owner,1,{originalname:'bomb.xlsx',buffer}),{code:'CATALOG_XLSX_TOO_LARGE'});
  await assert.rejects(()=>Service.preview(owner,1,{originalname:'legacy.xls',buffer}),{code:'CATALOG_FORMAT_UNSUPPORTED'});
  await assert.rejects(()=>Service.preview(owner,1,file('n,p\n'+ 'X'.repeat(4001)+',2')),{code:'CATALOG_CELL_TOO_LONG'});
  const p=await Service.preview(owner,1,file('n,p\nA,1'));assert.throws(()=>Service.validate(owner,1,p.import.id,{mapping:{name:0},mode:'add',publish:true}),{code:'CATALOG_MAPPING_INVALID'});
 }));
 it('multipart API uses real sessions and rejects revoked cookie after held XLSX parsing',()=>run(async({owner})=>{
  const express=require('express'),Auth=require('../src/services/auth.service');
  const oldUrl=process.env.WHATSAPP_CRM_PUBLIC_URL,oldCustomer=process.env.AVA_CUSTOMER_ACCESS_ENABLED,oldAuth=Auth.config.enabled;
  process.env.WHATSAPP_CRM_PUBLIC_URL='https://ava.example.test';process.env.AVA_CUSTOMER_ACCESS_ENABLED='true';Auth.config.enabled=true;
  const token=Identity.createSession('owner','catalog-http-test');
  const app=express();app.use(express.json());app.use('/api',Auth.requireAuth.bind(Auth));app.use('/api',require('../src/routes/customer-catalog.routes'));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/businesses/1/catalog-imports`;
  const headers={Cookie:`crm_session=ava2:${token}`,Origin:'https://ava.example.test'};
  const reader=require('read-excel-file/node'),read=reader.readSheet;
  try {
   const form=new FormData();form.append('file',new Blob(['name,price,sku\nGood,12,A']),'products.csv');
   const response=await fetch(base+'/preview',{method:'POST',headers,body:form});
   assert.strictEqual(response.status,200);const preview=await response.json();
   const committed=await fetch(base+'/'+preview.import.id+'/commit',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body())});
   assert.strictEqual(committed.status,200);assert.strictEqual(Store.listPublished(1).length,1);
   const cross=await fetch(base+'/'+preview.import.id+'/rollback',{method:'POST',headers:{...headers,Origin:'https://foreign.example.test'}});assert.strictEqual(cross.status,403);
   let entered,release;const held=new Promise(r=>{release=r;}),seen=new Promise(r=>{entered=r;});
   reader.readSheet=async(...args)=>{entered();await held;return read(...args);};
   const buffer=await writeXlsx([[{value:'name'},{value:'price'}],[{value:'Other'},{value:2}]]).toBuffer();
   const pendingForm=new FormData();pendingForm.append('file',new Blob([buffer]),'other.xlsx');
   const pending=fetch(base+'/preview',{method:'POST',headers,body:pendingForm});await seen;
   DB.run("UPDATE ava_sessions SET revokedAt=? WHERE userId='owner'",[Date.now()]);release();
   assert.strictEqual((await pending).status,401);assert.strictEqual(DB.get('SELECT COUNT(*) n FROM customer_catalog_imports').n,1);
  } finally {reader.readSheet=read;await new Promise(resolve=>server.close(resolve));Auth.config.enabled=oldAuth;if(oldCustomer===undefined)delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;else process.env.AVA_CUSTOMER_ACCESS_ENABLED=oldCustomer;if(oldUrl===undefined)delete process.env.WHATSAPP_CRM_PUBLIC_URL;else process.env.WHATSAPP_CRM_PUBLIC_URL=oldUrl;}
 }));

});
