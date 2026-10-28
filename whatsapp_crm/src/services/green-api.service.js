const axios = require('axios');
const Logger = require('../utils/logger');

const DEFAULT_API_URL = 'https://api.green-api.com';

class GreenApiService {
    /**
     * Build base URL for GREEN-API calls.
     * @param {string} apiUrl - base API URL (e.g. https://7103.api.green-api.com)
     * @param {string} idInstance - instance ID
     * @param {string} method - API method name
     * @param {string} apiToken - API token
     */
    _url(apiUrl, idInstance, method, apiToken) {
        const base = (apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
        return `${base}/waInstance${idInstance}/${method}/${apiToken}`;
    }

    /**
     * Get instance authorization state.
     * Returns: { stateInstance: "authorized" | "notAuthorized" | "blocked" | "starting" | "yellowCard" | "sleepMode" }
     */
    async getStateInstance(idInstance, apiToken, apiUrl) {
        const url = this._url(apiUrl, idInstance, 'getStateInstance', apiToken);
        Logger.info(`[GREEN-API] getStateInstance for ${idInstance}`);
        try {
            const res = await axios.get(url, { timeout: 10000 });
            return { success: true, data: res.data };
        } catch (err) {
            Logger.error(`[GREEN-API] getStateInstance failed:`, err.response?.data || err.message);
            return { success: false, error: err.response?.data?.message || err.message };
        }
    }

    /**
     * Get QR code for WhatsApp authorization.
     * Returns: { type: "qrCode", message: "<base64>" } or { type: "alreadyLogged" } or { type: "error" }
     */
    async getQR(idInstance, apiToken, apiUrl) {
        const url = this._url(apiUrl, idInstance, 'qr', apiToken);
        Logger.info(`[GREEN-API] getQR for ${idInstance}`);
        try {
            const res = await axios.get(url, { timeout: 15000 });
            return { success: true, data: res.data };
        } catch (err) {
            Logger.error(`[GREEN-API] getQR failed:`, err.response?.data || err.message);
            return { success: false, error: err.response?.data?.message || err.message };
        }
    }

    /**
     * Configure instance settings (webhook URL, notification types, etc.).
     */
    async setSettings(idInstance, apiToken, apiUrl, settings) {
        const url = this._url(apiUrl, idInstance, 'setSettings', apiToken);
        Logger.info(`[GREEN-API] setSettings for ${idInstance}`, settings);
        try {
            const res = await axios.post(url, settings, { timeout: 10000 });
            return { success: true, data: res.data };
        } catch (err) {
            Logger.error(`[GREEN-API] setSettings failed:`, err.response?.data || err.message);
            return { success: false, error: err.response?.data?.message || err.message };
        }
    }

    /**
     * Send a text message.
     */
    async sendMessage(idInstance, apiToken, apiUrl, chatId, message) {
        const url = this._url(apiUrl, idInstance, 'sendMessage', apiToken);
        try {
            const res = await axios.post(url, { chatId, message }, { timeout: 15000 });
            return { success: true, data: res.data };
        } catch (err) {
            Logger.error(`[GREEN-API] sendMessage failed:`, err.response?.data || err.message);
            return { success: false, error: err.response?.data?.message || err.message };
        }
    }

    /**
     * Logout (disconnect) WhatsApp account from instance.
     */
    async logout(idInstance, apiToken, apiUrl) {
        const url = this._url(apiUrl, idInstance, 'logout', apiToken);
        Logger.info(`[GREEN-API] logout for ${idInstance}`);
        try {
            const res = await axios.get(url, { timeout: 10000 });
            return { success: true, data: res.data };
        } catch (err) {
            Logger.error(`[GREEN-API] logout failed:`, err.response?.data || err.message);
            return { success: false, error: err.response?.data?.message || err.message };
        }
    }

    /**
     * Reboot instance.
     */
    async reboot(idInstance, apiToken, apiUrl) {
        const url = this._url(apiUrl, idInstance, 'reboot', apiToken);
        Logger.info(`[GREEN-API] reboot for ${idInstance}`);
        try {
            const res = await axios.get(url, { timeout: 10000 });
            return { success: true, data: res.data };
        } catch (err) {
            Logger.error(`[GREEN-API] reboot failed:`, err.response?.data || err.message);
            return { success: false, error: err.response?.data?.message || err.message };
        }
    }

    /**
     * Get WhatsApp account info (phone number, avatar, etc.).
     */
    async getWaSettings(idInstance, apiToken, apiUrl) {
        const url = this._url(apiUrl, idInstance, 'getWaSettings', apiToken);
        Logger.info(`[GREEN-API] getWaSettings for ${idInstance}`);
        try {
            const res = await axios.get(url, { timeout: 10000 });
            return { success: true, data: res.data };
        } catch (err) {
            Logger.error(`[GREEN-API] getWaSettings failed:`, err.response?.data || err.message);
            return { success: false, error: err.response?.data?.message || err.message };
        }
    }
}

module.exports = new GreenApiService();
