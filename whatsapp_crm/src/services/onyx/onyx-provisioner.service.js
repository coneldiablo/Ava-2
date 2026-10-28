const crypto = require('crypto');
const DB = require('../database.service');
const { OnyxLlmGateway } = require('../onyx-llm-gateway.service');
const { OnyxClient, normalizeBaseUrl } = require('./onyx-client');
const Credentials = require('./onyx-credentials');
const NativeAcl = require('./onyx-native-acl');

const REQUIRED_ONYX_VERSION = 'v4.7.0';

const READ_ACTIONS = new Set([
    'get_customer',
    'get_booking',
    'get_availability',
    'get_hotel_info',
    'get_call_history',
    'get_campaign',
]);

const ROLE_ACTIONS = {
    sales: new Set(['get_customer', 'get_booking', 'get_availability', 'get_hotel_info']),
    manager: new Set(['get_customer', 'get_booking', 'get_availability', 'get_hotel_info', 'get_call_history', 'get_campaign']),
    revenue: new Set(['get_hotel_info', 'get_availability', 'get_campaign']),
};

function invalidScope(message) {
    return Object.assign(new Error(message), { code: 'ONYX_CROSS_TENANT_VIOLATION', retryable: false });
}
function positiveId(value) { return Number.isSafeInteger(Number(value)) && Number(value) > 0; }
function ids(items) { return (items || []).map(item => Number(item.id ?? item.cc_pair_id ?? item)); }

class OnyxProvisionerService {
    constructor(options = {}) {
        this.clientFactory = options.clientFactory || ((opts) => new OnyxClient(opts));
        this.apiAdapter = options.apiAdapter || null;
        this.gateway = options.gateway || new OnyxLlmGateway();
    }

    _getClient(baseUrl, apiKey) {
        return this.clientFactory({
            baseUrl: normalizeBaseUrl(baseUrl || process.env.ONYX_BASE_URL || 'http://localhost:8080'),
            apiKey: apiKey || process.env.ONYX_BOOTSTRAP_API_KEY || process.env.ONYX_ADMIN_API_KEY || '',
            adapter: this.apiAdapter,
        });
    }

    async verifyOnyxCapabilities(client) {
        try {
            let version = null;
            try {
                const versionRes = await client.getVersion();
                version = versionRes?.version || versionRes?.backend_version || versionRes;
            } catch (_) {
                // Fallback to health check if version endpoint is restricted
                const health = await client.getHealth();
                version = health?.version;
            }

            const verStr = String(version || '').trim();
            if (!/^v?4\.7\.0(?:[-+].*)?$/.test(verStr)) {
                const err = new Error(`Установленная версия Onyx (${verStr}) не поддерживается. Требуется версия ${REQUIRED_ONYX_VERSION} для обеспечения изоляции приватных контуров.`);
                err.code = 'ONYX_VERSION_UNSUPPORTED';
                err.statusCode = 422;
                err.nonRetryable = true;
                throw err;
            }
            return { supported: true, version: verStr };
        } catch (error) {
            if (error.code === 'ONYX_VERSION_UNSUPPORTED') throw error;
            // If connection failure or network error, wrap appropriately
            const err = new Error(`Не удалось проверить возможности Onyx: ${error.message}`);
            err.code = error.code || 'ONYX_CAPABILITY_CHECK_FAILED';
            err.statusCode = error.statusCode || 503;
            throw err;
        }
    }

