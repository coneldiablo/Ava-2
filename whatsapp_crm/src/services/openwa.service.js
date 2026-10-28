const axios = require('axios');
const Logger = require('../utils/logger');

const LOCAL_OPENWA_URLS = new Set([
    'http://localhost:2785',
    'http://127.0.0.1:2785'
]);

class OpenWaService {
    /**
     * Resolve the effective shared gateway endpoint. Older database rows store
     * localhost as a schema default, which is not reachable from the CRM
     * container. In Docker, OPENWA_URL is authoritative for those legacy rows;
     * an explicitly configured non-local URL still wins.
     */
    resolveUrl(apiUrl) {
        const configured = String(apiUrl || '').trim().replace(/\/+$/, '');
        const shared = String(process.env.OPENWA_URL || '').trim().replace(/\/+$/, '');

        if (!configured || LOCAL_OPENWA_URLS.has(configured)) {
            return shared || configured || 'http://localhost:2785';
        }
        return configured;
    }

    /**
     * A single self-hosted OpenWA service uses one server-side API key. A
     * tenant may override it for an external gateway, while ordinary tenants
     * inherit OPENWA_API_KEY without persisting that secret in SQLite.
     */
    resolveApiKey(apiKey) {
        return String(apiKey || '').trim() || String(process.env.OPENWA_API_KEY || '').trim();
    }

    /**
     * Clean base URL (strips trailing slashes, ensures /api prefix is formatted properly).
     * OpenWA routes are under /api/
     */
    _baseUrl(apiUrl) {
        let base = this.resolveUrl(apiUrl);
        if (!base.endsWith('/api')) {
            base = `${base}/api`;
        }
        return base;
    }

    /**
     * Standard headers with X-API-Key
     */
    _headers(apiKey) {
        const headers = { 'Content-Type': 'application/json' };
        const effectiveApiKey = this.resolveApiKey(apiKey);
        if (effectiveApiKey) {
            headers['X-API-Key'] = effectiveApiKey;
        }
        return headers;
    }

    /**
     * Format WhatsApp chatId (e.g. 79991234567 -> 79991234567@c.us)
     */
    formatChatId(chatId) {
        if (!chatId) return '';
        let cleaned = String(chatId).trim();
        if (!cleaned.includes('@')) {
            cleaned = `${cleaned.replace(/\D/g, '')}@c.us`;
        }
        return cleaned;
    }

    /**
     * Get session state.
     * Maps OpenWA status to standard state: "authorized" | "notAuthorized" | "failed" | "starting" | "disconnected"
     */
    async getState(apiUrl, apiKey, sessionId) {
        if (!sessionId) {
            return { success: false, error: 'sessionId is required' };
        }
        const url = `${this._baseUrl(apiUrl)}/sessions/${encodeURIComponent(sessionId)}`;
        Logger.info(`[OpenWA] getState for session "${sessionId}"`);
        try {
            const res = await axios.get(url, {
                headers: this._headers(apiKey),
                timeout: 10000
            });
            const session = res.data || {};
            const rawStatus = session.status || 'disconnected';

            let stateInstance = 'notAuthorized';
            if (rawStatus === 'ready') {
                stateInstance = 'authorized';
            } else if (['initializing', 'created'].includes(rawStatus)) {
                stateInstance = 'starting';
            } else if (['qr_ready', 'authenticating'].includes(rawStatus)) {
                stateInstance = 'notAuthorized';
            } else if (['failed', 'action_required'].includes(rawStatus)) {
                // A transport/startup error does not prove an account ban.
                stateInstance = 'failed';
            } else if (rawStatus === 'blocked') {
                stateInstance = 'blocked';
            } else if (rawStatus === 'disconnected') {
                stateInstance = 'disconnected';
            }

            return {
                success: true,
                data: {
                    stateInstance,
                    rawStatus,
                    phone: session.phone || null,
                    pushName: session.pushName || null,
                    engineLoaded: session.engineLoaded ?? false,
                    lastActive: session.lastActive || null,
                    lastError: session.lastError || null,
                    session
                }
            };
        } catch (err) {
            const errMsg = err.response?.data?.message || err.message;
            Logger.error(`[OpenWA] getState failed for ${sessionId}:`, errMsg);
            return { success: false, error: errMsg, statusCode: err.response?.status };
        }
    }

