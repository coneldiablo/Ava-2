'use strict';

const Identity = require('./identity-store');
const DB = require('../database.service');
const CustomerAccess = require('./customer-access');
const policies = new Map(CustomerAccess.routePolicies);
policies.set('get /businesses/:businessId/telephony/external/requests/:key','business.read');
for(const [method,path] of [['post','/external'],['put','/external/:id'],['post','/external/:id/check'],['post','/external/:id/disconnect']])
    policies.set(method+' /businesses/:businessId/telephony'+path,'business.manage');
const add = (method, path, capability) => policies.set(`${method} ${path}`, capability);
for(const suffix of ['', '/catalog', '/orders/:id'])
    add('get','/businesses/:businessId/telephony'+suffix,'business.read');
for(const [method,suffix] of [['post','/quotes'],['post','/orders'],['put','/primary'],
    ['post','/numbers/:id/release'],['post','/numbers/:id/cancel-release']])
    add(method,'/businesses/:businessId/telephony'+suffix,'business.manage');

for(const prefix of ['/businesses/:businessId/telephony']) {
    add('get',prefix+'/existing','business.manage');
    add('post',prefix+'/imports','business.manage');
}
for(const suffix of ['recording','recording.wav']) add('get','/calls/:instanceId/:recordId/'+suffix,'business.read');

for (const path of [
    '/deals/:instanceId', '/deals/:instanceId/:dealId',
    '/dashboard/:instanceId/metrics', '/dashboard/:instanceId/intelligence',
    '/dashboard/:businessId/activity', '/dashboard/:businessId/ai/briefing',
    '/dashboard/:businessId/ai/recommendations', '/dashboard/:businessId/ai/briefing.pdf',
    '/businesses/:businessId/studio/proposals/:dealId',
    '/customer-intelligence/:instanceId/:chatId', '/calls/stats/:instanceId',
    '/calls/:instanceId', '/clients/:instanceId/:chatId/calls',
    '/businesses/:businessId/activity', '/clients/:instanceId/:chatId/identities',
    '/businesses/:businessId/knowledge/native-status', '/businesses/:businessId/native-modules/status',
    '/businesses/:businessId/knowledge/documents/:documentId/chunks',
    '/businesses/:businessId/crm/tasks/:taskId',
    '/businesses/:businessId/business-gpt/chats', '/businesses/:businessId/business-gpt/chats/:chatId',
    '/businesses/:businessId/outbound/campaigns/:campaignId/attempts',
    '/businesses/:businessId/instagram', '/businesses/:businessId/instagram-private',
]) add('get', path, 'business.read');
add('get', '/businesses/:businessId/team', 'team.read');
add('get', '/businesses/:businessId/sales-workspace', 'sales.read');
for (const [method, path] of [
    ['post','/deals/:instanceId'], ['put','/deals/:instanceId/:dealId'],
    ['delete','/deals/:instanceId/:dealId'], ['patch','/dashboard/:instanceId/tasks/:taskId'],
    ['post','/clients/:instanceId/:chatId/identities'],
    ['delete','/clients/:instanceId/:chatId/identities/:aliasId'],
    ['post','/businesses/:businessId/crm/tasks'],
    ['post','/businesses/:businessId/sales-workspace/tasks'],
    ['patch','/businesses/:businessId/sales-workspace/tasks/:taskId'],
    ['put','/businesses/:businessId/sales-workspace/clients/:chatId/assignee'],
    ['put','/businesses/:businessId/sales-workspace/clients/:chatId/name'],
]) add(method, path, 'sales.write');
add('post', '/businesses/:businessId/sales-workspace/tasks/:taskId/claim', 'tasks.claim');
for (const [method, path] of [
    ['get','/dashboard/:businessId/ai/overview'], ['get','/dashboard/:businessId/ai/briefing/audio'],
    ['post','/dashboard/:businessId/ai/ask'], ['post','/businesses/:businessId/knowledge/preview'],
    ['post','/businesses/:businessId/business-gpt/chats'],
    ['post','/businesses/:businessId/business-gpt/chats/:chatId/messages'],
]) add(method, path, 'ai.use');
// Keyword preview is a read-only deterministic match and executes no trigger.
add('post', '/businesses/:businessId/triggers/:triggerId/preview', 'business.read');
for (const [method, path] of [
    ['post','/businesses/:businessId/knowledge/documents/:documentId/sync'],
    ['put','/businesses/:businessId/knowledge/documents/:documentId/chunks/:chunkId'],
    ['delete','/businesses/:businessId/knowledge/documents/:documentId'],
    ['post','/businesses/:businessId/instagram'], ['delete','/businesses/:businessId/instagram'],
    ['post','/businesses/:businessId/instagram-private/login'],
    ['post','/businesses/:businessId/instagram-private/poll'],
    ['delete','/businesses/:businessId/instagram-private'],
]) add(method, path, 'business.manage');
add('post', '/businesses/:businessId/instagram-private/reply', 'messages.send');
for (const [method, path] of [
    ['post','/businesses/:businessId/team/invitations'],
    ['patch','/businesses/:businessId/team/members/:userId'],
    ['delete','/businesses/:businessId/team/members/:userId'],
    ['post','/businesses/:businessId/team/invitations/:invitationId/renew'],
    ['post','/businesses/:businessId/team/invitations/:invitationId/resend'],
    ['delete','/businesses/:businessId/team/invitations/:invitationId'],
]) add(method, path, 'team.manage');

