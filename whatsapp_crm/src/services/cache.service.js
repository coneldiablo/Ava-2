const Logger = require('../utils/logger');
const config = require('../config');

let redis = null;
let redisAvailable = false;

try {
    const Redis = require('ioredis');
    redis = new Redis({
        host: config.redis.host,
        port: config.redis.port,
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy(times) {
            if (times > 1) return null;
            return 250;
        }
    });

    redis.on('error', (err) => {
        if (redisAvailable) {
            Logger.warn(`Redis error: ${err.message}`);
        }
        redisAvailable = false;
    });

    redis.on('connect', () => {
        redisAvailable = true;
        Logger.success('Redis connected for embedding cache');
    });

    redis.connect().catch(() => {
        Logger.warn('Redis connection failed, using in-memory cache fallback');
        redisAvailable = false;
    });
} catch (e) {
    Logger.warn('ioredis not available, using in-memory cache');
    redisAvailable = false;
}

const memoryCache = new Map();
const MAX_MEMORY_CACHE_SIZE = 1000;

class CacheService {
    async getEmbedding(key) {
        if (redisAvailable && redis && redis.status === 'ready') {
            try {
                const cached = await redis.get(`emb:${key}`);
                if (cached) {
                    return JSON.parse(cached);
                }
            } catch (e) {
                // fallback to memory
            }
        }

        if (memoryCache.has(key)) {
            return memoryCache.get(key);
        }

        return null;
    }

    async setEmbedding(key, value, ttl = 86400 * 7) {
        if (redisAvailable && redis && redis.status === 'ready') {
            try {
                await redis.set(`emb:${key}`, JSON.stringify(value), 'EX', ttl);
                return;
            } catch (e) {
                // fallback to memory
            }
        }

        if (memoryCache.size >= MAX_MEMORY_CACHE_SIZE) {
            const firstKey = memoryCache.keys().next().value;
            memoryCache.delete(firstKey);
        }
        memoryCache.set(key, value);
    }

    async deleteEmbedding(key) {
        if (redisAvailable && redis && redis.status === 'ready') {
            try {
                await redis.del(`emb:${key}`);
            } catch (e) { }
        }
        memoryCache.delete(key);
    }

    async clearAll() {
        if (redisAvailable && redis && redis.status === 'ready') {
            try {
                const keys = await redis.keys('emb:*');
                if (keys.length > 0) {
                    await redis.del(...keys);
                }
            } catch (e) { }
        }
        memoryCache.clear();
    }

    isRedisAvailable() {
        return redisAvailable;
    }
}

module.exports = new CacheService();
