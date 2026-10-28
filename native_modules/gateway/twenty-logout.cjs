'use strict';

const { parse, Kind, visit } = require('graphql');

const MAX_BODY = 1024 * 1024;

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY) { reject(Object.assign(new Error('GRAPHQL_BODY_TOO_LARGE'), { code: 'GRAPHQL_BODY_TOO_LARGE' })); req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('aborted', () => reject(new Error('GRAPHQL_REQUEST_ABORTED')));
        req.on('error', reject);
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
}

function operationSignOut(document, operationName) {
    const operations = document.definitions.filter(item => item.kind === Kind.OPERATION_DEFINITION);
    const selected = operations.filter(item => !operationName || item.name?.value === operationName);
    if (operations.length !== 1 && (!operationName || selected.length !== 1)) return null;
    const operation = selected[0];
    if (!operation || operation.operation !== 'mutation') return null;
    const fragments = new Map(document.definitions.filter(item => item.kind === Kind.FRAGMENT_DEFINITION)
        .map(item => [item.name.value, item]));
    const visited = new Set();
    const aliases = [];
    const fields = selectionSet => (selectionSet?.selections || []).every(selection => {
        if (selection.kind === Kind.FIELD) {
            if (selection.directives?.length || selection.name.value !== 'signOut') return false;
            aliases.push(selection.alias?.value || 'signOut'); return true;
        }
        if (selection.kind === Kind.INLINE_FRAGMENT) return !selection.directives?.length && fields(selection.selectionSet);
        if (selection.kind !== Kind.FRAGMENT_SPREAD || visited.has(selection.name.value)) return false;
        if (selection.directives?.length) return false;
        visited.add(selection.name.value);
        const fragment = fragments.get(selection.name.value);
        return Boolean(fragment && !fragment.typeCondition?.name?.value || fragment?.typeCondition?.name?.value === 'Mutation')
            && fields(fragment?.selectionSet);
    });
    return fields(operation.selectionSet) && aliases.length ? aliases : null;
}

async function inspect(req) {
    if (req.method !== 'POST' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return { matched: false };
    const text = await readBody(req);
    let payload;
    try { payload = JSON.parse(text); } catch (_) { return { matched: false, body: text }; }
    // Apollo batches and persisted-only requests are ambiguous auth surfaces.
    if (!payload || Array.isArray(payload) || typeof payload !== 'object' || typeof payload.query !== 'string'
        || !payload.query.trim() || Object.keys(payload).some(key => !['query', 'variables', 'operationName'].includes(key))) {
        return { matched: false, ambiguous: true };
    }
    try {
        const document = parse(payload.query);
        const operations = document.definitions.filter(item => item.kind === Kind.OPERATION_DEFINITION);
        const named = payload.operationName && operations.filter(item => item.name?.value === payload.operationName);
        if (operations.length !== 1 && (!payload.operationName || named.length !== 1)) return { matched: false, ambiguous: true, body: text };
        const aliases = operationSignOut(document, payload.operationName);
        let containsSignOut = false;
        visit(document, { Field(node) { if (node.name.value === 'signOut') containsSignOut = true; } });
        if (!aliases && containsSignOut) return { matched: false, ambiguous: true, body: text };
        return { matched: Boolean(aliases), aliases: aliases || [], body: text };
    } catch (_) { return { matched: false, body: text }; }
}

module.exports = { inspect, readBody, MAX_BODY };
