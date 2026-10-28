# AVA Admin UI: полная карта фронтенда

Этот файл описывает именно фронтенд-часть `admin_ui/frontend`: какие страницы есть в интерфейсе, что на них отображается, какие кнопки и действия доступны, куда они ведут, какие модалки открываются и какой пользовательский сценарий покрывает каждая зона UI.

Ограничения этого описания:

- Описывается UI и его поведение по коду фронтенда.
- Ядро (`src/`) и логика Asterisk здесь не меняются и не документируются как backend-реализация.
- Если страница отправляет запрос в API, ниже это указано как фронтенд-действие, а не как описание внутренней backend-логики.

## 1. Что входит во фронтенд

Основное SPA-приложение находится в:

- `admin_ui/frontend/src/App.tsx`
- `admin_ui/frontend/src/components/layout/*`
- `admin_ui/frontend/src/pages/*`
- `admin_ui/frontend/src/components/config/*`
- `admin_ui/frontend/src/components/ui/*`
- `admin_ui/frontend/src/auth/*`

Фронтенд построен вокруг:

- `React`
- `React Router`
- `axios`
- `Tailwind`
- набора внутренних UI-компонентов и конфигурационных форм

## 2. Общая архитектура интерфейса

### 2.1. Защита приложения и стартовый поток

Приложение работает так:

1. Пользователь попадает на `/login`, если не авторизован.
2. После логина `RequireAuth` проверяет токен и пользователя.
3. Если backend сообщает, что пароль нужно сменить, принудительно открывается `ChangePasswordModal`.
4. После авторизации `SetupGuard` вызывает `/api/wizard/status`.
5. Если система ещё не сконфигурирована, пользователь автоматически уводится на `/wizard`.
6. После этого открывается основное приложение внутри `AppShell`.

### 2.2. Общий layout

`AppShell` состоит из:

- левого сайдбара
- верхнего header с breadcrumbs
- основной области контента

### 2.3. Сайдбар

Сайдбар всегда слева и содержит основные группы навигации:

- `Overview`
  - `Dashboard` → `/`
  - `Call History` → `/history`
  - `Call Scheduling` → `/scheduling`
  - `Setup Wizard` → `/wizard`
- `Core Configuration`
  - `Providers` → `/providers`
  - `Pipelines` → `/pipelines`
  - `Contexts` → `/contexts`
  - `Audio Profiles` → `/profiles`
  - `Tools` → `/tools`
  - `MCP` → `/mcp`
- `Advanced Settings`
  - `Voice Activity Detection` → `/vad`
  - `Streaming` → `/streaming`
  - `LLM Defaults` → `/llm`
  - `Audio Transport` → `/transport`
  - `Barge-in` → `/barge-in`
- `System`
  - `Environment` → `/env`
  - `Docker Services` → `/docker`
  - `Asterisk` → `/asterisk`
  - `Models` → `/models`
  - `Updates` → `/updates`
  - `Logs` → `/logs`
  - `Terminal` → `/terminal`
- `Danger Zone`
  - `Raw YAML` → `/yaml`
- `Support`
  - `Help` → `/help`
  - `API Docs` → `/docs` в новой вкладке

Внизу сайдбара есть блок текущего пользователя:

- кнопка `Password` открывает модалку смены пароля
- кнопка `Logout` делает выход

### 2.4. Header

Header сверху показывает breadcrumb-путь по текущему URL:

- `Admin / Providers`
- `Admin / System / Logs`
- и т.д.

Глобальных кнопок сохранения в header нет, каждая страница управляет своими действиями сама.

### 2.5. Общие глобальные UI-механики

Во всём приложении используются:

- `sonner`-toast уведомления
- `ConfirmDialogProvider` для подтверждений удаления, рестартов и опасных действий
- `Modal` для форм редактирования
- `YamlErrorBanner` для блокировки UI, если сломан YAML
- `usePendingChanges` для страниц, где после сохранения нужен hot reload или restart

## 3. Все маршруты фронтенда

Основные маршруты:

- `/login`
- `/wizard`
- `/`
- `/history`
- `/scheduling`
- `/providers`
- `/pipelines`
- `/contexts`
- `/profiles`
- `/tools`
- `/mcp`
- `/vad`
- `/streaming`
- `/llm`
- `/transport`
- `/barge-in`
- `/yaml`
- `/env`
- `/docker`
- `/asterisk`
- `/logs`
- `/terminal`
- `/models`
- `/updates`
- `/help`

Дополнительно во фронтенде есть страницы-компоненты, которые сейчас не подключены роутером напрямую:

- `ConfigEditor.tsx`
- `Logs.tsx`

Это скорее legacy/internal страницы, а не основная навигация текущего UI.

## 4. Страницы приложения

## 4.1. `/login` — Login Page

Назначение:

- вход в админку

Что есть на странице:

- логотип/маскот AVA
- заголовок `Asterisk AI Voice Agent`
- подпись `Sign in to manage your AI Voice Agent`
- поле `Username`
- поле `Password`
- кнопка `Sign in`

