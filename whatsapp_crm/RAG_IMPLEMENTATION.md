# RAG v1 Status / Ops

## Текущее состояние

RAG v1 в проекте доведен до консистентного рабочего состояния на текущем стеке:

- эмбеддинги: `AITunnel / GigaChat` через OpenAI-compatible `/embeddings`
- keyword search: `SQLite FTS5`
- vector search: `sqlite-vec`
- hybrid search: объединение keyword + vector score в одном пайплайне
- очередь: `BullMQ + Redis`, но только как optional enhancement
- rerank: `Cohere`, optional enhancement
- OCR: `Tesseract.js` для изображений, PDF OCR через raster fallback при доступном renderer

Core-path теперь работает и без Redis, BullMQ, Cohere, HyDE и OCR: загрузка документов, FTS keyword search, hybrid fallback, аналитика, versioning и chunk lifecycle не зависят от этих внешних компонентов.

## Что уже реализовано

- `kb_chunks.searchText` и FTS5 индекс по нормализованному русскому тексту
- единый search pipeline для UI и AI-поиска
- корректная нормализация keyword score и vector score
- fail-fast поведение для HyDE и Cohere rerank
- versioning документов по `originalName`
- dedupe по `contentHash + instanceId`, независимо от имени файла
- редактирование и удаление чанков с пересчетом индексов и статистики
- загрузка через оба multipart-формата: `files[]` и legacy `file`
- queued upload status с `state`, `percent`, `stage`, `result`, `failedReason`
- восстановление предыдущей версии при удалении current version
- instance-scoped `rebuild-embeddings`
- operational `migrate-embeddings` для полного reindex при смене размерности
- поиск и UI search analytics в `rag_search_log`
- UI для очереди загрузки, истории версий, chunk inspector и chunk edit/delete
- рабочий `npm test` и обновленный `test-rag.sh`

## Основные файлы

- backend search / ingestion: `src/services/rag.service.js`
- database / schema / FTS / vector index: `src/services/database.service.js`
- upload/search routes: `src/routes/api.routes.js`
- queue layer: `src/queues/document-queue.js`
- queue worker: `src/queues/workers/document-worker.js`
- OCR: `src/services/ocr.service.js`
- frontend screen: `frontend/src/pages/KnowledgeBase.tsx`
- frontend API client: `frontend/src/api.ts`
- text normalization for FTS: `src/utils/rag-normalizer.js`

## Smoke / Verification

Базовая проверка:

```bash
npm test
```

Этот runner:

- поднимает сервер локально
- проверяет upload через `files` и `file`
- проверяет keyword и hybrid search
- проверяет chunk update/delete
- проверяет versioning и dedupe
- проверяет analytics и rebuild endpoint
- работает в degraded режиме без Redis / BullMQ / Cohere / HyDE

Дополнительный ручной smoke:

```bash
BASE_URL=http://localhost:3000 bash test-rag.sh
```

## Операционные endpoint'ы

- `POST /api/knowledge-base/:instanceId/rebuild-embeddings`
  Безопасный reindex только для current documents конкретного instance.

- `POST /api/knowledge-base/:instanceId/migrate-embeddings`
  Полный operational flow для смены размерности: пересоздание `kb_chunks_vec` и полный reindex current documents.

## Runtime notes

- Текущая наблюдаемая размерность провайдера эмбеддингов: `2560d`
- `vectorSearchAvailable` зависит от наличия инициализированной `kb_chunks_vec`
- `embeddingsAvailable` отражает runtime availability провайдера после попытки инициализации, а не только наличие ключа
- Redis/BullMQ остаются опциональными. При их недоступности загрузка становится синхронной, а поиск продолжает работать

## Что осталось вне scope v1

- отдельный UX-поток для `clientFeedback` в search analytics
- более глубокая OCR-инфраструктура для PDF на машинах без подходящего renderer
- дополнительная продуктовая аналитика именно по AI-поиску из runtime assistant flow
