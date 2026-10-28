'use strict';

const express = require('express');
const CustomerAccess = require('../services/identity/customer-access');
const PmsService = require('../services/pms/pms.service');
const { getPublicUrl } = require('../services/identity/public-url');

const router = express.Router();

const publicMessages = {
    BNOVO_CREDENTIALS_REQUIRED: 'Укажите ID аккаунта и пароль API Bnovo.',
    BNOVO_AUTH_FAILED: 'Проверьте ID аккаунта и пароль API в Bnovo.',
    BNOVO_HOTEL_SELECTION_REQUIRED: 'В аккаунте несколько отелей. Укажите ID нужного отеля.',
    BNOVO_HOTEL_ID_UNAVAILABLE: 'Не удалось определить отель. Укажите его ID в Bnovo.',
    BNOVO_HOTEL_SCOPE_MISMATCH: 'Этот отель недоступен выбранному аккаунту Bnovo.',
    PMS_NOT_CONFIGURED: 'Сначала сохраните данные подключения Bnovo.',
    PMS_CONNECTION_CHANGED: 'Настройки подключения изменились. Обновите страницу.',
    PMS_PUBLIC_URL_REQUIRED: 'Не удалось подготовить адрес для уведомлений. Повторите позже.',
    CUSTOMER_ORIGIN_REQUIRED: 'Обновите страницу AVA и повторите действие.',
    BUSINESS_SCOPE_MISMATCH: 'Выберите нужный бизнес и повторите действие.',
};
function respondError(res, error) {
    const code = /^(BNOVO_|PMS_|BUSINESS_|CUSTOMER_|ACCOUNT_)[A-Z_]+$/.test(error.code || '') ? error.code : 'PMS_OPERATION_FAILED';
    const status = Number(error.statusCode || error.status);
    return res.status(status >= 400 && status <= 599 ? status : 500).json({ success:false,code,error:code,
        message:publicMessages[code] || 'Не удалось завершить действие Bnovo. Проверьте подключение и повторите.' });
}
function guard(req, res, next) {
    try {
        if (!req.auth?.userId || req.auth.platformRole === 'platform_admin') {
            throw Object.assign(new Error(),{code:'CUSTOMER_ACCESS_REQUIRED',statusCode:403});
        }
        const businessId = Number(req.params.businessId ?? req.params.id);
        if (!Number.isSafeInteger(businessId) || businessId < 1) throw Object.assign(new Error(),{code:'BUSINESS_SCOPE_REQUIRED',statusCode:400});
        const capability = req.method === 'GET' ? 'business.read' : 'business.manage';
        req.pmsBusinessId = CustomerAccess.reauthorize(req,businessId,capability);
        if (req.method !== 'GET') {
            const accepted = new Set([`${req.protocol}://${req.get('host')}`]);
            try { accepted.add(getPublicUrl().origin); } catch (_) {}
            if (!accepted.has(req.get('origin')) || req.get('sec-fetch-site') === 'cross-site') throw Object.assign(new Error(),{code:'CUSTOMER_ORIGIN_REQUIRED',statusCode:403});
        }
        res.set('Cache-Control','no-store'); next();
    } catch(error) { respondError(res,error); }
}
function cleanIntegration(pms) {
    if(!pms) return null;
    const {diagnostics,last_error,...safe} = pms;
    return {...safe,last_error:last_error ? {code:last_error.code} : null};
}
function authorizeUnchanged(req) {
    const Store = require('../services/pms/pms-store.service');
    const initial = Store.getIntegration(req.pmsBusinessId);
    const fingerprint = initial && [initial.credentialsEncrypted,initial.externalHotelId,initial.enabled,initial.currency,initial.mappingsJson].join(':');
    return () => {
        CustomerAccess.reauthorize(req,req.pmsBusinessId,'business.manage');
        const current = Store.getIntegration(req.pmsBusinessId);
        if((current && [current.credentialsEncrypted,current.externalHotelId,current.enabled,current.currency,current.mappingsJson].join(':')) !== fingerprint) {
            throw Object.assign(new Error(),{code:'PMS_CONNECTION_CHANGED',statusCode:409});
        }
    };
}