Поведение:

- при ошибке показывается красный alert `Invalid username or password`
- после успешного логина происходит редирект туда, куда пользователь пытался попасть до логина, иначе на `/`

## 4.2. `/wizard` — Setup Wizard

Назначение:

- первичная пошаговая настройка системы

Структура:

- верхний индикатор шагов
- шаги `Welcome` → `Provider` → `API Keys` → `Agent Configuration` → `Done`
- на первом шаге есть `Skip Setup`
- внизу есть `Back` и `Next` / `Finish Setup`

### Шаг 1. Welcome

Показывает:

- приветствие
- краткий список того, что понадобится для настройки

Кнопки:

- `Skip Setup`
- `Next`

### Шаг 2. Select Your AI Provider

Показывает карточки выбора провайдера:

- `OpenAI Realtime`
- `Local Hybrid`
- `Deepgram`
- `Google Live`
- `ElevenLabs Agent`
- `Local`

Нажатие по карточке:

- выбирает provider
- визуально подсвечивает активную карточку

### Шаг 3. Configure API Keys

Содержимое зависит от выбранного провайдера.

Варианты:

- `OpenAI Realtime`
  - поле `OpenAI API Key`
  - кнопка проверки ключа
- `Deepgram`
  - поле `Deepgram API Key`
  - поле `OpenAI API Key (for Think stage)`
  - тестовые кнопки
- `Google Live`
  - поле `Google API Key`
  - подсказка про Vertex AI / Google Cloud
- `ElevenLabs Agent`
  - поле `Agent ID`
  - ссылка на ElevenLabs dashboard
  - поле `ElevenLabs API Key`
  - тестовая кнопка
- `Local Hybrid`
  - большой блок настройки локальных STT/TTS
  - выбор языка
  - выбор backend и модели STT
  - выбор backend и модели TTS
  - режимы и голос Kokoro
  - поле `Kroko API Key` при нужном backend
  - выбор облачного LLM-провайдера (`Groq`, `OpenAI`, `Ollama`)
  - поле соответствующего API key
  - кнопки загрузки required моделей
- `Local`
  - экран подготовки Local AI Server
  - выбор языка
  - выбор STT / TTS / LLM моделей
  - Kokoro mode / voice
  - возможность скачать модели
  - прогресс скачивания
  - лог скачивания

Ключевые действия на шаге 3:

- `Test Key`
- `Download`
- `Download Selected Models`
- переход дальше разрешается только если обязательные ключи и модели есть

### Шаг 4. Agent Configuration

Секции:

- параметры Asterisk
  - `Asterisk Host`
  - `ARI Username`
  - `ARI Password`
  - `ARI Port`
  - `ARI Scheme`
  - `Stasis App Name`
  - для remote Asterisk дополнительно `Asterisk Server IP Address`
- кнопка `Test Connection`
- для `local_hybrid` отдельная кнопка проверки Local AI Server
- дефолтный контекст
  - `AI Name`
  - `AI Role`
  - `Greeting Message`

### Шаг 5. Done / запуск сервисов

Зависит от выбранного provider.

Для `local`:

- показывает состояние Local AI Server
- список скачанных моделей
- кнопка `Start Local AI Server`
- лог запуска локального сервера
- после готовности Local AI Server появляется блок `Start AI Engine`
- кнопка `Start AI Engine`
- после запуска двигателя появляется кнопка `Apply Changes`
- показывается dialplan snippet для Asterisk

Для облачных/не-local провайдеров:

- показывается статус `AI Engine`
- если не запущен, есть кнопка `Start AI Engine`
- если уже запущен, есть кнопка `Apply & Restart Engine`
- ниже показывается следующий шаг: обновить dialplan в Asterisk

Дополнительные действия wizard:

- копирование dialplan snippets
- автозагрузка старой конфигурации из backend
- инициализация `.env`
- проверка состояния движка, локального сервера, прогресса загрузки моделей

## 4.3. `/` — Dashboard

Назначение:

- обзор системы в одном экране

Верх страницы:

- заголовок `Dashboard`
- справа кнопка refresh

Аварийный блок:

- показывается, если не удалось загрузить контейнеры или метрики
- содержит кнопку `Retry`
- раскрываемый блок `Troubleshooting steps`

Основной контент:

- строка статуса платформы
  - `System Ready` / `Action Required`
  - passed checks
  - `OS`
  - `AAVA`
  - `Docker`
  - `Compose`
- строка ресурсов
  - `CPU`
  - `Memory`
  - `Disk`
  - `Asterisk`
  - `Audio Dirs`

Отдельные интерактивные элементы:

- блок `Asterisk` кликабелен и ведёт на `/asterisk`
- если ARI disconnected, справа маленькая кнопка-ключ запускает перезапуск AI Engine для переподключения
- если `Audio Dirs` не healthy, маленькая кнопка-ключ запускает автофикс директорий

