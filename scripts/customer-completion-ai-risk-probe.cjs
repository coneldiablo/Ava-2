#!/usr/bin/env node
'use strict';
// Run through docker exec -i whatsapp_crm node with global.__AVA_PROBE_GEMINI_SOURCE__ set to candidate file contents.
// Exactly two model requests allowed: original transport and candidate; no facts/answers retained.
// No App.start, listeners, consumers, sends, live writes or configuration edits.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const requireApp = Module.createRequire('/app/package.json');
const output = process.stdout.write.bind(process.stdout);
const started = Date.now();
const deadline = started + 102000;
const candidateSource = global.__AVA_PROBE_GEMINI_SOURCE__; delete global.__AVA_PROBE_GEMINI_SOURCE__;
if (typeof candidateSource !== 'string' || !candidateSource.includes('terminal candidate')) throw new Error('PROBE_CANDIDATE_REQUIRED');
const report = { kind: 'customer-completion-ai-risk-attribution', businessId: 9,
    startedAt: new Date(started).toISOString(), sourceDatabaseReadOnly: true,
    appStarted: false, customerSends: 0, customerCalls: 0, liveWrites: 0,
    candidateSHA256: crypto.createHash('sha256').update(candidateSource).digest('hex'), cases: [], generationCalls: [], deniedActions: 0, cleanup: false };