// AVA customer workspaces: method-specific and business-scoped. Individual
// handlers enforce canonical assignment, revisions and external-send fencing.
add('get', '/businesses/:businessId/workspace/features', 'sales.read');
add('patch', '/businesses/:businessId/workspace/features', 'business.manage');
for (const path of ['/workspace/attention','/workspace/availability','/workspace/knowledge-review','/workspace/clients/:chatId/presence'])
    add('get','/businesses/:businessId'+path,'sales.read');
add('get','/businesses/:businessId/workspace/clients/:chatId/reply-recovery','sales.read');
add('post','/businesses/:businessId/workspace/clients/:chatId/reply-recovery','sales.write');
add('get','/businesses/:businessId/workspace/clients/:chatId/messages/:messageId/media','sales.read');
add('post','/businesses/:businessId/workspace/clients/:chatId/messages/:messageId/media/retry','sales.write');
add('post','/businesses/:businessId/workspace/clients/:chatId/presence','sales.write');
add('patch','/businesses/:businessId/workspace/availability/:userId','sales.write');
add('post','/businesses/:businessId/workspace/clients/:chatId/copilot','ai.use');
add('post','/businesses/:businessId/workspace/knowledge-review/drafts','sales.write');
add('patch','/businesses/:businessId/workspace/knowledge-review/drafts/:id','sales.write');
for (const action of ['check','publish','rollback'])
    add('post','/businesses/:businessId/workspace/knowledge-review/drafts/:id/'+action,'sales.assign');
for (const path of ['/workspace','/workspace/clients/:chatId','/workspace/clients/:chatId/reply-status','/promises','/search','/saved-views','/release-flags','/autopilot','/catalog','/quotes'])
    add('get','/businesses/:businessId'+path,'sales.read');
for (const [method,path] of [['post','/workspace/clients/:chatId/control'],['post','/workspace/clients/:chatId/snooze'],
    ['post','/promises'],['patch','/promises/:id'],['post','/saved-views'],['delete','/saved-views/:id'],['post','/quotes']])
    add(method,'/businesses/:businessId'+path,'sales.write');
