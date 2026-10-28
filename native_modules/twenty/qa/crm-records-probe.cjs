'use strict';
// Disposable native data acceptance. Never points to a public/production API.
const fs = require('node:fs');
const crypto = require('node:crypto');
const check = (value, code) => { if (!value) throw Object.assign(new Error(code), { code }); };
async function main() {
    check(process.env.AVA_NATIVE_QA === 'true', 'QA_SCOPE_REQUIRED');
    const ctx = JSON.parse(fs.readFileSync('/run/ava-bootstrap/bootstrap.json', 'utf8'));
    check([900011, 900012].includes(ctx.businessId), 'QA_BUSINESS_REQUIRED');
    const server = `https://recipe-qa-${ctx.businessId}.crm.meludtech.tech`;
    check(process.env.SERVER_URL === server, 'QA_HOST_REQUIRED');
    const gatewayKey = fs.readFileSync('/run/ava-keys/gateway.key', 'utf8').trim();
    const workerKey = fs.readFileSync('/run/ava-keys/worker.key', 'utf8').trim();
    const peer = async (path, data, key) => {
        const response = await fetch('http://127.0.0.1:3902' + path, { method: 'POST', signal: AbortSignal.timeout(15000),
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(data) });
        check(response.ok, 'QA_NATIVE_PEER_FAILED'); return response.json();
    };
    const checks = {};
    const custom = process.env.AVA_QA_CRM_CUSTOM === 'true';
    const manifest = custom ? require('/app/packages/twenty-server/dist/ava-native/schema-manifest.json') : null;
    for (const role of ['manager', 'hotel_owner']) {
        const userId = crypto.randomUUID(), bindingId = crypto.randomUUID();
        const scope = { businessId: ctx.businessId, deploymentId: ctx.deploymentId, nativeScope: ctx.nativeScope, revision: ctx.revision };
        const identity = await peer('/v1/provision', { ...scope, userId, subject: `qa-records:${userId}`, role,
            email: `qa-records-${userId}@qa.invalid`, displayName: 'AVA QA records' }, workerKey);
        const session = await peer('/v1/sessions/create', { ...scope, bindingId, userId, subject: identity.subject,
            nativeUserId: identity.nativeUserId, role, expiresAt: Date.now() + 180000 }, gatewayKey);
        try {
            const graphql = async (query, variables = {}) => {
                const response = await fetch('http://127.0.0.1:3000/graphql', { method: 'POST', signal: AbortSignal.timeout(15000),
                    headers: { 'content-type': 'application/json', cookie: session.nativeCookie, origin: server,
                        'x-ava-native-peer': gatewayKey, 'x-ava-native-binding': bindingId },
                    body: JSON.stringify({ query, variables }) });
                const value = await response.json();
                check(response.ok && !value.errors?.length, 'QA_CRM_QUERY_FAILED'); return value.data;
            };
            const lastName = `AVA-QA-${crypto.randomUUID()}`;
            const created = await graphql('mutation($data: PersonCreateInput!) { createPerson(data: $data) { id name { firstName lastName } } }',
                { data: { name: { firstName: 'AVA', lastName } } });
            check(created.createPerson?.name?.lastName === lastName, 'QA_CRM_WRITE_FAILED');
            checks[`${role}_native_create`] = true;
            const read = await graphql('query($filter: PersonFilterInput!) { people(filter: $filter) { edges { node { id name { firstName lastName } } } } }',
                { filter: { id: { eq: created.createPerson.id } } });
            check(read.people?.edges?.length === 1 && read.people.edges[0].node.name.lastName === lastName, 'QA_CRM_READBACK_FAILED');
            checks[`${role}_native_readback`] = true;
            const updated = await graphql('mutation($id: UUID!, $data: PersonUpdateInput!) { updatePerson(id: $id, data: $data) { id name { firstName lastName } } }',
                { id: created.createPerson.id, data: { name: { firstName: 'AVA updated', lastName } } });
            check(updated.updatePerson?.name?.firstName === 'AVA updated', 'QA_CRM_UPDATE_FAILED');
            checks[`${role}_native_update`] = true;
            if (custom) {
                for (const spec of manifest.custom_objects) {
                    const type = spec.nameSingular[0].toUpperCase() + spec.nameSingular.slice(1);
                    const source = `qa-custom:${crypto.randomUUID()}`;
                    const data = { name: 'AVA isolated QA', avaBusinessId: String(ctx.businessId), avaSourceId: source };
                    for (const field of spec.fields) {
                        if (field in data) continue;
                        const definition = manifest.field_definitions[field];
                        data[field] = definition.type === 'NUMBER' ? 1 : definition.type === 'DATE' ? '2030-01-20'
                            : definition.type === 'DATE_TIME' ? '2030-01-20T10:00:00.000Z' : 'AVA isolated QA';
                    }
                    const mutation = `create${type}`;
                    const record = (await graphql(`mutation($data: ${type}CreateInput!) { ${mutation}(data:$data) { id avaBusinessId avaSourceId } }`, { data }))[mutation];
                    check(record?.avaBusinessId === String(ctx.businessId) && record?.avaSourceId === source, 'QA_CUSTOM_WRITE_FAILED');
                    const read = await graphql(`query($filter:${type}FilterInput!) { ${spec.namePlural}(filter:$filter) { edges { node { id avaBusinessId avaSourceId } } } }`, { filter:{ id:{ eq:record.id } } });
                    const nodes = read[spec.namePlural]?.edges;
                    check(nodes?.length === 1 && nodes[0].node.avaSourceId === source && nodes[0].node.avaBusinessId === String(ctx.businessId), 'QA_CUSTOM_READBACK_FAILED');
                    checks[`${role}_native_${spec.nameSingular}_readback`] = true;
                }
            }
        } finally {
            const revoked = await peer('/v1/sessions/revoke', { bindingId }, gatewayKey);
            check(revoked.nativeSessionAbsent === true, 'QA_REVOKE_FAILED');
            checks[`${role}_native_revoke`] = true;
        }
    }
    return { qa_only: true, buyer_acceptance: false, business_id: ctx.businessId, deployment_id: ctx.deploymentId, checks };
}
main().then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(error => {
    process.stderr.write(/^[A-Z_]{1,64}$/.test(error.code || '') ? error.code + '\n' : 'QA_CRM_FAILED\n'); process.exitCode = 1;
});
