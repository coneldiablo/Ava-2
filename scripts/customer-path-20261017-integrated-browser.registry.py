"""Attach bounded actual UI/API/SQLite evidence without closing untested states."""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs/customer-path-20261017'
REGISTRY = DOCS / 'РЕЕСТР КНОПОК.csv'
RESULTS = json.loads((DOCS / 'acceptance-integrated/results.json').read_text())
CASES = [
    ('INT-REG-SAFE-STATUS', 'A04', '/register', 'anonymous', 'Регистрация: reload, неверный код, существующий аккаунт', 'Имя/бизнес/email сохранены, пароль не хранится, неверный код 400, verified existing account не создаёт второй бизнес', ['SRC-1088','SRC-1096','SRC-1097','SRC-1098','SRC-1099','SRC-1102'], 'registration-existing'),
    ('INT-ROOT-TODAY', 'A01/A03', '/ → /today', 'hotel_owner', 'Главная и рабочее место существуют одновременно', 'Оба реальных маршрута доступны; завершённый onboarding не показывается', [], 'owner-today'),
    ('INT-HOME-ASK-CACHED-OVERVIEWS', 'A01/A03', '/', 'hotel_owner', 'Вопрос AVA и reload дневных обзоров', 'Сборщик фактов → vendor fixture → штатный JSON validator → grounded answer с sources; reload не вызывает новую генерацию сохранённых обзоров', ['SRC-0518'], 'home-grounded-answer'),
    ('INT-SETUP-MANUAL', 'A06', '/assistant-builder', 'hotel_owner', 'Сохранить ссылки → написать → утвердить инструкции', 'Профиль и ссылки сохраняются через API; после утверждения systemPrompt обновлён в SQLite; ручной путь не вызывает AI', ['SRC-0302','SRC-0304','SRC-0306'], 'manual-approved'),
    ('INT-CATALOG-IMPORT', 'A07', '/autopilot?tab=catalog', 'hotel_owner', 'CSV → mapping → проверить → опубликовать → reload', 'Две колонки и SKU, цена 2500.50 сохраняется как 250050; committed импорт читается после reload', ['SRC-0028','SRC-0032','SRC-0034'], 'catalog-persisted'),
    ('INT-WA-DELAY', 'A19', '/channels?channel=whatsapp', 'hotel_owner', 'Пауза 17 секунд → сохранить → reload', 'Реальные GET/PUT и SQLite revision; UI читает сохранённое значение', ['SRC-0167'], 'whatsapp-delay-persisted'),
    ('INT-CALL-CONTEXT', 'A09/A10', '/calls', 'hotel_owner', 'Открыть итог и расшифровку, перейти к клиенту', 'Реальный Calls API обращается к локальному admin HTTP fixture; результат и полная расшифровка, follow-up ссылка ведёт в canonical chat', ['SRC-0019'], 'call-summary-transcript'),
    ('INT-CAMPAIGN-DRAFT-UNKNOWN', 'A11/A12/A13', '/outbound', 'hotel_owner', 'Частичный CSV → черновик → подтверждённый старт → неизвестный ACK → сверка', 'Первый admin ACK потерян: unknown сохраняется после reload, read-only status доказывает running без второго start; второй viewport обычный ACK', ['SRC-0766','SRC-0774','SRC-0777','SRC-0779'], 'campaign-runtime-readback'),
    ('INT-STUDIO-INVOICE-PDF', 'A22/A23', '/studio', 'hotel_owner', 'Счёт → PDF → отправить → reload', 'Реквизиты подтверждены; реальные immutable invoice versions 1/2, %PDF header, fixture ACK через Workspace/ledger, после reload sent блокирует повторную отправку', ['SRC-0039','SRC-0040','SRC-0052'], 'invoice-accepted'),
    ('INT-BUSINESS-SWITCH', 'A01/A25', '/today', 'hotel_owner with businesses 1/2', 'Сменить бизнес и исключить чужой доступ', 'client query очищен, другая карточка не открыта; запрос workspace чужого business 3 → 403', [], 'business-switched'),
    ('INT-ROLE-WORKSPACE-LEAD', 'A01/A25', '/today', 'sales_lead', 'Руководитель читает общий контекст', 'Telegram по подтверждённому alias и call summary в одной карточке; запись owner WhatsApp settings → 403', [], 'role-lead'),
    ('INT-ROLE-WORKSPACE-MANAGER', 'A01/A25', '/today', 'assigned manager', 'Менеджер читает контекст и завершает свою задачу', 'Telegram+call summary общей карточки; task done сохранён в SQLite с тем же assignee; settings → 403', ['SRC-1049'], 'role-manager'),
    ('INT-ROLE-WORKSPACE-OBSERVER', 'A01/A25', '/today', 'observer', 'Наблюдатель читает без действий отправки/задач', 'Telegram+call summary видны; нет take-control и complete-task кнопок; settings → 403', [], 'role-observer'),
]

