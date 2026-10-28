# RAG v1: As-Built Documentation

## 1. Overview

Текущая реализация RAG в проекте предназначена для двух сценариев:

- админский поиск по базе знаний из UI
- retrieval контекста для AI-ответов

RAG v1 построен так, чтобы retrieval core продолжал работать даже при отказе внешних enhancement-компонентов. Минимально необходимый путь выглядит так:

1. документ загружается
2. текст извлекается и чанкуется
3. чанки сохраняются в `kb_chunks`
4. нормализованный `searchText` индексируется в FTS5
5. при доступности провайдера генерируются embeddings и индексируются в `kb_chunks_vec`
6. search pipeline выбирает keyword / vector / hybrid
7. все поисковые запросы логируются в `rag_search_log`

## 2. Stack

### Backend

- Node.js + Express
- SQLite (`better-sqlite3`)
- FTS5
- `sqlite-vec`
- `BullMQ` + `Redis` как optional queue path

### AI / Retrieval

- embeddings provider: `AITunnel`
- embeddings model: `gigachat-embeddings-giga-r`
- current observed dimension: `2560`
- optional rerank: `Cohere`
- optional HyDE query transform: existing AI provider path

### Parsing / OCR

- `pdf-parse`
- `mammoth`
- `Tesseract.js`
- `sharp`-based PDF raster fallback for OCR, если окружение умеет рендерить PDF pages

## 3. Data Model

### `knowledge_base`

Хранит версии документов.

Основные поля:

- `id`
- `instanceId`
- `filename`
- `originalName`
- `contentHash`
- `mimeType`
- `fileSize`
- `chunkCount`
- `hasEmbeddings`
- `version`
- `isCurrent`
- `createdAt`

Семантика:

- dedupe выполняется по `contentHash + instanceId`
- versioning выполняется по `originalName + instanceId`
- только `isCurrent = 1` участвует в активном поиске

### `kb_chunks`

Хранит чанки документа.

Основные поля:

- `id`
- `kbId`
- `chunkIndex`
- `text`
- `searchText`
- `section`

`searchText` — это не raw текст, а нормализованное поле для keyword search:

- lowercase
- разбиение по Unicode токенам
- фильтрация stop-words
- русский stemming через `PorterStemmerRu`, если доступен

### `kb_chunks_fts`

FTS5 таблица по `searchText`.

Использование:

- keyword search идет через `MATCH`
- индекс поддерживается триггерами и rebuild
- при update/delete chunk индекс обновляется синхронно

### `kb_chunks_vec`

`sqlite-vec` таблица для embeddings.

Хранит:

- `instanceId`
- `embedding`
- `chunkId`
- `kbId`
- `originalName`

`instanceId` используется как `PARTITION KEY`, поэтому vector search работает instance-scoped.

### `rag_search_log`

Логирует поисковые запросы.

Основные поля:

- `instanceId`
- `query`
- `searchType`
- `resultsCount`
- `topScore`
- `avgScore`
- `responseTimeMs`
- `wasUsedByAI`
- `clientFeedback`
- `createdAt`

## 4. Ingestion Pipeline

Основная функция: `processDocument(instanceId, buffer, originalName, mimeType, options?)`

### 4.1 Supported formats

- `application/pdf`
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- `text/plain`
- `text/csv`
- `text/markdown`
- `image/png`
- `image/jpeg`
- `image/jpg`

### 4.2 Extraction

- PDF: сначала `pdf-parse`
- если PDF-текст пустой или слишком короткий, включается OCR fallback
- DOCX: `mammoth.extractRawText`
- TXT / CSV / MD: `buffer.toString('utf8')`
- images: OCR через `Tesseract.js`

### 4.3 Duplicate / version rules

- если найден тот же `contentHash` внутри того же `instanceId`, документ считается duplicate
- имя файла при dedupe не важно
- если `contentHash` новый, но `originalName` уже существует, создается новая версия
- предыдущая current-версия переводится в `isCurrent = 0`
- при удалении current version предыдущая последняя версия автоматически поднимается в `isCurrent = 1`

### 4.4 Chunking

Пайплайн чанкования:

- разбиение по абзацам
- detection простых секций
- размер чанка около `1000` символов
- overlap около `200` символов
- overlap переносится из хвоста предыдущего чанка в начало нового

