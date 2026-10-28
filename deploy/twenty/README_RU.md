# Twenty CRM для AVA

Twenty — CRM-модуль единого продукта AVA. Текущий production размещает его на
том же сервере `203.0.113.10`, что AVA и Onyx; внутренние порты доступны только
локально и через защищённый reverse proxy. AVA остаётся источником звонков,
WhatsApp, кампаний и CRM-памяти; Twenty показывает людей, задачи, воронку и
безопасные проекции AVA. Отдельная VDS не требуется для текущей схемы.

## Административный bootstrap

Это инструкция оператору, а не покупателю. Автоматическое подключение CRM при
создании бизнеса ещё не принято: покупателю нельзя обещать готовность этого
сценария на основании ручных шагов ниже. Установленный Twenty v2.37.0 допускает
до 5 пространств без Enterprise key; шестое потребует действующего ключа.

1. Создайте DNS `crm.example.com` на IP Twenty VDS и TLS reverse proxy на `127.0.0.1:3000`.
2. Скопируйте `.env.example` в `.env`, замените домен и все секреты. Каждый секрет создаётся отдельно.
3. Проверьте конфигурацию: `docker compose --env-file .env -f docker-compose.twenty.yml config -q`.
4. Запустите: `docker compose --env-file .env -f docker-compose.twenty.yml up -d --wait`.
5. Создайте отдельный API key для workspace и передайте его provisioning-скрипту только через окружение:
   `TWENTY_API_KEY='...' ./provision_schema.py --base-url https://crm.example.com`.
   Скрипт идемпотентно создаёт custom objects, точные типы полей и служебные AVA-поля
   в стандартных объектах `Люди`, `Компании` и `Задачи`. Повторный запуск только проверяет схему;
   несовпадение типа считается ошибкой и не исправляется разрушительно.
6. В каждом workspace используйте отдельный API key с минимальными правами и отдельный Webhook.
7. В профиле соответствующего отеля AVA укажите URL, workspace ID и API key; сначала `shadow`, затем тест, начальная синхронизация и только потом `live`.

Один бизнес AVA связывается только с одним workspace Twenty. Общий API key между отелями запрещён.
Webhook подписывается HMAC SHA-256, проверяется с окном пять минут и дедуплицируется.
Недоступность Twenty не останавливает звонки, WhatsApp, PMS и задачи AVA: события остаются в outbox и повторяются с backoff.

Текущий bridge записывает строки `clients` в стандартный объект `people`, а не в
`avaCustomerIdentity`: `name`, `phones`, `jobTitle` являются стандартными полями,
а `avaBusinessId`, `avaSourceId`, `sourceUrl` нужно сначала создать из
`schema-manifest.json` в каждом workspace. `sourceUrl` ведёт на страницу бизнеса
AVA; прямой страницы клиента в этой проекции нет. Объект `avaCustomerIdentity`
зарезервирован в манифесте, но текущий sync bridge его не заполняет.
`opportunities` не получает запись от AVA и AVA-полей в нём пока нет. Перед
включением live-синхронизации после обновления схемы выполните provisioning
для нужного workspace и проверьте поля `people` в Twenty.

Outbox берёт по одной записи на аренду. Пока выполняется запрос к Twenty, воркер
продлевает аренду каждые 40 секунд (TTL 120 секунд). Истёкший или перехваченный
токен не может завершить job или сохранить локальную ссылку на запись. При
повторе создания используется стабильный ID Twenty, вычисленный из workspace,
бизнеса и исходной записи. Задание с истёкшей арендой возвращается в очередь.
Если процесс остановлен дольше TTL во время уже отправленного HTTP-запроса,
возможен повтор сетевой мутации; стабильный ID предотвращает вторую запись,
но Twenty не предоставляет здесь compare-and-swap для одновременных PATCH.

В production `LOG_LEVELS=error,warn`: Twenty v2.37 печатает полный URL исходящего
webhook на уровне `log`, а URL содержит секретный path token. Диагностика доставки
остаётся в redacted nginx access log и AVA inbox/audit; успешное выполнение job
Twenty само по себе **не доказывает** доставку HTTP. Не включайте `log/debug/verbose`
без redaction. После смены DNS обязательно проверяйте TLS из контейнера Twenty.