    async ensurePrivateCcPair(businessId, businessName, client, checkpoint = {}, save = () => {}) {
        const name = `ava-hotel-${businessId}-connector`;
        const verify = pair => {
            if (!positiveId(pair?.id) || pair.name !== name || pair.access_type !== 'private'
                || pair.connector?.name !== name || pair.connector?.source !== 'ingestion_api'
                || !positiveId(pair.connector?.id) || !positiveId(pair.credential?.id)) {
                throw invalidScope('Private ingestion connector ownership could not be verified');
            }
            return Number(pair.id);
        };
        if (checkpoint.ccPairId) return verify(await client.getCcPair(checkpoint.ccPairId));
        // /admin/connector excludes ingestion_api; use native pair status for
        // reconciliation, including after a lost response.
        const pairs = await client.getConnectorStatuses();
        if (!Array.isArray(pairs)) throw invalidScope('Unexpected connector status response');
        const matches = pairs.filter(pair => pair.name === name);
        if (matches.length > 1) throw invalidScope('Duplicate private connectors require review');
        if (matches.length) return verify(await client.getCcPair(matches[0].cc_pair_id));
        if (checkpoint.ccPairCreateRequested) {
            throw Object.assign(new Error('Результат создания приватного контура не подтвержден; требуется сверка ресурсов'),
                { code: 'ONYX_CREATE_RECONCILIATION_REQUIRED', retryable: false });
        }
        save({ ccPairCreateRequested: true });
        // This native endpoint creates a real connector and its non-secret
        // ingestion credential together; its name is part of Onyx's public API.
        const created = await client.createPrivateIngestionConnector({
            name, source: 'ingestion_api', input_type: 'load_state',
            connector_specific_config: {}, refresh_freq: null, access_type: 'private', groups: client.runtimeGroupId ? [client.runtimeGroupId] : [],
        });
        if (created?.success !== true || !positiveId(created.data)) {
            throw invalidScope('Native connector creation was not confirmed');
        }
        return verify(await client.getCcPair(created.data));
    }

    async ensurePrivateDocumentSet(businessId, businessName, ccPairId, client, checkpoint = {}) {
        const setName = `ava-hotel-${businessId}-knowledge`;

        const sets = await client.getDocumentSets();
        const setList = Array.isArray(sets) ? sets : (sets?.document_sets || []);
        const existing = setList.find((s) => s.name === setName);

        if (existing) {
            // Verify isolation boundary
            const details = await client.getDocumentSet(existing.id);

            if (details.is_public !== false) {
                const err = new Error(`Document set ${setName} is public, violating tenant boundary.`);
                err.code = 'ONYX_CROSS_TENANT_VIOLATION';
                err.statusCode = 422;
                err.nonRetryable = true;
                throw err;
            }

            const ccPairIds = (details.cc_pair_summaries || details.cc_pair_descriptors || details.cc_pairs || [])
                .map((p) => Number(p.id || p.cc_pair_id || p));
            if (ccPairIds.length !== 1 || ccPairIds[0] !== ccPairId
                || (checkpoint.documentSetId && Number(checkpoint.documentSetId) !== Number(existing.id))) {
                const err = new Error(`Document set ${setName} crosses tenant cc-pair boundary.`);
                err.code = 'ONYX_CROSS_TENANT_VIOLATION';
                err.statusCode = 422;
                err.nonRetryable = true;
                throw err;
            }

            return { id: Number(existing.id), name: setName };
        }

        const created = await client.createDocumentSet({
            name: setName,
            description: `AVA business ${businessId}: ${businessName || 'Hotel'}`,
            cc_pair_ids: [ccPairId],
            is_public: false,
            users: [],
            groups: client.runtimeGroupId ? [client.runtimeGroupId] : [],
        });

        const docsetId = Number(created?.id || created);
        if (!positiveId(docsetId)) throw invalidScope('Document set API returned no native ID');
        const verified = await client.getDocumentSet(docsetId);
        const pairIds = ids(verified.cc_pair_summaries || verified.cc_pair_descriptors || verified.cc_pairs);
        if (verified.is_public !== false || verified.name !== setName || pairIds.length !== 1 || pairIds[0] !== ccPairId) {
            throw invalidScope('Created document set failed isolation verification');
        }
        return { id: docsetId, name: setName };
    }

