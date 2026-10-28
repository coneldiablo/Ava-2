'use strict';
process.env.DOTENV_CONFIG_QUIET = 'true';
// Reproduce restart after durable inbound save, before queued processing.
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(process.argv[2]);
const baseline = process.argv.includes('--baseline');
const checkoutRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
assert.equal(checkoutRevision.status, 0);
const productChanges = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', 'whatsapp_crm/src', 'src/core'], { cwd: repo, encoding: 'utf8' });
assert.equal(productChanges.status, 0);
const req = Module.createRequire(path.join(repo, 'whatsapp_crm/package.json'));
const root = path.join(repo, 'whatsapp_crm');
const DB = req(path.join(root, 'src/services/database.service'));
const Logger = req(path.join(root, 'src/utils/logger'));
for (const key of ['info','warn','error','success','debug']) Logger[key] = () => {};
const push = req(path.join(root, 'src/services/push.service'));
push.notifyNewLead = async () => {};
req(path.join(root, 'tests/test-helper')).createTestDB();
let WA;
if (baseline) {
    const source = spawnSync('git', ['show', 'b3be6eefcf7d71fa905d4f4a0c26091982758501:whatsapp_crm/src/services/whatsapp.service.js'], { cwd: repo, encoding: 'utf8' });
    assert.equal(source.status, 0);
    const filename = path.join(root, 'src/services/whatsapp.service.js');
    const module = new Module(filename);
    module.filename = filename; module.paths = Module._nodeModulePaths(path.dirname(filename));
    module._compile(source.stdout, filename);
    WA = module.exports;
} else WA = req(path.join(root, 'src/services/whatsapp.service'));
const queued = [];
WA.batcher.enqueue = item => { queued.push(item); return { delayMs: 1, pendingCount: 1 }; };
async function main() {
    const business = await DB.createInstance({ name: 'Synthetic restart test', isActive: 1 });
    const event = { event: 'message.received', sessionId: 'synthetic-session', data: {
        id: 'synthetic-provider-source', from: 'synthetic-client@c.us', body: 'Synthetic inbound', fromMe: false,
    } };
    await WA.processOpenWaWebhook(event, business.id);
    assert.equal(queued.length, 1);
    WA.batcher.entries.clear();
    await WA.processOpenWaWebhook(event, business.id);
    assert.equal(DB.get("SELECT COUNT(*) AS n FROM messages WHERE instanceId=? AND role='user'", [business.id]).n, 1);
    if (baseline) {
        assert.equal(queued.length, 1, 'baseline gap no longer reproduced');
        console.log(JSON.stringify({ revision: 'b3be6eefcf7d71fa905d4f4a0c26091982758501 WhatsApp module', status: 'REPRODUCED',
            requirement: 'same provider delivery restores processing after lost in-memory queue', durableInboundRows: 1, firstEnqueues: 1, afterRestartDuplicateEnqueues: 1 }));
    } else {
        assert.equal(queued.length, 2);
        assert.equal(DB.get('SELECT COUNT(*) AS n FROM whatsapp_reply_jobs').n, 1);
        console.log(JSON.stringify({ revision: checkoutRevision.stdout.trim(), productWorkingTreeDirty: Boolean(productChanges.stdout.trim()), status: 'PASS', requirement: 'duplicate restores queued work without duplicating durable inbound', durableInboundRows: 1, durableJobs: 1, afterRestartDuplicateEnqueues: 2 }));
    }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => {
    if (DB.db?.open) DB.db.close();
    clearInterval(WA.recoveryTimer);
    setTimeout(() => process.exit(process.exitCode || 0), 20);
});
