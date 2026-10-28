'use strict';
const axios = require('axios');
const { fail } = require('./policy');
class ExolveClient {
    constructor({ token = process.env.EXOLVE_API_KEY, applicationId = process.env.EXOLVE_APPLICATION_UUID,
        request = options => axios(options), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
        this.token = token; this.applicationId = applicationId; this.request = request; this.sleep = sleep;
    }
    configured() { if (!this.token || !this.applicationId) fail('TELEPHONY_PROVIDER_NOT_CONFIGURED', 503); }
    async post(path, data, { read = false } = {}) {
        this.configured();
        for (let attempt = 0; attempt < (read ? 3 : 1); attempt++) {
            try {
                const response = await this.request({ method: 'POST', url: `https://api.exolve.ru${path}`, data,
                    headers: { Authorization: `Bearer ${this.token}` }, timeout: 15000,
                    maxRedirects: 0, maxContentLength: 1024 * 1024 });
                if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw new Error('invalid provider response');
                return response.data;
            } catch (cause) {
                const status = Number(cause.response?.status || 0);
                if (read && attempt < 2 && (!status || status === 429 || status >= 500)) {
                    const after = Number(cause.response?.headers?.['retry-after']);
                    await this.sleep(Math.min(15000, Math.max(500 * 2 ** attempt, Number.isFinite(after) ? after * 1000 : 0)));
                    continue;
                }
                // Never retain axios errors: they contain Authorization and SIP credentials.
                const code = status === 401 || status === 403 ? 'TELEPHONY_PROVIDER_AUTH'
                    : status === 429 ? 'TELEPHONY_PROVIDER_RATE_LIMIT' : 'TELEPHONY_PROVIDER_ERROR';
                throw Object.assign(new Error(code), { code, statusCode: 503, providerStatus: status,
                    uncertain: !read && (!status || status === 408 || status === 429 || status >= 500) });
            }
        }
    }
    catalog() { return this.post('/number/reference/v1/GetList', {}, { read: true }); }
    free(data) { return this.post('/number/v1/GetFree', data, { read: true }).then(r => {
        if(!Array.isArray(r.numbers)) fail('TELEPHONY_PROVIDER_RESPONSE_INVALID',503);
        return r.numbers;
    }); }
    fees() { return this.post('/sip/v1/GetFees', {}, { read: true }); }
    balance() { return this.post('/finance/v1/GetBalance', {}, { read: true }); }
    lock(number) { return this.post('/number/v1/Lock', { number_code: number, seconds: 300, description: 'AVA provisioning' }); }
    unlock(number, uid) { return this.post('/number/v1/Unlock', { number_code: number, uid }); }
    buy(number, uid) { return this.post('/number/v1/Buy', { number_code: number, reserve_uid: uid }); }
    deleteNumber(number) { return this.post('/number/v1/Delete', { number_code: number }); }
    createSip(name, number) { return this.post('/sip/v1/Create', { sip_name: name, number, description: 'AVA managed phone', call_record: false }); }
    sip(id) { return this.post('/sip/v1/GetAttributes', { sip_resource_id: id }, { read: true }); }
    deleteSip(id) { return this.post('/sip/v1/Delete', { sip_resource_id: id }); }
    forwarding(number, ip, port) {
        return this.post('/number/v1/SetCallForwarding', { number_code: number, call_forwarding_type: 4,
            call_forwarding_static: { static_ip: ip, port, timeout: 30, did: number } });
    }
    async inventory() {
        return this.pages('/number/customer/v1/GetList', 'numbers', { application_uuid: this.applicationId });
    }
    async sips() { return this.pages('/number/customer/v1/GetSIPList', 'sips', {}); }
    async pages(path, field, payload) {
        const result = [], seen=new Set();
        for (let offset = 0; offset < 100000; offset += 100) {
            const response = await this.post(path, { ...payload, limit: 100, offset }, { read: true });
            const items = response[field];
            if ((field==='numbers' && response.total==null) || !Array.isArray(items) || items.length>100) fail('TELEPHONY_PROVIDER_RESPONSE_INVALID', 503);
            for(const item of items) {
                const id=field==='numbers'?item?.number_name:item?.sip_resource_id;
                if(!item || !/^\d+$/.test(String(id)) || seen.has(String(id))
                    || typeof item.application_uuid!=='string' || !item.application_uuid
                    || (field==='numbers' && !/^7\d{10}$/.test(String(id)))
                    || (field==='sips' && typeof item.sip_name!=='string')) fail('TELEPHONY_PROVIDER_RESPONSE_INVALID',503);
                seen.add(String(id));
            }
            result.push(...items);
            if(response.total!=null && (!/^\d+$/.test(String(response.total)) || Number(response.total)<result.length
                || (items.length<100 && Number(response.total)!==result.length))) fail('TELEPHONY_INVENTORY_INCOMPLETE',503);
            if (items.length < 100 || (response.total!=null && Number(response.total) === result.length)) return result;
        }
        fail('TELEPHONY_INVENTORY_INCOMPLETE', 503);
    }
}
module.exports = { ExolveClient };
