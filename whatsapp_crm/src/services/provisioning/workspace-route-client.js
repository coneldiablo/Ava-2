'use strict';
const http = require('http');

function ensureWorkspaceRoute(businessId, slug) {
    const socketPath = process.env.AVA_WORKSPACE_ROUTE_SOCKET;
    if (!socketPath) throw Object.assign(new Error('Настройка защищённого адреса CRM ожидает администратора'), {
        code: 'WORKSPACE_ROUTE_HELPER_REQUIRED', retryable: false,
    });
    const body = JSON.stringify({ business_id: businessId, slug });
    return new Promise((resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('Не удалось подготовить защищённый адрес CRM'), {
            code: 'WORKSPACE_ROUTE_NOT_VERIFIED', retryable: true,
        }));
        const request = http.request({ socketPath, path: '/workspace/ensure', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, response => {
            let data = '';
            response.on('error', fail);
            response.on('data', chunk => {
                data += chunk;
                if (data.length > 4096) { request.destroy(); fail(); }
            });
            response.on('end', () => {
                try {
                    const value = JSON.parse(data);
                    if (response.statusCode !== 200 || value.business_id !== businessId || value.https_ready !== true
                        || value.hostname !== `${slug}.crm.meludtech.tech`) return fail();
                    resolve(value);
                } catch (_) { fail(); }
            });
        });
        request.setTimeout(240000, () => { request.destroy(); fail(); });
        request.on('error', fail);
        request.end(body);
    });
}
module.exports = { ensureWorkspaceRoute };