for (const path of ['/workspace/clients/:chatId/reply','/quotes/:id/send']) add('post','/businesses/:businessId'+path,'messages.send');
for (const [method,path] of [['put','/release-flags'],['put','/autopilot/policy'],['post','/autopilot/publish'],['post','/autopilot/pause'],
    ['post','/autopilot/rollback'],['post','/autopilot/simulations'],['post','/catalog'],['patch','/catalog/:id'],['post','/catalog/:id/publish'],
    ['put','/workspace/quality-criteria']]) add(method,'/businesses/:businessId'+path,'business.manage');
for (const path of ['/workspace/analytics','/workspace/quality-criteria']) add('get','/businesses/:businessId'+path,'sales.assign');

// Product catalog import uses the existing published Autopilot catalog.
add('get', '/businesses/:businessId/catalog-imports/:id', 'business.read');
for (const suffix of ['/preview', '/:id/validate', '/:id/commit', '/:id/rollback'])
    add('post', '/businesses/:businessId/catalog-imports' + suffix, 'business.manage');

add('patch','/businesses/:businessId/outbound/campaigns/:campaignId/retry-settings','business.manage');
for (const suffix of ['/campaigns', '/campaigns/:campaignId'])
    add('get', '/businesses/:businessId/outbound' + suffix, 'business.read');
for (const suffix of ['/imports/preview', '/campaigns', '/campaigns/:campaignId/commands', '/campaigns/:campaignId/reconcile'])
    add('post', '/businesses/:businessId/outbound' + suffix, 'business.manage');

add('get', '/businesses/:businessId/telephony/calls/:callId/result', 'business.read');

add('get', '/businesses/:businessId/telephony/records/:recordId/transcript', 'business.read');
for (const suffix of ['', '/proposal.pdf', '/invoices/:revision', '/invoices/:revision.pdf'])
    add('get', '/businesses/:businessId/studio/proposals/:dealId/documents' + suffix, 'sales.read');
add('post', '/businesses/:businessId/studio/proposals/:dealId/documents/invoices', 'sales.write');
add('post', '/businesses/:businessId/studio/proposals/:dealId/documents/send', 'messages.send');
add('put', '/businesses/:businessId/studio/proposals/:dealId/material', 'sales.write');
add('post', '/businesses/:businessId/studio/proposals/:dealId/handoff', 'messages.send');
add('get', '/businesses/:businessId/studio/proposals/:dealId/handoff', 'sales.read');
add('get', '/external-integrations/:instanceId/:provider', 'business.read');
add('get', '/external-integrations/:instanceId/amocrm/catalog', 'business.read');
for (const [method, suffix] of [['post', '/preview'], ['post', '/publish'], ['put', '/settings']])
    add(method, '/external-integrations/:instanceId/amocrm/catalog' + suffix, 'business.manage');
for (const suffix of ['/amocrm/options', '/avito/chats'])
    add('get', '/external-integrations/:instanceId' + suffix, 'business.manage');
for (const [method, suffix] of [['put', '/:provider'], ['delete', '/:provider'], ['post', '/:provider/connect'],
    ['post', '/amocrm/link'], ['post', '/:provider/check'], ['post', '/:provider/sync'], ['post', '/:provider/webhook'], ['post', '/avito/chats/:chatId/import']])
    add(method, '/external-integrations/:instanceId' + suffix, 'business.manage');

for (const method of ['get','put']) add(method, '/businesses/:businessId/whatsapp/response-settings', method==='get'?'business.read':'business.manage');

for (const prefix of ['/businesses/:businessId/pms', '/hotel-profiles/:id/pms']) {
    add('get', prefix, 'business.read');
    add('put', prefix, 'business.manage');
    add('delete', prefix, 'business.manage');
    add('post', prefix + '/test', 'business.manage');
    add('post', prefix + '/sync', 'business.manage');
    add('post', prefix + '/webhooks', 'business.manage');
    add('get', prefix + '/bookings', 'business.read');
    add('get', prefix + '/booking-requests', 'business.read');
}

