'use strict';

// Release-only runner. It never starts the application, timers or transports.
const fs = require('fs');
const path = require('path');
const {createRequire} = require('module');
const output = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
for (const method of ['log','info','warn','error','debug']) console[method] = () => {};
let db;
try {
    const mode = process.argv[2];
    const appRoot = process.env.AVA_MIGRATION_APP_ROOT || '/app';
    const dbPath = process.env.DB_PATH;
    if (!['migrate','compat'].includes(mode) || !dbPath || !path.isAbsolute(dbPath)
        || !fs.statSync(dbPath).isFile()) throw new Error('MIGRATION_INPUT_INVALID');
    const appRequire = createRequire(path.join(appRoot,'package.json'));
    const Sqlite = appRequire('better-sqlite3');
    db = new Sqlite(dbPath,{readonly:mode==='compat',fileMustExist:true});
    try { appRequire('sqlite-vec').load(db); } catch (_) { /* Not every deployment uses vectors. */ }
    db.pragma('busy_timeout=10000');
    db.pragma('foreign_keys=ON');
    if (mode === 'migrate') {
        const DB = appRequire('./src/services/database.service');
        DB.db = db;
        for (const table of ['instances','clients','messages','ava_users','ava_business_memberships',
            'conversation_events','ava_workspace_reply_actions','ava_call_transcript_sources']) {
            if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))
                throw new Error('MIGRATION_BASELINE_MISSING');
        }
        db.transaction(() => {
            for (const module of ['ava-improvements-flags.service','ava-collaboration.service',
                'ava-availability.service','ava-knowledge-review.service'])
                appRequire('./src/services/'+module).ensureSchema();
        }).immediate();
    }
    const integrity = db.pragma('integrity_check');
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('MIGRATION_INTEGRITY_FAILED');
    if (db.pragma('foreign_key_check').length) throw new Error('MIGRATION_FOREIGN_KEYS_FAILED');
    db.close();
    output(JSON.stringify({schemaVerified:true})+'\n');
} catch (error) {
    if (db?.open) db.close();
    const code = /^MIGRATION_/.test(error.message || '') ? error.message : 'MIGRATION_FAILED';
    process.stderr.write(code+'\n');
    process.exitCode = 1;
}
