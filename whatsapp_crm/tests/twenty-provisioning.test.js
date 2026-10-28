const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const TwentyStore = require('../src/services/twenty/twenty-store.service');
const TwentyService = require('../src/services/twenty/twenty.service');
const {
    TwentyProvisionerService,
    normalizeSlug,
    MAX_WORKSPACES_WITHOUT_ENTERPRISE_KEY,
} = require('../src/services/twenty/twenty-provisioner.service');
const ProvisioningWorker = require('../src/services/provisioning/business-provisioning-worker.service');
const { decryptJson } = require('../src/services/twenty/twenty-crypto');

process.env.TWENTY_CREDENTIALS_MASTER_KEY = '22'.repeat(32);
process.env.AVA_PUBLIC_BASE_URL = 'https://ava.example.test';

// Explicit control-plane fixture. Passing this suite is not proof of a
// compatible native Twenty management API or live workspace provisioning.
function createControlPlaneFixture() {
    const workspaces = [];
    return {
        findWorkspace: async ({slug}) => workspaces.find(ws => ws.subdomain === slug) || null,
        countWorkspaces: async () => workspaces.length,
        createWorkspace: async ({name,slug}) => {
            const ws = { id: `fixture-${slug}`, subdomain: slug, activationStatus: 'ACTIVE', displayName: name,
                workspaceUrl: `https://${slug}.crm.meludtech.tech` };
            workspaces.push(ws);
            return ws;
        },
        configureMembership: async () => ({ configured: true }),
        issueWorkspaceApiKey: async ({businessId}) => ({apiKey: `fixture-native-key-${businessId}`}),
    };
}
function standardObjects() {
    const manifest = require('../src/services/twenty/schema-manifest.json');
    return Object.keys(manifest.standard_object_fields).map(namePlural => ({ id: `obj_${namePlural}`, namePlural }));
}

function createMockClient() {
    const objects = standardObjects();
    const fields = [];
    return {
        request: async (method, path, options = {}) => {
            if (path === '/rest/metadata/objects') {
                if (method === 'GET') return { data: objects };
                if (method === 'POST') {
                    const item = { id: `obj_${options.data?.namePlural || 'c'}`, ...options.data };
                    objects.push(item);
                    return { data: item };
                }
            }
            if (path === '/rest/metadata/fields') {
                if (method === 'GET') return { data: fields };
                if (method === 'POST') {
                    const item = { id: `fld_${fields.length + 1}`, ...options.data };
                    fields.push(item);
                    return { data: item };
                }
            }
            return { data: [] };
        },
        testConnection: async () => ({ data: [] }),
    };
}

