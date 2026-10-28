'use strict';
const { describe, it, assert } = require('./test-helper');
const SQLite = require('better-sqlite3');
const { columns, migrate } = require('../../scripts/ava-product-audit-media-migration.cjs');
const snapshots = require('../../scripts/customer-completion-release/migrations.cjs');
function fixture(run) {
    const db = new SQLite(':memory:');
    db.exec("CREATE TABLE whatsapp_media_inputs(id INTEGER PRIMARY KEY, resultText TEXT); INSERT INTO whatsapp_media_inputs VALUES(1,'retained'); CREATE TABLE other(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO other VALUES(1,'retained');");
    const initialize = () => {
        const existing = db.pragma('table_info(whatsapp_media_inputs)').map(c => c.name);
        for (const c of columns) if (!existing.includes(c.name)) db.exec(`ALTER TABLE whatsapp_media_inputs ADD COLUMN ${c.name} ${c.definition}`);
    };
    try { run(db, initialize); } finally { db.close(); }
}
describe('product audit media migration', () => {
    it('adds four nullable columns, retains rows and is idempotent', () => fixture((db, initialize) => {
        const first = migrate(SQLite, db, initialize, snapshots);
        assert.deepStrictEqual(first.addedColumns, columns.map(c => c.name));
        assert.strictEqual(db.prepare('SELECT resultText FROM whatsapp_media_inputs').get().resultText, 'retained');
        assert.deepStrictEqual(migrate(SQLite, db, initialize, snapshots).addedColumns, []);
    }));
    it('rolls back if an initializer changes an existing row', () => fixture((db, initialize) => {
        assert.throws(() => migrate(SQLite, db, () => { initialize(); db.exec("UPDATE other SET value='changed'"); }, snapshots), /MIGRATION_EXISTING_ROWS_CHANGED/);
        assert.strictEqual(db.prepare('SELECT value FROM other').get().value, 'retained');
        assert.strictEqual(db.pragma('table_info(whatsapp_media_inputs)').length, 2);
    }));
    it('rolls back unreviewed schema and rejects an incompatible existing column', () => fixture((db, initialize) => {
        assert.throws(() => migrate(SQLite, db, () => { initialize(); db.exec('ALTER TABLE other ADD COLUMN unexpected TEXT'); }, snapshots), /MIGRATION_/);
        assert.strictEqual(db.pragma('table_info(other)').length, 2);
        db.exec('ALTER TABLE whatsapp_media_inputs ADD COLUMN mimeType INTEGER');
        assert.throws(() => migrate(SQLite, db, initialize, snapshots), /MEDIA_MIGRATION_COLUMN_CONTRACT/);
    }));
});