    async ensurePrivateLlmProvider(businessId, client, checkpoint = {}) {
        const providerName = `AVA Hotel ${businessId} LLM`;
        const modelAlias = `ava-hotel-${businessId}`;

        const proxyBaseUrl = (process.env.WHATSAPP_CRM_PUBLIC_URL || process.env.APP_PUBLIC_URL || 'https://app.crm.meludtech.tech')
            .replace(/\/+$/, '');

        const providersRes = await client.getLlmProviders();
        const providerList = Array.isArray(providersRes) ? providersRes : (providersRes?.providers || []);
        const existing = providerList.find((p) => p.name === providerName);
        if (existing) {
            const model = existing.model_configurations?.find(item => item.name === modelAlias);
            if (existing.is_public !== false || existing.api_base !== `${proxyBaseUrl}/api/integrations/onyx/llm`
                || existing.provider !== 'openai' || !positiveId(existing.id) || !positiveId(model?.id)) {
                throw invalidScope('Existing private model/provider boundary changed');
            }
            // Do not revoke an already working proxy token on every retry.
            return { providerId:existing.id, modelConfigId:model.id, modelAlias };
        }
        const tokenData = this.gateway.issueToken(businessId);

        const payload = {
            name: providerName,
            provider: 'openai',
            api_key: tokenData.token,
            api_base: `${proxyBaseUrl}/api/integrations/onyx/llm`,
            api_key_changed: true,
            is_public: false,
            is_auto_mode: false,
            personas: [],
            groups: client.runtimeGroupId ? [client.runtimeGroupId] : [],
            model_configurations: [{
                name: modelAlias,
                is_visible: true,
                max_input_tokens: 32768,
                supports_image_input: false,
                supports_reasoning: false,
                custom_display_name: `AVA: business ${businessId}`,
            }],
        };

        const result = await client.putLlmProvider(payload, true);
        const providerId = result?.id;
        const modelConfigId = result?.model_configurations?.find(m => m.name === modelAlias)?.id;

        if (!positiveId(providerId) || !positiveId(modelConfigId)) {
            throw Object.assign(new Error('Onyx did not return the dedicated provider/model IDs'),
                { code: 'ONYX_MODEL_NOT_VERIFIED', retryable: false });
        }
        return { providerId, modelConfigId, modelAlias };
    }

    async ensurePrivatePersonas(businessId, businessName, documentSetId, modelConfigId, client, checkpoint = {}) {
        const toolsRes = await client.getTools();
        const toolsList = Array.isArray(toolsRes) ? toolsRes : (toolsRes?.tools || []);
        const searchTool = toolsList.find((t) => (t.in_code_tool_id === 'SearchTool' || t.name === 'SearchTool') && t.enabled !== false);
        if (!searchTool || !positiveId(searchTool.id)) throw invalidScope('Native SearchTool is unavailable');

        const roles = [
            {
                role: 'sales',
                name: `AVA Hotel ${businessId} sales`,
                description: `Консультация гостей отеля ${businessName || businessId}, бронирование номеров и ответы по услугам.`,
                systemPrompt: `Ты — AI-ассистент отдела продаж отеля ${businessName || businessId}. Отвечай вежливо, факты подтверждай цитатами из базы отеля.`,
            },
            {
                role: 'manager',
                name: `AVA Hotel ${businessId} manager`,
                description: `Сопровождение бронирований, история обращений гостей и кампании отеля ${businessName || businessId}.`,
                systemPrompt: `Ты — AI-ассистент управляющего отеля ${businessName || businessId}. Доступ к истории звонков и профилям гостей строго по согласованию.`,
            },
            {
                role: 'revenue',
                name: `AVA Hotel ${businessId} revenue`,
                description: `Анализ загрузки, доступности категорий и тарифов отеля ${businessName || businessId}.`,
                systemPrompt: `Ты — AI-ассистент по доходам и тарифам отеля ${businessName || businessId}. Оперируй подтвержденными номерами и ценами.`,
            },
        ];

        const existingPersonas = await client.getPersonas();
        const personaList = Array.isArray(existingPersonas) ? existingPersonas : (existingPersonas?.personas || []);

        const bindings = [];
        const personaIds = [];

        for (const r of roles) {
            const existing = personaList.find((p) => p.name === r.name);
            const payload = {
                name: r.name,
                description: r.description,
                document_set_ids: [documentSetId],
                document_ids: [],
                hierarchy_node_ids: [],
                is_public: false,
                groups: client.runtimeGroupId ? [client.runtimeGroupId] : [],
                users: [],
                default_model_configuration_id: modelConfigId,
                tool_ids: [searchTool.id],
                system_prompt: r.systemPrompt,
                task_prompt: 'Отвечай по-русски. Факты подтверждай цитатами базы текущего отеля. Нельзя обещать выполненную операцию без результата инструмента AVA.',
                datetime_aware: true,
            };

            let personaId;
            if (existing) {
                const verified = await client.getPersona(existing.id);
                if (verified.is_public !== false || ids(verified.document_sets || verified.document_set_ids).join(',') !== String(documentSetId)
                    || Number(verified.default_model_configuration_id) !== Number(modelConfigId)
                    || (client.runtimeGroupId && ids(verified.groups).join(',') !== String(client.runtimeGroupId))) {
                    throw invalidScope('Existing private persona boundary changed');
                }
                personaId = existing.id;
            } else {
                const created = await client.createPersona(payload);
                personaId = created?.id || created;
            }

            personaIds.push(personaId);

            // Persist to onyx_agent_bindings table
            DB.run(`
                INSERT INTO onyx_agent_bindings (
                    business_id, role, onyx_base_url, persona_id, document_set_id,
                    document_set_name, model_configuration_id, search_tool_id, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(business_id, role) DO UPDATE SET
                    onyx_base_url = excluded.onyx_base_url,
                    persona_id = excluded.persona_id,
                    document_set_id = excluded.document_set_id,
                    document_set_name = excluded.document_set_name,
                    model_configuration_id = excluded.model_configuration_id,
                    search_tool_id = excluded.search_tool_id,
                    updated_at = CURRENT_TIMESTAMP
            `, [
                businessId,
                r.role,
                client.baseUrl,
                personaId,
                documentSetId,
                `ava-hotel-${businessId}-knowledge`,
                modelConfigId,
                searchTool.id,
            ]);

            bindings.push({ role: r.role, personaId, name: r.name });
        }

        return { bindings, personaIds, searchToolId: searchTool.id };
    }