const routes = [...policies].map(([key, capability]) => {
    const [method, path] = key.split(' ');
    const names = [];
    const pattern = path.split('/').map(segment => {
        if (segment.startsWith(':')) { names.push(segment.slice(1)); return '([^/]+)'; }
        return [...segment].map(char => '.+*?^$()[]{}|'.includes(char) ? String.fromCharCode(92) + char : char).join('');
    }).join('/');
    return { method, path, capability, names, pattern: new RegExp(`^${pattern}/?$`, 'i') };
});
const fail = (code, statusCode = 403) => Object.assign(new Error(code), { code, statusCode });

// Mount after requireAuth and before all customer routers. A standalone router
// cannot accidentally introduce a new customer mutation by omitting its guard.
function customerRoleBoundary(req, res, next) {
    if (!req.auth?.userId) return next();
    try {
        if (Identity.actor(req.auth.userId).platformRole === 'platform_admin') return next();
        const method = req.method.toLowerCase() === 'head' ? 'get' : req.method.toLowerCase();
        const rule = routes.find(item => item.method === method && item.pattern.test(req.path));
        if (!rule) throw fail('CUSTOMER_ROUTE_NOT_AVAILABLE');
        const matched = rule.pattern.exec(req.path);
        const params = Object.fromEntries(rule.names.map((name, index) => [name, decodeURIComponent(matched[index + 1])]));
        let businessId = params.businessId ?? params.instanceId;
        if (rule.path.startsWith('/instances/:id') || rule.path.startsWith('/hotel-profiles/:id')) businessId = params.id;
        if (rule.path.startsWith('/sales-brain/followup-drafts/')) businessId = req.body?.instanceId;
        if (rule.path === '/simulate' || rule.path === '/sales-brain/outbound/campaigns') {
            businessId = req.body?.instanceId ?? req.body?.instance_id;
        }
        if (rule.path.startsWith('/sales-brain/outbound/campaigns/:campaignId')) {
            const campaign = DB.getOutboundCampaign(params.campaignId);
            if (!campaign) throw fail('CAMPAIGN_NOT_FOUND', 404);
            businessId = campaign.instanceId;
        }
        if (businessId != null) {
            businessId = Identity.authorizeCapability(req.auth, businessId, rule.capability);
            for (const source of [req.body, req.query]) for (const key of ['businessId','business_id','instanceId','instance_id']) {
                if (source?.[key] != null && Number(source[key]) !== businessId) throw fail('BUSINESS_SCOPE_MISMATCH');
            }
        } else if (['get /instances','get /hotel-profiles','post /instances'].includes(`${method} ${rule.path}`)) {
            const current = Identity.actor(req.auth.userId);
            if (method === 'post' && current.businessQuota < 1
                && !current.memberships.some(item => item.role === 'hotel_owner')) throw fail('BUSINESS_ACCESS_DENIED');
        } else throw fail('BUSINESS_SCOPE_REQUIRED', 400);
        // A browser GET can also start a billed operation. Require the same
        // origin there before the provider is invoked.
        if (method !== 'get' || rule.capability === 'ai.use') {
            const accepted = new Set();
            if (process.env.WHATSAPP_CRM_PUBLIC_URL) accepted.add(new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin);
            if (req.get('host')) accepted.add(`${req.protocol}://${req.get('host')}`);
            // Same-origin GET fetches commonly omit Origin; Fetch Metadata then
            // supplies the browser's origin guarantee for paid read-shaped APIs.
            const sameOriginGet = method === 'get' && !req.get('origin') && req.get('sec-fetch-site') === 'same-origin';
            if ((!sameOriginGet && !accepted.has(req.get('origin'))) || req.get('sec-fetch-site') === 'cross-site') {
                throw fail('CUSTOMER_ORIGIN_REQUIRED');
            }
        }
        next();
    } catch (error) {
        return res.status(error.statusCode || 403).json({ success: false, code: error.code || error.message,
            error: 'Недостаточно прав для этого действия.' });
    }
}

module.exports = customerRoleBoundary;
module.exports.routePolicies = policies;