### 4.5 Indexing

После сохранения документа:

1. чанки вставляются в `kb_chunks`
2. `searchText` создается сразу при insert
3. FTS индекс обновляется триггерами
4. embeddings генерируются батчами, если provider доступен
5. успешные embeddings попадают в `kb_chunks_vec`
6. статистика документа обновляется через `chunkCount` и `hasEmbeddings`

### 4.6 Progress callback

`processDocument()` поддерживает progress callback со стадиями:

- `extract`
- `chunk`
- `save`
- `embed`
- `index`
- `finish`
- `error`

Этот контракт используется queue worker'ом и `upload-status`.

## 5. Retrieval

Внутренняя точка входа: `runSearchPipeline(instanceId, query, options)`

Поддерживаемые режимы:

- `keyword`
- `vector`
- `hybrid`

### 5.1 Keyword search

Keyword search использует:

- нормализацию запроса теми же правилами, что и `searchText`
- FTS5 `MATCH`
- AND-query как primary
- OR-query как fallback

Скоринг:

- raw `bm25()` считается lower-is-better
- затем значения нормализуются в диапазон `0..1`
- лучший результат всегда получает больший итоговый score

Это закрывает предыдущую проблему, где русские словоформы вроде `стрижкой` не находились или ранжировались нестабильно.

### 5.2 Vector search

Pipeline:

1. `initEmbeddings()`
2. optional HyDE query transform с коротким timeout
3. запрос embedding к провайдеру
4. KNN через `sqlite-vec`
5. нормализация distance result-set-wise в диапазон `0..1`

Если embeddings provider недоступен:

- vector search не роняет запрос
- происходит fallback в keyword search

### 5.3 Hybrid search

Hybrid search:

- берет keyword results и vector results
- приводит оба score к сопоставимому `0..1`
- применяет динамические веса
- сортирует детерминированно по:
  - `combinedScore`
  - `vectorScore`
  - `keywordScore`
  - `id`

Optional rerank:

- если есть `COHERE_API_KEY`
- если `RERANKING_ENABLED !== false`
- если rerank успевает в короткий timeout

При недоступности rerank:

- остается обычный hybrid ranking
- запрос не считается failed

### 5.4 Unified search path

И UI search, и AI search проходят через один и тот же `runSearchPipeline()`.

Это дает единое поведение для:

- scoring
- fallback logic
- threshold application
- analytics logging
- responseTime measurement

Разница только в том, что AI path вызывает `search()` поверх этого пайплайна и собирает готовый текстовый context block.

## 6. Chunk Lifecycle

### Update chunk

`PUT /api/knowledge-base/:instanceId/chunks/:chunkId`

При update:

1. проверяется принадлежность чанка нужному `instanceId`
2. обновляется `text`
3. пересчитывается `searchText`
4. FTS индекс обновляется триггером
5. старый vector entry удаляется
6. генерируется новый embedding, если provider доступен
7. статистика документа пересчитывается

### Delete chunk

`DELETE /api/knowledge-base/:instanceId/chunks/:chunkId`

При delete:

1. проверяется принадлежность нужному `instanceId`
2. удаляется запись из `kb_chunks_vec`
3. удаляется chunk
4. FTS индекс обновляется триггером
5. документу пересчитываются `chunkCount` и `hasEmbeddings`

## 7. Upload Modes

### Synchronous path

Если BullMQ/Redis недоступны:

- upload обрабатывается сразу в request-response цикле
- клиент получает terminal result немедленно

### Queued path

Если очередь доступна:

- файл ставится в BullMQ job
- ответ возвращает `jobId`
- worker шлет progress по стадиям ingestion pipeline

### Multipart compatibility

Route:

- `POST /api/knowledge-base/:instanceId/upload`

Поддерживает оба формата:

- `files`
- `file`

Это сделано для обратной совместимости со старыми скриптами и новым multi-file UI.

## 8. Public API

### Upload

`POST /api/knowledge-base/:instanceId/upload`

Ответ по каждому файлу:

- sync: terminal result
- queue: `{ queued: true, jobId, originalName }`

### Upload status

`GET /api/knowledge-base/:instanceId/upload-status/:jobId`

Возвращает:

- `state`
- `percent`
- `stage`
- `result`
- `failedReason`