Ниже:

- компонент `SystemTopology`

### Dashboard / SystemTopology

Показывает живую схему системы:

- состояние AI Engine
- соединение с Asterisk / ARI
- количество активных Asterisk каналов
- состояние Local AI Server
- активные локальные модели
- сконфигурированные full-agent providers
- сконфигурированные pipelines
- default provider
- active pipeline
- активные звонки

Это визуальная карта потока:

- Asterisk
- AI Engine
- Providers / Pipelines / Local AI
- текущее состояние звонков

## 4.4. `/history` — Call History

Назначение:

- история звонков и их разбор

Верхняя панель справа:

- кнопка переключения статистики
- refresh
- фильтры
- export `CSV`
- export `JSON`

Если выбран звонок:

- сверху появляется кнопка `Troubleshoot`
- она ведёт на `/logs` с query-параметрами этого звонка

Блок `Call Statistics`:

- `Total Calls`
- `Success / Failed`
- `Active Calls`
- `Avg Duration`
- `Top Provider`
- `Top Tool`

Панель фильтров:

- `Caller Number`
- `Caller Name`
- `Provider`
- `Pipeline`
- `Context`
- `Outcome`
- `From Date`
- `To Date`
- кнопка `Clear all`

Таблица звонков:

- caller
- time
- duration
- provider / pipeline
- context
- outcome
- turns
- latency
- barge-ins
- actions

Поведение:

- строка звонка кликабельна и открывает модалку деталей
- в actions есть delete
- пагинация `Prev/Next`

### Модалка Call Details

Верх:

- `Troubleshoot`
- delete
- close

Блок записи разговора:

- проверка наличия записи
- play/pause
- progress bar с перемоткой
- имя файла
- размер файла
- индикация `No recording` или `Recording exists but contains no audio`

Содержимое модалки:

- overview
  - caller
  - duration
  - outcome
  - turns
  - avg latency
  - barge-ins
- tool executions summary
- configuration
  - provider
  - pipeline
  - context
  - audio format
- transcript / conversation history
- подробности tool calls
- блок ошибки, если звонок завершился с ошибкой

Есть deep-link:

- `/history?id=<call_record_id>` сразу открывает нужный звонок

## 4.5. `/scheduling` — Call Scheduling

Назначение:

- outbound campaigns / lead list / voicemail drop / consent gate

Верх страницы:

- заголовок `Call Scheduling`
- справа `Refresh`
- справа `New Campaign`
- отображение серверного времени и времени кампании

Основные зоны:

- блок результатов CSV import с accepted / duplicates / rejected / warnings
- левая колонка `Campaigns`
- правая колонка деталей выбранной кампании

### Левая колонка Campaigns

Содержит:

- чекбокс `Show archived`
- список кампаний карточками

На карточке кампании:

- имя
- статус
- timezone
- daily window

### Правая колонка Details

Если кампания выбрана, показываются:

- имя
- статус
- default context
- max concurrent
- min interval
- timezone
- окно времени
- текущее локальное время кампании
- внутри окна / вне окна

Кнопки вверху карточки кампании:

- `Edit`
- `Clone`
- `Archive`
- `Delete`
- `Start`
- если уже running:
  - `Pause`
  - `Stop`

Есть статусы и предупреждения:

- нет pending leads
- нет voicemail recording
- нет consent recording

Ниже по странице есть:

- статистика кампании
- таблица лидов
- фильтры лидов
- поиск по лидам
- пагинация лидов

Действия по лидам:

- открыть call history конкретного лида
- recycle
- ignore
- delete

### Модалка создания/редактирования кампании

Имеет внутренние шаги:

- `settings`
- `leads`
- `recordings`
- `setup`
- `advanced`

В модалке доступны:

- основные поля кампании
  - name
  - timezone
  - daily window
  - max concurrent
  - min interval
  - default context
- voicemail настройки
- consent настройки
- AMD options
- импорт лидов CSV
- скачивание sample CSV
- загрузка и выбор voicemail / consent recordings
- preview записей
- dialplan snippet
- copy snippet

Дополнительные действия:

- upload recording в библиотеку
- import leads
- download error CSV
- preview recording by media URI
- open call history модалка по связанному звонку

## 4.6. `/providers` — Providers

Назначение:

- управление AI-провайдерами

Верх:

- баннер о том, что изменения требуют restart AI Engine
- кнопка `Restart AI Engine`
- заголовок и описание страницы
- `Add Provider Templates`
- `Add Provider`

Основное содержимое разбито минимум на:

- `Full Agents`
- modular providers по capability (`stt`, `llm`, `tts`) в карточках

На карточке провайдера отображаются:

- имя
- статус `Default`
- статус `Disabled`
- тип/модель/голос/живые данные для local provider

Hover actions:

- `Set as Default`
- `Test Connection`
- `Edit`
- `Delete`
- enable/disable

Логика страницы:

- нельзя удалить default provider
- нельзя отключить provider, если он используется активным pipeline
- при удалении учитываются зависимости из pipelines и contexts
- при сохранении modular provider автоматически нормализуется suffix `_stt`, `_llm`, `_tts`

### Модалка Add Provider Templates

Позволяет массово добавить шаблоны:

- `openai_realtime`
- `deepgram`
- `google_live`
- `elevenlabs_agent`
- `local_modular`
- `telnyx_llm`
- `azure_stt`
- `azure_tts`

### Модалка Add/Edit Provider

Показывает одну из provider-specific форм:

- `LocalProviderForm`
- `OllamaProviderForm`
- `OpenAIRealtimeProviderForm`
- `DeepgramProviderForm`
- `GoogleLiveProviderForm`
- `OpenAIProviderForm`
- `ElevenLabsProviderForm`
- `TelnyxProviderForm`
- `AzureProviderForm`
- `GenericProviderForm`

Примеры полей, которые умеет UI:

- endpoint/base URL / ws URL
- API key / project / org
- model / voice
- encoding / sample rate
- timeout
- greeting
- instructions
- VAD / turn detection
- enabled
- capabilities

То есть фронтенд умеет не только включать/выключать провайдера, но и редактировать его transport/audio/model-параметры.

## 4.7. `/pipelines` — Pipelines

Назначение:

- сборка modular пайплайнов из STT + LLM + TTS

Верх:

- баннер о необходимости restart
- кнопка `Reload AI Engine`
- `Add Pipeline`

Блок `Active Pipeline`:

- select со списком пайплайнов
- кнопка `Set Active`

Блок `Active Pipelines`:

- список карточек пайплайнов
- каждая карточка показывает цепочку:
  - `STT`
  - `LLM`
  - `TTS`
- для каждого узла показывается provider и model label
- активный pipeline помечается badge `Active`

Hover actions на карточке:

- edit
- delete

### Модалка PipelineForm

Секции:

- `Pipeline Identity`
  - `Pipeline Name`
- `Components`
  - выбор `Speech-to-Text`
  - выбор `Large Language Model`
  - выбор `Text-to-Speech`

Expert toggles:

- `Streaming STT`
- `LLM Expert Settings`
- `LLM Tools Enabled`
- `STT Expert Settings`
- `TTS Expert Settings`

Дополнительные поля:

- `chunk_ms`
- `stream_format`
- `OpenAI Realtime Model`
- `LLM Min Words Threshold`
- `LLM Min Chars Threshold`
- hangup guardrail settings
- STT timestamp granularities
- Azure STT overrides
- OpenAI / Groq / Azure TTS overrides

Форма валидирует:

- наличие выбранных STT/LLM/TTS providers
- соответствие capabilities
- запрет использования full-agent provider в modular slots
- запрет disabled providers

## 4.8. `/contexts` — Contexts

Назначение:

- AI-персоны, greeting, system prompt, выбор tools по фазам

Верх:

- баннер pending apply / restart
- кнопка `Apply Changes` или `Restart AI Engine`
- `Add Context`

Список карточек контекстов показывает:

- имя контекста
- profile
- pipeline override
- provider override
- greeting
- enabled tools с phase badge:
  - `pre`
  - `in`
  - `post`

Hover actions:

- edit
- delete

### Модалка ContextForm

Поля:

- `Context Name`
- `Greeting`
- `System Prompt`
- `Audio Profile`
- `Provider/Pipeline Override`

Большой блок `Tools by Phase`:

- `Pre-Call Tools`
- `In-Call Tools`
- `Post-Call Tools`

Особенности:

- global tools помечаются замком
- по фазам можно включать/выключать контекстные инструменты
- если global tool есть, для него можно сделать disable только в данном контексте
- у tools показываются help-tooltip с описанием

Дополнительно:

- настройка `Music On Hold`
- поле `MOH Class Name`
- подсказки по тому, как заводить MOH в Asterisk / FreePBX

## 4.9. `/profiles` — Audio Profiles

Назначение:

- конфигурации аудио-профилей

Верх:

- баннер pending apply
- `Apply Changes` / restart
- `Add Profile`

Карточка профиля показывает:

- имя
- badge `Default`
- описание профиля
- `Internal Rate`
- `Chunk`
- `Provider In`
- `Transport Out`
- список contexts, которые используют профиль

Hover actions:

- edit
- delete

### Модалка профиля

Поля:

- для нового профиля дополнительно `Profile Name`

Секции:

- `Core Settings`
  - `Chunk Duration`
  - `Idle Cutoff`
  - `Internal Sample Rate`
- `Provider Preferences`
  - input encoding
  - input sample rate
  - output encoding
  - output sample rate
- `Transport Output`
  - encoding
  - sample rate

Логика:

- нельзя удалить последний профиль
- если удаляется default profile, UI выбирает fallback default
- если профиль назначен contexts, эти contexts переводятся на default fallback

## 4.10. `/tools` — Tools & Capabilities

