const express = require('express');
const PmsService = require('../services/pms/pms.service');
const Logger = require('../utils/logger');

const router = express.Router();

router.post('/bnovo/webhooks/:opaqueToken', express.json({ limit: '128kb' }), (req, res) => {
    try {
        const result = PmsService.handleWebhook(req.params.opaqueToken, req.body || {});
        res.status(202).json(result);
    } catch (error) {
        Logger.warn(`[Bnovo webhook] ${error.code || 'error'}: ${error.message}`);
        res.status(error.statusCode || 500).json({
            accepted: false,
            error: error.code || 'PMS_WEBHOOK_ERROR',
        });
    }
});

module.exports = router;