    async ensureMcpBindings(businessId, bindings, client, checkpoint = {}) {
        let serversRes;
        try {
            serversRes = await client.getMcpServers();
        } catch (err) {
            const error = new Error(`Failed to discover Onyx MCP servers: ${err.message || 'Access denied / not found'}`);
            error.code = 'ONYX_MCP_DISCOVERY_FAILED';
            error.retryable = false;
            throw error;
        }

        const serverList = Array.isArray(serversRes) ? serversRes : (serversRes?.mcp_servers || []);
        const matches = serverList.filter((s) => s.name === 'AVA Read Actions');
        const existingServer = matches[0];
        if (!existingServer || !existingServer.id) {
            const error = new Error('Required MCP server "AVA Read Actions" is not configured in Onyx');
            error.code = 'ONYX_MCP_SERVER_NOT_FOUND';
            error.retryable = false;
            throw error;
        }
        const publicUrl = process.env.WHATSAPP_CRM_PUBLIC_URL || process.env.APP_PUBLIC_URL || 'https://app.crm.meludtech.tech';
        const expectedUrl = `${publicUrl.replace(/\/+$/, '')}/api/integrations/onyx/mcp`;
        if (matches.length !== 1 || existingServer.server_url !== expectedUrl || !expectedUrl.startsWith('https://')) {
            throw invalidScope('MCP server URL or ownership changed');
        }

        let snapshots;
        try {
            snapshots = await client.getMcpServerTools(existingServer.id);
        } catch (err) {
            const error = new Error(`Failed to fetch tools for MCP server ${existingServer.id}: ${err.message}`);
            error.code = 'ONYX_MCP_TOOLS_FETCH_FAILED';
            error.retryable = false;
            throw error;
        }

        const toolList = Array.isArray(snapshots) ? snapshots : (snapshots?.tools || []);
        const toolsMap = {};
        for (const t of toolList) {
            if (!READ_ACTIONS.has(t.name) || !positiveId(t.id) || Number(t.mcp_server_id) !== Number(existingServer.id)
                || toolsMap[t.name]) throw invalidScope('MCP catalog is not the verified read-only catalog');
            toolsMap[t.name] = t.id;
        }

        // Validate every private persona before making remote changes.
        const plans = [];
        for (const b of bindings) {
            const binding = DB.get('SELECT * FROM onyx_agent_bindings WHERE business_id=? AND role=?', [businessId, b.role]);
            const persona = await client.getPersona(b.personaId);
            if (!binding || Number(binding.persona_id) !== Number(b.personaId) || binding.onyx_base_url !== client.baseUrl
                || persona.is_public !== false || persona.name !== `AVA Hotel ${businessId} ${b.role}`
                || ids(persona.document_sets || persona.document_set_ids).join(',') !== String(binding.document_set_id)
                || Number(persona.default_model_configuration_id) !== Number(binding.model_configuration_id)) {
                throw invalidScope('Private persona ownership changed');
            }
            const allowedActions = ROLE_ACTIONS[b.role] || new Set();
            for (const action of allowedActions) {
                const toolId = toolsMap[action];
                if (!toolId) {
                    const error = new Error(`Required MCP tool "${action}" was not found on server ${existingServer.id}`);
                    error.code = 'ONYX_MCP_TOOL_NOT_FOUND';
                    error.retryable = false;
                    throw error;
                }
            }
            const payload = {
                name: persona.name, description: persona.description,
                is_public: false, document_set_ids: [binding.document_set_id],
                groups: persona.groups || [], users: (persona.users || []).map(user => user.id ?? user),
                default_model_configuration_id: binding.model_configuration_id,
                tool_ids: [...new Set([binding.search_tool_id, ...[...allowedActions].map(action => toolsMap[action])])],
                system_prompt: persona.system_prompt || '', task_prompt: persona.task_prompt || '',
                datetime_aware: persona.datetime_aware, replace_base_system_prompt: persona.replace_base_system_prompt,
                hierarchy_node_ids: ids(persona.hierarchy_nodes), document_ids: ids(persona.attached_documents),
                user_file_ids: persona.user_file_ids || [], starter_messages: persona.starter_messages,
                uploaded_image_id: persona.uploaded_image_id, icon_name: persona.icon_name, label_ids: ids(persona.labels),
            };
            plans.push({ b, payload, allowedActions });
        }
        if (Object.keys(toolsMap).length !== READ_ACTIONS.size) throw invalidScope('Incomplete read-only MCP catalog');
        await client.updateMcpServerTools(existingServer.id, [...READ_ACTIONS].sort());
        for (const { b, payload } of plans) {
            await client.updatePersona(b.personaId, payload);
            const verified = await client.getPersona(b.personaId);
            const actual = [...new Set(ids(verified.tools || verified.tool_ids))].sort((a,b) => a-b);
            const expected = [...payload.tool_ids].map(Number).sort((a,b) => a-b);
            if (verified.is_public !== false || JSON.stringify(actual) !== JSON.stringify(expected)) {
                throw invalidScope('Onyx did not persist private role-scoped MCP tools');
            }
        }
        // Publish local routing only after all native changes were read back.
        DB.db.transaction(() => {
            client.assertLease?.();
            for (const { b, allowedActions } of plans) {
                DB.run('DELETE FROM onyx_mcp_tool_bindings WHERE business_id=? AND agent_role=?', [businessId,b.role]);
                for (const action of allowedActions) DB.run(`
                    INSERT INTO onyx_mcp_tool_bindings (
                        business_id, agent_role, onyx_base_url, mcp_server_id, tool_name, tool_id
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(business_id, agent_role, tool_name) DO UPDATE SET
                        onyx_base_url = excluded.onyx_base_url,
                        mcp_server_id = excluded.mcp_server_id,
                        tool_id = excluded.tool_id
                `, [businessId, b.role, client.baseUrl, existingServer.id, action, toolsMap[action]]);
            }
        }).immediate();

        return { mcpServerId: existingServer.id };
    }

