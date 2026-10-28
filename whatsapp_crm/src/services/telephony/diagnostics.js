'use strict';
const DB = require('../database.service');
const Store = require('./store');
const { pilot } = require('./policy');

// Configuration, current host observation and a verified customer call are
// different facts. Never promote a saved alias to a working incoming number.
function snapshot(businessId, { canManage = false, now = Date.now() } = {}) {
    Store.ensureSchema();
    const instance = DB.get('SELECT id,name,isActive,sipTrunkNumber,sipCallerId FROM instances WHERE id=?', [businessId]);
    const healthRow = Store.meta('telephony_health');
    let host = null;
    try { if (healthRow && healthRow.updatedAt > now - 90000) host = JSON.parse(healthRow.value); } catch (_) {}
    const managed = DB.all("SELECT * FROM ava_phone_numbers WHERE businessId=? AND state<>'released'", [businessId]);
    const connections = managed.map(row => ({
        id: row.id, kind: row.origin === 'external' ? 'external_sip' : row.origin === 'existing' ? 'existing_sip' : 'service_number', number: row.number,
        businessId, businessName: instance.name, state: row.state,
        inbound: { configured: row.inboundReady === 1, available: row.origin==='external'?null:row.state !== 'active' || row.inboundReady !== 1 ? false : host ? host.ingressReady === true : null, verifiedAt: row.inboundVerifiedAt || null },
        outbound: { configured: row.outboundReady === 1, available: row.state !== 'active' || row.outboundReady !== 1 || process.env.AVA_TELEPHONY_OUTBOUND_ENABLED !== 'true' ? false : null, verifiedAt: row.outboundVerifiedAt || null },
    }));
    const aliases = DB.all('SELECT alias FROM business_sip_aliases WHERE businessId=?', [businessId]);
    for (const { alias } of aliases) {
        if (managed.some(row => row.number === alias)) continue;
        let routed = false;
        try { routed = Store.resolve(alias).businessId === businessId; } catch (_) {}
        connections.push({ id: `legacy:${alias}`, kind: 'own_sip', number: alias, businessId, businessName: instance.name,
            state: !instance.isActive ? 'inactive' : routed ? 'configured' : 'needs_setup',
            inbound: { configured: routed, available: !routed ? false : host ? host.ingressReady === true : null, verifiedAt: null },
            outbound: { configured: !!instance.sipTrunkNumber && instance.sipCallerId === alias, available: null, verifiedAt: null } });
    }
    const checks = [
        { code: 'number', state: connections.length ? 'configured' : 'missing' },
        { code: 'ingress', state: !host ? 'unknown' : host.ingressReady === true ? 'ready' : 'unavailable' },
        { code: 'recording', state: !host ? 'unknown' : host.recordingReady === true ? 'ready' : 'unavailable' },
        { code: 'test_call', state: connections.some(row => row.inbound.verifiedAt || row.outbound.verifiedAt) ? 'verified' : 'not_tested' },
    ];
    return { connections, diagnostics: { checkedAt: host ? healthRow.updatedAt : null, checks },
        connectionPaths: [
            { kind: 'own_sip', configured: connections.some(row => ['own_sip','existing_sip','external_sip'].includes(row.kind)),
                canImport: canManage && Object.values(require('./existing').bindings()).includes(businessId),
                selfService: 'external_sip', blocker: require('./external-sip').overview(businessId).externalSip.blocker||null },
            { kind: 'service_number', canPurchase: canManage && pilot(businessId),
                blocker: pilot(businessId) ? null : 'TELEPHONY_PILOT_DISABLED' },
        ] };
}
module.exports = { snapshot };
