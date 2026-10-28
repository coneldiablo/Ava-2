const express = require('express');
const { once } = require('events');
const { OnyxLlmGateway } = require('../services/onyx-llm-gateway.service');

function createOnyxLlmRouter(gateway = new OnyxLlmGateway()) {
    const router = express.Router();
    router.get('/onyx/llm/v1/models', (req, res) => {
        try {
            const business = gateway.authenticate(req.get('authorization'));
            res.json({ object: 'list', data: [{ id: `ava-hotel-${business.id}`, object: 'model', owned_by: 'ava' }] });
        } catch (error) {
            res.status(error.status || 500).json({ error: { code: error.code || 'ONYX_LLM_ERROR', message: 'LLM gateway unavailable' } });
        }
    });
    router.post('/onyx/llm/v1/chat/completions', async (req, res) => {
        const controller = new AbortController();
        const close = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', close);
        try {
            const result = await gateway.complete(req.get('authorization'), req.body, {
                signal: controller.signal,
                onChunk: async (chunk, requestId) => {
                    if (controller.signal.aborted) throw Object.assign(new Error('Disconnected'), { name: 'AbortError' });
                    if (!res.headersSent) {
                        res.setHeader('Content-Type', 'text/event-stream');
                        res.setHeader('Cache-Control', 'no-cache, no-transform');
                        res.setHeader('X-Accel-Buffering', 'no');
                        res.setHeader('X-Request-ID', requestId);
                    }
                    if (!res.write(`data: ${JSON.stringify(chunk)}\n\n`)) await once(res, 'drain', { signal: controller.signal });
                },
            });
            if (result.streamed) res.end('data: [DONE]\n\n');
            else res.setHeader('X-Request-ID', result.requestId).json(result.result);
        } catch (error) {
            const payload = { error: { code: error.code || 'ONYX_LLM_ERROR', message: 'LLM gateway request failed' } };
            if (!res.headersSent) res.status(error.status || 502).json(payload);
            else if (!res.destroyed) res.end(`data: ${JSON.stringify(payload)}\n\n`);
        } finally {
            res.off('close', close);
        }
    });
    return router;
}

module.exports = createOnyxLlmRouter;