Назначение:

- вся настройка встроенных и HTTP-инструментов агента

Верх:

- баннер о необходимости restart
- `Restart AI Engine`
- `Save Changes`

Есть табы:

- `Pre-Call`
- `In-Call`
- `Post-Call`
- `Catalog`

### Pre-Call

Содержит:

- `HTTPToolForm` для lookup/enrichment tools до ответа агента

### In-Call

Содержит два блока:

- `Built-in Tools`
- `In-Call HTTP Tools`

`Built-in Tools` через `ToolForm` настраивает:

- transfer
- attended_transfer
- cancel_transfer
- live_agent_transfer
- hangup_call
- leave_voicemail
- send_email_summary
- request_transcript
- google_calendar
- extension/live-agent routing
- hangup policy / guardrails
- email templates и preview

`In-Call HTTP Tools`:

- HTTP lookup tools, которые AI вызывает прямо во время разговора

### Post-Call

Содержит:

- webhook / CRM / post-call HTTP tools

### Catalog

Read-only каталог всех зарегистрированных tools.

Что есть:

- search
- refresh
- таблица со столбцами:
  - tool
  - phase
  - source
  - description
  - params
- раскрытие строки с параметрами tool schema

### Модалки и формы tool-страницы

`HTTPToolForm` умеет:

- создать/edit/delete HTTP tool
- `Tool Name`
- `Enabled`
- `Global (all contexts)`
- `URL`
- `Method`
- `Timeout`
- `Headers`
- `Query Params`
- `Body Template / Payload Template`
- `Output Variables`
- `Hold Audio File`
- `Hold Audio Threshold`
- для in-call:
  - `Description`
  - `Parameters`
  - `Return Raw JSON to AI`
  - `Error Message`
- тестовую панель:
  - тестовые значения подстановок
  - запуск теста
  - resolved URL
  - response
  - suggested mappings
- для post-call:
  - `Generate AI Summary`
  - `Max Summary Words`

`ToolForm` умеет:

- редактировать built-in policy fields
- управлять live-agent destinations
- настраивать attended transfer prompts
- настраивать hangup markers и farewell markers
- открывать `EmailTemplateModal` для email summary / transcript

## 4.11. `/mcp` — MCP Servers

Назначение:

- управление MCP-backed tool servers

Верх:

- `Refresh Status`
- `Save & Reload`

Отдельный warning banner:

- reload применяется только когда нет активных звонков
- `Test` выполняется в контексте AI Engine container

Блок `Global MCP Settings`:

- глобальный switch `Enable MCP`

Блок `Configured MCP Servers`:

- кнопка `Add Server`
- список карточек серверов

На карточке сервера:

- индикатор up/down
- id сервера
- disabled badge
- команда запуска
- discovered tools count
- registered tools count
- last error

Кнопки:

- `Test`
- `Edit`
- `Delete`

### Модалка MCP server

Поля:

- `Enabled`
- `Server ID`
- `Command Executable`
- `Command Arguments`
- `Working Directory`

Секция `Defaults`:

- `Timeout`
- `Slow Threshold`
- `Slow Message`

Секция `Restart Policy`:

- enabled
- `Max Restarts`
- `Backoff`

Секция `Environment`:

- пары key/value
- add/remove env var

Секция `Tool Overrides`:

- `Tool Name`
- `Expose As`
- `Speech Field`
- `Speech Template`
- add/remove override rows

## 4.12. `/vad` — Voice Activity Detection

Назначение:

- engine-side voice activity detection

Верх:

- баннер restart required
- `Reload AI Engine`
- `Save Changes`

Секции:

- `Primary Detection`
  - `Enhanced VAD`
  - `Use Provider VAD`
  - `Energy Threshold`
  - `Confidence Threshold`
  - `Adaptive Threshold`
  - `Noise Adaptation Rate`
- `Engine VAD (WebRTC)`
  - fallback
  - interval
  - aggressiveness
  - frame thresholds
- `Utterance Controls`
  - optional expert settings
- `Upstream Squelch`
  - squelch enable
  - thresholds / EMA / min speech / end silence

Есть локально сохраняемый toggle показа expert-полей utterance settings.

## 4.13. `/streaming` — Streaming Settings

Назначение:

- real-time audio streaming и playback tuning

Верх:

- баннер restart required
- `Reload AI Engine`
- `Save Changes`

Секции:

- `Playback Mode`
  - `Downstream Mode` (`stream` / `file`)
- `Audio Stream Parameters`
  - `Chunk Size`
  - `Sample Rate`
  - `Jitter Buffer`
  - `Connection Timeout`
  - `Keepalive Interval`
  - `Provider Grace Period`
  - `Fallback Timeout`
  - `Low Watermark`
  - `Min Start`
  - `Greeting Min Start`
  - `Greeting RTP Wait`
  - `Empty Backoff Ticks Max`
  - `Continuous Stream`