    /**
     * Get QR code for WhatsApp authorization.
     * OpenWA returns { qrCode: "data:image/png;base64,...", status: "qr_ready" }
     */
    async getQR(apiUrl, apiKey, sessionId) {
        if (!sessionId) {
            return { success: false, error: 'sessionId is required' };
        }
        const url = `${this._baseUrl(apiUrl)}/sessions/${encodeURIComponent(sessionId)}/qr`;
        Logger.info(`[OpenWA] getQR for session "${sessionId}"`);
        try {
            const res = await axios.get(url, {
                headers: this._headers(apiKey),
                timeout: 15000
            });

            if (res.data?.qrCode) {
                return {
                    success: true,
                    type: 'qrCode',
                    message: res.data.qrCode,
                    status: res.data.status
                };
            }

            if (res.data?.status === 'ready') {
                return { success: true, type: 'alreadyLogged', message: 'Already connected' };
            }

            return { success: true, type: 'pending', status: res.data?.status };
        } catch (err) {
            const errMsg = err.response?.data?.message || err.message;
            if (err.response?.status === 400 && errMsg?.toLowerCase().includes('authenticated')) {
                return { success: true, type: 'alreadyLogged', message: 'Already connected' };
            }
            Logger.error(`[OpenWA] getQR failed for ${sessionId}:`, errMsg);
            return { success: false, error: errMsg, statusCode: err.response?.status };
        }
    }

