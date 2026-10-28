# AVA identity: подготовленный контур, не production-приёмка

Этот каталог не подключается автоматически к основному Compose. `AVA_CUSTOMER_ACCESS_ENABLED=false` остаётся значением по умолчанию. Развёртывание, создание native SSO clients и переключение пользователей требуют отдельного review и разрешения. Наличие этих файлов не означает, что единый вход в Twenty/Onyx работает.

**Изменение решения от 14.09.2026:** владелец выбрал собственные модули связи с сохранением native интерфейсов, без покупки штатного платного SSO. См. [новое решение](../../docs/AVA_MODULE_BRIDGE_DECISION_2026-09-14_RU.md). Keycloak остаётся общим сервисом identity; ссылки на коммерческий SSO ниже объясняют прежний вариант, а не требование приобрести подписку для нового.

## Что подготовлено

- Keycloak 26.7.3 и PostgreSQL 17.11 закреплены по OCI digest. Манифесты образов проверены в registry; Docker build/runtime здесь не проверен.
- Отдельная БД, лимит Keycloak 2 ГБ, БД 512 МБ, отсутствие публичного порта PostgreSQL.
- Внешний адрес `https://auth.meludtech.tech`, HTTP Keycloak доступен только через loopback 8084 и приватную сеть worker.
- Русский realm `ava`, открытая регистрация и SMTP reset выключены, пароль от 12 символов, защита от перебора.
- Конфиденциальный клиент AVA с PKCE, точным redirect URI и backchannel logout.
- Отдельный service account для enrollment worker: manage/view/query users, не realm-admin. Его secret не передаётся в CRM web.
- Публичный nginx не проксирует `/admin`, master realm и метрики.
- Покупательский вход оформлен отдельной темой `themes/ava` поверх штатных шаблонов Keycloak: русские подписи, адаптивная форма и видимый фокус. Проверка пароля и OIDC не меняются.

## Обновление только оформления действующего realm

`ava-realm.json` действует лишь при первом импорте и не заменяет существующий realm. Перед обновлением сохраните Compose, realm и `pg_dump` identity database, затем проверьте архив. На уже установленном образе тему можно подключить отдельным `ava-theme.override.yml` с read-only mount и пересоздать только `keycloak`; базовый Compose сервера не заменяйте. Проверка `docker compose config --quiet` обязательна до перезапуска.

После запуска `python3 set_login_theme.py` показывает текущую тему, `python3 set_login_theme.py --set ava` включает новую, `--set keycloak` возвращает штатную. Скрипт читает закрытый `.env` локально, не принимает пароль через аргументы и не выводит токен. Для отката также уберите override при следующем пересоздании контейнера. Сначала проверьте форму визуально на широком и мобильном экране, затем OIDC discovery и вход пользователя.

## Почта и вход после приглашения

SMTP для Keycloak на действующем realm настраивается отдельно от SMTP приложения AVA. На identity host `set_smtp_env.py` добавляет параметры в закрытый `/opt/ava-identity/.env` с резервной копией и запросом пароля без вывода на экран. `configure_smtp.py` проверяет SMTP AUTH, сохраняет резервную копию realm и проверяет readback настроек Keycloak. Эти проверки не отправляют письмо и не подтверждают доставку получателю. Изменение `ava-realm.json` не обновляет действующий realm.

Для обычного `/invite` Keycloak хранит `emailVerified=false` и `VERIFY_EMAIL`; письмо со ссылкой отправляется при первом входе. Для `/owner-invite` AVA уже проверяет почту шестизначным кодом до создания пользователя, поэтому worker сохраняет `emailVerified=true` и убирает только `VERIFY_EMAIL`, сохраняя остальные required actions. После регистрации владельца OIDC требует повторного входа и сверяет `sub` с новым AVA user ID. Регистрация без приглашения остаётся выключенной.

Пароль владельца шифруется только на время незавершённой регистрации и повтора после сбоя worker. При успешном завершении `passwordEncrypted` очищается в одной транзакции с отметкой подтверждения кода; ранее завершённые строки очищаются при первом открытии хранилища новой версией. Старые резервные копии и WAL могут сохранять прежний ciphertext и требуют отдельной проверки срока хранения после выпуска.

При выпуске новой версии уберите прежний production mount `ava-verify-email.override.yml` для `provisioning_worker`: он подменяет файл нового образа старой реализацией. Перед переключением проверьте Compose config и резервные копии; после переключения проверьте новый тестовый путь и Keycloak readback. Адрес ссылки Keycloak зависит от публичного `KC_HOSTNAME`, но фактический URL и получение письма проверяются только в отправленном письме.

Для владельца, который **уже** ввёл код до исправления и остался с `VERIFY_EMAIL`, в образе есть узкий инструмент `node src/services/identity/reconcile-owner-email.js --user-id <AVA_USER_ID>`. По умолчанию он только читает доказательство завершённого кода, AVA user/subject и Keycloak user; `--apply` отмечает email подтверждённым и убирает только `VERIFY_EMAIL` после точного совпадения личности. Запускайте в `provisioning_worker` после отдельного review и перед повторным входом владельца. Скрипт не отправляет письмо и не создаёт пользователя.

## До установки