- `Audio Normalizer`
  - enable
  - max gain
  - target RMS
- `Egress Format`
  - swap mode
  - force μ-law
- `Diagnostics`
  - audio taps
  - output directory
  - pre/post seconds

## 4.14. `/llm` — LLM Defaults

Назначение:

- глобальные дефолты для LLM и local tool policy

Верх:

- баннер restart required
- `Reload AI Engine`
- `Save Changes`

Секции:

- `Default Parameters`
  - initial greeting
  - общие fallback-поля для LLM
- `Local LLM Prompting`
  - `Chat Format`
  - `Voice Preamble`
- `Local Tool Calling`
  - `Tool Policy Override`
  - `Structured Tool Gateway`
  - инфо о capability и resolved policy

## 4.15. `/transport` — Audio Transport

Назначение:

- выбор transport-режима между AudioSocket и ExternalMedia RTP

Верх:

- баннер apply/restart
- `Apply` / `Reload AI Engine`
- `Save Changes`

Секции:

- `Asterisk Configuration`
  - `Stasis Application Name`
- `Transport Type`
  - `Transport Method`
- если выбран AudioSocket:
  - `AudioSocket Settings`
  - bind host
  - advertise host
  - port
  - format
- если выбран External Media:
  - `External Media (RTP) Settings`
  - RTP bind host
  - advertise host
  - RTP port
  - port range
  - allowed remote hosts
  - Asterisk-side codec
  - direction
  - engine-side internal format
  - sample rate
  - expert settings
  - `Lock Remote Endpoint`

## 4.16. `/barge-in` — Barge-in Settings

Назначение:

- управление тем, как caller может перебивать TTS агента

Верх:

- баннер restart required
- `Reload AI Engine`
- `Save Changes`

Секция `Barge-in Control`:

- `Enable Barge-in`
- `Energy Threshold`
- `Minimum Duration`
- `Cooldown`
- `Post-TTS Protection`
- `Provider Output Suppress`

Есть информационный блок `Tuning Tips`.

Секция `Advanced`:

- раскрываемый блок `Show advanced settings`
- protection windows
- provider-owned mode
- pipeline / local_hybrid mode
- TALK_DETECT параметры

Секция `Current Configuration`:

- текущий status
- значения ключевых параметров

## 4.17. `/yaml` — Raw Configuration

Назначение:

- прямое редактирование YAML

Верх:

- `Import`
- `Export`
- `Save Changes`

Основное содержимое:

- Monaco Editor с YAML

Дополнительное поведение:

- предупреждение о несохранённых изменениях при уходе со страницы
- `Import` принимает `.zip`
- перед import спрашивает подтверждение
- `Export` скачивает backup zip
- если YAML уже сломан, сверху показывается orange-banner с line / column / problem

## 4.18. `/env` — Environment Variables

Назначение:

- управление `.env` и связанными системными настройками

Верх:

- баннер `Apply Changes`
- список сервисов, которые нужно рестартовать
- кнопка `Apply Changes`
- кнопка `Setup Wizard`
- кнопка `Refresh`
- кнопка `Save Changes`

Есть табы:

- `AI Engine`
- `Local AI Server`
- `System`

### AI Engine tab

Секции:

- `Asterisk Settings`
  - host
  - ARI username/password
  - port
  - websocket scheme
  - SSL verify
  - stasis app name
  - media directory
  - `Test Connection`
- `Cloud Provider API Keys`
  - OpenAI
  - Groq
  - Deepgram
  - Google
  - Telnyx
  - ElevenLabs
  - ElevenLabs Agent ID
  - Resend
  - Google service account
  - Vertex AI project/location
- `Email Delivery (SMTP)`
  - SMTP host/port/username/password
  - TLS mode
  - verify TLS
  - timeout
  - `Send Test Email`
- `Health Endpoint`
  - bind host
  - bind port
  - API token
- `NAT / Hybrid Network`
  - AudioSocket advertise host
  - ExternalMedia advertise host
- `Local AI Connection`
  - websocket URL
  - connect timeout
  - response timeout
  - chunk size
- `Logging`
  - log level
  - format
  - color
  - tracebacks
  - log to file
  - log file path
- `Streaming Logging`
  - streaming log level
- `Diagnostics`
  - taps
  - pre/post
  - output dir
  - egress swap
  - force mulaw
  - attack ms

### Local AI Server tab

Секции:

- `Server Bind Settings`
  - bind host
  - bind port
  - auth token
- `Runtime & Logging`
  - runtime mode
  - log level
  - verbose audio debug
- `STT (Speech-to-Text)`
  - backend
  - idle timeout
  - backend-specific settings:
    - Vosk
    - Kroko
    - Sherpa
    - T-one
    - Faster Whisper
    - Whisper.cpp
  - whisper-family segmentation advanced
- `TTS (Text-to-Speech)`
  - backend
  - Piper path
  - Kokoro mode / voice / API / token / model path
  - MeloTTS voice / device / speed
