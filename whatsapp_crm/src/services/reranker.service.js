const axios = require('axios');
const config = require('../config');
const Logger = require('../utils/logger');

class RerankerService {
    constructor() {
        this.apiKey = config.cohere.apiKey;
        this.enabled = config.cohere.rerankingEnabled && !!this.apiKey;
    }

    async rerank(query, documents, topN = 5) {
        if (!this.enabled) {
            throw new Error('Reranking is disabled or API key not set');
        }

        if (!documents || documents.length === 0) {
            return [];
        }

        try {
            const response = await axios.post('https://api.cohere.com/v2/rerank', {
                model: 'rerank-v4.0-pro',
                query,
                documents,
                top_n: Math.min(topN, documents.length)
            }, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            });

            if (response.data && response.data.results) {
                return response.data.results.map(r => ({
                    index: r.index,
                    relevance_score: r.relevance_score
                }));
            }

            throw new Error('Invalid rerank response');
        } catch (error) {
            Logger.error('Cohere rerank error:', error.message);
            throw error;
        }
    }
}

module.exports = new RerankerService();
