'use strict';
// Offline gate. Mount this module beside the pinned image, never start the app.
// node migration_probe.cjs migrate|apply|compat
// DB_PATH must name an existing absolute file; AVA_APP_ROOT defaults to /app.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const NEW_COLUMNS = new Set(['voiceModel', 'voiceSettings']);
const quote = name => '"' + name.replace(/"/g, '""') + '"';
const fail = (code, stage) => { throw Object.assign(new Error(code), { gateCode: code, gateStage: stage }); };
const requireGate = (condition, code, stage) => { if (!condition) fail(code, stage); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function digestRows(db, name, columns, withRowid) {
    const selected = columns.filter(column => column.hidden !== 1).map(column => quote(column.name));
    if (withRowid) selected.unshift('_rowid_');
    const rows = [];
    const statement = db.prepare(`SELECT ${selected.join(',')} FROM ${quote(name)}`).raw().safeIntegers(true);
    for (const row of statement.iterate()) {
        const digest = crypto.createHash('sha256');
        for (const value of row) {
            const bytes = value === null ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value
                : Buffer.from(typeof value === 'bigint' ? String(value) : typeof value === 'number' ? String(value) : value);
            const type = value === null ? 'null' : Buffer.isBuffer(value) ? 'blob' : typeof value;
            digest.update(`${type}:${bytes.length}:`); digest.update(bytes); digest.update(';');
        }
        rows.push(digest.digest('hex'));
    }
    // A multiset preserves duplicates without depending on the query planner.
    rows.sort();
    return { count: rows.length, digest: hash(rows.join('\n')) };
}

function snapshot(db, baseline) {
    return db.transaction(() => {
        const objects = db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master ORDER BY type,name').all();
        const metadata = { userVersion: db.pragma('user_version', { simple: true }), applicationId: db.pragma('application_id', { simple: true }),
            encoding: db.pragma('encoding', { simple: true }) };
        const tableList = db.prepare('PRAGMA table_list').all().filter(row => row.schema === 'main');
        const virtual = objects.filter(object => object.type === 'table' && /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(object.sql || ''));
        const tables = {};
        for (const object of objects.filter(object => object.type === 'table')) {
            const columns = db.prepare(`PRAGMA table_xinfo(${quote(object.name)})`).all();
            const previous = baseline?.tables[object.name];
            const selected = previous?.columns || columns;
            const table = tableList.find(row => row.name === object.name);
            // table_list's shadow label depends on whether xConnect ran on
            // this connection. Derive a stable classification from the DDL.
            const kind = virtual.some(value => value.name === object.name) ? 'virtual'
                : virtual.some(value => object.name.startsWith(value.name + '_')
                    && (/\bUSING\s+fts5\s*\(/i.test(value.sql) && /_(?:data|idx|content|docsize|config)$/.test(object.name)
                    || /\bUSING\s+vec0\s*\(/i.test(value.sql) && /_(?:info|chunks|rowids|vector_chunks\d+|auxiliary|metadatachunks\d+|metadatatext\d+)$/.test(object.name))) ? 'shadow' : 'table';
            // Virtual tables expose their identity columns. Shadow tables must
            // also be hashed directly: the logical view cannot prove vector BLOBs.
            const withRowid = previous ? previous.withRowid : !table?.wr
                && !columns.some(column => column.name.toLowerCase() === '_rowid_')
                && !(kind === 'virtual' && columns.some(column => column.name.toLowerCase() === 'rowid'));
            tables[object.name] = { columns, withRowid, kind,
                ...digestRows(db, object.name, selected, withRowid) };
        }
        return { objects, tables, metadata };
    })();
}

// Tokenize SQL without changing string literals. ALTER TABLE appends column
// definitions; removing only the permitted definitions must recover old SQL.
function tokens(sql) {
    return String(sql).match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:[^\]])*\]|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z_0-9$]*|\d+(?:\.\d+)?|[^\s]/g) || [];
}
function stripAddedColumns(sql, added) {
    const all = tokens(sql);
    const open = all.indexOf('(');
    requireGate(open >= 0, 'MIGRATION_SCHEMA_CHANGED');
    let depth = 1, start = open + 1, close = -1;
    const definitions = [];
    for (let index = start; index < all.length; index++) {
        if (all[index] === '(') depth++;
        if (all[index] === ')') depth--;
        if (depth === 0 || (depth === 1 && all[index] === ',')) {
            definitions.push(all.slice(start, index)); start = index + 1;
            if (depth === 0) { close = index; break; }
        }
    }
    requireGate(close >= 0, 'MIGRATION_SCHEMA_CHANGED');
    const kept = definitions.filter(definition => {
        const name = (definition[0] || '').replace(/^(?:"|`|\[)|(?:"|`|\])$/g, '');
        return !added.has(name);
    });
    return [...all.slice(0, open + 1), ...kept.flatMap((definition, index) => index ? [',', ...definition] : definition), ...all.slice(close)];
}

function validateColumns(db) {
    const columns = db.prepare('PRAGMA table_xinfo(instances)').all();
    for (const name of NEW_COLUMNS) {
        const column = columns.find(column => column.name === name);
        requireGate(column && column.type.toUpperCase() === 'TEXT' && !column.pk && !column.hidden && !column.notnull,
            'MIGRATION_VOICE_COLUMNS_INVALID');
        if (name === 'voiceSettings') requireGate(column.dflt_value === "'{}'", 'MIGRATION_VOICE_COLUMNS_INVALID');
    }
}

function compare(before, after, mode) {
    requireGate(JSON.stringify(before.metadata) === JSON.stringify(after.metadata), 'MIGRATION_SCHEMA_CHANGED', 'METADATA');
    requireGate(before.objects.length === after.objects.length, 'MIGRATION_SCHEMA_CHANGED', 'OBJECT_COUNT');
    const oldColumns = before.tables.instances?.columns;
    requireGate(oldColumns, 'MIGRATION_INSTANCES_MISSING');
    const added = new Set(after.tables.instances.columns.filter(column => !oldColumns.some(old => old.name === column.name)).map(column => column.name));
    requireGate([...added].every(name => mode === 'migrate' && NEW_COLUMNS.has(name)), 'MIGRATION_SCHEMA_CHANGED', 'ADDED_COLUMNS');
    for (let index = 0; index < before.objects.length; index++) {
        const old = before.objects[index], next = after.objects[index];
        requireGate(old.name === next.name && old.type === next.type && old.tbl_name === next.tbl_name && old.rootpage === next.rootpage,
            'MIGRATION_SCHEMA_CHANGED', 'OBJECT_IDENTITY');
        if (old.type === 'table' && old.name === 'instances' && added.size) {
            requireGate(JSON.stringify(tokens(old.sql)) === JSON.stringify(stripAddedColumns(next.sql, added)), 'MIGRATION_SCHEMA_CHANGED', 'TABLE_SQL');
        } else requireGate(old.sql === next.sql, 'MIGRATION_SCHEMA_CHANGED', 'OBJECT_SQL');
    }
    const derivedFts = new Set(before.objects.filter(object => object.type === 'table' && /\bUSING\s+fts5\s*\(/i.test(object.sql || ''))
        .flatMap(object => [object.name + '_data', object.name + '_idx']));
    let derivedFtsIndexesRebuilt = 0;
    for (const [name, old] of Object.entries(before.tables)) {
        const next = after.tables[name];
        requireGate(next && old.kind === next.kind, 'MIGRATION_SCHEMA_CHANGED', 'TABLE_KIND');
        requireGate(JSON.stringify(old.columns) === JSON.stringify(next.columns.filter(column => !(name === 'instances' && added.has(column.name)))),
            'MIGRATION_SCHEMA_CHANGED', 'COLUMN_METADATA');
        if (old.count !== next.count || old.digest !== next.digest) {
            // Actual DB.init rebuilds FTS5 segments on every start. Only these
            // derived index bytes may differ; logical FTS rowids/text, content,
            // docsize/config, every business table and ALL vec0 shadows remain
            // exact. Both old and new derived bytes were still snapshotted.
            if (!derivedFts.has(name)) {
                // Names/counts diagnose an unexpected side effect without
                // releasing row values, SQL, credentials or exception text.
                throw Object.assign(new Error('MIGRATION_EXISTING_DATA_CHANGED'), {
                    gateCode: 'MIGRATION_EXISTING_DATA_CHANGED', gateStage: 'ROW_DIGEST',
                    gateTable: name, gateBeforeCount: old.count, gateAfterCount: next.count,
                });
            }
            derivedFtsIndexesRebuilt++;
        }
    }
    return { addedColumns: [...added].sort(), derivedFtsIndexesRebuilt };
}

function vectorProof(snapshotValue) {
    const virtual = snapshotValue.objects.filter(object => object.type === 'table' && /\bUSING\s+vec0\s*\(/i.test(object.sql || ''));
    const physical = Object.entries(snapshotValue.tables).filter(([name, table]) => table.kind === 'shadow'
        && virtual.some(object => name.startsWith(object.name + '_')));
    // Older SQLite versions may not label vec0 shadows. Known physical tables
    // are still included and hashed by the exhaustive sqlite_master inventory.
    const shadows = physical.length ? physical : Object.entries(snapshotValue.tables).filter(([name]) => virtual.some(object =>
        name.startsWith(object.name + '_') && /_(?:info|chunks|rowids|vector_chunks\d+|auxiliary|metadatachunks\d+|metadatatext\d+)$/.test(name)));
    return { virtualTables: virtual.length, logicalRows: virtual.reduce((sum, object) => sum + snapshotValue.tables[object.name].count, 0),
        physicalTables: shadows.length, physicalRows: shadows.reduce((sum, [, table]) => sum + table.count, 0),
        physicalDigest: hash(JSON.stringify(shadows.map(([name, table]) => [name, table.count, table.digest]))) };
}

function prohibitActivity() {
    const denied = () => fail('MIGRATION_OFFLINE_ACTIVITY_DENIED');
    globalThis.fetch = denied;
    globalThis.setInterval = denied;
    globalThis.setTimeout = denied;
    require('node:net').Socket.prototype.connect = denied;
    require('node:net').Server.prototype.listen = denied;
    require('node:tls').connect = denied;
    require('node:http').request = denied; require('node:http').get = denied;
    require('node:https').request = denied; require('node:https').get = denied;
    require('node:dgram').createSocket = denied;
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) require('node:child_process')[name] = denied;
}

function assertSourceReadable(appRoot) {
    try {
        for (const directory of [appRoot, path.join(appRoot, 'src'), path.join(appRoot, 'src/services')]) {
            requireGate(fs.statSync(directory).isDirectory(), 'MIGRATION_APP_SOURCE_MISSING', 'APP_SOURCE');
            fs.accessSync(directory, fs.constants.X_OK);
        }
        const source = path.join(appRoot, 'src/services/database.service.js');
        requireGate(fs.statSync(source).isFile(), 'MIGRATION_APP_SOURCE_MISSING', 'APP_SOURCE');
        fs.accessSync(source, fs.constants.R_OK);
    } catch (error) {
        if (error.gateCode) throw error;
        fail(error.code === 'ENOENT' || error.code === 'ENOTDIR'
            ? 'MIGRATION_APP_SOURCE_MISSING' : 'MIGRATION_APP_SOURCE_UNREADABLE', 'APP_SOURCE');
    }
}

async function runProbe(mode, env = process.env) {
    requireGate(['migrate', 'apply', 'compat'].includes(mode), 'MIGRATION_INPUT_INVALID');
    const target = env.DB_PATH, appRoot = env.AVA_APP_ROOT || '/app';
    requireGate(target && path.isAbsolute(target) && path.isAbsolute(appRoot), 'MIGRATION_INPUT_INVALID');
    try { requireGate(fs.statSync(target).isFile() && fs.realpathSync(target) === path.resolve(target), 'MIGRATION_INPUT_INVALID'); }
    catch (_) { fail('MIGRATION_INPUT_INVALID'); }
    const appRequire = createRequire(path.join(appRoot, 'package.json'));
    // Node reports an inaccessible source directory as MODULE_NOT_FOUND.
    // Reject before opening/migrating the DB; never bypass the service UID.
    assertSourceReadable(appRoot);
    const SQLite = appRequire('better-sqlite3'), vec = appRequire('sqlite-vec');
    let inspection, DB;
    try {
        inspection = new SQLite(target, { readonly: true, fileMustExist: true });
        vec.load(inspection);
        requireGate(typeof inspection.prepare('SELECT vec_version() AS version').get().version === 'string', 'MIGRATION_VECTOR_EXTENSION_REQUIRED');
        inspection.pragma('busy_timeout=10000');
        requireGate(inspection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='instances'").get(), 'MIGRATION_INSTANCES_MISSING');
        const before = mode === 'apply' ? null : snapshot(inspection);
        if (mode === 'compat') validateColumns(inspection);
        inspection.close(); inspection = null;
        // DB.init is the sole application entry point; no server, jobs or workers.
        process.env.DB_PATH = target;
        DB = appRequire('./src/services/database.service');
        await DB.init();
        requireGate(DB.db?.open, 'MIGRATION_INIT_FAILED');
        // Reloading vec0 after DB.init has opened virtual tables replaces its
        // module registration and can change SQLite's shadow classification.
        requireGate(typeof DB.db.prepare('SELECT vec_version() AS version').get().version === 'string', 'MIGRATION_VECTOR_EXTENSION_REQUIRED');
        validateColumns(DB.db);
        requireGate(DB.db.pragma('integrity_check').every(row => row.integrity_check === 'ok'), 'MIGRATION_INTEGRITY_FAILED');
        if (mode === 'apply') return { ok: true, mode, sourceReadableVerified: true, initVerified: true, voiceColumnsVerified: true, exactDataFence: false };
        const after = snapshot(DB.db, before);
        const { addedColumns, derivedFtsIndexesRebuilt } = compare(before, after, mode);
        const vectors = vectorProof(before);
        return { ok: true, mode, sourceReadableVerified: true, initVerified: true, voiceColumnsVerified: true, exactDataFence: true,
            schemaPreserved: true, existingRowsPreserved: true, addedColumns,
            derivedFtsIndexesRebuilt, allPhysicalStoragePreserved: derivedFtsIndexesRebuilt === 0,
            tablesChecked: Object.keys(before.tables).length,
            rowsChecked: Object.values(before.tables).reduce((sum, table) => sum + table.count, 0),
            existingDataDigest: hash(JSON.stringify(Object.entries(before.tables).map(([name, table]) => [name, table.count, table.digest]))),
            vectors: { ...vectors, preserved: true } };
    } finally { if (inspection?.open) inspection.close(); if (DB?.db?.open) DB.db.close(); }
}

if (require.main === module) {
    const output = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true; process.stderr.write = () => true;
    for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = () => {};
    prohibitActivity();
    const finish = (result, status) => output(JSON.stringify(result) + '\n', () => process.exit(status));
    runProbe(process.argv[2]).then(result => finish(result, 0), error => finish({ ok: false,
        mode: ['migrate', 'apply', 'compat'].includes(process.argv[2]) ? process.argv[2] : null,
        code: /^MIGRATION_[A-Z_]+$/.test(error.gateCode || '') ? error.gateCode : 'MIGRATION_FAILED',
        ...(/^[A-Z_]+$/.test(error.gateStage || '') ? { stage: error.gateStage } : {}),
        ...(/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(error.gateTable || '')
            && Number.isSafeInteger(error.gateBeforeCount) && error.gateBeforeCount >= 0
            && Number.isSafeInteger(error.gateAfterCount) && error.gateAfterCount >= 0
            ? { table: error.gateTable, beforeCount: error.gateBeforeCount, afterCount: error.gateAfterCount } : {}) }, 1));
}

module.exports = { runProbe, snapshot, compare, vectorProof };
