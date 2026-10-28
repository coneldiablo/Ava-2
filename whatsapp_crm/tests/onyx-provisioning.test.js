const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const OnyxProvisioner = require('../src/services/onyx/onyx-provisioner.service');
const { REQUIRED_ONYX_VERSION } = require('../src/services/onyx/onyx-provisioner.service');
const BusinessProvisioningService = require('../src/services/provisioning/business-provisioning.service');
const BusinessProvisioningWorker = require('../src/services/provisioning/business-provisioning-worker.service');
const Credentials = require('../src/services/onyx/onyx-credentials');
const crypto = require('crypto');
process.env.ONYX_CREDENTIALS_MASTER_KEY = '33'.repeat(32);

function createMockOnyxServer() {
    const state = {
        version: REQUIRED_ONYX_VERSION,
        connectors: [],
        credentials: [],
        apiKeys: [],
        groups: [],
        ccPairs: [],
        documentSets: [],
        llmProviders: [],
        personas: [],
        tools: [{ id: 1, name: 'SearchTool', in_code_tool_id: 'SearchTool', enabled: true }],
        mcpServers: [{ id: 1, name: 'AVA Read Actions', server_url: 'https://app.crm.meludtech.tech/api/integrations/onyx/mcp' }],
        mcpTools: [
            { id: 1, name: 'get_customer', mcp_server_id: 1 },
            { id: 2, name: 'get_booking', mcp_server_id: 1 },
            { id: 3, name: 'get_availability', mcp_server_id: 1 },
            { id: 4, name: 'get_hotel_info', mcp_server_id: 1 },
            { id: 5, name: 'get_call_history', mcp_server_id: 1 },
            { id: 6, name: 'get_campaign', mcp_server_id: 1 },
        ],
        documents: [], // ingested documents
        idCounter: 100,
    };

    const nextId = () => ++state.idCounter;

    const adapter = async ({ method, path, data, client }) => {
        const cleanPath = path.replace(/^\/+/, '');

        // Contract fixture only: this exercises client handling of 403, not
        // the real Onyx authorization implementation (separate live gate).
        const nativeKey = state.apiKeys.find(key => key.api_key === client.apiKey);
        if (nativeKey) {
            if (cleanPath === 'manage/user-groups/minimal') return state.groups.filter(group => nativeKey.group_ids.includes(group.id))
                .map(group => ({ id: group.id, name: group.name, is_default: false }));
            if (cleanPath === 'manage/admin/user-group' || cleanPath === 'admin/api-key') {
                throw Object.assign(new Error('Fixture permission denied'), { statusCode: 403 });
            }
            const callerTenantId = Number(nativeKey.api_key_name.replace('AVA_RUNTIME_KEY_', ''));
            if (cleanPath.startsWith('persona/') && method === 'GET') {
                const persona = state.personas.find(p => p.id === Number(cleanPath.split('/').pop()));
                if (!persona?.name.startsWith(`AVA Hotel ${callerTenantId} `)) {
                    throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
                }
            }

            // Direct inspection of cc-pairs
            if (cleanPath.startsWith('manage/admin/cc-pair/')) {
                const requestedCcPairId = Number(cleanPath.split('/').pop());
                const pair = state.ccPairs.find((p) => p.id === requestedCcPairId);
                if (!pair || (callerTenantId && pair.tenantId !== callerTenantId)) {
                    const err = new Error('Access to requested cc-pair is forbidden for this tenant');
                    err.statusCode = 403;
                    err.code = 'ONYX_FORBIDDEN';
                    throw err;
                }
            }

            // Direct inspection of document sets
            if (cleanPath.startsWith('manage/admin/document-set/')) {
                const requestedDocSetId = Number(cleanPath.split('/').pop());
                const docset = state.documentSets.find((s) => s.id === requestedDocSetId);
                if (!docset || (callerTenantId && docset.tenantId !== callerTenantId)) {
                    const err = new Error('Access to requested document set is forbidden for this tenant');
                    err.statusCode = 403;
                    err.code = 'ONYX_FORBIDDEN';
                    throw err;
                }
            }

            // Ingestion check
            if (cleanPath === 'onyx-api/ingestion' && method === 'POST') {
                const targetCcPair = state.ccPairs.find((p) => p.id === data.cc_pair_id);
                if (!targetCcPair || (callerTenantId && targetCcPair.tenantId !== callerTenantId)) {
                    const err = new Error('Ingestion to foreign cc-pair is forbidden');
                    err.statusCode = 403;
                    err.code = 'ONYX_FORBIDDEN';
                    throw err;
                }
            }
        }

        if (cleanPath === 'health') {
            return { status: 'healthy', version: state.version };
        }

        if (cleanPath === 'manage/admin/version') {
            return { version: state.version };
        }

        if (cleanPath === 'me') {
            if (nativeKey) return { id: nativeKey.user_id, role: 'basic' };
            return { id: 'admin-user', email: 'admin@meludtech.tech', is_admin: true };
        }
        if (cleanPath === 'manage/admin/user-group' && method === 'GET') return state.groups.map(group => ({ ...group,
            users: state.apiKeys.filter(key => key.group_ids.includes(group.id)).map(key => ({ id: key.user_id })),
            cc_pairs: state.ccPairs.filter(pair => pair.groups.includes(group.id)),
            document_sets: state.documentSets.filter(set => set.groups.includes(group.id)),
            personas: state.personas.filter(persona => persona.groups.includes(group.id)),
        }));
        if (cleanPath === 'manage/admin/user-group' && method === 'POST') {
            if (state.groups.some(group => group.name === data.name)) throw Object.assign(new Error('Duplicate group'), { statusCode: 409 });
            const group = { id: nextId(), name: data.name, users: [], cc_pairs: [], document_sets: [], personas: [], is_default: false, is_up_for_deletion: false };
            state.groups.push(group);
            return group;
        }
        if (/manage\/admin\/user-group\/\d+\/permissions/.test(cleanPath)) return [];
        if (cleanPath === 'admin/api-key' && method === 'GET') return state.apiKeys.map(({ api_key, ...key }) => key);
        if (cleanPath === 'admin/api-key' && method === 'POST') {
            const key = { api_key_id: nextId(), api_key_name: data.name, group_ids: data.group_ids || [], user_id: crypto.randomUUID(), api_key: crypto.randomUUID() };
            state.apiKeys.push(key);
            return key;
        }
        if (cleanPath.endsWith('/regenerate') && method === 'POST') {
            const key = state.apiKeys.find(key => key.api_key_id === Number(cleanPath.split('/')[2]));
            key.api_key = crypto.randomUUID();
            return key;
        }

        if (cleanPath === 'manage/admin/connector' && method === 'GET') {
            return state.connectors;
        }
        if (cleanPath === 'manage/admin/connector/status' && method === 'GET') {
            return state.ccPairs.map(pair => ({...pair, cc_pair_id:pair.id}));
        }
        if (cleanPath === 'manage/admin/connector-with-mock-credential' && method === 'POST') {
            assert.strictEqual(data.access_type, 'private');
            const connector={id:nextId(),...data};
            const credential={id:nextId(),source:'ingestion_api'};
            state.connectors.push(connector);
            state.credentials.push(credential);
            const pair={id:nextId(),name:data.name,access_type:'private',connector,credential,groups:data.groups || [],
                tenantId:Number(data.name.match(/ava-hotel-(\d+)-/)[1])};
            state.ccPairs.push(pair);
            return {success:true,data:pair.id};
        }

        if (cleanPath === 'manage/admin/connector' && method === 'POST') {
            const connector = { id: nextId(), cc_pairs: [], ...data };
            state.connectors.push(connector);
            return connector;
        }

        if (cleanPath === 'manage/admin/credential' && method === 'GET') {
            return state.credentials;
        }

        if (cleanPath === 'manage/admin/credential' && method === 'POST') {
            const credential = { id: nextId(), ...data };
            state.credentials.push(credential);
            return credential;
        }

        if (cleanPath.startsWith('manage/admin/connector/') && cleanPath.includes('/credential/') && method === 'POST') {
            const parts = cleanPath.split('/');
            const connectorId = Number(parts[3]);
            const credentialId = Number(parts[5]);
            const connector = state.connectors.find((c) => c.id === connectorId);
            const tenantMatch = connector?.name?.match(/ava-hotel-(\d+)-connector/);
            const tenantId = tenantMatch ? Number(tenantMatch[1]) : null;

            const pair = {
                id: nextId(),
                connector_id: connectorId,
                credential_id: credentialId,
                tenantId,
                ...data,
            };
            state.ccPairs.push(pair);
            if (connector) connector.cc_pairs.push(pair);
            return pair;
        }

        if (cleanPath.startsWith('manage/admin/cc-pair/')) {
            const id = Number(cleanPath.split('/').pop());
            const pair = state.ccPairs.find((p) => p.id === id);
            if (!pair) throw Object.assign(new Error('CC-pair not found'), { statusCode: 404 });
            return pair;
        }

        if (cleanPath === 'manage/document-set' && method === 'GET') {
            return state.documentSets;
        }

        if (cleanPath.startsWith('manage/admin/document-set/') && method === 'GET') {
            const id = Number(cleanPath.split('/').pop());
            const docset = state.documentSets.find((s) => s.id === id);
            if (!docset) throw Object.assign(new Error('Document set not found'), { statusCode: 404 });
            return docset;
        }

        if (cleanPath === 'manage/admin/document-set' && method === 'POST') {
            const tenantMatch = data?.name?.match(/ava-hotel-(\d+)-knowledge/);
            const tenantId = tenantMatch ? Number(tenantMatch[1]) : null;
            const docset = {
                id: nextId(),
                cc_pair_descriptors: (data.cc_pair_ids || []).map((id) => ({ id })),
                tenantId,
                ...data,
            };
            state.documentSets.push(docset);
            return docset;
        }

        if (cleanPath === 'admin/llm/provider' && method === 'GET') {
            return { providers: state.llmProviders };
        }

        if (cleanPath.startsWith('admin/llm/provider') && method === 'PUT') {
            let provider = state.llmProviders.find((p) => p.name === data.name || (data.id && p.id === data.id));
            if (!provider) {
                provider = { id: nextId(), ...data };
                state.llmProviders.push(provider);
            } else {
                Object.assign(provider, data);
            }
            if (!provider.model_configurations || provider.model_configurations.length === 0) {
                provider.model_configurations = [{ id: nextId(), name: data.model_configurations?.[0]?.name || 'default' }];
            } else {
                provider.model_configurations = provider.model_configurations.map((m) => ({ id: m.id || nextId(), ...m }));
            }
            return provider;
        }

        if (cleanPath === 'tool' && method === 'GET') {
            return state.tools;
        }

        if (cleanPath === 'persona' && method === 'GET') {
            return state.personas;
        }

        if (cleanPath.startsWith('persona/') && method === 'GET') {
            const id = Number(cleanPath.split('/').pop());
            const p = state.personas.find((item) => item.id === id);
            if (!p) throw Object.assign(new Error('Persona not found'), { statusCode: 404 });
            return p;
        }

        if (cleanPath === 'persona' && method === 'POST') {
            const persona = { id: nextId(), ...data };
            state.personas.push(persona);
            return persona;
        }

        if (cleanPath.startsWith('persona/') && method === 'PATCH') {
            const id = Number(cleanPath.split('/').pop());
            const p = state.personas.find((item) => item.id === id);
            if (!p) throw Object.assign(new Error('Persona not found'), { statusCode: 404 });
            Object.assign(p, data);
            return p;
        }

        if (cleanPath.startsWith('persona/') && method === 'DELETE') {
            const id = Number(cleanPath.split('/').pop());
            state.personas = state.personas.filter((item) => item.id !== id);
            return { success: true };
        }

        if (cleanPath === 'admin/mcp/servers' && method === 'GET') {
            return { mcp_servers: state.mcpServers };
        }

        if (cleanPath.startsWith('admin/mcp/server/') && cleanPath.includes('/tools/snapshots')) {
            return { tools: state.mcpTools };
        }

        if (cleanPath === 'admin/mcp/servers/update' && method === 'POST') {
            return { success: true };
        }

        if (cleanPath === 'onyx-api/ingestion' && method === 'POST') {
            state.documents.push({
                cc_pair_id: data.cc_pair_id,
                ...data.document,
            });
            return { document_id: data.document.id, already_existed: false };
        }

        throw new Error(`Unhandled mock path: ${method} ${cleanPath}`);
    };

    return { state, adapter };
}