1. Реализовать и проверить собственные native adapters по новому решению; подтвердить лицензии исходников и отсутствие использования коммерческих реализаций. Одно добавление Keycloak и AVA access store не обеспечивает бесшовного входа в модули.
2. Снять и проверить recovery backup, включая CRM SQLite, существующие настройки nginx/Compose и все существующие подключения. БД Keycloak после появления также включить в backup через `pg_dump`, не копировать живой каталог PostgreSQL.
3. Проверить DNS `auth.meludtech.tech` и выпустить его TLS-сертификат. `nginx.conf` ожидает готовые файлы `/etc/letsencrypt/live/auth.meludtech.tech/`.
4. В защищённом env-файле вне Git подготовить разные случайные `AVA_IDENTITY_DB_PASSWORD`, `AVA_IDENTITY_BOOTSTRAP_PASSWORD`, `AVA_OIDC_CLIENT_SECRET`, `AVA_IDENTITY_ADMIN_CLIENT_SECRET`, `AVA_IDENTITY_BROKER_TOKEN`. `SESSION_SECRET` и broker token — минимум 32 символа. Не передавать значения аргументами команд и не публиковать вывод `compose config`.
5. Отдельно проверить сервисную роль Twenty `AVA Integration`. По умолчанию больше не выдаётся ключ роли Admin. Создание и проверка минимальных native permissions ещё требуют реализации на установленной схеме; переименованный Admin ограниченной ролью не является.

## Проверка файлов без запуска

Из корня репозитория, с уже установленными защищёнными переменными окружения:

```sh
docker compose -f deploy/keycloak/docker-compose.yml config -q
docker compose --env-file .env.example -f docker-compose.yml -f deploy/keycloak/ava-worker.override.yml config --no-env-resolution -q
```

Для второй команды требуется непустой `OPENWA_API_KEY`; для локальной проверки структуры допустимо тестовое значение, но не для запуска. Команды ничего не развёртывают.

После разрешения reviewed commit разворачивается отдельным Compose проектом из этого каталога. Затем nginx-конфигурация проверяется до reload; существующие хосты не заменяются. Worker подключается к `ava-identity-worker` через `ava-worker.override.yml`. Только worker использует `http://ava-identity-provider:8080` для Admin API; веб-приложение использует HTTPS issuer.

Первый запуск импортирует `ava-realm.json`. Штатный импорт Keycloak пропускает уже существующий realm: изменение JSON не является миграцией действующего realm. Последующие изменения выполнять отдельной reviewed миграцией с backup и проверкой readback. Bootstrap administrator — аварийная учётная запись платформы; покупателям её не выдавать. Административный UI доступен только через защищённый операторский путь, не через публичный `/admin`.

## API AVA

- `GET /api/auth/config`, `/api/auth/me` — конфигурация входа и текущая серверная identity/memberships.
- `GET /api/auth/sso/start`, `/api/auth/sso/callback` — OIDC authorization-code flow.
- `POST /api/invitations` — только platform admin/аварийный оператор, с проверкой Origin. Ссылка содержит одноразовый token в fragment и выдаётся один раз; в БД только hash, срок 24 часа.
- `POST /api/invitations/redeem` — пароль передаётся непосредственно в отдельный worker/Keycloak, в AVA не хранится. Потеря lease или отзыв доступа запускают durable compensation.
- `POST /api/access/{userId}/revoke` и `/reinvite` — немедленно отзывают локальный доступ; native отзыв выполняется очередью. Новое приглашение ждёт завершения старого отзыва.
- `POST /api/auth/sso/backchannel-logout` — подпись, issuer/audience, событие logout, срок и replay проверяются до отзыва сессии.

## Что ещё не готово

Не реализованы собственные native auth adapters Twenty/Onyx, полное управление customer memberships в обоих модулях и их отдельными native sessions. Добавленный `module-access-store` подключён к публичному scoped API и отдельному закрытому broker в коде, но не заменяет эти адаптеры. Очередь отзыва намеренно возвращает `NATIVE_MODULE_REVOCATION_NOT_VERIFIED`, если есть такие подключения и их отзыв не доказан. Не включать feature flag как обход этого ограничения.

Также нужен аудит прав в Python Admin backend для передачи customer actor; сейчас он остаётся отдельным административным контуром, а не customer API. Mount всего проекта и Docker socket в существующем Admin UI не изолирует секреты от доверенного администратора платформы; это не равно строгому worker-only vault.

## Приёмка перед включением

Два новых тестовых бизнеса, разные покупатели: приглашение → свой пароль → AVA → свой Twenty → свои знания без второго пароля. Проверить прямой запрет чужого workspace/document set, logout/revoke всех трёх сессий, повтор приглашения и ротацию секретов. Только после этих проверок разрешать customer flag. Тесты с HTTP fixtures подтверждают код протокола, а не native SSO.

Источники контрактов: [Keycloak containers](https://www.keycloak.org/server/containers), [realm import](https://www.keycloak.org/server/importExport), [reverse proxy](https://www.keycloak.org/server/reverseproxy), [Twenty SSO](https://docs.twenty.com/user-guide/permissions-access/capabilities/sso-configuration), [Onyx Enterprise](https://docs.onyx.app/admins/getting_started/enterprise_edition).
