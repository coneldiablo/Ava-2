'use strict';
const { randomUUID, createHash } = require('crypto');
const DB = require('./database.service');
const Identity = require('./identity/identity-store');
const Store = require('./catalog.store');
const MAX_BYTES=5*1024*1024, MAX_ROWS=5000, MAX_COLUMNS=50, MAX_CELL=4000;
const FIELDS=['sku','name','price','currency','description','terms'];
const fail=(code,statusCode=400)=>{throw Object.assign(new Error(code),{code,statusCode});};
function authorize(auth,businessId,write=false) {
    if (!auth?.userId || auth.platformRole==='platform_admin') fail('CUSTOMER_ACCESS_REQUIRED',403);
    const current=Identity.actor(auth.userId);
    const id=Identity.authorizeCapability(current,businessId,write?'business.manage':'business.read');
    if(write&&!current.memberships.some(m=>m.businessId===id&&m.role==='hotel_owner')) fail('CAPABILITY_DENIED',403);
    return id;
}
function csv(text) {
    text=text.replace(/^\uFEFF/,'');
    // Separators inside quoted header cells do not determine the CSV dialect.
    const counts={';':0,',':0,'\t':0};let headerQuoted=false;
    for(let i=0;i<text.length;i++){
        const c=text[i];
        if(c==='"'){if(headerQuoted&&text[i+1]==='"')i++;else headerQuoted=!headerQuoted;}
        else if(!headerQuoted){if(c==='\r'||c==='\n')break;if(Object.hasOwn(counts,c))counts[c]++;}
    }
    const delimiter=Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];
    const rows=[];let row=[],cell='',quoted=false;
    const add=()=>{row.push(cell);cell='';if(row.length>MAX_COLUMNS)fail('CATALOG_TOO_MANY_COLUMNS');};
    for(let i=0;i<text.length;i++) {
        const c=text[i];
        if(c==='"') { if(quoted&&text[i+1]==='"'){cell+='"';i++;} else if(quoted)quoted=false;else if(!cell)quoted=true;else fail('CATALOG_CSV_INVALID'); }
        else if(c===delimiter&&!quoted)add();
        else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;add();if(row.some(v=>v!==''))rows.push(row);row=[];}
        else cell+=c;
        if(cell.length>MAX_CELL)fail('CATALOG_CELL_TOO_LONG');
        if(rows.length>MAX_ROWS+1)fail('CATALOG_TOO_MANY_ROWS');
    }
    if(quoted)fail('CATALOG_CSV_INVALID');
    if(cell||row.length){add();if(row.some(v=>v!==''))rows.push(row);}
    return rows;
}
function checkZip(buffer) {
    // Reject ZIP64, huge expansion and hidden archive payloads before the XLSX
    // reader allocates XML/string tables. File byte limit alone is insufficient.
    let end=-1;for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--)if(buffer.readUInt32LE(i)===0x06054b50){end=i;break;}
    if(end<0)fail('CATALOG_XLSX_INVALID');
    const count=buffer.readUInt16LE(end+10),size=buffer.readUInt32LE(end+12),start=buffer.readUInt32LE(end+16);
    if(!count||count>2000||count===65535||start+size>end||buffer.readUInt16LE(end+4)||buffer.readUInt16LE(end+6))fail('CATALOG_XLSX_INVALID');
    let cursor=start,total=0;
    for(let i=0;i<count;i++) {
        if(cursor+46>start+size||buffer.readUInt32LE(cursor)!==0x02014b50)fail('CATALOG_XLSX_INVALID');
        const compressed=buffer.readUInt32LE(cursor+20),expanded=buffer.readUInt32LE(cursor+24);
        const nameLength=buffer.readUInt16LE(cursor+28),extra=buffer.readUInt16LE(cursor+30),comment=buffer.readUInt16LE(cursor+32);
        if(buffer.readUInt16LE(cursor+8)&1||expanded===0xffffffff||compressed===0xffffffff||expanded>20*1024*1024||expanded>Math.max(1024*1024,compressed*200))fail('CATALOG_XLSX_TOO_LARGE');
        total+=expanded;if(total>20*1024*1024)fail('CATALOG_XLSX_TOO_LARGE');
        cursor+=46+nameLength+extra+comment;
    }
    if(cursor!==start+size)fail('CATALOG_XLSX_INVALID');
}
async function parse(file) {
    if(!file||!Buffer.isBuffer(file.buffer)||file.buffer.length===0||file.buffer.length>MAX_BYTES)fail('CATALOG_FILE_INVALID');
    const filename=String(file.originalname||'').replace(/[\u0000-\u001f]/g,'').slice(0,200);
    let rows;
    if(/\.csv$/i.test(filename)) { const text=new TextDecoder('utf-8',{fatal:true});try{rows=csv(text.decode(file.buffer));}catch(e){if(e.code?.startsWith('CATALOG_'))throw e;fail('CATALOG_ENCODING_INVALID');} }
    else if(/\.xlsx$/i.test(filename)) {
        checkZip(file.buffer);
        try { rows=await require('read-excel-file/node').readSheet(file.buffer); } catch {fail('CATALOG_XLSX_INVALID');}
    } else fail('CATALOG_FORMAT_UNSUPPORTED');
    if(rows.length<2||rows.length>MAX_ROWS+1)fail(rows.length<2?'CATALOG_EMPTY':'CATALOG_TOO_MANY_ROWS');
    if(rows.some(r=>r.length>MAX_COLUMNS))fail('CATALOG_TOO_MANY_COLUMNS');
    rows=rows.map(r=>r.map(v=>{if(v==null)return '';if(v instanceof Date)fail('CATALOG_CELL_INVALID');const s=String(v);if(s.length>MAX_CELL)fail('CATALOG_CELL_TOO_LONG');return s.trim();}));
    return {filename,rows};
}
function mappingInput(mapping,columns) {
    if(!mapping||typeof mapping!=='object'||Array.isArray(mapping)||Object.keys(mapping).some(k=>!FIELDS.includes(k))||!Number.isSafeInteger(mapping.name)||!Number.isSafeInteger(mapping.price))fail('CATALOG_MAPPING_INVALID');
    const indexes=Object.values(mapping);if(indexes.some(n=>!Number.isSafeInteger(n)||n<0||n>=columns)||new Set(indexes).size!==indexes.length)fail('CATALOG_MAPPING_INVALID');
    return mapping;
}
function priceMinor(value) {
    const normalized=String(value).replace(/[ \u00a0]/g,'').replace(',','.');
    if(!/^\d+(?:\.\d{1,2})?$/.test(normalized))return null;
    const [whole,fraction='']=normalized.split('.');const n=Number(whole)*100+Number(fraction.padEnd(2,'0'));
    return Number.isSafeInteger(n)&&n<=100000000000?n:null;
}
const keyFor=(sku,name)=>sku?'sku:'+sku.toLocaleLowerCase('ru'):'name:'+name.toLocaleLowerCase('ru').replace(/\s+/g,' ');
function importRow(b,id) {const row=Store.get(b,id);if(!row)fail('CATALOG_IMPORT_NOT_FOUND',404);return row;}
function view(row) {
    const rows=JSON.parse(row.rowsJson);return {id:row.id,businessId:row.businessId,status:row.status,filename:row.filename,
        columns:rows[0].map((name,index)=>({index,name:name||`Столбец ${index+1}`})),rowCount:rows.length-1,
        preview:rows.slice(1,21).map((cells,index)=>({row:index+2,cells})),expiresAt:new Date(row.expiresAt).toISOString(),
        ...(row.receiptJson?{receipt:JSON.parse(row.receiptJson)}:{})};
}
async function preview(auth,businessId,file,{beforeWrite}={}) {
    const b=authorize(auth,businessId,true),{rows,filename}=await parse(file);
    Store.ensureSchema();beforeWrite?.();authorize(auth,b,true);
    DB.run("DELETE FROM customer_catalog_imports WHERE businessId=? AND status='preview' AND expiresAt<?",[b,Date.now()]);
    const id=randomUUID(),now=Date.now(),base=Object.fromEntries(Store.Catalog.offers(b).map(o=>[o.id,o.revision]));
    DB.run('INSERT INTO customer_catalog_imports(id,businessId,createdBy,filename,rowsJson,baseJson,createdAt,expiresAt) VALUES(?,?,?,?,?,?,?,?)',[id,b,auth.userId,filename,JSON.stringify(rows),JSON.stringify(base),now,now+86400000]);
    return {success:true,import:view(importRow(b,id))};
}
function validateRows(row,body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('CATALOG_IMPORT_INPUT_INVALID');
    const rows=JSON.parse(row.rowsJson),mapping=mappingInput(body.mapping,rows[0].length),seen=new Set(),offers=Store.Catalog.offers(row.businessId),base=JSON.parse(row.baseJson);
    if(!['add','upsert'].includes(body.mode)||typeof body.publish!=='boolean'||(body.allowPartial!==undefined&&typeof body.allowPartial!=='boolean'))fail('CATALOG_IMPORT_INPUT_INVALID');
    const errors=[],items=[],skipped=[],targetIds=new Set();
    for(let i=1;i<rows.length;i++) {
        const raw=rows[i],get=(k)=>mapping[k]===undefined?'':String(raw[mapping[k]]||'').trim();
        const name=get('name'),sku=get('sku'),amountMinor=priceMinor(get('price')),currency=get('currency').toUpperCase()||'RUB',description=get('description'),terms=get('terms');
        const invalid=[];if(!name||name.length>200)invalid.push('Название обязательно и не длиннее 200 символов.');
        if(sku.length>120)invalid.push('Артикул не длиннее 120 символов.');if(amountMinor===null)invalid.push('Укажите неотрицательную цену с точностью до копеек.');
        if(!['RUB','USD','EUR','KZT','BYN'].includes(currency))invalid.push('Валюта должна быть RUB, USD, EUR, KZT или BYN.');
        const productKey=keyFor(sku,name);
        if(seen.has(productKey))invalid.push('Повтор товара в файле.');seen.add(productKey);
        const linked=DB.get('SELECT offerId FROM customer_catalog_keys WHERE businessId=? AND productKey=?',[row.businessId,productKey]);
        const byName=offers.filter(o=>o.name.toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru'));
        if(!linked&&byName.length>1)invalid.push('Несколько товаров с таким названием; сначала устраните дубли.');
        const existing=linked?offers.find(o=>o.id===linked.offerId):byName.length===1?byName[0]:null;
        if(existing&&targetIds.has(existing.id))invalid.push('Две строки изменяют один товар; оставьте одну строку.');
        if(existing)targetIds.add(existing.id);
        if(existing&&(base[existing.id]!==existing.revision))invalid.push('Товар изменился после загрузки; загрузите файл заново.');
        if(invalid.length){errors.push({row:i+1,messages:invalid});continue;}
        if(existing&&body.mode==='add'){skipped.push({row:i+1,reason:'already_exists',offerId:existing.id});continue;}
        items.push({row:i+1,productKey,existing,offer:{name,description,terms,amountMinor,currency,active:true}});
    }
    return {items,errors,skipped};
}
function validate(auth,businessId,id,body) {
    const b=authorize(auth,businessId,true),row=importRow(b,id);
    if(row.status!=='preview'||row.expiresAt<=Date.now())fail('CATALOG_PREVIEW_EXPIRED',409);
    const plan=validateRows(row,body);return {success:true,validation:{validCount:plan.items.length,errorCount:plan.errors.length,skippedCount:plan.skipped.length,errors:plan.errors,skipped:plan.skipped,
        products:plan.items.slice(0,20).map(p=>({row:p.row,...p.offer,operation:p.existing?'update':'add'}))}};
}
function commit(auth,businessId,id,body) {
    const b=authorize(auth,businessId,true);Store.ensureSchema();
    if(!body||Object.keys(body).some(k=>!['mapping','mode','publish','allowPartial','idempotencyKey'].includes(k))||typeof body.idempotencyKey!=='string'||!body.idempotencyKey.trim()||body.idempotencyKey.length>200)fail('CATALOG_IMPORT_INPUT_INVALID');
    const hash=createHash('sha256').update(JSON.stringify({id,mapping:body.mapping,mode:body.mode,publish:body.publish,allowPartial:!!body.allowPartial})).digest('hex');
    return DB.db.transaction(()=>{
        authorize(auth,b,true);
        const row=importRow(b,id),prior=DB.get('SELECT * FROM customer_catalog_imports WHERE businessId=? AND createdBy=? AND idempotencyKey=?',[b,auth.userId,body.idempotencyKey]);
        if(prior){if(prior.id!==id||prior.commitHash!==hash)fail('CATALOG_IDEMPOTENCY_CONFLICT',409);return {success:true,import:view(prior),replayed:true};}
        if(row.status!=='preview'||row.expiresAt<=Date.now())fail('CATALOG_PREVIEW_EXPIRED',409);
        const plan=validateRows(row,body);
        if(plan.errors.length&&!body.allowPartial)throw Object.assign(new Error('CATALOG_ROWS_INVALID'),{code:'CATALOG_ROWS_INVALID',statusCode:422,details:{errors:plan.errors,validCount:plan.items.length}});
        const changes=[];const now=new Date().toISOString();
        for(const item of plan.items){
            const old=item.existing,next={...item.offer,id:old?.id||randomUUID(),revision:(old?.revision||0)+1,createdAt:old?.createdAt||now,publishedAt:body.publish?now:null};
            Store.Catalog.saveOffer(b,next,old?old.revision:null);
            if(body.publish)Store.Catalog.publishOffer(b,next);
            const previousKey=DB.get('SELECT productKey FROM customer_catalog_keys WHERE businessId=? AND offerId=?',[b,next.id])?.productKey||null;
            DB.run('DELETE FROM customer_catalog_keys WHERE businessId=? AND offerId=?',[b,next.id]);
            DB.run('INSERT INTO customer_catalog_keys(businessId,productKey,offerId) VALUES(?,?,?)',[b,item.productKey,next.id]);
            changes.push({offerId:next.id,revision:next.revision,previous:old||null,previousKey});
        }
        const receipt={status:plan.errors.length?'partial':'completed',added:changes.filter(c=>!c.previous).length,updated:changes.filter(c=>c.previous).length,skipped:plan.skipped,errors:plan.errors,published:body.publish,changes,committedAt:now};
        DB.run("UPDATE customer_catalog_imports SET status='committed',receiptJson=?,commitHash=?,idempotencyKey=? WHERE businessId=? AND id=?",[JSON.stringify(receipt),hash,body.idempotencyKey,b,id]);
        return {success:true,import:view(importRow(b,id))};
    }).immediate();
}
function rollback(auth,businessId,id){const b=authorize(auth,businessId,true);Store.ensureSchema();return DB.db.transaction(()=>{
    authorize(auth,b,true);const row=importRow(b,id);if(row.status==='rolled_back')return {success:true,import:view(row),replayed:true};
    if(row.status!=='committed')fail('CATALOG_IMPORT_NOT_COMMITTED',409);
    const receipt=JSON.parse(row.receiptJson);
    for(const c of receipt.changes)if(Store.Catalog.offer(b,c.offerId)?.revision!==c.revision)fail('CATALOG_ROLLBACK_CONFLICT',409);
    for(const c of receipt.changes){const current=Store.Catalog.offer(b,c.offerId),next=c.previous?{...c.previous,revision:current.revision+1}:{...current,active:false,publishedAt:null,revision:current.revision+1};
        Store.Catalog.saveOffer(b,next,current.revision);if(next.publishedAt)Store.Catalog.publishOffer(b,next);
        DB.run('DELETE FROM customer_catalog_keys WHERE businessId=? AND offerId=?',[b,c.offerId]);if(c.previousKey)DB.run('INSERT INTO customer_catalog_keys VALUES(?,?,?)',[b,c.previousKey,c.offerId]);}
    receipt.rolledBackAt=new Date().toISOString();DB.run("UPDATE customer_catalog_imports SET status='rolled_back',receiptJson=? WHERE businessId=? AND id=?",[JSON.stringify(receipt),b,id]);return {success:true,import:view(importRow(b,id))};
}).immediate();}
function get(auth,businessId,id){const b=authorize(auth,businessId);return {success:true,import:view(importRow(b,id))};}
module.exports={preview,validate,commit,rollback,get,authorize,_internals:{csv,checkZip,priceMinor,parse}};
