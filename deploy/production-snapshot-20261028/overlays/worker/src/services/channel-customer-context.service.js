'use strict';
const DB = require('./database.service');
const Canonical = require('./client-identity.service');

// Core owns the shared read model. This compatibility boundary can be removed
// once all deployments contain customer-context.service; it performs no I/O.
function snapshot(businessId, chatId, options = {}) {
    const id = Number(businessId);
    if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error('BUSINESS_SCOPE_REQUIRED'), {code:'BUSINESS_SCOPE_REQUIRED'});
    const canonical = Canonical.resolve(id, chatId);
    const client = DB.get('SELECT * FROM clients WHERE instanceId=? AND chatId=?', [id, canonical]);
    if (!client) throw Object.assign(new Error('WORKSPACE_CLIENT_NOT_FOUND'), {code:'WORKSPACE_CLIENT_NOT_FOUND'});
    let shared;
    try { shared = require('./customer-context.service'); }
    catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND' || !error.message.includes("'./customer-context.service'")) throw error;
    }
    if (shared) return shared.snapshot(id, canonical, options);
    const Memory = require('./crm-memory-store.service');
    const ready = kind => {
        const value = Memory.latest(id, canonical, kind);
        return value?.source_complete && ['relevant','mixed'].includes(value.relevance) && value.summary ? value : null;
    };
    const call = ready('call');
    const values = [ready('conversation'), call].filter(Boolean).sort((a,b) =>
        (Date.parse(b.source_updated_at || '') || 0) - (Date.parse(a.source_updated_at || '') || 0));
    const current = values[0];
    return {client, memory:{summary:current?.summary || null, sourceUpdatedAt:current?.source_updated_at || null,
        sourceComplete:Boolean(current), keyFacts:[current?.needs,...(current?.interests || [])].filter(Boolean)},
        callBrief:{lastSummary:call?.summary || null}, calls:[], sources:[], compatibility:true};
}

function aiContext(businessId, chatId) {
    const value = snapshot(businessId, chatId);
    return {customerContext:value, customerMemory:value.memory,
        lastCallSummary:value.callBrief?.lastCallSummary || value.calls?.find(call => call.summary)?.summary ||
            value.callBrief?.lastSummary || null};
}
module.exports = {snapshot, aiContext};
