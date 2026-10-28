'use strict';

const express = require('express');
const axios = require('axios');
const config = require('../config');
const Identity = require('../services/identity/identity-store');

const router = express.Router();

router.get('/calls/stats/:instanceId', async (req, res) => {
    const businessId = Number(req.params.instanceId);
    const days = Number(req.query.days === undefined ? 7 : req.query.days);
    if (!Number.isSafeInteger(businessId) || businessId < 1) {
        return res.status(400).json({ success: false, error: 'Выберите бизнес.' });
    }
    if (![7, 30, 90].includes(days)) {
        return res.status(400).json({ success: false, error: 'Выберите период 7, 30 или 90 дней.' });
    }
    try {
        // Analytics is customer-only: a legacy operator login is not tenant proof.
        if (!req.auth?.userId) return res.status(403).json({ success: false, error: 'Нет доступа к бизнесу.' });
        Identity.authorizeCapability(req.auth, businessId, 'business.read');

        const { apiUrl, serviceToken, timeoutMs } = config.avaAdmin;
        if (!apiUrl || !serviceToken) {
            return res.status(503).json({ success: false, error: 'Аналитика звонков временно недоступна.' });
        }
        const response = await axios.get(`${apiUrl}/api/internal/calls/business/${businessId}/stats`, {
            params: { days },
            headers: { Authorization: `Bearer ${serviceToken}`, Accept: 'application/json' },
            timeout: timeoutMs,
        });
        const source = response.data || {};
        if (Number(source.business_id) !== businessId || Number(source.period_days) !== days) {
            throw new Error('CALL_STATS_SCOPE_MISMATCH');
        }
        // A membership or its original cookie may be revoked while the request runs.
        require('../services/identity/customer-access').reauthorize(req, businessId, 'business.read');
        return res.json({
            success: true,
            business_id: businessId,
            period_days: days,
            generated_at: source.generated_at,
            stats: {
                total_calls: source.total_calls,
                avg_duration_seconds: source.avg_duration_seconds,
                total_duration_seconds: source.total_duration_seconds,
                outcomes: source.outcomes,
                providers: source.providers,
                directions: source.directions,
                calls_per_day: source.calls_per_day,
            },
        });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: 'Нет доступа к бизнесу.' });
        return res.status(503).json({ success: false, error: 'Аналитика звонков временно недоступна.' });
    }
});

function recordingName(value,businessId) {
    return typeof value==='string' && value.length<=180 && new RegExp('^ava-'+businessId+'-[A-Za-z0-9_.-]+\\.wav$').test(value)
        && !value.includes('..')?value:null;
}
for(const wav of [false,true]) router.get('/calls/:instanceId/:recordId/recording'+(wav?'.wav':''),async(req,res)=>{
    const businessId=Number(req.params.instanceId),recordId=req.params.recordId;
    if(!Number.isSafeInteger(businessId) || businessId<1 || !/^[A-Za-z0-9_-]{1,120}$/.test(recordId))
        return res.status(400).json({success:false,code:'CALL_RECORDING_INVALID'});
    const Access=require('../services/identity/customer-access');
    try {
        if(!req.auth?.userId) return res.status(403).json({success:false,code:'CALL_RECORDING_FORBIDDEN'});
        Access.reauthorize(req,businessId,'business.read');
        const {apiUrl,serviceToken,timeoutMs}=config.avaAdmin;
        if(!apiUrl || !serviceToken) throw new Error('unavailable');
        const upstream=`${apiUrl}/api/internal/calls/business/${businessId}/${encodeURIComponent(recordId)}/recording`;
        const options={headers:{Authorization:`Bearer ${serviceToken}`},timeout:timeoutMs,maxRedirects:0,maxContentLength:64*1024*1024};
        const metadata=(await axios.get(upstream,options)).data || {};
        Access.reauthorize(req,businessId,'business.read');
        if(metadata.business_id!=null && Number(metadata.business_id)!==businessId) throw new Error('scope mismatch');
        const filename=recordingName(metadata.filename,businessId);
        res.set('Cache-Control','private, no-store');
        if(!wav) return res.json({success:true,business_id:businessId,has_recording:metadata.has_recording===true && !!filename,
            filename,recording_url:metadata.has_recording===true && filename?`/api/calls/${businessId}/${recordId}/recording.wav`:null});
        if(metadata.has_recording!==true || !filename) return res.status(404).json({success:false,code:'CALL_RECORDING_NOT_READY'});
        const response=await axios.get(upstream+'.wav',{...options,responseType:'arraybuffer'});
        Access.reauthorize(req,businessId,'business.read');
        const bytes=Buffer.from(response.data);
        if(bytes.length<=44 || bytes.length>64*1024*1024 || bytes.toString('ascii',0,4)!=='RIFF' || bytes.toString('ascii',8,12)!=='WAVE')
            throw new Error('invalid WAV');
        res.set('Content-Type','audio/wav');res.set('X-Content-Type-Options','nosniff');
        return res.send(bytes);
    } catch(error) {
        const status=error.statusCode || (error.response?.status===404?404:503);
        return res.status(status).json({success:false,code:status===403?'CALL_RECORDING_FORBIDDEN':status===404?'CALL_RECORDING_NOT_READY':'CALL_RECORDING_UNAVAILABLE'});
    }
});

