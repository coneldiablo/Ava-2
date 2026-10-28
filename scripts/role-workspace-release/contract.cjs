'use strict';

// Structural release smoke on a disposable migrated copy. Product workflow
// tests and customer acceptance are separate from this image contract.
const path = require('path');
const {createRequire} = require('module');
let db;
try {
    if (process.env.AVA_RELEASE_OFFLINE !== '1' || process.argv[2] !== 'smoke' ||
        !path.isAbsolute(process.env.DB_PATH || '')) throw new Error('RELEASE_CONTRACT_INPUT_INVALID');
    const appRequire = createRequire('/app/package.json');
    db = new (appRequire('better-sqlite3'))(process.env.DB_PATH, {readonly: true, fileMustExist: true});
    appRequire('sqlite-vec').load(db);
    for (const name of ['instances', 'clients', 'messages', 'ava_users', 'ava_business_memberships']) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) {
            throw new Error('RELEASE_BASE_TABLE_MISSING');
        }
    }
    if (db.pragma('integrity_check', {simple: true}) !== 'ok' || db.pragma('foreign_key_check').length) {
        throw new Error('RELEASE_CONTRACT_INTEGRITY_FAILED');
    }
    db.close();
    console.log(JSON.stringify({contractVerified: true, structuralOnly: true}));
} catch (error) {
    if (db?.open) db.close();
    process.stderr.write(/^RELEASE_[A-Z_]+$/.test(error.message || '') ? error.message + '\n' : 'RELEASE_CONTRACT_FAILED\n');
    process.exitCode = 1;
}
