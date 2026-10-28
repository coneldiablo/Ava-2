'use strict';
// Add only the nullable media metadata columns shipped in ea6a150.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const columns = [
    { name: 'mimeType', definition: 'TEXT', defaultValue: null },
    { name: 'byteLength', definition: 'INTEGER', defaultValue: null },
    { name: 'downloadedAt', definition: 'INTEGER', defaultValue: null },
    { name: 'timingsJson', definition: 'TEXT', defaultValue: null },
];
function migrate(SQLite, db, initialize, snapshots) {
    return db.transaction(() => {
        const before = snapshots.snapshot(db);
        assert.ok(before.tables.whatsapp_media_inputs, 'MEDIA_MIGRATION_TABLE_REQUIRED');
        for (const column of columns) {
            const existing = before.tables.whatsapp_media_inputs.columns.find(c => c.name === column.name);
            if (existing) assert.ok(existing.type === column.definition && !existing.notnull && existing.dflt_value === null,
                'MEDIA_MIGRATION_COLUMN_CONTRACT');
        }
        initialize();
        const after = snapshots.snapshot(db, before);
        snapshots.compare(SQLite, before, after, {
            columns: { whatsapp_media_inputs: columns }, triggerReplacements: [], newTables: [],
        });
        const addedColumns = columns.filter(c => !before.tables.whatsapp_media_inputs.columns.some(old => old.name === c.name));
        for (const column of columns) {
            const next = after.tables.whatsapp_media_inputs.columns.find(c => c.name === column.name);
            assert.ok(next && next.type === column.definition && !next.notnull && next.dflt_value === null,
                'MEDIA_MIGRATION_COLUMN_CONTRACT');
        }
        for (const column of addedColumns) assert.equal(db.prepare(
            `SELECT COUNT(*) n FROM whatsapp_media_inputs WHERE "${column.name}" IS NOT NULL`).get().n, 0,
        'MEDIA_MIGRATION_BACKFILL_FORBIDDEN');
        assert.equal(db.pragma('integrity_check', { simple: true }), 'ok', 'MEDIA_MIGRATION_INTEGRITY');
        const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
        return { ok: true, addedColumns: addedColumns.map(c => c.name), existingRowsPreserved: true,
            existingColumnsPreserved: true, onlyAllowedSchemaChanges: true, integrityOk: true,
            beforeDigest: digest(before), afterDigest: digest(after) };
    }).immediate();
}
if (require.main === module) {
    assert.equal(process.env.AVA_RELEASE_MEDIA_MIGRATION, '1', 'MEDIA_MIGRATION_OPT_IN_REQUIRED');
    const output = process.stdout.write.bind(process.stdout);
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};
    const snapshots = require('/release/migrations.cjs');
    snapshots.prohibitActivity();
    const requireApp = createRequire('/app/package.json'), SQLite = requireApp('better-sqlite3');
    const db = new SQLite(process.env.DB_PATH, { fileMustExist: true });
    requireApp('sqlite-vec').load(db); db.pragma('busy_timeout=10000');
    const DB = requireApp('./src/services/database.service'); DB.db = db;
    try {
        const media = requireApp('./src/services/whatsapp-media.service');
        const result = migrate(SQLite, db, () => media.ensureSchema(), snapshots);
        db.close(); output(JSON.stringify(result) + '\n', () => process.exit(0));
    } catch (error) {
        db.close(); output(JSON.stringify({ ok: false, code: /^[A-Z_]+$/.test(error.message)
            ? error.message : 'MEDIA_MIGRATION_FAILED' }) + '\n', () => process.exit(1));
    }
}
module.exports = { columns, migrate };
