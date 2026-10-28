# Ava 2

AVA — CRM и голосовой ассистент для работы с обращениями, диалогами, знаниями о товарах и обзвоном.

Публичный снимок актуального исходного кода от **28 октября 2026**. В репозитории одна ветка — `main`. Старый приватный репозиторий, его ветки и PR сохранены без изменений.

## Версия на сервере

Исходная рабочая версия: `0a279446f2e9bc86582dd5cb024da2b7ef7a4bb9`, последняя ветка изменений от 26 октября. Проверка работающих контейнеров выполнена 28 октября. Компоненты production выпускались отдельно; точные серверные версии, отличия и SHA-256 находятся в [снимке production](deploy/production-snapshot-20261028/README.md).

```bash
python3 deploy/production-snapshot-20261028/source_snapshot.py verify
```

Эта команда проверяет 633 файла CRM, worker, голосового движка и admin backend. В снимке есть инструмент получения исходников каждого фактически работающего сервиса. Проверка хешей подтверждает целостность исходников, а не готовность интеграций или успешность звонков.

## Состав

| Каталог | Назначение |
|---|---|
| `whatsapp_crm/` | CRM API, каналы, клиентская память, автоматизация |
| `whatsapp_crm/frontend/` | Рабочее место менеджера на React/TypeScript |
| `src/` | Голосовые провайдеры, телефония и outbound engine |
| `admin_ui/` | Администрирование и backend управления |
| `native_modules/` | Интеграции Onyx и Twenty с зафиксированными upstream |
| `config/`, `deploy/` | Примеры конфигурации, контейнеры и инфраструктура |
| `tests/`, `whatsapp_crm/tests/` | Тесты на синтетических данных |

## Локальная разработка

Используйте Python 3.11 и Node.js 22. Зависимости зафиксированы в `requirements*.txt` и `package-lock.json` соответствующих компонентов.

```bash
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
npm --prefix whatsapp_crm ci
npm --prefix whatsapp_crm/frontend ci
npm --prefix whatsapp_crm/frontend run dev
```

Конфигурация начинается с `.env.example`, `whatsapp_crm/.env.example` и `config/ai-agent.example.yaml`. Для живых каналов нужны собственные учётные данные и настройка соответствующего провайдера. Репозиторий не содержит готового доступа к работающему серверу.

## Проверки

```bash
node whatsapp_crm/tests/run-tests.js crm-memory voice-recovery-customer-memory sales-brain customer-context-regression
node --test whatsapp_crm/tests/telephony-product.test.js
npm --prefix whatsapp_crm/frontend test -- src/pages/OutboundCampaigns.test.tsx
npm --prefix whatsapp_crm/frontend run build
```

Полные наборы унаследовали известные ошибки и несовместимости зависимостей. Публикация снимка не означает, что общий CI зелёный или что завершена большая переработка Sales Brains. Внешний API может ограничивать чтение/отправку независимо от состояния CRM.

## Публикация и лицензии

Снимок имеет новую Git-историю. Производственные `.env`, ключи, базы, записи звонков, клиентские документы/скриншоты и незакоммиченные планы исключены. Частные адреса инфраструктуры и персональные примеры заменены документационными значениями. Исторические workflows с привязкой к старому серверу не перенесены.

Лицензия проекта — [LICENSE](LICENSE); авторство и условия сторонних компонентов сохранены в их файлах. [Проверка публикации](PUBLICATION.md) описывает выполненную сверку и её границы.