    /**
     * Create a new session in OpenWA.
     */
    async createSession(apiUrl, apiKey, name = 'crm-session') {
        const url = `${this._baseUrl(apiUrl)}/sessions`;
        Logger.info(`[OpenWA] createSession name="${name}"`);
        try {
            const proxyUrl = String(process.env.OPENWA_EGRESS_PROXY_URL || '').trim();
            const payload = { name };
            if (proxyUrl) {
                const protocol = new URL(proxyUrl).protocol.slice(0, -1);
                if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) throw new Error('Invalid OpenWA egress proxy protocol');
                payload.proxyUrl = proxyUrl;
                payload.proxyType = protocol;
            }
            const res = await axios.post(url, payload, {
                headers: this._headers(apiKey),
                timeout: 15000
            });
            return { success: true, data: res.data };
        } catch (err) {
            const errMsg = err.response?.data?.message || err.message;
            Logger.error(`[OpenWA] createSession failed:`, errMsg);
            return { success: false, error: errMsg, statusCode: err.response?.status };
        }
    }

    /**
     * Start session engine.
     */
    async startSession(apiUrl, apiKey, sessionId) {
        if (!sessionId) return { success: false, error: 'sessionId is required' };
        const url = `${this._baseUrl(apiUrl)}/sessions/${encodeURIComponent(sessionId)}/start`;
        Logger.info(`[OpenWA] startSession "${sessionId}"`);
        try {
            const res = await axios.post(url, {}, {
                headers: this._headers(apiKey),
                timeout: 20000
            });
            return { success: true, data: res.data };
        } catch (err) {
            const errMsg = err.response?.data?.message || err.message;
            Logger.error(`[OpenWA] startSession failed:`, errMsg);
            return { success: false, error: errMsg, statusCode: err.response?.status };
        }
    }

    /**
     * Stop session engine.
     */
    async stopSession(apiUrl, apiKey, sessionId) {
        if (!sessionId) return { success: false, error: 'sessionId is required' };
        const url = `${this._baseUrl(apiUrl)}/sessions/${encodeURIComponent(sessionId)}/stop`;
        Logger.info(`[OpenWA] stopSession "${sessionId}"`);
        try {
            const res = await axios.post(url, {}, {
                headers: this._headers(apiKey),
                timeout: 15000
            });
            return { success: true, data: res.data };
        } catch (err) {
            const errMsg = err.response?.data?.message || err.message;
            Logger.error(`[OpenWA] stopSession failed:`, errMsg);
            return { success: false, error: errMsg, statusCode: err.response?.status };
        }
    }

    /**
     * Logout session (unlink device).
     */
    async logout(apiUrl, apiKey, sessionId) {
        if (!sessionId) return { success: false, error: 'sessionId is required' };
        const url = `${this._baseUrl(apiUrl)}/sessions/${encodeURIComponent(sessionId)}/logout`;
        Logger.info(`[OpenWA] logout "${sessionId}"`);
        try {
            const res = await axios.post(url, {}, {
                headers: this._headers(apiKey),
                timeout: 15000
            });
            return { success: true, data: res.data };
        } catch (err) {
            Logger.warn('[OpenWA] logout failed:', err.response?.status || err.code || 'unknown');
            return { success: false, error: 'WHATSAPP_DISCONNECT_UNAVAILABLE', statusCode: err.response?.status };
        }
    }

    /**
     * Send text message.
     */
    async sendMessage(apiUrl, apiKey, sessionId, chatId, text) {
        if (!sessionId) return { success: false, error: 'sessionId is required' };
        const targetChat = this.formatChatId(chatId);
        const url = `${this._baseUrl(apiUrl)}/sessions/${encodeURIComponent(sessionId)}/messages/send-text`;
        try {
            const res = await axios.post(url, {
                chatId: targetChat,
                text: String(text || '')
            }, {
                headers: this._headers(apiKey),
                timeout: 20000
            });
            return {
                success: true,
                data: {
                    idMessage: res.data?.messageId || res.data?.id || null,
                    timestamp: res.data?.timestamp || Math.floor(Date.now() / 1000),
                    ...res.data
                }
            };
        } catch (err) {
            const errMsg = err.response?.data?.message || err.message;
            Logger.error(`[OpenWA] sendMessage failed to ${targetChat}:`, errMsg);
            return { success: false, error: errMsg, statusCode: err.response?.status };
        }
    }

    /**
     * Send media (image/document/etc) by URL.
     */
    async sendMedia(apiUrl, apiKey, sessionId, chatId, mediaUrl, caption = '', filename = '') {
        if (!sessionId) return { success: false, error: 'sessionId is required' };
        const targetChat = this.formatChatId(chatId);
        const url = `${this._baseUrl(apiUrl)}/sessions/${encodeURIComponent(sessionId)}/messages/send-image`;
        try {
            const payload = {
                chatId: targetChat,
                url: mediaUrl,
                caption: caption || undefined,
                filename: filename || undefined
            };
            const res = await axios.post(url, payload, {
                headers: this._headers(apiKey),
                timeout: 30000
            });
            return {
                success: true,
                data: {
                    idMessage: res.data?.messageId || res.data?.id || null,
                    ...res.data
                }
            };
        } catch (err) {
            const errMsg = err.response?.data?.message || err.message;
            Logger.error(`[OpenWA] sendMedia failed to ${targetChat}:`, errMsg);
            return { success: false, error: errMsg, statusCode: err.response?.status };
        }
    }

    // Fetch only this authenticated session's stored message. Never follow a
    // URL from a webhook or expose gateway credentials to redirects.
    async downloadMessageMedia(apiUrl,apiKey,sessionId,chatId,messageId,maxBytes=10*1024*1024,options={}) {
        const base=`${this._baseUrl(apiUrl)}/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(chatId)}`;
        const remaining=()=>Number.isFinite(options.deadline)?Math.max(1,options.deadline-Date.now()):Infinity;
        const bounded={headers:this._headers(apiKey),timeout:Math.min(12000,remaining()),maxRedirects:0,proxy:false,
            maxContentLength:maxBytes,maxBodyLength:maxBytes,...(options.signal?{signal:options.signal}:{})};
        try {
            const response=await axios.get(`${base}/${encodeURIComponent(messageId)}/media`,{...bounded,responseType:'arraybuffer'});
            return{buffer:Buffer.from(response.data),mimeType:response.headers['content-type']};
        }catch(error){
            if(options.signal?.aborted||error?.code==='ERR_CANCELED')throw Object.assign(new Error('WHATSAPP_MEDIA_STALE'),{code:'WHATSAPP_MEDIA_STALE'});
            if([404,410].includes(error.response?.status)){
                // A fresh webhook can have an omitted/unarchived payload. A 404
                // means no STORED bytes, not necessarily expired WhatsApp media.
                // Recover only from the same authenticated session/chat, choose
                // the exact inbound message, and never follow webhook URLs.
                try{
                    const response=await axios.get(`${base}/history`,{...bounded,timeout:Math.min(18000,remaining()),
                        params:{limit:10,includeMedia:true},maxContentLength:Math.ceil(maxBytes*4/3)+256*1024});
                    const exact=Array.isArray(response.data)&&response.data.find(item=>item?.id===messageId
                        && item.fromMe===false && item.chatId===chatId);
                    const media=exact?.media;
                    if(media&&!media.omitted&&typeof media.mimetype==='string'&&typeof media.data==='string'
                        &&media.data.length<=Math.ceil(maxBytes*4/3)&&/^[A-Za-z0-9+/]+={0,2}$/.test(media.data)){
                        const buffer=Buffer.from(media.data,'base64');
                        if(buffer.length>maxBytes)throw Object.assign(new Error('WHATSAPP_MEDIA_TOO_LARGE'),{code:'WHATSAPP_MEDIA_TOO_LARGE'});
                        if(buffer.length)return{buffer,mimeType:media.mimetype};
                    }
                }catch(recovery){
                    if(options.signal?.aborted||recovery?.code==='ERR_CANCELED')throw Object.assign(new Error('WHATSAPP_MEDIA_STALE'),{code:'WHATSAPP_MEDIA_STALE'});
                    if(recovery.code==='WHATSAPP_MEDIA_TOO_LARGE')throw recovery;
                    if(![404,410].includes(recovery.response?.status))throw Object.assign(new Error('WHATSAPP_MEDIA_UNAVAILABLE'),{code:'WHATSAPP_MEDIA_UNAVAILABLE'});
                }
                throw Object.assign(new Error('WHATSAPP_MEDIA_EXPIRED'),{code:'WHATSAPP_MEDIA_EXPIRED'});
            }
            const code=error.response?.status===413||/maxContentLength/.test(error.message||'')?'WHATSAPP_MEDIA_TOO_LARGE':'WHATSAPP_MEDIA_UNAVAILABLE';
            throw Object.assign(new Error(code),{code});
        }
    }

    async sendChatState(apiUrl,apiKey,sessionId,chatId,state) {
        if(!sessionId||!['typing','paused'].includes(state)||!/^\d{7,20}@(c\.us|s\.whatsapp\.net|lid)$/.test(chatId||''))return false;
        try {
            const result=await axios.post(`${this._baseUrl(apiUrl)}/sessions/${encodeURIComponent(sessionId)}/chats/typing`,
                {chatId,state},{headers:this._headers(apiKey),timeout:1500,maxRedirects:0,proxy:false,maxContentLength:4096});
            return result.data?.success===true;
        }catch(_){return false;} // Optional presence must not fail or retry a reply.
    }

    async sendDocument(apiUrl,apiKey,sessionId,chatId,document) {
        const url=`${this._baseUrl(apiUrl)}/sessions/${encodeURIComponent(sessionId)}/messages/send-document`;
        try {
            const response=await axios.post(url,{chatId:this.formatChatId(chatId),base64:document.buffer.toString('base64'),
                mimetype:document.mimeType,filename:document.filename},{headers:this._headers(apiKey),timeout:25000,
                maxRedirects:0,maxBodyLength:16*1024*1024,maxContentLength:64000,proxy:false});
            const providerMessageId=response.data?.messageId||response.data?.id;
            if(typeof providerMessageId!=='string'||!providerMessageId) return{success:false,code:'WHATSAPP_DOCUMENT_ACK_UNKNOWN',safeToRetry:false};
            return{success:true,providerMessageId};
        }catch(error){
            // A 4xx validation refusal proves no send only for the bounded
            // gateway validation statuses. 5xx/timeouts/connection loss fence.
            const safeToRetry=[400,401,403,404,413,422,429].includes(error.response?.status);
            return{success:false,code:safeToRetry?'WHATSAPP_DOCUMENT_REJECTED':'WHATSAPP_DOCUMENT_ACK_UNKNOWN',safeToRetry};
        }
    }

    /**
     * Setup Webhook in OpenWA for receiving events.
     */
    async setupWebhook(apiUrl, apiKey, sessionId, webhookUrl, secret) {
        if (!webhookUrl) return { success: false, error: 'webhookUrl is required' };
        if (!sessionId) return { success: false, error: 'sessionId is required' };
        const url = `${this._baseUrl(apiUrl)}/sessions/${encodeURIComponent(sessionId)}/webhooks`;
        Logger.info(`[OpenWA] setupWebhook to "${webhookUrl}" for session "${sessionId || 'all'}"`);
        try {
            const payload = {
                url: webhookUrl,
                events: ['message.received', 'session.status', 'session.restriction'],
                ...(secret ? { secret } : {})
            };
            const options = { headers: this._headers(apiKey), timeout: 15000 };
            const current = await axios.get(url, options);
            const hooks = Array.isArray(current.data) ? current.data : [];
            const existing = hooks.find(hook => hook.url === webhookUrl);
            const res = existing ? await axios.put(`${url}/${encodeURIComponent(existing.id)}`, { ...payload, active: true }, options) : await axios.post(url, payload, {
                headers: this._headers(apiKey),
                timeout: 15000
            });
            return { success: true, data: res.data };
        } catch (err) {
            const errMsg = err.response?.data?.message || err.message;
            Logger.error(`[OpenWA] setupWebhook failed:`, errMsg);
            return { success: false, error: errMsg, statusCode: err.response?.status };
        }
    }

    /**
     * List all sessions configured on the OpenWA server.
     */
    async listSessions(apiUrl, apiKey) {
        const url = `${this._baseUrl(apiUrl)}/sessions`;
        try {
            const res = await axios.get(url, {
                headers: this._headers(apiKey),
                timeout: 10000
            });
            return { success: true, data: res.data || [] };
        } catch (err) {
            const errMsg = err.response?.data?.message || err.message;
            return { success: false, error: errMsg };
        }
    }
}

module.exports = new OpenWaService();
