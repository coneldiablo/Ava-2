'use strict';
// Derive exact new sqlite_master entries using application DDL on synthetic DB.
// Real baseline preservation is separately checked against an online backup.
const path = require('path'), fs = require('fs'), crypto = require('crypto'), { createRequire } = require('module');
const output = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
for (const key of ['log','info','warn','error','debug']) console[key] = () => {};
let db;
try {
    const appRoot = process.env.AVA_RELEASE_APP_ROOT;
    const baselineRoot = process.env.AVA_RELEASE_BASELINE_APP_ROOT;
    if (!appRoot || !baselineRoot || !path.isAbsolute(appRoot) || !path.isAbsolute(baselineRoot)
        || path.resolve(appRoot) === path.resolve(baselineRoot)) throw Error('IMMUTABLE_BASELINE_REQUIRED');
    const appRequire = createRequire(path.join(appRoot, 'package.json'));
    const baselineRequire = createRequire(path.join(baselineRoot, 'package.json'));
    // Seed only the explicitly pinned pre-feature application. Candidate identity
    // DDL must run AFTER the names snapshot, including any new staff-mail table.
    db = baselineRequire('./tests/test-helper').createTestDB();
    baselineRequire('./src/services/identity/identity-store').ensureSchema();
    const names = new Set(db.prepare('SELECT name FROM sqlite_master').all().map(row => row.name));
    appRequire('./src/services/database.service').db = db;
    appRequire('./src/services/identity/identity-store').ensureSchema();
    appRequire('./src/services/identity/self-registration.service').ensureSchema({cleanup:false});
    appRequire('./src/services/identity/password-recovery.service').ensureSchema();
    if (fs.existsSync(path.join(appRoot, 'src/services/onboarding-state.service.js')))
        appRequire('./src/services/onboarding-state.service').ensureSchema();
    if (fs.existsSync(path.join(appRoot, 'src/services/assistant-draft.service.js')))
        appRequire('./src/services/assistant-draft.service').ensureSchema();
    const additions = db.prepare('SELECT name,type,tbl_name,sql FROM sqlite_master ORDER BY name').all()
        .filter(row => !names.has(row.name)).map(({name,type,tbl_name,sql}) => ({name,type,tbl_name,
            sqlHash:crypto.createHash('sha256').update(sql || '').digest('hex')}));
    if (!additions.length) throw Error('EMPTY_SCHEMA');
    db.close(); output(JSON.stringify(additions, null, 2) + '\n');
} catch (_) {
    if (db?.open) db.close();
    process.stderr.write('SCHEMA_CONTRACT_FAILED\n'); process.exitCode=1;
}