- `LLM (Large Language Model)`
  - LLM model path
  - context size
  - batch size
  - max tokens
  - temperature
  - threads
  - infer timeout
- `Advanced LLM Settings`
  - GPU layers
  - auto GPU layer default
  - top p
  - repeat penalty
  - lock model in RAM
  - tool gateway enabled
  - stop tokens
  - chat format

### System tab

Секции:

- `Time Zone`
- `Authentication`
- `Admin UI Server`
- `Health Check URLs`
- `Call History`
- `Outbound Campaign (Alpha)`
- `Container Permissions`
- `Docker Build Settings`
  - STT backends
  - TTS backends
  - LLM & other backends
- `Other Variables`

Логика страницы:

- secret inputs умеют show/hide
- `Apply Changes` применяет рестарты в порядке:
  - `local_ai_server`
  - `ai_engine`
  - `admin_ui`
- если затрагивается `admin_ui` или `JWT_SECRET`, UI предупреждает о возможном logout

## 4.19. `/docker` — Docker Containers

Назначение:

- просмотр и перезапуск контейнеров, cleanup docker storage

Верх:

- заголовок
- `Refresh`

Если ошибка доступа к docker:

- alert с troubleshooting steps

Секция `Docker Disk Usage`:

- карточки:
  - `Build Cache`
  - `Images`
  - `Containers`
  - `Volumes`
- кнопки cleanup:
  - clean build cache
  - clean images
  - refresh disk usage

Секция `Service Status`:

- список контейнеров
- на карточке:
  - имя
  - image
  - status
  - uptime
  - ports
  - mounts
- действия:
  - restart container
  - раскрыть mounts

Если перезапускается `admin_ui`, фронтенд умеет пережить network error и перезагрузить страницу позже.

## 4.20. `/asterisk` — Asterisk Setup

Назначение:

- live-проверка интеграции с Asterisk

Верх:

- статус `Local` / `Remote`
- `Refresh`

Секции:

- `ARI Connection`
  - connected / not reachable
  - version
  - uptime
  - last reload
  - mode
  - FreePBX detection
- `Required Modules`
  - список нужных Asterisk modules
- `Application Registration`
  - stasis application
  - registered / not registered
- `Configuration Checklist`
  - результаты preflight manifest
  - для каждого check есть expandable fix hint
  - copy buttons для подсказок / шаблонов

Если preflight manifest отсутствует:

- UI прямо подсказывает запустить `./preflight.sh`

## 4.21. `/models` — Models

Назначение:

- библиотека моделей + runtime-переключение моделей Local AI Server

Страница делится на две большие части:

- статус и runtime Local AI Server
- `Model Library`

### Верхняя часть: Local AI Server

Показывает:

- connected / error / loading
- Host GPU vs Runtime GPU
- кнопки:
  - `Configure` → `/env`
  - `Restart`
  - `View Logs` → `/logs?container=local_ai_server`

Для runtime-моделей:

- STT
  - select модели
  - доп. настройки language / model type / decoder / KenLM
- LLM
  - select модели
  - tuning controls `Context`, `Max Tokens`
  - runtime stats prompt tokens / safe max / tools / policy
- TTS
  - select модели

Если Local AI Server выключен:

- показывается кнопка `Start Local AI Server`

Если есть pending changes:

- показывается `Apply Changes & Restart`
- возможен force apply incompatible selections
- возможен rebuild backend

### Нижняя часть: Model Library

Верх:

- refresh
- tabs:
  - `Installed`
  - `STT`
  - `TTS`
  - `LLM`
- для STT/TTS есть region filter

Вкладка `Installed`:

- список уже установленных моделей
- delete

Вкладки `STT`, `TTS`, `LLM`:

- карточки моделей
- badges:
  - installed
  - recommended
  - tool calls
- описание, размер, язык, backend
- кнопка `Download`
- если backend ещё не включён, кнопка `Enable Backend`

### RebuildBackendDialog

Открывается с ModelsPage и показывает:

- предупреждение, что будет rebuild контейнера
- estimated time
- что Local AI будет недоступен
- build progress bar
- live build output
- результат `success` / `failed`

## 4.22. `/updates` — Updates

Назначение:

- git/update flow внутри админки

Секция `Check Updates`:

- `Check updates`
- `Force refresh`
- показывает local branch, deployed tag, latest remote tag
- показывает latest release notes

Секция `Select Target + Preview`:

- выбор target mode:
  - stable
  - main
  - advanced branch
- checkbox:
  - update UI too
  - update agent CLI too
- optional `Agent CLI install path`
- preview:
  - will rebuild
  - will restart
  - skipped
  - files changed
  - warnings
  - changed files list

Секция `Proceed`:

- кнопка `Proceed`
- статус job
- live output tail

Секция `Recent Runs`:

- таблица истории update jobs
- столбцы:
  - when
  - branch
  - result
  - UI
  - rebuild
  - restart
  - files
  - recovery

Для failed jobs:

