'use strict';

const express = require('express');
const DB = require('../services/database.service');
const Deals = require('../services/customer-deals.store');
const Identity = require('../services/identity/identity-store');
const Studio = require('../services/customer-studio.service');

const router = express.Router();
const currencies = { RUB: '₽', USD: '$', EUR: '€', KZT: '₸' };

function plain(value, maxLength) {
    return typeof value === 'string'
        ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
        : '';
}

function money(amountMinor, currency) {
    const amount = (amountMinor / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${amount} ${currencies[currency] || currency}`;
}

router.get('/businesses/:businessId/studio/proposals/:dealId', (req, res) => {
    try {
        // Studio is a customer workspace, never a legacy operator or platform route.
        if (!req.auth?.userId || req.auth.platformRole === 'platform_admin') {
            return res.status(403).json({ success: false, code: 'CUSTOMER_ACCESS_REQUIRED' });
        }
        const businessId = Identity.authorizeCapability(req.auth, req.params.businessId, 'business.read');
        // No request-supplied scope, prices, client identity or text may influence a draft.
        if (Object.keys(req.query || {}).length || Object.keys(req.body || {}).length) {
            return res.status(403).json({ success: false, code: 'STUDIO_OVERRIDE_DENIED' });
        }
        const deal = Deals.get(businessId, req.params.dealId);
        if (!deal) return res.status(404).json({ success: false, code: 'DEAL_NOT_FOUND' });
        const hotel = DB.get('SELECT name FROM instances WHERE id=? AND isActive=1', [businessId]);
        if (!hotel) return res.status(404).json({ success: false, code: 'BUSINESS_NOT_FOUND' });
        const client = deal.clientChatId ? DB.get(
            'SELECT senderName FROM clients WHERE instanceId=? AND chatId=?', [businessId, deal.clientChatId]
        ) : null;

        const hotelName = plain(hotel.name, 180) || null;
        const clientName = plain(client?.senderName, 180) || null;
        const dealTitle = plain(deal.title, 180);
        const amountMinor = Number.isSafeInteger(deal.amountMinor) && deal.amountMinor > 0
            ? deal.amountMinor : 0;
        const currency = Object.hasOwn(currencies, deal.currency) ? deal.currency : 'RUB';
        const notesPresent = Boolean(plain(deal.notes, 2000));
        const requiresManagerConfirmation = [
            'Доступность и сроки', 'Итоговая стоимость и условия оплаты',
            'Скидки и специальные условия',
        ];
        if (notesPresent) requiresManagerConfirmation.push('Детали из внутренних заметок менеджера');

        const draftText = [
            'Коммерческое предложение — черновик для проверки менеджером',
            hotelName ? `Компания: ${hotelName}` : 'Название компании: уточнить',
            clientName ? `Для: ${clientName}` : 'Имя клиента: уточнить',
            `Запрос: ${dealTitle}`,
            amountMinor
                ? `Предварительный бюджет по сделке: ${money(amountMinor, currency)}. Итоговую стоимость необходимо подтвердить.`
                : 'Стоимость необходимо уточнить и подтвердить.',
            notesPresent
                ? 'Внутренние заметки менеджера есть; их детали необходимо проверить перед включением в предложение.'
                : 'Детали предложения необходимо уточнить с менеджером.',
            'Доступность, сроки, условия оплаты и возможные скидки не подтверждены. Перед отправкой согласуйте их с менеджером.',
        ].join('\n');

        return res.json({ success: true, businessId, dealId: deal.id, revision: deal.revision,
            draftText, source: { dealTitle, amountMinor, currency, clientName, hotelName },
            requiresManagerConfirmation, catalog: Studio.catalog(businessId),
            material: Studio.material(businessId, deal.id) });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json({ success: false,
            code: error.statusCode === 403 ? 'BUSINESS_ACCESS_DENIED' : 'STUDIO_UNAVAILABLE' });
        return res.status(503).json({ success: false, code: 'STUDIO_UNAVAILABLE' });
    }
});

function materialGuard(req, res, next) {
    try {
        if (!req.auth?.userId || req.auth.platformRole === 'platform_admin') {
            return res.status(403).json({ success: false, code: 'CUSTOMER_ACCESS_REQUIRED' });
        }
        const read = req.method === 'GET';
        if (!read && Object.keys(req.query || {}).length) {
            return res.status(400).json({ success: false, code: 'STUDIO_INPUT_INVALID' });
        }
        Identity.authorizeCapability(req.auth, req.params.businessId, read ? 'business.read' : 'sales.write');
        if (!read) {
            const accepted = process.env.WHATSAPP_CRM_PUBLIC_URL
                ? new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin : `${req.protocol}://${req.get('host')}`;
            if (req.get('origin') !== accepted || req.get('sec-fetch-site') === 'cross-site') {
                return res.status(403).json({ success: false, code: 'STUDIO_ORIGIN_REQUIRED' });
            }
        }
        next();
    } catch (error) { materialError(res, error); }
}
function materialError(res, error) {
    const code = /^(STUDIO_|DEAL_|BUSINESS_|SALES_|ACCOUNT_|CAPABILITY_|AVA_)/.test(error?.code || '')
        ? error.code : 'STUDIO_UNAVAILABLE';
    return res.status(error.statusCode || 503).json({ success: false, code });
}
const path = '/businesses/:businessId/studio/proposals/:dealId';
router.put(path + '/material', materialGuard, (req, res) => {
    try { res.json(Studio.save(req.auth, req.params.businessId, req.params.dealId, req.body)); }
    catch (error) { materialError(res, error); }
});
router.post(path + '/handoff', materialGuard, (req, res) => {
    try {
        if (!req.body || Object.keys(req.body).join(',') !== 'revision' || Object.keys(req.query).length) {
            return res.status(400).json({ success: false, code: 'STUDIO_INPUT_INVALID' });
        }
        res.json(Studio.handoff(req.auth, req.params.businessId, req.params.dealId, req.body.revision));
    } catch (error) { materialError(res, error); }
});
router.get(path + '/handoff', materialGuard, (req, res) => {
    try {
        if (Object.keys(req.query).join(',') !== 'revision' || !/^[1-9]\d{0,8}$/.test(req.query.revision)) {
            return res.status(400).json({ success: false, code: 'STUDIO_INPUT_INVALID' });
        }
        res.json(Studio.handoff(req.auth, req.params.businessId, req.params.dealId, Number(req.query.revision)));
    } catch (error) { materialError(res, error); }
});

module.exports = router;
