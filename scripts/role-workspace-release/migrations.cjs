'use strict';

// Offline release runner: imports only explicit schema initializers. It never
// starts the application, channel adapters, background timers or providers.
const fs = require('fs');
const path = require('path');
const {createRequire} = require('module');
const output = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};
let db;
try {
    if (process.env.AVA_RELEASE_OFFLINE !== '1') throw new Error('RELEASE_OFFLINE_REQUIRED');
    const mode = process.argv[2];
    const dbPath = process.env.DB_PATH;
    const modules = JSON.parse(process.env.AVA_ROLE_SCHEMA_MODULES || 'null');
    if (!['migrate', 'compat'].includes(mode) || !path.isAbsolute(dbPath || '') ||
        !fs.statSync(dbPath).isFile() || !Array.isArray(modules) || !modules.length ||
        modules.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9-]*(?:\.(?:service|store))?$/.test(name))) {
        throw new Error('RELEASE_MIGRATION_INPUT_INVALID');
    }
    const appRequire = createRequire('/app/package.json');
    db = new (appRequire('better-sqlite3'))(dbPath, {readonly: mode === 'compat', fileMustExist: true});
    appRequire('sqlite-vec').load(db);
    db.pragma('busy_timeout=10000');
    db.pragma('foreign_keys=ON');
    if (mode === 'migrate') {
        appRequire('./src/services/database.service').db = db;
        db.transaction(() => {
            for (const name of modules) {
                const initializer = appRequire('./src/services/' + name);
                if (typeof initializer.ensureSchema !== 'function') throw new Error('RELEASE_SCHEMA_INITIALIZER_MISSING');
                initializer.ensureSchema();
            }
        }).immediate();
    }
    if (db.pragma('integrity_check', {simple: true}) !== 'ok' || db.pragma('foreign_key_check').length) {
        throw new Error('RELEASE_MIGRATION_INTEGRITY_FAILED');
    }
    db.close();
    output(JSON.stringify({schemaVerified: true}) + '\n');
} catch (error) {
    if (db?.open) db.close();
    process.stderr.write(/^RELEASE_[A-Z_]+$/.test(error.message || '') ? error.message + '\n' : 'RELEASE_MIGRATION_FAILED\n');
    process.exitCode = 1;
}
