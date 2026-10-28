'use strict';
// Exact application schema methods only. Never DB.init(), application entrypoints,
// timers, transports, queues or user/password cleanup.
const fs = require('fs'), path = require('path'), { createRequire } = require('module');
const output = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
for (const key of ['log', 'info', 'warn', 'error', 'debug']) console[key] = () => {};
let db;
try {
    const mode = process.argv[2], target = process.env.DB_PATH;
    if (!['migrate', 'compat'].includes(mode) || !target || !path.isAbsolute(target)
        || !fs.statSync(target).isFile()) throw Error('MIGRATION_INPUT_INVALID');
    const appRoot = process.env.AVA_RELEASE_APP_ROOT || '/app';
    const appRequire = createRequire(path.join(appRoot, 'package.json'));
    const SQLite = appRequire('better-sqlite3');
    db = new SQLite(target, { readonly: mode === 'compat', fileMustExist: true });
    appRequire('sqlite-vec').load(db);
    db.pragma('busy_timeout=10000');
    db.pragma('foreign_keys=ON');
    if (mode === 'migrate') {
        const DB = appRequire('./src/services/database.service');
        DB.db = db;
        for (const table of ['instances', 'ava_users', 'ava_business_memberships', 'ava_invitations',
            'ava_identity_outbox', 'ava_sessions']) {
            if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
                throw Error('MIGRATION_BASELINE_MISSING');
        }
        // Identity prior security schema must already match reviewed deployed DB.
        // Clone preservation checks reject any destructive legacy migration.
        appRequire('./src/services/identity/identity-store').ensureSchema();
        db.transaction(() => {
            appRequire('./src/services/identity/self-registration.service').ensureSchema({ cleanup: false });
            appRequire('./src/services/identity/password-recovery.service').ensureSchema();
            if (fs.existsSync(path.join(appRoot, 'src/services/onboarding-state.service.js')))
                appRequire('./src/services/onboarding-state.service').ensureSchema();
            if (fs.existsSync(path.join(appRoot, 'src/services/assistant-draft.service.js')))
                appRequire('./src/services/assistant-draft.service').ensureSchema();
        }).immediate();
    }
    if (db.pragma('integrity_check').some(row => row.integrity_check !== 'ok')) throw Error('MIGRATION_INTEGRITY_FAILED');
    if (db.pragma('foreign_key_check').length) throw Error('MIGRATION_FOREIGN_KEYS_FAILED');
    db.close();
    output(JSON.stringify({ schemaVerified: true }) + '\n');
} catch (_) {
    if (db?.open) db.close();
    process.stderr.write('MIGRATION_FAILED\n');
    process.exitCode = 1;
}