- кнопка `Rollback`
- кнопка `Copy`

## 4.23. `/logs` — System Logs

Назначение:

- два режима просмотра логов:
  - raw
  - troubleshoot

Верхняя панель:

- `Export`
- select container:
  - `ai_engine`
  - `local_ai_server`
  - `admin_ui`
- select mode:
  - `Troubleshoot`
  - `Raw`
- toggle `Live / Paused`
- refresh

### Raw mode

Есть панель фильтров:

- уровни `error`, `warning`, `info`, `debug`
- search

Ниже:

- raw terminal-like log area
- ANSI colors поддерживаются

### Troubleshoot mode

Имеет два состояния.

Сначала `Find a Call`:

- filters:
  - caller number
  - caller name
  - provider
  - pipeline
  - context
  - outcome
  - from date
  - to date
- кнопки:
  - `Search`
  - `Clear`
- таблица call results
- для каждой записи есть `Troubleshoot`

После выбора звонка:

- фильтры сверху:
  - `View`
  - `Call`
  - `Find Call`
  - `Search`
  - `Since`
  - `Until`
  - `Hide transcripts / payloads`
  - `Include debug`
  - `Hide repeats`
- summary block с данными звонка
- лог-события в structured event-view
- кнопка `Jump to latest`, если скролл ушёл вверх

Views:

- `Overview`
- `Issues`
- `Provider`
- `Media`
- `Barge-in / VAD`
- `Tools`
- `All`

## 4.24. `/terminal` — Web Terminal

Назначение:

- простая web-обёртка над несколькими predefined API-командами

Что есть:

- терминальное окно history
- инпут команды
- submit-кнопка с иконкой send

Поддерживаемые команды:

- `help`
- `status`
- `restart <service>`
- `logs <container> <lines>`
- `version`
- `clear`

Это не полноценный shell, а ограниченный frontend-командный интерфейс поверх API.

## 4.25. `/help` — Help & Documentation

Назначение:

- встроенный браузер markdown-документации

Что есть:

- search input
- search results
- список категорий документации
- каждая категория раскрывается
- карточки документов внутри категории

При открытии документа:

- открывается modal
- внутри markdown rendering
- кнопка `GitHub`
- close
- навигация `prev` / `next`

## 5. Общие модалки и служебный UI

### ChangePasswordModal

Открывается:

- из сайдбара кнопкой `Password`
- принудительно после логина, если backend требует смены пароля

Содержит:

- current password
- new password
- confirm new password
- `Update Password`

### ConfirmDialog

Используется почти везде для:

- delete
- restart
- force restart
- import config
- rollback / update
- delete lead/campaign/provider/pipeline/context/tool

### EmailTemplateModal

Используется на ToolsPage для email-инструментов:

- preview рендера шаблона
- copy default template
- reload defaults
- save custom template

## 6. Нероутовые / legacy frontend-страницы

### `ConfigEditor.tsx`

Есть в проекте, но в текущий роутинг не подключена.

Умеет:

- редактировать YAML
- export/import
- save
- restart/apply
- открывать табы отдельных config blocks
- отдельно редактировать providers через embedded forms

### `Logs.tsx`

Есть упрощённая старая страница логов:

- container logs
- auto refresh
- pause/play
- download
- search

Но актуальным маршрутом сейчас является `System/LogsPage.tsx`.

## 7. Что реально можно считать «полным функционалом фронтенда»

Если коротко, фронтенд админки покрывает:

- аутентификацию и forced password change
- setup wizard
- обзор состояния системы
- историю звонков и их разбор
- outbound campaign scheduling
- конфигурирование providers / pipelines / contexts / profiles
- настройку built-in tools и HTTP tools
- настройку MCP servers
- advanced tuning: VAD / streaming / LLM defaults / transport / barge-in
- raw YAML editing и import/export config
- env/.env management
- docker container management
- Asterisk readiness checks
- model library и runtime model switching
- update/rollback flow
- logs / troubleshoot flow
- встроенный web terminal
- встроенный help center

## 8. Самые важные связи между страницами

- `Dashboard` → клик по Asterisk ведёт на `/asterisk`
- `Dashboard` → topology и статусы помогают перейти к system pages
- `Call History` → `Troubleshoot` ведёт на `/logs?...`
- `Call Scheduling` → open call history по связанному звонку
- `Env` → `Setup Wizard` ведёт на `/wizard`
- `Models` → `Configure` ведёт на `/env`
- `Models` → `View Logs` ведёт на `/logs?container=local_ai_server`
- `Sidebar` → `API Docs` ведёт на `/docs`

## 9. Итог

С точки зрения UI это полноценная операторская панель для AVA:

- первичная установка
- повседневная эксплуатация
- детальная настройка голоса/моделей/пайплайнов/инструментов
- диагностика звонков
- обслуживание контейнеров и обновлений

То есть фронтенд здесь не декоративный, а фактически является основной рабочей консолью оператора системы.
