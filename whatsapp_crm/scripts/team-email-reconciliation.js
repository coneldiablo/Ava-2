#!/usr/bin/env node
'use strict';
// Imported services may initialize dotenv. Operator stdout is a redacted JSON
// receipt, so suppress dotenv's non-JSON startup diagnostics before imports.
process.env.DOTENV_CONFIG_QUIET = 'true';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const DB = require('../src/services/database.service');
const { reconcile, scopeDigest } = require('../src/services/identity/team-email-reconciliation');

async function main(args = process.argv.slice(2)) {
    const options = {};
    for (let n = 0; n < args.length; n++) {
        const argument = args[n];
        if (argument === '--apply' && !options.apply) options.apply = true;
        else if (['--invitation-id', '--verification-id', '--receipt'].includes(argument)
            && !options[argument] && args[n + 1] && !args[n + 1].startsWith('--')) options[argument] = args[++n];
        else throw new Error('TEAM_EMAIL_RECONCILIATION_ARGUMENT_INVALID');
    }
    if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') throw new Error('IDENTITY_WORKER_REQUIRED');
    if (!process.env.DB_PATH || !options['--receipt'] || !path.isAbsolute(options['--receipt'])
        || !/^[\w-]{1,128}$/.test(options['--invitation-id'] || '')
        || !/^[\w-]{1,128}$/.test(options['--verification-id'] || '')) throw new Error('TEAM_EMAIL_RECONCILIATION_SCOPE_REQUIRED');
    const receipt = { version: 1, receiptId: crypto.randomUUID(), startedAt: new Date().toISOString(),
        mode: options.apply ? 'apply' : 'dry_run', scopeDigest: scopeDigest(options['--invitation-id'], options['--verification-id']), status: 'started' };
    // Exclusive private file, created before any provider mutation. Never
    // include source IDs, native IDs, emails, provider errors, tokens or letters.
    const fd = fs.openSync(options['--receipt'], 'wx', 0o600);
    fs.fchmodSync(fd, 0o600);
    const save = () => { fs.ftruncateSync(fd); fs.writeSync(fd, JSON.stringify(receipt, null, 2), 0, 'utf8'); fs.fsyncSync(fd); };
    try {
        save();
        DB.db = new Database(process.env.DB_PATH, { readonly: true, fileMustExist: true });
        DB.db.pragma('query_only = ON');
        Object.assign(receipt, await reconcile({ invitationId: options['--invitation-id'], verificationId: options['--verification-id'], apply: !!options.apply }));
    } catch (error) {
        receipt.status = 'failed';
        const safeCodes = new Set(['TEAM_EMAIL_RECONCILIATION_PROOF_INVALID', 'TEAM_EMAIL_RECONCILIATION_PROOF_CHANGED',
            'TEAM_EMAIL_RECONCILIATION_NATIVE_CONFLICT', 'TEAM_EMAIL_RECONCILIATION_READBACK_FAILED',
            'IDENTITY_WORKER_REQUIRED', 'IDENTITY_PROVIDER_UNAVAILABLE', 'IDENTITY_CONFIGURATION_INVALID']);
        receipt.errorCode = safeCodes.has(error.code) ? error.code : 'TEAM_EMAIL_RECONCILIATION_FAILED';
        receipt.nativeMutationAmbiguous = error.nativeMutationAmbiguous === true;
        process.exitCode = 1;
    } finally {
        receipt.finishedAt = new Date().toISOString(); save(); fs.closeSync(fd); DB.db?.close(); DB.db = null;
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return receipt;
}
if (require.main === module) main().catch(() => { process.stderr.write('TEAM_EMAIL_RECONCILIATION_ARGUMENT_OR_RECEIPT_FAILED\n'); process.exitCode = 1; });
module.exports = { main };
