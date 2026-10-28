'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Service = require('../src/services/ava-knowledge-review.service');
const Native = require('../src/services/customer-native-knowledge.service');
const Local = require('../src/services/knowledge-local.service');
const RAG = require('../src/services/rag.service');
const { normalizeSearchText } = require('../src/utils/rag-normalizer');
const chat = '79990000000@c.us';
const flags = { assertEnabled(_businessId, key) { assert.strictEqual(key, 'knowledgeReview'); } };
function setup({ authority = true, onyx = false } = {}) {
    createTestDB(); Identity.ensureSchema(); DB.createSalesWorkspaceTables();
    DB.run("INSERT INTO instances(id,name,isActive) VALUES(1,'One',1),(2,'Two',1)");
    for (const [id, role, businessId] of [['owner','hotel_owner',1], ['lead','sales_lead',1], ['manager','manager',1], ['peer','manager',1], ['observer','observer',1], ['foreign','hotel_owner',2]]) {
        DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)', [id, id + '@example.test', id]);
        DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [id,businessId,role]);
    }
    DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,?,'Client','manager'),(1,'peer-client','Peer','peer'),(2,?,'Foreign','foreign')", [chat,chat]);
    Service.ensureSchema();
    DB.run("INSERT INTO messages(instanceId,chatId,senderName,role,content,channel) VALUES(1,?,'Client','user','Есть ли парковка?','whatsapp'),(1,'peer-client','Peer','user','Peer question','whatsapp'),(2,?,'Foreign','user','Secret foreign source','whatsapp')", [chat,chat]);
    let documentId, chunkId;
    if (authority) {
        documentId = Number(DB.run("INSERT INTO knowledge_base(instanceId,filename,originalName,contentHash) VALUES(1,'rules.txt','Business rules','rules-hash')").lastInsertRowid);
        chunkId = Number(DB.run('INSERT INTO kb_chunks(kbId,chunkIndex,text,searchText) VALUES(?,0,?,?)', [documentId,'Парковка бесплатная. Стоянка охраняемая.',normalizeSearchText('Парковка бесплатная. Стоянка охраняемая.')]).lastInsertRowid);
    }
    if (onyx) DB.run("INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,status) VALUES(1,'tenant-1','https://example.test/api','ACTIVE')");
    const actors = Object.fromEntries(['owner','lead','manager','peer','observer','foreign'].map(id => [id, Identity.actor(id)]));
    const adapter = { calls: [], async generatePlainText(messages, config, options) {
        this.calls.push({ messages, config, options });
        const input = JSON.parse(messages[1].content);
        if (input.candidateAnswer !== undefined && !authority) return JSON.stringify({passed:false,manualRequired:true,reason:'Новые сведения должен подтвердить владелец.',citations:[]});
        if (input.candidateAnswer !== undefined) return JSON.stringify({ passed:true, reason:'Supported by business rules.', citations:[{documentId,chunkId,quote:'Парковка бесплатная.'}] });
        return JSON.stringify({answer:'Парковка бесплатная.'});
    } };
    return { ...actors, documentId, chunkId, ai:adapter, options:{flags,ai:adapter}, source:{type:'message',id:'1',chatId:chat} };
}
async function draft(a, auth = a.manager, extra = {}) { return (await Service.createDraft(auth,1,{question:'Парковка?',source:a.source},{...a.options,...extra})).draft; }
async function checked(a, row) { return (await Service.checkDraft(a.lead,1,row.id,{revision:row.revision},a.options)).draft; }
function publish(a, row, extra = {}) { return Service.publishDraft(a.lead,1,row.id,{revision:row.revision,confirm:true},{...a.options,...extra}).draft; }
const throws = (fn,code) => assert.throws(fn,error => error.code === code);
const rejects = (fn,code) => assert.rejects(fn,error => error.code === code);
function deferred() { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise,resolve}; }