    async syncBusinessDocuments(businessId, kbInstanceId, ccPairId, client) {
        const bId = Number(businessId);
        const targetKbId = Number(kbInstanceId || bId);

        // Enforce strict tenant boundary (R6). instanceId is canonical;
        // business_id is a nullable compatibility mirror on newer uploads.
        // Forbid cross-tenant document smuggling where one hotel loads another hotel's documents.
        if (targetKbId !== bId || DB.get(`SELECT id FROM knowledge_base
            WHERE (instanceId=? AND business_id IS NOT NULL AND business_id!=?)
               OR (business_id=? AND instanceId!=?)
            LIMIT 1`, [bId,bId,bId,bId])) {
            throw Object.assign(new Error('Knowledge ownership must match the selected business'),
                { code: 'ONYX_KNOWLEDGE_SCOPE_MISMATCH', retryable: false });
        }
        const docs = DB.all(`SELECT id,title,filename,originalName,content,contentHash FROM knowledge_base
            WHERE instanceId=? AND isCurrent=1 AND (business_id IS NULL OR business_id=?)`, [bId,bId]);

        if (!docs || docs.length === 0) {
            return {
                docCount: 0,
                hasDocuments: false,
                userNextStep: 'Добавьте знания в базу отеля',
            };
        }

        // Upload strictly selected business documents
        let uploaded = 0;
        for (const doc of docs) {
            // Parsed chunks remain canonical after edits/last-chunk removal;
            // an old compatibility content field must not reintroduce text.
            const chunks = DB.all('SELECT text FROM kb_chunks WHERE kbId=? ORDER BY chunkIndex,id', [doc.id]);
            const content = chunks.map(c => c.text || '').join('\n\n').trim();
            if (!content || !content.trim()) continue;
            const externalId = `ava:${businessId}:knowledge:${doc.id}`;
            const contentHash = doc.contentHash || crypto.createHash('sha256').update(content).digest('hex');

            const acknowledgement = await client.ingestDocument({
                id: externalId,
                sections: [{ type: 'text', text: content, link: `/hotels/${businessId}/kb/${doc.id}` }],
                source: 'ingestion_api',
                semantic_identifier: doc.title || doc.originalName || doc.filename || externalId,
                title: doc.title || doc.originalName || doc.filename || externalId,
                metadata: {
                    business_id: String(businessId),
                    ava_entity_type: 'knowledge',
                    ava_source_id: String(doc.id),
                    ava_content_hash: contentHash,
                },
                from_ingestion_api: true,
            }, ccPairId);

            let acknowledgedId;
            try { acknowledgedId = typeof acknowledgement?.document_id === 'string'
                ? decodeURIComponent(acknowledgement.document_id) : null; }
            catch (_) { acknowledgedId = null; }
            if (acknowledgedId !== externalId) {
                throw Object.assign(new Error('Onyx ingestion acknowledgement was not verified'),
                    { code: 'ONYX_INGEST_ACK_INVALID', retryable: true });
            }
            client.assertLease?.();
            const current = DB.get(`SELECT contentHash FROM knowledge_base WHERE id=? AND instanceId=?
                AND isCurrent=1 AND (business_id IS NULL OR business_id=?)`, [doc.id, bId, bId]);
            if (!current || current.contentHash !== doc.contentHash) {
                throw Object.assign(new Error('Knowledge changed during ingestion'),
                    { code: 'ONYX_KNOWLEDGE_CHANGED', retryable: true });
            }

            // Record link
            DB.run(`
                INSERT INTO onyx_document_links (
                    business_id, entity_type, source_id, onyx_document_id, content_hash, last_synced_at
                ) VALUES (?, 'knowledge', ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(business_id, entity_type, source_id) DO UPDATE SET
                    onyx_document_id = excluded.onyx_document_id,
                    content_hash = excluded.content_hash,
                    last_synced_at = CURRENT_TIMESTAMP
            `, [businessId, doc.id, acknowledgement.document_id, contentHash]);

            uploaded++;
        }

        return {
            docCount: uploaded,
            hasDocuments: uploaded > 0,
            userNextStep: 'Документы отеля загружены в контур Onyx',
        };
    }

