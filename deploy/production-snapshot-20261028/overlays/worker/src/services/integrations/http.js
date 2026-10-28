'use strict';
const axios=require('axios');
const Store=require('./store');
function amoDomain(value) {
    const raw=String(value||'').trim().replace(/^https:\/\//,'').replace(/\/$/,'').toLowerCase();
    if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:amocrm\.(?:ru|com)|kommo\.com)$/.test(raw)) Store.fail('EXTERNAL_DOMAIN_INVALID');
    return raw;
}
function providerError(error) {
    if(error?.code?.startsWith('EXTERNAL_'))return error;
    if(/^(BUSINESS_|CAPABILITY_|AUTHENTICATION_|CUSTOMER_|WORKSPACE_|CHANNEL_|AVITO_)/.test(error?.code||''))return Object.assign(error,{safeToRetry:true,unknown:false});
    const status=Number(error?.response?.status);
    // Request Timeout is not a validation refusal: an upstream proxy may
    // time out after the provider accepted a write. Keep the unknown fence.
    const rejected=status>=400&&status<500&&status!==408;
    let code=status===401?'EXTERNAL_AUTH_REQUIRED':status===403?'EXTERNAL_ACCESS_DENIED':status===429?'EXTERNAL_RATE_LIMITED':
        status===408||['ECONNABORTED','ETIMEDOUT','ERR_CANCELED'].includes(error?.code)?'EXTERNAL_TIMEOUT':rejected?'EXTERNAL_REQUEST_REJECTED':'EXTERNAL_PROVIDER_UNAVAILABLE';
    let retryAt=null;
    if(status===429) {const delay=Number(error?.response?.headers?.['retry-after']);retryAt=Date.now()+Math.max(1000,Math.min(Number.isFinite(delay)?delay*1000:60000,3600000));}
    return Object.assign(new Error(code),{code,statusCode:status===401?409:status===403?403:status===429?429:502,
        safeToRetry:rejected,unknown:!rejected,retryAt});
}
async function request(config) {
    try {return (await axios.request({...config,timeout:12000,maxRedirects:0,maxContentLength:2*1024*1024,maxBodyLength:1024*1024})).data;}
    catch(e) {throw providerError(e);}
}
function recordError(id,provider,error,revision=null) {
    const e=providerError(error);
    const current=Store.get(id,provider);
    if(!current||current.status==='disconnected'||revision!=null&&current.revision!==revision)return e;
    const status=e.code==='EXTERNAL_AUTH_REQUIRED'?'reauth_required':e.code==='EXTERNAL_ACCESS_DENIED'?'access_denied':e.code==='EXTERNAL_RATE_LIMITED'?'rate_limited':'error';
    Store.patch(id,provider,{status,errorCode:e.code,retryAt:e.retryAt||null},current.revision);
    return e;
}
async function write(id,provider,key,payload,execute,{beforeSend=null,validate=null,chatId=null}={}) {
    // A failed local precondition must never be mistaken for an external write.
    const start=Store.begin(id,provider,key,payload,chatId);
    if(start.replay)return {...start.evidence,replayed:true};
    let dispatched=false;
    try {
        if(beforeSend)await beforeSend();
        dispatched=true;
        const data=await execute();
        if(validate&&!validate(data)) Store.fail('EXTERNAL_ACK_INVALID',502,{unknown:true});
        Store.finish(id,provider,key,'succeeded',data);
        return data;
    } catch(error) {
        const e=providerError(error);
        const safe=!dispatched||e.safeToRetry===true;
        Store.finish(id,provider,key,safe?'failed':'unknown',{},e.code);
        e.safeToRetry=safe;e.unknown=!safe;throw e;
    }
}
module.exports={amoDomain,request,providerError,recordError,write};
