// Opt-in integration: actual frontend Axios wrappers -> actual backend routers/services.
// Run with AVA_BACKEND_ROOT=/absolute/path/to/whatsapp_crm node tests/WorkspaceImprovements.integration.mjs
// Only SQLite :memory:, synthetic identities and injected AI; never start app.js.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert(process.env.AVA_BACKEND_ROOT, 'Set AVA_BACKEND_ROOT to the assembled backend checkout');
const backend = path.resolve(process.env.AVA_BACKEND_ROOT);
const requireBackend = createRequire(path.join(backend, 'package.json'));
const temporary = await mkdtemp(path.join(tmpdir(), 'ava-improvements-http-'));
process.env.AVA_IMPROVEMENTS_BUSINESSES = '1';
process.env.AVA_WORKSPACE_BUSINESSES = '*';
const DB = requireBackend('./src/services/database.service');
const Identity = requireBackend('./src/services/identity/identity-store');
const AI = requireBackend('./src/services/ai.service');
const Channel = requireBackend('./src/services/channel-router.service');
const originalAI = AI.generatePlainText, originalSend = Channel.sendMessageDetailed;
const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
const results = [], counts = { ai: 0, sends: 0 };
let server;
async function check(name, fn) {
    await fn(); results.push({ name, passed: true }); console.log('PASS ' + name);
}
function rejected(code, status) {
    return error => error.response?.data?.code === code && error.response?.status === status;
}