function registerPmsRoutes(basePath) {
    router.get(basePath, guard, (req, res) => {
        try {
            const pms = PmsService.get(req.pmsBusinessId);
            res.json({ success: true, businessId: req.pmsBusinessId, pms:cleanIntegration(pms) });
        } catch (error) {
            respondError(res, error);
        }
    });

    router.put(basePath, guard, (req, res) => {
        try {
            CustomerAccess.reauthorize(req, req.pmsBusinessId, 'business.manage');
            const input=req.body || {};
            if(Object.keys(input).some(key=>!['account_id','api_password','external_hotel_id','currency','enabled'].includes(key)) || (input.enabled !== undefined && typeof input.enabled !== 'boolean') || (input.currency !== undefined && !['RUB','USD','EUR','KZT','BYN'].includes(input.currency))) throw Object.assign(new Error(),{code:'PMS_INPUT_INVALID',statusCode:400});
            const pms = PmsService.configure(req.pmsBusinessId,input);
            res.json({ success: true, businessId: req.pmsBusinessId, pms:cleanIntegration(pms) });
        } catch (error) {
            respondError(res, error);
        }
    });

    router.delete(basePath, guard, (req, res) => {
        try {
            CustomerAccess.reauthorize(req, req.pmsBusinessId, 'business.manage');
            const result = PmsService.disconnect(req.pmsBusinessId);
            res.json({ success: true, businessId: req.pmsBusinessId, ...result });
        } catch (error) {
            respondError(res, error);
        }
    });

    router.post(`${basePath}/test`, guard, async (req, res) => {
        try {
            CustomerAccess.reauthorize(req, req.pmsBusinessId, 'business.manage');
            const result = await PmsService.test(req.pmsBusinessId, undefined, {beforeWrite:authorizeUnchanged(req)});
            CustomerAccess.reauthorize(req,req.pmsBusinessId,'business.manage');
            res.json({ success:true,businessId:req.pmsBusinessId,pms:cleanIntegration(result.pms),capabilities:result.capabilities });
        } catch (error) {
            respondError(res, error);
        }
    });

    router.post(`${basePath}/sync`, guard, (req, res) => {
        try {
            CustomerAccess.reauthorize(req, req.pmsBusinessId, 'business.manage');
            const result = PmsService.enqueueInitialSync(req.pmsBusinessId);
            res.json({ success: true, businessId: req.pmsBusinessId, ...result });
        } catch (error) {
            respondError(res, error);
        }
    });

    router.post(`${basePath}/webhooks`, guard, async (req, res) => {
        try {
            CustomerAccess.reauthorize(req, req.pmsBusinessId, 'business.manage');
            const publicBaseUrl = getPublicUrl().origin;
            const result = await PmsService.connectWebhooks(req.pmsBusinessId,publicBaseUrl,undefined,{beforeWrite:authorizeUnchanged(req)});
            CustomerAccess.reauthorize(req,req.pmsBusinessId,'business.manage');
            res.json({success:true,businessId:req.pmsBusinessId,pms:cleanIntegration(result.pms),activation_may_take_hours:result.activation_may_take_hours});
        } catch (error) {
            respondError(res, error);
        }
    });

    router.get(`${basePath}/bookings`, guard, (req, res) => {
        try {
            CustomerAccess.reauthorize(req,req.pmsBusinessId,'business.manage');
            const bookings = PmsService.listBookings(req.pmsBusinessId, {
                phone: req.query.phone,
                bookingNumber: req.query.booking_number,
                limit: req.query.limit,
            });
            res.json({ success: true, businessId: req.pmsBusinessId, provider: 'bnovo', bookings });
        } catch (error) {
            respondError(res, error);
        }
    });

    router.get(`${basePath}/booking-requests`, guard, (req, res) => {
        try {
            CustomerAccess.reauthorize(req,req.pmsBusinessId,'business.manage');
            const booking_requests = PmsService.listBookingRequests(req.pmsBusinessId, {
                status: req.query.status,
                limit: req.query.limit,
            });
            res.json({ success: true, businessId: req.pmsBusinessId, provider: 'bnovo', booking_requests });
        } catch (error) {
            respondError(res, error);
        }
    });
}

registerPmsRoutes('/businesses/:businessId/pms');
registerPmsRoutes('/hotel-profiles/:id/pms');

module.exports = router;