with REGISTRY.open(encoding='utf-8-sig', newline='') as f:
    reader = csv.DictReader(f)
    fields = reader.fieldnames
    rows = list(reader)
rows = [row for row in rows if not row['action_id'].startswith('INT-')]
for action_id, task_id, route, role, label, effect, source_ids, screenshot in CASES:
    matching = [item for item in RESULTS['results'] if item['id'] == action_id]
    assert len(matching) == 2 and all(item['status'] == 'PASS' for item in matching), action_id
    evidence = f'acceptance-integrated/results.json#{action_id}; acceptance-integrated/{screenshot}-{{1440,390}}.png; scripts/customer-path-20261017-integrated-browser.mjs'
    row = {field: 'NOT_TESTED' for field in fields}
    row.update(action_id=action_id, task_id=task_id, route_screen=route, role=role,
               visibility_condition='Only seeded role/business and the exact two viewport cases in results.json',
               control_label=label, selector='Accessible labels/roles in named integrated test',
               purpose=effect, preconditions='Built React + actual Express + test SQLite/cookie sessions; external boundaries are fixtures',
               expected_navigation_or_change=effect, api_runtime_effect=effect,
               validation='PASS only explicit assertions in linked test; other validations NOT_TESTED',
               success='PASS scoped result and readback', refresh_readback='PASS where explicit reload/SQLite assertion is in test',
               mobile='PASS viewport 390; desktop 1440; no horizontal overflow in captured state',
               keyboard='NOT_TESTED exhaustive; Playwright accessible role/label interaction only',
               owner='Independent integrated acceptance agent 08', local_status='PASS scoped scenario',
               integrated_status='PASS scoped local integration; external fixtures',
               live_provider_status='NOT_TESTED', customer_acceptance_status='NOT_TESTED',
               evidence=evidence,
               notes=f'{effect}. Source seeds: {", ".join(source_ids) or "composed route/role scenario"}. No claim about every role/state, real provider delivery, production or user acceptance.')
    rows.append(row)
    for source in rows:
        if source['action_id'] in source_ids:
            source['integrated_status'] = 'PARTIAL scoped action; remaining roles/states NOT_TESTED'
            annotation = f' Actual integration subset: {action_id} (1440/390; {role}); evidence acceptance-integrated/results.json. See exact INT row, not blanket PASS.'
            if annotation not in source['notes']:
                source['notes'] += annotation

assert len([row for row in rows if row['action_id'].startswith('SRC-')]) == 1120
assert len([row for row in rows if row['action_id'].startswith('SEM-')]) == 37
with REGISTRY.open('w', encoding='utf-8-sig', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=fields, quoting=csv.QUOTE_ALL)
    writer.writeheader()
    writer.writerows(rows)
print(json.dumps({'rows': len(rows), 'source_seeds': 1120, 'prior_semantic_groups': 37, 'integrated_groups': len(CASES), 'source_subset_annotations': sum(row['integrated_status'].startswith('PARTIAL') for row in rows)}))
