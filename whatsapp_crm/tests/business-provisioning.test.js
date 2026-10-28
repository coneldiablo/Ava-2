const { describe, it, assert, runAll, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Store = require('../src/services/provisioning/business-provisioning-store.service');
const Worker = require('../src/services/provisioning/business-provisioning-worker.service');
const Service = require('../src/services/provisioning/business-provisioning.service');
const HotelProfileService = require('../src/services/hotel-profile.service');

describe('A02 (BBH-51): Атомарное создание бизнеса и устойчивая очередь подключения', () => {
    it('1. Атомарное создание: создает профиль, выделяет knowledgeBaseInstanceId, регистрирует SIP и jobs', async () => {
        createTestDB();

        const result = Store.createBusinessAtomic({
            name: 'Grand Hotel Oasis',
            hotelTimezone: 'Europe/Moscow',
            sipAliases: ['74951112233', '+7 495 111-22-33', '1001'],
            sipTrunkNumber: '+74950000001',
            hotelTone: 'formal',
        });

        assert.ok(result.instance, 'Инстанс создан');
        const bizId = result.instance.id;
        assert.strictEqual(result.instance.name, 'Grand Hotel Oasis');
        assert.strictEqual(Number(result.instance.knowledgeBaseInstanceId), bizId, 'KnowledgeBaseInstanceId равен businessId');
        assert.strictEqual(result.isExisting, false);

        // Проверяем регистрацию SIP-алиасов в таблице business_sip_aliases
        const aliases = DB.all('SELECT alias FROM business_sip_aliases WHERE businessId = ? ORDER BY alias ASC', [bizId]);
        assert.deepStrictEqual(aliases.map(a => a.alias), ['1001', '74951112233']);

        // Проверяем создание jobs для модулей
        const jobs = DB.all('SELECT module, stage, status, dependsOnModule FROM business_provisioning_jobs WHERE businessId = ? ORDER BY id ASC', [bizId]);
        const moduleNames = jobs.map(j => j.module);
        assert.ok(moduleNames.includes('knowledge_base'), 'Есть job knowledge_base');
        assert.ok(moduleNames.includes('crm_workspace'), 'Есть job crm_workspace');
        assert.ok(moduleNames.includes('onyx_runtime'), 'Есть job onyx_runtime');
        assert.ok(moduleNames.includes('telephony_sip'), 'Есть job telephony_sip');
        assert.ok(moduleNames.includes('whatsapp'), 'Есть job whatsapp');

        const onyxJob = jobs.find(j => j.module === 'onyx_runtime');
        assert.strictEqual(onyxJob.dependsOnModule, 'knowledge_base', 'Onyx зависит от knowledge_base');
    });

    it('2. Идемпотентность: повторный запрос с тем же Idempotency-Key не создает дубликатов', async () => {
        createTestDB();

        const payload = {
            name: 'Idempotent Resort',
            hotelTimezone: 'UTC',
            sipAliases: ['78129998877'],
        };

        const res1 = Store.createBusinessAtomic(payload, { idempotencyKey: 'idemp-req-001' });
        assert.strictEqual(res1.isExisting, false);
        const bizId1 = res1.instance.id;

        const countInstancesBefore = DB.get('SELECT COUNT(*) AS total FROM instances').total;
        const countJobsBefore = DB.get('SELECT COUNT(*) AS total FROM business_provisioning_jobs').total;

        // Повторный вызов с тем же ключом и тем же телом
        const res2 = Store.createBusinessAtomic(payload, { idempotencyKey: 'idemp-req-001' });
        assert.strictEqual(res2.isExisting, true, 'Помечен как существующий');
        assert.strictEqual(res2.instance.id, bizId1, 'Возвращен тот же businessId');

        const countInstancesAfter = DB.get('SELECT COUNT(*) AS total FROM instances').total;
        const countJobsAfter = DB.get('SELECT COUNT(*) AS total FROM business_provisioning_jobs').total;

        assert.strictEqual(countInstancesAfter, countInstancesBefore, 'Новый бизнес в instances не создан');
        assert.strictEqual(countJobsAfter, countJobsBefore, 'Дубликаты jobs не созданы');

        // Вызов с тем же ключом, но другим телом -> должен бросить 409
        let error = null;
        try {
            Store.createBusinessAtomic({ name: 'Tampered Payload' }, { idempotencyKey: 'idemp-req-001' });
        } catch (e) {
            error = e;
        }
        assert.ok(error, 'Брошена ошибка конфликта');
        assert.strictEqual(error.statusCode, 409);
        assert.strictEqual(error.code, 'IDEMPOTENCY_KEY_MISMATCH');
    });

    it('3. Атомарная проверка конфликтов SIP-алиасов', async () => {
        createTestDB();

        // Создаем отель 1 с алиасом 79991234567
        Store.createBusinessAtomic({
            name: 'Hotel Alpha',
            sipAliases: ['79991234567'],
        });

        // Попытка создать отель 2 с тем же алиасом -> 409
        let error = null;
        try {
            Store.createBusinessAtomic({
                name: 'Hotel Beta',
                sipAliases: ['79991234567', '2002'],
            });
        } catch (e) {
            error = e;
        }
        assert.ok(error, 'Конфликт алиаса обнаружен');
        assert.strictEqual(error.statusCode, 409);
        assert.strictEqual(error.code, 'SIP_ALIAS_CONFLICT');

        // В базе не должен появиться Hotel Beta
        const beta = DB.get("SELECT * FROM instances WHERE name = 'Hotel Beta'");
        assert.strictEqual(beta, undefined, 'Hotel Beta не был частично создан при ошибке транзакции');
    });

    it('4. Устойчивая очередь: эксклюзивный лизинг и изоляция от параллельных воркеров', async () => {
        createTestDB();

        Store.createBusinessAtomic({
            name: 'Queue Test Hotel',
            sipAliases: ['70001112233'],
        });

        // Worker 1 захватывает 1 задачу
        const leased1 = Store.leaseJobs(1, 60);
        assert.strictEqual(leased1.length, 1);
        const job1 = leased1[0];
        assert.strictEqual(job1.status, 'LEASED');
        assert.ok(job1.leaseToken, 'Выдан leaseToken');

        // Worker 2 пытается захватить задачу параллельно
        const leased2 = Store.leaseJobs(1, 60);
        assert.strictEqual(leased2.length, 1);
        const job2 = leased2[0];
        assert.notStrictEqual(job2.id, job1.id, 'Второй воркер получил ДРУГУЮ задачу, задача 1 не дублируется');
    });

    it('5. Зависимости в очереди: onyx_runtime ждет завершения knowledge_base', async () => {
        createTestDB();

        const { instance } = Store.createBusinessAtomic({
            name: 'Dependency Hotel',
        });

        // Запрашиваем все доступные задачи (limit = 10)
        const leased = Store.leaseJobs(10, 60);
        const leasedModules = leased.map(j => j.module);

        // onyx_runtime НЕ должен быть в leased, так как зависит от knowledge_base (status: PENDING)
        assert.strictEqual(leasedModules.includes('onyx_runtime'), false, 'Onyx не берется в работу, пока KB не готов');

        // Завершаем knowledge_base
        const kbJob = leased.find(j => j.module === 'knowledge_base');
        assert.ok(kbJob, 'knowledge_base был выдан в лизинг');
        const finishedKb = Store.finishJob(kbJob.id, kbJob.leaseToken, { status: 'DONE', stage: 'ready' });
        assert.strictEqual(finishedKb, true);

        // Теперь onyx_runtime становится доступен для лизинга
        const nextLeased = Store.leaseJobs(10, 60);
        const nextModules = nextLeased.map(j => j.module);
        assert.ok(nextModules.includes('onyx_runtime'), 'После завершения KB onyx_runtime взят в работу');
    });

    it('6. Stale recovery: автоматический сброс зависшего лизинга', async () => {
        createTestDB();

        Store.createBusinessAtomic({
            name: 'Stale Hotel',
        });

        // Захватываем с TTL = -10 секунд (уже просрочен)
        DB.run(`
            UPDATE business_provisioning_jobs
            SET status = 'LEASED',
                leaseToken = 'stale-token-123',
                leasedUntil = datetime('now', '-10 seconds')
            WHERE module = 'telephony_sip'
        `);

        // Вызов leaseJobs запускает stale recovery
        const leased = Store.leaseJobs(10, 60);
        const recoveredJob = leased.find(j => j.module === 'telephony_sip');
        assert.ok(recoveredJob, 'Зависшая задача telephony_sip была автоматически восстановлена и выдана новому лизу');
        assert.notStrictEqual(recoveredJob.leaseToken, 'stale-token-123', 'Старый токен лизинга заменен');
    });

    it('7. Exponential backoff и блокировка зависимых задач при исчерпании попыток', async () => {
        createTestDB();

        const { instance } = Store.createBusinessAtomic({
            name: 'Backoff Hotel',
        });

        const [kbJob] = Store.leaseJobs(1, 60);
        assert.strictEqual(kbJob.module, 'knowledge_base');

        // Имитируем сбой с retryable = true (попытка 1)
        Store.finishJob(kbJob.id, kbJob.leaseToken, {
            status: 'FAILED',
            retryable: true,
            errorCode: 'S3_TIMEOUT',
            errorMessage: 'Connection timed out',
        });

        const jobAfterFail1 = DB.get('SELECT * FROM business_provisioning_jobs WHERE id = ?', [kbJob.id]);
        assert.strictEqual(jobAfterFail1.status, 'PENDING', 'Переведено в PENDING для повтора');
        assert.strictEqual(jobAfterFail1.attempts, 1);
        assert.strictEqual(jobAfterFail1.lastErrorCode, 'S3_TIMEOUT');

        // Имитируем последнюю попытку (attempts = maxAttempts = 5)
        DB.run('UPDATE business_provisioning_jobs SET attempts = 5 WHERE id = ?', [kbJob.id]);
        // Захватываем для финальной попытки
        DB.run("UPDATE business_provisioning_jobs SET status = 'LEASED', leaseToken = 'last-try-token', leasedUntil=datetime('now','+60 seconds') WHERE id = ?", [kbJob.id]);

        Store.finishJob(kbJob.id, 'last-try-token', {
            status: 'FAILED',
            retryable: true,
            errorCode: 'S3_PERMANENT_ERROR',
            errorMessage: 'Fatal S3 bucket error',
        });

        const jobAfterFinalFail = DB.get('SELECT * FROM business_provisioning_jobs WHERE id = ?', [kbJob.id]);
        assert.strictEqual(jobAfterFinalFail.status, 'FAILED', 'После 5 попыток статус FAILED');

        // Зависимый onyx_runtime должен быть автоматически переведен в BLOCKED
        const onyxJob = DB.get("SELECT * FROM business_provisioning_jobs WHERE businessId = ? AND module = 'onyx_runtime'", [instance.id]);
        assert.strictEqual(onyxJob.status, 'BLOCKED', 'Зависимый модуль заблокирован');
    });

    it('8. Ручной retry: восстанавливает упавшие задачи без создания нового бизнеса', async () => {
        createTestDB();

        const { instance } = Store.createBusinessAtomic({
            name: 'Retry Hotel',
        });

        // Помечаем пару задач как FAILED и BLOCKED
        DB.run("UPDATE business_provisioning_jobs SET status = 'FAILED', attempts = 5 WHERE businessId = ? AND module = 'knowledge_base'", [instance.id]);
        DB.run("UPDATE business_provisioning_jobs SET status = 'BLOCKED' WHERE businessId = ? AND module = 'onyx_runtime'", [instance.id]);

        const countBefore = DB.get('SELECT COUNT(*) AS total FROM instances').total;

        // Ручной retry через Store
        const retried = Store.retryJobs(instance.id);
        assert.strictEqual(retried, 2, 'Сброшены 2 задачи');

        const countAfter = DB.get('SELECT COUNT(*) AS total FROM instances').total;
        assert.strictEqual(countAfter, countBefore, 'Новый бизнес не создан');

        const kbJob = DB.get("SELECT * FROM business_provisioning_jobs WHERE businessId = ? AND module = 'knowledge_base'", [instance.id]);
        const onyxJob = DB.get("SELECT * FROM business_provisioning_jobs WHERE businessId = ? AND module = 'onyx_runtime'", [instance.id]);

        assert.strictEqual(kbJob.status, 'PENDING');
        assert.strictEqual(kbJob.attempts, 0);
        assert.strictEqual(onyxJob.status, 'PENDING');
    });

    it('9. Безопасность API: статус и ошибки очищены от секретов, токенов и traceback', async () => {
        createTestDB();

        const { instance } = Store.createBusinessAtomic({
            name: 'Security Hotel',
        });

        // Завершаем одну задачу успешно, а вторую с ошибкой с чувствительными данными
        const [job1, job2] = Store.leaseJobs(2, 60);
        Store.finishJob(job1.id, job1.leaseToken, { status: 'DONE' });
        Store.finishJob(job2.id, job2.leaseToken, {
            status: 'FAILED',
            retryable: false,
            errorCode: 'AUTH_FAILED',
            errorMessage: 'Failed with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret and password=SuperSecretPassword at /app/services/crm.js:42:12',
        });

        const status = Store.getProvisioningStatus(instance.id);
        assert.ok(status);
        assert.strictEqual(status.overallStatus, 'partially_ready', 'Частичный успех показан как partially_ready, не ready');
        assert.ok(status.modules[job2.module]);

        const err = status.modules[job2.module].error;
        assert.strictEqual(err.includes('SuperSecretPassword'), false, 'Пароль вырезан');
        assert.strictEqual(err.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), false, 'JWT токен вырезан');
        assert.strictEqual(err.includes('/app/services/crm.js'), false, 'Traceback вырезан');
    });

    it('10. Профиль ставит задания в очередь; отдельный worker подтверждает этапы', async () => {
        createTestDB();

        const profile = await HotelProfileService.create({
            name: 'Full Flow Hotel',
            hotelTimezone: 'Asia/Dubai',
            sipAliases: ['79001234567'],
        }, { syncProcess: true });

        assert.strictEqual(profile.name, 'Full Flow Hotel');
        assert.ok(profile.id > 0);
        assert.strictEqual(profile.knowledgeBaseInstanceId, profile.id);

        const queued = await HotelProfileService.getProvisioningStatus(profile.id);
        assert.strictEqual(queued.progressPercent, 0, 'HTTP creation does not run external provisioning');
        await require('../src/services/provisioning/business-provisioning-worker.service').processQueue();

        const status = await HotelProfileService.getProvisioningStatus(profile.id);
        assert.ok(status, 'Статус provisioning получен');
        assert.ok(['ready', 'partially_ready', 'in_progress'].includes(status.overallStatus));
        assert.ok(status.progressPercent > 0 && status.progressPercent < 100, 'Настройка слота не подтверждает готовность внешних систем');
    });

    it('11. Отклоняет чужой knowledgeBaseInstanceId и выделяет собственный scope', async () => {
        createTestDB();

        // 1) Явно переданный ID базы знаний
        const sharedKb = await DB.createInstance({ name: 'Shared Master KB' });
        await assert.rejects(HotelProfileService.create({
            name: 'Hotel with Shared KB',
            knowledgeBaseInstanceId: sharedKb.id,
        }), { code: 'ONYX_KNOWLEDGE_SCOPE_MISMATCH' });
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM instances').n, 1, 'Создание бизнеса откатилось целиком');

        // 2) Не переданный ID базы знаний -> равен собственному businessId
        const hotelSelf = await HotelProfileService.create({
            name: 'Hotel with Dedicated KB',
        });
        assert.strictEqual(hotelSelf.knowledgeBaseInstanceId, hotelSelf.id, 'По умолчанию равен собственному ID');
    });
});

if (require.main === module) {
    runAll().then((success) => process.exit(success ? 0 : 1));
}
