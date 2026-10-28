#!/usr/bin/env node
'use strict';
// Prepare/check locally first. Only --run dispatches a real model turn, after
// verifying the deployed helper bytes; --inspect (the default) never calls AI.
const { spawn } = require('node:child_process');
const { Script } = require('node:vm');
const EXPECTED_SOURCE_SHA = 'dfbba5f2777d84169f17112e27ab931dfe07401d01ea918677acfa6b6c599335';

function parseArgs(args) {
    if (args.length > 1 || args.some(arg => !['--check', '--inspect', '--run'].includes(arg))) {
        throw Object.assign(new Error('PROBE_ARGUMENTS_INVALID'), { code: 'PROBE_ARGUMENTS_INVALID' });
    }
    return { mode: args[0] === '--run' ? 'run' : args[0] === '--check' ? 'check' : 'inspect' };
}

// This function is serialized to the existing deployed CRM Node process. It
// neither imports the application nor starts a server, worker, scheduler or SDK
// replacement. The model/auth transport and inherited provider environment stay
// unchanged. All application DB reads are rebound to a private online backup.
async function remoteMain(options) {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const Module = require('node:module'), crypto = require('node:crypto');
    const output = process.stdout.write.bind(process.stdout), started = Date.now();
    const report = {
        kind: 'knowledge-native-preview-live-clone', mode: options.run ? 'run' : 'inspect',
        startedAt: new Date(started).toISOString(), pass: false,
        sourceDatabaseReadOnly: true, privateClone: true, productionEnvironmentInherited: true,
        applicationStarted: false, liveWrites: 0, customerSends: 0, calls: 0,
        previewCalls: 0, generationDispatches: 0, nonGeminiAxiosPosts: 0,
        retry: false, providerTransportReplaced: false, identityFabricated: false,
        questionRetained: false, answerRetained: false, privateContentRetained: false,
        deniedActions: 0, cleanup: false, userInterfaceAcceptance: 'NOT_TESTED',
        onyxGeneration: 'NOT_TESTED',
    };
    let directory, source, clone, DB, axios, originalPost, complete = false, timer;
    const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const fail = code => { throw Object.assign(new Error(code), { code }); };
    const safeCode = error => /^(?:PROBE_[A-Z0-9_]{1,90}|KNOWLEDGE_PREVIEW_[A-Z0-9_]{1,80}|AI_[A-Z0-9_]{1,80}|ACCOUNT_NOT_ACTIVE|BUSINESS_ACCESS_DENIED|CAPABILITY_DENIED|BUSINESS_NOT_FOUND)$/.test(error?.code || '')
        ? error.code : 'PROBE_RUNTIME_FAILED';
    const denied = () => { report.deniedActions++; fail('PROBE_ACTION_DENIED'); };
    function finish(error) {
        if (complete) return;
        complete = true; clearTimeout(timer);
        if (error) report.errorCode = safeCode(error);
        if (axios && originalPost) axios.post = originalPost;
        if (DB) DB.db = null;
        let cleaned = true;
        for (const connection of [source, clone]) {
            try { if (connection?.open) connection.close(); } catch (_) { cleaned = false; }
        }
        try { if (directory) fs.rmSync(directory, { recursive: true, force: true }); }
        catch (_) { cleaned = false; }
        report.cleanup = cleaned && (!directory || !fs.existsSync(directory));
        report.elapsedMs = Date.now() - started;
        report.pass = !error && report.cleanup && report.deniedActions === 0
            && (options.run ? report.answer?.verified === true && report.previewCalls === 1
                && report.generationDispatches === 1 && report.nonGeminiAxiosPosts === 0
                : report.previewCalls === 0 && report.generationDispatches === 0 && report.readyForExplicitRun === true);
        output(JSON.stringify(report) + '\n');
        process.exit(report.pass ? 0 : 1);
    }
    // Never forward production logs, document text, credentials or provider
    // bodies to the coordinator. Only the final allowlisted report is emitted.
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir']) console[method] = () => {};
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    timer = setTimeout(() => finish({ code: 'PROBE_PROCESS_DEADLINE' }), 45000);
    process.once('SIGTERM', () => finish({ code: 'PROBE_CANCELED' }));
    process.once('SIGINT', () => finish({ code: 'PROBE_CANCELED' }));
    global.setInterval = denied;
    require('node:net').Server.prototype.listen = denied;
    require('node:dgram').createSocket = denied;
    for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) require('node:child_process')[method] = denied;
    const originalLoad = Module._load;
    Module._load = function (request, parent, ...rest) {
        if (/(?:^|\/)(?:app|openwa\.service|whatsapp\.service|telegram\.service|email\.service|followup\.service)(?:\.js)?$/.test(request)
            || /\/services\/(?:telephony|integrations)\//.test(request)) denied();
        return originalLoad.call(this, request, parent, ...rest);
    };

    async function main() {
        const app = Module.createRequire('/app/package.json');
        const deployedFile = '/app/src/services/knowledge-preview-ai.service.js';
        if (!fs.existsSync(deployedFile)) fail('PROBE_SOURCE_NOT_DEPLOYED');
        report.sourceSha256 = crypto.createHash('sha256').update(fs.readFileSync(deployedFile)).digest('hex');
        report.sourceMatchesAcceptedHelper = report.sourceSha256 === options.expectedSha;
        if (!report.sourceMatchesAcceptedHelper) fail('PROBE_SOURCE_SHA_MISMATCH');
        const livePath = '/app/data/crm_v2.db';
        if (process.env.DB_PATH !== livePath) fail('PROBE_DATABASE_SCOPE');
        const SQLite = app('better-sqlite3');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-native-preview-live-'));
        fs.chmodSync(directory, 0o700);
        const clonePath = path.join(directory, 'crm.db');
        source = new SQLite(livePath, { readonly: true, fileMustExist: true });
        await source.backup(clonePath);
        source.close(); source = null;
        fs.chmodSync(clonePath, 0o600);
        process.env.DB_PATH = clonePath;
        clone = new SQLite(clonePath, { fileMustExist: true });
        app('sqlite-vec').load(clone);
        if (clone.pragma('integrity_check', { simple: true }) !== 'ok') fail('PROBE_CLONE_INTEGRITY');
        report.cloneIntegrity = true;
        DB = app('./src/services/database.service');
        DB.db = clone; // Before Identity, AI or the actual helper is imported.
        const tables = new Set(clone.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
        if (!['instances', 'ava_users', 'ava_business_memberships', 'knowledge_base', 'kb_chunks'].every(table => tables.has(table))) fail('PROBE_REQUIRED_STORAGE_ABSENT');

        function snapshot(connection, businessId) {
            return connection.transaction(() => {
                const documents = connection.prepare(`SELECT id,originalName,contentHash,version,chunkCount,createdAt
                    FROM knowledge_base WHERE instanceId=? AND isCurrent=1 ORDER BY id LIMIT 65`).all(businessId);
                const size = connection.prepare(`SELECT COUNT(*) AS chunks,COALESCE(SUM(length(c.text)),0) AS chars,
                    COALESCE(SUM(length(CAST(c.text AS BLOB))),0) AS bytes
                    FROM kb_chunks c JOIN knowledge_base k ON k.id=c.kbId WHERE k.instanceId=? AND k.isCurrent=1`).get(businessId);
                if (!documents.length || documents.length > 64 || !size.chunks || size.chunks > 64 || size.chars > 60000 || size.bytes > 128 * 1024) return null;
                const chunks = connection.prepare(`SELECT c.id,c.kbId,c.chunkIndex,c.text,c.section FROM kb_chunks c
                    JOIN knowledge_base k ON k.id=c.kbId WHERE k.instanceId=? AND k.isCurrent=1 ORDER BY k.id,c.chunkIndex,c.id`).all(businessId);
                if (chunks.some(chunk => typeof chunk.text !== 'string' || !chunk.text.trim() || chunk.text.length > 6000)
                    || documents.some(doc => !Number.isSafeInteger(doc.chunkCount) || doc.chunkCount < 1
                        || chunks.filter(chunk => chunk.kbId === doc.id).length !== doc.chunkCount)) return null;
                return { documents, chunks, chars: size.chars, bytes: size.bytes, digest: digest({ documents, chunks }) };
            }).deferred();
        }
        const candidates = clone.prepare(`SELECT i.id,m.userId FROM instances i
            JOIN ava_business_memberships m ON m.businessId=i.id AND m.enabled=1 AND m.role='hotel_owner'
            JOIN ava_users u ON u.id=m.userId AND u.enabled=1 AND u.platformRole='customer'
            WHERE i.isActive=1 AND i.aiProvider='gemini' AND COALESCE(i.knowledgeBaseInstanceId,i.id)=i.id
            ORDER BY i.id,m.userId`).all();
        const Identity = app('./src/services/identity/identity-store');
        const AI = app('./src/services/ai.service');
        const accountsBefore = digest({ users: clone.prepare('SELECT * FROM ava_users ORDER BY id').all(),
            memberships: clone.prepare('SELECT * FROM ava_business_memberships ORDER BY businessId,userId').all(),
            businesses: clone.prepare('SELECT * FROM instances ORDER BY id').all() });
        const stopWords = new Set(['который', 'которые', 'которого', 'можно', 'нужно', 'также', 'этого', 'после', 'перед', 'будет', 'чтобы', 'когда', 'только', 'данные', 'должны', 'должен', 'например']);
        let selected;
        const visited = new Set();
        for (const candidate of candidates) {
            if (visited.has(candidate.id)) continue;
            visited.add(candidate.id);
            const corpus = snapshot(clone, candidate.id);
            if (!corpus) continue;
            const words = corpus.chunks.flatMap(chunk => chunk.text.match(/[\p{L}]{5,24}/gu) || [])
                .map(word => word.toLowerCase()).filter(word => !stopWords.has(word));
            const anchor = words.find(word => /[а-яё]/u.test(word)) || words[0];
            if (!anchor) continue;
            const question = 'Что указано в базе знаний по теме «' + anchor + '»?';
            const input = JSON.stringify({ question, documents: corpus.documents.map(doc => ({ sourceId: doc.id, title: doc.originalName })),
                chunks: corpus.chunks.map(chunk => ({ sourceId: chunk.kbId, chunkId: chunk.id, text: chunk.text })) });
            if (Buffer.byteLength(input) > 128 * 1024) continue;
            const actor = Identity.actor(candidate.userId);
            Identity.authorizeCapability(actor, candidate.id, 'ai.use');
            const instance = await DB.getInstance(candidate.id);
            let resolved;
            try { resolved = AI._resolveProviderConfig(instance); } catch (_) { continue; }
            if (resolved.provider !== 'gemini' || !/^gemini-[a-zA-Z0-9._-]{1,90}$/.test(resolved.model || '')) continue;
            selected = { businessId: candidate.id, actor, corpus, question, resolved, ordinal: visited.size };
            break;
        }
        if (!selected) fail('PROBE_NO_ELIGIBLE_EXISTING_OWNER_SCOPE');
        const { businessId, actor, corpus, question, resolved } = selected;
        const ownerStillActive = connection => !!connection.prepare(`SELECT 1 FROM ava_business_memberships m
            JOIN ava_users u ON u.id=m.userId JOIN instances i ON i.id=m.businessId
            WHERE m.businessId=? AND m.userId=? AND m.role='hotel_owner' AND m.enabled=1
                AND u.enabled=1 AND u.platformRole='customer' AND i.isActive=1
                AND COALESCE(i.knowledgeBaseInstanceId,i.id)=i.id`).get(businessId, actor.userId);
        const configDigest = connection => digest(connection.prepare(`SELECT aiProvider,geminiModel,aiTemperature,
            isActive,knowledgeBaseInstanceId FROM instances WHERE id=?`).get(businessId));
        const initialConfig = configDigest(clone);
        // Identity may run its normal additive DDL on the private clone; it
        // must not create/change a user, business or membership. All following
        // application reads are additionally protected by SQLite query_only.
        const accountDigest = () => digest({ users: clone.prepare('SELECT * FROM ava_users ORDER BY id').all(),
            memberships: clone.prepare('SELECT * FROM ava_business_memberships ORDER BY businessId,userId').all(),
            businesses: clone.prepare('SELECT * FROM instances ORDER BY id').all() });
        if (accountDigest() !== accountsBefore) fail('PROBE_PRIVATE_ACCOUNT_DATA_CHANGED');
        clone.pragma('query_only = ON');
        report.privateApplicationDatabaseQueryOnly = true;
        const revalidateLive = () => {
            source = new SQLite(livePath, { readonly: true, fileMustExist: true });
            try {
                return source.transaction(() => {
                    const current = snapshot(source, businessId);
                    return !!current && current.digest === corpus.digest && ownerStillActive(source)
                        && configDigest(source) === initialConfig;
                }).deferred();
            } finally { source.close(); source = null; }
        };
        if (!revalidateLive()) fail('PROBE_LIVE_SCOPE_CHANGED_BEFORE_REQUEST');
        report.selectedBusiness = { anonymousCandidateOrdinal: selected.ordinal, active: true, existingOwnerMembership: true,
            ownCurrentKnowledgeScope: true, documents: corpus.documents.length, chunks: corpus.chunks.length,
            corpusChars: corpus.chars, corpusBytes: corpus.bytes };
        report.provider = resolved.provider; report.selectedModel = resolved.model;
        report.actualIdentityAuthorization = true;
        report.sourceVersionValidatedBeforeRequest = true;
        report.readyForExplicitRun = true;
        if (!options.run) {
            report.generation = 'NOT_RUN';
            report.nativePreview = 'NOT_RUN';
            return;
        }

        const NativePreview = app('./src/services/knowledge-preview-ai.service');
        axios = app('axios'); originalPost = axios.post;
        let observedModel = null;
        axios.post = function (...args) {
            // Observe only: original arguments, promise, response and stream are
            // untouched. ADC/token network uses its existing Google SDK.
            let url;
            try { url = new URL(String(args[0])); } catch (_) {}
            const match = url?.pathname.match(/\/publishers\/google\/models\/([A-Za-z0-9._-]+):streamGenerateContent$/);
            if (url?.protocol === 'https:' && url.hostname === 'aiplatform.googleapis.com' && match) {
                report.generationDispatches++;
                observedModel = match[1];
            } else report.nonGeminiAxiosPosts++;
            return Reflect.apply(originalPost, this, args);
        };
        const controller = new AbortController();
        const callStart = Date.now();
        const turnTimer = setTimeout(() => controller.abort(), 15000);
        let answer;
        try {
            report.previewCalls++;
            answer = await NativePreview.answer(actor, businessId, question, { signal: controller.signal, timeoutMs: 12000 });
        } finally { clearTimeout(turnTimer); controller.abort(); }
        report.answerElapsedMs = Date.now() - callStart;
        if (!answer) fail('PROBE_NATIVE_PREVIEW_INELIGIBLE');
        const refs = answer.citations;
        const seen = new Set();
        const scoped = Array.isArray(refs) && refs.length >= 1 && refs.length <= 3 && refs.every(ref => {
            const chunk = corpus.chunks.find(row => row.id === ref.chunk_id && row.kbId === ref.source_id);
            const doc = corpus.documents.find(row => row.id === ref.source_id);
            const key = JSON.stringify([ref.source_id, ref.chunk_id]);
            if (!chunk || !doc || seen.has(key) || ref.quote !== chunk.text) return false;
            seen.add(key); return true;
        });
        const wholeChunkAnswer = scoped && typeof answer.answer === 'string' && answer.answer.length > 0
            && answer.answer.length <= 18000 && answer.answer === refs.map(ref => ref.quote).join('\n\n');
        const stableClone = snapshot(clone, businessId)?.digest === corpus.digest;
        const stableLive = revalidateLive();
        const unchangedAccounts = accountDigest() === accountsBefore;
        Identity.authorizeCapability(actor, businessId, 'ai.use');
        report.observedModel = observedModel;
        report.selectedModelWasDispatched = observedModel === resolved.model;
        report.answer = { sourceCount: Array.isArray(refs) ? refs.length : 0, allSourcesCurrentAndTenantScoped: scoped,
            exactWholeChunkAnswer: wholeChunkAnswer, cloneSourceVersionStable: stableClone,
            liveSourceVersionAndMembershipStable: stableLive, privateAccountDataUnchanged: unchangedAccounts,
            sourceTimestampValid: typeof answer.source_timestamp === 'string' && Number.isFinite(Date.parse(answer.source_timestamp)),
            provenance: answer.provenance === 'native_knowledge_ai_selection' ? answer.provenance : 'UNEXPECTED', retained: false };
        report.answer.verified = !!(scoped && wholeChunkAnswer && stableClone && stableLive && unchangedAccounts
            && report.answer.sourceTimestampValid && answer.provenance === 'native_knowledge_ai_selection'
            && report.selectedModelWasDispatched && report.generationDispatches === 1 && report.nonGeminiAxiosPosts === 0
            && report.answerElapsedMs <= 15000);
        if (!report.answer.verified) fail('PROBE_NATIVE_PREVIEW_UNCONFIRMED');
    }
    try { await main(); finish(); } catch (error) { finish(error); }
}

function buildRemote(mode) {
    return `(${remoteMain.toString()})(${JSON.stringify({ run: mode === 'run', expectedSha: EXPECTED_SOURCE_SHA })});\n`;
}

function main(args) {
    let mode;
    try { ({ mode } = parseArgs(args)); new Script(buildRemote(mode), { filename: 'native-preview-remote.cjs' }); }
    catch (_) { process.stdout.write(JSON.stringify({ pass: false, errorCode: 'PROBE_ARGUMENTS_OR_SYNTAX_INVALID', networkStarted: false }) + '\n'); process.exitCode = 1; return; }
    if (mode === 'check') {
        process.stdout.write(JSON.stringify({ kind: 'native-preview-coordinator-check', pass: true, remoteSyntaxValid: true,
            networkStarted: false, generationDispatches: 0, defaultMode: 'inspect', expectedSourceSha256: EXPECTED_SOURCE_SHA }) + '\n');
        return;
    }
    const child = spawn('ssh', ['-i', '/Users/developer/.ssh/ava-deploy-ed25519', '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=8', 'root@203.0.113.10', 'docker exec -i whatsapp_crm node -'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', finished = false, outputOverflow = false;
    const cap = setTimeout(() => child.kill('SIGTERM'), 55000);
    child.stdout.on('data', data => { if (stdout.length + data.length <= 65536) stdout += data; else outputOverflow = true; });
    child.stderr.on('data', () => {}); // Do not retain or expose remote/provider logs.
    child.stdin.on('error', () => {});
    child.stdin.end(buildRemote(mode));
    const done = status => {
        if (finished) return; finished = true; clearTimeout(cap);
        try {
            if (outputOverflow) throw new Error();
            const result = JSON.parse(stdout.trim());
            if (result.kind !== 'knowledge-native-preview-live-clone' || result.mode !== mode) throw new Error();
            process.stdout.write(JSON.stringify(result, null, 2) + '\n');
            if (status !== 0 || result.pass !== true) process.exitCode = 1;
        } catch (_) {
            process.stdout.write(JSON.stringify({ pass: false, mode, errorCode: 'PROBE_TRANSPORT_OR_RUNTIME_FAILED',
                sshStatus: Number.isSafeInteger(status) ? status : null, privateContentRetained: false }) + '\n');
            process.exitCode = 1;
        }
    };
    child.once('error', () => done(null)); child.once('close', done);
}

module.exports = { parseArgs, buildRemote, EXPECTED_SOURCE_SHA };
if (require.main === module) main(process.argv.slice(2));
