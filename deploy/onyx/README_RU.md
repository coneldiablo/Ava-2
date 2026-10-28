# Onyx для AVA

AVA использует официальный Onyx `v4.7.0`, commit
`a1b9e02eb65cc114c65381cbef5e555e1753ed0a`. Старый самодельный compose на
`v0.5.15` удалён: он не соответствовал текущему API и содержал небезопасные
пароли по умолчанию.

## Развёртывание на отдельной VDS

Рекомендуется отдельная VDS с 32 GB RAM, 8 vCPU и не менее 100 GB SSD. На
телефонный сервер AVA Onyx не ставится.

1. Выполнить `sudo ./deploy/onyx/install-official.sh /opt/onyx-v4.7.0`.
2. Заполнить `/opt/onyx-v4.7.0/deployment/docker_compose/.env` и `.env.nginx`.
3. Положить TLS-сертификат и ключ в `deployment/data/sslcerts` согласно
   `.env.nginx`.
4. Выполнить `sudo ./deploy/onyx/preflight.sh /opt/onyx-v4.7.0`.
5. Снять backup, затем запустить из каталога `deployment/docker_compose`:
   `docker compose -f docker-compose.prod-no-letsencrypt.yml up -d --wait`.

## Изоляция отелей

Для каждого `business_id` в Onyx создаются отдельная connector/credential pair,
группа доступа и API-ключ с доступом только к этой паре. В AVA хранится только
имя переменной окружения с ключом, например `ONYX_HOTEL_17_API_KEY`; сам ключ не
попадает в SQLite или API.

Администратор AVA настраивает связь через `PUT /api/onyx/tenants/{business_id}`:

```json
{
  "base_url": "https://onyx.example.com/api",
  "credential_ref": "ONYX_HOTEL_17_API_KEY",
  "cc_pair_id": 42,
  "onyx_version": "v4.7.0"
}
```

После `POST /api/onyx/tenants/{business_id}/test` связь переходит в `STAGING`.
Загрузка базы знаний использует официальный endpoint
`/api/onyx-api/ingestion`, стабильный document ID
`ava:{business_id}:knowledge:{source_id}` и выделенный `cc_pair_id`.

Live-cutover запрещён, пока не пройдены health check, синхронизация, теневой
прогон, backup/restore, мониторинг, проверка grounding и rollback. Откат меняет
только маршрутизацию на локальную AVA; телефония, WhatsApp и CRM продолжают
работать независимо.