describe('A04 (BBH-53): Приватная область знаний Onyx для каждого бизнеса', () => {
    it('1. Проверка возможностей и ограничений: отклоняет неподдерживаемую версию Onyx с кодом ONYX_VERSION_UNSUPPORTED', async () => {
        createTestDB();
        const { state, adapter } = createMockOnyxServer();
        state.version = 'v3.8.1'; // Старая несовместимая версия

        const oldAdapter = OnyxProvisioner.apiAdapter;
        const oldBaseUrl = process.env.ONYX_BASE_URL;
        OnyxProvisioner.apiAdapter = adapter;
        process.env.ONYX_BASE_URL = 'http://onyx.test:8080';

        try {
            const client = OnyxProvisioner._getClient();
            let thrown = null;
            try {
                await OnyxProvisioner.verifyOnyxCapabilities(client);
            } catch (err) {
                thrown = err;
            }

            assert.ok(thrown, 'Ожидалась ошибка при несовместимой версии');
            assert.strictEqual(thrown.code, 'ONYX_VERSION_UNSUPPORTED');
            assert.strictEqual(thrown.statusCode, 422);
            assert.strictEqual(thrown.nonRetryable, true);
            assert.ok(thrown.message.includes('не поддерживается'));
            assert.ok(thrown.message.includes(REQUIRED_ONYX_VERSION));
        } finally {
            OnyxProvisioner.apiAdapter = oldAdapter;
            process.env.ONYX_BASE_URL = oldBaseUrl;
        }
    });

    it('2. Независимые приватные ресурсы: два бизнеса получают строго раздельные cc-pair, document set, LLM provider и personas', async () => {
        createTestDB();
        const { state, adapter } = createMockOnyxServer();

        const oldAdapter = OnyxProvisioner.apiAdapter;
        const oldBaseUrl = process.env.ONYX_BASE_URL;
        OnyxProvisioner.apiAdapter = adapter;
        process.env.ONYX_BASE_URL = 'http://onyx.test:8080';

        try {
            const bizA = await DB.createInstance({ name: 'Отель Астория', isActive: 1 });
            const bizB = await DB.createInstance({ name: 'Гранд Отель Поляна', isActive: 1 });

            const resA = await OnyxProvisioner.provisionTenant(bizA, {});
            const resB = await OnyxProvisioner.provisionTenant(bizB, {});

            assert.strictEqual(resA.status, 'DONE');
            assert.strictEqual(resB.status, 'DONE');

            // Проверка изоляции CC-pair
            assert.notStrictEqual(resA.checkpoint.ccPairId, resB.checkpoint.ccPairId, 'Разные cc_pair_id');

            // Проверка изоляции Document Set
            assert.notStrictEqual(resA.checkpoint.documentSetId, resB.checkpoint.documentSetId, 'Разные documentSetId');
            assert.strictEqual(resA.checkpoint.documentSetName, `ava-hotel-${bizA.id}-knowledge`);
            assert.strictEqual(resB.checkpoint.documentSetName, `ava-hotel-${bizB.id}-knowledge`);

            // Проверка свойств приватности
            const docsetA = state.documentSets.find((s) => s.id === resA.checkpoint.documentSetId);
            const docsetB = state.documentSets.find((s) => s.id === resB.checkpoint.documentSetId);
            assert.strictEqual(docsetA.is_public, false, 'Docset A должен быть приватным');
            assert.strictEqual(docsetB.is_public, false, 'Docset B должен быть приватным');

            // Проверка изоляции LLM Provider
            assert.notStrictEqual(resA.checkpoint.providerId, resB.checkpoint.providerId, 'Разные провайдеры LLM');
            const provA = state.llmProviders.find((p) => p.id === resA.checkpoint.providerId);
            const provB = state.llmProviders.find((p) => p.id === resB.checkpoint.providerId);
            assert.strictEqual(provA.is_public, false);
            assert.strictEqual(provB.is_public, false);
            assert.strictEqual(provA.model_configurations[0].name, `ava-hotel-${bizA.id}`);
            assert.strictEqual(provB.model_configurations[0].name, `ava-hotel-${bizB.id}`);

            // Проверка персон: у каждого бизнеса ровно 3 персоны (sales, manager, revenue)
            assert.strictEqual(resA.checkpoint.personaIds.length, 3);
            assert.strictEqual(resB.checkpoint.personaIds.length, 3);
            for (const pid of resA.checkpoint.personaIds) {
                assert.ok(!resB.checkpoint.personaIds.includes(pid), 'Персоны бизнеса A не пересекаются с B');
                const p = state.personas.find((item) => item.id === pid);
                assert.strictEqual(p.is_public, false, 'Персона должна быть приватной');
            }

            // Проверка БД: привязки сохранены с правильным tenantId
            const linkA = DB.get('SELECT * FROM onyx_tenant_links WHERE business_id = ?', [bizA.id]);
            const linkB = DB.get('SELECT * FROM onyx_tenant_links WHERE business_id = ?', [bizB.id]);
            assert.strictEqual(linkA.onyx_tenant_id, `hotel_${bizA.id}`);
            assert.strictEqual(linkB.onyx_tenant_id, `hotel_${bizB.id}`);
            assert.strictEqual(linkA.status, 'STAGING', 'Статус должен быть STAGING');
            assert.strictEqual(linkB.status, 'STAGING', 'Статус должен быть STAGING');
        } finally {
            OnyxProvisioner.apiAdapter = oldAdapter;
            process.env.ONYX_BASE_URL = oldBaseUrl;
        }
    });

    it('3. Разделение фактов в базе знаний: загружаются только документы выбранного отеля', async () => {
        createTestDB();
        const { state, adapter } = createMockOnyxServer();

        const oldAdapter = OnyxProvisioner.apiAdapter;
        const oldBaseUrl = process.env.ONYX_BASE_URL;
        OnyxProvisioner.apiAdapter = adapter;
        process.env.ONYX_BASE_URL = 'http://onyx.test:8080';

        try {
            const bizA = await DB.createInstance({ name: 'Отель Альфа', isActive: 1 });
            const bizB = await DB.createInstance({ name: 'Отель Бета', isActive: 1 });

            // Добавляем документы для Отеля Альфа
            DB.run(`
                INSERT INTO knowledge_base (instanceId, business_id, title, filename, originalName, content, contentHash)
                VALUES (?, ?, 'Правила проживания Альфа', 'rules.txt', 'rules.txt', 'Отель Альфа: время заезда 14:00, завтрак включен в стоимость.', 'hash_a1')
            `, [bizA.id, bizA.id]);

            // Добавляем документы для Отеля Бета
            DB.run(`
                INSERT INTO knowledge_base (instanceId, business_id, title, filename, originalName, content, contentHash)
                VALUES (?, ?, 'Правила проживания Бета', 'rules.txt', 'rules.txt', 'Отель Бета: время заезда 16:00, завтрак оплачивается отдельно 800р.', 'hash_b1')
            `, [bizB.id, bizB.id]);

            for (const businessId of [bizA.id, bizB.id]) DB.run(`INSERT INTO kb_chunks(kbId,chunkIndex,text)
                SELECT id,0,content FROM knowledge_base WHERE instanceId=?`, [businessId]);

            const resA = await OnyxProvisioner.provisionTenant(bizA, {});
            const resB = await OnyxProvisioner.provisionTenant(bizB, {});

            assert.strictEqual(resA.checkpoint.docCount, 1);
            assert.strictEqual(resB.checkpoint.docCount, 1);

            // Проверяем, что в хранилище документов cc_pair_id строго изолированы
            const docsA = state.documents.filter((d) => d.cc_pair_id === resA.checkpoint.ccPairId);
            const docsB = state.documents.filter((d) => d.cc_pair_id === resB.checkpoint.ccPairId);

            assert.strictEqual(docsA.length, 1);
            assert.strictEqual(docsB.length, 1);
            assert.ok(docsA[0].sections[0].text.includes('Отель Альфа: время заезда 14:00'));
            assert.ok(!docsA[0].sections[0].text.includes('Отель Бета'));

            assert.ok(docsB[0].sections[0].text.includes('Отель Бета: время заезда 16:00'));
            assert.ok(!docsB[0].sections[0].text.includes('Отель Альфа'));
        } finally {
            OnyxProvisioner.apiAdapter = oldAdapter;
            process.env.ONYX_BASE_URL = oldBaseUrl;
        }
    });

    it('3a. Синхронизация использует текущий DB-документ и canonical kb_chunks.text', async () => {
        createTestDB();
        const bizA = await DB.createInstance({ name: 'Отель Альфа', isActive: 1 });
        const bizB = await DB.createInstance({ name: 'Отель Бета', isActive: 1 });

        DB.run(`INSERT INTO knowledge_base
            (instanceId,business_id,title,filename,originalName,content,contentHash,version,isCurrent)
            VALUES (?,?,'Старые правила','rules-v1.txt','rules.txt','Старый факт: заезд в 12:00','old-hash',1,0)`,
        [bizA.id,bizA.id]);
        const currentId = DB.addKnowledgeBaseFile(
            bizA.id, 'rules-v2.txt', 'rules.txt', 'current-hash', 'text/plain', 64, 2
        );
        DB.run("UPDATE knowledge_base SET content='SYNTHETIC_STALE_COMPATIBILITY_TEXT' WHERE id=?", [currentId]);
        DB.run('INSERT INTO kb_chunks (kbId,chunkIndex,text) VALUES (?,?,?)',
            [currentId,0,'Актуальный факт: заезд в 15:00']);
        DB.run('INSERT INTO kb_chunks (kbId,chunkIndex,text) VALUES (?,?,?)',
            [currentId,1,'Завтрак начинается в 07:00']);

        const ingested = [];
        const client = { ingestDocument: async (document, ccPairId) => {
            ingested.push({ document, ccPairId });
            return { document_id: encodeURIComponent(document.id) };
        } };
        const result = await OnyxProvisioner.syncBusinessDocuments(bizA.id, bizA.id, 77, client);

        assert.strictEqual(result.docCount, 1);
        assert.strictEqual(ingested.length, 1);
        assert.strictEqual(ingested[0].ccPairId, 77);
        assert.strictEqual(ingested[0].document.id, `ava:${bizA.id}:knowledge:${currentId}`);
        assert.ok(ingested[0].document.sections[0].text.includes('Актуальный факт: заезд в 15:00'));
        assert.ok(ingested[0].document.sections[0].text.includes('Завтрак начинается в 07:00'));
        assert.ok(!ingested[0].document.sections[0].text.includes('Старый факт'));
        assert.ok(!ingested[0].document.sections[0].text.includes('SYNTHETIC_STALE_COMPATIBILITY_TEXT'));

        for (const ack of [{}, { document_id: `ava:${bizB.id}:knowledge:${currentId}` },
            { document_id: '%' }]) {
            DB.run('DELETE FROM onyx_document_links WHERE business_id=?', [bizA.id]);
            await assert.rejects(OnyxProvisioner.syncBusinessDocuments(bizA.id, bizA.id, 77,
                { ingestDocument: async () => ack }), { code: 'ONYX_INGEST_ACK_INVALID' });
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM onyx_document_links WHERE business_id=?', [bizA.id]).n, 0);
        }
        await assert.rejects(OnyxProvisioner.syncBusinessDocuments(bizA.id, bizA.id, 77,
            { ingestDocument: async document => {
                DB.updateChunkContent(bizA.id, DB.getDocumentChunks(bizA.id, currentId)[0].id, 'SYNTHETIC_CHANGED', null);
                return { document_id: document.id };
            } }), { code: 'ONYX_KNOWLEDGE_CHANGED' });
        assert.equal(DB.get('SELECT COUNT(*) AS n FROM onyx_document_links WHERE business_id=?', [bizA.id]).n, 0);

        DB.run(`INSERT INTO knowledge_base
            (instanceId,business_id,title,filename,originalName,content,contentHash,isCurrent)
            VALUES (?,?,'Чужой документ','foreign.txt','foreign.txt','Чужой факт','foreign-hash',1)`,
        [bizA.id,bizB.id]);
        await assert.rejects(
            OnyxProvisioner.syncBusinessDocuments(bizA.id, bizA.id, 77, client),
            { code: 'ONYX_KNOWLEDGE_SCOPE_MISMATCH', retryable: false }
        );
        await assert.rejects(
            OnyxProvisioner.syncBusinessDocuments(bizA.id, bizB.id, 77, client),
            { code: 'ONYX_KNOWLEDGE_SCOPE_MISMATCH', retryable: false }
        );
        assert.strictEqual(ingested.length, 1, 'Cross-tenant rows must be rejected before another ingest');
    });

    it('4. Граница прав: прямой API-запрос с ключом бизнеса B не может прочитать или изменить ресурсы бизнеса A', async () => {
        createTestDB();
        const { adapter } = createMockOnyxServer();

        const oldAdapter = OnyxProvisioner.apiAdapter;
        const oldBaseUrl = process.env.ONYX_BASE_URL;
        OnyxProvisioner.apiAdapter = adapter;
        process.env.ONYX_BASE_URL = 'http://onyx.test:8080';

        try {
            const bizA = await DB.createInstance({ name: 'Отель А', isActive: 1 });
            const bizB = await DB.createInstance({ name: 'Отель Б', isActive: 1 });

            const resA = await OnyxProvisioner.provisionTenant(bizA, {});
            const resB = await OnyxProvisioner.provisionTenant(bizB, {});

            const linkB = DB.get('SELECT * FROM onyx_tenant_links WHERE business_id = ?', [bizB.id]);
            const keyB = Credentials.resolve(bizB.id, linkB.credential_ref);
            assert.ok(keyB, 'Ключ отеля B разрешается из зашифрованного хранилища');

            // Создаем клиент с runtime-ключом Отеля B
            const clientB = new (require('../src/services/onyx/onyx-client').OnyxClient)({
                baseUrl: 'http://onyx.test:8080',
                apiKey: keyB,
                adapter,
            });

            // 1. Попытка прочитать чужой cc-pair бизнеса A с ключом B
            let ccPairError = null;
            try {
                await clientB.getCcPair(resA.checkpoint.ccPairId);
            } catch (err) {
                ccPairError = err;
            }
            assert.ok(ccPairError, 'Запрос с ключом B к cc-pair A должен быть заблокирован');
            assert.strictEqual(ccPairError.statusCode, 403);

            // 2. Попытка прочитать чужой document set бизнеса A с ключом B
            let docSetError = null;
            try {
                await clientB.getDocumentSet(resA.checkpoint.documentSetId);
            } catch (err) {
                docSetError = err;
            }
            assert.ok(docSetError, 'Запрос с ключом B к docset A должен быть заблокирован');
            assert.strictEqual(docSetError.statusCode, 403);

            // 3. Попытка записи документа в чужой cc-pair бизнеса A с ключом B
            let ingestError = null;
            try {
                await clientB.ingestDocument({
                    id: 'ava:hack:knowledge:1',
                    sections: [{ type: 'text', text: 'Hack attempt' }],
                }, resA.checkpoint.ccPairId);
            } catch (err) {
                ingestError = err;
            }
            assert.ok(ingestError, 'Запись с ключом B в cc-pair A должна быть заблокирована');
            assert.strictEqual(ingestError.statusCode, 403);
        } finally {
            OnyxProvisioner.apiAdapter = oldAdapter;
            process.env.ONYX_BASE_URL = oldBaseUrl;
        }
    });

    it('5. Идемпотентность и recovery: повторный вызов (retry) не создает дубликатов document set, personas и cc-pair', async () => {
        createTestDB();
        const { state, adapter } = createMockOnyxServer();

        const oldAdapter = OnyxProvisioner.apiAdapter;
        const oldBaseUrl = process.env.ONYX_BASE_URL;
        OnyxProvisioner.apiAdapter = adapter;
        process.env.ONYX_BASE_URL = 'http://onyx.test:8080';

        try {
            const biz = await DB.createInstance({ name: 'Отель Идемпотент', isActive: 1 });

            // Первый прогон
            const first = await OnyxProvisioner.provisionTenant(biz, {});
            const docsetCount1 = state.documentSets.length;
            const personasCount1 = state.personas.length;
            const providersCount1 = state.llmProviders.length;
            const ccPairCount1 = state.ccPairs.length;

            // Повторный прогон с тем же чекпоинтом (симуляция ретрая упавшего шага)
            const second = await OnyxProvisioner.provisionTenant(biz, first.checkpoint);

            assert.strictEqual(state.documentSets.length, docsetCount1, 'Количество document set не увеличилось');
            assert.strictEqual(state.personas.length, personasCount1, 'Количество personas не увеличилось');
            assert.strictEqual(state.llmProviders.length, providersCount1, 'Количество LLM providers не увеличилось');
            assert.strictEqual(state.ccPairs.length, ccPairCount1, 'Количество cc-pair не увеличилось');

            assert.strictEqual(first.checkpoint.documentSetId, second.checkpoint.documentSetId);
            assert.strictEqual(first.checkpoint.ccPairId, second.checkpoint.ccPairId);
            assert.strictEqual(first.checkpoint.providerId, second.checkpoint.providerId);
            assert.deepStrictEqual(first.checkpoint.personaIds, second.checkpoint.personaIds);
        } finally {
            OnyxProvisioner.apiAdapter = oldAdapter;
            process.env.ONYX_BASE_URL = oldBaseUrl;
        }
    });

    it('6. Пустая база знаний: показывает «Добавьте знания», не копирует чужие данные', async () => {
        createTestDB();
        const { state, adapter } = createMockOnyxServer();

        const oldAdapter = OnyxProvisioner.apiAdapter;
        const oldBaseUrl = process.env.ONYX_BASE_URL;
        OnyxProvisioner.apiAdapter = adapter;
        process.env.ONYX_BASE_URL = 'http://onyx.test:8080';

        try {
            // Создаем эталонный отель с данными
            const donor = await DB.createInstance({ name: 'Отель Донор', isActive: 1 });
            DB.run("INSERT INTO knowledge_base (instanceId, business_id, title, filename, originalName, content) VALUES (?, ?, 'Секретные данные', 'secret.txt', 'secret.txt', 'Конфиденциально')", [donor.id, donor.id]);
            await OnyxProvisioner.provisionTenant(donor, {});

            // Создаем новый пустой отель
            const emptyHotel = await DB.createInstance({ name: 'Новый Отель Без Знаний', isActive: 1 });
            const res = await OnyxProvisioner.provisionTenant(emptyHotel, {});

            assert.strictEqual(res.checkpoint.docCount, 0);
            assert.strictEqual(res.checkpoint.hasDocuments, false);
            assert.ok(res.userNextStep.includes('Добавьте знания в базу отеля'));

            // Проверяем, что в cc_pair нового отеля не попало ни одного документа
            const docsEmpty = state.documents.filter((d) => d.cc_pair_id === res.checkpoint.ccPairId);
            assert.strictEqual(docsEmpty.length, 0, 'В пустой отель не должны копироваться документы');
        } finally {
            OnyxProvisioner.apiAdapter = oldAdapter;
            process.env.ONYX_BASE_URL = oldBaseUrl;
        }
    });

    it('7. Разделение bootstrap и runtime учетных данных: bootstrap PAT не сохраняется в связке тенанта', async () => {
        createTestDB();
        const { adapter } = createMockOnyxServer();

        const oldAdapter = OnyxProvisioner.apiAdapter;
        const oldBaseUrl = process.env.ONYX_BASE_URL;
        const oldBootstrap = process.env.ONYX_BOOTSTRAP_API_KEY;

        OnyxProvisioner.apiAdapter = adapter;
        process.env.ONYX_BASE_URL = 'http://onyx.test:8080';
        process.env.ONYX_BOOTSTRAP_API_KEY = 'super-secret-admin-bootstrap-token';

        try {
            const biz = await DB.createInstance({ name: 'Отель Секьюрити', isActive: 1 });
            await OnyxProvisioner.provisionTenant(biz, {});

            const link = DB.get('SELECT * FROM onyx_tenant_links WHERE business_id = ?', [biz.id]);
            assert.strictEqual(link.credential_ref, `ONYX_API_KEY_HOTEL_${biz.id}`);

            // Проверяем, что значение в env под этим ключом — это сгенерированный изолированный ключ, а не bootstrap токен
            const runtimeKey = Credentials.resolve(biz.id, link.credential_ref);
            assert.ok(runtimeKey);
            assert.strictEqual(process.env[link.credential_ref], undefined);
            assert.notStrictEqual(runtimeKey, process.env.ONYX_BOOTSTRAP_API_KEY);

            // Проверяем, что bootstrap токен нигде не сохранен в БД
            const rawRowJson = JSON.stringify(link);
            assert.ok(!rawRowJson.includes('super-secret-admin-bootstrap-token'));
        } finally {
            OnyxProvisioner.apiAdapter = oldAdapter;
            process.env.ONYX_BASE_URL = oldBaseUrl;
            process.env.ONYX_BOOTSTRAP_API_KEY = oldBootstrap;
        }
    });

    it('8. Безопасное отключение: deprovisionTenant очищает привязки тенанта без повреждения соседних бизнесов', async () => {
        createTestDB();
        const { adapter } = createMockOnyxServer();

        const oldAdapter = OnyxProvisioner.apiAdapter;
        const oldBaseUrl = process.env.ONYX_BASE_URL;
        OnyxProvisioner.apiAdapter = adapter;
        process.env.ONYX_BASE_URL = 'http://onyx.test:8080';

        try {
            const biz1 = await DB.createInstance({ name: 'Соседний Бизнес 1', isActive: 1 });
            const biz2 = await DB.createInstance({ name: 'Удаляемый Бизнес 2', isActive: 1 });

            await OnyxProvisioner.provisionTenant(biz1, {});
            await OnyxProvisioner.provisionTenant(biz2, {});

            // Отключаем Бизнес 2
            await OnyxProvisioner.deprovisionTenant(biz2.id);

            // Бизнес 2 должен быть disabled
            const link2 = DB.get('SELECT * FROM onyx_tenant_links WHERE business_id = ?', [biz2.id]);
            assert.strictEqual(link2.status, 'DISABLED');
            const bindings2 = DB.all('SELECT * FROM onyx_agent_bindings WHERE business_id = ?', [biz2.id]);
            assert.strictEqual(bindings2.length, 0);

            // Бизнес 1 должен остаться активным в STAGING со всеми привязками
            const link1 = DB.get('SELECT * FROM onyx_tenant_links WHERE business_id = ?', [biz1.id]);
            assert.strictEqual(link1.status, 'STAGING');
            const bindings1 = DB.all('SELECT * FROM onyx_agent_bindings WHERE business_id = ?', [biz1.id]);
            assert.strictEqual(bindings1.length, 3);
        } finally {
            OnyxProvisioner.apiAdapter = oldAdapter;
            process.env.ONYX_BASE_URL = oldBaseUrl;
        }
    });

    it('9. Контролируемый Cutover Guard: автоподключение не переводит статус в ACTIVE_LIVE', async () => {
        createTestDB();
        const { adapter } = createMockOnyxServer();

        const oldAdapter = OnyxProvisioner.apiAdapter;
        const oldBaseUrl = process.env.ONYX_BASE_URL;
        OnyxProvisioner.apiAdapter = adapter;
        process.env.ONYX_BASE_URL = 'http://onyx.test:8080';

        try {
            const biz = await DB.createInstance({ name: 'Отель Стейджинг', isActive: 1 });
            const res = await OnyxProvisioner.provisionTenant(biz, {});

            assert.strictEqual(res.checkpoint.status, 'STAGING');
            assert.strictEqual(res.checkpoint.liveCutover, false);

            const link = DB.get('SELECT status, readiness_json FROM onyx_tenant_links WHERE business_id = ?', [biz.id]);
            assert.strictEqual(link.status, 'STAGING');
            assert.notStrictEqual(link.status, 'ACTIVE_LIVE');
            assert.strictEqual(link.readiness_json, '{}', 'Readiness evidence должны быть пустыми до приёмки');
        } finally {
            OnyxProvisioner.apiAdapter = oldAdapter;
            process.env.ONYX_BASE_URL = oldBaseUrl;
        }
    });

    it('10. Сквозная интеграция с очередью A02: knowledge_base -> onyx_runtime успешно завершаются воркером', async () => {
        createTestDB();
        const { adapter } = createMockOnyxServer();

        const oldAdapter = OnyxProvisioner.apiAdapter;
        const oldBaseUrl = process.env.ONYX_BASE_URL;
        OnyxProvisioner.apiAdapter = adapter;
        process.env.ONYX_BASE_URL = 'http://onyx.test:8080';

        try {
            // Создаем отель с canonical current-документом: metadata в
            // knowledge_base, а фактическое содержимое — в kb_chunks.text.
            const created = await BusinessProvisioningService.createBusiness({
                name: 'Парк-Отель Родники',
                phone: '+79998887766',
            }, { autoProcess: false });
            const hotel = created.instance;

            DB.run(`INSERT INTO knowledge_base
                (instanceId,business_id,title,filename,originalName,content,version,isCurrent)
                VALUES (?,?,'Старая информация','info-v1.txt','info.txt','Бассейн работает до 20:00',1,0)`,
            [hotel.id,hotel.id]);
            const currentId = DB.addKnowledgeBaseFile(
                hotel.id, 'info-v2.txt', 'info.txt', 'current-pool-hash', 'text/plain', 48, 2
            );
            DB.run('INSERT INTO kb_chunks (kbId,chunkIndex,text) VALUES (?,?,?)',
                [currentId,0,'Бассейн работает до 23:00']);

            // Выполняем очередь: благодаря автоматическому drain loop обрабатываются и knowledge_base,
            // и автоматически разблокированный зависимый шаг onyx_runtime без второго ручного вызова (R1).
            const processed = await BusinessProvisioningWorker.processQueue(5);
            assert.ok(processed >= 2, 'Очередь полностью обработана, включая зависимый шаг');

            const kbJob = DB.get("SELECT * FROM business_provisioning_jobs WHERE businessId=? AND module='knowledge_base'", [hotel.id]);
            assert.strictEqual(kbJob.status, 'DONE');
            const kbCheckpoint = JSON.parse(kbJob.checkpointJson || '{}');
            assert.strictEqual(kbCheckpoint.hasDocuments, true);
            assert.strictEqual(kbCheckpoint.docCount, 1, 'Считается только current canonical документ');

            const onyxJob = DB.get("SELECT * FROM business_provisioning_jobs WHERE businessId=? AND module='onyx_runtime'", [hotel.id]);
            assert.strictEqual(onyxJob.status, 'DONE');
            assert.strictEqual(onyxJob.stage, 'ready');
            const onyxCheckpoint = JSON.parse(onyxJob.checkpointJson || '{}');
            assert.strictEqual(onyxCheckpoint.onyxBound, true);
            assert.strictEqual(onyxCheckpoint.status, 'STAGING');
            assert.strictEqual(onyxCheckpoint.hasDocuments, true);

            // Проверяем базу данных
            const onyxLink = DB.get('SELECT * FROM onyx_tenant_links WHERE business_id = ?', [hotel.id]);
            assert.ok(onyxLink);
            assert.strictEqual(onyxLink.status, 'STAGING');
            assert.strictEqual(onyxLink.onyx_tenant_id, `hotel_${hotel.id}`);
        } finally {
            OnyxProvisioner.apiAdapter = oldAdapter;
            process.env.ONYX_BASE_URL = oldBaseUrl;
        }
    });
});

module.exports = { createMockOnyxServer };
