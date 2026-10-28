const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const Logger = require('../utils/logger');
const { VALID_STATUSES, BUSINESS_TYPES, resolveBusinessType } = require('../utils/constants');
const { normalizeSearchText } = require('../utils/rag-normalizer');
const ChannelCredentials = require('./channel-credentials');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../crm_v2.db');
const UNFINISHED_SEQUENCE_STATUSES = Object.freeze(['active', 'paused', 'delivery_failed']);
const SEQUENCE_STEPS_LOCKED_CODE = 'sequence_has_unfinished_enrollments';

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function normalizeText(value, limit = 220) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3)).trim()}...` : text;
}

function uniqueTextList(values, limit = 12, itemLimit = 220) {
    const list = Array.isArray(values) ? values : [values];
    const seen = new Set();
    const result = [];
    for (const value of list) {
        const text = normalizeText(value, itemLimit);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(text);
        if (result.length >= limit) break;
    }
    return result;
}

function ensureObject(value) {
    const parsed = parseJson(value, null);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function mergeProfileRawJson(existingRaw, incomingRaw) {
    if (incomingRaw === undefined) return existingRaw;

    const existing = ensureObject(existingRaw);
    const incoming = ensureObject(incomingRaw);

    if (!Object.keys(existing).length && !Object.keys(incoming).length) {
        return incomingRaw || existingRaw || null;
    }

    const merged = { ...existing, ...incoming };
    merged.keyFacts = uniqueTextList([
        ...(Array.isArray(existing.keyFacts) ? existing.keyFacts : []),
        ...(Array.isArray(existing.memoryFacts) ? existing.memoryFacts : []),
        ...(Array.isArray(incoming.keyFacts) ? incoming.keyFacts : []),
        ...(Array.isArray(incoming.memoryFacts) ? incoming.memoryFacts : []),
    ], 12, 180);
    merged.importantDates = uniqueTextList([
        ...(Array.isArray(existing.importantDates) ? existing.importantDates : []),
        ...(Array.isArray(incoming.importantDates) ? incoming.importantDates : []),
    ], 8, 120);
    merged.interestSignals = uniqueTextList([
        ...(Array.isArray(existing.interestSignals) ? existing.interestSignals : []),
        ...(Array.isArray(existing.interests) ? existing.interests : []),
        ...(Array.isArray(incoming.interestSignals) ? incoming.interestSignals : []),
        ...(Array.isArray(incoming.interests) ? incoming.interests : []),
    ], 10, 140);
    merged.callSummaries = uniqueTextList([
        ...(Array.isArray(existing.callSummaries) ? existing.callSummaries : []),
        ...(Array.isArray(incoming.callSummaries) ? incoming.callSummaries : []),
        incoming.lastCallSummary || null,
        existing.lastCallSummary || null,
    ], 5, 220);

    if (incoming.lastCallSummary) {
        merged.lastCallSummary = normalizeText(incoming.lastCallSummary, 220);
    } else if (existing.lastCallSummary) {
        merged.lastCallSummary = normalizeText(existing.lastCallSummary, 220);
    }

    merged.lastCallAt = incoming.lastCallAt || existing.lastCallAt || null;
    merged.callCount = Math.max(
        0,
        Number(existing.callCount || 0) + Number(incoming.callCountIncrement || 0),
        Number(incoming.callCount || 0),
        Number(existing.callCount || 0),
    );
    delete merged.callCountIncrement;

    return JSON.stringify(merged);
}

function sequenceStepsLockedError(count) {
    const error = new Error(SEQUENCE_STEPS_LOCKED_CODE);
    error.code = SEQUENCE_STEPS_LOCKED_CODE;
    error.statusCode = 409;
    error.unfinishedEnrollmentCount = count;
    return error;
}

class DatabaseService {
    constructor() {
        this.db = null;
    }

    async init() {
        try {
            this.db = new Database(DB_PATH);
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('foreign_keys = ON');
            
            // Load sqlite-vec extension for vector similarity search
            try {
                const sqliteVec = require('sqlite-vec');
                sqliteVec.load(this.db);
                Logger.success('sqlite-vec extension loaded successfully');
            } catch (vecError) {
                Logger.warn('sqlite-vec not available, vector search will be disabled:', vecError.message);
            }
            
            this.createTables();
            this.ensureColumns();
            this.migrateRagSchema(); // New migration for RAG vectors
            this.createSalesBrainTables();
            this.createPmsTables();
            this.createTwentyTables();
            this.createOnyxTables();
            this.createProvisioningTables();
            require('./telephony/store').ensureSchema();
            this.createBusinessGptTables();
            require('./instagram.service').ensureSchema();
            Logger.success('БД инициализирована успешно');
        } catch (err) {
            Logger.error('Ошибка подключения к БД:', err);
            throw err;
        }
    }

    run(sql, params = []) {
        return this.db.prepare(sql).run(...params);
    }

    createBusinessGptTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS customer_business_gpt_chats (
                id TEXT PRIMARY KEY,
                business_id INTEGER NOT NULL,
                user_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT 'Новый диалог',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_business_gpt_chats_owner
                ON customer_business_gpt_chats (business_id, user_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS customer_business_gpt_turns (
                id TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL REFERENCES customer_business_gpt_chats(id) ON DELETE CASCADE,
                business_id INTEGER NOT NULL,
                user_id TEXT NOT NULL,
                request_id TEXT NOT NULL,
                question TEXT NOT NULL,
                answer TEXT NOT NULL,
                citations_json TEXT NOT NULL,
                source_timestamp TEXT NOT NULL,
                correlation_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(chat_id, request_id)
            );
            CREATE INDEX IF NOT EXISTS idx_business_gpt_turns_chat
                ON customer_business_gpt_turns (chat_id, created_at, id);
        `);
    }

    get(sql, params = []) {
        return this.db.prepare(sql).get(...params);
    }

    all(sql, params = []) {
        return this.db.prepare(sql).all(...params) || [];
    }

    _id(prefix) {
        const fallback = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        return `${prefix}_${crypto.randomUUID ? crypto.randomUUID() : fallback}`;
    }

    backfillChunkSearchText() {
        try {
            const rows = this.all(`
                SELECT id, text
                FROM kb_chunks
                WHERE searchText IS NULL OR TRIM(searchText) = ''
            `);

            if (rows.length === 0) return 0;

            const stmt = this.db.prepare('UPDATE kb_chunks SET searchText = ? WHERE id = ?');
            const transaction = this.db.transaction((chunks) => {
                for (const chunk of chunks) {
                    stmt.run(normalizeSearchText(chunk.text), chunk.id);
                }
            });

            transaction(rows);
            Logger.info(`Backfilled searchText for ${rows.length} kb chunk(s)`);
            return rows.length;
        } catch (error) {
            Logger.warn('Failed to backfill searchText:', error.message);
            return 0;
        }
    }

    ensureChunkSearchIndex() {
        try {
            const existing = this.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='kb_chunks_fts'");
            const needsRecreate = !existing || !existing.sql || !existing.sql.includes('searchText');

            this._dropChunkSearchTriggers();

            if (needsRecreate) {
                this.db.exec('DROP TABLE IF EXISTS kb_chunks_fts');
            }

            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
                    searchText,
                    tokenize='unicode61 remove_diacritics 0'
                )
            `);

            this.db.exec(`
                CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
                    INSERT INTO kb_chunks_fts(rowid, searchText)
                    VALUES (new.id, COALESCE(new.searchText, ''));
                END
            `);
            this.db.exec(`
                CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
                    DELETE FROM kb_chunks_fts WHERE rowid = old.id;
                END
            `);
            this.db.exec(`
                CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
                    DELETE FROM kb_chunks_fts WHERE rowid = old.id;
                    INSERT INTO kb_chunks_fts(rowid, searchText)
                    VALUES (new.id, COALESCE(new.searchText, ''));
                END
            `);

            this.rebuildChunkSearchIndex();
            Logger.success('kb_chunks_fts search index verified');
            return true;
        } catch (error) {
            Logger.warn('FTS5 migration:', error.message);
            return false;
        }
    }

    rebuildChunkSearchIndex() {
        try {
            this.db.exec('DELETE FROM kb_chunks_fts');
            const rows = this.all('SELECT id, searchText FROM kb_chunks ORDER BY id ASC');
            if (rows.length > 0) {
                const stmt = this.db.prepare('INSERT INTO kb_chunks_fts(rowid, searchText) VALUES (?, ?)');
                const transaction = this.db.transaction((chunks) => {
                    for (const chunk of chunks) {
                        stmt.run(chunk.id, chunk.searchText || '');
                    }
                });
                transaction(rows);
            }
            return true;
        } catch (error) {
            Logger.warn('Failed to rebuild kb_chunks_fts:', error.message);
            return false;
        }
    }

    _dropChunkSearchTriggers() {
        const triggerNames = ['kb_chunks_ai', 'kb_chunks_ad', 'kb_chunks_au'];
        for (const triggerName of triggerNames) {
            try {
                this.db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
            } catch (error) {
                Logger.warn(`Failed to drop trigger ${triggerName}:`, error.message);
            }
        }
    }

    getVectorTableDimensions() {
        try {
            const existing = this.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='kb_chunks_vec'");
            const match = existing?.sql?.match(/float\[(\d+)\]/);
            return match ? parseInt(match[1], 10) : 0;
        } catch (error) {
            return 0;
        }
    }

    createTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS instances (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                greenApiInstance TEXT,
                greenApiToken TEXT,
                greenApiUrl TEXT DEFAULT 'https://api.green-api.com',

                whatsappProvider TEXT DEFAULT 'openwa',
                openWaUrl TEXT DEFAULT 'http://localhost:2785',
                openWaApiKey TEXT,
                openWaSessionId TEXT,
                openWaStatus TEXT,

                aiProvider TEXT DEFAULT 'yandex',
                geminiModel TEXT,
                voiceAiProvider TEXT,
                voiceName TEXT,
                voiceModel TEXT,
                voiceSettings TEXT DEFAULT '{}',
                openRouterKey TEXT,
                openRouterModel TEXT,
                yandexGptKey TEXT,
                yandexGptFolderId TEXT,
                yandexGptModelUri TEXT,
                aiTemperature TEXT DEFAULT '0.3',
                aiResponseFormat TEXT DEFAULT 'text',
                
                systemPrompt TEXT,
                
                yclientsLink TEXT,
                yclientsCompanyId TEXT,
                yclientsFormId TEXT,
                
                crmIntegration TEXT DEFAULT 'none',
                amoCrmDomain TEXT,
                amoCrmAccessToken TEXT,
                bitrix24WebhookUrl TEXT,
                
                followUpEnabled INTEGER DEFAULT 0,
                followUpDelay TEXT DEFAULT '48',
                followUpText TEXT DEFAULT 'Добрый день! Остались ли у вас вопросы? Буду рад помочь 😊',
                
                isActive INTEGER DEFAULT 1,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS clients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                chatId TEXT NOT NULL,
                senderName TEXT NOT NULL,
                assigneeUserId TEXT,
                leadStatus TEXT DEFAULT 'new',
                lastMessage TEXT,
                lastMessageTime TEXT,
                crmContactId TEXT,
                crmLeadId TEXT,
                tags TEXT DEFAULT '[]',
                lastStatusChangeAt TEXT DEFAULT CURRENT_TIMESTAMP,
                followUpSentAt TEXT,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(instanceId, chatId),
                FOREIGN KEY(instanceId) REFERENCES instances(id)
            )
        `);

        // Index for faster queries
        try {
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_clients_instance_updated ON clients(instanceId, updatedAt DESC)');
        } catch (e) { /* ignore if exists */ }

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                chatId TEXT NOT NULL,
                senderName TEXT NOT NULL,
                messageType TEXT,
                content TEXT,
                role TEXT,
                aiThought TEXT,
                timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(instanceId) REFERENCES instances(id)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS lead_status_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                chatId TEXT NOT NULL,
                fromStatus TEXT,
                toStatus TEXT NOT NULL,
                reason TEXT,
                changedBy TEXT DEFAULT 'ai',
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(instanceId) REFERENCES instances(id)
            )
        `);

        // Quick reply templates
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                label TEXT NOT NULL,
                text TEXT NOT NULL,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(instanceId) REFERENCES instances(id)
            )
        `);

        // Web Push subscriptions
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER,
                endpoint TEXT NOT NULL UNIQUE,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // --- NEW TABLES: Personalization + Triggers + Sequences + Channels ---

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS client_profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                chatId TEXT NOT NULL,
                needs TEXT,
                budget TEXT,
                objections TEXT,
                interests TEXT DEFAULT '[]',
                communicationStyle TEXT DEFAULT 'casual',
                decisionSpeed TEXT DEFAULT 'medium',
                preferredChannel TEXT DEFAULT 'whatsapp',
                language TEXT DEFAULT 'ru',
                timezone TEXT,
                sentimentScore REAL DEFAULT 0.5,
                conversionProbability REAL DEFAULT 0,
                lastProfileUpdate TEXT,
                rawProfileJson TEXT,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(instanceId, chatId),
                FOREIGN KEY(instanceId) REFERENCES instances(id)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS optimal_contact_times (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                chatId TEXT NOT NULL,
                dayOfWeek INTEGER NOT NULL,
                hourSlot INTEGER NOT NULL,
                responseCount INTEGER DEFAULT 0,
                avgResponseTimeSec REAL DEFAULT 0,
                UNIQUE(instanceId, chatId, dayOfWeek, hourSlot),
                FOREIGN KEY(instanceId) REFERENCES instances(id)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS smart_triggers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                name TEXT NOT NULL,
                isActive INTEGER DEFAULT 1,
                triggerType TEXT NOT NULL,
                conditions TEXT DEFAULT '{}',
                actionType TEXT NOT NULL,
                actionData TEXT DEFAULT '{}',
                priority INTEGER DEFAULT 0,
                maxExecutions INTEGER DEFAULT 0,
                cooldownMinutes INTEGER DEFAULT 60,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(instanceId) REFERENCES instances(id)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS trigger_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                chatId TEXT NOT NULL,
                triggerId INTEGER NOT NULL,
                triggerType TEXT,
                actionType TEXT,
                details TEXT DEFAULT '{}',
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(instanceId) REFERENCES instances(id),
                FOREIGN KEY(triggerId) REFERENCES smart_triggers(id)
            )
        `);

        // One durable claim per source occurrence, independent of cooldown (which may be zero).
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS trigger_occurrences (
                instanceId INTEGER NOT NULL,
                triggerId INTEGER NOT NULL,
                chatId TEXT NOT NULL,
                sourceKey TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'pending',
                leaseToken TEXT,
                leaseExpiresAt TEXT,
                completedAt TEXT,
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (instanceId, triggerId, chatId, sourceKey),
                FOREIGN KEY(instanceId) REFERENCES instances(id),
                FOREIGN KEY(triggerId) REFERENCES smart_triggers(id)
            )
        `);
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_trigger_occurrences_created ON trigger_occurrences(createdAt)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_lead_status_history_instance_created ON lead_status_history(instanceId, createdAt)');
        // Existing rules have no occurrence keys for actions already fired by
        // the old poller. Fence only upgraded databases with existing rules so
        // widening the scan to 24 hours cannot replay their old messages.
        this.db.exec(`CREATE TABLE IF NOT EXISTS trigger_occurrence_meta (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            scanNotBefore TEXT NOT NULL
        )`);
        const existingRules = this.db.prepare('SELECT COUNT(*) AS count FROM smart_triggers').get().count;
        this.db.prepare('INSERT OR IGNORE INTO trigger_occurrence_meta (id, scanNotBefore) VALUES (1, ?)')
            .run(existingRules > 0 ? new Date().toISOString() : '1970-01-01T00:00:00.000Z');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS message_sequences (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                targetSegment TEXT DEFAULT '{}',
                isActive INTEGER DEFAULT 1,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(instanceId) REFERENCES instances(id)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sequence_steps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sequenceId INTEGER NOT NULL,
                stepOrder INTEGER NOT NULL,
                delayMinutes INTEGER DEFAULT 60,
                messageTemplate TEXT NOT NULL,
                useAiPersonalization INTEGER DEFAULT 0,
                channelOverride TEXT,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(sequenceId) REFERENCES message_sequences(id) ON DELETE CASCADE
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS client_sequences (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                chatId TEXT NOT NULL,
                sequenceId INTEGER NOT NULL,
                currentStep INTEGER DEFAULT 0,
                status TEXT DEFAULT 'active',
                nextStepAt TEXT,
                startedAt TEXT DEFAULT CURRENT_TIMESTAMP,
                completedAt TEXT,
                deliveryAttemptAt TEXT,
                deliveryFailureCode TEXT,
                deliveryFailureChannel TEXT,
                deliveryFailureStep INTEGER,
                FOREIGN KEY(instanceId) REFERENCES instances(id),
                FOREIGN KEY(sequenceId) REFERENCES message_sequences(id)
            )
        `);

        try {
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_trigger_log_instance ON trigger_log(instanceId, createdAt DESC)');
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_trigger_log_chat ON trigger_log(instanceId, chatId, triggerId)');
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_client_sequences_active ON client_sequences(status, nextStepAt)');
        } catch (e) { /* ignore if exists */ }

        // ==========================================
        // CREATE KNOWLEDGE BASE TABLES (RAG)
        // ==========================================
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS knowledge_base (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                filename TEXT NOT NULL,
                originalName TEXT NOT NULL,
                contentHash TEXT,
                mimeType TEXT,
                fileSize INTEGER,
                chunkCount INTEGER DEFAULT 0,
                hasEmbeddings INTEGER DEFAULT 0,
                version INTEGER DEFAULT 1,
                isCurrent INTEGER DEFAULT 1,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (instanceId) REFERENCES instances (id) ON DELETE CASCADE
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS kb_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kbId INTEGER NOT NULL,
                chunkIndex INTEGER NOT NULL,
                text TEXT NOT NULL,
                searchText TEXT,
                section TEXT,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (kbId) REFERENCES knowledge_base (id) ON DELETE CASCADE
            )
        `);

        const config = require('../config');
        const EMBEDDING_DIM = config.embeddings.dimensions || 0;

        if (EMBEDDING_DIM > 0) {
            try {
                this.db.exec(`
                    CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_vec USING vec0(
                        instanceId INTEGER PARTITION KEY,
                        embedding float[${EMBEDDING_DIM}],
                        +chunkId INTEGER,
                        +kbId INTEGER,
                        +originalName TEXT
                    )
                `);
                Logger.success(`kb_chunks_vec virtual table created/verified (float[${EMBEDDING_DIM}], PARTITION KEY=instanceId)`);
            } catch (vecError) {
                Logger.warn('Could not create vec0 table (sqlite-vec may not be loaded):', vecError.message);
            }
        } else {
            Logger.info('EMBEDDINGS_DIMENSIONS not set, vec table will be created after auto-detect');
            try {
                const existing = this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='kb_chunks_vec'");
                if (!existing) {
                    Logger.info('No kb_chunks_vec table exists yet, will be created on first embedding init');
                }
            } catch (e) {}
        }

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS rag_search_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                query TEXT NOT NULL,
                searchType TEXT,
                resultsCount INTEGER,
                topScore REAL,
                avgScore REAL,
                responseTimeMs INTEGER,
                wasUsedByAI INTEGER DEFAULT 0,
                clientFeedback TEXT,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);

        try {
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_rag_search_log_instance ON rag_search_log(instanceId, createdAt DESC)');
        } catch (e) { }

        // ==========================================
        // CREATE PAYMENTS TABLE
        // ==========================================
                this.db.exec(`
            CREATE TABLE IF NOT EXISTS payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                paymentId TEXT NOT NULL UNIQUE,
                instanceId INTEGER NOT NULL,
                chatId TEXT NOT NULL,
                amount REAL NOT NULL,
                status TEXT DEFAULT 'pending',
                description TEXT,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (instanceId) REFERENCES instances (id) ON DELETE CASCADE
            )
        `);

        // ==========================================
        // CREATE ORDERS TABLE (Barista Bot)
        // ==========================================
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                chatId TEXT NOT NULL,
                clientName TEXT,
                orderSummary TEXT NOT NULL,
                pickupTime TEXT,
                status TEXT DEFAULT 'new',
                baristaChatId TEXT,
                baristaName TEXT,
                telegramMessageIds TEXT DEFAULT '[]',
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                acceptedAt TEXT,
                readyAt TEXT,
                completedAt TEXT,
                feedbackSentAt TEXT,
                FOREIGN KEY (instanceId) REFERENCES instances (id) ON DELETE CASCADE
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS order_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                orderId INTEGER NOT NULL,
                instanceId INTEGER NOT NULL,
                chatId TEXT NOT NULL,
                itemName TEXT NOT NULL,
                quantity INTEGER DEFAULT 1,
                category TEXT,
                modifiers TEXT DEFAULT '[]',
                unitPrice REAL,
                confidence REAL,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (orderId) REFERENCES orders (id) ON DELETE CASCADE,
                FOREIGN KEY (instanceId) REFERENCES instances (id) ON DELETE CASCADE
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS coffee_stop_list (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                itemName TEXT NOT NULL,
                reason TEXT,
                addedBy TEXT,
                isActive INTEGER DEFAULT 1,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (instanceId) REFERENCES instances (id) ON DELETE CASCADE
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS coffee_feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                chatId TEXT NOT NULL,
                orderId INTEGER,
                sentiment TEXT DEFAULT 'neutral',
                text TEXT NOT NULL,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (instanceId) REFERENCES instances (id) ON DELETE CASCADE,
                FOREIGN KEY (orderId) REFERENCES orders (id) ON DELETE SET NULL
            )
        `);

        // ==========================================
        // CREATE BARISTA STAFF TABLE
        // ==========================================
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS barista_staff (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                telegramChatId TEXT NOT NULL,
                name TEXT NOT NULL,
                isActive INTEGER DEFAULT 1,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(instanceId, telegramChatId),
                FOREIGN KEY (instanceId) REFERENCES instances (id) ON DELETE CASCADE
            )
        `);
    }

    createSalesBrainTables() {
        require('./crm-memory-store.service').initSchema(this.db);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS conversation_events (
                eventId TEXT PRIMARY KEY,
                instanceId INTEGER NOT NULL,
                chatId TEXT,
                customerId TEXT,
                channel TEXT NOT NULL,
                direction TEXT DEFAULT 'inbound',
                role TEXT DEFAULT 'system',
                content TEXT,
                callId TEXT,
                sourceId TEXT,
                metadataJson TEXT DEFAULT '{}',
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(instanceId) REFERENCES instances(id)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ml_decisions (
                decisionId TEXT PRIMARY KEY,
                instanceId INTEGER NOT NULL,
                chatId TEXT,
                customerId TEXT,
                taskType TEXT NOT NULL,
                model TEXT,
                promptVersion TEXT,
                inputRefsJson TEXT DEFAULT '[]',
                outputJson TEXT DEFAULT '{}',
                confidence REAL,
                latencyMs INTEGER DEFAULT 0,
                costJson TEXT DEFAULT '{}',
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(instanceId) REFERENCES instances(id)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS tool_runs (
                toolRunId TEXT PRIMARY KEY,
                instanceId INTEGER NOT NULL,
                chatId TEXT,
                customerId TEXT,
                callId TEXT,
                conversationEventId TEXT,
                toolName TEXT NOT NULL,
                phase TEXT DEFAULT 'chat',
                argsRedactedJson TEXT DEFAULT '{}',
                resultRedactedJson TEXT DEFAULT '{}',
                status TEXT DEFAULT 'ok',
                latencyMs INTEGER DEFAULT 0,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(instanceId) REFERENCES instances(id)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS customer_identity_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER NOT NULL,
                customerId TEXT NOT NULL,
                chatId TEXT,
                normalizedPhone TEXT,
                linkType TEXT NOT NULL,
                confidence TEXT NOT NULL,
                evidenceJson TEXT DEFAULT '{}',
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(instanceId, linkType, normalizedPhone),
                FOREIGN KEY(instanceId) REFERENCES instances(id)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS prompt_templates (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                taskType TEXT NOT NULL,
                channel TEXT DEFAULT 'any',
                version TEXT NOT NULL,
                body TEXT NOT NULL,
                status TEXT DEFAULT 'active',
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS prompt_bindings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instanceId INTEGER,
                contextId TEXT,
                taskType TEXT NOT NULL,
                promptTemplateId TEXT NOT NULL,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(promptTemplateId) REFERENCES prompt_templates(id)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS prompt_evaluations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                promptTemplateId TEXT NOT NULL,
                score REAL,
                failureReasonsJson TEXT DEFAULT '[]',
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(promptTemplateId) REFERENCES prompt_templates(id)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS outbound_campaigns (
                campaignId TEXT PRIMARY KEY,
                instanceId INTEGER NOT NULL,
                name TEXT NOT NULL,
                sourceFilterJson TEXT DEFAULT '{}',
                contextId TEXT NOT NULL DEFAULT 'unified_sales_agent',
                timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
                callWindowJson TEXT DEFAULT '{}',
                maxAttempts INTEGER NOT NULL DEFAULT 3,
                retryPolicyJson TEXT DEFAULT '{}',
                postCallActionJson TEXT DEFAULT '{}',
                enabled INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'draft',
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(instanceId) REFERENCES instances(id)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS outbound_leads (
                leadId TEXT PRIMARY KEY,
                campaignId TEXT NOT NULL,
                instanceId INTEGER NOT NULL,
                chatId TEXT,
                customerId TEXT,
                phone TEXT NOT NULL,
                name TEXT,
                sourceJson TEXT DEFAULT '{}',
                customVarsJson TEXT DEFAULT '{}',
                state TEXT NOT NULL DEFAULT 'pending',
                doNotCall INTEGER NOT NULL DEFAULT 0,
                attemptCount INTEGER NOT NULL DEFAULT 0,
                nextAttemptAt TEXT,
                lastAttemptAt TEXT,
                lastOutcome TEXT,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(campaignId, phone),
                FOREIGN KEY(campaignId) REFERENCES outbound_campaigns(campaignId)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS outbound_attempts (
                attemptId TEXT PRIMARY KEY,
                campaignId TEXT NOT NULL,
                leadId TEXT,
                instanceId INTEGER NOT NULL,
                callId TEXT,
                phone TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'created',
                outcome TEXT,
                startedAt TEXT DEFAULT CURRENT_TIMESTAMP,
                endedAt TEXT,
                durationSec INTEGER,
                errorMessage TEXT,
                metadataJson TEXT DEFAULT '{}',
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(campaignId) REFERENCES outbound_campaigns(campaignId),
                FOREIGN KEY(leadId) REFERENCES outbound_leads(leadId)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS manager_tasks (
                taskId TEXT PRIMARY KEY,
                instanceId INTEGER NOT NULL,
                chatId TEXT,
                customerId TEXT,
                callId TEXT,
                phone TEXT,
                customerName TEXT,
                summary TEXT NOT NULL,
                reason TEXT NOT NULL DEFAULT 'manual',
                priority TEXT NOT NULL DEFAULT 'normal',
                status TEXT NOT NULL DEFAULT 'new',
                source TEXT NOT NULL DEFAULT 'sales_brain',
                assignee TEXT,
                assigneeUserId TEXT,
                dueAt TEXT,
                createdByUserId TEXT,
                conversationEventId TEXT,
                resolutionNote TEXT,
                metadataJson TEXT DEFAULT '{}',
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
                closedAt TEXT,
                FOREIGN KEY(instanceId) REFERENCES instances(id)
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS followup_drafts (
                draftId TEXT PRIMARY KEY,
                instanceId INTEGER NOT NULL,
                chatId TEXT,
                customerId TEXT,
                callId TEXT,
                managerTaskId TEXT,
                phone TEXT,
                originalText TEXT NOT NULL DEFAULT '',
                text TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'draft',
                source TEXT NOT NULL DEFAULT 'sales_brain',
                conversationEventId TEXT,
                approvedBy TEXT,
                approvedAt TEXT,
                editedBy TEXT,
                editedAt TEXT,
                sentAt TEXT,
                failureReason TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                metadataJson TEXT DEFAULT '{}',
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(instanceId) REFERENCES instances(id)
            )
        `);

        // Onyx AI Integration Tables (Stages 2, 3, 4, 7, 8, 9)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS onyx_tenant_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                business_id INTEGER NOT NULL UNIQUE,
                onyx_tenant_id TEXT NOT NULL,
                onyx_base_url TEXT NOT NULL,
                credential_ref TEXT,
                cc_pair_id INTEGER,
                onyx_version TEXT,
                readiness_json TEXT DEFAULT '{}',
                schema_version TEXT DEFAULT '1.0',
                status TEXT DEFAULT 'active',
                last_health_at TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(business_id) REFERENCES instances(id) ON DELETE CASCADE
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS onyx_document_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                business_id INTEGER NOT NULL,
                entity_type TEXT NOT NULL,
                source_id INTEGER NOT NULL,
                onyx_document_id TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                last_synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(business_id, entity_type, source_id),
                FOREIGN KEY(business_id) REFERENCES instances(id) ON DELETE CASCADE
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS onyx_sync_outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                business_id INTEGER NOT NULL,
                entity_type TEXT NOT NULL,
                source_id INTEGER NOT NULL,
                operation TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                status TEXT DEFAULT 'PENDING',
                attempts INTEGER DEFAULT 0,
                next_attempt_at TEXT DEFAULT CURRENT_TIMESTAMP,
                lease_token TEXT,
                leased_until TEXT,
                last_error_code TEXT,
                last_error TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(business_id) REFERENCES instances(id) ON DELETE CASCADE
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS onyx_action_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                business_id INTEGER NOT NULL,
                user_id TEXT,
                agent_id TEXT NOT NULL,
                action TEXT NOT NULL,
                arguments_hash TEXT NOT NULL,
                status TEXT NOT NULL,
                result_hash TEXT,
                payload_json TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(business_id) REFERENCES instances(id) ON DELETE CASCADE
            )
        `);

        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_conversation_events_customer ON conversation_events(instanceId, chatId, createdAt DESC);
            CREATE INDEX IF NOT EXISTS idx_conversation_events_call ON conversation_events(callId);
            CREATE INDEX IF NOT EXISTS idx_ml_decisions_customer ON ml_decisions(instanceId, chatId, createdAt DESC);
            CREATE INDEX IF NOT EXISTS idx_tool_runs_customer ON tool_runs(instanceId, chatId, createdAt DESC);
            CREATE INDEX IF NOT EXISTS idx_identity_phone ON customer_identity_links(instanceId, normalizedPhone);
            CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_instance ON outbound_campaigns(instanceId, status, enabled);
            CREATE INDEX IF NOT EXISTS idx_onyx_sync_outbox_status ON onyx_sync_outbox(status, next_attempt_at);
            CREATE INDEX IF NOT EXISTS idx_onyx_document_links_lookup ON onyx_document_links(business_id, entity_type, source_id);
            CREATE INDEX IF NOT EXISTS idx_onyx_action_audit_business ON onyx_action_audit(business_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_outbound_leads_campaign_state ON outbound_leads(campaignId, state, nextAttemptAt);
            CREATE INDEX IF NOT EXISTS idx_outbound_leads_phone ON outbound_leads(instanceId, phone);
            CREATE INDEX IF NOT EXISTS idx_outbound_attempts_campaign ON outbound_attempts(campaignId, startedAt DESC);
            CREATE INDEX IF NOT EXISTS idx_outbound_attempts_call ON outbound_attempts(callId);
            CREATE INDEX IF NOT EXISTS idx_manager_tasks_instance_status ON manager_tasks(instanceId, status, createdAt DESC);
            CREATE INDEX IF NOT EXISTS idx_manager_tasks_call ON manager_tasks(instanceId, callId);
            CREATE INDEX IF NOT EXISTS idx_manager_tasks_phone ON manager_tasks(instanceId, phone);
            CREATE INDEX IF NOT EXISTS idx_followup_drafts_instance_status ON followup_drafts(instanceId, status, createdAt DESC);
            CREATE INDEX IF NOT EXISTS idx_followup_drafts_call ON followup_drafts(instanceId, callId);
            CREATE INDEX IF NOT EXISTS idx_followup_drafts_chat ON followup_drafts(instanceId, chatId, createdAt DESC);
            CREATE INDEX IF NOT EXISTS idx_followup_drafts_task ON followup_drafts(instanceId, managerTaskId);
        `);
        this.createSalesWorkspaceTables();
    }

    createSalesWorkspaceTables() {
        // Additive and repeatable for legacy databases; stable IDs never come
        // from display names, phone suffixes, or legacy assignee labels.
        this.db.transaction(() => {
            const tables = new Set(this.all("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name));
            for (const [table, additions] of [
                ['clients', [['assigneeUserId', 'TEXT']]],
                ['manager_tasks', [['assigneeUserId', 'TEXT'], ['dueAt', 'TEXT'], ['createdByUserId', 'TEXT']]],
            ]) {
                if (!tables.has(table)) continue;
                const columns = new Set(this.all(`PRAGMA table_info(${table})`).map(row => row.name));
                for (const [name, type] of additions) {
                    if (!columns.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
                }
            }
            this.db.exec(`CREATE TABLE IF NOT EXISTS sales_workspace_schema_migrations (
                version TEXT PRIMARY KEY, appliedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`);
            if (tables.has('clients')) this.db.exec(`CREATE INDEX IF NOT EXISTS idx_clients_assignee
                ON clients(instanceId, assigneeUserId, updatedAt DESC)`);
            if (tables.has('manager_tasks')) this.db.exec(`CREATE INDEX IF NOT EXISTS idx_manager_tasks_assignee
                ON manager_tasks(instanceId, assigneeUserId, status, dueAt)`);

            // Identity tables can be initialized later than sales at startup.
            // Defer until present, then record this once so revoked/released
            // assignments are never resurrected by a subsequent restart.
            const version = 'legacy_manager_task_assignment_v1';
            if (!tables.has('manager_tasks') || !tables.has('ava_users') || !tables.has('ava_business_memberships')
                || this.get('SELECT 1 FROM sales_workspace_schema_migrations WHERE version=?', [version])) return;
            this.run(`UPDATE manager_tasks SET assigneeUserId=assignee
                WHERE assigneeUserId IS NULL AND assignee IS NOT NULL AND assignee!=''
                  AND EXISTS (SELECT 1 FROM ava_users u
                    JOIN ava_business_memberships m ON m.userId=u.id
                    JOIN instances i ON i.id=m.businessId
                    WHERE u.id=manager_tasks.assignee AND u.enabled=1 AND m.enabled=1 AND i.isActive=1
                      AND m.businessId=manager_tasks.instanceId
                      AND m.role IN ('hotel_owner','sales_lead','manager'))`);
            this.run('INSERT INTO sales_workspace_schema_migrations(version) VALUES (?)', [version]);
        }).immediate();
    }

    createPmsTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS pms_integrations (
                id TEXT PRIMARY KEY,
                businessId INTEGER NOT NULL,
                provider TEXT NOT NULL DEFAULT 'bnovo',
                enabled INTEGER NOT NULL DEFAULT 0,
                mode TEXT NOT NULL DEFAULT 'read_only',
                externalHotelId TEXT,
                accountIdMasked TEXT,
                credentialsEncrypted TEXT NOT NULL,
                currency TEXT NOT NULL DEFAULT 'RUB',
                mappingsJson TEXT NOT NULL DEFAULT '{}',
                webhookTokenHash TEXT,
                webhookTokenEncrypted TEXT,
                webhookSubscriberId TEXT,
                connectionStatus TEXT NOT NULL DEFAULT 'not_tested',
                pollingStatus TEXT NOT NULL DEFAULT 'idle',
                webhookStatus TEXT NOT NULL DEFAULT 'not_configured',
                lastSyncAt TEXT,
                lastSuccessfulAvailabilityAt TEXT,
                lastWebhookAt TEXT,
                lastErrorCode TEXT,
                lastErrorMessage TEXT,
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(businessId, provider),
                UNIQUE(provider, externalHotelId),
                FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS pms_bookings (
                id TEXT PRIMARY KEY,
                businessId INTEGER NOT NULL,
                provider TEXT NOT NULL,
                externalBookingId TEXT NOT NULL,
                externalHotelId TEXT,
                bookingNumber TEXT,
                statusCode TEXT,
                statusName TEXT,
                arrivalAt TEXT,
                departureAt TEXT,
                roomTypeId TEXT,
                roomTypeName TEXT,
                tariffId TEXT,
                tariffName TEXT,
                amount REAL,
                currency TEXT NOT NULL DEFAULT 'RUB',
                customerName TEXT,
                customerSurname TEXT,
                normalizedPhone TEXT,
                normalizedEmail TEXT,
                sourceUpdatedAt TEXT,
                sourceTimestamp TEXT NOT NULL,
                rawSafeJson TEXT NOT NULL DEFAULT '{}',
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(businessId, provider, externalBookingId),
                FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS pms_booking_guests (
                id TEXT PRIMARY KEY,
                businessId INTEGER NOT NULL,
                bookingId TEXT NOT NULL,
                externalGuestId TEXT,
                name TEXT,
                surname TEXT,
                normalizedPhone TEXT,
                normalizedEmail TEXT,
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(businessId, bookingId, externalGuestId),
                FOREIGN KEY(bookingId) REFERENCES pms_bookings(id) ON DELETE CASCADE,
                FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS pms_booking_requests (
                id TEXT PRIMARY KEY,
                businessId INTEGER NOT NULL,
                provider TEXT NOT NULL DEFAULT 'bnovo',
                idempotencyKey TEXT NOT NULL,
                channel TEXT NOT NULL,
                callId TEXT,
                messageBatchId TEXT,
                chatId TEXT,
                customerId TEXT,
                callerNumber TEXT,
                customerName TEXT,
                arrivalDate TEXT,
                departureDate TEXT,
                adults INTEGER NOT NULL DEFAULT 1,
                children INTEGER NOT NULL DEFAULT 0,
                roomTypeId TEXT,
                roomTypeName TEXT,
                tariffId TEXT,
                tariffName TEXT,
                quotedTotal REAL,
                currency TEXT NOT NULL DEFAULT 'RUB',
                status TEXT NOT NULL DEFAULT 'new',
                managerTaskId TEXT,
                detailsJson TEXT NOT NULL DEFAULT '{}',
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(businessId, idempotencyKey),
                FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS pms_sync_jobs (
                id TEXT PRIMARY KEY,
                businessId INTEGER NOT NULL,
                provider TEXT NOT NULL DEFAULT 'bnovo',
                jobType TEXT NOT NULL,
                dedupeKey TEXT,
                payloadJson TEXT NOT NULL DEFAULT '{}',
                state TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                maxAttempts INTEGER NOT NULL DEFAULT 8,
                nextAttemptAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                leaseToken TEXT,
                leaseExpiresAt TEXT,
                lastErrorCode TEXT,
                lastErrorMessage TEXT,
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completedAt TEXT,
                UNIQUE(businessId, provider, dedupeKey),
                FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS pms_audit_events (
                id TEXT PRIMARY KEY,
                businessId INTEGER NOT NULL,
                provider TEXT NOT NULL DEFAULT 'bnovo',
                correlationId TEXT,
                eventType TEXT NOT NULL,
                operation TEXT,
                status TEXT NOT NULL,
                httpStatus INTEGER,
                latencyMs INTEGER,
                errorCode TEXT,
                message TEXT,
                metadataJson TEXT NOT NULL DEFAULT '{}',
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_pms_integrations_business ON pms_integrations(businessId, provider);
            CREATE INDEX IF NOT EXISTS idx_pms_bookings_phone ON pms_bookings(businessId, normalizedPhone, arrivalAt);
            CREATE INDEX IF NOT EXISTS idx_pms_bookings_number ON pms_bookings(businessId, bookingNumber);
            CREATE INDEX IF NOT EXISTS idx_pms_bookings_dates ON pms_bookings(businessId, arrivalAt, departureAt);
            CREATE INDEX IF NOT EXISTS idx_pms_booking_requests_status ON pms_booking_requests(businessId, status, createdAt DESC);
            CREATE INDEX IF NOT EXISTS idx_pms_jobs_due ON pms_sync_jobs(state, nextAttemptAt, leaseExpiresAt);
            CREATE INDEX IF NOT EXISTS idx_pms_audit_business ON pms_audit_events(businessId, createdAt DESC);
        `);
    }

    createTwentyTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS twenty_workspace_links (
                id TEXT PRIMARY KEY,
                businessId INTEGER NOT NULL UNIQUE,
                workspaceId TEXT UNIQUE,
                baseUrl TEXT NOT NULL,
                apiKeyEncrypted TEXT NOT NULL,
                webhookSecretEncrypted TEXT,
                webhookTokenHash TEXT UNIQUE,
                webhookTokenEncrypted TEXT,
                enabled INTEGER NOT NULL DEFAULT 0,
                mode TEXT NOT NULL DEFAULT 'shadow',
                connectionStatus TEXT NOT NULL DEFAULT 'not_tested',
                mappingsJson TEXT NOT NULL DEFAULT '{}',
                lastSyncAt TEXT,
                lastSuccessAt TEXT,
                lastWebhookAt TEXT,
                lastErrorCode TEXT,
                lastErrorMessage TEXT,
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE,
                CHECK(mode IN ('shadow', 'live'))
            );

            CREATE TABLE IF NOT EXISTS twenty_record_links (
                id TEXT PRIMARY KEY,
                businessId INTEGER NOT NULL,
                entityType TEXT NOT NULL,
                sourceTable TEXT NOT NULL,
                sourceId TEXT NOT NULL,
                twentyObject TEXT NOT NULL,
                twentyRecordId TEXT NOT NULL,
                sourceHash TEXT,
                lastSyncedAt TEXT,
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(businessId, sourceTable, sourceId),
                UNIQUE(businessId, twentyObject, twentyRecordId),
                FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS twenty_sync_outbox (
                eventId TEXT PRIMARY KEY,
                businessId INTEGER NOT NULL,
                entityType TEXT NOT NULL,
                sourceTable TEXT NOT NULL,
                sourceId TEXT NOT NULL,
                operation TEXT NOT NULL DEFAULT 'upsert',
                payloadJson TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'PENDING',
                attempts INTEGER NOT NULL DEFAULT 0,
                nextAttemptAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                leaseToken TEXT,
                leasedUntil TEXT,
                lastErrorCode TEXT,
                lastErrorMessage TEXT,
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS twenty_bootstrap_events (
                eventId TEXT PRIMARY KEY,
                businessId INTEGER NOT NULL,
                workspaceId TEXT NOT NULL,
                revision INTEGER NOT NULL,
                verifiedAt TEXT,
                FOREIGN KEY(eventId) REFERENCES twenty_sync_outbox(eventId) ON DELETE CASCADE,
                FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS twenty_webhook_inbox (
                id TEXT PRIMARY KEY,
                deliveryId TEXT NOT NULL UNIQUE,
                businessId INTEGER NOT NULL,
                workspaceId TEXT,
                eventType TEXT NOT NULL,
                twentyObject TEXT NOT NULL,
                twentyRecordId TEXT,
                payloadJson TEXT NOT NULL,
                payloadHash TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'PENDING',
                attempts INTEGER NOT NULL DEFAULT 0,
                nextAttemptAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                leaseToken TEXT,
                leasedUntil TEXT,
                lastErrorCode TEXT,
                lastErrorMessage TEXT,
                receivedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                processedAt TEXT,
                FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS twenty_audit_events (
                id TEXT PRIMARY KEY,
                businessId INTEGER NOT NULL,
                direction TEXT NOT NULL,
                action TEXT NOT NULL,
                entityType TEXT,
                sourceId TEXT,
                twentyRecordId TEXT,
                status TEXT NOT NULL,
                correlationId TEXT,
                detailJson TEXT NOT NULL DEFAULT '{}',
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_twenty_outbox_due
                ON twenty_sync_outbox(status, nextAttemptAt, businessId);
            CREATE INDEX IF NOT EXISTS idx_twenty_outbox_source
                ON twenty_sync_outbox(businessId, sourceTable, sourceId, createdAt DESC);
            CREATE INDEX IF NOT EXISTS idx_twenty_inbox_due
                ON twenty_webhook_inbox(status, nextAttemptAt, businessId);
            CREATE INDEX IF NOT EXISTS idx_twenty_audit_business
                ON twenty_audit_events(businessId, createdAt DESC);
        `);

        const triggerSpecs = [
            ['instances', 'id', 'id', 'hotel'],
            ['clients', 'instanceId', 'id', 'person'],
            ['manager_tasks', 'instanceId', 'taskId', 'manager_task'],
            ['followup_drafts', 'instanceId', 'draftId', 'followup_draft'],
            ['outbound_campaigns', 'instanceId', 'campaignId', 'outbound_campaign'],
            ['outbound_leads', 'instanceId', 'leadId', 'outbound_lead'],
            ['outbound_attempts', 'instanceId', 'attemptId', 'outbound_attempt'],
            ['pms_booking_requests', 'businessId', 'id', 'booking_request'],
        ];
        for (const [table, businessColumn, idColumn, entityType] of triggerSpecs) {
            for (const action of ['INSERT', 'UPDATE']) {
                const suffix = action === 'INSERT' ? 'ai' : 'au';
                const triggerName = `twenty_${table}_${suffix}`;
                this.db.exec(`
                    CREATE TRIGGER IF NOT EXISTS ${triggerName}
                    AFTER ${action} ON ${table}
                    WHEN EXISTS (
                        SELECT 1 FROM twenty_workspace_links
                        WHERE businessId = NEW.${businessColumn} AND enabled = 1
                    )
                    BEGIN
                        INSERT INTO twenty_sync_outbox (
                            eventId, businessId, entityType, sourceTable, sourceId,
                            operation, payloadJson, status, nextAttemptAt
                        ) VALUES (
                            'twout_' || lower(hex(randomblob(16))),
                            NEW.${businessColumn}, '${entityType}', '${table}',
                            CAST(NEW.${idColumn} AS TEXT), 'upsert',
                            json_object('source_table', '${table}', 'source_id', CAST(NEW.${idColumn} AS TEXT)),
                            'PENDING', CURRENT_TIMESTAMP
                        );
                    END;
                `);
            }
        }

        const twentyColumns = new Set(this.db.prepare('PRAGMA table_info(twenty_workspace_links)').all().map(row => row.name));
        if (!twentyColumns.has('revision')) this.db.exec('ALTER TABLE twenty_workspace_links ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
        const inboxColumns = new Set(this.db.prepare('PRAGMA table_info(twenty_webhook_inbox)').all().map(row => row.name));
        if (!inboxColumns.has('integrationRevision')) this.db.exec('ALTER TABLE twenty_webhook_inbox ADD COLUMN integrationRevision INTEGER');
        // Old queued payloads cannot prove which connection authenticated them.
        // Preserve them for diagnosis, but never attach them to a new key/link.
        this.db.exec(`UPDATE twenty_webhook_inbox SET status='DEAD',leaseToken=NULL,leasedUntil=NULL,
            lastErrorCode='TWENTY_WEBHOOK_LEGACY_REVERIFICATION_REQUIRED'
            WHERE integrationRevision IS NULL AND status IN ('PENDING','LEASED')`);
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS twenty_configuration_revision
            AFTER UPDATE OF baseUrl,workspaceId,apiKeyEncrypted,webhookSecretEncrypted,webhookTokenEncrypted,enabled,mode,mappingsJson
            ON twenty_workspace_links
            WHEN OLD.baseUrl IS NOT NEW.baseUrl OR OLD.workspaceId IS NOT NEW.workspaceId
              OR OLD.apiKeyEncrypted IS NOT NEW.apiKeyEncrypted
              OR OLD.webhookSecretEncrypted IS NOT NEW.webhookSecretEncrypted
              OR OLD.webhookTokenEncrypted IS NOT NEW.webhookTokenEncrypted
              OR OLD.enabled IS NOT NEW.enabled OR OLD.mode IS NOT NEW.mode
              OR OLD.mappingsJson IS NOT NEW.mappingsJson
            BEGIN
              UPDATE twenty_workspace_links SET revision=revision+1 WHERE businessId=NEW.businessId;
            END`);
        require('./twenty/twenty-crypto').migrateLegacyCredentials(this.db);

        // Repair the obsolete status written by the first Twenty adapter.
        // Restrict this to linked rows; ordinary/unlinked task data is untouched.
        this.db.exec(`
            UPDATE manager_tasks SET status='done',
                closedAt=COALESCE(closedAt,CURRENT_TIMESTAMP),updatedAt=CURRENT_TIMESTAMP
            WHERE status='closed' AND EXISTS (
                SELECT 1 FROM twenty_record_links
                WHERE businessId=manager_tasks.instanceId
                  AND sourceTable='manager_tasks' AND sourceId=manager_tasks.taskId
            )
        `);

        this.db.exec(`
            CREATE TRIGGER IF NOT EXISTS twenty_conversation_events_ai
            AFTER INSERT ON conversation_events
            WHEN NEW.callId IS NOT NULL AND TRIM(NEW.callId) <> '' AND EXISTS (
                SELECT 1 FROM twenty_workspace_links
                WHERE businessId = NEW.instanceId AND enabled = 1
            )
            BEGIN
                INSERT INTO twenty_sync_outbox (
                    eventId, businessId, entityType, sourceTable, sourceId,
                    operation, payloadJson, status, nextAttemptAt
                ) VALUES (
                    'twout_' || lower(hex(randomblob(16))),
                    NEW.instanceId, 'call', 'conversation_events', NEW.callId,
                    'upsert', json_object('source_table', 'conversation_events', 'source_id', NEW.callId),
                    'PENDING', CURRENT_TIMESTAMP
                );
            END;
        `);
    }

    createOnyxTables() {
        require('./onyx/onyx-credentials').ensureSchema();
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS onyx_tenant_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                business_id INTEGER NOT NULL UNIQUE,
                onyx_tenant_id TEXT NOT NULL,
                onyx_base_url TEXT NOT NULL,
                credential_ref TEXT,
                cc_pair_id INTEGER,
                onyx_version TEXT,
                readiness_json TEXT DEFAULT '{}',
                schema_version TEXT DEFAULT '1.0',
                status TEXT DEFAULT 'active',
                last_health_at TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(business_id) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS onyx_document_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                business_id INTEGER NOT NULL,
                entity_type TEXT NOT NULL,
                source_id INTEGER NOT NULL,
                onyx_document_id TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                last_synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(business_id, entity_type, source_id),
                FOREIGN KEY(business_id) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS onyx_sync_outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                business_id INTEGER NOT NULL,
                entity_type TEXT NOT NULL,
                source_id INTEGER NOT NULL,
                operation TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                status TEXT DEFAULT 'PENDING',
                attempts INTEGER DEFAULT 0,
                next_attempt_at TEXT DEFAULT CURRENT_TIMESTAMP,
                lease_token TEXT,
                leased_until TEXT,
                last_error_code TEXT,
                last_error TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(business_id) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS onyx_action_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                business_id INTEGER NOT NULL,
                user_id TEXT,
                agent_id TEXT NOT NULL,
                action TEXT NOT NULL,
                arguments_hash TEXT NOT NULL,
                status TEXT NOT NULL,
                result_hash TEXT,
                payload_json TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(business_id) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS onyx_action_approvals (
                token_hash TEXT PRIMARY KEY,
                business_id INTEGER NOT NULL,
                agent_id TEXT NOT NULL,
                action TEXT NOT NULL,
                arguments_hash TEXT NOT NULL,
                approved_by TEXT NOT NULL,
                expires_at REAL NOT NULL,
                consumed_event_id TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS onyx_agent_bindings (
                business_id INTEGER NOT NULL REFERENCES instances(id),
                role TEXT NOT NULL CHECK(role IN ('sales','manager','revenue')),
                onyx_base_url TEXT NOT NULL,
                persona_id INTEGER NOT NULL,
                document_set_id INTEGER NOT NULL,
                document_set_name TEXT NOT NULL,
                model_configuration_id INTEGER NOT NULL,
                search_tool_id INTEGER NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(business_id,role),
                UNIQUE(onyx_base_url,persona_id)
            );

            CREATE TABLE IF NOT EXISTS onyx_mcp_discovery_credentials (
                id INTEGER PRIMARY KEY CHECK(id=1),
                token_hash TEXT NOT NULL,
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS onyx_mcp_execution_scopes (
                token_hash TEXT PRIMARY KEY,
                discovery_hash TEXT NOT NULL,
                business_id INTEGER NOT NULL REFERENCES instances(id),
                agent_role TEXT NOT NULL,
                channel TEXT NOT NULL,
                correlation_id TEXT NOT NULL,
                customer_id INTEGER,
                actor_id TEXT NOT NULL,
                expires_at REAL NOT NULL,
                revoked_at REAL,
                calls_used INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS onyx_mcp_action_links (
                token_hash TEXT NOT NULL REFERENCES onyx_mcp_execution_scopes(token_hash) ON DELETE CASCADE,
                event_id TEXT NOT NULL REFERENCES onyx_action_audit(event_id),
                business_id INTEGER NOT NULL,
                action TEXT NOT NULL,
                created_at REAL NOT NULL,
                PRIMARY KEY(token_hash,event_id)
            );

            CREATE TABLE IF NOT EXISTS onyx_mcp_tool_bindings (
                business_id INTEGER NOT NULL REFERENCES instances(id),
                agent_role TEXT NOT NULL,
                onyx_base_url TEXT NOT NULL,
                mcp_server_id INTEGER NOT NULL,
                tool_name TEXT NOT NULL,
                tool_id INTEGER NOT NULL,
                PRIMARY KEY(business_id,agent_role,tool_name)
            );

            CREATE TABLE IF NOT EXISTS onyx_llm_credentials (
                business_id INTEGER PRIMARY KEY REFERENCES instances(id),
                token_hash TEXT NOT NULL UNIQUE,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS onyx_llm_requests (
                request_id TEXT PRIMARY KEY,
                business_id INTEGER NOT NULL REFERENCES instances(id),
                started_at INTEGER NOT NULL,
                finished_at INTEGER,
                lease_until INTEGER NOT NULL,
                status TEXT NOT NULL,
                error_code TEXT,
                prompt_tokens INTEGER,
                completion_tokens INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_onyx_sync_outbox_status ON onyx_sync_outbox(status, next_attempt_at);
            CREATE INDEX IF NOT EXISTS idx_onyx_document_links_lookup ON onyx_document_links(business_id, entity_type, source_id);
            CREATE INDEX IF NOT EXISTS idx_onyx_action_audit_business ON onyx_action_audit(business_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_onyx_mcp_scope_expiry ON onyx_mcp_execution_scopes(expires_at);
            CREATE INDEX IF NOT EXISTS idx_onyx_llm_budget ON onyx_llm_requests(business_id, started_at);
        `);
        const columns = new Set(this.db.prepare('PRAGMA table_info(onyx_tenant_links)').all().map(row => row.name));
        if (!columns.has('revision')) this.db.exec('ALTER TABLE onyx_tenant_links ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
        this.db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_onyx_private_pair_owner
                ON onyx_tenant_links(onyx_base_url,cc_pair_id) WHERE cc_pair_id IS NOT NULL AND cc_pair_id>0;
            CREATE TRIGGER IF NOT EXISTS onyx_link_configuration_revision
            AFTER UPDATE OF onyx_base_url,credential_ref,cc_pair_id,onyx_version,status ON onyx_tenant_links
            WHEN OLD.onyx_base_url IS NOT NEW.onyx_base_url OR OLD.credential_ref IS NOT NEW.credential_ref
              OR OLD.cc_pair_id IS NOT NEW.cc_pair_id OR OLD.onyx_version IS NOT NEW.onyx_version
              OR (NEW.status='DISABLED' AND OLD.status!='DISABLED')
            BEGIN
              UPDATE onyx_tenant_links SET revision=revision+1,readiness_json='{}',last_health_at=NULL
              WHERE business_id=NEW.business_id;
            END;
            CREATE TRIGGER IF NOT EXISTS onyx_credential_link_revision
            AFTER UPDATE OF token_encrypted,enabled ON onyx_tenant_credentials
            WHEN OLD.token_encrypted IS NOT NEW.token_encrypted OR OLD.enabled IS NOT NEW.enabled
            BEGIN
              UPDATE onyx_tenant_links SET revision=revision+1,readiness_json='{}',last_health_at=NULL
              WHERE business_id=NEW.business_id AND credential_ref=NEW.env_ref;
            END;
            CREATE TRIGGER IF NOT EXISTS onyx_credential_delete_revision
            AFTER DELETE ON onyx_tenant_credentials
            BEGIN
              UPDATE onyx_tenant_links SET revision=revision+1,readiness_json='{}',last_health_at=NULL
              WHERE business_id=OLD.business_id AND credential_ref=OLD.env_ref;
            END;
        `);
    }

    createProvisioningTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ava_business_routes (
                businessId INTEGER PRIMARY KEY REFERENCES instances(id),
                slug TEXT NOT NULL UNIQUE,
                createdAt INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ava_module_deployments (
                id TEXT PRIMARY KEY,
                businessId INTEGER REFERENCES instances(id),
                module TEXT NOT NULL CHECK(module IN ('twenty','onyx')),
                hostname TEXT UNIQUE,
                namespace TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL DEFAULT 'requested' CHECK(state IN
                    ('requested','reserved','provisioning','verified','capacity_required','disabled','failed','quarantined')),
                revision INTEGER NOT NULL DEFAULT 1,
                reservedMemoryMiB INTEGER NOT NULL DEFAULT 0 CHECK(reservedMemoryMiB>=0),
                sourceCommit TEXT,
                imageDigest TEXT,
                secretReference TEXT,
                leaseToken TEXT,
                leasedUntil INTEGER,
                attempts INTEGER NOT NULL DEFAULT 0,
                nextRetryAt INTEGER,
                lastVerifiedAt INTEGER,
                lastErrorCode TEXT,
                correlationId TEXT NOT NULL,
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL,
                UNIQUE(businessId,module)
            );
            CREATE INDEX IF NOT EXISTS ava_module_deployments_due
                ON ava_module_deployments(state,nextRetryAt,leasedUntil);
            CREATE TABLE IF NOT EXISTS business_provisioning_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                businessId INTEGER NOT NULL,
                module TEXT NOT NULL,
                stage TEXT NOT NULL DEFAULT 'init',
                status TEXT NOT NULL DEFAULT 'PENDING',
                leaseToken TEXT,
                leasedUntil TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                maxAttempts INTEGER NOT NULL DEFAULT 5,
                nextAttemptAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                backoffSeconds INTEGER NOT NULL DEFAULT 5,
                checkpointJson TEXT NOT NULL DEFAULT '{}',
                dependsOnModule TEXT,
                lastErrorCode TEXT,
                lastErrorMessage TEXT,
                userNextStep TEXT,
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(businessId, module),
                FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE,
                CHECK(status IN ('PENDING', 'LEASED', 'DONE', 'FAILED', 'BLOCKED', 'SKIPPED'))
            );

            CREATE TABLE IF NOT EXISTS business_idempotency_keys (
                idempotencyKey TEXT PRIMARY KEY,
                businessId INTEGER NOT NULL,
                requestHash TEXT NOT NULL,
                responseJson TEXT,
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS business_sip_aliases (
                alias TEXT PRIMARY KEY,
                businessId INTEGER NOT NULL,
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_provisioning_jobs_due
                ON business_provisioning_jobs(status, nextAttemptAt, businessId);
            CREATE INDEX IF NOT EXISTS idx_provisioning_jobs_business
                ON business_provisioning_jobs(businessId, module);
            CREATE INDEX IF NOT EXISTS idx_business_sip_aliases_biz
                ON business_sip_aliases(businessId);
        `);

        // Backfill active business_sip_aliases from existing active instances if table is empty
        try {
            const countRow = this.get('SELECT COUNT(*) AS total FROM business_sip_aliases');
            if (!countRow || Number(countRow.total || 0) === 0) {
                const rows = this.all("SELECT id, sipAliases FROM instances WHERE isActive = 1 AND sipAliases IS NOT NULL AND sipAliases != '' AND sipAliases != '[]'");
                for (const row of rows) {
                    let aliases = [];
                    try {
                        const parsed = JSON.parse(row.sipAliases);
                        if (Array.isArray(parsed)) aliases = parsed;
                    } catch (_) {}
                    for (const alias of aliases) {
                        const norm = String(alias || '').replace(/\\D+/g, '');
                        if (norm) {
                            try {
                                this.run('INSERT OR IGNORE INTO business_sip_aliases (alias, businessId) VALUES (?, ?)', [norm, row.id]);
                            } catch (_) {}
                        }
                    }
                }
            }
        } catch (_) {}
    }

    ensureColumns() {
        // Older CRM databases predate the fail-closed sequence delivery state.
        const sequenceDeliveryCols = [
            { name: 'deliveryAttemptAt', type: 'TEXT' },
            { name: 'deliveryFailureCode', type: 'TEXT' },
            { name: 'deliveryFailureChannel', type: 'TEXT' },
            { name: 'deliveryFailureStep', type: 'INTEGER' },
        ];
        for (const col of sequenceDeliveryCols) {
            try {
                this.db.exec(`ALTER TABLE client_sequences ADD COLUMN ${col.name} ${col.type}`);
            } catch (e) { /* column already exists */ }
        }
        const instanceCols = [
            { name: 'greenApiUrl', type: "TEXT DEFAULT 'https://api.green-api.com'" },
            { name: 'whatsappProvider', type: "TEXT DEFAULT 'openwa'" },
            { name: 'openWaUrl', type: "TEXT DEFAULT 'http://localhost:2785'" },
            { name: 'openWaApiKey', type: 'TEXT' },
            { name: 'openWaSessionId', type: 'TEXT' },
            { name: 'openWaStatus', type: 'TEXT' },
            { name: 'aiProvider', type: "TEXT DEFAULT 'yandex'" },
            { name: 'geminiModel', type: 'TEXT' },
            { name: 'voiceAiProvider', type: 'TEXT' },
            { name: 'voiceName', type: 'TEXT' },
            { name: 'voiceModel', type: 'TEXT' },
            { name: 'voiceSettings', type: "TEXT DEFAULT '{}'" },
            { name: 'voiceAmbient', type: 'TEXT' },
            { name: 'yandexGptKey', type: 'TEXT' },
            { name: 'yandexGptFolderId', type: 'TEXT' },
            { name: 'yandexGptModelUri', type: 'TEXT' },
            { name: 'aiTemperature', type: "TEXT DEFAULT '0.3'" },
            { name: 'aiResponseFormat', type: "TEXT DEFAULT 'text'" },
            { name: 'systemPrompt', type: 'TEXT' },
            { name: 'crmIntegration', type: "TEXT DEFAULT 'none'" },
            { name: 'amoCrmDomain', type: 'TEXT' },
            { name: 'amoCrmAccessToken', type: 'TEXT' },
            { name: 'bitrix24WebhookUrl', type: 'TEXT' },
            { name: 'yookassaShopId', type: 'TEXT' },
            { name: 'yookassaSecretKey', type: 'TEXT' },
            { name: 'salesGoal', type: "TEXT DEFAULT 'call'" },
            { name: 'businessType', type: "TEXT DEFAULT 'standard'" },
            { name: 'hotelTone', type: 'TEXT' },
            { name: 'hotelTimezone', type: "TEXT DEFAULT 'UTC'" },
            { name: 'hotelWorkingHours', type: 'TEXT' },
            { name: 'sipTrunkNumber', type: 'TEXT' },
            { name: 'sipCallerId', type: 'TEXT' },
            { name: 'sipAliases', type: 'TEXT' },
            { name: 'knowledgeBaseInstanceId', type: 'INTEGER' },
            { name: 'voiceContextName', type: "TEXT DEFAULT 'unified_sales_agent'" },
            { name: 'voiceGreetingTemplate', type: 'TEXT' },
            { name: 'outboundOpenerTemplate', type: 'TEXT' },
            { name: 'coffeeOperationMode', type: "TEXT DEFAULT 'normal'" },
            { name: 'coffeeCafeHours', type: "TEXT DEFAULT '09:00-00:00'" },
            { name: 'coffeeKitchenHours', type: "TEXT DEFAULT '09:00-22:00'" },
            { name: 'coffeePrepTimeMinutes', type: 'INTEGER DEFAULT 15' },
            { name: 'coffeeBusyPrepTimeMinutes', type: 'INTEGER DEFAULT 25' },
            { name: 'coffeeFeedbackDelayMinutes', type: 'INTEGER DEFAULT 90' },
            { name: 'coffeeFeedbackText', type: "TEXT DEFAULT 'Спасибо, что зашли. Всё было хорошо с заказом?'" },
            // Follow-up approval policy: manager-only unless a business opts in.
            { name: 'followupAutoSendEnabled', type: 'INTEGER DEFAULT 0' },
        ];

        for (const col of instanceCols) {
            try {
                this.db.exec(`ALTER TABLE instances ADD COLUMN ${col.name} ${col.type}`);
            } catch (e) { /* column already exists, ignore */ }
        }

        // Keep this migration additive. Updating instances here fires existing
        // Twenty/business triggers and queues unrelated work on startup.
        // VoiceSettings.project reads legacy flat selections lazily; planWrite
        // persists that provider entry during the first normal settings write.

        // Backward compatibility: profiles created before businessType existed
        // already identify coffee shops through the coffee_pickup sales goal.
        this.run(`
            UPDATE instances
            SET businessType = 'coffee_shop'
            WHERE salesGoal = 'coffee_pickup'
              AND COALESCE(businessType, 'standard') != 'coffee_shop'
        `);

        const orderCols = [
            { name: 'pickupTime', type: 'TEXT' },
            { name: 'readyAt', type: 'TEXT' },
            { name: 'feedbackSentAt', type: 'TEXT' },
        ];
        for (const col of orderCols) {
            try {
                this.db.exec(`ALTER TABLE orders ADD COLUMN ${col.name} ${col.type}`);
            } catch (e) { /* column already exists, ignore */ }
        }

        try {
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_orders_instance_status_created ON orders(instanceId, status, createdAt DESC)');
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_orders_client_created ON orders(instanceId, chatId, createdAt DESC)');
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_order_items_instance_item ON order_items(instanceId, itemName)');
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_stop_list_instance_active ON coffee_stop_list(instanceId, isActive)');
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_instance_chat ON coffee_feedback(instanceId, chatId, createdAt DESC)');
        } catch (e) { /* indexes may fail on partial migrations; ignore */ }

        // Ensure aiThought column on messages table (for existing DBs)
        try {
            this.db.exec('ALTER TABLE messages ADD COLUMN aiThought TEXT');
        } catch (e) { /* column already exists, ignore */ }

        // Ensure knowledge_base compatibility columns
        const kbCols = [
            { name: 'business_id', type: 'INTEGER' },
            { name: 'title', type: 'TEXT' },
            { name: 'content', type: 'TEXT' },
        ];
        for (const col of kbCols) {
            try {
                this.db.exec(`ALTER TABLE knowledge_base ADD COLUMN ${col.name} ${col.type}`);
            } catch (e) { /* column already exists, ignore */ }
        }

        // Ensure follow-up columns on instances table
        const followUpCols = [
            { name: 'followUpEnabled', type: 'INTEGER DEFAULT 0' },
            { name: 'followUpDelay', type: "TEXT DEFAULT '48'" },
            { name: 'followUpText', type: "TEXT DEFAULT 'Добрый день! Остались ли у вас вопросы? Буду рад помочь 😊'" },
        ];
        for (const col of followUpCols) {
            try {
                this.db.exec(`ALTER TABLE instances ADD COLUMN ${col.name} ${col.type}`);
            } catch (e) { /* column already exists, ignore */ }
        }

        // Ensure new client columns
        const clientCols = [
            { name: 'tags', type: "TEXT DEFAULT '[]'" },
            { name: 'lastStatusChangeAt', type: 'TEXT' },
            { name: 'followUpSentAt', type: 'TEXT' },
            { name: 'preferredChannel', type: "TEXT DEFAULT 'whatsapp'" },
            { name: 'detectedLanguage', type: "TEXT DEFAULT 'ru'" },
            { name: 'telegramChatId', type: 'TEXT' },
            { name: 'emailAddress', type: 'TEXT' },
        ];
        for (const col of clientCols) {
            try {
                this.db.exec(`ALTER TABLE clients ADD COLUMN ${col.name} ${col.type}`);
            } catch (e) { /* column already exists, ignore */ }
        }

        // Ensure new instance columns for omnichannel + personalization
        const omnichannelCols = [
            { name: 'telegramBotToken', type: 'TEXT' },
            { name: 'telegramBotUsername', type: 'TEXT' },
            { name: 'emailSmtpHost', type: 'TEXT' },
            { name: 'emailSmtpPort', type: "TEXT DEFAULT '587'" },
            { name: 'emailSmtpUser', type: 'TEXT' },
            { name: 'emailSmtpPass', type: 'TEXT' },
            { name: 'emailImapHost', type: 'TEXT' },
            { name: 'emailImapPort', type: "TEXT DEFAULT '993'" },
            { name: 'emailImapUser', type: 'TEXT' },
            { name: 'emailImapPass', type: 'TEXT' },
            { name: 'emailFromName', type: 'TEXT' },
            { name: 'defaultLanguage', type: "TEXT DEFAULT 'ru'" },
            { name: 'autoTranslate', type: 'INTEGER DEFAULT 0' },
            { name: 'dynamicPricingEnabled', type: 'INTEGER DEFAULT 0' },
            { name: 'dynamicPricingRules', type: 'TEXT' },
            { name: 'smartTriggersEnabled', type: 'INTEGER DEFAULT 0' },
            { name: 'vkGroupToken', type: 'TEXT' },
            { name: 'vkGroupId', type: 'TEXT' },
            { name: 'vkGroupName', type: 'TEXT' },
                        { name: 'maxBotToken', type: 'TEXT' },
            { name: 'maxBotName', type: 'TEXT' },
            { name: 'maxBotUsername', type: 'TEXT' },
            { name: 'baristaBotToken', type: 'TEXT' },
            { name: 'baristaBotUsername', type: 'TEXT' },
            { name: 'baristaInviteCode', type: 'TEXT' },
        ];
        for (const col of omnichannelCols) {
            try {
                this.db.exec(`ALTER TABLE instances ADD COLUMN ${col.name} ${col.type}`);
            } catch (e) { /* column already exists, ignore */ }
        }

        // Ensure VK/MAX columns on clients table
        const vkMaxClientCols = [
            { name: 'vkUserId', type: 'TEXT' },
            { name: 'vkPeerId', type: 'TEXT' },
            { name: 'maxUserId', type: 'TEXT' },
            { name: 'maxChatId', type: 'TEXT' },
        ];
        for (const col of vkMaxClientCols) {
            try {
                this.db.exec(`ALTER TABLE clients ADD COLUMN ${col.name} ${col.type}`);
            } catch (e) { /* column already exists, ignore */ }
        }

        // Ensure channel column on messages table
        try {
            this.db.exec("ALTER TABLE messages ADD COLUMN channel TEXT DEFAULT 'whatsapp'");
        } catch (e) { /* column already exists, ignore */ }
        try {
            this.db.exec('ALTER TABLE messages ADD COLUMN sourceMessageId TEXT');
        } catch (e) { /* column already exists, ignore */ }
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_instance_chat_channel ON messages(instanceId, chatId, channel)');
        this.ensureMessageOriginSchema();

        const onyxTenantCols = [
            { name: 'cc_pair_id', type: 'INTEGER' },
            { name: 'onyx_version', type: 'TEXT' },
            { name: 'readiness_json', type: "TEXT DEFAULT '{}'" },
            { name: 'revision', type: 'INTEGER NOT NULL DEFAULT 1' },
        ];
        for (const col of onyxTenantCols) {
            try {
                this.db.exec(`ALTER TABLE onyx_tenant_links ADD COLUMN ${col.name} ${col.type}`);
            } catch (e) { /* column already exists, ignore */ }
        }
        const onyxOutboxCols = [
            { name: 'lease_token', type: 'TEXT' },
            { name: 'leased_until', type: 'TEXT' },
            { name: 'last_error_code', type: 'TEXT' },
        ];
        for (const col of onyxOutboxCols) {
            try {
                this.db.exec(`ALTER TABLE onyx_sync_outbox ADD COLUMN ${col.name} ${col.type}`);
            } catch (e) { /* column already exists, ignore */ }
        }
        try {
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_onyx_sync_outbox_lease ON onyx_sync_outbox(status, next_attempt_at, leased_until)');
        } catch (e) { /* index may fail on a partial legacy migration */ }
    }

    // Migration for RAG vector support (adds new columns and indexes)
    ensureMessageOriginSchema() {
        // COALESCE protects older INSERT shapes immediately; the trigger retains
        // natural origin before a later canonical merge changes chatId.
        this.db.transaction(() => {
            if (!this.all('PRAGMA table_info(messages)').some(column => column.name === 'originChatId')) {
                this.db.exec('ALTER TABLE messages ADD COLUMN originChatId TEXT');
            }
            this.db.exec(`UPDATE messages SET originChatId=chatId WHERE originChatId IS NULL;
                DROP INDEX IF EXISTS idx_messages_source_message;
                DROP INDEX IF EXISTS idx_messages_origin_source;
                CREATE UNIQUE INDEX idx_messages_origin_source
                    ON messages(instanceId,COALESCE(originChatId,chatId),channel,sourceMessageId)
                    WHERE sourceMessageId IS NOT NULL;
                CREATE TRIGGER IF NOT EXISTS trg_messages_origin_insert
                    AFTER INSERT ON messages WHEN NEW.originChatId IS NULL
                    BEGIN UPDATE messages SET originChatId=NEW.chatId WHERE id=NEW.id; END;`);
        }).immediate();
    }

    migrateRagSchema() {
        try {
            const kbColumns = this.all("PRAGMA table_info(knowledge_base)");
            const columnNames = kbColumns.map(c => c.name);

            if (!columnNames.includes('contentHash')) {
                try { this.db.exec('ALTER TABLE knowledge_base ADD COLUMN contentHash TEXT'); } catch(e) {}
                Logger.info('Added contentHash column to knowledge_base');
            }

            if (!columnNames.includes('mimeType')) {
                try { this.db.exec('ALTER TABLE knowledge_base ADD COLUMN mimeType TEXT'); } catch(e) {}
                Logger.info('Added mimeType column to knowledge_base');
            }

            if (!columnNames.includes('fileSize')) {
                try { this.db.exec('ALTER TABLE knowledge_base ADD COLUMN fileSize INTEGER'); } catch(e) {}
                Logger.info('Added fileSize column to knowledge_base');
            }

            if (!columnNames.includes('chunkCount')) {
                try { this.db.exec('ALTER TABLE knowledge_base ADD COLUMN chunkCount INTEGER DEFAULT 0'); } catch(e) {}
                Logger.info('Added chunkCount column to knowledge_base');
            }

            if (!columnNames.includes('hasEmbeddings')) {
                try { this.db.exec('ALTER TABLE knowledge_base ADD COLUMN hasEmbeddings INTEGER DEFAULT 0'); } catch(e) {}
                Logger.info('Added hasEmbeddings column to knowledge_base');
            }

            if (!columnNames.includes('version')) {
                try { this.db.exec('ALTER TABLE knowledge_base ADD COLUMN version INTEGER DEFAULT 1'); } catch(e) {}
                Logger.info('Added version column to knowledge_base');
            }

            if (!columnNames.includes('isCurrent')) {
                try { this.db.exec('ALTER TABLE knowledge_base ADD COLUMN isCurrent INTEGER DEFAULT 1'); } catch(e) {}
                Logger.info('Added isCurrent column to knowledge_base');
            }

            const chunkColumns = this.all("PRAGMA table_info(kb_chunks)");
            const chunkColumnNames = chunkColumns.map(c => c.name);

            if (!chunkColumnNames.includes('searchText')) {
                try { this.db.exec('ALTER TABLE kb_chunks ADD COLUMN searchText TEXT'); } catch(e) {}
                Logger.info('Added searchText column to kb_chunks');
            }

            if (!chunkColumnNames.includes('section')) {
                try { this.db.exec('ALTER TABLE kb_chunks ADD COLUMN section TEXT'); } catch(e) {}
                Logger.info('Added section column to kb_chunks');
            }

            this.db.exec(`
                CREATE INDEX IF NOT EXISTS idx_kb_chunks_kbId ON kb_chunks(kbId);
                CREATE INDEX IF NOT EXISTS idx_knowledge_base_instanceId ON knowledge_base(instanceId);
                CREATE INDEX IF NOT EXISTS idx_knowledge_base_instance_current ON knowledge_base(instanceId, isCurrent, createdAt DESC);
                CREATE INDEX IF NOT EXISTS idx_knowledge_base_hash ON knowledge_base(instanceId, contentHash);
            `);

            this.backfillChunkSearchText();
            this.ensureChunkSearchIndex();

            this.db.exec(`
                CREATE TABLE IF NOT EXISTS rag_search_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    instanceId INTEGER NOT NULL,
                    query TEXT NOT NULL,
                    searchType TEXT,
                    resultsCount INTEGER,
                    topScore REAL,
                    avgScore REAL,
                    responseTimeMs INTEGER,
                    wasUsedByAI INTEGER DEFAULT 0,
                    clientFeedback TEXT,
                    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
                )
            `);
            try {
                this.db.exec('CREATE INDEX IF NOT EXISTS idx_rag_search_log_instance ON rag_search_log(instanceId, createdAt DESC)');
            } catch (e) {}

            Logger.success('RAG schema migration completed');

        } catch (error) {
            Logger.warn('RAG schema migration error (may already be migrated):', error.message);
        }
    }

    // --- Instance Methods ---

    async createInstance(data) {
        const { name } = data;
        const businessType = BUSINESS_TYPES.includes(data.businessType) ? data.businessType : 'standard';
        const salesGoal = businessType === 'coffee_shop' ? 'coffee_pickup' : (data.salesGoal || 'call');
        const { patch: voice } = await require('./voice-settings.service').prepareWrite(data);
        this.run(
            'INSERT INTO instances (name, businessType, salesGoal, voiceAiProvider, voiceModel, voiceName, voiceSettings, voiceAmbient) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [name, businessType, salesGoal, voice.voiceAiProvider || null, voice.voiceModel || null, voice.voiceName || null, voice.voiceSettings || '{}', voice.voiceAmbient ?? null]
        );
        return this.getInstance(this.get('SELECT last_insert_rowid() AS id').id);
    }

    async getInstances() {
        return this.all('SELECT * FROM instances ORDER BY id ASC').map(ChannelCredentials.decryptInstance);
    }

    async getInstance(id) {
        return ChannelCredentials.decryptInstance(this.get('SELECT * FROM instances WHERE id = ?', [id]));
    }

    async getInstanceByGreenApi(greenApiInstance) {
        return ChannelCredentials.decryptInstance(this.get('SELECT * FROM instances WHERE greenApiInstance = ?', [greenApiInstance]));
    }

    async getInstanceByOpenWaSession(sessionId) {
        if (!sessionId) return null;
        return ChannelCredentials.decryptInstance(this.get('SELECT * FROM instances WHERE openWaSessionId = ?', [String(sessionId)]));
    }

    async updateInstance(id, data, options = {}) {
        const sets = [];
        const params = [];
        const rawInstance = this.get('SELECT * FROM instances WHERE id = ?', [id]);
        if (!rawInstance) return null;
        const currentInstance = await this.getInstance(id);
        const normalizedData = { ...data };
        const VoiceSettings = require('./voice-settings.service');
        const { VOICE_AI_PROVIDERS } = require('./voice-provider.service');
        if (Object.hasOwn(data, 'aiProvider')) {
            if (VOICE_AI_PROVIDERS.has(data.aiProvider)) {
                // Legacy voice clients used aiProvider. Route those selections
                // through the same validated canonical path, preserving text AI.
                if (!Object.hasOwn(data, 'voiceAiProvider')) normalizedData.voiceAiProvider = data.aiProvider;
                delete normalizedData.aiProvider;
            } else if (!currentInstance.voiceAiProvider && VOICE_AI_PROVIDERS.has(currentInstance.aiProvider)
                && !Object.hasOwn(data, 'voiceAiProvider')) {
                // Pin an old flat voice selection before updating CRM text AI.
                normalizedData.voiceAiProvider = currentInstance.aiProvider;
            }
        }
        const preparedVoice = await VoiceSettings.prepareWrite(normalizedData, currentInstance, options);
        return this.db.transaction(() => {
            // BEGIN IMMEDIATE protects the fresh merge and write from other DB
            // connections as well as concurrent requests in this process.
            const latestVoiceRow = this.get('SELECT * FROM instances WHERE id = ?', [id]);
            if (!latestVoiceRow) return null;
            if (options.signal?.aborted) throw Object.assign(new Error('VOICE_REQUEST_CANCELLED'), { code: 'VOICE_REQUEST_CANCELLED', statusCode: 499 });
            if (!Object.hasOwn(normalizedData, 'voiceAiProvider') && (Object.hasOwn(data, 'voiceName') || Object.hasOwn(data, 'voiceModel') || Object.hasOwn(data, 'voiceWaiting'))
                && VoiceSettings.project(latestVoiceRow).voiceAiProvider !== VoiceSettings.project(currentInstance).voiceAiProvider) {
                throw Object.assign(new Error('VOICE_SETTINGS_CHANGED'), { code: 'VOICE_SETTINGS_CHANGED', statusCode: 409 });
            }
            const voicePatch = VoiceSettings.planWrite(normalizedData, latestVoiceRow, preparedVoice.catalog);
            if (voicePatch.needsCatalog) throw Object.assign(new Error('VOICE_SETTINGS_CHANGED'), { code: 'VOICE_SETTINGS_CHANGED', statusCode: 409 });
            Object.assign(normalizedData, voicePatch);
            Object.assign(normalizedData, require('./postcall-followup.service').planWrite(data, latestVoiceRow, voicePatch));
            options.beforeWrite?.();

            // On any write with a configured key, migrate remaining legacy
            // plaintext credentials in the same instance without changing callers.
            if (ChannelCredentials.masterKey()) {
                for (const field of ChannelCredentials.SECRET_FIELDS) {
                    if (normalizedData[field] === undefined && latestVoiceRow[field] &&
                        !ChannelCredentials.isEncrypted(latestVoiceRow[field])) {
                        normalizedData[field] = latestVoiceRow[field];
                    }
                }
            }

            if (normalizedData.businessType !== undefined) {
                if (!BUSINESS_TYPES.includes(normalizedData.businessType)) {
                    throw new Error(`Invalid business type: "${normalizedData.businessType}"`);
                }
                if (normalizedData.businessType === 'coffee_shop') {
                    normalizedData.salesGoal = 'coffee_pickup';
                } else if (normalizedData.salesGoal === 'coffee_pickup' || (
                    normalizedData.salesGoal === undefined &&
                    resolveBusinessType(currentInstance) === 'coffee_shop'
                )) {
                    normalizedData.salesGoal = 'call';
                }
            } else if (normalizedData.salesGoal === 'coffee_pickup') {
                normalizedData.businessType = 'coffee_shop';
            }

            const fields = [
                'name', 'greenApiInstance', 'greenApiToken', 'greenApiUrl',
                'whatsappProvider', 'openWaUrl', 'openWaApiKey', 'openWaSessionId', 'openWaStatus',
                'aiProvider', 'geminiModel', 'voiceAiProvider', 'voiceModel', 'voiceName', 'voiceSettings', 'voiceAmbient', 'openRouterKey', 'openRouterModel',
                'yandexGptKey', 'yandexGptFolderId', 'yandexGptModelUri',
                'aiTemperature', 'aiResponseFormat',
                'systemPrompt',
                'yclientsLink', 'yclientsCompanyId', 'yclientsFormId',
                'crmIntegration', 'amoCrmDomain', 'amoCrmAccessToken', 'bitrix24WebhookUrl',
                'followUpEnabled', 'followUpDelay', 'followUpText',
                'isActive',
                'telegramBotToken', 'telegramBotUsername',
                'emailSmtpHost', 'emailSmtpPort', 'emailSmtpUser', 'emailSmtpPass',
                'emailImapHost', 'emailImapPort', 'emailImapUser', 'emailImapPass',
                'emailFromName', 'defaultLanguage', 'autoTranslate',
                'dynamicPricingEnabled', 'dynamicPricingRules', 'smartTriggersEnabled',
                'vkGroupToken', 'vkGroupId', 'vkGroupName',
                'maxBotToken', 'maxBotName', 'maxBotUsername',
                'salesGoal', 'businessType',
                'hotelTone', 'hotelTimezone', 'hotelWorkingHours',
                'sipTrunkNumber', 'sipCallerId', 'sipAliases',
                'knowledgeBaseInstanceId', 'voiceContextName',
                'voiceGreetingTemplate', 'outboundOpenerTemplate',
                'yookassaShopId', 'yookassaSecretKey',
                'baristaBotToken', 'baristaBotUsername', 'baristaInviteCode',
                'coffeeOperationMode', 'coffeeCafeHours', 'coffeeKitchenHours',
                'coffeePrepTimeMinutes', 'coffeeBusyPrepTimeMinutes',
                'coffeeFeedbackDelayMinutes', 'coffeeFeedbackText',
                'followupAutoSendEnabled'
            ];

            fields.forEach(field => {
                if (normalizedData[field] !== undefined) {
                    sets.push(`${field} = ?`);
                    params.push(ChannelCredentials.SECRET_FIELDS.includes(field)
                        ? ChannelCredentials.encrypt(normalizedData[field], id, field)
                        : normalizedData[field]);
                }
            });

            if (sets.length === 0) return null;

            sets.push('updatedAt = CURRENT_TIMESTAMP');
            params.push(id);

            require('./telephony/store').protectProfile(id, normalizedData);
            this.run(`UPDATE instances SET ${sets.join(', ')} WHERE id = ?`, params);
            if(normalizedData.isActive != null && Number(normalizedData.isActive)===0
                && this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='whatsapp_reply_jobs'"))
                require('./whatsapp.service').cancelPending(Number(id),null,'WHATSAPP_BUSINESS_PAUSED');
            return ChannelCredentials.decryptInstance(this.get('SELECT * FROM instances WHERE id = ?', [id]));
        }).immediate();
    }

    // --- Client Methods ---

    async getClient(instanceId, chatId) {
        chatId = require('./client-identity.service').resolve(instanceId, chatId);
        return this.get('SELECT * FROM clients WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
    }

    async getOrCreateClient(instanceId, chatId, senderName) {
        chatId = require('./client-identity.service').resolve(instanceId, chatId);
        let client = this.get('SELECT * FROM clients WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
        if (!client) {
            this.run(
                'INSERT INTO clients (instanceId, chatId, senderName, lastStatusChangeAt) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
                [instanceId, chatId, senderName]
            );
            client = this.get('SELECT * FROM clients WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
        }
        return client;
    }

    async updateClientStatus(instanceId, chatId, status, reason = null, changedBy = 'ai') {
        return this.updateClientStatusSync(instanceId, chatId, status, reason, changedBy);
    }

    updateClientStatusSync(instanceId, chatId, status, reason = null, changedBy = 'ai') {
        chatId = require('./client-identity.service').resolve(instanceId, chatId);
        if (!VALID_STATUSES.includes(status)) {
            throw new Error(`Invalid lead status: "${status}". Valid: ${VALID_STATUSES.join(', ')}`);
        }

        const client = this.get('SELECT leadStatus FROM clients WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
        const fromStatus = client ? client.leadStatus : 'new';

        this.run(
            `UPDATE clients SET leadStatus = ?, lastStatusChangeAt = CURRENT_TIMESTAMP, followUpSentAt = NULL, updatedAt = CURRENT_TIMESTAMP WHERE instanceId = ? AND chatId = ?`,
            [status, instanceId, chatId]
        );

        // Log status transition
        this.run(
            `INSERT INTO lead_status_history (instanceId, chatId, fromStatus, toStatus, reason, changedBy) VALUES (?, ?, ?, ?, ?, ?)`,
            [instanceId, chatId, fromStatus, status, reason, changedBy]
        );
    }

    async getStatusHistory(instanceId, chatId) {
        chatId = require('./client-identity.service').resolve(instanceId, chatId);
        return this.all(
            'SELECT * FROM lead_status_history WHERE instanceId = ? AND chatId = ? ORDER BY createdAt DESC LIMIT 20',
            [instanceId, chatId]
        );
    }

    async saveMessage(instanceId, chatId, senderName, content, role, aiThought = null, sourceMessageId = null) {
        return this.saveMessageWithChannel(instanceId, chatId, senderName, content, role, 'whatsapp', aiThought, sourceMessageId);
    }

        async getClientHistory(instanceId, chatId, limit = 10) {
        chatId = require('./client-identity.service').resolve(instanceId, chatId);
        const rows = this.all(
            `SELECT * FROM messages WHERE instanceId = ? AND chatId = ? ORDER BY timestamp DESC, id DESC LIMIT ?`,
            [instanceId, chatId, limit]
        );
        return rows.reverse();
    }

    // --- Tags ---

    async updateClientTags(instanceId, chatId, tags) {
        chatId = require('./client-identity.service').resolve(instanceId, chatId);
        const tagsJson = JSON.stringify(Array.isArray(tags) ? tags : []);
        this.run(
            'UPDATE clients SET tags = ?, updatedAt = CURRENT_TIMESTAMP WHERE instanceId = ? AND chatId = ?',
            [tagsJson, instanceId, chatId]
        );
    }

    // --- Stats ---

    async getClientCount(instanceId) {
        const row = this.get('SELECT COUNT(*) as count FROM clients WHERE instanceId = ?', [instanceId]);
        return row ? row.count : 0;
    }

    async getMessageCountToday(instanceId) {
        const row = this.get(
            "SELECT COUNT(*) as count FROM messages WHERE instanceId = ? AND date(timestamp) = date('now')",
            [instanceId]
        );
        return row ? row.count : 0;
    }

    async getClients(instanceId) {
        const clients = this.all(
            'SELECT * FROM clients WHERE instanceId = ? ORDER BY updatedAt DESC',
            [instanceId]
        );
        // A client can have history in several channels; preferredChannel only
        // controls the default outbound route and cannot describe the inbox.
        const channelRows = this.all(
            `SELECT chatId, COALESCE(NULLIF(LOWER(TRIM(channel)), ''), 'whatsapp') AS channel
             FROM messages WHERE instanceId = ?
             GROUP BY chatId, COALESCE(NULLIF(LOWER(TRIM(channel)), ''), 'whatsapp')`,
            [instanceId]
        );
        const channelsByChatId = new Map();
        for (const row of channelRows) {
            if (!channelsByChatId.has(row.chatId)) channelsByChatId.set(row.chatId, []);
            channelsByChatId.get(row.chatId).push(row.channel);
        }
        return clients.map(client => ({
            ...client,
            channels: channelsByChatId.get(client.chatId) || [],
        }));
    }

    async getMessages(instanceId, chatId) {
        chatId = require('./client-identity.service').resolve(instanceId, chatId);
        return this.all(
            'SELECT * FROM messages WHERE instanceId = ? AND chatId = ? ORDER BY timestamp ASC, id ASC',
            [instanceId, chatId]
        );
    }

    // Get recent N messages (for conversation context in RAG)
    async getRecentMessages(instanceId, chatId, limit = 3) {
        chatId = require('./client-identity.service').resolve(instanceId, chatId);
        return this.all(
            'SELECT * FROM messages WHERE instanceId = ? AND chatId = ? ORDER BY timestamp DESC LIMIT ?',
            [instanceId, chatId, limit]
        ).reverse(); // Return in chronological order
    }

    async getStats(instanceId) {
        const instance = await this.getInstance(instanceId);
        const isCoffeeShop = resolveBusinessType(instance) === 'coffee_shop';
        const clientCount = await this.getClientCount(instanceId);
        const messagesToday = await this.getMessageCountToday(instanceId);

        // Get counts for each status
        const statusRows = this.all(
            "SELECT leadStatus, COUNT(*) as count FROM clients WHERE instanceId = ? GROUP BY leadStatus",
            [instanceId]
        );

        const pipeline = {
            new: 0,
            qualified: 0,
            audit: 0,
            offer: 0,
            pickup_confirmed: 0,
            ready_for_pickup: 0,
            booked: 0,
            junk: 0
        };

        statusRows.forEach(row => {
            if (pipeline[row.leadStatus] !== undefined) {
                pipeline[row.leadStatus] = row.count;
            } else {
                pipeline['new'] += row.count;
            }
        });

        const activeLeads = pipeline.qualified + pipeline.audit + pipeline.offer;
        const pickupConfirmed = pipeline.pickup_confirmed + pipeline.ready_for_pickup;
        const booked = pipeline.booked;
        const converted = isCoffeeShop ? pickupConfirmed : booked;

        const meaningfulLeads = clientCount - pipeline.junk;
        const conversion = meaningfulLeads > 0 ? Math.round((converted / meaningfulLeads) * 100) : 0;

        const dynamicsQuery = `
            SELECT date(createdAt) as date, COUNT(*) as count
            FROM clients 
            WHERE instanceId = ? AND createdAt >= date('now', '-7 days')
            GROUP BY date(createdAt)
            ORDER BY date(createdAt) ASC
        `;
        const last7DaysLeads = this.all(dynamicsQuery, [instanceId]);

        const dynamics = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateStr = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
            const found = last7DaysLeads.find(r => r.date === dateStr);
            dynamics.push({
                date: date.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric' }),
                leads: found ? found.count : 0
            });
        }

        return {
            activeLeads,
            messagesToday,
            booked,
            pickupConfirmed,
            readyForPickup: pipeline.ready_for_pickup,
            converted,
            conversion,
            totalClients: clientCount,
            pipeline,
            dynamics
        };
    }

    async updateClientCrmIds(instanceId, chatId, contactId, leadId) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        this.run(
            'UPDATE clients SET crmContactId = ?, crmLeadId = ?, updatedAt = CURRENT_TIMESTAMP WHERE instanceId = ? AND chatId = ?',
            [contactId, leadId, instanceId, chatId]
        );
    }

    async deleteInstance(id) {
        const Workspace = require('./ava-workspace.store');
        const Autopilot = require('./ava-autopilot.store');
        Workspace.ensureSchema(); Autopilot.ensureSchema();
        require('./ava-release-flags.service').ensureSchema();
        const Deals = require('./customer-deals.store');
        Deals.ensureSchema();
        this.db.transaction(() => {
            // Delete from all related tables as one operation. Deals must go before clients.
            if(this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customer_external_connections'")) {
                if(this.get("SELECT 1 FROM customer_external_operations WHERE instanceId=? AND status IN ('started','unknown') LIMIT 1",[id])
                    ||this.get("SELECT 1 FROM customer_external_connections WHERE instanceId=? AND authLease IS NOT NULL AND authLeaseUntil>? LIMIT 1",[id,Date.now()]))
                    throw Object.assign(new Error('EXTERNAL_OUTCOME_UNKNOWN'),{code:'EXTERNAL_OUTCOME_UNKNOWN',statusCode:409});
                for(const table of ['customer_external_exports','customer_external_callbacks','customer_external_progress','customer_external_entities','customer_external_links','customer_external_operations','customer_external_connections'])
                    this.run(`DELETE FROM ${table} WHERE instanceId=?`,[id]);
            }
            Workspace.removeBusiness(id); Autopilot.removeBusiness(id);
            require('./ava-release-flags.service').removeBusiness(id);
            Deals.removeBusiness(id);
            this.run('DELETE FROM trigger_occurrences WHERE instanceId = ?', [id]);
            this.run('DELETE FROM trigger_log WHERE instanceId = ?', [id]);
            this.run('DELETE FROM client_sequences WHERE instanceId = ?', [id]);
            this.run('DELETE FROM optimal_contact_times WHERE instanceId = ?', [id]);
            this.run('DELETE FROM client_profiles WHERE instanceId = ?', [id]);
            this.run('DELETE FROM lead_status_history WHERE instanceId = ?', [id]);
            this.run('DELETE FROM messages WHERE instanceId = ?', [id]);
            this.run('DELETE FROM order_items WHERE instanceId = ?', [id]);
            this.run('DELETE FROM coffee_stop_list WHERE instanceId = ?', [id]);
            this.run('DELETE FROM coffee_feedback WHERE instanceId = ?', [id]);
            this.run('DELETE FROM clients WHERE instanceId = ?', [id]);
            this.run('DELETE FROM templates WHERE instanceId = ?', [id]);
            this.run('DELETE FROM push_subscriptions WHERE instanceId = ?', [id]);
            // Delete sequence steps via sequence IDs
            const seqs = this.all('SELECT id FROM message_sequences WHERE instanceId = ?', [id]);
            for (const seq of seqs) {
                this.run('DELETE FROM sequence_steps WHERE sequenceId = ?', [seq.id]);
            }
            this.run('DELETE FROM message_sequences WHERE instanceId = ?', [id]);
            this.run('DELETE FROM smart_triggers WHERE instanceId = ?', [id]);
            this.run('DELETE FROM orders WHERE instanceId = ?', [id]);
            this.run('DELETE FROM barista_staff WHERE instanceId = ?', [id]);
            this.run('DELETE FROM instances WHERE id = ?', [id]);
        }).immediate();
    }

    // --- Templates ---

    async getTemplates(instanceId) {
        return this.all('SELECT * FROM templates WHERE instanceId = ? ORDER BY createdAt ASC', [instanceId]);
    }

    async createTemplate(instanceId, label, text) {
        this.run('INSERT INTO templates (instanceId, label, text) VALUES (?, ?, ?)', [instanceId, label, text]);
        return this.get('SELECT * FROM templates WHERE id = last_insert_rowid()');
    }

    async deleteTemplate(instanceId, id) {
        return this.run('DELETE FROM templates WHERE instanceId = ? AND id = ?', [instanceId, id]);
    }

    // --- Push Subscriptions ---

    async savePushSubscription(endpoint, p256dh, auth, instanceId = null) {
        try {
            this.run(
                'INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, instanceId) VALUES (?, ?, ?, ?)',
                [endpoint, p256dh, auth, instanceId]
            );
        } catch (e) {
            Logger.warn('savePushSubscription error:', e.message);
        }
    }

    async getPushSubscriptions(instanceId = null) {
        if (instanceId) {
            return this.all(
                'SELECT * FROM push_subscriptions WHERE instanceId = ? OR instanceId IS NULL',
                [instanceId]
            );
        }
        return this.all('SELECT * FROM push_subscriptions');
    }

    async deletePushSubscription(endpoint) {
        this.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
    }

    // --- Follow-up: get stuck leads ---

    async getStuckLeads(hoursThreshold = 24) {
        return this.all(`
            SELECT c.*, i.greenApiInstance, i.greenApiToken, i.greenApiUrl, i.systemPrompt,
                   i.aiProvider, i.geminiModel, i.openRouterKey, i.openRouterModel,
                   i.yandexGptKey, i.yandexGptFolderId, i.yandexGptModelUri,
                   i.aiTemperature, i.aiResponseFormat, i.isActive
            FROM clients c
            JOIN instances i ON c.instanceId = i.id
            WHERE c.leadStatus NOT IN ('pickup_confirmed', 'ready_for_pickup', 'booked', 'junk')
              AND c.followUpSentAt IS NULL
              AND i.isActive = 1
              AND i.greenApiInstance IS NOT NULL
              AND i.greenApiToken IS NOT NULL
              AND (
                  c.lastStatusChangeAt IS NULL
                  OR (julianday('now') - julianday(c.lastStatusChangeAt)) * 24 >= ?
              )
        `, [hoursThreshold]);
    }

    async markFollowUpSent(instanceId, chatId) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        this.run(
            'UPDATE clients SET followUpSentAt = CURRENT_TIMESTAMP WHERE instanceId = ? AND chatId = ?',
            [instanceId, chatId]
        );
    }

    // --- Analytics: Funnel Transitions ---
    async getFunnelTransitions(instanceId) {
        return this.all(`
            SELECT fromStatus, toStatus, COUNT(*) as count
            FROM lead_status_history
            WHERE instanceId = ? AND fromStatus IS NOT NULL
            GROUP BY fromStatus, toStatus
            ORDER BY count DESC
        `, [instanceId]);
    }

    // --- Analytics: Average Time Per Status ---
    async getAvgTimePerStatus(instanceId) {
        // For each status transition, compute how long leads stayed in the fromStatus
        const rows = this.all(`
            SELECT
                h.fromStatus as status,
                COUNT(*) as sampleCount,
                AVG(
                    (julianday(h.createdAt) - julianday(
                        COALESCE(
                            (SELECT h2.createdAt FROM lead_status_history h2
                             WHERE h2.instanceId = h.instanceId
                               AND h2.chatId = h.chatId
                               AND h2.toStatus = h.fromStatus
                               AND h2.createdAt < h.createdAt
                             ORDER BY h2.createdAt DESC LIMIT 1),
                            (SELECT c.createdAt FROM clients c
                             WHERE c.instanceId = h.instanceId AND c.chatId = h.chatId)
                        )
                    )) * 24
                ) as avgHours
            FROM lead_status_history h
            WHERE h.instanceId = ? AND h.fromStatus IS NOT NULL
            GROUP BY h.fromStatus
        `, [instanceId]);

        return rows.map(r => ({
            status: r.status,
            sampleCount: r.sampleCount,
            avgHours: r.avgHours ? Math.round(r.avgHours * 10) / 10 : 0
        }));
    }

    // --- Save message with channel ---
    async saveMessageWithChannel(instanceId, chatId, senderName, content, role, channel = 'whatsapp', aiThought = null, sourceMessageId = null) {
        const originChatId = String(chatId);
        chatId = require('./client-identity.service').resolve(instanceId, chatId);
        instanceId = Number(instanceId);
        if (!Number.isSafeInteger(instanceId) || instanceId < 1) throw new Error('Invalid business ID');
        if (!['whatsapp', 'telegram', 'email', 'vk', 'max', 'instagram', 'avito'].includes(channel)) {
            throw new Error('Unsupported conversation channel');
        }
        if (sourceMessageId != null && typeof sourceMessageId !== 'string' &&
            !(typeof sourceMessageId === 'number' && Number.isSafeInteger(sourceMessageId))) {
            throw new Error('Invalid source message ID');
        }
        const providerId = sourceMessageId == null || sourceMessageId === ''
            ? null : String(sourceMessageId);
        if (providerId && providerId.length > 256) throw new Error('Invalid source message ID');
        return this.db.transaction(() => {
            const inserted = this.run(
                `INSERT OR IGNORE INTO messages (instanceId, chatId, senderName, messageType, content, role, aiThought, channel, sourceMessageId, originChatId) VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?, ?)`,
                [instanceId, chatId, senderName, content, role, aiThought, channel, providerId, originChatId]
            );
            if (inserted.changes === 0) return { inserted: false };
            this.run(
                `UPDATE clients SET lastMessage = ?, lastMessageTime = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE instanceId = ? AND chatId = ?`,
                [content, instanceId, chatId]
            );
            // Only a confirmed customer dialog may start conversation memory.
            if (this.get("SELECT 1 FROM messages WHERE instanceId=? AND chatId=? AND role='user' LIMIT 1", [instanceId, chatId])) {
                require('./crm-memory-store.service').enqueueConversation(instanceId, chatId);
            }
            return { inserted: true, id: inserted.lastInsertRowid };
        }).immediate();
    }

    // --- Client Profile (Digital Twin) ---

    async getClientProfile(instanceId, chatId) {
        chatId = require('./client-identity.service').resolve(instanceId, chatId);
        return this.get('SELECT * FROM client_profiles WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
    }

    async upsertClientProfile(instanceId, chatId, profileData) {
        return this.upsertClientProfileSync(instanceId, chatId, profileData);
    }

    upsertClientProfileSync(instanceId, chatId, profileData) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        const existing = this.get('SELECT * FROM client_profiles WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
        if (existing) {
            const sets = [];
            const params = [];
            const fields = ['needs', 'budget', 'objections', 'interests', 'communicationStyle', 'decisionSpeed',
                'preferredChannel', 'language', 'timezone', 'sentimentScore', 'conversionProbability', 'rawProfileJson'];
            fields.forEach(f => {
                if (profileData[f] !== undefined) {
                    sets.push(`${f} = ?`);
                    if (f === 'rawProfileJson') {
                        params.push(mergeProfileRawJson(existing.rawProfileJson, profileData.rawProfileJson));
                    } else {
                        params.push(profileData[f] !== null && typeof profileData[f] === 'object' ? JSON.stringify(profileData[f]) : profileData[f]);
                    }
                }
            });
            if (sets.length === 0) return existing;
            sets.push('lastProfileUpdate = CURRENT_TIMESTAMP', 'updatedAt = CURRENT_TIMESTAMP');
            params.push(instanceId, chatId);
            this.run(`UPDATE client_profiles SET ${sets.join(', ')} WHERE instanceId = ? AND chatId = ?`, params);
        } else {
            const interests = profileData.interests ? (typeof profileData.interests === 'string' ? profileData.interests : JSON.stringify(profileData.interests)) : '[]';
            this.run(
                `INSERT INTO client_profiles (instanceId, chatId, needs, budget, objections, interests, communicationStyle, decisionSpeed, preferredChannel, language, timezone, sentimentScore, conversionProbability, rawProfileJson, lastProfileUpdate)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [instanceId, chatId, profileData.needs || null, profileData.budget || null, profileData.objections || null,
                    interests, profileData.communicationStyle || 'casual', profileData.decisionSpeed || 'medium',
                    profileData.preferredChannel || 'whatsapp', profileData.language || 'ru', profileData.timezone || null,
                    profileData.sentimentScore || 0.5, profileData.conversionProbability || 0, profileData.rawProfileJson || null]
            );
        }
        return this.get('SELECT * FROM client_profiles WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
    }

    // --- Optimal Contact Times ---

    // --- Sales Brain audit/memory ---

    createConversationEvent(data = {}, memoryInput = null) {
        if (data.chatId != null) {
            const canonicalChatId = require('./client-identity.service').resolve(data.instanceId, data.chatId);
            const client = this.get('SELECT id FROM clients WHERE instanceId=? AND chatId=?', [data.instanceId, canonicalChatId]);
            data = { ...data, chatId: canonicalChatId, ...(client && canonicalChatId !== data.chatId ? { customerId: `crm_${data.instanceId}_${client.id}` } : {}) };
        }
        return this.db.transaction(() => {
        const eventId = data.eventId || this._id('evt');
        this.run(`
            INSERT OR IGNORE INTO conversation_events (
                eventId, instanceId, chatId, customerId, channel, direction, role,
                content, callId, sourceId, metadataJson
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            eventId,
            data.instanceId,
            data.chatId || null,
            data.customerId || null,
            data.channel || 'system',
            data.direction || 'inbound',
            data.role || 'system',
            data.content || '',
            data.callId || null,
            data.sourceId || null,
            JSON.stringify(data.metadata || data.metadataJson || {}),
        ]);
        const event = this.get('SELECT * FROM conversation_events WHERE eventId = ?', [eventId]);
        if (Number(event.instanceId) !== Number(data.instanceId)) throw new Error('Conversation event scope mismatch');
        if (memoryInput) require('./crm-memory-store.service').enqueueCall(event, memoryInput);
        return event;
        }).immediate();
    }

    getConversationEventById(eventId) {
        return this.get('SELECT * FROM conversation_events WHERE eventId = ?', [eventId]);
    }

    updateConversationEvent(eventId, data = {}) {
        const existing = this.getConversationEventById(eventId);
        if (!existing) return null;
        const metadata = {
            ...parseJson(existing.metadataJson, {}),
            ...(data.metadata || {}),
        };
        this.run(`
            UPDATE conversation_events
            SET content = ?, metadataJson = ?
            WHERE eventId = ?
        `, [
            data.content !== undefined ? data.content : existing.content,
            JSON.stringify(metadata),
            eventId,
        ]);
        return this.getConversationEventById(eventId);
    }

    getConversationEventBySource(instanceId, sourceId) {
        return this.get(`
            SELECT *
            FROM conversation_events
            WHERE instanceId = ? AND sourceId = ?
            ORDER BY createdAt DESC
            LIMIT 1
        `, [instanceId, sourceId]);
    }

    getConversationEvents(instanceId, chatId, limit = 50) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        return this.all(`
            SELECT *
            FROM conversation_events
            WHERE instanceId = ? AND (? IS NULL OR chatId = ?)
            ORDER BY createdAt DESC
            LIMIT ?
        `, [instanceId, chatId || null, chatId || null, Math.max(1, Math.min(Number(limit) || 50, 200))]).reverse();
    }

    getPendingFollowupDrafts(instanceId, chatId, limit = 20) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        return this.all(`
            SELECT *
            FROM conversation_events
            WHERE instanceId = ?
              AND (? IS NULL OR chatId = ?)
              AND metadataJson LIKE '%whatsapp_followup_draft%'
              AND metadataJson LIKE '%"status":"draft"%'
            ORDER BY createdAt DESC
            LIMIT ?
        `, [instanceId, chatId || null, chatId || null, Math.max(1, Math.min(Number(limit) || 20, 100))]);
    }

    createMlDecision(data = {}) {
        if (data.chatId != null) {
            const canonicalChatId = require('./client-identity.service').resolve(data.instanceId, data.chatId);
            const client = this.get('SELECT id FROM clients WHERE instanceId=? AND chatId=?', [data.instanceId, canonicalChatId]);
            data = { ...data, chatId: canonicalChatId, ...(client && canonicalChatId !== data.chatId ? { customerId: `crm_${data.instanceId}_${client.id}` } : {}) };
        }
        const decisionId = data.decisionId || this._id('dec');
        this.run(`
            INSERT OR IGNORE INTO ml_decisions (
                decisionId, instanceId, chatId, customerId, taskType, model, promptVersion,
                inputRefsJson, outputJson, confidence, latencyMs, costJson
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            decisionId,
            data.instanceId,
            data.chatId || null,
            data.customerId || null,
            data.taskType,
            data.model || null,
            data.promptVersion || null,
            JSON.stringify(data.inputRefs || []),
            JSON.stringify(data.output || {}),
            data.confidence ?? null,
            Number(data.latencyMs || 0),
            JSON.stringify(data.cost || {}),
        ]);
        return this.get('SELECT * FROM ml_decisions WHERE decisionId = ?', [decisionId]);
    }

    getMlDecisions(instanceId, chatId, limit = 50) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        return this.all(`
            SELECT *
            FROM ml_decisions
            WHERE instanceId = ? AND (? IS NULL OR chatId = ?)
            ORDER BY createdAt DESC
            LIMIT ?
        `, [instanceId, chatId || null, chatId || null, Math.max(1, Math.min(Number(limit) || 50, 200))]);
    }

    createToolRun(data = {}) {
        if (data.chatId != null) {
            const canonicalChatId = require('./client-identity.service').resolve(data.instanceId, data.chatId);
            const client = this.get('SELECT id FROM clients WHERE instanceId=? AND chatId=?', [data.instanceId, canonicalChatId]);
            data = { ...data, chatId: canonicalChatId, ...(client && canonicalChatId !== data.chatId ? { customerId: `crm_${data.instanceId}_${client.id}` } : {}) };
        }
        const toolRunId = data.toolRunId || this._id('tool');
        this.run(`
            INSERT OR IGNORE INTO tool_runs (
                toolRunId, instanceId, chatId, customerId, callId, conversationEventId,
                toolName, phase, argsRedactedJson, resultRedactedJson, status, latencyMs
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            toolRunId,
            data.instanceId,
            data.chatId || null,
            data.customerId || null,
            data.callId || null,
            data.conversationEventId || null,
            data.toolName,
            data.phase || 'chat',
            JSON.stringify(data.argsRedacted || {}),
            JSON.stringify(data.resultRedacted || {}),
            data.status || 'ok',
            Number(data.latencyMs || 0),
        ]);
        return this.get('SELECT * FROM tool_runs WHERE toolRunId = ?', [toolRunId]);
    }

    getToolRuns(instanceId, chatId, limit = 50) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        return this.all(`
            SELECT *
            FROM tool_runs
            WHERE instanceId = ? AND (? IS NULL OR chatId = ?)
            ORDER BY createdAt DESC
            LIMIT ?
        `, [instanceId, chatId || null, chatId || null, Math.max(1, Math.min(Number(limit) || 50, 200))]);
    }

    // ─── Manager handoff tasks ────────────────────────────────────────────
    // Every read is scoped by instanceId: a task belongs to exactly one tenant
    // and must never surface in another business.

    createManagerTask(data = {}) {
        if (data.chatId != null) {
            const canonicalChatId = require('./client-identity.service').resolve(data.instanceId, data.chatId);
            const client = this.get('SELECT id FROM clients WHERE instanceId=? AND chatId=?', [data.instanceId, canonicalChatId]);
            data = { ...data, chatId: canonicalChatId, ...(client && canonicalChatId !== data.chatId ? { customerId: `crm_${data.instanceId}_${client.id}` } : {}) };
        }
        const taskId = data.taskId || this._id('task');
        this.run(`
            INSERT OR IGNORE INTO manager_tasks (
                taskId, instanceId, chatId, customerId, callId, phone, customerName,
                summary, reason, priority, status, source, assignee,
                assigneeUserId, dueAt, createdByUserId, conversationEventId, metadataJson
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            taskId,
            data.instanceId,
            data.chatId || null,
            data.customerId || null,
            data.callId || null,
            data.phone || null,
            data.customerName || null,
            data.summary || '',
            data.reason || 'manual',
            data.priority || 'normal',
            data.status || 'new',
            data.source || 'sales_brain',
            data.assignee || null,
            data.assigneeUserId || null,
            data.dueAt || null,
            data.createdByUserId || null,
            data.conversationEventId || null,
            JSON.stringify(data.metadata || {}),
        ]);
        // Scoped read-back on purpose. INSERT OR IGNORE is a no-op when taskId
        // already exists, and an unscoped SELECT would then hand back another
        // tenant's row on an id collision.
        return this.getManagerTask(data.instanceId, taskId);
    }

    getManagerTask(instanceId, taskId) {
        return this.get(
            'SELECT * FROM manager_tasks WHERE instanceId = ? AND taskId = ?',
            [instanceId, taskId],
        );
    }

    getManagerTaskByCall(instanceId, callId) {
        if (!callId) return null;
        return this.get(`
            SELECT *
            FROM manager_tasks
            WHERE instanceId = ? AND callId = ?
            ORDER BY createdAt DESC
            LIMIT 1
        `, [instanceId, callId]);
    }

    getManagerTasks(instanceId, filters = {}) {
        const status = filters.status || null;
        const callId = filters.callId || null;
        const phone = filters.phone || null;
        return this.all(`
            SELECT *
            FROM manager_tasks
            WHERE instanceId = ?
              AND (? IS NULL OR status = ?)
              AND (? IS NULL OR callId = ?)
              AND (? IS NULL OR phone = ?)
            ORDER BY createdAt DESC
            LIMIT ?
        `, [
            instanceId,
            status, status,
            callId, callId,
            phone, phone,
            Math.max(1, Math.min(Number(filters.limit) || 50, 200)),
        ]);
    }

    countManagerTasksByStatus(instanceId) {
        return this.all(`
            SELECT status, COUNT(*) AS total
            FROM manager_tasks
            WHERE instanceId = ?
            GROUP BY status
        `, [instanceId]);
    }

    updateManagerTask(instanceId, taskId, data = {}) {
        const existing = this.getManagerTask(instanceId, taskId);
        if (!existing) return null;
        const metadata = {
            ...parseJson(existing.metadataJson, {}),
            ...(data.metadata || {}),
        };
        const status = data.status !== undefined ? data.status : existing.status;
        const isClosed = status === 'done' || status === 'cancelled';
        this.run(`
            UPDATE manager_tasks
            SET status = ?,
                assignee = ?,
                assigneeUserId = ?,
                dueAt = ?,
                createdByUserId = ?,
                priority = ?,
                summary = ?,
                reason = ?,
                resolutionNote = ?,
                metadataJson = ?,
                updatedAt = CURRENT_TIMESTAMP,
                closedAt = ?
            WHERE instanceId = ? AND taskId = ?
        `, [
            status,
            data.assignee !== undefined ? (data.assignee || null) : existing.assignee,
            data.assigneeUserId !== undefined ? (data.assigneeUserId || null) : existing.assigneeUserId,
            data.dueAt !== undefined ? (data.dueAt || null) : existing.dueAt,
            data.createdByUserId !== undefined ? (data.createdByUserId || null) : existing.createdByUserId,
            data.priority !== undefined ? data.priority : existing.priority,
            data.summary !== undefined ? data.summary : existing.summary,
            data.reason !== undefined ? data.reason : existing.reason,
            data.resolutionNote !== undefined ? (data.resolutionNote || null) : existing.resolutionNote,
            JSON.stringify(metadata),
            isClosed ? (existing.closedAt || new Date().toISOString()) : null,
            instanceId,
            taskId,
        ]);
        return this.getManagerTask(instanceId, taskId);
    }

    // ─── WhatsApp follow-up drafts ────────────────────────────────────────
    // Same tenant rule as manager tasks: instanceId scopes every read, and a
    // draft can only ever be approved and sent inside its own business.

    createFollowupDraft(data = {}) {
        if (data.chatId != null) {
            const canonicalChatId = require('./client-identity.service').resolve(data.instanceId, data.chatId);
            const client = this.get('SELECT id FROM clients WHERE instanceId=? AND chatId=?', [data.instanceId, canonicalChatId]);
            data = { ...data, chatId: canonicalChatId, ...(client && canonicalChatId !== data.chatId ? { customerId: `crm_${data.instanceId}_${client.id}` } : {}) };
        }
        const draftId = data.draftId || this._id('draft');
        const text = data.text || '';
        this.run(`
            INSERT OR IGNORE INTO followup_drafts (
                draftId, instanceId, chatId, customerId, callId, managerTaskId, phone,
                originalText, text, status, source, conversationEventId, metadataJson
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            draftId,
            data.instanceId,
            data.chatId || null,
            data.customerId || null,
            data.callId || null,
            data.managerTaskId || null,
            data.phone || null,
            data.originalText !== undefined ? data.originalText : text,
            text,
            data.status || 'draft',
            data.source || 'sales_brain',
            data.conversationEventId || null,
            JSON.stringify(data.metadata || {}),
        ]);
        // Scoped read-back: INSERT OR IGNORE is a no-op on an id collision and
        // an unscoped SELECT would hand back another tenant's draft.
        return this.getFollowupDraft(data.instanceId, draftId);
    }

    getFollowupDraft(instanceId, draftId) {
        return this.get(
            'SELECT * FROM followup_drafts WHERE instanceId = ? AND draftId = ?',
            [instanceId, draftId],
        );
    }

    getFollowupDraftByCall(instanceId, callId) {
        if (!callId) return null;
        return this.get(`
            SELECT *
            FROM followup_drafts
            WHERE instanceId = ? AND callId = ?
            ORDER BY createdAt DESC
            LIMIT 1
        `, [instanceId, callId]);
    }

    getFollowupDrafts(instanceId, filters = {}) {
        const status = filters.status || null;
        const chatId = filters.chatId || null;
        const callId = filters.callId || null;
        const managerTaskId = filters.managerTaskId || null;
        return this.all(`
            SELECT *
            FROM followup_drafts
            WHERE instanceId = ?
              AND (? IS NULL OR status = ?)
              AND (? IS NULL OR chatId = ?)
              AND (? IS NULL OR callId = ?)
              AND (? IS NULL OR managerTaskId = ?)
            ORDER BY createdAt DESC
            LIMIT ?
        `, [
            instanceId,
            status, status,
            chatId, chatId,
            callId, callId,
            managerTaskId, managerTaskId,
            Math.max(1, Math.min(Number(filters.limit) || 50, 200)),
        ]);
    }

    countFollowupDraftsByStatus(instanceId) {
        return this.all(`
            SELECT status, COUNT(*) AS total
            FROM followup_drafts
            WHERE instanceId = ?
            GROUP BY status
        `, [instanceId]);
    }

    updateFollowupDraft(instanceId, draftId, data = {}) {
        const existing = this.getFollowupDraft(instanceId, draftId);
        if (!existing) return null;
        const metadata = {
            ...parseJson(existing.metadataJson, {}),
            ...(data.metadata || {}),
        };
        const pick = (key) => (data[key] !== undefined ? data[key] : existing[key]);
        this.run(`
            UPDATE followup_drafts
            SET text = ?,
                status = ?,
                approvedBy = ?,
                approvedAt = ?,
                editedBy = ?,
                editedAt = ?,
                sentAt = ?,
                failureReason = ?,
                attempts = ?,
                managerTaskId = ?,
                metadataJson = ?,
                updatedAt = CURRENT_TIMESTAMP
            WHERE instanceId = ? AND draftId = ?
        `, [
            pick('text'),
            pick('status'),
            data.approvedBy !== undefined ? (data.approvedBy || null) : existing.approvedBy,
            data.approvedAt !== undefined ? (data.approvedAt || null) : existing.approvedAt,
            data.editedBy !== undefined ? (data.editedBy || null) : existing.editedBy,
            data.editedAt !== undefined ? (data.editedAt || null) : existing.editedAt,
            data.sentAt !== undefined ? (data.sentAt || null) : existing.sentAt,
            data.failureReason !== undefined ? (data.failureReason || null) : existing.failureReason,
            data.attempts !== undefined ? Number(data.attempts || 0) : Number(existing.attempts || 0),
            data.managerTaskId !== undefined ? (data.managerTaskId || null) : existing.managerTaskId,
            JSON.stringify(metadata),
            instanceId,
            draftId,
        ]);
        return this.getFollowupDraft(instanceId, draftId);
    }

    // ─── Pilot analytics aggregates ───────────────────────────────────────
    // Counts only. These never return client rows, phone numbers or message
    // bodies, and every query is scoped to a single instanceId.

    countManagerTasksInRange(instanceId, startAt = null, endAt = null) {
        return this.all(`
            SELECT status, COUNT(*) AS total
            FROM manager_tasks
            WHERE instanceId = ?
              AND (? IS NULL OR createdAt >= ?)
              AND (? IS NULL OR createdAt <= ?)
            GROUP BY status
        `, [instanceId, startAt, startAt, endAt, endAt]);
    }

    countFollowupDraftsInRange(instanceId, startAt = null, endAt = null) {
        return this.all(`
            SELECT status, COUNT(*) AS total
            FROM followup_drafts
            WHERE instanceId = ?
              AND (? IS NULL OR createdAt >= ?)
              AND (? IS NULL OR createdAt <= ?)
            GROUP BY status
        `, [instanceId, startAt, startAt, endAt, endAt]);
    }

    // Sent is counted by delivery time, not creation time: a draft written on
    // Monday and approved on Tuesday belongs to Tuesday's numbers.
    countFollowupsSentInRange(instanceId, startAt = null, endAt = null) {
        const row = this.get(`
            SELECT COUNT(*) AS total
            FROM followup_drafts
            WHERE instanceId = ?
              AND status = 'sent'
              AND sentAt IS NOT NULL
              AND (? IS NULL OR sentAt >= ?)
              AND (? IS NULL OR sentAt <= ?)
        `, [instanceId, startAt, startAt, endAt, endAt]);
        return Number(row?.total || 0);
    }

    upsertIdentityLink(data = {}) {
        if (data.chatId != null) {
            const canonicalChatId = require('./client-identity.service').resolve(data.instanceId, data.chatId);
            const client = this.get('SELECT id FROM clients WHERE instanceId=? AND chatId=?', [data.instanceId, canonicalChatId]);
            data = { ...data, chatId: canonicalChatId, ...(client && canonicalChatId !== data.chatId ? { customerId: `crm_${data.instanceId}_${client.id}` } : {}) };
        }
        const customerId = data.customerId || this._id('cust');
        this.run(`
            INSERT INTO customer_identity_links (
                instanceId, customerId, chatId, normalizedPhone, linkType, confidence, evidenceJson
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(instanceId, linkType, normalizedPhone)
            DO UPDATE SET
                customerId = excluded.customerId,
                chatId = excluded.chatId,
                confidence = excluded.confidence,
                evidenceJson = excluded.evidenceJson,
                updatedAt = CURRENT_TIMESTAMP
        `, [
            data.instanceId,
            customerId,
            data.chatId || null,
            data.normalizedPhone || null,
            data.linkType || 'phone',
            data.confidence || 'weak',
            JSON.stringify(data.evidence || {}),
        ]);
        return this.get(`
            SELECT *
            FROM customer_identity_links
            WHERE instanceId = ? AND linkType = ? AND normalizedPhone = ?
        `, [data.instanceId, data.linkType || 'phone', data.normalizedPhone || null]);
    }

    getIdentityLinkByPhone(instanceId, normalizedPhone) {
        const identities = require('./client-identity.service');
        const canonicalChatId = identities.resolve(instanceId, normalizedPhone);
        if (canonicalChatId !== normalizedPhone) {
            const client = this.get('SELECT * FROM clients WHERE instanceId=? AND chatId=?', [instanceId, canonicalChatId]);
            if (client) return { instanceId, chatId: client.chatId, customerId: `crm_${instanceId}_${client.id}`, normalizedPhone, confidence: 'manual', linkType: 'phone' };
        }
        return this.get(`
            SELECT *
            FROM customer_identity_links
            WHERE instanceId = ? AND normalizedPhone = ?
            ORDER BY updatedAt DESC
            LIMIT 1
        `, [instanceId, normalizedPhone]);
    }

    getIdentityLinksByChat(instanceId, chatId, linkType = null) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        return this.all(`
            SELECT *
            FROM customer_identity_links
            WHERE instanceId = ?
              AND chatId = ?
              AND (? IS NULL OR linkType = ?)
            ORDER BY updatedAt DESC
        `, [instanceId, chatId, linkType, linkType]);
    }

    deleteIdentityLinksByChat(instanceId, chatId, linkType = null) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        return this.run(`
            DELETE FROM customer_identity_links
            WHERE instanceId = ?
              AND chatId = ?
              AND (? IS NULL OR linkType = ?)
        `, [instanceId, chatId, linkType, linkType]);
    }

    // --- Sales Brain outbound campaigns ---

    createOutboundCampaign(data = {}) {
        const campaignId = data.campaignId || this._id('camp');
        this.run(`
            INSERT INTO outbound_campaigns (
                campaignId, instanceId, name, sourceFilterJson, contextId, timezone,
                callWindowJson, maxAttempts, retryPolicyJson, postCallActionJson,
                enabled, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            campaignId,
            Number(data.instanceId),
            data.name || 'Untitled Sales Brain campaign',
            JSON.stringify(data.sourceFilter || data.sourceFilterJson || {}),
            data.contextId || data.context_id || 'unified_sales_agent',
            data.timezone || 'Europe/Moscow',
            JSON.stringify(data.callWindow || data.callWindowJson || {}),
            Math.max(1, Number(data.maxAttempts || data.max_attempts || 3)),
            JSON.stringify(data.retryPolicy || data.retryPolicyJson || {}),
            JSON.stringify(data.postCallAction || data.postCallActionJson || {}),
            data.enabled ? 1 : 0,
            data.status || 'draft',
        ]);
        return this.getOutboundCampaign(campaignId);
    }

    getOutboundCampaign(campaignId) {
        return this.get('SELECT * FROM outbound_campaigns WHERE campaignId = ?', [campaignId]);
    }

    listOutboundCampaigns(instanceId, options = {}) {
        const includeDisabled = Boolean(options.includeDisabled || options.include_disabled);
        const includeArchived = Boolean(options.includeArchived || options.include_archived);
        const clauses = ['instanceId = ?'];
        const params = [Number(instanceId)];
        if (!includeDisabled) clauses.push('enabled = 1');
        if (!includeArchived) clauses.push("status != 'archived'");
        return this.all(`
            SELECT *
            FROM outbound_campaigns
            WHERE ${clauses.join(' AND ')}
            ORDER BY createdAt DESC
        `, params);
    }

    updateOutboundCampaign(campaignId, data = {}) {
        const allowed = {
            name: data.name,
            sourceFilterJson: data.sourceFilter || data.source_filter ? JSON.stringify(data.sourceFilter || data.source_filter) : undefined,
            contextId: data.contextId || data.context_id,
            timezone: data.timezone,
            callWindowJson: data.callWindow || data.call_window ? JSON.stringify(data.callWindow || data.call_window) : undefined,
            maxAttempts: data.maxAttempts || data.max_attempts,
            retryPolicyJson: data.retryPolicy || data.retry_policy ? JSON.stringify(data.retryPolicy || data.retry_policy) : undefined,
            postCallActionJson: data.postCallAction || data.post_call_action ? JSON.stringify(data.postCallAction || data.post_call_action) : undefined,
            enabled: data.enabled === undefined ? undefined : (data.enabled ? 1 : 0),
            status: data.status,
        };
        const keys = Object.keys(allowed).filter((key) => allowed[key] !== undefined);
        if (keys.length === 0) return this.getOutboundCampaign(campaignId);
        keys.push('updatedAt');
        const setClause = keys.map((key) => `${key} = ?`).join(', ');
        const values = keys.map((key) => key === 'updatedAt' ? new Date().toISOString() : allowed[key]);
        values.push(campaignId);
        this.run(`UPDATE outbound_campaigns SET ${setClause} WHERE campaignId = ?`, values);
        return this.getOutboundCampaign(campaignId);
    }

    upsertOutboundLead(data = {}) {
        const leadId = data.leadId || this._id('lead');
        this.run(`
            INSERT INTO outbound_leads (
                leadId, campaignId, instanceId, chatId, customerId, phone, name,
                sourceJson, customVarsJson, state, doNotCall, nextAttemptAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(campaignId, phone)
            DO UPDATE SET
                chatId = COALESCE(excluded.chatId, outbound_leads.chatId),
                customerId = COALESCE(excluded.customerId, outbound_leads.customerId),
                name = COALESCE(excluded.name, outbound_leads.name),
                sourceJson = excluded.sourceJson,
                customVarsJson = excluded.customVarsJson,
                doNotCall = excluded.doNotCall,
                updatedAt = CURRENT_TIMESTAMP
        `, [
            leadId,
            data.campaignId,
            Number(data.instanceId),
            data.chatId || null,
            data.customerId || null,
            data.phone,
            data.name || null,
            JSON.stringify(data.source || {}),
            JSON.stringify(data.customVars || {}),
            data.state || 'pending',
            data.doNotCall ? 1 : 0,
            data.nextAttemptAt || new Date().toISOString(),
        ]);
        return this.get(`
            SELECT *
            FROM outbound_leads
            WHERE campaignId = ? AND phone = ?
        `, [data.campaignId, data.phone]);
    }

    listOutboundLeads(campaignId, options = {}) {
        const clauses = ['campaignId = ?'];
        const params = [campaignId];
        if (options.state) {
            clauses.push('state = ?');
            params.push(options.state);
        }
        return this.all(`
            SELECT *
            FROM outbound_leads
            WHERE ${clauses.join(' AND ')}
            ORDER BY createdAt DESC
            LIMIT ?
        `, [...params, Math.max(1, Math.min(Number(options.limit || 100), 5000))]);
    }

    getOutboundLead(leadId) {
        return this.get('SELECT * FROM outbound_leads WHERE leadId = ?', [leadId]);
    }

    updateOutboundLead(leadId, data = {}) {
        const allowed = {
            state: data.state,
            doNotCall: data.doNotCall === undefined ? undefined : (data.doNotCall ? 1 : 0),
            nextAttemptAt: data.nextAttemptAt,
            lastAttemptAt: data.lastAttemptAt,
            lastOutcome: data.lastOutcome,
            customVarsJson: data.customVars ? JSON.stringify(data.customVars) : undefined,
        };
        const keys = Object.keys(allowed).filter((key) => allowed[key] !== undefined);
        if (keys.length === 0) return this.get('SELECT * FROM outbound_leads WHERE leadId = ?', [leadId]);
        keys.push('updatedAt');
        const values = keys.map((key) => key === 'updatedAt' ? new Date().toISOString() : allowed[key]);
        values.push(leadId);
        this.run(`UPDATE outbound_leads SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE leadId = ?`, values);
        return this.get('SELECT * FROM outbound_leads WHERE leadId = ?', [leadId]);
    }

    getRunnableOutboundLeads(campaignId, limit = 10, nowIso = null) {
        const now = nowIso || new Date().toISOString();
        return this.all(`
            SELECT *
            FROM outbound_leads
            WHERE campaignId = ?
              AND doNotCall = 0
              AND state IN ('pending', 'retry')
              AND (nextAttemptAt IS NULL OR nextAttemptAt <= ?)
            ORDER BY nextAttemptAt ASC, createdAt ASC
            LIMIT ?
        `, [campaignId, now, Math.max(1, Math.min(Number(limit || 10), 100))]);
    }

    createOutboundAttempt(data = {}) {
        const attemptId = data.attemptId || this._id('attempt');
        const now = new Date().toISOString();
        this.run(`
            INSERT OR IGNORE INTO outbound_attempts (
                attemptId, campaignId, leadId, instanceId, callId, phone, status,
                outcome, startedAt, endedAt, durationSec, errorMessage, metadataJson
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            attemptId,
            data.campaignId,
            data.leadId || null,
            Number(data.instanceId),
            data.callId || null,
            data.phone,
            data.status || 'created',
            data.outcome || null,
            data.startedAt || now,
            data.endedAt || null,
            data.durationSec || null,
            data.errorMessage || null,
            JSON.stringify(data.metadata || {}),
        ]);
        if (data.leadId) {
            this.run(`
                UPDATE outbound_leads
                SET attemptCount = attemptCount + 1,
                    lastAttemptAt = ?,
                    lastOutcome = COALESCE(?, lastOutcome),
                    state = ?,
                    updatedAt = CURRENT_TIMESTAMP
                WHERE leadId = ?
            `, [
                data.startedAt || now,
                data.outcome || null,
                data.leadState || (data.outcome === 'answered' ? 'completed' : 'called'),
                data.leadId,
            ]);
        }
        return this.get('SELECT * FROM outbound_attempts WHERE attemptId = ?', [attemptId]);
    }

    finishOutboundAttempt(attemptId, data = {}) {
        this.run(`
            UPDATE outbound_attempts
            SET status = ?,
                outcome = ?,
                endedAt = ?,
                durationSec = ?,
                errorMessage = ?,
                metadataJson = ?,
                updatedAt = CURRENT_TIMESTAMP
            WHERE attemptId = ?
        `, [
            data.status || 'finished',
            data.outcome || null,
            data.endedAt || new Date().toISOString(),
            data.durationSec || null,
            data.errorMessage || null,
            JSON.stringify(data.metadata || {}),
            attemptId,
        ]);
        return this.get('SELECT * FROM outbound_attempts WHERE attemptId = ?', [attemptId]);
    }

    async upsertContactTime(instanceId, chatId, dayOfWeek, hourSlot, responseTimeSec) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        const existing = this.get(
            'SELECT * FROM optimal_contact_times WHERE instanceId = ? AND chatId = ? AND dayOfWeek = ? AND hourSlot = ?',
            [instanceId, chatId, dayOfWeek, hourSlot]
        );
        if (existing) {
            const newCount = existing.responseCount + 1;
            const newAvg = ((existing.avgResponseTimeSec * existing.responseCount) + responseTimeSec) / newCount;
            this.run(
                'UPDATE optimal_contact_times SET responseCount = ?, avgResponseTimeSec = ? WHERE id = ?',
                [newCount, newAvg, existing.id]
            );
        } else {
            this.run(
                'INSERT INTO optimal_contact_times (instanceId, chatId, dayOfWeek, hourSlot, responseCount, avgResponseTimeSec) VALUES (?, ?, ?, ?, 1, ?)',
                [instanceId, chatId, dayOfWeek, hourSlot, responseTimeSec]
            );
        }
    }

    async getContactTimes(instanceId, chatId) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        return this.all(
            'SELECT * FROM optimal_contact_times WHERE instanceId = ? AND chatId = ? ORDER BY responseCount DESC',
            [instanceId, chatId]
        );
    }

    // --- Smart Triggers ---

    async getTriggers(instanceId) {
        return this.all('SELECT * FROM smart_triggers WHERE instanceId = ? ORDER BY priority DESC, createdAt ASC', [instanceId]);
    }

    async getActiveTriggers(instanceId) {
        return this.all('SELECT * FROM smart_triggers WHERE instanceId = ? AND isActive = 1 ORDER BY priority DESC', [instanceId]);
    }

    async getTrigger(triggerId) {
        return this.get('SELECT * FROM smart_triggers WHERE id = ?', [triggerId]);
    }

    async createTrigger(instanceId, data) {
        this.run(
            `INSERT INTO smart_triggers (instanceId, name, triggerType, conditions, actionType, actionData, priority, maxExecutions, cooldownMinutes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [instanceId, data.name, data.triggerType, JSON.stringify(data.conditions || {}),
                data.actionType, JSON.stringify(data.actionData || {}),
                data.priority || 0, data.maxExecutions || 0, data.cooldownMinutes ?? 60]
        );
        return this.get('SELECT * FROM smart_triggers WHERE id = last_insert_rowid()');
    }

    async updateTrigger(triggerId, data) {
        const sets = [];
        const params = [];
        const fields = ['name', 'isActive', 'triggerType', 'conditions', 'actionType', 'actionData', 'priority', 'maxExecutions', 'cooldownMinutes'];
        fields.forEach(f => {
            if (data[f] !== undefined) {
                sets.push(`${f} = ?`);
                params.push(typeof data[f] === 'object' ? JSON.stringify(data[f]) : data[f]);
            }
        });
        if (sets.length === 0) return null;
        sets.push('updatedAt = CURRENT_TIMESTAMP');
        params.push(triggerId);
        this.run(`UPDATE smart_triggers SET ${sets.join(', ')} WHERE id = ?`, params);
        return this.getTrigger(triggerId);
    }

    async deleteTrigger(triggerId) {
        this.run('DELETE FROM trigger_occurrences WHERE triggerId = ?', [triggerId]);
        this.run('DELETE FROM trigger_log WHERE triggerId = ?', [triggerId]);
        this.run('DELETE FROM smart_triggers WHERE id = ?', [triggerId]);
    }

    // --- Trigger Log ---

    async claimTriggerOccurrence(instanceId, triggerId, chatId, sourceKey) {
        const token = crypto.randomUUID();
        const now = new Date().toISOString();
        const leaseExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        return this.db.transaction(() => {
            this.run(
                `INSERT OR IGNORE INTO trigger_occurrences (instanceId, triggerId, chatId, sourceKey)
                 SELECT ?, ?, ?, ? WHERE EXISTS
                 (SELECT 1 FROM smart_triggers WHERE id = ? AND instanceId = ? AND isActive = 1)`,
                [instanceId, triggerId, chatId, sourceKey, triggerId, instanceId]
            );
            const result = this.run(
                `UPDATE trigger_occurrences SET state = 'leased', leaseToken = ?, leaseExpiresAt = ?
                 WHERE instanceId = ? AND triggerId = ? AND chatId = ? AND sourceKey = ?
                   AND (state = 'pending' OR (state = 'leased' AND leaseExpiresAt <= ?))`,
                [token, leaseExpiresAt, instanceId, triggerId, chatId, sourceKey, now]
            );
            return result.changes === 1 ? token : null;
        }).immediate();
    }

    async finishTriggerOccurrence(instanceId, triggerId, chatId, sourceKey, token, outcome) {
        const state = outcome === true ? 'completed' : outcome === 'suppressed' ? 'suppressed' : 'pending';
        this.run(
            `UPDATE trigger_occurrences SET state = ?, leaseToken = NULL, leaseExpiresAt = NULL,
             completedAt = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END
             WHERE instanceId = ? AND triggerId = ? AND chatId = ? AND sourceKey = ?
               AND state = 'leased' AND leaseToken = ?`,
            [state, outcome === true ? 1 : 0,
                instanceId, triggerId, chatId, sourceKey, token]
        );
    }

    async pruneTriggerOccurrences() {
        this.run("DELETE FROM trigger_occurrences WHERE createdAt < datetime('now', '-30 days') AND state != 'leased'");
    }

    async getTriggerOccurrenceFence() {
        return this.get('SELECT scanNotBefore FROM trigger_occurrence_meta WHERE id = 1')?.scanNotBefore || null;
    }

    async logTriggerExecution(instanceId, chatId, triggerId, triggerType, actionType, details = {}) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        this.run(
            'INSERT INTO trigger_log (instanceId, chatId, triggerId, triggerType, actionType, details) VALUES (?, ?, ?, ?, ?, ?)',
            [instanceId, chatId, triggerId, triggerType, actionType, JSON.stringify(details)]
        );
    }

    async getTriggerLog(instanceId, limit = 50) {
        return this.all(
            `SELECT tl.*, st.name as triggerName FROM trigger_log tl
             LEFT JOIN smart_triggers st ON tl.triggerId = st.id
             WHERE tl.instanceId = ? ORDER BY tl.createdAt DESC LIMIT ?`,
            [instanceId, limit]
        );
    }

    async getTriggerExecutionCount(instanceId, chatId, triggerId) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        const row = this.get(
            'SELECT COUNT(*) as count FROM trigger_log WHERE instanceId = ? AND chatId = ? AND triggerId = ?',
            [instanceId, chatId, triggerId]
        );
        return row ? row.count : 0;
    }

    async getLastTriggerExecution(instanceId, chatId, triggerId) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        return this.get(
            'SELECT * FROM trigger_log WHERE instanceId = ? AND chatId = ? AND triggerId = ? ORDER BY createdAt DESC LIMIT 1',
            [instanceId, chatId, triggerId]
        );
    }

    // --- Message Sequences ---

    async getSequences(instanceId) {
        return this.all(`SELECT ms.*,
                (SELECT COUNT(*) FROM client_sequences cs
                 WHERE cs.sequenceId = ms.id AND cs.instanceId = ms.instanceId
                   AND cs.status = 'delivery_failed') AS deliveryFailureCount
                ,(SELECT COUNT(*) FROM client_sequences cs
                 WHERE cs.sequenceId = ms.id AND cs.instanceId = ms.instanceId
                   AND cs.status IN ('active','paused','delivery_failed')) AS unfinishedEnrollmentCount
            FROM message_sequences ms WHERE ms.instanceId = ? ORDER BY ms.createdAt DESC`, [instanceId]);
    }

    async getSequence(seqId) {
        return this.get('SELECT * FROM message_sequences WHERE id = ?', [seqId]);
    }

    async createSequence(instanceId, data) {
        this.run(
            'INSERT INTO message_sequences (instanceId, name, description, targetSegment, isActive) VALUES (?, ?, ?, ?, ?)',
            [instanceId, data.name, data.description || null, JSON.stringify(data.targetSegment || {}),
                data.isActive === undefined ? 1 : Number(Boolean(data.isActive))]
        );
        return this.get('SELECT * FROM message_sequences WHERE id = last_insert_rowid()');
    }

    async updateSequence(seqId, data) {
        const sets = [];
        const params = [];
        ['name', 'description', 'targetSegment', 'isActive'].forEach(f => {
            if (data[f] !== undefined) {
                sets.push(`${f} = ?`);
                params.push(f === 'isActive' ? Number(Boolean(data[f]))
                    : typeof data[f] === 'object' ? JSON.stringify(data[f]) : data[f]);
            }
        });
        if (sets.length === 0) return null;
        sets.push('updatedAt = CURRENT_TIMESTAMP');
        params.push(seqId);
        this.run(`UPDATE message_sequences SET ${sets.join(', ')} WHERE id = ?`, params);
        return this.getSequence(seqId);
    }

    async deleteSequence(seqId) {
        this.run('DELETE FROM client_sequences WHERE sequenceId = ?', [seqId]);
        this.run('DELETE FROM sequence_steps WHERE sequenceId = ?', [seqId]);
        this.run('DELETE FROM message_sequences WHERE id = ?', [seqId]);
    }

    // --- Sequence Steps ---

    async getSequenceSteps(seqId) {
        return this.all('SELECT * FROM sequence_steps WHERE sequenceId = ? ORDER BY stepOrder ASC', [seqId]);
    }

    async getSequenceUnfinishedEnrollmentCount(seqId) {
        const row = this.get(
            `SELECT COUNT(*) AS count FROM client_sequences WHERE sequenceId = ? AND status IN (${UNFINISHED_SEQUENCE_STATUSES.map(() => '?').join(',')})`,
            [seqId, ...UNFINISHED_SEQUENCE_STATUSES]
        );
        return Number(row?.count || 0);
    }

    _assertSequenceStepsMutable(seqId) {
        const row = this.get(
            `SELECT COUNT(*) AS count FROM client_sequences WHERE sequenceId = ? AND status IN (${UNFINISHED_SEQUENCE_STATUSES.map(() => '?').join(',')})`,
            [seqId, ...UNFINISHED_SEQUENCE_STATUSES]
        );
        const count = Number(row?.count || 0);
        if (count > 0) throw sequenceStepsLockedError(count);
    }

    async addSequenceStep(seqId, data) {
        return this.db.transaction(() => {
            this._assertSequenceStepsMutable(seqId);
            const maxOrder = this.get('SELECT MAX(stepOrder) as maxO FROM sequence_steps WHERE sequenceId = ?', [seqId]);
            const order = data.stepOrder || ((maxOrder?.maxO || 0) + 1);
            this.run(
                'INSERT INTO sequence_steps (sequenceId, stepOrder, delayMinutes, messageTemplate, useAiPersonalization, channelOverride) VALUES (?, ?, ?, ?, ?, ?)',
                [seqId, order, data.delayMinutes ?? 60, data.messageTemplate, data.useAiPersonalization || 0, data.channelOverride || null]
            );
            return this.get('SELECT * FROM sequence_steps WHERE id = last_insert_rowid()');
        }).immediate();
    }

    async updateSequenceStep(stepId, data) {
        return this.db.transaction(() => {
            const existing = this.get('SELECT sequenceId FROM sequence_steps WHERE id = ?', [stepId]);
            if (!existing) return null;
            this._assertSequenceStepsMutable(existing.sequenceId);
            const sets = [];
            const params = [];
            ['stepOrder', 'delayMinutes', 'messageTemplate', 'useAiPersonalization', 'channelOverride'].forEach(f => {
                if (data[f] !== undefined) {
                    sets.push(`${f} = ?`);
                    params.push(data[f]);
                }
            });
            if (sets.length === 0) return null;
            params.push(stepId);
            this.run(`UPDATE sequence_steps SET ${sets.join(', ')} WHERE id = ?`, params);
            return this.get('SELECT * FROM sequence_steps WHERE id = ?', [stepId]);
        }).immediate();
    }

    async deleteSequenceStep(stepId) {
        return this.db.transaction(() => {
            const existing = this.get('SELECT sequenceId FROM sequence_steps WHERE id = ?', [stepId]);
            if (!existing) return;
            this._assertSequenceStepsMutable(existing.sequenceId);
            this.run('DELETE FROM sequence_steps WHERE id = ?', [stepId]);
        }).immediate();
    }

    // --- Client Sequences ---

    async getActiveClientSequences() {
        return this.all(
            `SELECT cs.*, ms.name as sequenceName, ms.instanceId
             FROM client_sequences cs
             JOIN message_sequences ms ON cs.sequenceId = ms.id AND cs.instanceId = ms.instanceId
             WHERE cs.status = 'active' AND ms.isActive = 1
               AND datetime(cs.nextStepAt) <= datetime('now')`
        );
    }

    async assignClientToSequence(instanceId, chatId, sequenceId) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        return this.db.transaction(() => {
            const sequence = this.get('SELECT id, isActive FROM message_sequences WHERE id = ? AND instanceId = ?', [sequenceId, instanceId]);
            if (!sequence) {
                throw new Error('Sequence does not belong to business');
            }
            if (!sequence.isActive) {
                const error = new Error('Sequence is disabled');
                error.code = 'sequence_disabled';
                throw error;
            }
            const existing = this.get(
                "SELECT * FROM client_sequences WHERE instanceId = ? AND chatId = ? AND sequenceId = ? AND status IN ('active', 'paused', 'delivery_failed')",
                [instanceId, chatId, sequenceId]
            );
            if (existing) return existing;

            const firstStep = this.get('SELECT * FROM sequence_steps WHERE sequenceId = ? ORDER BY stepOrder ASC LIMIT 1', [sequenceId]);
            const configuredDelay = Number(firstStep?.delayMinutes);
            const delayMin = Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : 60;
            const delayParam = '+' + delayMin + ' minutes';
            this.run(
                `INSERT INTO client_sequences (instanceId, chatId, sequenceId, currentStep, status, nextStepAt)
                 VALUES (?, ?, ?, 0, 'active', datetime('now', ?))`,
                [instanceId, chatId, sequenceId, delayParam]
            );
            return this.get('SELECT * FROM client_sequences WHERE id = last_insert_rowid()');
        }).immediate();
    }

    async updateClientSequence(id, data) {
        const sets = [];
        const params = [];
        ['currentStep', 'status', 'nextStepAt', 'completedAt', 'deliveryAttemptAt', 'deliveryFailureCode', 'deliveryFailureChannel', 'deliveryFailureStep'].forEach(f => {
            if (data[f] !== undefined) {
                sets.push(`${f} = ?`);
                params.push(data[f]);
            }
        });
        if (sets.length === 0) return;
        params.push(id);
        this.run(`UPDATE client_sequences SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    async claimClientSequenceDelivery(clientSeq, channel) {
        const safeChannel = ['whatsapp', 'telegram', 'email', 'vk', 'max'].includes(channel) ? channel : 'unknown';
        // Commit an outcome-unknown state BEFORE the external call. If this process dies
        // after a provider accepts the message, the next poll must never send it again.
        const result = this.run(`UPDATE client_sequences
            SET status = 'delivery_failed', deliveryAttemptAt = CURRENT_TIMESTAMP,
                deliveryFailureCode = 'outcome_unknown', deliveryFailureChannel = ?, deliveryFailureStep = ?
            WHERE id = ? AND instanceId = ? AND sequenceId = ? AND currentStep = ?
              AND status = 'active' AND datetime(nextStepAt) <= datetime('now')
              AND EXISTS (SELECT 1 FROM message_sequences ms
                          WHERE ms.id = client_sequences.sequenceId
                            AND ms.instanceId = client_sequences.instanceId
                            AND ms.isActive = 1)`,
            [safeChannel, clientSeq.currentStep, clientSeq.id, clientSeq.instanceId,
                clientSeq.sequenceId, clientSeq.currentStep]);
        return result.changes === 1;
    }

    async recordClientSequenceDeliveryFailure(id, code) {
        const safeCode = ['send_returned_false', 'send_exception'].includes(code) ? code : 'outcome_unknown';
        this.run("UPDATE client_sequences SET deliveryFailureCode = ? WHERE id = ? AND status = 'delivery_failed'",
            [safeCode, id]);
    }

    async pauseClientSequences(instanceId, chatId) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        this.run(
            "UPDATE client_sequences SET status = 'paused' WHERE instanceId = ? AND chatId = ? AND status = 'active'",
            [instanceId, chatId]
        );
    }

    async getClientActiveSequences(instanceId, chatId) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        return this.all(
            "SELECT cs.*, ms.name as sequenceName FROM client_sequences cs JOIN message_sequences ms ON cs.sequenceId = ms.id WHERE cs.instanceId = ? AND cs.chatId = ? AND cs.status IN ('active', 'paused', 'delivery_failed') ORDER BY cs.startedAt DESC",
            [instanceId, chatId]
        );
    }

    // --- Client helpers for channels ---

    async updateClientChannel(instanceId, chatId, channel) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        this.run(
            'UPDATE clients SET preferredChannel = ?, updatedAt = CURRENT_TIMESTAMP WHERE instanceId = ? AND chatId = ?',
            [channel, instanceId, chatId]
        );
    }

    async updateClientLanguage(instanceId, chatId, language) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        this.run(
            'UPDATE clients SET detectedLanguage = ?, updatedAt = CURRENT_TIMESTAMP WHERE instanceId = ? AND chatId = ?',
            [language, instanceId, chatId]
        );
    }

    async getClientByTelegram(instanceId, telegramChatId) {
        const canonical = require('./client-identity.service').resolve(instanceId, `tg_${telegramChatId}`);
        const linked = this.get('SELECT * FROM clients WHERE instanceId=? AND chatId=?', [instanceId, canonical]);
        if (linked) return linked;
        return this.get('SELECT * FROM clients WHERE instanceId = ? AND telegramChatId = ?', [instanceId, telegramChatId]);
    }

    async getClientByEmail(instanceId, emailAddress) {
        const identity = require('./client-identity.service');
        const value = identity.normalize('email', emailAddress);
        const canonical = identity.resolve(instanceId, value);
        return this.get('SELECT * FROM clients WHERE instanceId=? AND chatId=?', [instanceId, canonical])
            || this.get('SELECT * FROM clients WHERE instanceId=? AND LOWER(emailAddress)=?', [instanceId, value]);
    }

    async getClientByVk(instanceId, vkUserId) {
        const canonical = require('./client-identity.service').resolve(instanceId, 'vk_' + vkUserId);
        return this.get('SELECT * FROM clients WHERE instanceId=? AND chatId=?', [instanceId, canonical])
            || this.get('SELECT * FROM clients WHERE instanceId=? AND vkUserId=?', [instanceId, vkUserId]);
    }

    async getClientByMax(instanceId, maxUserId) {
        const canonical = require('./client-identity.service').resolve(instanceId, 'max_' + maxUserId);
        return this.get('SELECT * FROM clients WHERE instanceId=? AND chatId=?', [instanceId, canonical])
            || this.get('SELECT * FROM clients WHERE instanceId=? AND maxUserId=?', [instanceId, maxUserId]);
    }

    async getInstanceByTelegramToken(token) {
        if (!token) return null;
        // AES-GCM uses random nonces, so an equality index cannot match the
        // encrypted value. Resolve via the transparent decrypted read path.
        return (await this.getInstances()).find(instance => instance.telegramBotToken === token) || null;
    }

    async getMessageCount(instanceId, chatId) {
        chatId = require('./client-identity.service').resolve(instanceId, chatId);
        const row = this.get('SELECT COUNT(*) as count FROM messages WHERE instanceId = ? AND chatId = ? AND role = ?', [instanceId, chatId, 'user']);
        return row ? row.count : 0;
    }

    async getSilentClientsForFollowUp(instanceId, delayHours) {
        return this.all(`
            SELECT * FROM clients
            WHERE instanceId = ?
              AND leadStatus NOT IN ('pickup_confirmed', 'ready_for_pickup', 'booked', 'junk')
              AND followUpSentAt IS NULL
              AND (
                  lastMessageTime IS NULL
                  OR (julianday('now') - julianday(lastMessageTime)) * 24 >= ?
              )
        `, [instanceId, delayHours]);
    }

    async getClientsForTrigger(instanceId, statuses = null) {
        if (statuses && statuses.length > 0) {
            const placeholders = statuses.map(() => '?').join(',');
            return this.all(
                `SELECT * FROM clients WHERE instanceId = ? AND leadStatus IN (${placeholders})`,
                [instanceId, ...statuses]
            );
        }
        return this.all('SELECT * FROM clients WHERE instanceId = ?', [instanceId]);
    }

    async getRecentStatusChanges(instanceId, minutes = 1) {
        const safeMinutes = parseInt(minutes) || 1;
        const minutesParam = '-' + safeMinutes + ' minutes';
        return this.all(
            `SELECT * FROM lead_status_history WHERE instanceId = ? AND createdAt >= datetime('now', ?)`,
            [instanceId, minutesParam]
        );
    }

    // --- Analytics: Export Leads with History ---
    async getLeadsForExport(instanceId, dateFrom = null, dateTo = null) {
        let sql = `SELECT * FROM clients WHERE instanceId = ?`;
        const params = [instanceId];

        if (dateFrom) {
            sql += ` AND createdAt >= ?`;
            params.push(dateFrom);
        }
        if (dateTo) {
            sql += ` AND createdAt <= ?`;
            params.push(dateTo + 'T23:59:59');
        }

        sql += ` ORDER BY updatedAt DESC`;
        const leads = this.all(sql, params);

        // Attach status history to each lead
        for (const lead of leads) {
            lead.statusHistory = this.all(
                `SELECT * FROM lead_status_history WHERE instanceId = ? AND chatId = ? ORDER BY createdAt ASC`,
                [instanceId, lead.chatId]
            );
        }

        return leads;
    }
    // --- KNOWLEDGE BASE (RAG) ---

    addKnowledgeBaseFile(instanceId, filename, originalName, contentHash = null, mimeType = null, fileSize = null, version = 1) {
        const stmt = this.db.prepare(`
            INSERT INTO knowledge_base (instanceId, filename, originalName, contentHash, mimeType, fileSize, version, isCurrent) 
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        `);
        try {
            const result = stmt.run(instanceId, filename, originalName, contentHash, mimeType, fileSize, version);
            return result.lastInsertRowid;
        } catch (error) {
            if (error.message && error.message.includes('UNIQUE constraint failed')) {
                const existing = this.get('SELECT id FROM knowledge_base WHERE contentHash = ? AND instanceId = ?', [contentHash, instanceId]);
                return existing ? existing.id : null;
            }
            throw error;
        }
    }

    getKnowledgeBaseByHash(instanceId, contentHash) {
        return this.get(`
            SELECT *
            FROM knowledge_base
            WHERE instanceId = ? AND contentHash = ?
            ORDER BY createdAt DESC
            LIMIT 1
        `, [instanceId, contentHash]);
    }

    getCurrentKnowledgeBaseFileByName(instanceId, originalName) {
        return this.get(`
            SELECT *
            FROM knowledge_base
            WHERE instanceId = ? AND originalName = ? AND isCurrent = 1
            ORDER BY version DESC, createdAt DESC
            LIMIT 1
        `, [instanceId, originalName]);
    }

    async getKnowledgeBaseFiles(instanceId) {
        return this.all('SELECT * FROM knowledge_base WHERE instanceId = ? AND isCurrent = 1 ORDER BY createdAt DESC', [instanceId]);
    }

    async getAllKnowledgeBaseVersions(instanceId, originalName) {
        return this.all('SELECT * FROM knowledge_base WHERE instanceId = ? AND originalName = ? ORDER BY version DESC', [instanceId, originalName]);
    }

    getAllCurrentKnowledgeBaseDocuments() {
        return this.all(`
            SELECT *
            FROM knowledge_base
            WHERE isCurrent = 1
            ORDER BY instanceId ASC, createdAt ASC
        `);
    }

    async deleteKnowledgeBaseFile(id, instanceId) {
        const transaction = this.db.transaction((kbId, ownerInstanceId) => {
            const doc = this.get(`
                SELECT id, instanceId, originalName, version, isCurrent
                FROM knowledge_base
                WHERE id = ? AND instanceId = ?
            `, [kbId, ownerInstanceId]);

            if (!doc) {
                return { deleted: 0, restoredVersion: null };
            }

            try {
                this.run(`
                    DELETE FROM kb_chunks_vec
                    WHERE chunkId IN (
                        SELECT c.id FROM kb_chunks c
                        WHERE c.kbId = ?
                    )
                `, [kbId]);
            } catch (error) {
                Logger.warn('Failed to delete vector rows for KB document:', error.message);
            }

            this.run('DELETE FROM knowledge_base WHERE id = ? AND instanceId = ?', [kbId, ownerInstanceId]);

            let restoredVersion = null;
            if (doc.isCurrent) {
                const previous = this.get(`
                    SELECT id, version
                    FROM knowledge_base
                    WHERE instanceId = ? AND originalName = ?
                    ORDER BY version DESC, createdAt DESC
                    LIMIT 1
                `, [ownerInstanceId, doc.originalName]);

                if (previous) {
                    this.run('UPDATE knowledge_base SET isCurrent = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE instanceId = ? AND originalName = ?', [
                        previous.id,
                        ownerInstanceId,
                        doc.originalName
                    ]);
                    restoredVersion = previous.version;
                }
            }

            return { deleted: 1, restoredVersion };
        });

        return transaction(id, instanceId);
    }

    async updateKnowledgeBaseStats(kbId, chunkCount, hasEmbeddings = false) {
        this.run(`
            UPDATE knowledge_base 
            SET chunkCount = ?, hasEmbeddings = ? 
            WHERE id = ?
        `, [chunkCount, hasEmbeddings ? 1 : 0, kbId]);
    }

    recalculateKnowledgeBaseStats(kbId) {
        const chunkCount = this.get('SELECT COUNT(*) as count FROM kb_chunks WHERE kbId = ?', [kbId])?.count || 0;
        let vectorCount = 0;
        try {
            vectorCount = this.get(`
                SELECT COUNT(*) as count
                FROM kb_chunks_vec
                WHERE chunkId IN (SELECT id FROM kb_chunks WHERE kbId = ?)
            `, [kbId])?.count || 0;
        } catch (error) {
            vectorCount = 0;
        }

        this.updateKnowledgeBaseStats(kbId, chunkCount, chunkCount > 0 && vectorCount >= chunkCount);
        return { chunkCount, vectorCount };
    }

    async addKnowledgeBaseChunks(kbId, chunks) {
        const stmt = this.db.prepare(`
            INSERT INTO kb_chunks (kbId, chunkIndex, text, searchText, section) 
            VALUES (?, ?, ?, ?, ?)
        `);
        const transaction = this.db.transaction((chunksArr) => {
            for (let i = 0; i < chunksArr.length; i++) {
                const chunk = chunksArr[i];
                const text = typeof chunk === 'string' ? chunk : chunk.text;
                const section = typeof chunk === 'object' ? (chunk.section || null) : null;
                const chunkIndex = typeof chunk === 'object' && Number.isInteger(chunk.chunkIndex) ? chunk.chunkIndex : i;
                stmt.run(kbId, chunkIndex, text, normalizeSearchText(text), section);
            }
        });
        transaction(chunks);
    }

    async getKnowledgeBaseChunks(instanceId) {
        return this.all(`
            SELECT c.id, c.kbId, c.chunkIndex, c.text, c.section, k.originalName
            FROM kb_chunks c
            JOIN knowledge_base k ON c.kbId = k.id
            WHERE k.instanceId = ? AND k.isCurrent = 1
            ORDER BY k.createdAt DESC, c.chunkIndex ASC
        `, [instanceId]);
    }

    async getChunksWithEmbeddings(instanceId) {
        try {
            return this.all(`
                SELECT c.id, c.kbId, c.chunkIndex, c.text, c.section, k.originalName
                FROM kb_chunks c
                JOIN kb_chunks_vec v ON c.id = v.chunkId
                JOIN knowledge_base k ON c.kbId = k.id
                WHERE k.instanceId = ? AND k.isCurrent = 1
                ORDER BY k.createdAt DESC, c.chunkIndex ASC
            `, [instanceId]);
        } catch (e) {
            return this.getKnowledgeBaseChunks(instanceId);
        }
    }

    async getChunksWithoutEmbeddings(instanceId) {
        try {
            return this.all(`
                SELECT c.id, c.kbId, c.chunkIndex, c.text, c.section, k.originalName
                FROM kb_chunks c
                JOIN knowledge_base k ON c.kbId = k.id
                WHERE k.instanceId = ? AND k.isCurrent = 1
                  AND c.id NOT IN (SELECT chunkId FROM kb_chunks_vec)
                ORDER BY c.id ASC
            `, [instanceId]);
        } catch (e) {
            return this.all(`
                SELECT c.id, c.kbId, c.chunkIndex, c.text, c.section, k.originalName
                FROM kb_chunks c
                JOIN knowledge_base k ON c.kbId = k.id
                WHERE k.instanceId = ? AND k.isCurrent = 1
                ORDER BY c.id ASC
            `, [instanceId]);
        }
    }

    getChunksForRebuild(instanceId) {
        return this.all(`
            SELECT c.id, c.kbId, c.chunkIndex, c.text, c.section, k.originalName
            FROM kb_chunks c
            JOIN knowledge_base k ON c.kbId = k.id
            WHERE k.instanceId = ? AND k.isCurrent = 1
            ORDER BY c.id ASC
        `, [instanceId]);
    }

    getChunksForKnowledgeBase(kbId) {
        return this.all(`
            SELECT c.id, c.kbId, c.chunkIndex, c.text, c.section
            FROM kb_chunks c
            WHERE c.kbId = ?
            ORDER BY c.chunkIndex ASC
        `, [kbId]);
    }

    getChunkById(instanceId, chunkId) {
        return this.get(`
            SELECT
                c.id,
                c.kbId,
                c.chunkIndex,
                c.text,
                c.searchText,
                c.section,
                k.instanceId,
                k.originalName,
                k.isCurrent
            FROM kb_chunks c
            JOIN knowledge_base k ON k.id = c.kbId
            WHERE c.id = ? AND k.instanceId = ?
            LIMIT 1
        `, [chunkId, instanceId]);
    }

    updateChunkContent(instanceId, chunkId, text, section) {
        const chunk = this.getChunkById(instanceId, chunkId);
        if (!chunk) return null;

        const searchText = normalizeSearchText(text);
        this.db.transaction(() => {
            this.run(`
                UPDATE kb_chunks
                SET text = ?, searchText = ?, section = ?
                WHERE id = ?
            `, [text, searchText, section || null, chunkId]);
            if (text !== chunk.text) this.refreshEditedKnowledgeHash(instanceId, chunk.kbId);
        }).immediate();

        return { ...chunk, text, searchText, section: section || null };
    }

    deleteChunkById(instanceId, chunkId) {
        const chunk = this.getChunkById(instanceId, chunkId);
        if (!chunk) return null;

        this.db.transaction(() => {
            try {
                this.run('DELETE FROM kb_chunks_vec WHERE chunkId = ?', [chunkId]);
            } catch (error) {
                Logger.warn('Failed to delete vector row for chunk:', error.message);
            }
            this.run('DELETE FROM kb_chunks WHERE id = ?', [chunkId]);
            this.refreshEditedKnowledgeHash(instanceId, chunk.kbId);
        }).immediate();
        return chunk;
    }

    refreshEditedKnowledgeHash(instanceId, kbId) {
        const content = this.getDocumentChunks(instanceId, kbId).map(row => row.text).join('\n\n').trim();
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        this.run('UPDATE knowledge_base SET contentHash=? WHERE id=? AND instanceId=? AND isCurrent=1',
            [hash, kbId, instanceId]);
    }

    searchChunksByFTS5(instanceId, query, k = 5) {
        try {
            const results = this.all(`
                SELECT
                    c.id,
                    c.text,
                    c.section,
                    c.kbId,
                    k.originalName,
                    bm25(kb_chunks_fts) as rawRank
                FROM kb_chunks_fts f
                JOIN kb_chunks c ON c.id = f.rowid
                JOIN knowledge_base k ON c.kbId = k.id
                WHERE f.searchText MATCH ? AND k.instanceId = ? AND k.isCurrent = 1
                ORDER BY bm25(kb_chunks_fts), c.chunkIndex ASC, c.id ASC
                LIMIT ?
            `, [query, instanceId, k]);

            return results.map((row) => ({
                ...row,
                rawRank: typeof row.rawRank === 'number' ? row.rawRank : Number.MAX_SAFE_INTEGER
            }));
        } catch (error) {
            Logger.error('searchChunksByFTS5 error:', error.message);
            return [];
        }
    }

    searchChunksByVector(instanceId, queryEmbedding, k = 5) {
        try {
            const queryVec = new Float32Array(queryEmbedding);
            const queryBuf = Buffer.from(queryVec.buffer);

            const stmt = this.db.prepare(`
                SELECT 
                    v.chunkId as id,
                    v.kbId,
                    v.originalName,
                    v.distance
                FROM kb_chunks_vec v
                WHERE v.embedding MATCH ?
                  AND k = ?
                  AND v.instanceId = ?
                ORDER BY v.distance
            `);
            const rawResults = stmt.all(queryBuf, k, instanceId);

            const filtered = [];
            for (const r of rawResults) {
                const chunk = this.get('SELECT text, section FROM kb_chunks WHERE id = ?', [r.id]);
                if (chunk) {
                    filtered.push({
                        id: r.id,
                        kbId: r.kbId,
                        originalName: r.originalName,
                        text: chunk.text,
                        section: chunk.section,
                        distance: r.distance
                    });
                }
            }

            return filtered;
        } catch (error) {
            Logger.error('searchChunksByVector error (PARTITION KEY), falling back:', error.message);
            return this._searchChunksByVectorFallback(instanceId, queryEmbedding, k);
        }
    }

    _searchChunksByVectorFallback(instanceId, queryEmbedding, k = 5) {
        try {
            const queryVec = new Float32Array(queryEmbedding);
            const queryBuf = Buffer.from(queryVec.buffer);

            const kbIds = new Set(
                this.all('SELECT id FROM knowledge_base WHERE instanceId = ? AND isCurrent = 1', [instanceId])
                    .map(r => r.id)
            );

            if (kbIds.size === 0) return [];

            const fetchK = k * 3;
            const stmt = this.db.prepare(`
                SELECT 
                    v.chunkId as id,
                    v.kbId,
                    v.originalName,
                    v.distance
                FROM kb_chunks_vec v
                WHERE v.embedding MATCH ?
                  AND v.k = ?
                ORDER BY v.distance
            `);
            const rawResults = stmt.all(queryBuf, fetchK);

            const filtered = [];
            for (const r of rawResults) {
                if (!kbIds.has(r.kbId)) continue;
                const chunk = this.get('SELECT text, section FROM kb_chunks WHERE id = ?', [r.id]);
                if (chunk) {
                    filtered.push({
                        id: r.id,
                        kbId: r.kbId,
                        originalName: r.originalName,
                        text: chunk.text,
                        section: chunk.section,
                        distance: r.distance
                    });
                }
                if (filtered.length >= k) break;
            }

            return filtered;
        } catch (error) {
            Logger.error('searchChunksByVector fallback error:', error.message);
            return [];
        }
    }

    addChunkToVectorTable(chunkId, kbId, instanceId, embedding, originalName) {
        try {
            const embeddingVec = new Float32Array(embedding);
            const embeddingBuf = Buffer.from(embeddingVec.buffer);
            const stmt = this.db.prepare(`
                INSERT INTO kb_chunks_vec (instanceId, embedding, chunkId, kbId, originalName)
                VALUES (CAST(? AS INTEGER), ?, CAST(? AS INTEGER), CAST(? AS INTEGER), ?)
            `);
            stmt.run(instanceId, embeddingBuf, chunkId, kbId, originalName);
            return true;
        } catch (error) {
            Logger.error('addChunkToVectorTable error:', error.message);
            return this._addChunkToVectorTableFallback(chunkId, kbId, instanceId, embedding, originalName);
        }
    }

    _addChunkToVectorTableFallback(chunkId, kbId, instanceId, embedding, originalName) {
        try {
            const embeddingVec = new Float32Array(embedding);
            const embeddingBuf = Buffer.from(embeddingVec.buffer);
            const stmt = this.db.prepare(`
                INSERT INTO kb_chunks_vec (instanceId, embedding, chunkId, kbId, originalName)
                VALUES (CAST(? AS INTEGER), ?, CAST(? AS INTEGER), CAST(? AS INTEGER), ?)
            `);
            stmt.run(instanceId, embeddingBuf, chunkId, kbId, originalName);
            return true;
        } catch (error) {
            Logger.error('addChunkToVectorTable fallback error:', error.message);
            return false;
        }
    }

    getDocumentChunks(instanceId, kbId) {
        return this.all(`
            SELECT c.id, c.chunkIndex, c.text, c.section
            FROM kb_chunks c
            JOIN knowledge_base k ON c.kbId = k.id
            WHERE k.instanceId = ? AND c.kbId = ? AND k.isCurrent = 1
            ORDER BY c.chunkIndex ASC
        `, [instanceId, kbId]);
    }

    logRAGSearch(instanceId, query, searchType, resultsCount, topScore, avgScore, responseTimeMs, wasUsedByAI = false) {
        const result = this.run(`
            INSERT INTO rag_search_log (instanceId, query, searchType, resultsCount, topScore, avgScore, responseTimeMs, wasUsedByAI)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [instanceId, query.substring(0, 500), searchType, resultsCount, topScore, avgScore, responseTimeMs, wasUsedByAI ? 1 : 0]);
        return result?.lastInsertRowid || null;
    }

    getRAGSearchAnalytics(instanceId) {
        try {
            const totalSearches = this.all(
                'SELECT COUNT(*) as cnt FROM rag_search_log WHERE instanceId = ?',
                [instanceId]
            )[0]?.cnt || 0;

            const avgResponseTime = this.all(
                'SELECT AVG(responseTimeMs) as avg FROM rag_search_log WHERE instanceId = ?',
                [instanceId]
            )[0]?.avg || 0;

            const aiUsedCount = this.all(
                'SELECT COUNT(*) as cnt FROM rag_search_log WHERE instanceId = ? AND wasUsedByAI = 1',
                [instanceId]
            )[0]?.cnt || 0;

            const topQueries = this.all(`
                SELECT query, COUNT(*) as count, AVG(topScore) as avgScore
                FROM rag_search_log
                WHERE instanceId = ?
                GROUP BY query
                ORDER BY count DESC
                LIMIT 10
            `, [instanceId]);

            const recentSearches = this.all(`
                SELECT query, searchType, resultsCount, topScore, responseTimeMs, wasUsedByAI, createdAt
                FROM rag_search_log
                WHERE instanceId = ?
                ORDER BY createdAt DESC
                LIMIT 20
            `, [instanceId]);

            const searchesByDay = this.all(`
                SELECT DATE(createdAt) as date, COUNT(*) as count, AVG(avgScore) as avgScore
                FROM rag_search_log
                WHERE instanceId = ? AND createdAt >= datetime('now', '-30 days')
                GROUP BY DATE(createdAt)
                ORDER BY date DESC
            `, [instanceId]);

            return {
                totalSearches,
                aiUsedCount,
                aiUseRate: totalSearches > 0 ? Math.round((aiUsedCount / totalSearches) * 100) : 0,
                avgResponseTime: Math.round(avgResponseTime),
                topQueries,
                recentSearches,
                searchesByDay
            };
        } catch (e) {
            return {
                totalSearches: 0,
                aiUsedCount: 0,
                aiUseRate: 0,
                avgResponseTime: 0,
                topQueries: [],
                recentSearches: [],
                searchesByDay: []
            };
        }
    }

    ensureVectorTable(dim) {
        try {
            const existingDim = this.getVectorTableDimensions();
            if (existingDim > 0) {
                if (existingDim === dim) {
                    return true;
                }
                Logger.info(`kb_chunks_vec dimension mismatch (DB=${existingDim}, need=${dim}), recreating...`);
                return this.recreateVectorTable(dim);
            }
            return this.recreateVectorTable(dim);
        } catch (e) {
            Logger.error('ensureVectorTable error:', e.message);
            return false;
        }
    }

    recreateVectorTable(newDim) {
        try {
            this.db.exec('DROP TABLE IF EXISTS kb_chunks_vec');
            this.db.exec(`
                CREATE VIRTUAL TABLE kb_chunks_vec USING vec0(
                    instanceId INTEGER PARTITION KEY,
                    embedding float[${newDim}],
                    +chunkId INTEGER,
                    +kbId INTEGER,
                    +originalName TEXT
                )
            `);
            Logger.success(`kb_chunks_vec recreated with float[${newDim}]`);
            return true;
        } catch (error) {
            Logger.error('recreateVectorTable error:', error.message);
            return false;
        }
    }

    // --- PAYMENTS (YooKassa) ---
    async createPayment(paymentId, instanceId, chatId, amount, description, status = 'pending') {
        const stmt = this.db.prepare('INSERT INTO payments (paymentId, instanceId, chatId, amount, status, description) VALUES (?, ?, ?, ?, ?, ?)');
        stmt.run(paymentId, instanceId, chatId, amount, status, description);
        return paymentId;
    }

    async updatePaymentStatus(paymentId, status) {
        return this.run('UPDATE payments SET status = ? WHERE paymentId = ?', [status, paymentId]);
    }

    async getPayment(paymentId) {
        return this.get('SELECT * FROM payments WHERE paymentId = ?', [paymentId]);
    }

    async getPaymentsByInstance(instanceId) {
        return this.all('SELECT * FROM payments WHERE instanceId = ? ORDER BY createdAt DESC', [instanceId]);
    }

    // --- Lead Deletion ---
    async deleteLead(instanceId, chatId) {
        const Workspace = require('./ava-workspace.store');
        const Autopilot = require('./ava-autopilot.store');
        Workspace.ensureSchema(); Autopilot.ensureSchema();
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        const Deals = require('./customer-deals.store');
        Deals.ensureSchema();
        this.db.transaction(() => {
            // Preserve deals without retaining a link to the deleted client.
            Workspace.unlinkClient(instanceId, chatId); Autopilot.unlinkClient(instanceId, chatId);
            Deals.unlinkClient(instanceId, chatId);
            // Delete all related data in correct order (due to foreign keys)
            this.run('DELETE FROM trigger_occurrences WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
            this.run('DELETE FROM trigger_log WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
            this.run('DELETE FROM client_sequences WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
            this.run('DELETE FROM optimal_contact_times WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
            this.run('DELETE FROM client_profiles WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
            this.run('DELETE FROM lead_status_history WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
            this.run('DELETE FROM messages WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
            this.run('DELETE FROM order_items WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
            this.run('DELETE FROM coffee_feedback WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
            this.run('DELETE FROM orders WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
            this.run('DELETE FROM clients WHERE instanceId = ? AND chatId = ?', [instanceId, chatId]);
        }).immediate();

        Logger.info(`[DB] Lead deleted: instanceId=${instanceId}, chatId=${chatId}`);
    }

    // ==========================================
    // ORDERS (Barista Bot)
    // ==========================================

    _normalizeOrderItems(items = []) {
        if (!Array.isArray(items)) return [];

        return items
            .map((item) => {
                if (typeof item === 'string') {
                    return { itemName: item.trim(), quantity: 1, category: null, modifiers: [], unitPrice: null, confidence: null };
                }

                const itemName = String(item?.itemName || item?.name || item?.title || item?.position || '').trim();
                if (!itemName) return null;

                const quantity = Math.max(parseInt(item?.quantity, 10) || 1, 1);
                const modifiers = Array.isArray(item?.modifiers)
                    ? item.modifiers.filter(Boolean).map(String)
                    : (item?.modifiers ? [String(item.modifiers)] : []);
                const unitPrice = Number(item?.unitPrice ?? item?.price);
                const confidence = Number(item?.confidence);

                return {
                    itemName,
                    quantity,
                    category: item?.category ? String(item.category).trim() : null,
                    modifiers,
                    unitPrice: Number.isFinite(unitPrice) ? unitPrice : null,
                    confidence: Number.isFinite(confidence) ? confidence : null
                };
            })
            .filter(Boolean);
    }

    _replaceOrderItemsSync(orderId, instanceId, chatId, items = []) {
        const normalizedItems = this._normalizeOrderItems(items);
        this.run('DELETE FROM order_items WHERE orderId = ?', [orderId]);

        if (normalizedItems.length === 0) return 0;

        const insert = this.db.prepare(`
            INSERT INTO order_items (orderId, instanceId, chatId, itemName, quantity, category, modifiers, unitPrice, confidence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const item of normalizedItems) {
            insert.run(
                orderId,
                instanceId,
                chatId,
                item.itemName,
                item.quantity,
                item.category,
                JSON.stringify(item.modifiers || []),
                item.unitPrice,
                item.confidence
            );
        }
        return normalizedItems.length;
    }

    async replaceOrderItems(orderId, items = []) {
        const order = await this.getOrder(orderId);
        if (!order) return 0;
        return this._replaceOrderItemsSync(order.id, order.instanceId, order.chatId, items);
    }

    async createOrder(instanceId, chatId, clientName, orderSummary, pickupTime = null, orderItems = []) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        const transaction = this.db.transaction(() => {
            this.run(
                'INSERT INTO orders (instanceId, chatId, clientName, orderSummary, pickupTime) VALUES (?, ?, ?, ?, ?)',
                [instanceId, chatId, clientName, orderSummary, pickupTime]
            );
            const order = this.get('SELECT * FROM orders WHERE id = last_insert_rowid()');
            this._replaceOrderItemsSync(order.id, instanceId, chatId, orderItems);
            return order;
        });
        return transaction();
    }

    async createOrderIfNew(instanceId, chatId, clientName, orderSummary, pickupTime = null, orderItems = []) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        const normalizedSummary = String(orderSummary || '').trim().replace(/\s+/g, ' ').toLowerCase();
        const normalizedPickupTime = String(pickupTime || '').trim();
        if (!normalizedSummary) return { order: null, created: false };

        const transaction = this.db.transaction(() => {
            this._expireStaleOrders(instanceId, chatId);

            const activeOrders = this.all(
                "SELECT * FROM orders WHERE instanceId = ? AND chatId = ? AND status IN ('new', 'accepted', 'ready') ORDER BY createdAt DESC",
                [instanceId, chatId]
            );
            const lockedOrder = activeOrders.find((order) => ['accepted', 'ready'].includes(order.status));
            if (lockedOrder) {
                return {
                    order: lockedOrder,
                    created: false,
                    updated: false,
                    reason: `active_order_${lockedOrder.status}`
                };
            }

            const duplicate = activeOrders.find((order) =>
                String(order.orderSummary || '').trim().replace(/\s+/g, ' ').toLowerCase() === normalizedSummary
            );

            if (duplicate) {
                if (normalizedPickupTime && duplicate.pickupTime !== normalizedPickupTime && duplicate.status === 'new') {
                    this.run(
                        'UPDATE orders SET clientName = ?, pickupTime = ? WHERE id = ?',
                        [clientName, normalizedPickupTime, duplicate.id]
                    );
                    if (Array.isArray(orderItems) && orderItems.length > 0) {
                        this._replaceOrderItemsSync(duplicate.id, instanceId, chatId, orderItems);
                    }
                    return {
                        order: this.get('SELECT * FROM orders WHERE id = ?', [duplicate.id]),
                        created: false,
                        updated: true
                    };
                }
                return { order: duplicate, created: false, updated: false };
            }

            const pendingOrder = activeOrders.find((order) => order.status === 'new');
            if (pendingOrder) {
                this.run(
                    'UPDATE orders SET clientName = ?, orderSummary = ?, pickupTime = ? WHERE id = ?',
                    [clientName, String(orderSummary).trim(), normalizedPickupTime || null, pendingOrder.id]
                );
                if (Array.isArray(orderItems) && orderItems.length > 0) {
                    this._replaceOrderItemsSync(pendingOrder.id, instanceId, chatId, orderItems);
                }
                return {
                    order: this.get('SELECT * FROM orders WHERE id = ?', [pendingOrder.id]),
                    created: false,
                    updated: true
                };
            }

            this.run(
                'INSERT INTO orders (instanceId, chatId, clientName, orderSummary, pickupTime) VALUES (?, ?, ?, ?, ?)',
                [instanceId, chatId, clientName, String(orderSummary).trim(), normalizedPickupTime || null]
            );
            const order = this.get('SELECT * FROM orders WHERE id = last_insert_rowid()');
            this._replaceOrderItemsSync(order.id, instanceId, chatId, orderItems);
            return {
                order,
                created: true,
                updated: false
            };
        });

        return transaction();
    }

    async getOrder(orderId) {
        return this.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    }

    _expireStaleOrders(instanceId, chatId = null, maxAgeHours = 12) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        const hours = Number(maxAgeHours);
        const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 12;
        const params = [instanceId];
        let chatFilter = '';
        if (chatId) {
            chatFilter = ' AND chatId = ?';
            params.push(chatId);
        }
        params.push(`-${safeHours} hours`);

        return this.run(
            `UPDATE orders
             SET status = 'expired',
                 completedAt = COALESCE(completedAt, CURRENT_TIMESTAMP)
             WHERE instanceId = ?
               ${chatFilter}
               AND status IN ('new', 'accepted', 'ready')
               AND datetime(createdAt) <= datetime('now', ?)`,
            params
        );
    }

    async expireStaleOrders(instanceId, chatId = null, maxAgeHours = 12) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        const result = this._expireStaleOrders(instanceId, chatId, maxAgeHours);
        return result.changes || 0;
    }

    async getActiveOrderForClient(instanceId, chatId) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        this._expireStaleOrders(instanceId, chatId);
        return this.get(
            `SELECT * FROM orders
             WHERE instanceId = ? AND chatId = ? AND status IN ('new', 'accepted', 'ready')
             ORDER BY CASE status WHEN 'accepted' THEN 0 WHEN 'ready' THEN 1 ELSE 2 END, datetime(createdAt) DESC
             LIMIT 1`,
            [instanceId, chatId]
        );
    }

    async getLastOrderForClient(instanceId, chatId) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        this._expireStaleOrders(instanceId, chatId);
        return this.get(
            'SELECT * FROM orders WHERE instanceId = ? AND chatId = ? ORDER BY datetime(createdAt) DESC, id DESC LIMIT 1',
            [instanceId, chatId]
        );
    }

    async getActiveOrders(instanceId) {
        this._expireStaleOrders(instanceId);
        return this.all(
            "SELECT * FROM orders WHERE instanceId = ? AND status IN ('new', 'accepted', 'ready') ORDER BY createdAt DESC",
            [instanceId]
        );
    }

    async updateOrderStatus(orderId, status, baristaChatId = null, baristaName = null) {
        const updates = ['status = ?'];
        const params = [status];

        if (status === 'accepted') {
            updates.push('acceptedAt = CURRENT_TIMESTAMP');
        } else if (status === 'ready') {
            updates.push('readyAt = CURRENT_TIMESTAMP');
        } else if (['completed', 'rejected', 'expired'].includes(status)) {
            updates.push('completedAt = CURRENT_TIMESTAMP');
        }

        if (baristaChatId) {
            updates.push('baristaChatId = ?');
            params.push(baristaChatId);
        }
        if (baristaName) {
            updates.push('baristaName = ?');
            params.push(baristaName);
        }

        params.push(orderId);
        this.run(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`, params);
        return this.getOrder(orderId);
    }

    async transitionOrderStatus(instanceId, orderId, fromStatus, toStatus, baristaChatId = null, baristaName = null) {
        const updates = ['status = ?'];
        const params = [toStatus];

        if (toStatus === 'accepted') {
            updates.push('acceptedAt = CURRENT_TIMESTAMP');
        } else if (toStatus === 'ready') {
            updates.push('readyAt = CURRENT_TIMESTAMP');
        } else if (['completed', 'rejected', 'expired'].includes(toStatus)) {
            updates.push('completedAt = CURRENT_TIMESTAMP');
        }

        if (baristaChatId) {
            updates.push('baristaChatId = ?');
            params.push(baristaChatId);
        }
        if (baristaName) {
            updates.push('baristaName = ?');
            params.push(baristaName);
        }

        params.push(instanceId, orderId, fromStatus);
        const result = this.run(
            `UPDATE orders SET ${updates.join(', ')} WHERE instanceId = ? AND id = ? AND status = ?`,
            params
        );

        return result.changes === 1 ? this.getOrder(orderId) : null;
    }

    async updateOrderTelegramMessageIds(orderId, messageIds) {
        this.run('UPDATE orders SET telegramMessageIds = ? WHERE id = ?',
            [JSON.stringify(messageIds), orderId]);
    }

    async getOrdersByClient(instanceId, chatId, limit = 20) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        const safeLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
        this._expireStaleOrders(instanceId, chatId);
        return this.all(
            'SELECT * FROM orders WHERE instanceId = ? AND chatId = ? ORDER BY datetime(createdAt) DESC, id DESC LIMIT ?',
            [instanceId, chatId, safeLimit]
        );
    }

    async getOrderStats(instanceId) {
        this._expireStaleOrders(instanceId);
        const rows = this.all(
            'SELECT status, COUNT(*) as count FROM orders WHERE instanceId = ? GROUP BY status',
            [instanceId]
        );
        const stats = { new: 0, accepted: 0, ready: 0, completed: 0, rejected: 0, expired: 0 };
        rows.forEach(r => { if (stats[r.status] !== undefined) stats[r.status] = r.count; });
        return stats;
    }

    _mapOrderItemRow(row) {
        if (!row) return row;
        let modifiers = [];
        try {
            modifiers = JSON.parse(row.modifiers || '[]');
        } catch (e) {
            modifiers = row.modifiers ? [row.modifiers] : [];
        }
        return { ...row, modifiers };
    }

    async getOrderItems(orderId) {
        return this.all('SELECT * FROM order_items WHERE orderId = ? ORDER BY id ASC', [orderId])
            .map((row) => this._mapOrderItemRow(row));
    }

    async getOrderItemsForClient(instanceId, chatId, limit = 100) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        const safeLimit = Math.min(Math.max(parseInt(limit) || 100, 1), 500);
        return this.all(
            `SELECT oi.*, o.status as orderStatus, o.pickupTime, o.createdAt as orderCreatedAt
             FROM order_items oi
             JOIN orders o ON o.id = oi.orderId
             WHERE oi.instanceId = ? AND oi.chatId = ?
             ORDER BY datetime(o.createdAt) DESC, oi.id ASC
             LIMIT ?`,
            [instanceId, chatId, safeLimit]
        ).map((row) => this._mapOrderItemRow(row));
    }

    _parseModifiersRows(rows) {
        const counts = new Map();
        for (const row of rows) {
            let modifiers = [];
            try {
                modifiers = JSON.parse(row.modifiers || '[]');
            } catch (e) {
                modifiers = row.modifiers ? [row.modifiers] : [];
            }
            for (const modifier of modifiers) {
                const key = String(modifier || '').trim();
                if (!key) continue;
                counts.set(key, (counts.get(key) || 0) + Number(row.totalQuantity || row.quantity || 1));
            }
        }
        return [...counts.entries()]
            .map(([modifier, count]) => ({ modifier, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 20);
    }

    async getCoffeeStopList(instanceId, includeInactive = false) {
        return this.all(
            `SELECT * FROM coffee_stop_list
             WHERE instanceId = ? ${includeInactive ? '' : 'AND isActive = 1'}
             ORDER BY isActive DESC, datetime(createdAt) DESC, id DESC`,
            [instanceId]
        );
    }

    async addCoffeeStopListItem(instanceId, data = {}) {
        const itemName = String(data.itemName || data.name || '').trim();
        if (!itemName) throw new Error('itemName is required');
        this.run(
            `INSERT INTO coffee_stop_list (instanceId, itemName, reason, addedBy, isActive)
             VALUES (?, ?, ?, ?, ?)`,
            [
                instanceId,
                itemName,
                data.reason ? String(data.reason).trim() : null,
                data.addedBy ? String(data.addedBy).trim() : null,
                data.isActive === false ? 0 : 1
            ]
        );
        return this.get('SELECT * FROM coffee_stop_list WHERE id = last_insert_rowid()');
    }

    async updateCoffeeStopListItem(instanceId, itemId, data = {}) {
        const fields = [];
        const params = [];
        if (data.itemName !== undefined || data.name !== undefined) {
            const itemName = String(data.itemName || data.name || '').trim();
            if (!itemName) throw new Error('itemName is required');
            fields.push('itemName = ?');
            params.push(itemName);
        }
        if (data.reason !== undefined) {
            fields.push('reason = ?');
            params.push(data.reason ? String(data.reason).trim() : null);
        }
        if (data.addedBy !== undefined) {
            fields.push('addedBy = ?');
            params.push(data.addedBy ? String(data.addedBy).trim() : null);
        }
        if (data.isActive !== undefined) {
            fields.push('isActive = ?');
            params.push(data.isActive ? 1 : 0);
        }
        if (fields.length === 0) {
            return this.get('SELECT * FROM coffee_stop_list WHERE instanceId = ? AND id = ?', [instanceId, itemId]);
        }
        fields.push('updatedAt = CURRENT_TIMESTAMP');
        params.push(instanceId, itemId);
        this.run(`UPDATE coffee_stop_list SET ${fields.join(', ')} WHERE instanceId = ? AND id = ?`, params);
        return this.get('SELECT * FROM coffee_stop_list WHERE instanceId = ? AND id = ?', [instanceId, itemId]);
    }

    async deleteCoffeeStopListItem(instanceId, itemId) {
        const result = this.run('DELETE FROM coffee_stop_list WHERE instanceId = ? AND id = ?', [instanceId, itemId]);
        return result.changes || 0;
    }

    async updateCoffeeOperationsMode(instanceId, data = {}) {
        const allowedModes = ['normal', 'busy', 'kitchen_closed', 'closed'];
        const updates = {};

        if (data.mode !== undefined || data.coffeeOperationMode !== undefined) {
            const mode = String(data.mode || data.coffeeOperationMode || '').trim();
            if (!allowedModes.includes(mode)) throw new Error(`Invalid coffee operation mode: ${mode}`);
            updates.coffeeOperationMode = mode;
        }
        for (const field of ['coffeeCafeHours', 'coffeeKitchenHours', 'coffeeFeedbackText']) {
            if (data[field] !== undefined) updates[field] = String(data[field] || '').trim();
        }
        for (const field of ['coffeePrepTimeMinutes', 'coffeeBusyPrepTimeMinutes', 'coffeeFeedbackDelayMinutes']) {
            if (data[field] !== undefined) {
                const value = parseInt(data[field], 10);
                if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid value for ${field}`);
                updates[field] = value;
            }
        }

        return this.updateInstance(instanceId, updates);
    }

    _getAvgAiResponseSeconds(instanceId) {
        const rows = this.all(
            `SELECT chatId, role, timestamp
             FROM messages
             WHERE instanceId = ? AND date(timestamp) = date('now')
             ORDER BY datetime(timestamp) ASC, id ASC
             LIMIT 1000`,
            [instanceId]
        );
        const lastUserByChat = new Map();
        const diffs = [];
        for (const row of rows) {
            if (row.role === 'user') {
                lastUserByChat.set(row.chatId, new Date(row.timestamp).getTime());
            } else if (row.role === 'assistant' && lastUserByChat.has(row.chatId)) {
                const userTime = lastUserByChat.get(row.chatId);
                const assistantTime = new Date(row.timestamp).getTime();
                const diff = (assistantTime - userTime) / 1000;
                if (Number.isFinite(diff) && diff >= 0 && diff < 3600) diffs.push(diff);
                lastUserByChat.delete(row.chatId);
            }
        }
        if (diffs.length === 0) return null;
        return Math.round(diffs.reduce((sum, value) => sum + value, 0) / diffs.length);
    }

    async getCoffeeDashboard(instanceId) {
        this._expireStaleOrders(instanceId);
        const instance = await this.getInstance(instanceId);
        const orderStatsRows = this.all(
            `SELECT status, COUNT(*) as count
             FROM orders
             WHERE instanceId = ? AND date(createdAt) = date('now')
             GROUP BY status`,
            [instanceId]
        );
        const todayOrders = { new: 0, accepted: 0, ready: 0, completed: 0, rejected: 0, expired: 0 };
        for (const row of orderStatsRows) {
            if (todayOrders[row.status] !== undefined) todayOrders[row.status] = row.count;
        }

        const messagesToday = this.get(
            "SELECT COUNT(*) as count FROM messages WHERE instanceId = ? AND role = 'user' AND date(timestamp) = date('now')",
            [instanceId]
        )?.count || 0;
        const clientsToday = this.get(
            "SELECT COUNT(DISTINCT chatId) as count FROM messages WHERE instanceId = ? AND role = 'user' AND date(timestamp) = date('now')",
            [instanceId]
        )?.count || 0;
        const repeatOrders = this.get(
            `SELECT COUNT(*) as count
             FROM orders o
             WHERE o.instanceId = ?
               AND date(o.createdAt) = date('now')
               AND EXISTS (
                   SELECT 1 FROM orders prev
                   WHERE prev.instanceId = o.instanceId
                     AND prev.chatId = o.chatId
                     AND prev.id != o.id
                     AND datetime(prev.createdAt) < datetime(o.createdAt)
               )`,
            [instanceId]
        )?.count || 0;

        const avgAcceptSeconds = this.get(
            `SELECT AVG((julianday(acceptedAt) - julianday(createdAt)) * 86400.0) as value
             FROM orders
             WHERE instanceId = ? AND acceptedAt IS NOT NULL AND date(acceptedAt) = date('now')`,
            [instanceId]
        )?.value;
        const avgPrepSeconds = this.get(
            `SELECT AVG((julianday(readyAt) - julianday(acceptedAt)) * 86400.0) as value
             FROM orders
             WHERE instanceId = ? AND readyAt IS NOT NULL AND acceptedAt IS NOT NULL AND date(readyAt) = date('now')`,
            [instanceId]
        )?.value;

        const hourlyRows = this.all(
            `SELECT hour,
                    SUM(messages) as messages,
                    SUM(orders) as orders,
                    SUM(ready) as ready
             FROM (
                 SELECT strftime('%H', timestamp) as hour, COUNT(*) as messages, 0 as orders, 0 as ready
                 FROM messages
                 WHERE instanceId = ? AND role = 'user' AND date(timestamp) = date('now')
                 GROUP BY hour
                 UNION ALL
                 SELECT strftime('%H', createdAt) as hour, 0 as messages, COUNT(*) as orders, 0 as ready
                 FROM orders
                 WHERE instanceId = ? AND date(createdAt) = date('now')
                 GROUP BY hour
                 UNION ALL
                 SELECT strftime('%H', readyAt) as hour, 0 as messages, 0 as orders, COUNT(*) as ready
                 FROM orders
                 WHERE instanceId = ? AND readyAt IS NOT NULL AND date(readyAt) = date('now')
                 GROUP BY hour
             )
             GROUP BY hour
             ORDER BY hour ASC`,
            [instanceId, instanceId, instanceId]
        );

        const popularItems = this.all(
            `SELECT itemName, category, SUM(quantity) as quantity, COUNT(DISTINCT orderId) as orders
             FROM order_items
             WHERE instanceId = ? AND date(createdAt) = date('now')
             GROUP BY itemName, category
             ORDER BY quantity DESC, orders DESC
             LIMIT 10`,
            [instanceId]
        );

        const unstructuredOrders = this.get(
            `SELECT COUNT(*) as count
             FROM orders o
             LEFT JOIN order_items oi ON oi.orderId = o.id
             WHERE o.instanceId = ? AND date(o.createdAt) = date('now') AND oi.id IS NULL`,
            [instanceId]
        )?.count || 0;

        return {
            settings: {
                mode: instance?.coffeeOperationMode || 'normal',
                cafeHours: instance?.coffeeCafeHours || '09:00-00:00',
                kitchenHours: instance?.coffeeKitchenHours || '09:00-22:00',
                prepTimeMinutes: instance?.coffeePrepTimeMinutes || 15,
                busyPrepTimeMinutes: instance?.coffeeBusyPrepTimeMinutes || 25,
                feedbackDelayMinutes: instance?.coffeeFeedbackDelayMinutes || 90
            },
            today: {
                messages: messagesToday,
                clients: clientsToday,
                ordersCreated: Object.values(todayOrders).reduce((sum, value) => sum + value, 0),
                ordersAccepted: todayOrders.accepted + todayOrders.ready + todayOrders.completed,
                ready: todayOrders.ready,
                completed: todayOrders.completed,
                rejected: todayOrders.rejected,
                expired: todayOrders.expired,
                repeatOrders,
                avgAiResponseSeconds: this._getAvgAiResponseSeconds(instanceId),
                avgBaristaAcceptSeconds: avgAcceptSeconds ? Math.round(avgAcceptSeconds) : null,
                avgPrepSeconds: avgPrepSeconds ? Math.round(avgPrepSeconds) : null
            },
            funnel: {
                inquiry: messagesToday,
                choosing: this.get("SELECT COUNT(*) as count FROM clients WHERE instanceId = ? AND leadStatus IN ('qualified', 'audit')", [instanceId])?.count || 0,
                sentToBarista: todayOrders.new,
                accepted: todayOrders.accepted,
                ready: todayOrders.ready,
                completed: todayOrders.completed
            },
            losses: {
                askedButNoOrder: Math.max(clientsToday - Object.values(todayOrders).reduce((sum, value) => sum + value, 0), 0),
                formedNotAccepted: todayOrders.new,
                rejected: todayOrders.rejected,
                expired: todayOrders.expired,
                unstructuredOrders
            },
            peakHours: hourlyRows.map((row) => ({
                hour: row.hour,
                messages: row.messages || 0,
                orders: row.orders || 0,
                ready: row.ready || 0
            })),
            popularItems,
            stopList: await this.getCoffeeStopList(instanceId)
        };
    }

    async getCoffeeOrderAnalytics(instanceId, days = 30) {
        this._expireStaleOrders(instanceId);
        const safeDays = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
        const byDay = this.all(
            `SELECT date(createdAt) as date,
                    COUNT(*) as total,
                    SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new,
                    SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted,
                    SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) as ready,
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                    SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
                    SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired
             FROM orders
             WHERE instanceId = ? AND datetime(createdAt) >= datetime('now', ?)
             GROUP BY date(createdAt)
             ORDER BY date ASC`,
            [instanceId, `-${safeDays} days`]
        );
        const active = await this.getActiveOrders(instanceId);
        const latest = this.all(
            'SELECT * FROM orders WHERE instanceId = ? ORDER BY datetime(createdAt) DESC, id DESC LIMIT 50',
            [instanceId]
        );
        return {
            byDay,
            active,
            latest,
            stats: await this.getOrderStats(instanceId)
        };
    }

    async getCoffeeItemAnalytics(instanceId, days = 30) {
        const safeDays = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
        const params = [instanceId, `-${safeDays} days`];
        const topItems = this.all(
            `SELECT itemName,
                    category,
                    SUM(quantity) as quantity,
                    COUNT(DISTINCT orderId) as orders,
                    SUM(CASE WHEN unitPrice IS NOT NULL THEN unitPrice * quantity ELSE 0 END) as revenue
             FROM order_items
             WHERE instanceId = ? AND datetime(createdAt) >= datetime('now', ?)
             GROUP BY itemName, category
             ORDER BY quantity DESC, orders DESC
             LIMIT 30`,
            params
        );
        const topCategories = this.all(
            `SELECT COALESCE(category, 'Без категории') as category,
                    SUM(quantity) as quantity,
                    COUNT(DISTINCT orderId) as orders
             FROM order_items
             WHERE instanceId = ? AND datetime(createdAt) >= datetime('now', ?)
             GROUP BY COALESCE(category, 'Без категории')
             ORDER BY quantity DESC
             LIMIT 20`,
            params
        );
        const modifierRows = this.all(
            `SELECT modifiers, SUM(quantity) as totalQuantity
             FROM order_items
             WHERE instanceId = ? AND datetime(createdAt) >= datetime('now', ?)
             GROUP BY modifiers`,
            params
        );
        const unstructuredOrders = this.get(
            `SELECT COUNT(*) as count
             FROM orders o
             LEFT JOIN order_items oi ON oi.orderId = o.id
             WHERE o.instanceId = ?
               AND datetime(o.createdAt) >= datetime('now', ?)
               AND oi.id IS NULL`,
            params
        )?.count || 0;
        return {
            topItems,
            topCategories,
            topModifiers: this._parseModifiersRows(modifierRows),
            unstructuredOrders
        };
    }

    _extractPickupHour(pickupTime) {
        const text = String(pickupTime || '');
        const match = text.match(/(?:к\s*)?(\d{1,2})(?::|\.| )?(\d{2})?/i);
        if (!match) return null;
        const hour = parseInt(match[1], 10);
        return hour >= 0 && hour <= 23 ? hour : null;
    }

    async getCoffeeClientInsights(instanceId, chatId) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        const client = await this.getClient(instanceId, chatId);
        const orders = await this.getOrdersByClient(instanceId, chatId, 100);
        const items = await this.getOrderItemsForClient(instanceId, chatId, 500);
        const feedback = this.all(
            `SELECT * FROM coffee_feedback
             WHERE instanceId = ? AND chatId = ?
             ORDER BY datetime(createdAt) DESC
             LIMIT 20`,
            [instanceId, chatId]
        );

        const completedOrders = orders.filter((order) => order.status === 'completed');
        const firstOrder = orders.length ? orders[orders.length - 1] : null;
        const lastOrder = orders.length ? orders[0] : null;
        const successfulOrders = orders.filter((order) => ['accepted', 'ready', 'completed'].includes(order.status));

        const favoriteMap = new Map();
        const categoryMap = new Map();
        let knownRevenue = 0;
        for (const item of items) {
            const quantity = Number(item.quantity || 1);
            favoriteMap.set(item.itemName, (favoriteMap.get(item.itemName) || 0) + quantity);
            const category = item.category || 'Без категории';
            categoryMap.set(category, (categoryMap.get(category) || 0) + quantity);
            if (item.unitPrice !== null && item.unitPrice !== undefined) {
                knownRevenue += Number(item.unitPrice) * quantity;
            }
        }

        const favoriteItems = [...favoriteMap.entries()]
            .map(([itemName, quantity]) => ({ itemName, quantity }))
            .sort((a, b) => b.quantity - a.quantity)
            .slice(0, 5);
        const categoryShare = [...categoryMap.entries()]
            .map(([category, quantity]) => ({ category, quantity }))
            .sort((a, b) => b.quantity - a.quantity);

        const pickupHours = orders.map((order) => this._extractPickupHour(order.pickupTime)).filter((hour) => hour !== null);
        const favoritePickupHour = pickupHours.length
            ? Math.round(pickupHours.reduce((sum, hour) => sum + hour, 0) / pickupHours.length)
            : null;

        const negativeFeedbacks = feedback.filter((row) => ['negative', 'problem'].includes(row.sentiment));
        const segments = [];
        if (orders.length === 0) segments.push('new_guest');
        if (orders.length > 1) segments.push('repeat_guest');
        if (orders.length >= 5) segments.push('regular_guest');
        if (negativeFeedbacks.length > 0) segments.push('unhappy_guest');
        if (categoryShare.some((row) => /кофе|coffee/i.test(row.category))) segments.push('loves_coffee');
        if (categoryShare.some((row) => /еда|завтрак|салат|десерт|food/i.test(row.category))) segments.push('orders_food');
        if (favoritePickupHour !== null && favoritePickupHour >= 18) segments.push('evening_guest');

        const aiNote = favoriteItems.length
            ? `В следующий раз можно предложить ${favoriteItems[0].itemName}${favoritePickupHour !== null ? ` примерно к ${String(favoritePickupHour).padStart(2, '0')}:00` : ''}.`
            : 'Пока мало данных: сначала уточнить предпочтения и не навязывать позиции.';

        return {
            client,
            ordersCount: orders.length,
            successfulOrdersCount: successfulOrders.length,
            completedOrdersCount: completedOrders.length,
            firstOrder,
            lastOrder,
            isRepeat: orders.length > 1,
            returnsCount: Math.max(orders.length - 1, 0),
            favoriteItems,
            favoritePickupHour,
            averageCheck: completedOrders.length > 0 && knownRevenue > 0 ? Math.round(knownRevenue / completedOrders.length) : null,
            ltv: knownRevenue > 0 ? Math.round(knownRevenue) : null,
            categoryShare,
            negativeFeedbacks,
            segments,
            aiNote,
            feedback,
            orders: orders.slice(0, 20)
        };
    }

    async getDueCoffeeFeedbackOrders(limit = 50) {
        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        return this.all(
            `SELECT o.*, i.coffeeFeedbackText, i.coffeeFeedbackDelayMinutes
             FROM orders o
             JOIN instances i ON i.id = o.instanceId
             WHERE o.status = 'completed'
               AND o.feedbackSentAt IS NULL
               AND o.completedAt IS NOT NULL
               AND (i.salesGoal = 'coffee_pickup' OR i.businessType = 'coffee_shop')
               AND datetime(o.completedAt) <= datetime('now', '-' || COALESCE(i.coffeeFeedbackDelayMinutes, 90) || ' minutes')
             ORDER BY datetime(o.completedAt) ASC
             LIMIT ?`,
            [safeLimit]
        );
    }

    async markOrderFeedbackSent(orderId) {
        this.run('UPDATE orders SET feedbackSentAt = CURRENT_TIMESTAMP WHERE id = ?', [orderId]);
        return this.getOrder(orderId);
    }

    async getLatestFeedbackCandidate(instanceId, chatId) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        return this.get(
            `SELECT *
             FROM orders
             WHERE instanceId = ?
               AND chatId = ?
               AND status = 'completed'
               AND feedbackSentAt IS NOT NULL
               AND datetime(feedbackSentAt) >= datetime('now', '-24 hours')
             ORDER BY datetime(feedbackSentAt) DESC, id DESC
             LIMIT 1`,
            [instanceId, chatId]
        );
    }

    async saveCoffeeFeedback(instanceId, chatId, orderId, sentiment, text) {
        if (chatId != null) chatId = require('./client-identity.service').resolve(instanceId, chatId);
        this.run(
            `INSERT INTO coffee_feedback (instanceId, chatId, orderId, sentiment, text)
             VALUES (?, ?, ?, ?, ?)`,
            [instanceId, chatId, orderId || null, sentiment || 'neutral', String(text || '').trim()]
        );
        return this.get('SELECT * FROM coffee_feedback WHERE id = last_insert_rowid()');
    }

    // ==========================================
    // BARISTA STAFF
    // ==========================================

    async addBaristaStaff(instanceId, telegramChatId, name) {
        this.run(
            'INSERT OR REPLACE INTO barista_staff (instanceId, telegramChatId, name, isActive) VALUES (?, ?, ?, 1)',
            [instanceId, telegramChatId, name]
        );
        return this.get('SELECT * FROM barista_staff WHERE instanceId = ? AND telegramChatId = ?',
            [instanceId, telegramChatId]);
    }

    async getBaristaStaff(instanceId) {
        return this.all(
            'SELECT * FROM barista_staff WHERE instanceId = ? AND isActive = 1',
            [instanceId]
        );
    }

    async getBaristaStaffMember(instanceId, telegramChatId) {
        return this.get(
            'SELECT * FROM barista_staff WHERE instanceId = ? AND telegramChatId = ? AND isActive = 1',
            [instanceId, telegramChatId]
        );
    }

    async removeBaristaStaff(instanceId, telegramChatId) {
        this.run(
            'UPDATE barista_staff SET isActive = 0 WHERE instanceId = ? AND telegramChatId = ?',
            [instanceId, telegramChatId]
        );
    }

    async findBaristaInstance(telegramChatId) {
        return this.get(
            'SELECT bs.*, i.name as instanceName FROM barista_staff bs JOIN instances i ON bs.instanceId = i.id WHERE bs.telegramChatId = ? AND bs.isActive = 1',
            [telegramChatId]
        );
    }
}

module.exports = new DatabaseService();