router.get('/calls/:instanceId', async (req, res) => {
    const businessId = Number(req.params.instanceId);
    if (!Number.isSafeInteger(businessId) || businessId < 1) {
        return res.status(400).json({ success: false, error: 'Выберите бизнес.' });
    }
    try {
        // A browser-supplied business ID is never proof of access. Legacy
        // operator sessions are authenticated by requireAuth before this router.
        if (req.auth?.userId) Identity.authorizeCapability(req.auth, businessId, 'business.read');
        else if (!req.auth?.login) return res.status(403).json({ success: false, error: 'Нет доступа к бизнесу.' });

        const { apiUrl, serviceToken, timeoutMs } = config.avaAdmin;
        if (!apiUrl || !serviceToken) {
            return res.status(503).json({ success: false, error: 'История звонков временно недоступна.' });
        }
        const page = Math.max(1, Math.min(Math.trunc(Number(req.query.page) || 1), 100000));
        const pageSize = Math.max(1, Math.min(Math.trunc(Number(req.query.page_size) || 20), 50));
        const response = await axios.get(`${apiUrl}/api/internal/calls/business/${businessId}`, {
            params: { page, page_size: pageSize },
            headers: { Authorization: `Bearer ${serviceToken}`, Accept: 'application/json' },
            timeout: timeoutMs,
        });
        const source = response.data || {};
        const rows = Array.isArray(source.calls) ? source.calls : [];
        if (rows.some(call => Number(call.business_id) !== businessId)) throw new Error('CALL_HISTORY_SCOPE_MISMATCH');
        const calls = rows
            .map(call => ({
                id: call.id,
                call_id: call.call_id,
                business_id: businessId,
                caller_number: call.caller_number,
                caller_name: call.caller_name,
                called_number: call.called_number,
                direction: call.direction,
                outcome: call.outcome,
                start_time: call.start_time,
                duration_seconds: call.duration_seconds,
                provider_name: call.provider_name,
                campaign_id: call.campaign_id,
                phone_number_id: typeof call.phone_number_id==='string' && /^[a-f0-9-]{36}$/.test(call.phone_number_id)?call.phone_number_id:null,
                recording_file: recordingName(call.recording_file,businessId),
                recording_url: recordingName(call.recording_file,businessId) && /^[A-Za-z0-9_-]{1,120}$/.test(String(call.id))?
                    `/api/calls/${businessId}/${call.id}/recording.wav`:null,
            }));
        if (req.auth?.userId) require('../services/identity/customer-access').reauthorize(req, businessId, 'business.read');
        return res.json({
            success: true,
            business_id: businessId,
            calls,
            total: Math.max(0, Number(source.total) || 0),
            page,
            page_size: pageSize,
            total_pages: Math.max(1, Number(source.total_pages) || 1),
        });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: 'Нет доступа к бизнесу.' });
        return res.status(503).json({ success: false, error: 'История звонков временно недоступна.' });
    }
});

router.get('/clients/:instanceId/:chatId/calls', async (req, res) => {
    const instanceId = Number(req.params.instanceId);
    try {
        if (!req.auth?.userId) return res.status(403).json({ success: false, error: 'Нет доступа к бизнесу.' });
        Identity.authorizeCapability(req.auth, instanceId, 'business.read');
        const result = await require('../services/client-call-history.service').page(instanceId, req.params.chatId, req.query.page);
        require('../services/identity/customer-access').reauthorize(req, instanceId, 'business.read');
        return res.json({ success: true, instanceId, ...result });
    } catch (error) {
        return res.status(error.statusCode || 503).json({ success: false, error: 'Не удалось загрузить звонки клиента.' });
    }
});

module.exports = router;
