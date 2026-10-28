# Публичные адреса AVA на одном сервере

`ava-public-http.conf` и `ava-public-https.conf` обслуживают существующие
`ai.meludtech.tech` (Admin) и `wh.meludtech.tech` (WhatsApp CRM).
`ava-modules.conf` добавляет `crm.meludtech.tech` (Twenty) и
`knowledge.meludtech.tech` (Onyx). Все upstream локальные.

При установке `ava-public-https.conf` также скопировать
`ava-module-access-location.conf` в `/etc/nginx/snippets/` перед `nginx -t`.
На странице `/module-access` используется `Referrer-Policy: strict-origin`:
переход через HTML POST должен передать точный Origin AVA, но не URL или query.
`same-origin`/`no-referrer` на этой странице превращает Origin в `null` и ломает
проверку CSRF шлюза. Origin `null` шлюз по-прежнему не принимает.

## Буферизация ответов module-vhost

В `ava-modules.conf` обычные страницы, REST API и файлы проходят с
`proxy_buffering on`. Буферизация отключена только для потоковых маршрутов
Onyx v4.7.0, проверенных по исходникам закреплённой версии:

- `/api/chat/send-chat-message` (ответ SSE при `stream=true`, это значение по умолчанию);
- `/api/chat/chat-session/{id}/resume-stream`;
- `/api/voice/synthesize` (поток аудио) и `/api/image-generation/generate`
  (поток ответа с keepalive);
- `/api/build/sessions/{id}/scheduled-run-events`,
  `/api/build/sessions/{id}/subagents/{subagent_id}/send-message`,
  `/api/build/sessions/{id}/turns/{turn_id}/events` и
  `/api/build/debug/opencode-logs/stream` (SSE Craft).

Onyx принимает эти пути через внутренний nginx с префиксом `/api`, который
снимается перед FastAPI. Путей `/api/knowledge/stream` и `/graphql/stream` в
этом Onyx нет. При обновлении Onyx сверить перечень его StreamingResponse
маршрутов перед заменой edge-конфига.

Перед включением: сохранить копию действующего
`/etc/nginx/sites-available/ava-modules`, сравнить его с ожидаемым baseline,
установить новый файл, выполнить `nginx -t` и только затем reload. После
reload проверить первый чанк авторизованного streaming-запроса, обычный REST,
статический файл и прежний CRM redirect. `pytest -q tests/test_ava_modules_nginx.py`
проверяет распределение известных путей по nginx location локально.

Для нового module-vhost нужен сертификат:

```sh
certbot certonly --webroot -w /var/www/acme --cert-name ava-product-modules \
  -d crm.meludtech.tech -d knowledge.meludtech.tech --non-interactive
```

DNS должен указывать на этот сервер, HTTP challenge root должен уже
обслуживаться. После recovery backup конфигурация устанавливается в
`/etc/nginx/sites-available/ava-modules`, включается ссылкой в `sites-enabled`,
проверяется `nginx -t`, затем `systemctl reload nginx`.

Canonical URLs сохраняются в существующих защищённых `.env`:

- `/opt/onyx-v4.7.0/deployment/docker_compose/.env`:
  `WEB_DOMAIN=https://knowledge.meludtech.tech`.
- `/opt/ava-deploy/twenty/.env`:
  `TWENTY_PUBLIC_URL=https://crm.meludtech.tech`.

Применять теми же compose files, что использует installation; не запускать
параллельный project и не заменять секреты. Для смены URL нужны только Onyx
api/background/web и Twenty server/worker. После пересоздания Onyx web/api
нужно проверить и reload внутреннего `onyx-nginx-1`, чтобы обновить upstream.

Новые домены не заменяют учётные записи и не включают SSO. Запасной HTTPS 8443
обслуживает тот же защищённый интерфейс; canonical application URLs остаются
без порта. Успешная загрузка HTML не доказывает успешный вход или guest flow.

## Существующие tenant bindings

Не применять обычный `configure` ради переименования того же backend: смена
соединения намеренно сбрасывает agent/readiness mappings. Узкая миграция
`scripts/migrate-ava-module-domains.py` меняет только известные IP aliases
выбранного бизнеса. Она не подходит для переноса на иной backend.

Перед `--apply`: online SQLite backup, сравнение authenticated Onyx user/cc-pair
и одной известной tenant-scoped Twenty записи через оба адреса. Скрипт требует
ожидаемые `business-id`, `cc-pair-id`, `workspace-id`; без `--apply` выполняется
preview с rollback. Он сохраняет credentials, режимы и все связи.

Точный журнал переключения и recovery hashes:
`docs/PRODUCTION_ACCEPTANCE_2026-09-07_SINGLE_HOST_RU.md`.
Rollback конфигурации выполняется выборочным восстановлением прежних `.env`
и nginx vhost из encrypted backup с повторной проверкой/recreate тех же сервисов.
Не восстанавливать всю production SQLite ради URL: новые aliases того же backend
можно оставить работающими. Полный DB restore нужен только при повреждении данных
и требует отдельного согласованного окна.

## CRM: отдельные адреса пространств (8 сентября 2026)

В production включён штатный multi-workspace Twenty:

- общий вход: `https://app.crm.meludtech.tech`;
- существующее пространство AVA Hotels (business 1 / «Аллея Resort»):
  `https://ava-hotels.crm.meludtech.tech`;
- `https://crm.meludtech.tech` перенаправляет браузерные маршруты на общий вход
  с HTTP 307. Пути `/rest`, `/metadata`, `/graphql`, `/admin-panel`, `/healthz`
  сохраняют прежний API upstream для совместимости.

Авторитетные DNS `ns1.reg.ru` и `ns2.reg.ru` публикуют
`A *.crm.meludtech.tech -> 203.0.113.10`. HTTP-конфигурация
`ava-crm-workspaces-http.conf` обслуживает wildcard и HTTP-01 challenge.
HTTPS-конфигурация `ava-crm-workspaces-https.conf` содержит только два явно
разрешённых имени выше: неизвестный отель не перенаправляется в business 1.
Wildcard DNS **не означает** wildcard-сертификат или готовность нового tenant.

Сертификат `ava-crm-workspaces` выпущен через существующий webroot:

```sh
certbot certonly --webroot -w /var/www/acme --cert-name ava-crm-workspaces \
  -d app.crm.meludtech.tech -d ava-hotels.crm.meludtech.tech --non-interactive
```

Сертификат действителен до 7 декабря 2026; `snap.certbot.renew.timer` включён.
Для нового пространства provisioning ещё должен подготовить сертификат и
точный HTTPS vhost, проверить их и только затем публиковать готовую ссылку.
Нельзя просто добавить wildcard HTTPS upstream без проверки tenant routing.

Смена существующей ссылки выполнена
`scripts/migrate-twenty-workspace-url.cjs`: проверены workspace и одна и та же
контрольная задача через оба URL; транзакция меняет только URL/timestamp и
отказывает при конкурентной смене ключа. Настоящий вход владельца через HTTPS
проверяет `scripts/verify-twenty-public-login.mjs` (запускается на Mac, не сбрасывает
пароль). Это проверка существующего пространства, не приёмка автосоздания новых.
