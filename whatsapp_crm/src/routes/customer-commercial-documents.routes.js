'use strict';
const express = require('express');
const Identity = require('../services/identity/identity-store');
const Documents = require('../services/commercial-documents.service');
const Access = require('../services/identity/customer-access');
const router = express.Router();
const base = '/businesses/:businessId/studio/proposals/:dealId/documents';
function error(res,e) { return res.status(e.statusCode || 503).json({ success: false,
    code: /^(DOCUMENT_|WORKSPACE_|STUDIO_|DEAL_|SALES_|BUSINESS_|CAPABILITY_|ACCOUNT_|AVA_)/.test(e.code || '') ? e.code : 'DOCUMENT_UNAVAILABLE' }); }
function guard(req,res,next) {
    try {
        if (!req.auth?.userId || req.auth.platformRole === 'platform_admin') return res.status(403).json({ success: false, code: 'CUSTOMER_ACCESS_REQUIRED' });
        Identity.authorizeCapability(req.auth,req.params.businessId,req.method === 'GET' ? 'sales.read' : 'sales.write');
        if (req.method !== 'GET') {
            const origin = process.env.WHATSAPP_CRM_PUBLIC_URL ? new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin : `${req.protocol}://${req.get('host')}`;
            if (req.get('origin') !== origin || req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ success: false, code: 'DOCUMENT_ORIGIN_REQUIRED' });
        }
        if (Object.keys(req.query).some(key => !(req.path.endsWith('/proposal.pdf') && key === 'revision'))) return res.status(400).json({ success: false, code: 'DOCUMENT_INPUT_INVALID' });
        res.set('Cache-Control','no-store'); next();
    } catch(e) { error(res,e); }
}
router.get(base,guard,(req,res) => { try { res.json(Documents.list(req.auth,req.params.businessId,req.params.dealId)); } catch(e) { error(res,e); } });
router.post(base + '/invoices',guard,(req,res) => { try { res.json(Documents.issue(req.auth,req.params.businessId,req.params.dealId,req.body)); } catch(e) { error(res,e); } });
router.get(base + '/proposal.pdf',guard,async (req,res) => {
    try { const pdf = await Documents.proposalPdf(req.auth,req.params.businessId,req.params.dealId,Number(req.query.revision));
        Access.reauthorize(req,req.params.businessId,'sales.read');
        res.type('pdf').set('Content-Disposition',`attachment; filename="proposal-v${Number(req.query.revision)}.pdf"`).send(pdf); } catch(e) { error(res,e); }
});
router.get(base + '/invoices/:revision.pdf',guard,async (req,res) => {
    try { const pdf = await Documents.invoicePdf(req.auth,req.params.businessId,req.params.dealId,Number(req.params.revision));
        Access.reauthorize(req,req.params.businessId,'sales.read');
        res.type('pdf').set('Content-Disposition',`attachment; filename="invoice-v${Number(req.params.revision)}.pdf"`).send(pdf); } catch(e) { error(res,e); }
});
router.post(base + '/send',guard,async (req,res) => {
    try {
        const input=req.body || {};
        if (Object.keys(input).some(key => !['kind','revision','expectedDialogueRevision'].includes(key)))
            throw Object.assign(new Error('DOCUMENT_INPUT_INVALID'),{code:'DOCUMENT_INPUT_INVALID',statusCode:400});
        const selection={kind:input.kind,revision:input.revision};
        Access.reauthorize(req,req.params.businessId,'messages.send');
        const attachment=await Documents.prepareDelivery(req.auth,req.params.businessId,req.params.dealId,selection);
        const beforeDispatch=()=>{
            Access.reauthorize(req,req.params.businessId,'messages.send');
            const current=Documents.deliverySnapshot(req.auth,req.params.businessId,req.params.dealId,selection);
            if(current.chatId!==attachment.chatId||current.documentKey!==attachment.documentKey||current.materialRevision!==attachment.materialRevision)
                throw Object.assign(new Error('DOCUMENT_MATERIAL_CHANGED'),{code:'DOCUMENT_MATERIAL_CHANGED',statusCode:409});
        };
        beforeDispatch();
        const text=selection.kind==='proposal'?'Коммерческое предложение · PDF':'Счет на оплату · PDF';
        const result=await require('../services/ava-workspace.service').reply(req.auth,req.params.businessId,attachment.chatId,
            {text,idempotencyKey:attachment.documentKey,...(input.expectedDialogueRevision!==undefined?{expectedDialogueRevision:input.expectedDialogueRevision}:{})},
            {attachment,beforeDispatch});
        Access.reauthorize(req,req.params.businessId,'messages.send');
        res.json(result);
    } catch(e) { error(res,e); }
});
router.get(base + '/invoices/:revision',guard,(req,res) => {
    try { const invoice = Documents.read(req.auth,req.params.businessId,req.params.dealId,Number(req.params.revision));
        if (!invoice) return res.status(404).json({ success: false, code: 'DOCUMENT_NOT_FOUND' });
        res.json({ success: true, invoice }); } catch(e) { error(res,e); }
});
module.exports = router;