И дополнительно валидирует принадлежность job текущему `instanceId`.

### Search

`POST /api/knowledge-base/:instanceId/search`

Вход:

- `query`
- `searchType`
- `k`

Выход:

- `searchType`
- `responseTimeMs`
- `resultsCount`
- `results[]`

Каждый search request логируется в `rag_search_log`.

### Stats

`GET /api/knowledge-base/:instanceId/stats`

Возвращает:

- `totalDocuments`
- `totalChunks`
- `chunksWithEmbeddings`
- `embeddingsCoverage`
- `vectorSearchAvailable`
- `embeddingsAvailable`
- `embeddingDimensions`
- `searchAnalytics`

### Rebuild embeddings

`POST /api/knowledge-base/:instanceId/rebuild-embeddings`

Поведение:

- очищает vector entries для current documents данного instance
- заново строит embeddings только для этого instance

### Migrate embeddings

`POST /api/knowledge-base/:instanceId/migrate-embeddings`

Operational endpoint:

- инициализирует provider
- валидирует размерность
- пересоздает `kb_chunks_vec`
- делает full reindex всех current documents

UI не должен вызывать этот endpoint автоматически.

### Version history

`GET /api/knowledge-base/:instanceId/versions/:originalName`

Возвращает все версии документа по `originalName` внутри instance.

## 9. Frontend: Knowledge Base

Экран `frontend/src/pages/KnowledgeBase.tsx` поддерживает:

- multi-file upload
- queued upload polling
- terminal upload states и errors
- список current documents
- раскрытие чанков документа
- историю версий
- редактирование чанка
- удаление чанка
- ручной keyword / vector / hybrid search
- аналитические карточки и список recent searches

### Queue UX

При queued upload UI показывает:

- stage
- percent
- terminal success / duplicate / failure state
- сообщение об ошибке или duplicate

### Chunk inspector

После edit:

- chunk немедленно обновляется на сервере
- переиндексируется
- повторно загружаются chunks, версии, файлы и stats

## 10. Analytics

Все search requests пишутся в `rag_search_log`.

Доступная аналитика:

- total search volume
- avg latency
- top queries
- top score / avg score
- recent searches
- AI use rate

`clientFeedback` оставлен в схеме для совместимости, но v1 не требует отдельного UI flow для него.

## 11. Degraded Mode / Fallbacks

### Без embeddings provider

- документ все равно загружается
- vector index не строится
- keyword search продолжает работать
- hybrid search автоматически ведет себя как keyword-first fallback

### Без Redis / BullMQ

- upload остается рабочим
- route обрабатывает документы синхронно
- queue/status path просто не используется

### Без Cohere

- rerank пропускается
- hybrid search отдает базовый score

### Без HyDE

- vector search использует исходный query
- запрос не падает

### Без OCR renderer для PDF

- PDF OCR не делается
- это видно по логам
- raw PDF parse все равно используется

## 12. Verified Scenarios

Фактически прогнаны:

- frontend build
- backend module load
- `npm test`
- `test-rag.sh`

Smoke coverage:

- upload через `files`
- upload через legacy `file`
- keyword search
- hybrid search
- chunk update
- chunk delete
- version creation
- duplicate rejection по content hash
- current-version restore after delete
- analytics logging
- rebuild endpoint

## 13. Known Operational Notes

- если Redis недоступен, в логах возможны connection warnings от queue/cache layer, но core RAG path остается рабочим
- `vectorSearchAvailable` отражает наличие инициализированного vector contour, а не гарантию доступности внешнего embedding provider в текущую секунду
- для production OCR по PDF желательно окружение, где `sharp` может rasterize PDF pages

## 14. Recommended Env

Минимально полезные переменные:

```env
EMBEDDINGS_PROVIDER=aitunnel
EMBEDDINGS_API_URL=https://api.aitunnel.ru/v1
EMBEDDINGS_API_KEY=...
EMBEDDINGS_MODEL=gigachat-embeddings-giga-r

COHERE_API_KEY=
RERANKING_ENABLED=true
HYDE_ENABLED=true
OCR_ENABLED=true

REDIS_HOST=localhost
REDIS_PORT=6379
```

Если `EMBEDDINGS_DIMENSIONS` не задан, размерность определяется автоматически при первом успешном запросе к embedding provider.