describe('A03 (BBH-52): Автоматическое создание и подключение Twenty workspace', () => {
    it('1. Генерация slug: транслитерация, спецсимволы, зарезервированные слова и детерминированность', () => {
        // Транслитерация кириллицы
        assert.strictEqual(normalizeSlug('Отель Восход', 2), 'otel-voskhod-2');
        assert.strictEqual(normalizeSlug('Гостиница «Южная Звезда»', 5), 'gostinitsa-yuzhnaya-zvezda-5');

        // Очистка спецсимволов и дефисов
        assert.strictEqual(normalizeSlug('Grand & Luxury Resort!!!', 10), 'grand-luxury-resort-10');
        assert.strictEqual(normalizeSlug('---Leading---Hotel---', 7), 'leading-hotel-7');

        // Зарезервированные поддомены
        assert.strictEqual(normalizeSlug('app', 3), 'biz-app-3');
        assert.strictEqual(normalizeSlug('crm', 4), 'biz-crm-4');
        assert.strictEqual(normalizeSlug('admin', 9), 'biz-admin-9');

        // Пустое имя -> дефолт
        assert.strictEqual(normalizeSlug('', 12), 'hotel-12');
        assert.strictEqual(normalizeSlug('   ', 15), 'hotel-15');
    });

    it('2. Лимит лицензии: блокирует 6-е пространство без Enterprise-ключа с кодом TWENTY_WORKSPACE_LIMIT_REACHED', () => {
        const provisioner = new TwentyProvisionerService();

        // 4 пространства -> ОК
        assert.strictEqual(provisioner.checkWorkspaceCapacity(4, false), true);

        // 5 пространств без Enterprise -> ошибка
        let error = null;
        try {
            provisioner.checkWorkspaceCapacity(5, false);
        } catch (e) {
            error = e;
        }
        assert.ok(error, 'Должна быть брошена ошибка превышения лимита');
        assert.strictEqual(error.code, 'TWENTY_WORKSPACE_LIMIT_REACHED');
        assert.strictEqual(error.statusCode, 422);
        assert.ok(error.message.includes('максимум 5 без Enterprise-лицензии'));

        // С Enterprise-ключом -> пропускает даже при >= 5
        assert.strictEqual(provisioner.checkWorkspaceCapacity(5, true), true);
        assert.strictEqual(provisioner.checkWorkspaceCapacity(10, true), true);
    });

    it('3. Разделение ключей: bootstrap-токен не попадает в базу, runtime-ключ зашифрован', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Security Hotel', ownerEmail: 'owner@security.test' });

        const provisioner = new TwentyProvisionerService({ apiAdapter: createControlPlaneFixture() });
        const mockClient = createMockClient();
        provisioner.clientFactory = () => mockClient;
        process.env.TWENTY_BOOTSTRAP_API_KEY = 'super-secret-bootstrap-admin-token';
        process.env.TWENTY_BASE_URL = 'https://crm.meludtech.tech';

        const result = await provisioner.provisionWorkspace(instance.id, instance);

        // Проверяем запись в twenty_workspace_links
        const link = TwentyStore.getIntegrationUnsafe(instance.id);
        assert.ok(link, 'Запись создана');
        assert.ok(link.apiKeyEncrypted, 'Ключ зашифрован');

        // Bootstrap-ключ нигде не записан в БД
        assert.strictEqual(link.apiKeyEncrypted.includes('super-secret-bootstrap-admin-token'), false);
        assert.strictEqual(JSON.stringify(link).includes('super-secret-bootstrap-admin-token'), false);

        // Чекпоинт не содержит сырой ключ
        assert.strictEqual(result.checkpoint.apiKey, undefined);

        // Runtime ключ расшифровывается только крипто-сервисом
        const decrypted = decryptJson(link.apiKeyEncrypted, { businessId: instance.id });
        assert.strictEqual(decrypted.apiKey, `fixture-native-key-${instance.id}`);
    });

    it('4. Идемпотентное применение схемы AVA (schema-manifest.json): custom objects и поля', async () => {
        const provisioner = new TwentyProvisionerService();

        const objectsStore = standardObjects();
        const fieldsStore = [];

        const mockClient = {
            request: async (method, path, options = {}) => {
                if (method === 'GET' && path === '/rest/metadata/objects') {
                    return { data: objectsStore };
                }
                if (method === 'POST' && path === '/rest/metadata/objects') {
                    const newObj = { id: `obj_${options.data.namePlural}`, ...options.data };
                    objectsStore.push(newObj);
                    return { data: newObj };
                }
                if (method === 'GET' && path === '/rest/metadata/fields') {
                    return { data: fieldsStore };
                }
                if (method === 'POST' && path === '/rest/metadata/fields') {
                    const newField = { id: `fld_${fieldsStore.length + 1}`, ...options.data };
                    fieldsStore.push(newField);
                    return { data: newField };
                }
                return { data: {} };
            },
        };

        provisioner.clientFactory = () => mockClient;

        // Первый прогон: создание схемы
        const stats1 = await provisioner.applySchemaManifest('https://test-workspace.crm.meludtech.tech', 'twk_dummy');
        assert.ok(stats1.objectsCreated >= 6, 'Созданы все custom objects из манифеста');
        assert.ok(stats1.fieldsCreated > 20, 'Созданы все необходимые поля');

        const initialObjectsCount = objectsStore.length;
        const initialFieldsCount = fieldsStore.length;

        // Второй прогон: идемпотентность (ничего нового не создается)
        const stats2 = await provisioner.applySchemaManifest('https://test-workspace.crm.meludtech.tech', 'twk_dummy');
        assert.strictEqual(stats2.objectsCreated, 0, 'Повторный запуск не создает объекты');
        assert.strictEqual(stats2.fieldsCreated, 0, 'Повторный запуск не создает поля');
        assert.ok(stats2.fieldsVerified >= initialFieldsCount, 'Все поля успешно проверены');
        assert.strictEqual(objectsStore.length, initialObjectsCount);
        assert.strictEqual(fieldsStore.length, initialFieldsCount);
    });

    it('5. Контроль несовпадения типов схемы: отказ при конфликтующем типе поля без разрушений', async () => {
        const provisioner = new TwentyProvisionerService();

        const mockClient = {
            request: async (method, path) => {
                if (path === '/rest/metadata/objects') {
                    return { data: [{ id: 'obj_companies', namePlural: 'companies' }] };
                }
                if (path === '/rest/metadata/fields') {
                    // Симулируем поле avaBusinessId с неверным типом NUMBER вместо TEXT
                    return { data: [{ id: 'fld_1', objectMetadataId: 'obj_companies', name: 'avaBusinessId', type: 'NUMBER' }] };
                }
                return { data: {} };
            },
        };

        provisioner.clientFactory = () => mockClient;

        let error = null;
        try {
            await provisioner.applySchemaManifest('https://test-workspace.crm.meludtech.tech', 'twk_dummy', {
                standard_object_fields: { companies: ['avaBusinessId'] }, field_definitions: { avaBusinessId: { type: 'TEXT' } },
            });
        } catch (e) {
            error = e;
        }

        assert.ok(error, 'Должна быть брошена ошибка несоответствия типа');
        assert.strictEqual(error.code, 'TWENTY_SCHEMA_TYPE_MISMATCH');
        assert.ok(error.message.includes('Type mismatch for companies.avaBusinessId'));
    });

    it('6. Подключение Webhook: создает подписанный HMAC токен и сохраняет хеш', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Webhook Hotel' });
        const provisioner = new TwentyProvisionerService({ apiAdapter: createControlPlaneFixture() });
        provisioner.clientFactory = () => createMockClient();
        process.env.TWENTY_BASE_URL = 'https://crm.meludtech.tech';

        await provisioner.provisionWorkspace(instance.id, instance);

        const link = TwentyStore.getIntegrationUnsafe(instance.id);
        assert.ok(link.webhookSecretEncrypted, 'HMAC секрет сохранен');
        assert.ok(link.webhookTokenHash, 'Хеш токена сохранен');
        assert.ok(link.webhookTokenEncrypted, 'Токен сохранен');
    });

    it('7. Checkpoint recovery: при сбое возобновляет работу без повторного создания workspace', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Crash Recovery Hotel' });
        const provisioner = new TwentyProvisionerService();
        provisioner.clientFactory = () => createMockClient();
        process.env.TWENTY_BASE_URL = 'https://crm.meludtech.tech';

        let createWorkspaceCalls = 0;
        const fakeCreatedWorkspace = {
            id: 'ws-existing-12345',
            displayName: instance.name,
            subdomain: 'crash-recovery-hotel-1',
            activationStatus: 'ACTIVE',
            workspaceUrl: 'https://crash-recovery-hotel-1.crm.meludtech.tech',
        };

        provisioner.apiAdapter = {
            findWorkspace: async ({ slug, workspaceId }) => {
                if (workspaceId === 'ws-existing-12345') return fakeCreatedWorkspace;
                return null;
            },
            createWorkspace: async () => {
                createWorkspaceCalls += 1;
                return fakeCreatedWorkspace;
            },
            configureMembership: async () => ({ configured: true }),
            issueWorkspaceApiKey: async () => ({ apiKey: 'twk_test_key_1' }),
            applySchemaManifest: async () => ({ objectsCreated: 0, fieldsCreated: 0, fieldsVerified: 25 }),
            countWorkspaces: async () => 1,
        };

        // Шаг 1: Симулируем сбой после создания workspace (в чекпоинте есть workspaceId)
        const interruptedCheckpoint = {
            workspaceId: 'ws-existing-12345',
            slug: 'crash-recovery-hotel-1',
            workspaceCreated: true,
        };

        // Шаг 2: Повторный запуск провижининга с чекпоинтом
        const resumeResult = await provisioner.provisionWorkspace(instance.id, instance, interruptedCheckpoint);

        assert.strictEqual(createWorkspaceCalls, 0, 'createWorkspace НЕ должен вызываться повторно при наличии workspaceId в чекпоинте');
        assert.strictEqual(resumeResult.workspaceId, 'ws-existing-12345');
        assert.strictEqual(resumeResult.checkpoint.workspaceLinked, true);
        assert.strictEqual(resumeResult.checkpoint.connectionStatus, 'staged');
        assert.strictEqual(resumeResult.checkpoint.initialSyncVerified, false);
    });

    it('8. Worker не объявляет CRM готовой до подтверждения webhook и initial sync', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'End To End Hotel' });

        const TwentyProvisioner = require('../src/services/twenty/twenty-provisioner.service');
        TwentyProvisioner.clientFactory = () => createMockClient();
        TwentyProvisioner.apiAdapter = createControlPlaneFixture();
        process.env.TWENTY_BASE_URL = 'https://crm.meludtech.tech';

        // Создаем задачу crm_workspace в очереди
        DB.run(`INSERT INTO business_provisioning_jobs (
            businessId, module, stage, status, checkpointJson
        ) VALUES (?, 'crm_workspace', 'init', 'PENDING', '{}')`, [instance.id]);

        const processed = await ProvisioningWorker.processQueue(5);
        assert.ok(processed > 0, 'Задание обработано');

        const job = DB.get("SELECT * FROM business_provisioning_jobs WHERE businessId=? AND module='crm_workspace'", [instance.id]);
        assert.strictEqual(job.status, 'SKIPPED');
        assert.strictEqual(job.stage, 'requires_verification');

        // Проверяем статус в twenty_workspace_links
        const link = TwentyStore.getIntegrationUnsafe(instance.id);
        assert.ok(link);
        assert.strictEqual(link.connectionStatus, 'staged');
        assert.strictEqual(link.mode, 'shadow');
        assert.strictEqual(link.enabled, 1);
        TwentyProvisioner.apiAdapter = null;
    });

    it('9. Обработка ошибки лимита воркером: установка правильного кода и завершение без бесконечного ретрая', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Overflow Hotel' });

        const TwentyProvisioner = require('../src/services/twenty/twenty-provisioner.service');
        TwentyProvisioner.clientFactory = () => createMockClient();
        TwentyProvisioner.apiAdapter = {
            findWorkspace: async () => null,
            countWorkspaces: async () => 5, // Уже 5 рабочих пространств!
        };
        delete process.env.TWENTY_ENTERPRISE_KEY;

        DB.run(`INSERT INTO business_provisioning_jobs (
            businessId, module, stage, status, checkpointJson
        ) VALUES (?, 'crm_workspace', 'init', 'PENDING', '{}')`, [instance.id]);

        await ProvisioningWorker.processQueue(5);

        const job = DB.get("SELECT * FROM business_provisioning_jobs WHERE businessId=? AND module='crm_workspace'", [instance.id]);
        assert.strictEqual(job.status, 'FAILED');
        assert.strictEqual(job.lastErrorCode, 'TWENTY_WORKSPACE_LIMIT_REACHED');
        assert.ok(job.userNextStep.includes('максимум 5 без Enterprise-лицензии'));

        // Очищаем мок
        TwentyProvisioner.apiAdapter = null;
    });

    it('10. Изоляция: существующий Business 1 («AVA Hotels») остается нетронутым', async () => {
        createTestDB();

        // Регистрируем Business 1 в точном соответствии с production
        const biz1 = await DB.createInstance({ id: 1, name: 'AVA Hotels' });
        TwentyStore.upsertIntegration(biz1.id, {
            workspaceId: '72600089-b4b4-4db3-a8b9-362f07033467',
            baseUrl: 'https://ava-hotels.crm.meludtech.tech',
            apiKeyEncrypted: 'fixture-cipher-biz1',
            mode: 'live',
            enabled: 1,
            connectionStatus: 'connected',
        });

        const biz1Before = TwentyStore.getIntegrationUnsafe(1);

        // Создаем Business 2 через автопровижининг
        const biz2 = await DB.createInstance({ id: 2, name: 'Novotel Moscow' });
        process.env.TWENTY_BASE_URL = 'https://crm.meludtech.tech';

        const provisioner = new TwentyProvisionerService({ apiAdapter: createControlPlaneFixture() });
        provisioner.clientFactory = () => createMockClient();
        await provisioner.provisionWorkspace(biz2.id, biz2);

        // Проверяем Business 1
        const biz1After = TwentyStore.getIntegrationUnsafe(1);
        assert.strictEqual(biz1After.workspaceId, biz1Before.workspaceId);
        assert.strictEqual(biz1After.baseUrl, 'https://ava-hotels.crm.meludtech.tech');
        assert.strictEqual(biz1After.apiKeyEncrypted, 'fixture-cipher-biz1');
        assert.strictEqual(biz1After.mode, 'live');
        assert.strictEqual(biz1After.enabled, 1);

        // Проверяем Business 2
        const biz2Link = TwentyStore.getIntegrationUnsafe(2);
        assert.notStrictEqual(biz2Link.workspaceId, biz1After.workspaceId);
        assert.notStrictEqual(biz2Link.baseUrl, biz1After.baseUrl);
        assert.strictEqual(biz2Link.baseUrl, 'https://novotel-moscow-2.crm.meludtech.tech');
        assert.strictEqual(biz2Link.mode, 'shadow');
    });
});
