const Logger = require('../utils/logger');
const OpenWaService = require('./openwa.service');
const GreenApiService = require('./green-api.service');

class WhatsAppGatewayService {
    /**
     * Determine gateway capability & configuration for an instance.
     */
    getConfig(instance) {
        if (!instance) return { hasOpenWa: false, hasGreenApi: false, mode: 'openwa' };
        const hasOpenWa = Boolean(instance.openWaSessionId);
        const hasGreenApi = Boolean(instance.greenApiInstance && instance.greenApiToken);
        const mode = instance.whatsappProvider || 'openwa'; // 'openwa' | 'green_api' | 'auto' | 'hybrid'
        return { hasOpenWa, hasGreenApi, mode };
    }

    /**
     * Send a WhatsApp message with automatic OpenWA -> GreenAPI fallback.
     * 
     * @param {Object} instanceConfig - Instance row from database
     * @param {string} chatId - Target WhatsApp chatId (e.g. 79991234567@c.us)
     * @param {string} message - Message text
     * @returns {Promise<{success: boolean, gateway: string, fallback?: boolean, data?: any, error?: string}>}
     */
    async sendMessage(instanceConfig, chatId, message, context = null) {
        const rejected = { success: false, code: 'WHATSAPP_NOT_CONFIGURED', safeToRetry: true };
        if (!instanceConfig) return rejected;
        const { hasOpenWa, hasGreenApi, mode } = this.getConfig(instanceConfig);
        const normalize = (result, gateway, fallback = false) => {
            // HTTP 2xx alone is not a provider acceptance proof.
            const ack = result?.data?.idMessage || result?.data?.messageId || result?.data?.id;
            if (result?.success && typeof ack === 'string' && ack.length) {
                return { success: true, gateway, fallback, data: result.data };
            }
            return { success: false, gateway, fallback, code: 'WHATSAPP_SEND_ACK_UNKNOWN',
                safeToRetry: result?.safeToRetry === true || (!result?.success && [401,403,404].includes(result?.statusCode)),
                statusCode: result?.statusCode };
        };
        const greenSend = async fallback => {
            if (!hasGreenApi) return { ...rejected, gateway: 'green_api' };
            if (typeof context?.beforeSend === 'function') { const guard = context.beforeSend(); if (guard?.then) await guard; }
            try { return normalize(await GreenApiService.sendMessage(instanceConfig.greenApiInstance,
                instanceConfig.greenApiToken, instanceConfig.greenApiUrl, chatId, message), 'green_api', fallback); }
            catch (_) { return { success: false, gateway: 'green_api', fallback, code: 'WHATSAPP_SEND_ACK_UNKNOWN', safeToRetry: false }; }
        };
        if (mode === 'green_api') return greenSend(false);
        if (hasOpenWa) {
            let result;
            if (typeof context?.beforeSend === 'function') { const guard = context.beforeSend(); if (guard?.then) await guard; }
            try { result = normalize(await OpenWaService.sendMessage(instanceConfig.openWaUrl,
                instanceConfig.openWaApiKey, instanceConfig.openWaSessionId, chatId, message), 'openwa'); }
            catch (_) { result = { success: false, gateway: 'openwa', code: 'WHATSAPP_SEND_ACK_UNKNOWN', safeToRetry: false }; }
            if (result.success) return result;
            Logger.warn(`[WhatsAppGateway] Primary send failed for instance ${instanceConfig.id}: ${result.code}`);
            // A timeout/5xx may occur after acceptance. Switching transports
            // then creates a duplicate reply. Only a proven unsent request may fall back.
            if (!result.safeToRetry || mode === 'only_openwa') return result;
        }
        if (hasGreenApi && mode !== 'only_openwa') return greenSend(hasOpenWa);
        return { ...rejected, gateway: 'openwa' };
    }

    /**
     * Get combined state for both OpenWA and GreenAPI.
     */
    async getState(instanceConfig, force = false) {
        if (!instanceConfig) {
            return { success: false, error: 'Instance not found' };
        }

        const { hasOpenWa, hasGreenApi, mode } = this.getConfig(instanceConfig);

        let openWaState = { configured: hasOpenWa, state: hasOpenWa ? 'unknown' : 'notConfigured' };
        let greenApiState = { configured: hasGreenApi, state: hasGreenApi ? 'unknown' : 'notConfigured' };

        if (hasOpenWa) {
            const res = await OpenWaService.getState(
                instanceConfig.openWaUrl,
                instanceConfig.openWaApiKey,
                instanceConfig.openWaSessionId
            );
            if (res.success) {
                openWaState = {
                    configured: true,
                    state: res.data.stateInstance,
                    rawStatus: res.data.rawStatus,
                    phone: res.data.phone,
                    pushName: res.data.pushName,
                    engineLoaded: res.data.engineLoaded
                };
            } else {
                openWaState = {
                    configured: true,
                    state: 'error',
                    error: res.error
                };
            }
        }

        if (hasGreenApi) {
            const res = await GreenApiService.getStateInstance(
                instanceConfig.greenApiInstance,
                instanceConfig.greenApiToken,
                instanceConfig.greenApiUrl
            );
            if (res.success) {
                greenApiState = {
                    configured: true,
                    state: res.data?.stateInstance || 'unknown'
                };
            } else {
                greenApiState = {
                    configured: true,
                    state: 'error',
                    error: res.error
                };
            }
        }

        // Active state resolution based on current mode
        let effectiveState = 'notConfigured';
        let activeGateway = 'none';

        if (mode === 'green_api') {
            effectiveState = greenApiState.state;
            activeGateway = 'green_api';
        } else {
            // OpenWA is primary
            if (openWaState.state === 'authorized') {
                effectiveState = 'authorized';
                activeGateway = 'openwa';
            } else if (mode !== 'only_openwa' && greenApiState.state === 'authorized') {
                // OpenWA not ready, but fallback GreenAPI is authorized!
                effectiveState = 'authorized';
                activeGateway = 'green_api (fallback ready)';
            } else {
                effectiveState = openWaState.state !== 'notConfigured' ? openWaState.state : greenApiState.state;
                activeGateway = hasOpenWa ? 'openwa' : (hasGreenApi ? 'green_api' : 'none');
            }
        }

        return {
            success: true,
            effectiveState,
            activeGateway,
            mode,
            openwa: openWaState,
            greenApi: greenApiState
        };
    }
}

module.exports = new WhatsAppGatewayService();
