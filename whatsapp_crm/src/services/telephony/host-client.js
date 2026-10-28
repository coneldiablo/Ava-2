'use strict';
const axios = require('axios');
const { fail } = require('./policy');
class HostClient {
    constructor({request=options=>axios(options)}={}) { this.request=request; }
    async call(path,data={}) {
        if(!process.env.AVA_TELEPHONY_AGENT_TOKEN || !process.env.AVA_TELEPHONY_AGENT_SOCKET)
            fail('TELEPHONY_AGENT_NOT_CONFIGURED',503);
        try {
            const r=await this.request({method:'POST',url:`http://localhost${path}`,socketPath:process.env.AVA_TELEPHONY_AGENT_SOCKET,
                data,headers:{Authorization:`Bearer ${process.env.AVA_TELEPHONY_AGENT_TOKEN}`},timeout:20000,maxRedirects:0,maxContentLength:65536});
            if(r.data?.success!==true) throw new Error('agent refused');
            return r.data;
        } catch (_) { fail('TELEPHONY_AGENT_UNAVAILABLE',503); }
    }
    health() { return this.call('/health'); }
    apply(phone,credentials) { return this.call('/apply',{phoneId:phone.id,number:phone.number,endpoint:phone.endpoint,credentials}); }
    status(phone) { return this.call('/status',{endpoint:phone.endpoint}); }
    remove(phone) { return this.call('/remove',{endpoint:phone.endpoint}); }
    calls() { return this.call('/calls'); }
    externalCapabilities() { return this.call('/external/capabilities'); }
    applyExternal(phone,credentials) { return this.call('/external/apply',{phoneId:phone.id,businessId:phone.businessId,number:phone.number,endpoint:phone.endpoint,revision:phone.generation,credentials}); }
    externalStatus(phone) { return this.call('/external/status',{phoneId:phone.id,businessId:phone.businessId,endpoint:phone.endpoint,revision:phone.generation}); }
    removeExternal(phone) { return this.call('/external/remove',{phoneId:phone.id,businessId:phone.businessId,endpoint:phone.endpoint,revision:phone.generation}); }
}
module.exports={HostClient};