## Текущая production-конфигурация multi-workspace

С 8 сентября 2026 общий вход — `https://app.crm.meludtech.tech`, существующий
business 1 — `https://ava-hotels.crm.meludtech.tech`. Прежний адрес
`https://crm.meludtech.tech` сохраняется как корневой SERVER_URL и API alias,
а браузерные запросы перенаправляются на общий вход. Пароль и данные сохранены.

В `/opt/ava-deploy/twenty/` применяются **три** compose-файла:

```sh
docker compose -f docker-compose.twenty.yml \
  -f docker-compose.production.yml -f docker-compose.workspaces.yml config --quiet
docker compose -f docker-compose.twenty.yml \
  -f docker-compose.production.yml -f docker-compose.workspaces.yml \
  up -d --no-deps --no-build --pull never server worker
```

В существующей `.env` COMPOSE_FILE содержит эти три имени через двоеточие,
поэтому обычный `docker compose` также сохраняет overlay при перезапуске.
Overlay включает только `IS_MULTIWORKSPACE_ENABLED=true`, `DEFAULT_SUBDOMAIN=app`
и `IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS=true` у server/worker.
Image v2.37.0, volumes, пароль, роли и лицензионные ограничения не менялись.
Пользователь без server-admin прав не получает право создания пространства.

Само включение native-режима **не реализует** автоматическое создание бизнеса.
Ещё нужны durable provisioning, отдельные ключи/схема, HTTPS для нового адреса
и реальная проверка второго tenant. Покупатель не должен выполнять эти шаги вручную.

При необходимости откатить только режим: сначала проверить отсутствие новых
пространств, сделать recovery checkpoint, восстановить прежнюю nginx-конфигурацию
и COMPOSE_FILE с двумя прежними файлами, затем пересоздать только server/worker
явно с этими двумя файлами. TLS aliases можно оставить; проверенный API URL
business 1 не требует отката всей SQLite. Если появились новые пространства,
сначала согласовать последствия отключения multi-workspace для их пользователей.
Порядок и хэши checkpoint см. в production acceptance report.

## Резервное копирование

`./backup.sh` создаёт PostgreSQL dump, локальные файлы, Redis snapshot, recovery env,
manifest и SHA-256. В production дополнительно шифруйте весь каталог GPG и копируйте вне VDS.

### Проверка восстановления текущего checkpoint

`scripts/verify-twenty-restore.sh` в корне AVA принимает расшифрованный custom-format
dump через stdin. Он не умеет восстанавливать production: создаёт свой временный
PostgreSQL той же image, без сети/портов, с read-only rootfs и tmpfs для данных,
проверяет 110 таблиц и контрольные связи владельца/пространства/задачи, затем
удаляет контейнер по точному ID и собственной метке. Скрипт привязан к текущему
контрольному checkpoint AVA Hotels; для другой схемы ожидаемые данные надо явно
обновить после проверки. Роли/ACL не восстанавливаются (`--no-owner --no-privileges`),
поэтому это проверка schema/data recovery, не полной системы прав или запуска приложения.

Пример запуска с Mac (пути зашифрованного файла и ключа задаются локально):

```bash
set -o pipefail
gpg --batch --quiet --pinentry-mode loopback \
  --passphrase-file "$KEY_FILE" --decrypt "$ENCRYPTED_PGDUMP" \
  | ssh -i ~/.ssh/ava-deploy-ed25519 root@203.0.113.10 \
      'bash /root/ava-current/scripts/verify-twenty-restore.sh --isolated-from-stdin'
```

Ключ остаётся на Mac с mode 0600, plaintext dump не записывается. Успех — exit 0,
`isolated_restore_verified=true` и `temporary_container_removed=true`, а не только
успешный `pg_restore`. Детальные результаты и SHA текущих копий находятся в
`docs/PRODUCTION_ACCEPTANCE_2026-09-07_SINGLE_HOST_RU.md`.