    async issueRuntimeCredentials(businessId, client) {
        const envRef = `ONYX_API_KEY_HOTEL_${businessId}`;
        // Check encryption configuration before creating a remote credential.
        Credentials.seal('preflight', businessId, envRef);
        let token;
        let issuedUserId;
        try { token = Credentials.resolve(businessId, envRef); }
        catch (error) {
            if (error.code !== 'ONYX_CREDENTIAL_UNAVAILABLE') throw error;
        }
        if (!token) {
            const name = `AVA_RUNTIME_KEY_${businessId}`;
            const keys = await client.getApiKeys();
            if (!Array.isArray(keys)) throw invalidScope('Unexpected native API-key listing');
            const matches = keys.filter(item => item.api_key_name === name);
            if (matches.length > 1) throw invalidScope('Duplicate native runtime keys require review');
            // Reconcile a lost create response by native name before issuing.
            const issued = matches.length
                ? await client.regenerateApiKey(matches[0].api_key_id)
                : await client.createApiKey(name, client.runtimeGroupId ? [client.runtimeGroupId] : []);
            if (!issued?.user_id || !issued?.api_key || issued.api_key === client.apiKey) {
                throw invalidScope('Native service-account credential was not returned');
            }
            token = issued.api_key;
            issuedUserId = issued.user_id;
        }
        const runtime = this._getClient(client.baseUrl, token);
        const identity = await runtime.getMe();
        if (!identity?.id || (issuedUserId && identity.id !== issuedUserId)
            || identity.is_admin === true || identity.is_superuser === true
            || !['basic', 'user', 'member', 'viewer'].includes(String(identity.role).toLowerCase())) {
            throw invalidScope('Runtime must use a dedicated non-administrator service account');
        }
        if (issuedUserId) {
            DB.db.transaction(() => {
                client.assertLease?.();
                Credentials.save(businessId, token, envRef);
                client.credentialSaved?.();
            }).immediate();
        }
        return { envRef, runtime, userId: identity.id };
    }

