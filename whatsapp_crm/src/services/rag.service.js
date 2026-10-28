const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const crypto = require('crypto-js');
const axios = require('axios');
const DB = require('./database.service');
const NativeKnowledge = require('./customer-native-knowledge.service');
const Logger = require('../utils/logger');
const config = require('../config');
const GeminiEmbeddings = require('./gemini-embeddings.service');
const { buildFtsQueries, normalizeTokens, hasStemmer } = require('../utils/rag-normalizer');

class RAGService {
    constructor() {
        this.chunkSize = 1000;
        this.overlap = 200;
        this.maxFileSize = 20 * 1024 * 1024;
        this.stemmer = hasStemmer;
        this.hydeTimeoutMs = 2500;
        this.rerankTimeoutMs = 3000;

        this.supportedFormats = {
            'application/pdf': 'pdf',
            'text/plain': 'txt',
            'text/csv': 'csv',
            'text/markdown': 'md',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
            'image/png': 'png',
            'image/jpeg': 'jpeg',
            'image/jpg': 'jpg'
        };

        this.embeddingsAvailable = false;
        this.embeddingsInitialized = false;
        this.embeddingDimensions = config.embeddings.dimensions || 0;
        this.vectorSearchAvailable = false;

        this.apiClient = axios.create({
            baseURL: config.embeddings.apiUrl,
            headers: {
                'Authorization': `Bearer ${config.embeddings.apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });
    }

    async initEmbeddings() {
        if (this.embeddingsInitialized) return;
        try {
            const testResult = await this._generateEmbedding('тест');
            if (testResult && testResult.length > 0) {
                this.embeddingDimensions = testResult.length;
                this.embeddingsAvailable = true;

                if (!config.embeddings.dimensions || config.embeddings.dimensions !== this.embeddingDimensions) {
                    config.embeddings.dimensions = this.embeddingDimensions;
                }

                DB.ensureVectorTable(this.embeddingDimensions);

                Logger.success(`Embeddings enabled (${config.embeddings.model}, ${this.embeddingDimensions}d)`);
            }
        } catch (e) {
            Logger.warn('Embeddings disabled:', e.message);
        } finally {
            this.embeddingsInitialized = true;
            this._checkVectorSearchAvailable();
        }
    }

    _checkVectorSearchAvailable() {
        try {
            const dimensions = DB.getVectorTableDimensions();
            if (dimensions > 0) {
                this.embeddingDimensions = this.embeddingDimensions || dimensions;
                this.vectorSearchAvailable = true;
            }
        } catch (e) {}
    }

    async _generateEmbedding(text) {
        const response = await this.apiClient.post('/embeddings', {
            model: config.embeddings.model,
            input: text
        });
        if (response.data && response.data.data && response.data.data[0]) {
            return response.data.data[0].embedding;
        }
        throw new Error('Invalid embedding response');
    }

    async _generateEmbeddingsBatch(texts) {
        const response = await this.apiClient.post('/embeddings', {
            model: config.embeddings.model,
            input: texts
        });
        if (response.data && response.data.data) {
            return response.data.data
                .sort((a, b) => a.index - b.index)
                .map(d => d.embedding);
        }
        throw new Error('Invalid batch embedding response');
    }

    async _runWithTimeout(taskFactory, timeoutMs, errorMessage) {
        return Promise.race([
            taskFactory(),
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
            })
        ]);
    }

    _normalizeLowerIsBetter(rawResults, scoreField) {
        if (!rawResults || rawResults.length === 0) return [];

        const values = rawResults.map((result) => Number(result[scoreField] || 0));
        const minValue = Math.min(...values);
        const maxValue = Math.max(...values);

        return rawResults.map((result, index) => {
            const value = values[index];
            const score = maxValue === minValue
                ? 1
                : 1 - ((value - minValue) / (maxValue - minValue));

            return {
                ...result,
                score: Number(score.toFixed(6))
            };
        });
    }

    _buildSearchContext(results) {
        return results.map((result) => {
            const relevance = Math.round((result.combinedScore || result.score || 0) * 100);
            const source = result.originalName || 'unknown';
            const section = result.section ? ` (${result.section})` : '';
            return `[Из документа "${source}"${section}, релевантность ${relevance}%]:\n${result.text}`;
        }).join('\n\n---\n\n');
    }

    async buildConversationContext(instanceId, chatId, lastText = '', options = {}) {
        const k = options.k || 5;
        const messageLimit = options.messageLimit || 3;
        const explicitHistory = Array.isArray(options.history) ? options.history : null;

        let recentUserText = '';

        if (explicitHistory) {
            recentUserText = explicitHistory
                .filter(m => (m.role === 'user' || m.role === 'client') && (m.content || m.text))
                .slice(-messageLimit)
                .map(m => m.content || m.text)
                .join(' ');
        } else if (chatId) {
            const recentMessages = await DB.getRecentMessages(instanceId, chatId, messageLimit);
            recentUserText = recentMessages
                .filter(m => m.role === 'user' && (m.content || m.text))
                .map(m => m.content || m.text)
                .join(' ');
        }

        const query = (recentUserText || lastText || '').trim();
        if (!query) {
            return { query: '', context: '', searched: false };
        }

        const context = await this.search(instanceId, query, k);
        return { query, context, searched: true };
    }

    _emitProgress(onProgress, stage, percent, extra = {}) {
        if (typeof onProgress !== 'function') return;
        try {
            onProgress({ stage, percent, ...extra });
        } catch (error) {
            Logger.warn('RAG progress callback error:', error.message);
        }
    }

    async extractText(buffer, mimeType) {
        try {
            let text = '';

            switch (mimeType) {
                case 'application/pdf': {
                    const pdfData = await pdfParse(buffer);
                    text = pdfData.text;
                    if (!text || text.trim().length < 50) {
                        if (config.rag.ocrEnabled) {
                            try {
                                const OCRService = require('./ocr.service');
                                text = await OCRService.extractTextFromPDF(buffer);
                            } catch (ocrErr) {
                                Logger.warn('OCR fallback failed:', ocrErr.message);
                            }
                        }
                    }
                    break;
                }
                case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
                    const result = await mammoth.extractRawText({ buffer });
                    text = result.value;
                    break;
                }
                case 'image/png':
                case 'image/jpeg':
                case 'image/jpg': {
                    if (config.rag.ocrEnabled) {
                        const OCRService = require('./ocr.service');
                        text = await OCRService.extractTextFromImage(buffer);
                    } else {
                        throw new Error('OCR is disabled. Enable OCR_ENABLED to process images.');
                    }
                    break;
                }
                case 'text/plain':
                case 'text/csv':
                case 'text/markdown':
                    text = buffer.toString('utf8');
                    break;
                default:
                    text = buffer.toString('utf8');
                    if (!text.trim()) {
                        throw new Error(`Unsupported file type: ${mimeType}`);
                    }
            }

            text = text.replace(/\r\n/g, '\n')
                       .replace(/\n{3,}/g, '\n\n')
                       .replace(/[ \t]+/g, ' ')
                       .trim();

            if (!text) throw Object.assign(new Error('Document has no text.'), { code: 'KNOWLEDGE_TEXT_EMPTY' });
            // A manually entered note is uploaded as text/plain. A short fact
            // such as a check-in time is useful knowledge in its own right.
            if (mimeType !== 'text/plain' && text.length < 50) {
                throw Object.assign(new Error('Document is too short. Minimum 50 characters required.'), { code: 'KNOWLEDGE_DOCUMENT_TOO_SHORT' });
            }

            return text;
        } catch (error) {
            Logger.error(`Text extraction failed for ${mimeType}:`, error);
            throw Object.assign(new Error(`Failed to extract text: ${error.message}`), { code: error.code });
        }
    }

    calculateContentHash(text) {
        return crypto.MD5(text).toString();
    }

    smartChunk(text, originalName, { allowShortText = false } = {}) {
        const chunks = [];
        const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);

        let currentChunk = '';
        let chunkIndex = 0;
        let currentSection = 'Introduction';
        let lastChunkTail = '';

        for (const paragraph of paragraphs) {
            const trimmedParagraph = paragraph.trim();

            const headerMatch = trimmedParagraph.match(/^(#{1,3}\s+.+|[A-ZА-ЯЁ]{3,}\s*[.:])/);
            if (headerMatch) {
                if (currentChunk.trim().length > 20) {
                    chunks.push({
                        text: currentChunk.trim(),
                        chunkIndex: chunkIndex++,
                        section: currentSection
                    });
                    lastChunkTail = currentChunk.slice(-this.overlap);
                }
                currentSection = trimmedParagraph.replace(/^#{1,3}\s+/, '').trim();
                currentChunk = lastChunkTail ? lastChunkTail + '\n\n' + trimmedParagraph + '\n\n' : trimmedParagraph + '\n\n';
                continue;
            }

            if ((currentChunk + '\n\n' + trimmedParagraph).length > this.chunkSize) {
                if (currentChunk.trim().length > 20) {
                    chunks.push({
                        text: currentChunk.trim(),
                        chunkIndex: chunkIndex++,
                        section: currentSection
                    });
                    lastChunkTail = currentChunk.slice(-this.overlap);
                }

                const sentences = trimmedParagraph.match(/[^.!?]+[.!?]+/g) || [trimmedParagraph];
                let subChunk = lastChunkTail ? lastChunkTail + '\n\n' : '';
                for (const sentence of sentences) {
                    if ((subChunk + sentence).length > this.chunkSize) {
                        if (subChunk.trim().length > 20) {
                            chunks.push({
                                text: subChunk.trim(),
                                chunkIndex: chunkIndex++,
                                section: currentSection
                            });
                            lastChunkTail = subChunk.slice(-this.overlap);
                        }
                        subChunk = lastChunkTail + sentence;
                    } else {
                        subChunk += sentence;
                    }
                }
                currentChunk = subChunk;
            } else {
                currentChunk += (currentChunk ? '\n\n' : '') + trimmedParagraph;
            }
        }

        if (currentChunk.trim().length > 20) {
            chunks.push({
                text: currentChunk.trim(),
                chunkIndex: chunkIndex,
                section: currentSection
            });
        }

        if (!chunks.length && allowShortText && text.trim()) {
            chunks.push({ text: text.trim(), chunkIndex: 0, section: currentSection });
        }
        Logger.info(`Smart chunking: ${chunks.length} chunks from ${originalName} (avg size: ${Math.round(chunks.reduce((sum, c) => sum + c.text.length, 0) / Math.max(chunks.length, 1))} chars)`);
        return chunks;
    }

    async generateEmbeddings(chunks, instanceId) {
        if (GeminiEmbeddings.selected(instanceId)) return GeminiEmbeddings.generate(chunks, instanceId);
        await this.initEmbeddings();

        if (!this.embeddingsAvailable) {
            Logger.warn('Embeddings not available, skipping vector generation');
            return chunks.map(c => ({ ...c, embedding: null }));
        }

        const CacheService = require('./cache.service');
        const startTime = Date.now();
        const BATCH_SIZE = 20;
        const MAX_CONCURRENT = 3;
        const embeddings = new Array(chunks.length).fill(null);

        Logger.info(`Generating embeddings for ${chunks.length} chunks (batch=${BATCH_SIZE}, concurrency=${MAX_CONCURRENT})...`);

        const uncachedIndices = [];
        const uncachedTexts = [];

        for (let i = 0; i < chunks.length; i++) {
            const cacheKey = crypto.MD5(chunks[i].text).toString();
            try {
                const cached = await CacheService.getEmbedding(cacheKey);
                if (cached) {
                    embeddings[i] = cached;
                    continue;
                }
            } catch (e) { }

            uncachedIndices.push(i);
            uncachedTexts.push(chunks[i].text);
        }

        if (uncachedTexts.length > 0) {
            const batches = [];
            for (let i = 0; i < uncachedTexts.length; i += BATCH_SIZE) {
                batches.push({
                    indices: uncachedIndices.slice(i, i + BATCH_SIZE),
                    texts: uncachedTexts.slice(i, i + BATCH_SIZE)
                });
            }

            const executing = new Set();
            for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
                const batch = batches[batchIdx];
                const task = (async () => {
                    try {
                        let batchResults;
                        if (batch.texts.length === 1) {
                            const single = await this._generateEmbedding(batch.texts[0]);
                            batchResults = [single];
                        } else {
                            batchResults = await this._generateEmbeddingsBatch(batch.texts);
                        }
                        for (let j = 0; j < batch.indices.length; j++) {
                            const idx = batch.indices[j];
                            embeddings[idx] = batchResults[j];
                            const cacheKey = crypto.MD5(chunks[idx].text).toString();
                            try {
                                await CacheService.setEmbedding(cacheKey, batchResults[j]);
                            } catch (e) { }
                        }
                    } catch (batchErr) {
                        Logger.warn(`Batch embedding failed, falling back to single: ${batchErr.message}`);
                        for (let j = 0; j < batch.indices.length; j++) {
                            try {
                                const single = await this._generateEmbedding(batch.texts[j]);
                                const idx = batch.indices[j];
                                embeddings[idx] = single;
                                const cacheKey = crypto.MD5(chunks[idx].text).toString();
                                try {
                                    await CacheService.setEmbedding(cacheKey, single);
                                } catch (e) { }
                            } catch (singleErr) {
                                Logger.error(`Single embedding failed for chunk ${batch.indices[j]}:`, singleErr.message);
                            }
                        }
                    }
                    Logger.info(`  Embedding progress: ${Math.round(((batchIdx + 1) / batches.length) * 100)}%`);
                })();

                executing.add(task.then(() => executing.delete(task)));
                if (executing.size >= MAX_CONCURRENT) {
                    await Promise.race([...executing]);
                }
            }
            await Promise.all([...executing]);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        const successCount = embeddings.filter(e => e !== null).length;
        Logger.success(`Generated ${successCount}/${chunks.length} embeddings in ${duration}s`);

        return chunks.map((c, i) => ({ ...c, embedding: embeddings[i] }));
    }

    async _indexDocumentChunks(instanceId, kbId, originalName, chunks, onProgress = null) {
        const storedChunks = DB.getChunksForKnowledgeBase(kbId);
        const chunksWithEmbeddings = await this.generateEmbeddings(storedChunks, instanceId);
        let vectorCount = 0;

        for (let index = 0; index < chunksWithEmbeddings.length; index++) {
            const chunk = chunksWithEmbeddings[index];
            if (!chunk.embedding) continue;

            const added = chunk.embeddingProvider === 'gemini' ? GeminiEmbeddings.store(chunk, instanceId) : DB.addChunkToVectorTable(
                chunk.id,
                kbId,
                instanceId,
                chunk.embedding,
                originalName
            );

            if (added) vectorCount++;

            if (chunksWithEmbeddings.length > 0) {
                const progress = 55 + Math.round(((index + 1) / chunksWithEmbeddings.length) * 35);
                this._emitProgress(onProgress, 'embed', progress, {
                    current: index + 1,
                    total: chunksWithEmbeddings.length
                });
            }
        }

        DB.updateKnowledgeBaseStats(kbId, chunks.length, chunks.length > 0 && vectorCount >= chunks.length);
        this._emitProgress(onProgress, 'index', 95, { chunksCount: chunks.length, embeddingsCount: vectorCount });

        return {
            chunksWithEmbeddings,
            vectorCount
        };
    }

    async processDocument(instanceId, buffer, originalName, mimeType, options = {}) {
        const onProgress = options.onProgress;
        try {
            Logger.info(`Processing document: ${originalName} (${mimeType})`);
            this._emitProgress(onProgress, 'extract', 5, { originalName });

            if (buffer.length > this.maxFileSize) {
                throw new Error(`File too large. Maximum size: ${this.maxFileSize / 1024 / 1024}MB`);
            }

            if (!this.supportedFormats[mimeType]) {
                throw new Error(`Unsupported format. Supported: ${Object.keys(this.supportedFormats).join(', ')}`);
            }

            const text = await this.extractText(buffer, mimeType);
            const contentHash = this.calculateContentHash(text);
            this._emitProgress(onProgress, 'extract', 20, { contentLength: text.length });

            const duplicateDoc = DB.getKnowledgeBaseByHash(instanceId, contentHash);
            if (duplicateDoc) {
                Logger.warn(`Duplicate document detected by content hash: ${originalName}`);
                this._emitProgress(onProgress, 'finish', 100, { duplicate: true });
                return {
                    success: false,
                    isDuplicate: true,
                    kbId: duplicateDoc.id,
                    version: duplicateDoc.version,
                    error: 'This document has already been uploaded for this instance. Duplicate detected by content hash.'
                };
            }

            const existingDoc = DB.getCurrentKnowledgeBaseFileByName(instanceId, originalName);

            const chunks = this.smartChunk(text, originalName, { allowShortText: mimeType === 'text/plain' });
            this._emitProgress(onProgress, 'chunk', 35, { chunksCount: chunks.length });

            if (chunks.length === 0) {
                throw new Error('No valid chunks extracted from document');
            }

            let version = 1;
            if (existingDoc && existingDoc.contentHash !== contentHash) {
                const prevVersion = DB.get(
                    'SELECT MAX(version) as maxVer FROM knowledge_base WHERE instanceId = ? AND originalName = ?',
                    [instanceId, originalName]
                );
                version = (prevVersion?.maxVer || 0) + 1;
                DB.run('UPDATE knowledge_base SET isCurrent = 0 WHERE instanceId = ? AND originalName = ? AND isCurrent = 1', [instanceId, originalName]);
            }

            const filename = `${Date.now()}_${originalName}`;
            const kbId = DB.addKnowledgeBaseFile(
                instanceId,
                filename,
                originalName,
                contentHash,
                mimeType,
                buffer.length,
                version
            );

            if (!kbId) {
                throw new Error('Failed to save document metadata (duplicate or DB error)');
            }

            await DB.addKnowledgeBaseChunks(kbId, chunks);
            // Both direct uploads and BullMQ queue the saved source before
            // optional local embeddings. Outages leave an explicit retry state.
            const nativeSync = this._queueNativeKnowledge(instanceId, kbId);
            this._emitProgress(onProgress, 'save', 50, { kbId, version });

            const { vectorCount } = await this._indexDocumentChunks(instanceId, kbId, originalName, chunks, onProgress);
            this._emitProgress(onProgress, 'finish', 100, { kbId, version, chunksCount: chunks.length, embeddingsCount: vectorCount });

            Logger.success(`Document ${originalName} v${version} processed: ${chunks.length} chunks, ${vectorCount} embeddings`);

            return {
                success: true,
                kbId,
                chunksCount: chunks.length,
                embeddingsCount: vectorCount,
                nativeSync,
                isDuplicate: false,
                version
            };

        } catch (error) {
            Logger.error(`Error processing document ${originalName}:`, error);
            this._emitProgress(onProgress, 'error', 100, { error: error.message });
            return {
                success: false,
                ...(error.code === 'KNOWLEDGE_TEXT_EMPTY' || error.code === 'KNOWLEDGE_DOCUMENT_TOO_SHORT' ? { code: error.code } : {}),
                error: error.message
            };
        }
    }

    async searchKeyword(instanceId, query, k = 5) {
        try {
            const { tokens, primary, fallback } = buildFtsQueries(query);
            if (tokens.length === 0) return [];

            let results = DB.searchChunksByFTS5(instanceId, primary, k * 2);
            if (results.length === 0 && fallback && fallback !== primary) {
                results = DB.searchChunksByFTS5(instanceId, fallback, k * 2);
            }

            return this._normalizeLowerIsBetter(results, 'rawRank')
                .slice(0, k)
                .map((result) => ({
                    ...result,
                    searchType: 'keyword'
                }));
        } catch (error) {
            Logger.error('Error in keyword search (FTS5):', error);
            if (this.stemmer) {
                return this._searchKeywordFallback(instanceId, query, k);
            }
            return [];
        }
    }

    async _searchKeywordFallback(instanceId, query, k = 5) {
        try {
            const chunks = DB.getKnowledgeBaseChunks(instanceId);
            if (!chunks || chunks.length === 0) return [];

            const queryTokens = normalizeTokens(query);

            if (queryTokens.length === 0) return [];

            const documentFrequencies = {};
            const chunkTokensList = chunks.map(c => {
                const tokens = normalizeTokens(c.text);
                const uniqueTokens = new Set(tokens);
                uniqueTokens.forEach(t => {
                    documentFrequencies[t] = (documentFrequencies[t] || 0) + 1;
                });
                return tokens;
            });

            const N = chunks.length;
            const scoredChunks = chunks.map((chunk, index) => {
                const tokens = chunkTokensList[index];
                let score = 0;
                queryTokens.forEach(qToken => {
                    const tf = tokens.filter(t => t === qToken).length;
                    if (tf > 0) {
                        const df = documentFrequencies[qToken] || 1;
                        const idf = Math.log(1 + N / df);
                        score += tf * idf;
                    }
                });
                return { ...chunk, score, searchType: 'keyword' };
            });

            return scoredChunks
                .filter(c => c.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, k);
        } catch (error) {
            Logger.error('Error in keyword fallback search:', error);
            return [];
        }
    }

    async searchVector(instanceId, query, k = 5) {
        try {
            if (GeminiEmbeddings.selected(instanceId)) {
                const results = await GeminiEmbeddings.search(instanceId, query, k);
                return results.length ? this._normalizeLowerIsBetter(results, 'distance')
                    .map(result => ({ ...result, searchType: 'vector' })) : this.searchKeyword(instanceId, query, k);
            }
            await this.initEmbeddings();

            if (!this.embeddingsAvailable || !this.vectorSearchAvailable) {
                Logger.warn('Vector search not available, falling back to keyword search');
                return this.searchKeyword(instanceId, query, k);
            }

            let searchQuery = query;
            if (config.rag.hydeEnabled) {
                try {
                    searchQuery = await this._runWithTimeout(
                        () => this.transformQuery(query, instanceId),
                        this.hydeTimeoutMs,
                        'HyDE timeout'
                    ) || query;
                } catch (e) {
                    Logger.warn('HyDE failed, using original query:', e.message);
                }
            }

            const queryEmbedding = await this._generateEmbedding(searchQuery);
            const vectorResults = DB.searchChunksByVector(instanceId, queryEmbedding, k);

            if (vectorResults.length === 0) return [];

            return this._normalizeLowerIsBetter(vectorResults, 'distance')
                .map((result) => ({
                    ...result,
                    searchType: 'vector'
                }));

        } catch (error) {
            Logger.error('Error in vector search:', error);
            return this.searchKeyword(instanceId, query, k);
        }
    }

    async searchHybrid(instanceId, query, k = 5) {
        try {
            const weights = this._calculateWeights(query);

            const keywordResults = await this.searchKeyword(instanceId, query, k * 2);
            const vectorResults = await this.searchVector(instanceId, query, k * 2);

            const combinedMap = new Map();

            const maxKeywordScore = keywordResults.length > 0
                ? Math.max(...keywordResults.map(r => r.score || 0))
                : 1;

            keywordResults.forEach(r => {
                const normalizedTfidf = (r.score || 0) / maxKeywordScore;
                combinedMap.set(r.id, {
                    ...r,
                    keywordScore: normalizedTfidf,
                    vectorScore: 0,
                    combinedScore: weights.keyword * normalizedTfidf,
                    searchType: 'hybrid'
                });
            });

            vectorResults.forEach(r => {
                const normalizedVec = r.score || 0;
                if (combinedMap.has(r.id)) {
                    const existing = combinedMap.get(r.id);
                    existing.vectorScore = normalizedVec;
                    existing.combinedScore += weights.vector * normalizedVec;
                } else {
                    combinedMap.set(r.id, {
                        ...r,
                        keywordScore: 0,
                        vectorScore: normalizedVec,
                        combinedScore: weights.vector * normalizedVec,
                        searchType: 'hybrid'
                    });
                }
            });

            let results = Array.from(combinedMap.values())
                .sort((a, b) => (
                    (b.combinedScore - a.combinedScore) ||
                    ((b.vectorScore || 0) - (a.vectorScore || 0)) ||
                    ((b.keywordScore || 0) - (a.keywordScore || 0)) ||
                    ((a.id || 0) - (b.id || 0))
                ))
                .slice(0, k);

            if (config.cohere.rerankingEnabled && config.cohere.apiKey && results.length > 0) {
                try {
                    const RerankerService = require('./reranker.service');
                    const reranked = await this._runWithTimeout(
                        () => RerankerService.rerank(
                            query,
                            results.map(r => r.text),
                            k
                        ),
                        this.rerankTimeoutMs,
                        'Rerank timeout'
                    );
                    results = reranked.map(rr => {
                        const original = results[rr.index];
                        return {
                            ...original,
                            combinedScore: rr.relevance_score,
                            reranked: true
                        };
                    });
                } catch (rerankErr) {
                    Logger.warn('Reranking failed, using hybrid scores:', rerankErr.message);
                }
            }

            return results;
        } catch (error) {
            Logger.error('Error in hybrid search:', error);
            return this.searchKeyword(instanceId, query, k);
        }
    }

    _calculateWeights(query) {
        const queryLength = query.split(/\s+/).length;
        const hasSpecialChars = /[^\w\sа-яё]/i.test(query);
        const hasNumbers = /\d/.test(query);

        if (hasNumbers || hasSpecialChars || queryLength <= 3) {
            return { keyword: 0.6, vector: 0.4 };
        }
        return { keyword: 0.3, vector: 0.7 };
    }

    async transformQuery(query, instanceId) {
        try {
            const AIService = require('./ai.service');
            const instance = await DB.getInstance(instanceId);
            if (!instance) return null;

            const hydePrompt = [
                { role: 'system', content: 'Напиши краткий ответ на вопрос (2-3 предложения). Это для поисковой системы, пиши фактами из контекста бизнеса.' },
                { role: 'user', content: query }
            ];

            const hypotheticalAnswer = await AIService._callProviderPlain(hydePrompt, instance);
            return hypotheticalAnswer || null;
        } catch (e) {
            Logger.warn('HyDE transformQuery error:', e.message);
            return null;
        }
    }

    async runSearchPipeline(instanceId, query, options = {}) {
        const {
            k = 5,
            searchType = 'hybrid',
            applyThreshold = false,
            usedByAI = false
        } = options;

        const startTime = Date.now();
        let results;
        if (searchType === 'vector') {
            results = await this.searchVector(instanceId, query, k);
        } else if (searchType === 'keyword') {
            results = await this.searchKeyword(instanceId, query, k);
        } else {
            results = await this.searchHybrid(instanceId, query, k);
        }

        const responseTimeMs = Date.now() - startTime;
        const effectiveResults = applyThreshold
            ? results.filter((result) => (result.combinedScore || result.score || 0) >= config.rag.minConfidence)
            : results;

        const avgScore = effectiveResults.length > 0
            ? effectiveResults.reduce((sum, result) => sum + (result.combinedScore || result.score || 0), 0) / effectiveResults.length
            : 0;
        const topScore = effectiveResults[0]?.combinedScore || effectiveResults[0]?.score || 0;
        this._logSearch(instanceId, query, searchType, effectiveResults.length, topScore, avgScore, responseTimeMs, usedByAI && effectiveResults.length > 0);

        return {
            searchType,
            responseTimeMs,
            results,
            effectiveResults
        };
    }

    async search(instanceId, query, k = 3) {
        const { effectiveResults } = await this.runSearchPipeline(instanceId, query, {
            k,
            searchType: 'hybrid',
            applyThreshold: true,
            usedByAI: true
        });

        if (effectiveResults.length === 0) {
            return '';
        }

        return this._buildSearchContext(effectiveResults);
    }

    _selectAnswerChunk(results, question) {
        const ignored = new Set([
            'как', 'какой', 'какие', 'какая', 'есть', 'ли', 'отел', 'отель',
            'отеле', 'можно', 'подскаж', 'пожал', 'скольк', 'этот', 'ваш',
            'наши', 'про', 'можн', 'приеха', 'нужн', 'хот', 'расскаж', 'скаж', 'узна',
        ]);
        const baseTokens = normalizeTokens(question)
            .map((token) => String(token || '').toLowerCase())
            .filter((token) => token.length >= 3 && !ignored.has(token));
        const aliases = {
            заселен: ['заезд'],
            выселя: ['выезд'],
            питомц: ['животн'],
            собак: ['животн'],
            кошк: ['животн'],
            интернет: ['wi-fi', 'wifi'],
            машин: ['парков'],
            автомобил: ['парков'],
            мор: ['пляж', 'берег'],
        };
        const queryTokens = [...new Set([
            ...baseTokens,
            ...baseTokens.flatMap((token) => aliases[token] || []),
        ])];
        const ranked = results.map((result, index) => {
            const haystack = `${result.section || ''} ${result.text || ''}`.toLowerCase();
            const matches = queryTokens.filter((token) => haystack.includes(token));
            const roomCategoryQuestion = queryTokens.includes('категор') && queryTokens.includes('номер');
            const knownCategoryCount = ['стандарт', 'комфорт', 'семей', 'люкс']
                .filter((token) => haystack.includes(token)).length;
            let intentBoost = roomCategoryQuestion && (
                haystack.includes('номерной фонд')
                || haystack.includes('| категория |')
                || knownCategoryCount >= 3
            ) ? 4 : 0;
            const checkInQuestion = queryTokens.includes('заезд') || queryTokens.includes('выезд');
            if (checkInQuestion && (
                haystack.includes('заезд / выезд')
                || (haystack.includes('заезд') && haystack.includes('выезд') && /\b\d{1,2}:\d{2}\b/.test(haystack))
            )) intentBoost += 4;
            return {
                result,
                index,
                lexicalScore: matches.length + intentBoost,
                matchedTokens: matches,
                baseScore: Number(result.combinedScore || result.score || 0),
            };
        }).sort((left, right) => (
            right.lexicalScore - left.lexicalScore
            || right.baseScore - left.baseScore
            || left.index - right.index
        ));
        return ranked[0] || null;
    }

    _expandSearchQuestion(question) {
        const value = String(question || '').toLowerCase().replace(/ё/g, 'е');
        const additions = [];
        if (/заселен|заселя|регистрац.*заезд/.test(value)) additions.push('заезд', 'выезд');
        if (/выселен|выселя/.test(value)) additions.push('выезд', 'заезд');
        if (/питом|домашн.*живот/.test(value)) additions.push('животные', 'размещение с животными');
        if (/собак|кошк/.test(value)) additions.push('животные', 'размещение с животными');
        if (/остав.*машин|автомобил/.test(value)) additions.push('парковка');
        if (/интернет|вай[ -]?фай/.test(value)) additions.push('wi-fi');
        return [...new Set([String(question || '').trim(), ...additions])].filter(Boolean).join(' ');
    }

    _voiceSnippet(selection, maxLength) {
        const raw = String(selection?.result?.text || '');
        const text = raw.replace(/\s+/g, ' ').trim();
        if (!text) return '';
        const categoryQuestion = (selection.matchedTokens || []).includes('категор')
            && (selection.matchedTokens || []).includes('номер');
        if (!categoryQuestion) {
            // Return the matching fact, not an arbitrary 420-character window
            // that can include unrelated prices or operator instructions.
            const facts = raw.split(/\n|(?<=[.!?])\s+(?=[А-ЯЁA-Z])/u)
                .map((line) => line.trim())
                .filter((line) => line && !/^#{1,6}\s|^\|?[\s:|-]+\|?$/.test(line))
                .map((line, index) => ({ line, index, matches: (selection.matchedTokens || [])
                    .filter((token) => line.toLowerCase().includes(token)).length }))
                .filter((fact) => fact.matches > 0 && !/\?[\s*»”"']*$/.test(fact.line))
                .sort((left, right) => right.matches - left.matches || left.index - right.index);
            if (facts.length) {
                const fact = facts[0].line.replace(/^\s*(?:>\s*|[-*]\s+)/, '')
                    .replace(/\*\*|\*/g, '').replace(/^\|\s*|\s*\|$/g, '')
                    .replace(/\s*\|\s*/g, ': ').replace(/\s+/g, ' ').trim();
                return fact.length > maxLength ? `${fact.slice(0, maxLength).trim()}…` : fact;
            }
        }
        const anchor = [...(selection.matchedTokens || [])]
            .sort((left, right) => right.length - left.length)
            .find((token) => text.toLowerCase().includes(token));
        const lowerText = text.toLowerCase();
        const categoryListIndex = lowerText.indexOf('у нас есть стандарт');
        const categoryTableIndex = lowerText.indexOf('| категория |');
        const anchorIndex = categoryQuestion && categoryListIndex >= 0
            ? categoryListIndex
            : categoryQuestion && categoryTableIndex >= 0
                ? categoryTableIndex
                : anchor ? lowerText.indexOf(anchor) : 0;
        const start = anchorIndex > 90 ? Math.max(0, anchorIndex - 70) : 0;
        const snippet = text.slice(start, start + maxLength).trim();
        return `${start > 0 ? '…' : ''}${snippet}${start + maxLength < text.length ? '…' : ''}`;
    }

    async answerFromKnowledge(instanceId, question, options = {}) {
        const safeQuestion = String(question || '').trim();
        if (!safeQuestion) {
            return {
                answer: '',
                spoken: 'Мне нужен конкретный вопрос, чтобы проверить базу знаний.',
                confidence: 0,
                citations: [],
                missing_info: ['question'],
                should_handoff: false,
                requires_manager: false,
                manager_task_created: false
            };
        }

        const k = Math.max(1, Math.min(Number(options.k || 8), 8));
        const searchQuestion = this._expandSearchQuestion(safeQuestion);
        const searchType = options.searchType || 'hybrid';
        let voiceKeyword;
        if (options.channel === 'voice' && searchType === 'hybrid') {
            try {
                // Probe without a search-log row. A positive current fact can
                // avoid the vector wait; a lexical miss cannot prove absence.
                const probe = (await this.searchKeyword(instanceId, searchQuestion, k))
                    .filter(result => (result.combinedScore || result.score || 0) >= config.rag.minConfidence);
                if (probe.length && this._selectAnswerChunk(probe, safeQuestion).matchedTokens.length) {
                    const current = await this.runSearchPipeline(instanceId, searchQuestion, {
                        k, searchType: 'keyword', applyThreshold: true, usedByAI: true
                    });
                    // A source can disappear or lose its topic between reads.
                    // Let the existing hybrid path handle that race as a miss.
                    if (current.effectiveResults.length
                        && this._selectAnswerChunk(current.effectiveResults, safeQuestion).matchedTokens.length) voiceKeyword = current;
                }
            } catch (_) { /* Optional fast lookup must not disable hybrid retrieval. */ }
        }
        const { effectiveResults, responseTimeMs } = voiceKeyword || await this.runSearchPipeline(instanceId, searchQuestion, {
            k,
            searchType,
            applyThreshold: true,
            usedByAI: true
        });

        if (!effectiveResults.length) {
            return {
                answer: 'В базе знаний нет точного ответа на этот вопрос.',
                spoken: 'В базе знаний нет точного ответа на этот вопрос. Уточните формулировку, и я попробую проверить ещё раз.',
                confidence: 0,
                citations: [],
                missing_info: [safeQuestion],
                should_handoff: false,
                requires_manager: false,
                manager_task_created: false,
                response_time_ms: responseTimeMs
            };
        }

        const selection = this._selectAnswerChunk(effectiveResults, safeQuestion);
        const top = selection.result;
        const score = Number(top.combinedScore || top.score || 0);
        // Hybrid/RRF scores rank candidates; even a high score does not prove
        // the document answers this question. Extractive fallback needs an
        // informative lexical anchor (including the explicit FAQ synonyms).
        if (selection.matchedTokens.length === 0) {
            return {
                answer: 'В базе знаний нет точного ответа на этот вопрос.',
                spoken: 'В базе знаний нет точного ответа на этот вопрос. Уточните формулировку, и я попробую проверить ещё раз.',
                confidence: 0,
                citations: [],
                missing_info: [safeQuestion],
                should_handoff: false,
                requires_manager: false,
                manager_task_created: false,
                response_time_ms: responseTimeMs,
            };
        }
        const snippet = this._voiceSnippet(selection, options.channel === 'voice' ? 420 : 650);
        const answer = snippet || 'Нашел релевантную информацию в базе знаний.';
        const citationResults = [top, ...effectiveResults.filter((result) => result !== top)].slice(0, 3);
        const citations = citationResults.map((result) => ({
            document_id: String(result.kbId || ''),
            chunk_id: String(result.id || ''),
            score: Number((result.combinedScore || result.score || 0).toFixed
                ? (result.combinedScore || result.score || 0).toFixed(4)
                : (result.combinedScore || result.score || 0)),
            title: result.originalName || 'knowledge_base',
            section: result.section || null
        }));

        return {
            answer,
            spoken: answer,
            confidence: Math.max(0, Math.min(1, score)),
            citations,
            missing_info: [],
            should_handoff: false,
            requires_manager: false,
            manager_task_created: false,
            response_time_ms: responseTimeMs
        };
    }

    _logSearch(instanceId, query, searchType, resultsCount, topScore, avgScore, responseTimeMs, wasUsedByAI = false) {
        try {
            DB.logRAGSearch(instanceId, query, searchType, resultsCount, topScore, avgScore, responseTimeMs, wasUsedByAI);
        } catch (e) { }
    }

    stemTokens(tokens) {
        if (!Array.isArray(tokens) || tokens.length === 0) return [];
        return normalizeTokens(tokens.join(' '));
    }

    async rebuildEmbeddings(instanceId) {
        try {
            Logger.info(`Rebuilding embeddings for instance ${instanceId}...`);

            const chunks = DB.getChunksForRebuild(instanceId);

            if (chunks.length === 0) {
                return { success: true, rebuilt: 0, message: 'No chunks to rebuild' };
            }

            const gemini = GeminiEmbeddings.selected(instanceId);
            try {
                if (!gemini) {
                DB.run(`
                    DELETE FROM kb_chunks_vec
                    WHERE chunkId IN (
                        SELECT c.id
                        FROM kb_chunks c
                        JOIN knowledge_base k ON k.id = c.kbId
                        WHERE k.instanceId = ? AND k.isCurrent = 1
                    )
                `, [instanceId]);
                }
            } catch (error) {
                Logger.warn('Failed to clear existing instance vectors before rebuild:', error.message);
            }

            const chunksWithEmbeddings = await this.generateEmbeddings(chunks, instanceId);

            let vectorCount = 0;
            for (const chunk of chunksWithEmbeddings) {
                if (chunk.embedding) {
                    const doc = DB.get('SELECT id, originalName, instanceId FROM knowledge_base WHERE id = ?', [chunk.kbId]);
                    if (doc) {
                        const added = chunk.embeddingProvider === 'gemini' ? GeminiEmbeddings.store(chunk, instanceId)
                            : DB.addChunkToVectorTable(chunk.id, chunk.kbId, doc.instanceId, chunk.embedding, doc.originalName);
                        if (added) vectorCount++;
                        this._recalculateStats(instanceId, chunk.kbId);
                    }
                }
            }

            Logger.success(`Rebuilt ${vectorCount} embeddings for instance ${instanceId}`);
            return { success: true, rebuilt: vectorCount };

        } catch (error) {
            Logger.error('Error rebuilding embeddings:', error);
            return { success: false, error: error.message };
        }
    }

    async migrateEmbeddings(requestedDimensions = 0) {
        try {
            this.embeddingsInitialized = false;
            this.embeddingsAvailable = false;
            await this.initEmbeddings();

            if (!this.embeddingsAvailable || !this.embeddingDimensions) {
                throw new Error('Embeddings provider is not available for migration');
            }

            if (requestedDimensions && Number(requestedDimensions) !== Number(this.embeddingDimensions)) {
                throw new Error(`Requested dimensions ${requestedDimensions} do not match provider output ${this.embeddingDimensions}`);
            }

            const recreated = await DB.recreateVectorTable(this.embeddingDimensions);
            if (!recreated) {
                throw new Error('Failed to recreate vector table');
            }

            const docs = DB.getAllCurrentKnowledgeBaseDocuments();
            let rebuilt = 0;

            for (const doc of docs) {
                const chunks = DB.getChunksForKnowledgeBase(doc.id);
                if (chunks.length === 0) {
                    DB.updateKnowledgeBaseStats(doc.id, 0, false);
                    continue;
                }

                // This administrative migration changes only the legacy vector space.
                if (GeminiEmbeddings.selected(doc.instanceId)) continue;
                const chunksWithEmbeddings = await this.generateEmbeddings(chunks, doc.instanceId);
                let vectorCount = 0;
                for (const chunk of chunksWithEmbeddings) {
                    if (!chunk.embedding) continue;
                    const added = DB.addChunkToVectorTable(chunk.id, doc.id, doc.instanceId, chunk.embedding, doc.originalName);
                    if (added) {
                        vectorCount++;
                        rebuilt++;
                    }
                }

                DB.updateKnowledgeBaseStats(doc.id, chunks.length, chunks.length > 0 && vectorCount >= chunks.length);
            }

            this._checkVectorSearchAvailable();
            return {
                success: true,
                dimensions: this.embeddingDimensions,
                documentsReindexed: docs.length,
                rebuilt
            };
        } catch (error) {
            Logger.error('Error migrating embeddings:', error);
            return { success: false, error: error.message };
        }
    }

    async getStats(instanceId) {
        const docs = await DB.getKnowledgeBaseFiles(instanceId);
        const totalChunks = DB.all(`
            SELECT COUNT(*) as count FROM kb_chunks c
            JOIN knowledge_base k ON c.kbId = k.id
            WHERE k.instanceId = ? AND k.isCurrent = 1
        `, [instanceId])[0]?.count || 0;

        const gemini = GeminiEmbeddings.selected(instanceId);
        let chunksWithEmbeddings = 0;
        try {
            chunksWithEmbeddings = gemini ? GeminiEmbeddings.count(instanceId) : DB.all(`
                SELECT COUNT(*) as count FROM kb_chunks_vec v
                JOIN kb_chunks c ON c.id = v.chunkId
                JOIN knowledge_base k ON c.kbId = k.id
                WHERE k.instanceId = ? AND k.isCurrent = 1
            `, [instanceId])[0]?.count || 0;
        } catch (e) {
            chunksWithEmbeddings = 0;
        }

        const searchAnalytics = DB.getRAGSearchAnalytics(instanceId);
        const vectorTableDimensions = gemini ? GeminiEmbeddings.DIMENSIONS : DB.getVectorTableDimensions();
        const embeddingDimensions = gemini ? GeminiEmbeddings.DIMENSIONS : (this.embeddingDimensions || vectorTableDimensions || config.embeddings.dimensions || 0);
        const embeddingsAvailable = gemini ? require('./gemini-text.service').configured() : (this.embeddingsAvailable || (!this.embeddingsInitialized && Boolean(config.embeddings.apiKey)));

        return {
            totalDocuments: docs.length,
            totalChunks,
            chunksWithEmbeddings,
            embeddingsCoverage: totalChunks > 0 ? Math.round((chunksWithEmbeddings / totalChunks) * 100) : 0,
            vectorSearchAvailable: gemini ? chunksWithEmbeddings > 0 : (this.vectorSearchAvailable || vectorTableDimensions > 0),
            embeddingsAvailable,
            embeddingDimensions,
            searchAnalytics
        };
    }

    async getDocumentChunks(instanceId, kbId) {
        return DB.getDocumentChunks(instanceId, kbId);
    }

    _queueNativeKnowledge(instanceId, kbId) {
        try { return NativeKnowledge.enqueue(instanceId, kbId); }
        catch (error) {
            const code = ['ONYX_NOT_CONFIGURED', 'DOCUMENT_EMPTY', 'DOCUMENT_SYNC_IN_PROGRESS'].includes(error?.code)
                ? error.code : 'KNOWLEDGE_UNAVAILABLE';
            return { state: code === 'DOCUMENT_EMPTY' ? 'empty' : code === 'ONYX_NOT_CONFIGURED'
                ? 'unavailable' : 'needs_sync', queued: false, code };
        }
    }

    _recalculateStats(instanceId, kbId) {
        if (!GeminiEmbeddings.selected(instanceId)) return DB.recalculateKnowledgeBaseStats(kbId);
        const chunks = DB.getChunksForKnowledgeBase(kbId);
        const indexed = GeminiEmbeddings.count(instanceId, kbId);
        return DB.updateKnowledgeBaseStats(kbId, chunks.length, chunks.length > 0 && indexed >= chunks.length);
    }

    async deleteChunk(instanceId, chunkId) {
        const chunk = DB.deleteChunkById(instanceId, chunkId);
        if (!chunk) {
            throw new Error('Chunk not found for this instance');
        }
        this._recalculateStats(instanceId, chunk.kbId);
        return { success: true, kbId: chunk.kbId, nativeSync: this._queueNativeKnowledge(instanceId, chunk.kbId) };
    }

    async updateChunk(instanceId, chunkId, text, section, options = {}) {
        if (typeof text !== 'string' || !text.trim() || text.length > 10000
            || (section != null && (typeof section !== 'string' || section.length > 200))
            || !options || typeof options !== 'object' || Array.isArray(options)
            || (options.expectedHash !== undefined && (typeof options.expectedHash !== 'string'
                || !/^[a-f0-9]{32,64}$/.test(options.expectedHash)))
            || (options.beforeWrite !== undefined && typeof options.beforeWrite !== 'function')) {
            throw Object.assign(new Error('INVALID_CHUNK'), { code: 'INVALID_CHUNK', statusCode: 400 });
        }
        const chunk = DB.getChunkById(instanceId, chunkId);
        if (!chunk) {
            throw Object.assign(new Error('Chunk not found for this instance'), { code: 'CHUNK_NOT_FOUND', statusCode: 404 });
        }
        // NativeKnowledge uses only generateEmbeddings/_queueNativeKnowledge/
        // _recalculateStats from this service, never updateChunk: no recursion.
        const saved = await NativeKnowledge.updateChunk(instanceId, chunk.kbId, chunkId,
            { text, section: section || null, expectedHash: options.expectedHash },
            { beforeWrite: options.beforeWrite });
        return { success: true, kbId: chunk.kbId, nativeSync: saved.sync };
    }
}

module.exports = new RAGService();
