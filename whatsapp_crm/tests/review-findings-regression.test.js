const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const BusinessProvisioningService = require('../src/services/provisioning/business-provisioning.service');
const Store = require('../src/services/provisioning/business-provisioning-store.service');
const Worker = require('../src/services/provisioning/business-provisioning-worker.service');
const TwentyProvisioner = require('../src/services/twenty/twenty-provisioner.service');
const TwentyStore = require('../src/services/twenty/twenty-store.service');
const OnyxProvisioner = require('../src/services/onyx/onyx-provisioner.service');
const { createMockOnyxServer } = require('./onyx-provisioning.test');
const Credentials = require('../src/services/onyx/onyx-credentials');

function twentyFixture() {
    let workspace;
    return {
        findWorkspace: async () => workspace || null,
        countWorkspaces: async () => workspace ? 1 : 0,
        createWorkspace: async ({slug}) => (workspace={id:'fixture-native-workspace',subdomain:slug,activationStatus:'ACTIVE',workspaceUrl:'https://fixture.example.test'}),
        configureMembership: async () => ({configured:true}),
        issueWorkspaceApiKey: async () => ({apiKey:'fixture-native-api-key'}),
        applySchemaManifest: async () => ({fieldsVerified:1}),
    };
}

describe('Review Findings Regression Suite (R1 - R7)', () => {
    it('R1: Очередь воркера автоматически завершает зависимые шаги за один drain-цикл', async () => {
        createTestDB();
        const oldBaseUrl = process.env.ONYX_BASE_URL;
        const oldAdapter = OnyxProvisioner.apiAdapter;
        process.env.ONYX_BASE_URL = 'http://localhost:8080';
        const { adapter } = createMockOnyxServer();
        OnyxProvisioner.apiAdapter = adapter;

        try {
            const created = await BusinessProvisioningService.createBusiness({
                name: 'Auto Drain Hotel',
            }, { autoProcess: false });
            const bizId = created.instance.id;

            DB.run(
                "INSERT INTO knowledge_base (instanceId, business_id, title, filename, originalName, content) VALUES (?, ?, 'FAQ', 'faq.txt', 'faq.txt', 'Бассейн 10-22')",
                [bizId, bizId]
            );

            // Одиночный вызов processQueue должен выполнить и knowledge_base, и разблокировать/выполнить onyx_runtime
            const processed = await Worker.processQueue(5);
            assert.ok(processed >= 2, 'Воркер обработал пачку и зависимый шаг без повторного ручного вызова');

            const kbJob = DB.get("SELECT * FROM business_provisioning_jobs WHERE businessId = ? AND module = 'knowledge_base'", [bizId]);
            assert.strictEqual(kbJob.status, 'DONE');

            const onyxJob = DB.get("SELECT * FROM business_provisioning_jobs WHERE businessId = ? AND module = 'onyx_runtime'", [bizId]);
            assert.strictEqual(onyxJob.status, 'DONE');
        } finally {
            OnyxProvisioner.apiAdapter = oldAdapter;
            process.env.ONYX_BASE_URL = oldBaseUrl;
        }
    });

    it('R2: Пропущенные внешние модули не маскируются под 100% готовность бизнеса', async () => {
        createTestDB();
        const created = await BusinessProvisioningService.createBusiness({
            name: 'Unconfigured Services Hotel',
        }, { autoProcess: false });
        const bizId = created.instance.id;

        // Помечаем Twenty и Onyx как SKIPPED (не сконфигурированы в сервере)
        DB.run("UPDATE business_provisioning_jobs SET status = 'SKIPPED', stage = 'skipped', userNextStep = 'Twenty CRM не настроена' WHERE businessId = ? AND module = 'crm_workspace'", [bizId]);
        DB.run("UPDATE business_provisioning_jobs SET status = 'SKIPPED', stage = 'skipped', userNextStep = 'Onyx не настроен' WHERE businessId = ? AND module = 'onyx_runtime'", [bizId]);
        DB.run("UPDATE business_provisioning_jobs SET status = 'DONE', stage = 'ready' WHERE businessId = ? AND module = 'knowledge_base'", [bizId]);
        DB.run("UPDATE business_provisioning_jobs SET status = 'DONE', stage = 'ready' WHERE businessId = ? AND module = 'telephony_sip'", [bizId]);
        DB.run("UPDATE business_provisioning_jobs SET status = 'DONE', stage = 'ready' WHERE businessId = ? AND module = 'whatsapp'", [bizId]);
        DB.run("UPDATE business_provisioning_jobs SET status = 'SKIPPED', stage = 'skipped' WHERE businessId = ? AND module = 'pms'", [bizId]);

        const status = Store.getProvisioningStatus(bizId);

        // Статус НЕ должен быть 'ready', и прогресс НЕ должен быть 100%
        assert.notStrictEqual(status.overallStatus, 'ready', 'Бизнес без CRM и Onyx не может иметь статус ready');
        assert.strictEqual(status.overallStatus, 'partially_ready');
        assert.ok(status.progressPercent < 100, 'Прогресс меньше 100% при пропущенных модулях');
        assert.ok(status.nextStep !== null, 'Пользователю предложен следующий шаг настройки');
    });

    it('R3: Ошибка проверки подключения Twenty не превращается в connected', async () => {
        createTestDB();
        process.env.TWENTY_CREDENTIALS_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        const biz = await DB.createInstance({ name: 'Failing Twenty Hotel' });

        const provisioner = new (TwentyProvisioner.constructor)({
            apiAdapter: { ...twentyFixture(), testConnection: async () => false },
            clientFactory: () => ({
                testConnection: async () => {
                    const err = new Error('Twenty 503 Service Unavailable');
                    err.statusCode = 503;
                    throw err;
                },
                request: async () => ({ data: [] }),
            }),
        });

        let thrown = null;
        try {
            await provisioner.provisionWorkspace(biz.id, biz);
        } catch (e) {
            thrown = e;
        }

        assert.ok(thrown, 'Должна быть выброшена ошибка при недоступном Twenty');
        assert.strictEqual(thrown.code, 'TWENTY_CONNECTION_FAILED');

        const link = TwentyStore.getIntegrationUnsafe(biz.id);
        assert.notStrictEqual(link?.connectionStatus, 'connected', 'Статус не должен быть connected');
    });

    it('R4: Сбой на втором шаге Twenty сохраняет чекпоинт с workspaceId и не плодит дубли', async () => {
        createTestDB();
        process.env.TWENTY_CREDENTIALS_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        const biz = await DB.createInstance({ name: 'Crash Recovery Hotel' });
        let createCalls = 0;

        const provisioner = new (TwentyProvisioner.constructor)({
            apiAdapter: twentyFixture(),
            clientFactory: () => ({
                testConnection: async () => ({ data: [] }),
                request: async () => ({ data: [] }),
            }),
        });

        const origCreate = provisioner.createWorkspace.bind(provisioner);
        provisioner.createWorkspace = async (params) => {
            createCalls++;
            return origCreate(params);
        };

        // Шаг 2 падает
        provisioner.configureMembership = async () => {
            const err = new Error('Network timeout configuring membership');
            err.code = 'MEMBERSHIP_TIMEOUT';
            throw err;
        };

        let savedCheckpoint = null;
        let firstError = null;
        try {
            await provisioner.provisionWorkspace(biz.id, biz, {}, {
                onCheckpoint: (cp) => { savedCheckpoint = cp; },
            });
        } catch (err) {
            firstError = err;
        }

        assert.ok(firstError, 'Первая попытка завершилась ошибкой');
        assert.ok(firstError.checkpoint?.workspaceId, 'Ошибка сохранила чекпоинт с созданным workspaceId');
        assert.ok(savedCheckpoint?.workspaceId, 'onCheckpoint зафиксировал workspaceId');
        assert.strictEqual(createCalls, 1);

        const firstWorkspaceId = savedCheckpoint.workspaceId;

        // Повторный запуск (retry) с сохраненным чекпоинтом
        provisioner.configureMembership = async () => ({ configured: true });
        const recovered = await provisioner.provisionWorkspace(biz.id, biz, savedCheckpoint);

        assert.strictEqual(recovered.workspaceId, firstWorkspaceId, 'Повторный запуск переиспользовал исходный workspace');
        assert.strictEqual(createCalls, 1, 'createWorkspace НЕ вызывался повторно');
    });

    it('R5: Runtime-ключ Onyx сохраняется в БД и доступен без process.env', async () => {
        createTestDB();
        const business = await DB.createInstance({name:'Native key fixture'});
        const bizId = business.id;
        const {adapter} = createMockOnyxServer();
        const provisioner = new OnyxProvisioner.constructor({apiAdapter:adapter});
        const creds = await provisioner.issueRuntimeCredentials(bizId, provisioner._getClient('https://onyx.example.test','fixture-bootstrap'));

        assert.ok(creds.envRef);
        const key = Credentials.resolve(bizId);
        assert.ok(key);

        // Проверяем наличие записи в SQLite
        const row = DB.get('SELECT * FROM onyx_tenant_credentials WHERE env_ref = ?', [creds.envRef]);
        assert.ok(row, 'Запись создана в таблице onyx_tenant_credentials');
        assert.strictEqual(row.token, '');
        assert.ok(!row.token_encrypted.includes(key));
        assert.strictEqual(row.business_id, bizId);

        // Симулируем отдельный процесс (удаляем из process.env Node)
        delete process.env[creds.envRef];
        assert.strictEqual(process.env[creds.envRef], undefined);

        // Проверяем чтение из SQLite
        assert.strictEqual(Credentials.resolve(bizId), key, 'Ключ расшифрован из БД');
    });

    it('R6: Изоляция базы знаний: чужой scope не позволяет загрузить документы в новый бизнес', async () => {
        createTestDB();
        const hotelA = await DB.createInstance({ id: 10, name: 'Hotel A' });
        const hotelB = await DB.createInstance({ id: 20, name: 'Hotel B' });

        // Документ отеля A
        DB.run(
            "INSERT INTO knowledge_base (instanceId, business_id, title, filename, originalName, content) VALUES (?, ?, 'Секреты Отеля A', 'secrets.txt', 'secrets.txt', 'Пароль от сейфа 1234')",
            [hotelA.id, hotelA.id]
        );

        const ingestedDocs = [];
        const mockClient = {
            ingestDocument: async (doc) => {
                ingestedDocs.push(doc);
                return { success: true };
            },
        };

        // Попытка передать knowledgeBaseInstanceId отеля A при синхронизации для отеля B
        await assert.rejects(OnyxProvisioner.syncBusinessDocuments(hotelB.id, hotelA.id, 999, mockClient), {code:'ONYX_KNOWLEDGE_SCOPE_MISMATCH'});

        // Документы отеля A НЕ должны быть загружены для отеля B
        assert.strictEqual(ingestedDocs.length, 0, 'Ingest API не получил документов чужого отеля');
    });

    it('R7: Ошибки MCP discovery (403/404) вызывают явное исключение без дефолтных ID=1', async () => {
        createTestDB();
        const bizId = 33;
        const bindings = [{ role: 'sales', personaId: 101, name: 'Sales Agent' }];

        // Mock-клиент с ошибкой 403 на discovery
        const failingClient = {
            baseUrl: 'http://localhost:8080',
            getMcpServers: async () => {
                const err = new Error('403 Forbidden accessing MCP servers');
                err.statusCode = 403;
                throw err;
            },
        };

        let discoveryError = null;
        try {
            await OnyxProvisioner.ensureMcpBindings(bizId, bindings, failingClient);
        } catch (e) {
            discoveryError = e;
        }

        assert.ok(discoveryError, 'Должна быть выброшена ошибка discovery');
        assert.strictEqual(discoveryError.code, 'ONYX_MCP_DISCOVERY_FAILED');

        // В БД НЕ должно появиться фиктивных записей с tool_id = 1
        const bindingsRows = DB.all('SELECT * FROM onyx_mcp_tool_bindings WHERE business_id = ?', [bizId]);
        assert.strictEqual(bindingsRows.length, 0, 'Фиктивные MCP tool bindings не созданы');
    });
});
