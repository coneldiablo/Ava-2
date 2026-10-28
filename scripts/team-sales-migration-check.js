'use strict';

// Read-only schema/lease receipt. Never emits identities, tokens or customer data.
const Database = require('better-sqlite3');
const path = require('path');
const mode = process.argv[2] || 'schema';
const file = process.env.DB_PATH || path.join('/app/src/services', '../../crm_v2.db');
let db;
const fail = code => { throw new Error(code); };
try {
  db = new Database(file, { readonly: true, fileMustExist: true, timeout: 8000 });
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const count = (table, where, args = []) => names.has(table)
    ? db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n : 0;
  const counts = {};
  for (const table of ['ava_users', 'ava_business_memberships', 'ava_invitations', 'clients', 'manager_tasks', 'followup_drafts']) {
    if (names.has(table)) counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  }
  if (mode === 'idle') {
    const activeEnrollments = count('ava_invitations', "state='redeeming' AND leasedUntil>?", [Date.now()]);
    const activeIdentityJobs = count('ava_identity_outbox', "state='leased' AND leasedUntil>?", [Date.now()]);
    const activeProvisioningJobs = count('business_provisioning_jobs', "status='LEASED' AND datetime(leasedUntil)>datetime('now')");
    if (activeEnrollments) fail('ACTIVE_ENROLLMENT_LEASE');
    if (activeIdentityJobs) fail('ACTIVE_IDENTITY_LEASE');
    if (activeProvisioningJobs) fail('ACTIVE_PROVISIONING_LEASE');
    console.log(JSON.stringify({ phase: 'database_idle', activeEnrollments, activeIdentityJobs, activeProvisioningJobs, counts }));
  } else if (mode === 'schema') {
    for (const table of ['ava_business_memberships', 'ava_invitations']) {
      const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql || '';
      if (!['hotel_owner', 'sales_lead', 'manager', 'observer'].every(role => sql.includes(`'${role}'`))) fail('ROLE_CHECK_NOT_EXPANDED');
      if (count(table, "role NOT IN ('hotel_owner','sales_lead','manager','observer')")) fail('UNSUPPORTED_PERSISTED_ROLE');
    }
    for (const [table, required] of [
      ['clients', ['assigneeUserId']],
      ['manager_tasks', ['assigneeUserId', 'dueAt', 'createdByUserId']],
      ['ava_invitations', ['acceptanceMode']],
    ]) {
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      if (required.some(column => !columns.has(column))) fail('ASSIGNMENT_OR_INVITATION_SCHEMA_MISSING');
    }
    if (!names.has('ava_team_audit') || !names.has('sales_workspace_schema_migrations')) fail('TEAM_SCHEMA_MISSING');
    if (!db.prepare("SELECT 1 FROM sales_workspace_schema_migrations WHERE version='legacy_manager_task_assignment_v1'").get()) fail('ASSIGNMENT_MIGRATION_DEFERRED');
    if (db.pragma('foreign_key_check').length) fail('DATABASE_FOREIGN_KEY_CHECK_FAILED');
    if (db.pragma('quick_check', { simple: true }) !== 'ok') fail('DATABASE_QUICK_CHECK_FAILED');
    for (const table of ['ava_users', 'ava_business_memberships', 'ava_invitations', 'clients', 'manager_tasks', 'followup_drafts']) {
      if (!names.has(table)) fail('EXPECTED_TABLE_MISSING');
    }
    console.log(JSON.stringify({ phase: 'schema_verified', roleChecksExpanded: true, assignmentsMigrated: true, foreignKeyCheck: true, quickCheck: true, counts }));
  } else fail('INVALID_VALIDATION_MODE');
} catch (error) {
  const code = /^[A-Z_]+$/.test(error.message || '') ? error.message : 'DATABASE_VALIDATION_FAILED';
  console.log(JSON.stringify({ phase: 'database_validation_failed', reason: code }));
  process.exitCode = 1;
} finally {
  db?.close();
}
