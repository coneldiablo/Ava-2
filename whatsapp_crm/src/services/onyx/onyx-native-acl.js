'use strict';
const DB = require('../database.service');
const fail = code => Object.assign(new Error(`Не удалось подтвердить приватный доступ к знаниям (${code}).`), { code, retryable: false });

async function ensureGroup(businessId, client, checkpoint, save) {
    DB.run(`CREATE TABLE IF NOT EXISTS onyx_business_groups (
        business_id INTEGER PRIMARY KEY REFERENCES instances(id),
        base_url TEXT NOT NULL, group_id INTEGER NOT NULL, group_name TEXT NOT NULL,
        UNIQUE(base_url,group_id))`);
    const name = `AVA Business ${businessId}`;
    const saved = DB.get('SELECT * FROM onyx_business_groups WHERE business_id=?', [businessId]);
    if (saved && (saved.base_url !== client.baseUrl || saved.group_name !== name)) throw fail('ONYX_GROUP_SCOPE_CHANGED');
    let groups;
    try { groups = await client.getUserGroups(); }
    catch (_) { throw fail('ONYX_ENTERPRISE_GROUPS_REQUIRED'); }
    if (!Array.isArray(groups)) throw fail('ONYX_GROUP_CONTRACT_INVALID');
    let matching = groups.filter(group => group.name === name);
    if (!matching.length) {
        if (saved || checkpoint.groupId || checkpoint.groupCreateRequested) throw fail('ONYX_GROUP_RECONCILIATION_REQUIRED');
        if (DB.get('SELECT id FROM onyx_tenant_links WHERE business_id=?', [businessId])) throw fail('ONYX_EXISTING_BOUNDARY_REQUIRES_REVIEW');
        save({ groupCreateRequested: true });
        await client.createUserGroup(name);
        matching = (await client.getUserGroups()).filter(group => group.name === name);
    }
    const group = matching[0];
    if (matching.length !== 1 || !Number.isSafeInteger(group.id) || group.id < 1
        || group.is_default !== false || group.is_up_for_deletion !== false
        || (saved && saved.group_id !== group.id) || (checkpoint.groupId && checkpoint.groupId !== group.id)
        || (!saved && !checkpoint.groupCreateRequested && !checkpoint.groupId && (group.users?.length || group.cc_pairs?.length))) throw fail('ONYX_GROUP_SCOPE_CHANGED');
    const permissions = await client.getGroupPermissions(group.id);
    // Base non-toggleable access is supplied natively. This AVA runtime group
    // must not grant any optional administrative capability.
    if (!Array.isArray(permissions) || permissions.length) throw fail('ONYX_RUNTIME_GROUP_PRIVILEGED');
    DB.db.transaction(() => {
        client.assertLease?.();
        DB.run('INSERT OR IGNORE INTO onyx_business_groups VALUES (?,?,?,?)', [businessId, client.baseUrl, group.id, name]);
        const row = DB.get('SELECT * FROM onyx_business_groups WHERE business_id=?', [businessId]);
        if (row?.group_id !== group.id || row.base_url !== client.baseUrl) throw fail('ONYX_GROUP_SCOPE_CHANGED');
        save({ groupId: group.id, groupName: name });
    }).immediate();
    return group.id;
}

async function verifyRuntime(businessId, runtime, groupId, personaIds) {
    const groups = await runtime.getOwnGroups();
    if (!Array.isArray(groups) || groups.length !== 1 || groups[0].id !== groupId || groups[0].is_default !== false) throw fail('ONYX_RUNTIME_GROUP_SCOPE_INVALID');
    for (const probe of [() => runtime.getUserGroups(), () => runtime.getApiKeys()]) {
        let denied = false;
        try { await probe(); } catch (error) { denied = Number(error.statusCode) === 403; }
        if (!denied) throw fail('ONYX_RUNTIME_ADMIN_ACCESS_NOT_DENIED');
    }
    const foreign = DB.all('SELECT persona_id FROM onyx_agent_bindings WHERE business_id!=? AND onyx_base_url=?', [businessId, runtime.baseUrl]);
    for (const row of foreign) {
        if (personaIds.includes(row.persona_id)) throw fail('ONYX_FOREIGN_PERSONA_COLLISION');
        let denied = false;
        try { await runtime.getPersona(row.persona_id); }
        catch (error) { denied = [403, 404].includes(Number(error.statusCode)); }
        if (!denied) throw fail('ONYX_RUNTIME_FOREIGN_ACCESS_NOT_DENIED');
    }
    // Zero foreign businesses is not paired tenant-isolation acceptance.
    return { ownGroupVerified: true, adminDenied: true, foreignProbes: foreign.length };
}
module.exports = { ensureGroup, verifyRuntime };
