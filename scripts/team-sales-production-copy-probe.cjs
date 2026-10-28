'use strict';
// Execute only against a server-private copied database, with no provider network.
const fs = require('node:fs');
const crypto = require('node:crypto');
const SQLite = require('/app/node_modules/better-sqlite3');
const path = process.env.DB_PATH;
if (!path || !path.startsWith('/probe/')) throw new Error('ISOLATED_COPY_REQUIRED');
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fingerprint(db, schema) {
  return Object.fromEntries(Object.entries(schema).map(([table, columns]) => {
    const quote = x => '"' + x.replaceAll('"', '""') + '"';
    const rows = db.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)}`).all();
    return [table, {count: rows.length, sha256: digest(rows.map(row => JSON.stringify(row)).sort().join('\n'))}];
  }));
}
(async () => {
  let db = new SQLite(path);
  const tables = db.pragma('table_list').filter(row => row.schema === 'main' && row.type === 'table' && !row.name.startsWith('sqlite_')).sort((a,b) => a.name.localeCompare(b.name));
  const schema = Object.fromEntries(tables.map(({name}) => [name, db.prepare(`PRAGMA table_info("${name.replaceAll('"','""')}")`).all().map(x => x.name)]));
  const before = fingerprint(db, schema);
  const oldOutbox = new Map(db.prepare('SELECT * FROM twenty_sync_outbox').all().map(row => [row.eventId, JSON.stringify(row)]));
  const beforeForeignKeys = db.pragma('foreign_key_check').length;
  db.close();
  // Do not emit database contents, credentials, IDs or invitation tokens.
  const log = console.log, warn = console.warn, error = console.error;
  console.log = console.warn = console.error = () => {};
  const DB = require('/app/src/services/database.service');
  const Identity = require('/app/src/services/identity/identity-store');
  const passes = [];
  try {
    for (let pass = 0; pass < 2; pass++) {
      await DB.init();
      Identity.ensureSchema();
      DB.createSalesWorkspaceTables();
      const after = fingerprint(DB.db, schema);
      const changed = Object.keys(before).filter(table => JSON.stringify(before[table]) !== JSON.stringify(after[table]));
      const unexpected = changed.filter(table => table !== 'twenty_sync_outbox');
      if (unexpected.length) throw new Error('ORIGINAL_ROWS_CHANGED:' + unexpected.join(','));
      const outbox = DB.db.prepare('SELECT * FROM twenty_sync_outbox').all();
      const currentOutbox = new Map(outbox.map(row => [row.eventId, JSON.stringify(row)]));
      for (const [id, original] of oldOutbox) if (currentOutbox.get(id) !== original) throw new Error('ORIGINAL_OUTBOX_ROW_CHANGED');
      const appended = outbox.filter(row => !oldOutbox.has(row.eventId));
      for (const row of appended) {
        const task = DB.db.prepare('SELECT assigneeUserId FROM manager_tasks WHERE taskId=? AND instanceId=?').get(row.sourceId, row.businessId);
        if (row.sourceTable !== 'manager_tasks' || row.entityType !== 'manager_task' || row.operation !== 'upsert' || row.status !== 'PENDING' || !task?.assigneeUserId) throw new Error('UNEXPECTED_MIGRATION_OUTBOX_APPEND');
      }
      if (pass && appended.length !== passes[0].assignmentSyncEventsAppended) throw new Error('MIGRATION_RESTART_ADDED_OUTBOX');
      if (DB.db.pragma('integrity_check', {simple: true}) !== 'ok') throw new Error('INTEGRITY_FAILED');
      const violations = DB.db.pragma('foreign_key_check').length;
      if (violations !== beforeForeignKeys) throw new Error('FOREIGN_KEYS_CHANGED');
      for (const table of ['ava_business_memberships', 'ava_invitations']) {
        const sql = DB.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(table).sql;
        if (!sql.includes("'sales_lead'") || !sql.includes("'observer'")) throw new Error('ROLE_CHECK_MISSING');
      }
      for (const table of ['clients', 'manager_tasks']) {
        if (!DB.db.prepare(`PRAGMA table_info(${table})`).all().some(x => x.name === 'assigneeUserId')) throw new Error('ASSIGNMENT_COLUMN_MISSING');
      }
      if (DB.db.pragma('foreign_keys', {simple: true}) !== 1) throw new Error('FK_ENFORCEMENT_DISABLED');
      passes.push({pass: pass + 1, originalTables: tables.length, originalRowsUnchanged: true, assignmentSyncEventsAppended: appended.length, integrity: 'ok', foreignKeyViolations: violations});
      DB.db.close();
    }
  } finally { console.log = log; console.warn = warn; console.error = error; }
  console.log(JSON.stringify({success: true, passes, liveDatabaseWritten: false, providerCalls: 0}));
})().catch(err => {
  fs.writeFileSync('/probe/migration-error.private.txt', String(err.stack || err), {mode: 0o600});
  process.stderr.write('MIGRATION_PROBE_FAILED; details remain server-private\n');
  process.exitCode = 1;
});