let ownDirectory, clone, source, DB, activeCase, finished = false;
function code(error) {
    const raw = error?.code || error?.message || '';
    return /^[A-Z][A-Z0-9_]{1,100}$/.test(raw) ? raw : 'UNCLASSIFIED_PROBE_ERROR';
}
function denied() { report.deniedActions++; throw Object.assign(new Error('PROBE_EXTERNAL_ACTION_DENIED'), { code: 'PROBE_EXTERNAL_ACTION_DENIED' }); }
function clean() {
    try { if (DB) DB.db = null; if (clone?.open) clone.close(); } catch (_) {}
    try { if (source?.open) source.close(); } catch (_) {}
    if (ownDirectory) {
        try { fs.rmSync(ownDirectory, { recursive: true, force: true }); report.cleanup = !fs.existsSync(ownDirectory); }
        catch (_) { report.cleanup = false; }
    } else report.cleanup = true;
}
function finish(error) {
    if (finished) return;
    finished = true;
    if (error) report.error = code(error);
    clean();
    report.elapsedMs = Date.now() - started;
    report.pass = !error && report.cleanup && report.deniedActions === 0 && report.cases.length === 2
        && report.cases.every(row => row.pass) && report.generationCalls.length === 2;
    output(JSON.stringify(report) + '\n');
    process.exit(report.pass ? 0 : 1);
}
const hardDeadline = setTimeout(() => finish(Object.assign(new Error('PROBE_PROCESS_DEADLINE'), { code: 'PROBE_PROCESS_DEADLINE' })), 105000);
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};
global.setInterval = denied;
require('node:net').Server.prototype.listen = denied;
require('node:dgram').createSocket = denied;
for (const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) require('node:child_process')[method] = denied;
const originalLoad = Module._load;
Module._load = function(request, parent, ...rest) {
    if (/(?:^|\/)(?:app|openwa\.service|whatsapp\.service|telegram\.service|email\.service|followup\.service)(?:\.js)?$/.test(request)
        || /\/services\/(?:telephony|integrations|identity)\//.test(request)) denied();
    return originalLoad.call(this, request, parent, ...rest);
};
function allowedUrl(input, options) {
    let url;
    try {
        if (typeof input === 'string' || input instanceof URL) url = new URL(input);
        else if (input?.url && typeof input.url === 'string') url = new URL(input.url);
        else {
            const opts = input || options || {};
            const host = opts.hostname || opts.host;
            if (!host || opts.socketPath) return denied();
            url = new URL((opts.protocol || 'https:') + '//' + host + (opts.port ? ':' + opts.port : '') + (opts.path || '/'));
        }
    } catch (_) { return denied(); }
    const auth = url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token';
    const model = url.hostname === 'aiplatform.googleapis.com'
        && /^\/v1(?:beta1)?\/projects\/[^/]+\/locations\/global\/(?:publishers\/google\/models\/[^/:]+:(?:streamGenerateContent|generateContent)|endpoints\/openapi\/chat\/completions)$/.test(url.pathname);
    if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || (!auth && !model)) return denied();
    if (model && activeCase) {
        const count = report.cases.reduce((sum, row) => sum + row.networkDispatches, 0);
        if (count >= 2) return denied();
        activeCase.networkDispatches++;
    }
    return url;
}
for (const name of ['node:http', 'node:https']) {
    const transport = require(name);
    for (const method of ['request', 'get']) {
        const original = transport[method];
        transport[method] = function(...args) { allowedUrl(args[0], args[1]); return original.apply(this, args); };
    }
}
const originalFetch = global.fetch;
if (originalFetch) global.fetch = function(...args) { allowedUrl(args[0]); return originalFetch.apply(this, args); };
function receipt(value) {
    const safeModel = text => typeof text === 'string' && /^[A-Za-z0-9._/-]{1,100}$/.test(text) ? text : null;
    return { provider: ['gemini','aitunnel'].includes(value?.provider) ? value.provider : null,
        selectedModel: safeModel(value?.selectedModel), actualModel: safeModel(value?.actualModel),
        transport: ['native_sse'].includes(value?.transport) ? value.transport : null,
        fallbackUsed: value?.fallbackUsed === true, elapsedMs: Number(value?.elapsedMs) || null,
        attempts: (value?.attempts || []).map(row => ({ model: safeModel(row.model),
            status: row.status === 'answered' ? 'answered' : code({ code: row.status }), elapsedMs: Number(row.elapsedMs) || null })) };
}
function resultFields(result) {
    return { grounded: result?.grounded === true, answerStatus: result?.answerStatus || null,
        dataStatus: result?.dataStatus || result?.status || null,
        answerChars: typeof (result?.answer ?? result?.summary) === 'string' ? (result.answer ?? result.summary).length : 0,
        sourceCount: Array.isArray(result?.sources) ? result.sources.length : null,
        receipt: result?.modelReceipt ? receipt(result.modelReceipt) : null };
}
async function main() {
    const SQLite = requireApp('better-sqlite3');
    const databasePath = process.env.DB_PATH;
    if (databasePath !== '/app/data/crm_v2.db') throw Object.assign(new Error('PROBE_DATABASE_SCOPE_INVALID'), { code: 'PROBE_DATABASE_SCOPE_INVALID' });
    ownDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-completion-ai-probe-'));
    fs.chmodSync(ownDirectory, 0o700);
    const clonePath = path.join(ownDirectory, 'crm.db');
    source = new SQLite(databasePath, { readonly: true, fileMustExist: true });
    await source.backup(clonePath);
    source.close(); source = null;
    fs.chmodSync(clonePath, 0o600);
    process.env.DB_PATH = clonePath;
    clone = new SQLite(clonePath, { fileMustExist: true });
    requireApp('sqlite-vec').load(clone);
    if (clone.pragma('integrity_check', { simple: true }) !== 'ok') throw Object.assign(new Error('PROBE_CLONE_INTEGRITY'), { code: 'PROBE_CLONE_INTEGRITY' });
    DB = requireApp('./src/services/database.service');
    DB.db = clone;
    const Gemini = requireApp('./src/services/gemini-text.service');
    const moduleFile = requireApp.resolve('./src/services/gemini-text.service');
    const candidateModule = new Module(moduleFile, module);
    candidateModule.filename = moduleFile; candidateModule.paths = Module._nodeModulePaths(path.dirname(moduleFile));
    candidateModule._compile(candidateSource, moduleFile);
    const candidateGemini = candidateModule.exports;
    report.originalSHA256 = crypto.createHash('sha256').update(fs.readFileSync(moduleFile)).digest('hex');
    const axios = requireApp('axios'), originalPost = axios.post;
    const { StringDecoder } = require('node:string_decoder');
    const { GoogleAuth } = requireApp('google-auth-library');
    const originalToken = GoogleAuth.prototype.getAccessToken;
    GoogleAuth.prototype.getAccessToken = async function(...args) {
        const began = Date.now();
        try { return await originalToken.apply(this, args); }
        finally { if (activeCase) activeCase.authMs = Date.now() - began; }
    };
    axios.post = async function(url, body, options) {
        if (!String(url).includes(':streamGenerateContent')) return originalPost.call(this, url, body, options);
        const row = activeCase;
        const trace = { requestMs: Date.now() - row.began, headersMs: null, firstSSEMs: null, firstTextMs: null,
            stopMs: null, endMs: null, closeMs: null, frames: 0, thoughtParts: 0, outputChars: 0,
            inputBytes: Buffer.byteLength(JSON.stringify(body)), thinkingLevel: body.generationConfig?.thinkingConfig?.thinkingLevel,
            maxOutputTokens: body.generationConfig?.maxOutputTokens };
        row.transport.push(trace);
        let response;
        try { response = await originalPost.call(this, url, body, options); }
        catch(error) { trace.error = code(error); throw error; }
        trace.headersMs = Date.now() - row.began;
        const stream = response.data, iterator = stream[Symbol.asyncIterator].bind(stream);
        const decoder = new StringDecoder('utf8'); let buffer = '';
        stream.once('end', () => { trace.endMs = Date.now() - row.began; });
        stream.once('close', () => { trace.closeMs = Date.now() - row.began; });
        stream[Symbol.asyncIterator] = async function*() {
            for await (const chunk of { [Symbol.asyncIterator]: iterator }) {
                if (trace.firstSSEMs === null) trace.firstSSEMs = Date.now() - row.began;
                buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                let end;
                while ((end = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
                    if (!line.startsWith('data:')) continue;
                    let frame; try { frame = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
                    trace.frames++;
                    if (typeof frame.modelVersion === 'string' && /^gemini-[a-zA-Z0-9.-]+$/.test(frame.modelVersion)) trace.providerModelVersion = frame.modelVersion;
                    if (frame.usageMetadata) trace.usage = Object.fromEntries(['promptTokenCount','candidatesTokenCount','thoughtsTokenCount','totalTokenCount']
                        .filter(key => Number.isFinite(frame.usageMetadata[key])).map(key => [key, frame.usageMetadata[key]]));
                    for (const candidate of frame.candidates || []) {
                        for (const part of candidate.content?.parts || []) {
                            if (part.thought) { trace.thoughtParts++; continue; }
                            if (typeof part.text === 'string') { trace.outputChars += part.text.length; if (trace.firstTextMs === null) trace.firstTextMs = Date.now() - row.began; }
                        }
                        if (candidate.finishReason === 'STOP') trace.stopMs = Date.now() - row.began;
                        if (candidate.finishReason) trace.finishReason = candidate.finishReason;
                    }
                }
                yield chunk;
            }
        };
        return response;
    };
    const AI = requireApp('./src/services/ai.service');
    const Model = requireApp('./src/services/dashboard/ai.model');
    const Dashboard = requireApp('./src/services/dashboard/ai');
    const Facts = requireApp('./src/services/dashboard/facts');
    const instance = requireApp('./src/services/channel-credentials').decryptInstance(DB.get('SELECT * FROM instances WHERE id=? AND isActive=1', [9]));
    if (!instance) throw Object.assign(new Error('PROBE_BUSINESS_NOT_FOUND'), { code: 'PROBE_BUSINESS_NOT_FOUND' });
    const selected = AI._resolveProviderConfig(instance);
    report.selectedProvider = selected.provider;
    report.selectedModel = receipt({ selectedModel: selected.model }).selectedModel;
    if (selected.provider !== 'gemini') throw Object.assign(new Error('PROBE_CONFIGURED_PROVIDER_NOT_GEMINI'), { code: 'PROBE_CONFIGURED_PROVIDER_NOT_GEMINI' });
    for (const method of ['info', 'warn', 'success', 'debug', 'chain', 'error']) requireApp('./src/utils/logger')[method] = () => {};
    const originalGenerate = AI.generatePlainText;
    AI.generatePlainText = async function(messages, config, options = {}) {
        if (!activeCase || report.generationCalls.length >= 2) throw Object.assign(new Error('PROBE_GENERATION_LIMIT'), { code: 'PROBE_GENERATION_LIMIT' });
        const call = { case: activeCase.case, call: report.generationCalls.length + 1, elapsedMs: null,
            rawChars: null, validation: null, receipt: null };
        report.generationCalls.push(call);
        const began = Date.now();
        const timeout = Math.min(options.timeout || 45000, deadline - Date.now());
        if (timeout < 1000) throw Object.assign(new Error('PROBE_PROCESS_BUDGET'), { code: 'PROBE_PROCESS_BUDGET' });
        try {
            const raw = await originalGenerate.call(this, messages, config, { ...options, timeout,
                validate: options.validate ? candidate => {
                    call.rawChars = typeof candidate === 'string' ? candidate.length : null;
                    try { const value = JSON.parse(candidate); call.jsonObject = !!value && !Array.isArray(value) && typeof value === 'object';
                        call.requiredKeysOnly = Object.keys(value || {}).sort().join(',') === 'answer,sourceIds,status';
                        call.modelAnswerChars = typeof value?.answer === 'string' ? value.answer.length : null;
                        call.modelSourceCount = Array.isArray(value?.sourceIds) ? value.sourceIds.length : null;
                    } catch (_) { call.jsonObject = false; }
                    try { const result = options.validate(candidate); call.validation = 'PASS'; return result; }
                    catch (error) { call.validation = code(error); throw error; }
                } : undefined,
                onReceipt: value => { call.receipt = receipt(value); if (options.onReceipt) options.onReceipt(value); } });
            call.rawChars = raw.length;
            return raw;
        } catch (error) { call.error = code(error); throw error; }
        finally { call.elapsedMs = Date.now() - began; }
    };
    const originalModel = Model.generate;
    Model.generate = function(args) {
        if (activeCase) {
            const normalized = Model.normalizeFacts(args.rawFacts, args.question);
            activeCase.factCount = args.rawFacts.length;
            activeCase.normalizedFactCount = normalized.length;
            activeCase.factSourceTypes = [...new Set(normalized.map(row => row.source.type))].sort();
        }
        return originalModel.call(this, args);
    };
    const now = new Date();
    const range = Dashboard.period({ from: new Date(now.getTime() - 30 * 86400000).toISOString(), to: now.toISOString() }, now);
    for (const spec of [
        { case: 'risk_original_transport', question: 'Кто из клиентов рискует уйти?' },
        { case: 'risk_candidate_terminal_stop', question: 'Кто из клиентов рискует уйти?', candidate: true },
    ]) {
        if (spec.candidate) Gemini.complete = candidateGemini.complete;
        const row = { case: spec.case, networkDispatches: 0, transport: [], began: Date.now() };
        report.cases.push(row); activeCase = row;
        const beforeCalls = report.generationCalls.length, began = Date.now();
        try {
            const result = spec.kind ? await Dashboard.overview(9, spec.kind, { now })
                : await Dashboard.ask(9, range, spec.question, { now });
            Object.assign(row, resultFields(result));
            row.generationCalls = report.generationCalls.length - beforeCalls;
            row.pass = row.grounded && row.answerChars > 0 && row.generationCalls === 1
                && report.generationCalls.at(-1)?.validation === 'PASS' && !!report.generationCalls.at(-1)?.receipt;
        } catch (error) { row.error = code(error); row.pass = false; row.generationCalls = report.generationCalls.length - beforeCalls; }
        row.elapsedMs = Date.now() - began;
        delete row.began; activeCase = null;
    }
    report.generationCount = report.generationCalls.length;
}
main().then(() => { clearTimeout(hardDeadline); finish(); }, error => { clearTimeout(hardDeadline); finish(error); });