describe('AVA knowledge review: scoped grounded drafts and atomic publication', () => {
    it('fails closed when flags are missing/off and denies generation before provider call', async () => {
        const a=setup();
        throws(() => Service.list(a.owner,1,{}, {flags:{assertEnabled(){throw Object.assign(new Error(),{code:'FEATURE_DISABLED'});}}}), 'FEATURE_DISABLED');
        throws(() => Service.list(a.owner,1,{}, {flags:{}}), 'KNOWLEDGE_REVIEW_UNAVAILABLE');
        await rejects(() => draft(a,a.observer), 'CAPABILITY_DENIED');
        await rejects(() => draft(a,a.foreign), 'BUSINESS_ACCESS_DENIED');
        await rejects(() => Service.createDraft(a.manager,1,{question:'Q',source:{...a.source,id:'3'}},a.options), 'KNOWLEDGE_REVIEW_SOURCE_INVALID');
        await rejects(() => Service.createDraft(a.manager,1,{question:'Q',source:{...a.source,id:'2',chatId:'peer-client'}},a.options), 'SALES_CLIENT_SCOPE_DENIED');
        assert.strictEqual(a.ai.calls.length,0);
    });
    it('scopes live reads and manager edits to assigned clients and their own drafts', async () => {
        const a=setup(), row=await draft(a);
        assert.strictEqual(Service.list(a.manager,1,{},a.options).drafts.length,1);
        assert.strictEqual(Service.list(a.peer,1,{},a.options).drafts.length,0);
        assert.strictEqual(Service.list(a.observer,1,{},a.options).drafts.length,1);
        await rejects(() => Service.checkDraft(a.manager,1,row.id,{revision:row.revision},a.options),'CAPABILITY_DENIED');
        throws(() => Service.publishDraft(a.manager,1,row.id,{revision:row.revision,confirm:true},a.options),'CAPABILITY_DENIED');
        throws(() => Service.rollbackDraft(a.observer,1,row.id,{revision:row.revision,confirm:true},a.options),'CAPABILITY_DENIED');
        const ownerDraft=await draft(a,a.owner);
        throws(() => Service.updateDraft(a.manager,1,ownerDraft.id,{revision:1,answer:'Edit'},a.options),'KNOWLEDGE_REVIEW_DRAFT_SCOPE_DENIED');
        DB.run("UPDATE clients SET assigneeUserId='peer' WHERE instanceId=1 AND chatId=?",[chat]);
        assert.strictEqual(Service.list(a.manager,1,{},a.options).drafts.length,0);
        throws(() => Service.updateDraft(a.manager,1,row.id,{revision:1,answer:'Edit'},a.options),'SALES_CLIENT_SCOPE_DENIED');
    });
    it('generates from real call transcript and resolves existing canonical aliases', async () => {
        const a=setup();
        DB.createConversationEvent({instanceId:1,chatId:chat,eventId:'call-source',callId:'call-1',channel:'voice',content:'Parking discussion'});
        DB.run('INSERT INTO ava_call_transcript_sources(businessId,chatId,sourceId,text,sourceHash,timestamp) VALUES(1,?,?,?,?,?)',[chat,'call-source','Client: парковка? Team: парковка бесплатная.','transcript-hash',new Date().toISOString()]);
        require('../src/services/client-identity.service').attach(1,chat,{kind:'telegram',value:'1234567'});
        const row=(await Service.createDraft(a.manager,1,{question:'Парковка?',source:{type:'call',id:'call-source',chatId:'tg_1234567'}},a.options)).draft;
        assert.strictEqual(row.source.chatId,chat);
        assert.strictEqual(row.source.id,'call-source'); assert(a.ai.calls[0].messages[1].content.includes('Team:'));
        assert.strictEqual(Service.list(a.manager,1,{},a.options).candidates.filter(x=>x.source.type==='call').length,1);
        await rejects(() => Service.createDraft(a.manager,1,{question:'Q',source:{type:'call',id:'call-1',chatId:chat}},a.options),'KNOWLEDGE_REVIEW_SOURCE_INVALID');
    });
    it('invalidates edited checks, requires human confirmation, and publishes actual retrieval chunks', async () => {
        const a=setup(); let row=await checked(a,await draft(a));
        assert.strictEqual(row.check.passed,true); assert.strictEqual(row.check.revision,row.revision);
        row=Service.updateDraft(a.manager,1,row.id,{revision:row.revision,answer:'Парковка бесплатная. Стоянка охраняемая.'},a.options).draft;
        assert.strictEqual(row.check,null); assert.strictEqual(row.approval,null); assert.strictEqual(row.status,'draft');
        throws(() => publish(a,row),'KNOWLEDGE_REVIEW_CHECK_REQUIRED');
        row=await checked(a,row);
        throws(() => Service.publishDraft(a.lead,1,row.id,{revision:row.revision},a.options),'KNOWLEDGE_REVIEW_CONFIRMATION_REQUIRED');
        row=publish(a,row); assert.strictEqual(row.sync.state,'local_only'); assert.strictEqual(row.approval.type,'ai_grounded'); assert.strictEqual(row.approval.revision,row.check.revision);
        const chunks=DB.getDocumentChunks(1,row.currentDocumentId); assert.strictEqual(chunks.length,1); assert(chunks[0].text.includes('Стоянка охраняемая.'));
        const keyword=await RAG.searchKeyword(1,'Стоянка',12); assert(keyword.some(x=>x.kbId===row.currentDocumentId));
        const local=await Local.lookup(1,'Стоянка'); assert(local.answer.includes('Стоянка')); assert(local.citations.length);
        // Isolate the approved artifact in retrieval; the independent source was used for its check.
        DB.run('UPDATE knowledge_base SET isCurrent=0 WHERE id=?',[a.documentId]);
        const voice=await RAG.answerFromKnowledge(1,'Стоянка',{channel:'voice',searchType:'keyword'});
        assert.strictEqual(voice.spoken,'Стоянка охраняемая.'); assert.strictEqual(voice.answer,voice.spoken);
        assert(voice.citations.some(citation=>Number(citation.document_id)===row.currentDocumentId));
        const textAnswer=await RAG.answerFromKnowledge(1,'Стоянка',{channel:'text',searchType:'keyword'});
        assert.strictEqual(textAnswer.answer,voice.spoken);
        assert.strictEqual(DB.get('SELECT chunkCount,hasEmbeddings FROM knowledge_base WHERE id=?',[row.currentDocumentId]).hasEmbeddings,0);
        throws(() => publish(a,row),'KNOWLEDGE_REVIEW_CHECK_REQUIRED');
    });
    it('requires actual authoritative chunk quotations and excludes its own prior publication', async () => {
        const a=setup(); let row=publish(a,await checked(a,await draft(a)));
        row=Service.updateDraft(a.manager,1,row.id,{revision:row.revision,answer:'Парковка платная.'},a.options).draft;
        const original=a.ai.generatePlainText;
        a.ai.generatePlainText=async function(messages) {
            const input=JSON.parse(messages[1].content);
            assert(!input.authoritativeKnowledge.some(x=>x.documentId===row.currentDocumentId));
            return JSON.stringify({passed:true,reason:'I agree',citations:[{documentId:row.currentDocumentId,chunkId:999,quote:'Парковка платная.'}]});
        };
        row=await checked(a,row); assert.strictEqual(row.check.passed,false); assert.strictEqual(row.check.code,'KNOWLEDGE_REVIEW_AI_UNGROUNDED');
        throws(()=>publish(a,row),'KNOWLEDGE_REVIEW_CHECK_REQUIRED');
        a.ai.generatePlainText=async()=>JSON.stringify({passed:true,reason:'Yes',citations:[]});
        row=await checked(a,row); assert.strictEqual(row.check.passed,false);
        a.ai.generatePlainText=original;
    });
    it('stores finite timeout/unavailable check results and cannot approve without authority', async () => {
        const a=setup(); let row=await draft(a);
        row=(await Service.checkDraft(a.lead,1,row.id,{revision:row.revision},{...a.options,timeoutMs:15,ai:{generatePlainText:()=>new Promise(()=>{})}})).draft;
        assert.strictEqual(row.check.status,'timeout'); assert.strictEqual(row.check.passed,false);
        row=(await Service.checkDraft(a.lead,1,row.id,{revision:row.revision},{...a.options,ai:{generatePlainText:async()=>{throw new Error('Provider private detail');}}})).draft;
        assert.strictEqual(row.check.status,'unavailable'); assert(!JSON.stringify(row).includes('Provider private detail'));
        const b=setup({authority:false}); row=await draft(b); row=await checked(b,row);
        assert.strictEqual(row.check.status,'manual_required'); assert.strictEqual(row.check.passed,false); assert.strictEqual(row.check.needsConfirmation,true); assert.strictEqual(b.ai.calls.length,2);
    });
    it('fences source edits, corpus edits, assignment changes and revocation during slow AI', async () => {
        for(const mode of ['source','corpus','assignment','revocation']) {
            const a=setup(), gate=deferred(), begun=deferred();
            a.options.ai={generatePlainText:()=>{begun.resolve();return gate.promise;}};
            const request=draft(a); await begun.promise;
            if(mode==='source') DB.run("UPDATE messages SET content='Changed' WHERE id=1");
            if(mode==='corpus') DB.run("UPDATE kb_chunks SET text='Different authority' WHERE id=?",[a.chunkId]);
            if(mode==='assignment') DB.run("UPDATE clients SET assigneeUserId='peer' WHERE instanceId=1 AND chatId=?",[chat]);
            if(mode==='revocation') DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='manager'");
            gate.resolve(JSON.stringify({answer:'Parking'}));
            await assert.rejects(()=>request,error=>['KNOWLEDGE_REVIEW_SOURCE_CHANGED','KNOWLEDGE_REVIEW_KNOWLEDGE_CHANGED','SALES_CLIENT_SCOPE_DENIED','BUSINESS_ACCESS_DENIED'].includes(error.code));
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_knowledge_review_drafts').n,0);
        }
    });
    it('does not save obsolete AI checks after a concurrent edit, revoked lead, or changed corpus', async () => {
        for(const mode of ['draft','lead','corpus','source']) {
            const a=setup(), row=await draft(a), gate=deferred(), begun=deferred();
            const request=Service.checkDraft(a.lead,1,row.id,{revision:1},{...a.options,ai:{generatePlainText:()=>{begun.resolve();return gate.promise;}}});
            await begun.promise;
            if(mode==='draft') Service.updateDraft(a.manager,1,row.id,{revision:1,answer:'Edited'},a.options);
            if(mode==='lead') DB.run("UPDATE ava_business_memberships SET role='manager' WHERE userId='lead'");
            if(mode==='corpus') DB.run("UPDATE kb_chunks SET text='changed' WHERE id=?",[a.chunkId]);
            if(mode==='source') DB.run("UPDATE messages SET content='changed' WHERE id=1");
            gate.resolve(JSON.stringify({passed:true,reason:'supported',citations:[{documentId:a.documentId,chunkId:a.chunkId,quote:'Парковка бесплатная.'}]}));
            await assert.rejects(()=>request,error=>['KNOWLEDGE_REVIEW_REVISION_CONFLICT','CAPABILITY_DENIED','KNOWLEDGE_REVIEW_KNOWLEDGE_CHANGED','KNOWLEDGE_REVIEW_SOURCE_CHANGED'].includes(error.code));
            assert.strictEqual(DB.get('SELECT checkJson FROM ava_knowledge_review_drafts WHERE id=?',[row.id]).checkJson,null);
        }
    });
    it('uses durable operation keys across module reload and prevents conflicting/pending replays', async () => {
        const a=setup(); const row=await draft(a,a.manager,{idempotencyKey:'create-1'});
        assert.strictEqual((await draft(a,a.manager,{idempotencyKey:'create-1'})).id,row.id); assert.strictEqual(a.ai.calls.length,1);
        const reordered=await Service.createDraft(a.manager,1,{source:{chatId:chat,id:'1',type:'message'},question:'Парковка?'},{...a.options,idempotencyKey:'create-1'});
        assert.strictEqual(reordered.draft.id,row.id); assert.strictEqual(a.ai.calls.length,1);
        await rejects(()=>Service.createDraft(a.manager,1,{question:'Different',source:a.source},{...a.options,idempotencyKey:'create-1'}),'KNOWLEDGE_REVIEW_IDEMPOTENCY_CONFLICT');
        let checkedRow=await checked(a,row);
        const result=publish(a,checkedRow,{idempotencyKey:'publish-1'});
        delete require.cache[require.resolve('../src/services/ava-knowledge-review.service')];
        const reloaded=require('../src/services/ava-knowledge-review.service');
        const repeated=reloaded.publishDraft(a.lead,1,checkedRow.id,{revision:checkedRow.revision,confirm:true},{...a.options,idempotencyKey:'publish-1'});
        assert.strictEqual(repeated.draft.revision,result.revision); assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM knowledge_base WHERE id=?',[result.currentDocumentId]).n,1);
        const b=setup(), gate=deferred(), begun=deferred();
        b.options.ai={generatePlainText:()=>{begun.resolve();return gate.promise;}};
        const pending=draft(b,b.manager,{idempotencyKey:'pending'}); await begun.promise;
        await rejects(()=>draft(b,b.manager,{idempotencyKey:'pending'}),'KNOWLEDGE_REVIEW_OPERATION_PENDING');
        gate.resolve(JSON.stringify({answer:'Parking'})); await pending;
    });
    it('rolls back durably to earlier published content while retaining revisions and one stable document', async () => {
        const a=setup({onyx:true}); let row=publish(a,await checked(a,await draft(a)));
        const first=row.history.find(x=>x.kind==='published'), documentId=row.currentDocumentId;
        row=Service.updateDraft(a.manager,1,row.id,{revision:row.revision,answer:'Парковка бесплатная. Стоянка охраняемая.'},a.options).draft;
        row=publish(a,await checked(a,row));
        assert.strictEqual(row.currentDocumentId,documentId);
        row=Service.rollbackDraft(a.lead,1,row.id,{revision:row.revision,confirm:true,versionId:first.id},a.options).draft;
        assert.strictEqual(row.answer,'Парковка бесплатная.'); assert.strictEqual(row.check,null);
        assert.strictEqual(row.history[0].restoredVersionId,first.id);
        assert.strictEqual(row.history.filter(x=>x.kind==='published').length,2);
        const content=DB.getDocumentChunks(1,documentId)[0].text; assert(!content.includes('Стоянка охраняемая'));
        const pending=DB.all("SELECT * FROM onyx_sync_outbox WHERE source_id=? AND status='PENDING'",[documentId]);
        assert.strictEqual(pending.length,1); assert.strictEqual(JSON.parse(pending[0].payload_json).content,content);
        assert(DB.get("SELECT COUNT(*) AS n FROM onyx_sync_outbox WHERE source_id=? AND status='DEAD'",[documentId]).n>=1);
        const keyword=await RAG.searchKeyword(1,'Стоянка',12); assert(!keyword.some(x=>x.kbId===documentId));
        const voice=await RAG.answerFromKnowledge(1,'Парковка',{channel:'voice',searchType:'keyword'});
        assert.strictEqual(voice.spoken,'Парковка бесплатная.');
        assert(voice.citations.some(citation=>Number(citation.document_id)===documentId));
        const currentText=await Local.lookup(1,'Парковка'); assert.strictEqual(currentText.answer,'Парковка бесплатная.');
    });
    it('rejects external document edits/deletions and stale authority before publishing/rollback', async () => {
        const a=setup(); let row=publish(a,await checked(a,await draft(a)));
        row=Service.updateDraft(a.manager,1,row.id,{revision:row.revision,answer:'Parking'},a.options).draft;
        DB.run("UPDATE knowledge_base SET contentHash='external-change' WHERE id=?",[row.currentDocumentId]);
        await rejects(()=>checked(a,row),'KNOWLEDGE_REVIEW_DOCUMENT_CHANGED');
        throws(()=>Service.rollbackDraft(a.lead,1,row.id,{revision:row.revision,confirm:true},a.options),'KNOWLEDGE_REVIEW_ROLLBACK_UNAVAILABLE');
        const b=setup(); const candidate=await checked(b,await draft(b));
        DB.run("UPDATE kb_chunks SET text='Changed policy' WHERE id=?",[b.chunkId]);
        throws(()=>publish(b,candidate),'KNOWLEDGE_REVIEW_KNOWLEDGE_CHANGED');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM knowledge_base').n,1);
        const c=setup(); let deleted=publish(c,await checked(c,await draft(c)));
        const previous=deleted.history.find(item=>item.kind==='published');
        deleted=Service.updateDraft(c.manager,1,deleted.id,{revision:deleted.revision,answer:'Парковка бесплатная. Стоянка охраняемая.'},c.options).draft;
        deleted=publish(c,await checked(c,deleted));
        await DB.deleteKnowledgeBaseFile(deleted.currentDocumentId,1);
        await rejects(()=>checked(c,deleted),'KNOWLEDGE_REVIEW_DOCUMENT_CHANGED');
        throws(()=>Service.rollbackDraft(c.owner,1,deleted.id,{revision:deleted.revision,confirm:true,versionId:previous.id},c.options),'KNOWLEDGE_REVIEW_DOCUMENT_CHANGED');
        assert.strictEqual(DB.get('SELECT id FROM knowledge_base WHERE id=?',[deleted.currentDocumentId]),undefined);
    });
    it('rolls back the entire publication if native sync fails or an old sync is processing', async () => {
        const a=setup({onyx:true}); let row=publish(a,await checked(a,await draft(a)));
        const documentId=row.currentDocumentId, original=DB.getDocumentChunks(1,documentId)[0].text;
        row=Service.updateDraft(a.manager,1,row.id,{revision:row.revision,answer:'Парковка бесплатная. Стоянка охраняемая.'},a.options).draft;
        row=await checked(a,row);
        DB.run("UPDATE onyx_sync_outbox SET status='PROCESSING' WHERE source_id=?",[documentId]);
        throws(()=>publish(a,row),'DOCUMENT_SYNC_IN_PROGRESS');
        assert.strictEqual(DB.getDocumentChunks(1,documentId)[0].text,original);
        assert.strictEqual(DB.get('SELECT revision FROM ava_knowledge_review_drafts WHERE id=?',[row.id]).revision,row.revision);
        DB.run("UPDATE onyx_sync_outbox SET status='PENDING' WHERE source_id=?",[documentId]);
        const enqueue=Native.enqueue; Native.enqueue=()=>{throw Object.assign(new Error('failure'),{code:'SYNC_FAILED'});};
        try { throws(()=>publish(a,row),'SYNC_FAILED'); assert.strictEqual(DB.getDocumentChunks(1,documentId)[0].text,original); }
        finally { Native.enqueue=enqueue; }
        row=publish(a,row); assert.strictEqual(row.sync.state,'processing');
    });
    it('reports native needs_sync until the exact current stable document hash is admitted', async () => {
        const a=setup({onyx:true});
        DB.run(`INSERT INTO ava_module_deployments(id,businessId,module,namespace,state,revision,correlationId,createdAt,updatedAt)
            VALUES('native-test',1,'onyx','tenant-1','verified',1,'test-correlation',?,?)`,[Date.now(),Date.now()]);
        DB.db.exec(`CREATE TABLE onyx_native_runtime_document_links (
            business_id INTEGER,entity_type TEXT,source_id INTEGER,deployment_id TEXT,deployment_revision INTEGER,
            content_hash TEXT,onyx_document_id TEXT)`);
        let row=publish(a,await checked(a,await draft(a)));
        assert.deepStrictEqual(row.sync,{state:'needs_sync',queued:false});
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM onyx_sync_outbox').n,0);
        const hash=DB.get('SELECT contentHash FROM knowledge_base WHERE id=?',[row.currentDocumentId]).contentHash;
        DB.run(`INSERT INTO onyx_native_runtime_document_links VALUES(1,'knowledge',?,'native-test',1,?,?)`,[row.currentDocumentId,hash,`ava:1:knowledge:${row.currentDocumentId}`]);
        assert.strictEqual(Native.status(1).documents.find(document=>document.id===row.currentDocumentId).state,'submitted');
        row=Service.updateDraft(a.manager,1,row.id,{revision:row.revision,answer:'Парковка бесплатная. Стоянка охраняемая.'},a.options).draft;
        row=publish(a,await checked(a,row));
        assert.strictEqual(row.sync.state,'needs_sync');
        assert.strictEqual(Native.status(1).documents.find(document=>document.id===row.currentDocumentId).state,'needs_sync');
        DB.run("UPDATE ava_module_deployments SET state='quarantined' WHERE id='native-test'");
        row=Service.updateDraft(a.manager,1,row.id,{revision:row.revision,answer:'Парковка бесплатная.'},a.options).draft;
        row=await checked(a,row);
        const before=DB.getDocumentChunks(1,row.currentDocumentId)[0].text;
        throws(()=>publish(a,row),'ONYX_NATIVE_DEPLOYMENT_NOT_READY');
        assert.strictEqual(DB.getDocumentChunks(1,row.currentDocumentId)[0].text,before);
    });
    it('removes obsolete real sqlite-vec rows atomically when replacing or rolling back chunks', async () => {
        const a=setup(); require('sqlite-vec').load(DB.db);
        DB.db.exec(`CREATE VIRTUAL TABLE kb_chunks_vec USING vec0(instanceId INTEGER PARTITION KEY,
            embedding float[2],+chunkId INTEGER,+kbId INTEGER,+originalName TEXT)`);
        let row=publish(a,await checked(a,await draft(a)));
        const first=row.history.find(item=>item.kind==='published'), oldChunk=DB.getDocumentChunks(1,row.currentDocumentId)[0];
        DB.run('INSERT INTO kb_chunks_vec(instanceId,embedding,chunkId,kbId,originalName) VALUES(?,?,?,?,?)',[1n,Buffer.from(new Float32Array([1,0]).buffer),BigInt(oldChunk.id),BigInt(row.currentDocumentId),'review']);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM kb_chunks_vec').n,1);
        row=Service.updateDraft(a.manager,1,row.id,{revision:row.revision,answer:'Парковка бесплатная. Стоянка охраняемая.'},a.options).draft;
        row=publish(a,await checked(a,row));
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM kb_chunks_vec').n,0);
        const currentChunk=DB.getDocumentChunks(1,row.currentDocumentId)[0];
        DB.run('INSERT INTO kb_chunks_vec(instanceId,embedding,chunkId,kbId,originalName) VALUES(?,?,?,?,?)',[1n,Buffer.from(new Float32Array([0,1]).buffer),BigInt(currentChunk.id),BigInt(row.currentDocumentId),'review']);
        row=Service.rollbackDraft(a.lead,1,row.id,{revision:row.revision,confirm:true,versionId:first.id},a.options).draft;
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM kb_chunks_vec').n,0);
        assert.strictEqual(DB.getDocumentChunks(1,row.currentDocumentId).length,1);
        assert.strictEqual(DB.get('SELECT hasEmbeddings FROM knowledge_base WHERE id=?',[row.currentDocumentId]).hasEmbeddings,0);
    });
    it('survives a physical SQLite reopen with publish replay and preserved rollback history', async () => {
        const fs=require('fs'), os=require('os'), path=require('path'), Database=require('better-sqlite3');
        const a=setup({onyx:true}); let row=await checked(a,await draft(a));
        const request={revision:row.revision,confirm:true};
        row=publish(a,row,{idempotencyKey:'physical-publication'});
        const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ava-review-reopen-')),file=path.join(directory,'review.sqlite'),original=DB.db;
        await original.backup(file); DB.db=new Database(file); DB.db.pragma('foreign_keys=ON');
        try {
            const replay=Service.publishDraft(a.lead,1,row.id,request,{...a.options,idempotencyKey:'physical-publication'}).draft;
            assert.strictEqual(replay.revision,row.revision);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM onyx_sync_outbox').n,1);
            row=Service.updateDraft(a.manager,1,row.id,{revision:row.revision,answer:'Парковка бесплатная. Стоянка охраняемая.'},a.options).draft;
            row=publish(a,await checked(a,row));
            const restored=Service.rollbackDraft(a.lead,1,row.id,{revision:row.revision,confirm:true},a.options).draft;
            assert.strictEqual(restored.answer,'Парковка бесплатная.'); assert(restored.history[0].restoredVersionId);
            const voice=await RAG.answerFromKnowledge(1,'Парковка',{channel:'voice',searchType:'keyword'});
            assert.strictEqual(voice.spoken,'Парковка бесплатная.');
        } finally { DB.db.close(); DB.db=original; fs.rmSync(directory,{recursive:true,force:true}); }
    });
    it('publishes a checked revision only once and rejects stale source and foreign rollback targets', async () => {
        const a=setup(); let row=await checked(a,await draft(a));
        const revision=row.revision; row=publish(a,row);
        throws(()=>Service.publishDraft(a.owner,1,row.id,{revision,confirm:true},a.options),'KNOWLEDGE_REVIEW_REVISION_CONFLICT');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM knowledge_base').n,2);
        throws(()=>Service.rollbackDraft(a.lead,1,row.id,{revision:row.revision,confirm:true,versionId:'foreign-version'},a.options),'KNOWLEDGE_REVIEW_ROLLBACK_UNAVAILABLE');
        row=Service.updateDraft(a.manager,1,row.id,{revision:row.revision,answer:'Парковка бесплатная. Стоянка охраняемая.'},a.options).draft;
        row=await checked(a,row); DB.run("UPDATE messages SET content='Changed source' WHERE id=1");
        throws(()=>publish(a,row),'KNOWLEDGE_REVIEW_SOURCE_CHANGED');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM knowledge_base').n,2);
    });
    it('requires exact human attestation for empty knowledge, a new fact, and contradictory authority', async () => {
        for (const scenario of ['empty','new_fact','contradiction']) {
            const a=setup({authority:scenario!=='empty'}); let row=await draft(a);
            const proposed=scenario==='contradiction'?'Парковка платная.':scenario==='new_fact'?'Парковка работает круглосуточно.':'Парковка бесплатная.';
            row=Service.updateDraft(a.manager,1,row.id,{revision:row.revision,answer:proposed},a.options).draft;
            const ai={generatePlainText:async()=>JSON.stringify({passed:false,manualRequired:true,reason:'Владелец должен лично подтвердить новые условия.',citations:scenario==='contradiction'?[{documentId:a.documentId,chunkId:a.chunkId,quote:'Парковка бесплатная.'}]:[]})};
            row=(await Service.checkDraft(a.lead,1,row.id,{revision:row.revision},{...a.options,ai})).draft;
            assert.strictEqual(row.status,'draft'); assert.strictEqual(row.check.status,'manual_required');
            assert.strictEqual(row.check.passed,false); assert.strictEqual(row.check.needsConfirmation,true);
            assert.strictEqual(row.approval,null); assert(/^[a-f0-9]{64}$/.test(row.check.contentHash));
            throws(()=>publish(a,row),'KNOWLEDGE_REVIEW_ATTESTATION_REQUIRED');
            const attestation={confirm:true,revision:row.check.revision,contentHash:row.check.contentHash,sourceHash:row.check.sourceHash};
            for(const patch of [{confirm:false},{revision:row.revision-1},{contentHash:'forged'},{sourceHash:'forged'}]) {
                throws(()=>Service.publishDraft(a.lead,1,row.id,{revision:row.revision,confirm:true,attestation:{...attestation,...patch}},a.options),'KNOWLEDGE_REVIEW_ATTESTATION_INVALID');
            }
            throws(()=>Service.publishDraft(a.manager,1,row.id,{revision:row.revision,confirm:true,attestation},a.options),'CAPABILITY_DENIED');
            row=Service.publishDraft(a.lead,1,row.id,{revision:row.revision,confirm:true,attestation},a.options).draft;
            assert.strictEqual(row.approval.type,'human_confirmed'); assert.strictEqual(row.approval.userId,'lead');
            assert.strictEqual(row.check.passed,false); assert.strictEqual(row.check.status,'manual_required');
            assert.deepStrictEqual(row.history[0].approval,row.approval);
            assert(DB.getDocumentChunks(1,row.currentDocumentId)[0].text.includes(proposed));
            const voice=await RAG.answerFromKnowledge(1,'Парковка?',{channel:'voice',searchType:'keyword'});
            const local=await Local.lookup(1,'Парковка?');
            assert.strictEqual(voice.spoken,proposed); assert.strictEqual(local.answer,proposed);
            assert(voice.citations.some(citation=>Number(citation.document_id)===row.currentDocumentId));
            assert.strictEqual(Number(local.citations[0].source_id),row.currentDocumentId);
        }
    });
    it('cannot use human attestation to bypass provider errors, timeouts, malformed or contradictory verdicts', async () => {
        for(const response of ['error','timeout','malformed','invalid_citations','passed_and_manual']) {
            const a=setup({authority:false}); let row=await draft(a);
            const adapter={generatePlainText:async()=> {
                if(response==='error') throw new Error('Provider down');
                if(response==='timeout') return new Promise(()=>{});
                if(response==='malformed') return '{broken';
                if(response==='passed_and_manual') return JSON.stringify({passed:true,manualRequired:true,reason:'Conflicting verdict',citations:[]});
                return JSON.stringify({passed:false,manualRequired:true,reason:'New facts',citations:[null]});
            }};
            row=(await Service.checkDraft(a.lead,1,row.id,{revision:row.revision},{...a.options,ai:adapter,timeoutMs:10})).draft;
            assert.strictEqual(row.check.passed,false); assert.strictEqual(row.check.needsConfirmation,false);
            assert.strictEqual(row.check.status,response==='timeout'?'timeout':'unavailable');
            const attestation={confirm:true,revision:row.revision,contentHash:row.check.contentHash,sourceHash:row.check.sourceHash};
            throws(()=>Service.publishDraft(a.owner,1,row.id,{revision:row.revision,confirm:true,attestation},a.options),'KNOWLEDGE_REVIEW_CHECK_REQUIRED');
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM knowledge_base').n,0);
        }
    });
    it('clears edited human approvals and restores their original provenance through rollback', async () => {
        const a=setup({authority:false}); let row=await checked(a,await draft(a));
        const attestation={confirm:true,revision:row.check.revision,contentHash:row.check.contentHash,sourceHash:row.check.sourceHash};
        row=Service.publishDraft(a.owner,1,row.id,{revision:row.revision,confirm:true,attestation},a.options).draft;
        const first=row.history.find(item=>item.kind==='published'), originalApproval=row.approval;
        assert.strictEqual(originalApproval.userId,'owner');
        row=Service.updateDraft(a.manager,1,row.id,{revision:row.revision,answer:'Парковка платная.'},a.options).draft;
        assert.strictEqual(row.approval,null); assert.strictEqual(row.check,null);
        throws(()=>Service.publishDraft(a.owner,1,row.id,{revision:row.revision,confirm:true,attestation},a.options),'KNOWLEDGE_REVIEW_CHECK_REQUIRED');
        row=await checked(a,row);
        row=Service.publishDraft(a.lead,1,row.id,{revision:row.revision,confirm:true,attestation:{confirm:true,revision:row.check.revision,contentHash:row.check.contentHash,sourceHash:row.check.sourceHash}},a.options).draft;
        assert.strictEqual(row.approval.userId,'lead');
        row=Service.rollbackDraft(a.lead,1,row.id,{revision:row.revision,confirm:true,versionId:first.id},a.options).draft;
        assert.deepStrictEqual(row.approval,originalApproval); assert.strictEqual(row.history[0].actorUserId,'lead');
        assert.strictEqual(row.history[0].restoredVersionId,first.id); assert.deepStrictEqual(row.history[0].approval,originalApproval);
        assert.strictEqual(row.answer,'Парковка бесплатная.'); assert.strictEqual(row.check,null);
    });
});
