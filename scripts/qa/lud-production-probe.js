'use strict';
// Run on stdin inside the CRM container. SELECT-only, no application imports.
const SQLite = require('better-sqlite3');
const crypto = require('crypto');
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const db = new SQLite(process.env.DB_PATH || '/app/data/crm_v2.db', { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');
const all = (sql, ...args) => db.prepare(sql).all(...args);
const ownerEmail = process.env.LUD_OWNER_EMAIL;
if (!ownerEmail) throw new Error('LUD_OWNER_EMAIL_REQUIRED');
const exists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
async function main() {
    const users = all('SELECT id,enabled,subject IS NOT NULL AS linked FROM ava_users WHERE lower(email)=lower(?)', ownerEmail);
    const result = { observedAt: new Date().toISOString(), ownerMatches: users.length, businesses: [] };
    for (const user of users) {
        for (const membership of all('SELECT businessId,role,enabled FROM ava_business_memberships WHERE userId=?', user.id)) {
            const businessId = membership.businessId;
            const i = db.prepare('SELECT * FROM instances WHERE id=?').get(businessId);
            const item = { businessId, ownerHash: hash(user.id), ownerEnabled: user.enabled, subjectLinked: Boolean(user.linked),
                membershipRole: membership.role, membershipEnabled: membership.enabled, active: i.isActive, provider: i.whatsappProvider,
                sessionBound: Boolean(i.openWaSessionId), sessionHash: i.openWaSessionId ? hash(i.openWaSessionId) : null,
                sessionBindingCount: i.openWaSessionId ? all('SELECT id FROM instances WHERE openWaSessionId=?', i.openWaSessionId).length : 0,
                messages: all('SELECT role,COUNT(*) AS count,MIN(timestamp) AS firstAt,MAX(timestamp) AS lastAt,COUNT(sourceMessageId) AS withSourceId FROM messages WHERE instanceId=? GROUP BY role', businessId),
                knowledge: all('SELECT k.id,k.version,k.isCurrent,k.chunkCount,k.hasEmbeddings,COUNT(c.id) AS actualChunks FROM knowledge_base k LEFT JOIN kb_chunks c ON c.kbId=k.id WHERE k.instanceId=? GROUP BY k.id', businessId),
                tenantLinks: all('SELECT status,cc_pair_id IS NOT NULL AS connectorBound FROM onyx_tenant_links WHERE business_id=?', businessId),
                agentBindings: all('SELECT role FROM onyx_agent_bindings WHERE business_id=?', businessId),
                documentLinks: all('SELECT entity_type,COUNT(*) AS count FROM onyx_document_links WHERE business_id=? GROUP BY entity_type', businessId),
                sync: all('SELECT entity_type,operation,status,COUNT(*) AS count,MAX(attempts) AS maxAttempts,last_error_code FROM onyx_sync_outbox WHERE business_id=? GROUP BY entity_type,operation,status,last_error_code', businessId),
                activeOwnerSessions: db.prepare('SELECT COUNT(*) AS count FROM ava_sessions WHERE userId=? AND revokedAt IS NULL AND expiresAt>?').get(user.id, Date.now()).count,
                deploymentTables: all("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%deployment%' OR name LIKE '%provision%')").map(r => r.name),
            };
            if (exists('module_deployments')) {
                item.deploymentColumns = all('PRAGMA table_info(module_deployments)').map(r => r.name);
            }
            if (i.openWaSessionId) {
                let base = i.openWaUrl || process.env.OPENWA_URL || 'http://whatsapp_crm_openwa:2785';
                if (process.env.OPENWA_URL && /localhost|127\.0\.0\.1/.test(base)) base = process.env.OPENWA_URL;
                base = base.replace(/\/+$/, '').replace(/\/api$/, '') + '/api';
                try {
                    const response = await fetch(`${base}/sessions/${encodeURIComponent(i.openWaSessionId)}`, {
                        headers: { 'X-API-Key': i.openWaApiKey || process.env.OPENWA_API_KEY || '' }, signal: AbortSignal.timeout(10000), redirect: 'error',
                    });
                    item.providerRead = { httpStatus: response.status };
                    if (response.ok) {
                        const state = await response.json();
                        item.providerRead.status = state.status;
                        item.providerRead.engineLoaded = state.engineLoaded;
                        item.providerRead.hasLastError = Boolean(state.lastError);
                        item.providerRead.webhookConfigured = Boolean(state.webhookUrl || state.webhook);
                    }
                } catch (_) { item.providerRead = { errorCode: 'PROVIDER_READ_UNAVAILABLE' }; }
            }
            result.businesses.push(item);
        }
    }
    console.log(JSON.stringify(result, null, 2));
}
main().finally(() => db.close()).catch(() => { console.error('PROBE_FAILED'); process.exitCode = 1; });
