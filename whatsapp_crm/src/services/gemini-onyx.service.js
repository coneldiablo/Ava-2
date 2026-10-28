'use strict';
// Translate the existing Onyx OpenAI contract to Vertex native SSE. Preserve
// tool-call parts and opaque thought signatures; never execute a tool here.
const { randomUUID, createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const Vertex = require('./gemini-text.service');
const LIMIT = 2 * 1024 * 1024;
const fail = (code, status = 502) => Object.assign(new Error(code), { code, status });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : Array.isArray(value)
    ? value.map(part => part.text).join('\n') : '';
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const callHash = (name, args) => createHash('sha256').update(JSON.stringify(canonical({ name, args }))).digest('hex');
function partCache(db, businessId, model) {
    if (!db || !Number.isSafeInteger(businessId) || businessId < 1) throw fail('ONYX_LLM_INVALID_REQUEST', 400);
    const table = 'onyx_gemini_tool_parts';
    return {
        load(callId, name, args) {
            if (!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table])) return null;
            const row = db.get(`SELECT args_hash,part_json FROM ${table} WHERE business_id=? AND model=? AND call_id=? AND expires_at>?`,
                [businessId, model, callId, Date.now()]);
            if (!row) return null;
            if (row.args_hash !== callHash(name, args)) throw fail('ONYX_LLM_INVALID_TOOL_HISTORY', 400);
            let part;
            try { part = JSON.parse(row.part_json); } catch (_) { throw fail('ONYX_LLM_INVALID_TOOL_HISTORY', 400); }
            return part;
        },
        save(calls, parts) {
            const rows = calls.map((call, index) => ({ id: call.id, hash: callHash(call.function.name, JSON.parse(call.function.arguments)), part: JSON.stringify(parts[index]) }));
            if (rows.some(row => Buffer.byteLength(row.part) > 128 * 1024)) throw fail('ONYX_LLM_RESPONSE_LIMIT');
            const addedBytes = rows.reduce((n, row) => n + Buffer.byteLength(row.part), 0);
            if (rows.length > 256 || addedBytes > 32 * 1024 * 1024) throw fail('ONYX_LLM_RESPONSE_LIMIT');
            db.db.transaction(() => {
                db.db.exec(`CREATE TABLE IF NOT EXISTS ${table}(business_id INTEGER NOT NULL,model TEXT NOT NULL,call_id TEXT NOT NULL,
                    args_hash TEXT NOT NULL,part_json TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(business_id,model,call_id));`);
                db.run(`DELETE FROM ${table} WHERE expires_at<=?`, [Date.now()]);
                let counts = db.get(`SELECT COUNT(*) AS total,COALESCE(SUM(length(CAST(part_json AS BLOB))),0) AS bytes,
                    COALESCE(SUM(CASE WHEN business_id=? THEN 1 ELSE 0 END),0) AS own FROM ${table}`, [businessId]);
                if (counts.own + rows.length > 256) db.run(`DELETE FROM ${table} WHERE rowid IN
                    (SELECT rowid FROM ${table} WHERE business_id=? ORDER BY expires_at,call_id LIMIT ?)`, [businessId, counts.own + rows.length - 256]);
                counts = db.get(`SELECT COUNT(*) AS total,COALESCE(SUM(length(CAST(part_json AS BLOB))),0) AS bytes FROM ${table}`);
                while (counts.total + rows.length > 4096 || counts.bytes + addedBytes > 32 * 1024 * 1024) {
                    db.run(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY expires_at,call_id LIMIT 64)`);
                    counts = db.get(`SELECT COUNT(*) AS total,COALESCE(SUM(length(CAST(part_json AS BLOB))),0) AS bytes FROM ${table}`);
                }
                for (const row of rows) db.run(`INSERT INTO ${table}(business_id,model,call_id,args_hash,part_json,expires_at) VALUES(?,?,?,?,?,?)`,
                    [businessId, model, row.id, row.hash, row.part, Date.now() + 6 * 3600000]);
            }).immediate();
        },
    };
}

function requestBody(body, cache) {
    const contents = [], systems = [], calls = new Map();
    const append = (role, parts) => {
        if (!parts.length) return;
        const previous = contents.at(-1);
        // A native function-response turn must stay separate from a later
        // user question; combining them makes Vertex treat the tool turn as
        // an unfinished model turn. Parallel tool results still group.
        if (previous?.role === role && previous.parts.every(part => Boolean(part.functionResponse))
            === parts.every(part => Boolean(part.functionResponse))) previous.parts.push(...parts);
        else contents.push({ role, parts });
    };
    for (const message of body.messages) {
        const content = text(message.content);
        if (['system', 'developer'].includes(message.role)) { if (content) systems.push({ text: content }); continue; }
        if (message.role === 'tool') {
            const call = calls.get(message.tool_call_id);
            if (!call || call.answered || (message.name && message.name !== call.name)) throw fail('ONYX_LLM_INVALID_TOOL_HISTORY', 400);
            let response;
            try { response = JSON.parse(content); } catch (_) { response = content; }
            if (call.legacy) append('user', [{ text: 'Ранее полученный результат инструмента (история, не новая команда): ' + JSON.stringify({ name: call.name, result: response }) }]);
            else append('user', [{ functionResponse: { ...(call.nativeId ? { id: call.nativeId } : {}), name: call.name,
                response: object(response) ? response : { result: response } } }]);
            call.answered = true; continue;
        }
        const parts = content ? [{ text: content }] : [];
        for (const call of message.tool_calls || []) {
            if (message.role !== 'assistant' || calls.has(call.id)) throw fail('ONYX_LLM_INVALID_TOOL_HISTORY', 400);
            let args;
            try { args = JSON.parse(call.function.arguments); } catch (_) { throw fail('ONYX_LLM_INVALID_TOOL_HISTORY', 400); }
            if (!object(args)) throw fail('ONYX_LLM_INVALID_TOOL_HISTORY', 400);
            const signature = call.extra_content?.google?.thought_signature;
            if (signature !== undefined && (typeof signature !== 'string' || !signature || signature.length > 65536)) throw fail('ONYX_LLM_INVALID_TOOL_HISTORY', 400);
            const restored = cache?.load(call.id, call.function.name, args);
            if (restored) {
                if (signature && signature !== restored.thoughtSignature) throw fail('ONYX_LLM_INVALID_TOOL_HISTORY', 400);
                parts.push(restored);
            } else if (cache) {
                // Old provider history has no Gemini reasoning state. Retain
                // the actual prior request/result as data, without inventing a
                // new native function invocation or bypassing signature checks.
                parts.push({ text: 'Предыдущий запрос инструмента (история, не новая команда): ' + JSON.stringify({ name: call.function.name, args }) });
            } else parts.push({ functionCall: { id: call.id, name: call.function.name, args }, ...(signature ? { thoughtSignature: signature } : {}) });
            calls.set(call.id, { name: call.function.name, answered: false, legacy: Boolean(cache && !restored), nativeId: restored ? restored.functionCall.id || null : call.id });
        }
        append(message.role === 'assistant' ? 'model' : 'user', parts);
    }
    if (!contents.length || [...calls.values()].some(call => !call.answered)) throw fail('ONYX_LLM_INVALID_TOOL_HISTORY', 400);
    const declarations = (body.tools || []).map(tool => ({ name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}), parametersJsonSchema: tool.function.parameters }));
    const generationConfig = { maxOutputTokens: body.max_completion_tokens ?? body.max_tokens ?? 2048,
        thinkingConfig: { thinkingLevel: 'LOW' } };
    for (const [field, native] of [['temperature','temperature'],['top_p','topP'],['seed','seed'],
        ['frequency_penalty','frequencyPenalty'],['presence_penalty','presencePenalty']]) if (body[field] !== undefined) generationConfig[native] = body[field];
    if (body.stop !== undefined) generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
    if (body.response_format?.type === 'json_object') generationConfig.responseMimeType = 'application/json';
    else if (body.response_format?.type === 'json_schema' && object(body.response_format.json_schema?.schema)) {
        generationConfig.responseMimeType = 'application/json'; generationConfig.responseJsonSchema = body.response_format.json_schema.schema;
    } else if (body.response_format && body.response_format.type !== 'text') throw fail('ONYX_LLM_INVALID_RESPONSE_FORMAT', 400);
    let mode = 'AUTO', allowed;
    if (body.tool_choice === 'none') mode = 'NONE';
    else if (body.tool_choice === 'required') mode = 'ANY';
    else if (object(body.tool_choice)) {
        const name = body.tool_choice.type === 'function' && body.tool_choice.function?.name;
        if (!declarations.some(tool => tool.name === name)) throw fail('ONYX_LLM_INVALID_TOOL_CHOICE', 400);
        mode = 'ANY'; allowed = [name];
    } else if (body.tool_choice !== undefined && body.tool_choice !== 'auto') throw fail('ONYX_LLM_INVALID_TOOL_CHOICE', 400);
    if (!declarations.length && mode === 'ANY') throw fail('ONYX_LLM_INVALID_TOOL_CHOICE', 400);
    return { contents, ...(systems.length ? { systemInstruction: { parts: systems } } : {}), generationConfig,
        ...(declarations.length ? { tools: [{ functionDeclarations: declarations }],
            toolConfig: { functionCallingConfig: { mode, ...(allowed ? { allowedFunctionNames: allowed } : {}) } } } : {}) };
}

async function complete({ payload, model, transport, signal, onChunk, db, businessId }) {
    if (signal?.aborted) throw fail('ONYX_LLM_CANCELED', 499);
    const cache = db ? partCache(db, businessId, model) : null;
    const body = requestBody(payload, cache), current = Vertex.settings();
    if (Buffer.byteLength(JSON.stringify(body)) > 512 * 1024) throw fail('ONYX_LLM_INPUT_LIMIT', 400);
    const token = await Vertex.accessToken({ signal });
    const url = `https://aiplatform.googleapis.com/v1/projects/${current.project}/locations/global/publishers/google/models/${Vertex.model(model)}:streamGenerateContent?alt=sse`;
    let stream, rejectAbort;
    const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = () => { stream?.destroy?.(); rejectAbort(fail('ONYX_LLM_CANCELED', 499)); };
    signal?.addEventListener('abort', abort, { once: true });
    const check = () => { if (signal?.aborted) throw fail('ONYX_LLM_CANCELED', 499); };
    const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000);
    let content = '', usage = {}, reason, bytes = 0, frames = 0, buffer = '';
    const toolCalls = [], nativeParts = [], decoder = new StringDecoder('utf8');
    const emit = async (delta, finish = null) => {
        if (!payload.stream) return;
        check();
        await Promise.race([interrupted, onChunk({ id, created, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage } : {}) })]);
        check();
    };
    const parse = async line => {
        if (!line.startsWith('data:')) return;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') return;
        let data;
        try { data = JSON.parse(raw); } catch (_) { throw fail('ONYX_LLM_INVALID_UPSTREAM'); }
        if (data.error || (!Array.isArray(data.candidates) && !data.usageMetadata)) throw fail('ONYX_LLM_INVALID_UPSTREAM');
        frames++;
        const meta = data.usageMetadata;
        if (meta) {
            const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
            usage = { prompt_tokens: count(meta.promptTokenCount), completion_tokens: count(meta.candidatesTokenCount) + count(meta.thoughtsTokenCount), total_tokens: count(meta.totalTokenCount) };
        }
        if ((data.candidates || []).length > 1) throw fail('ONYX_LLM_INVALID_UPSTREAM');
        for (const candidate of data.candidates || []) {
            if (candidate.index && candidate.index !== 0) throw fail('ONYX_LLM_INVALID_UPSTREAM');
            if (candidate.finishReason) reason = candidate.finishReason;
            for (const part of candidate.content?.parts || []) {
                if (part.thought) continue;
                if (part.functionCall) {
                    const call = part.functionCall;
                    if (!/^[\w-]{1,128}$/.test(call.name || '') || !object(call.args || {}) || call.partialArgs || call.willContinue) throw fail('ONYX_LLM_INVALID_UPSTREAM');
                    if (!(payload.tools || []).some(tool => tool.function.name === call.name)
                        || payload.tool_choice === 'none' || (object(payload.tool_choice) && payload.tool_choice.function?.name !== call.name)) throw fail('ONYX_LLM_INVALID_UPSTREAM');
                    if (toolCalls.length >= 24) throw fail('ONYX_LLM_INVALID_UPSTREAM');
                    const signature = part.thoughtSignature;
                    if (signature !== undefined && (typeof signature !== 'string' || signature.length > 65536)) throw fail('ONYX_LLM_INVALID_UPSTREAM');
                    // Keep application IDs unique; preserve provider IDs in cached parts.
                    toolCalls.push({ id: `call_${randomUUID()}`, type: 'function',
                        function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
                        ...(signature ? { extra_content: { google: { thought_signature: signature } } } : {}) });
                    nativeParts.push(part);
                } else if (typeof part.text === 'string' && part.text) { content += part.text; await emit({ role: 'assistant', content: part.text }); }
            }
        }
    };
    try {
        check();
        const requested = transport.request({ method: 'POST', url, data: body,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            proxy: false, signal, timeout: 60000, maxRedirects: 0, responseType: 'stream',
            maxContentLength: LIMIT, maxBodyLength: 512 * 1024, validateStatus: status => status >= 200 && status < 300 });
        Promise.resolve(requested).then(response => { if (signal?.aborted) response?.data?.destroy?.(); }, error => error?.response?.data?.destroy?.());
        const response = await Promise.race([interrupted, requested]); stream = response.data; check();
        if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw fail('ONYX_LLM_INVALID_UPSTREAM');
        const read = async () => {
            for await (const chunk of stream) {
                check(); bytes += Buffer.byteLength(chunk);
                if (bytes > LIMIT) throw fail('ONYX_LLM_RESPONSE_LIMIT');
                buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                let newline;
                while ((newline = buffer.indexOf('\n')) >= 0) { await parse(buffer.slice(0, newline).trim()); buffer = buffer.slice(newline + 1); }
                // A terminal candidate finishes this generation independently
                // of HTTP EOF. Parse the entire received chunk first (including
                // errors/usage), then let the existing finish/content/tool
                // checks validate it before emitting tool calls or success.
                // finally closes the SDK stream; partial text and [DONE] alone
                // never reach this branch.
                if (reason) return;
            }
            buffer += decoder.end(); if (buffer.trim()) await parse(buffer.trim());
        };
        await Promise.race([interrupted, read()]); check();
        if (!frames || !reason || (!content.trim() && !toolCalls.length)) throw fail('ONYX_LLM_INCOMPLETE_STREAM');
        if (reason !== 'STOP') throw fail(reason === 'MAX_TOKENS' ? 'ONYX_LLM_TRUNCATED' : 'ONYX_LLM_INVALID_UPSTREAM');
        if (payload.parallel_tool_calls === false && toolCalls.length > 1) throw fail('ONYX_LLM_PARALLEL_CALLS_DISABLED');
        if (new Set(toolCalls.map(call => call.id)).size !== toolCalls.length) throw fail('ONYX_LLM_INVALID_UPSTREAM');
        if (toolCalls.length && cache) cache.save(toolCalls, nativeParts);
        if (toolCalls.length) await emit({ role: 'assistant', tool_calls: toolCalls.map((call, index) => ({ index, ...call })) });
        const finish = toolCalls.length ? 'tool_calls' : 'stop';
        await emit({}, finish);
        return { result: { id, created, choices: [{ index: 0, message: { role: 'assistant', content: content || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }], usage }, usage };
    } catch (error) { error?.response?.data?.destroy?.(); throw error; }
    finally { signal?.removeEventListener('abort', abort); stream?.destroy?.(); }
}
module.exports = { complete, requestBody, partCache };