    async provisionTenant(instance, checkpoint = {}, options = {}) {
        const businessId = Number(instance.id);
        if (!Number.isInteger(businessId) || businessId < 1
            || !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [businessId])) {
            throw invalidScope('Business is missing or inactive');
        }
        const businessName = instance.name || `Hotel ${businessId}`;
        const kbInstanceId = Number(instance.knowledgeBaseInstanceId || businessId);

        const baseUrl = process.env.ONYX_BASE_URL || 'http://localhost:8080';
        const client = this._getClient(baseUrl);
        let currentCheckpoint = { ...checkpoint };
        let expectedRevision = DB.get('SELECT revision FROM onyx_tenant_links WHERE business_id=?', [businessId])?.revision;

        const saveCp = (updates) => {
            const link = DB.get('SELECT revision,status FROM onyx_tenant_links WHERE business_id=?', [businessId]);
            if (!DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [businessId])
                || link?.status === 'DISABLED' || link?.revision !== expectedRevision) {
                throw Object.assign(new Error('Подключение изменено или отключено во время проверки.'),
                    { code: 'ONYX_CONFIGURATION_CHANGED', retryable: false });
            }
            currentCheckpoint = { ...currentCheckpoint, ...updates };
            if (typeof options.onCheckpoint === 'function') {
                options.onCheckpoint(currentCheckpoint);
            }
        };
        client.assertLease = () => saveCp({});
        client.credentialSaved = () => {
            // Called inside the credential transaction, after its own trigger.
            expectedRevision = DB.get('SELECT revision FROM onyx_tenant_links WHERE business_id=?', [businessId])?.revision;
        };
        // Recheck ownership after every network wait, before the next side
        // effect; a late response must not let an expired worker carry on.
        if (client._request) {
            const request = client._request.bind(client);
            client._request = async (...args) => {
                client.assertLease();
                const result = await request(...args);
                client.assertLease();
                return result;
            };
        }

        try {
            Credentials.seal('preflight', businessId, `ONYX_API_KEY_HOTEL_${businessId}`);
            // 1. Verify Onyx Capabilities & Version
            await this.verifyOnyxCapabilities(client);
            saveCp({ capabilitiesVerified: true });
            client.runtimeGroupId = await NativeAcl.ensureGroup(businessId, client, currentCheckpoint, saveCp);

            // 2. Prepare Private CC-Pair Boundary
            const ccPairId = await this.ensurePrivateCcPair(businessId, businessName, client, currentCheckpoint, saveCp);
            saveCp({ ccPairId, ccPairConfigured: true });

            // 3. Prepare Private Document Set
            const docset = await this.ensurePrivateDocumentSet(businessId, businessName, ccPairId, client, currentCheckpoint);
            saveCp({ documentSetId: docset.id, documentSetName: docset.name });

            // 4. Prepare Private LLM Provider & Model
            const { providerId, modelConfigId, modelAlias } = await this.ensurePrivateLlmProvider(businessId, client, currentCheckpoint);
            saveCp({ providerId, modelConfigId, modelAlias });

            // 5. Prepare Private Personas
            const { bindings, personaIds, searchToolId } = await this.ensurePrivatePersonas(
                businessId,
                businessName,
                docset.id,
                modelConfigId,
                client,
                currentCheckpoint
            );
            saveCp({ personaIds, searchToolId });

            // 6. Bind MCP Tools
            const { mcpServerId } = await this.ensureMcpBindings(businessId, bindings, client, currentCheckpoint);
            saveCp({ mcpServerId });

            // 7. Sync Business Documents (strictly isolated, never copied)
            const docSync = await this.syncBusinessDocuments(businessId, kbInstanceId, ccPairId, client);
            saveCp({ docCount: docSync.docCount, hasDocuments: docSync.hasDocuments });

            // 8. Issue Dedicated Runtime Credential (separated from bootstrap)
            const { envRef, runtime, userId: runtimeUserId } = await this.issueRuntimeCredentials(businessId, client);
            // Bootstrap visibility is not runtime visibility. A native service
            // account without private-resource grants must not be called ready.
            for (const binding of bindings) {
                try {
                    const persona = await runtime.getPersona(binding.personaId);
                    if (persona.is_public !== false || persona.name !== binding.name
                        || ids(persona.document_sets || persona.document_set_ids).join(',') !== String(docset.id)) {
                        throw invalidScope('Runtime private persona scope is invalid');
                    }
                } catch (_) {
                    throw Object.assign(new Error('Выдайте сервисному аккаунту доступ только к приватным ресурсам этого отеля и повторите проверку'),
                        { code: 'ONYX_RUNTIME_ACCESS_NOT_VERIFIED', retryable: false });
                }
            }
            const acl = await NativeAcl.verifyRuntime(businessId, runtime, client.runtimeGroupId, personaIds);
            const ownGroup = (await client.getUserGroups()).find(group => group.id === client.runtimeGroupId);
            if (!ownGroup || ownGroup.users?.length !== 1 || ownGroup.users[0].id !== runtimeUserId
                || ids(ownGroup.cc_pairs).join(',') !== String(ccPairId)
                || ids(ownGroup.document_sets).join(',') !== String(docset.id)
                || ids(ownGroup.personas).sort((a,b) => a-b).join(',') !== [...personaIds].sort((a,b) => a-b).join(',')) {
                throw invalidScope('Native group resources or membership were not read back');
            }
            saveCp({ runtimeAcl: acl });
            saveCp({ credentialRef: envRef });

            // 9. Persist Tenant Link
            // CRITICAL: status is ALWAYS STAGING, never ACTIVE_LIVE before A11/A12/A18 cutover
            const status = 'STAGING';
            DB.db.transaction(() => {
                saveCp({});
                DB.run(`
                INSERT INTO onyx_tenant_links (
                    business_id, onyx_tenant_id, onyx_base_url, credential_ref,
                    cc_pair_id, onyx_version, readiness_json, schema_version,
                    status, last_health_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, '{}', '1.0', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT(business_id) DO UPDATE SET
                    onyx_tenant_id = excluded.onyx_tenant_id,
                    onyx_base_url = excluded.onyx_base_url,
                    credential_ref = excluded.credential_ref,
                    cc_pair_id = excluded.cc_pair_id,
                    onyx_version = excluded.onyx_version,
                    status = excluded.status,
                    last_health_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
            `, [
                businessId,
                `hotel_${businessId}`,
                baseUrl,
                envRef,
                ccPairId,
                REQUIRED_ONYX_VERSION,
                status,
            ]);
            }).immediate();

            const nextCheckpoint = {
                ...currentCheckpoint,
                onyxBound: true,
                tenantId: `hotel_${businessId}`,
                status,
                liveCutover: false,
            };

            return {
                status: 'DONE',
                stage: 'ready',
                checkpoint: nextCheckpoint,
                userNextStep: docSync.hasDocuments
                    ? 'Контур знаний Onyx подключен (режим STAGING)'
                    : 'Контур знаний Onyx подготовлен. Добавьте знания в базу отеля',
            };
        } catch (error) {
            error.checkpoint = currentCheckpoint;
            throw error;
        }
    }

    async deprovisionTenant(businessId) {
        const id = Number(businessId);
        Credentials.revoke(id);
        DB.run('DELETE FROM onyx_agent_bindings WHERE business_id = ?', [id]);
        DB.run('DELETE FROM onyx_mcp_tool_bindings WHERE business_id = ?', [id]);
        DB.run('DELETE FROM onyx_mcp_action_links WHERE business_id = ?', [id]);
        DB.run('DELETE FROM onyx_mcp_execution_scopes WHERE business_id = ?', [id]);
        DB.run("UPDATE onyx_tenant_links SET status = 'DISABLED', updated_at = CURRENT_TIMESTAMP WHERE business_id = ?", [id]);
        return { disabled: true, businessId: id };
    }
}

module.exports = new OnyxProvisionerService();
module.exports.OnyxProvisionerService = OnyxProvisionerService;
module.exports.REQUIRED_ONYX_VERSION = REQUIRED_ONYX_VERSION;