try {
    requireBackend('./tests/test-helper').createTestDB();
    Identity.ensureSchema(); DB.createSalesWorkspaceTables();
    requireBackend('./src/services/ava-workspace.store').ensureSchema();
    requireBackend('./src/services/ava-autopilot.store').ensureSchema();
    const Review = requireBackend('./src/services/ava-knowledge-review.service');
    Review.ensureSchema();
    DB.run("INSERT INTO instances(id,name,isActive,aiProvider,yandexGptKey,yandexGptModelUri) VALUES(1,'Synthetic business',1,'yandex','synthetic-key','gpt://synthetic/model'),(2,'Foreign business',1,'yandex','synthetic-key','gpt://synthetic/model')");
    for (const [id, role, businessId] of [['owner','hotel_owner',1],['lead','sales_lead',1],['manager','manager',1],['observer','observer',1],['foreign','hotel_owner',2]]) {
        DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)', [id,id+'@example.test',id]);
        DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [id,businessId,role]);
    }
    const chat = 'guest/a'; // Deliberately requires path encoding in frontend transport.
    DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,?,'Synthetic client','manager'),(1,'queue','Unassigned',NULL),(2,?,'Foreign client','foreign')", [chat,chat]);
    const messageId = Number(DB.run("INSERT INTO messages(instanceId,chatId,senderName,role,content,channel) VALUES(1,?,'Synthetic client','user','Есть ли парковка?','whatsapp')", [chat]).lastInsertRowid);
    const documentId = Number(DB.run("INSERT INTO knowledge_base(instanceId,filename,originalName,contentHash) VALUES(1,'rules.txt','Business rules','rules-hash')").lastInsertRowid);
    const chunkId = Number(DB.run('INSERT INTO kb_chunks(kbId,chunkIndex,text,searchText) VALUES(?,0,?,?)', [documentId,'Парковка бесплатная.',requireBackend('./src/utils/rag-normalizer').normalizeSearchText('Парковка бесплатная.')]).lastInsertRowid);
    AI.generatePlainText = async () => {
        counts.ai++;
        return JSON.stringify({text:'Здравствуйте! Парковка бесплатная.',sourceIds:['message:'+messageId,'knowledge:'+chunkId]});
    };
    Channel.sendMessageDetailed = async () => { counts.sends++; throw Error('Unexpected channel send'); };
    globalThis.fetch = async () => { throw Error('Unexpected external fetch'); };
    const syntheticAI = { async generatePlainText(messages) {
        counts.ai++;
        const input = JSON.parse(messages[1].content);
        if (input.candidateAnswer === undefined) return JSON.stringify({answer:'Парковка бесплатная.'});
        if (input.candidateAnswer.includes('воскресенье')) return JSON.stringify({passed:false,manualRequired:true,reason:'Новые сведения должен подтвердить владелец.',citations:[]});
        return JSON.stringify({passed:true,reason:'Подтверждено правилами.',citations:[{documentId,chunkId,quote:'Парковка бесплатная.'}]});
    } };
    const reviewAdapter = {authorize:(auth,id)=>Review.authorize(auth,id,'sales.read')};
    for (const name of ['list','createDraft','updateDraft','checkDraft','publishDraft','rollbackDraft']) {
        reviewAdapter[name] = (...args) => {
            args[args.length-1] = {...args.at(-1),ai:syntheticAI};
            return Review[name](...args);
        };
    }
    const app = requireBackend('express')();
    app.use(requireBackend('express').json());
    // Test authentication only; authorization still uses actual live memberships.
    app.use((req,_res,next)=>{ req.auth={userId:req.get('X-Test-User') || 'owner'}; next(); });
    for (const router of ['ava-workspace','ava-improvements-flags','ava-collaboration','ava-availability','ava-attention','ava-copilot']) app.use('/api',requireBackend('./src/routes/'+router+'.routes'));
    app.use('/api',requireBackend('./src/routes/ava-knowledge-review.routes').createRouter(reviewAdapter));
    server = await new Promise(resolve => { const listening=app.listen(0,'127.0.0.1',()=>resolve(listening)); });
    const origin = 'http://127.0.0.1:'+server.address().port;
    process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
    const bundle = path.join(temporary,'transport.mjs');
    await build({stdin:{contents:"export { api } from './src/api'; export * from './src/improvementsApi'; export { getWorkday, getClientWorkspace, workspaceError } from './src/avaWorkspace';",resolveDir:frontend,loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:bundle,banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"}});
    const F = await import(pathToFileURL(bundle));
    F.api.defaults.baseURL = origin+'/api'; F.api.defaults.proxy=false;
    F.api.defaults.headers.common.Origin = origin;
    globalThis.window = {dispatchEvent(){}}; // Only browser auth-event interceptor for denied requests.
    let flags, revision, draft, publishedVersion;
    await check('real scoped feature flags and independent compare-and-swap toggle',async()=>{
        flags=await F.getFeatures(1); assert.equal(flags.available,true); assert(Object.values(flags.flags).every(Boolean));
        const off=await F.updateFeatures(1,flags.revision,{copilot:false});
        assert.equal(off.flags.copilot,false); assert.equal(off.flags.knowledgeReview,true);
        await assert.rejects(()=>F.updateFeatures(1,flags.revision,{attention:false}),rejected('WORKSPACE_FEATURES_REVISION_CONFLICT',409));
        flags=await F.updateFeatures(1,off.revision,{copilot:true});
    });
    await check('queue/detail/presence share a real dialogue revision and encoded client ID',async()=>{
        const workday=await F.getWorkday(1,'team',1); assert(Array.isArray(workday.items));
        const detail=await F.getClientWorkspace(1,chat); revision=detail.dialogueRevision; assert.equal(typeof revision,'string');
        F.api.defaults.headers.common['X-Test-User']='manager';
        const presence=await F.postPresence(1,chat,{sessionId:'frontend-http-test',typing:true});
        assert.equal(presence.dialogueRevision,revision); assert(presence.participants.some(p=>p.userId==='manager'&&p.typing));
        assert.equal((await F.getPresence(1,chat)).dialogueRevision,revision);
        F.api.defaults.headers.common['X-Test-User']='owner';
    });
    await check('manager self status omits capacity; owner can set capacity',async()=>{
        let member=(await F.getAvailability(1)).members.find(m=>m.userId==='manager'); assert(member);
        F.api.defaults.headers.common['X-Test-User']='manager';
        member=(await F.updateAvailability(1,'manager',{revision:member.revision,status:'break'})).member; assert.equal(member.status,'break');
        F.api.defaults.headers.common['X-Test-User']='owner';
        member=(await F.updateAvailability(1,'manager',{revision:member.revision,status:'available',capacity:4})).member; assert.equal(member.capacity,4);
    });
    await check('real attention envelope accepted by runtime validator',async()=>{
        const attention=await F.getAttention(1); assert.equal(attention.counts.returned,attention.items.length);
        assert(attention.items.every(item=>item.href.startsWith('/')));
    });
    await check('grounded copilot draft matches current revision and makes no send',async()=>{
        const before=DB.get('SELECT COUNT(*) AS n FROM messages').n;
        const response=await F.generateCopilot(1,chat,'reply'); assert.equal(response.dialogueRevision,revision);
        assert.equal(response.draft.kind,'reply'); assert(response.draft.sources.some(s=>s.type==='knowledge'));
        assert.equal(DB.get('SELECT COUNT(*) AS n FROM messages').n,before); assert.equal(counts.sends,0);
    });
    await check('knowledge create replay/edit invalidation/current check/publish through frontend wrappers',async()=>{
        const source=(await F.getKnowledgeReview(1)).candidates.find(c=>c.source.chatId===chat).source;
        const body={question:'Есть ли парковка?',source};
        draft=(await F.createKnowledgeDraft(1,body,undefined,'http-create')).draft;
        assert.equal((await F.createKnowledgeDraft(1,body,undefined,'http-create')).draft.id,draft.id);
        draft=(await F.checkKnowledgeDraft(1,draft.id,draft.revision,undefined,'http-check')).draft; assert.equal(draft.check.passed,true);
        draft=(await F.updateKnowledgeDraft(1,draft.id,{revision:draft.revision,question:draft.question,answer:draft.answer},undefined,'http-edit')).draft; assert.equal(draft.check,null);
        await assert.rejects(()=>F.publishKnowledgeDraft(1,draft.id,draft.revision,undefined,'http-unchecked'),rejected('KNOWLEDGE_REVIEW_CHECK_REQUIRED',409));
        draft=(await F.checkKnowledgeDraft(1,draft.id,draft.revision,undefined,'http-recheck')).draft;
        draft=(await F.publishKnowledgeDraft(1,draft.id,draft.revision,undefined,'http-publish')).draft;
        assert.equal(draft.status,'published'); assert.equal(draft.approval.type,'ai_grounded');
        assert(DB.getDocumentChunks(1,draft.currentDocumentId).some(c=>c.text.includes('Парковка бесплатная.')));
        publishedVersion=draft.history.find(v=>v.kind==='published').id;
    });
    await check('manual attestation exact hashes and rollback retain original approval',async()=>{
        draft=(await F.updateKnowledgeDraft(1,draft.id,{revision:draft.revision,question:draft.question,answer:'Парковка в воскресенье платная.'},undefined,'http-manual-edit')).draft;
        draft=(await F.checkKnowledgeDraft(1,draft.id,draft.revision,undefined,'http-manual-check')).draft;
        assert.equal(draft.check.status,'manual_required'); assert.equal(draft.check.passed,false);
        const attestation={confirm:true,revision:draft.check.revision,contentHash:draft.check.contentHash,sourceHash:draft.check.sourceHash};
        draft=(await F.publishKnowledgeDraft(1,draft.id,draft.revision,undefined,'http-human-publish',attestation)).draft;
        assert.equal(draft.approval.type,'human_confirmed');
        draft=(await F.rollbackKnowledgeDraft(1,draft.id,draft.revision,publishedVersion,undefined,'http-rollback')).draft;
        assert.equal(draft.answer,'Парковка бесплатная.'); assert.equal(draft.approval.type,'ai_grounded');
    });
    await check('cross-business and foreign-origin denial use actual authorization',async()=>{
        await assert.rejects(()=>F.getFeatures(2),rejected('BUSINESS_ACCESS_DENIED',403));
        F.api.defaults.headers.common.Origin='https://foreign.example';
        try { await assert.rejects(()=>F.postPresence(1,chat,{sessionId:'blocked',typing:false}),rejected('WORKSPACE_ORIGIN_REQUIRED',403)); }
        finally { F.api.defaults.headers.common.Origin=origin; }
    });
    await check('disabled feature stops provider work before execution',async()=>{
        const before=counts.ai;
        flags=await F.updateFeatures(1,flags.revision,{copilot:false});
        await assert.rejects(()=>F.generateCopilot(1,chat,'reply'),rejected('WORKSPACE_FEATURE_DISABLED',409));
        assert.equal(counts.ai,before); assert.equal(counts.sends,0);
        assert(F.workspaceError({response:{data:{code:'WORKSPACE_FEATURE_DISABLED'}}}).includes('отключена'));
    });
    const backendDirty = Boolean(execFileSync('git',['status','--porcelain'],{cwd:backend,encoding:'utf8'}).trim());
    const receipt={checkedAt:new Date().toISOString(),backendCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:backend,encoding:'utf8'}).trim(),backendWorkingTreeDirty:backendDirty,backendTrackedDiffSha256:backendDirty ? createHash('sha256').update(execFileSync('git',['diff','--binary','HEAD'],{cwd:backend})).digest('hex') : null,frontendCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:frontend,encoding:'utf8'}).trim(),database:':memory:',transport:'actual frontend Axios -> actual Express routes/services',provider:'synthetic injected adapter',externalSends:counts.sends,results};
    if (process.env.AVA_INTEGRATION_RECEIPT) await writeFile(process.env.AVA_INTEGRATION_RECEIPT,JSON.stringify(receipt,null,2)+'\n');
    console.log(JSON.stringify({passed:results.length,externalSends:counts.sends,backendCommit:receipt.backendCommit}));
} finally {
    AI.generatePlainText=originalAI; Channel.sendMessageDetailed=originalSend;
    globalThis.fetch=originalFetch;
    if (originalWindow===undefined) delete globalThis.window; else globalThis.window=originalWindow;
    if (server) await new Promise(resolve=>server.close(resolve));
    if (DB.db?.open) DB.db.close();
    await rm(temporary,{recursive:true,force:true});
}
