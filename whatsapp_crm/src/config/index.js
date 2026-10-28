require('dotenv').config();

const batchMs = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const firstConfiguredText = (...values) => values.map(value => String(value || '').trim()).find(Boolean) || '';

module.exports = {
  port: process.env.PORT || 3000,
  env: process.env.NODE_ENV || 'development',

  aiTunnel: {
    apiKey: firstConfiguredText(process.env.AITUNNEL_API_KEY, process.env.AI_TUNNEL_API_KEY, process.env.YANDEX_GPT_API_KEY),
    apiUrl: firstConfiguredText(process.env.AITUNNEL_API_URL, process.env.AI_TUNNEL_API_URL) || 'https://api.aitunnel.ru/v1',
    model: firstConfiguredText(process.env.AITUNNEL_MODEL, process.env.AI_TUNNEL_MODEL, process.env.YANDEX_GPT_MODEL_URI) || 'gpt-oss-120b',
  },

  embeddings: {
    provider: process.env.EMBEDDINGS_PROVIDER || 'aitunnel',
    apiUrl: process.env.EMBEDDINGS_API_URL || 'https://api.aitunnel.ru/v1',
    apiKey: process.env.EMBEDDINGS_API_KEY || '',
    model: process.env.EMBEDDINGS_MODEL || 'gigachat-embeddings-giga-r',
    dimensions: parseInt(process.env.EMBEDDINGS_DIMENSIONS) || 0,
  },

  cohere: {
    apiKey: process.env.COHERE_API_KEY || '',
    rerankingEnabled: process.env.RERANKING_ENABLED !== 'false',
  },

  rag: {
    minConfidence: parseFloat(process.env.RAG_MIN_CONFIDENCE) || 0.3,
    hydeEnabled: process.env.HYDE_ENABLED !== 'false',
    ocrEnabled: process.env.OCR_ENABLED !== 'false',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
  },

  auth: {
    enabled: process.env.AUTH_ENABLED !== 'false',
    adminLogin: process.env.ADMIN_LOGIN || '',
    adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
    sessionSecret: process.env.SESSION_SECRET || '',
    sessionTtlHours: Math.max(1, parseInt(process.env.SESSION_TTL_HOURS) || 24),
  },

  avaAdmin: {
    apiUrl: (process.env.AVA_ADMIN_API_URL || 'http://127.0.0.1:3003').replace(/\/+$/, ''),
    serviceToken: process.env.CRM_SERVICE_API_TOKEN || '',
    timeoutMs: Math.max(1000, parseInt(process.env.AVA_ADMIN_TIMEOUT_MS) || 15000),
  },

  messageBatching: {
    idleMs: Math.max(0, batchMs(process.env.AI_BATCH_IDLE_MS, 9000)),
    shortIdleMs: Math.max(0, batchMs(process.env.AI_BATCH_SHORT_IDLE_MS, 18000)),
    maxMs: Math.max(1, batchMs(process.env.AI_BATCH_MAX_MS, 30000)),
  },
  whatsappMessageBatching: {
    idleMs: Math.max(0, batchMs(process.env.WHATSAPP_BATCH_IDLE_MS, 1500)),
    shortIdleMs: Math.max(0, batchMs(process.env.WHATSAPP_BATCH_SHORT_IDLE_MS, 3500)),
    maxMs: Math.max(1, batchMs(process.env.WHATSAPP_BATCH_MAX_MS, 6000)),
  },
  whatsappOnyx: {
    waitMs: Math.max(1, Math.min(65000, batchMs(process.env.WHATSAPP_ONYX_WAIT_MS, 6000))),
    hedgeMs: Math.max(0, Math.min(65000, batchMs(process.env.WHATSAPP_ONYX_HEDGE_MS, 3000))),
  },
};
