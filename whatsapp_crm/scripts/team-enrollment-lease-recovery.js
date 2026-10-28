#!/usr/bin/env node
'use strict';
process.env.DOTENV_CONFIG_QUIET = 'true';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const DB = require('../src/services/database.service');
const { recover, scopeDigest } = require('../src/services/identity/team-enrollment-lease-recovery');

async function main(args = process.argv.slice(2)) {
    const options = {};
    for (let n = 0; n < args.length; n++) {
        const arg = args[n];
        if (['--apply', '--provider-quiescent'].includes(arg) && !options[arg]) options[arg] = true;
        else if (['--invitation-id', '--lease-digest', '--worker-container-id', '--receipt'].includes(arg)
            && !options[arg] && args[n + 1] && !args[n + 1].startsWith('--')) options[arg] = args[++n];
        else throw new Error('TEAM_LEASE_ARGUMENT_INVALID');
    }
    if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') throw new Error('IDENTITY_WORKER_REQUIRED');
    if (!process.env.DB_PATH || !options['--provider-quiescent'] || !path.isAbsolute(options['--receipt'] || '')
        || !/^[\w-]{1,128}$/.test(options['--invitation-id'] || '')
        || !/^[a-f0-9]{64}$/.test(options['--lease-digest'] || '')
        || !/^[a-f0-9]{64}$/.test(options['--worker-container-id'] || '')) throw new Error('TEAM_LEASE_SCOPE_REQUIRED');
    const receipt = { version: 1, receiptId: crypto.randomUUID(), startedAt: new Date().toISOString(),
        mode: options['--apply'] ? 'apply' : 'dry_run', providerQuiescenceAcknowledged: true,
        scopeDigest: scopeDigest(options['--invitation-id'], options['--lease-digest'], options['--worker-container-id']), status: 'started' };
    const fd = fs.openSync(options['--receipt'], 'wx', 0o600); fs.fchmodSync(fd, 0o600);
    const save = () => { fs.ftruncateSync(fd); fs.writeSync(fd, JSON.stringify(receipt, null, 2), 0, 'utf8'); fs.fsyncSync(fd); };
    try {
        save();
        DB.db = new Database(process.env.DB_PATH, { readonly: !options['--apply'], fileMustExist: true });
        if (!options['--apply']) DB.db.pragma('query_only = ON');
        DB.db.pragma('busy_timeout = 5000');
        Object.assign(receipt, await recover({ invitationId: options['--invitation-id'], leaseDigest: options['--lease-digest'],
            workerContainerId: options['--worker-container-id'], providerQuiescent: true, apply: !!options['--apply'] }));
    } catch (error) {
        receipt.status = 'failed';
        const safeCodes = new Set(['TEAM_LEASE_DOCKER_UNAVAILABLE', 'TEAM_LEASE_WORKER_NOT_STOPPED',
            'TEAM_LEASE_WORKER_SET_CONFLICT', 'TEAM_LEASE_WORKER_CHANGED', 'TEAM_LEASE_SCOPE_REQUIRED',
            'TEAM_LEASE_LOCAL_CONFLICT', 'TEAM_LEASE_LOCAL_CHANGED', 'TEAM_LEASE_NATIVE_CONFLICT', 'TEAM_LEASE_READBACK_FAILED',
            'IDENTITY_WORKER_REQUIRED', 'IDENTITY_PROVIDER_UNAVAILABLE', 'IDENTITY_CONFIGURATION_INVALID']);
        receipt.errorCode = safeCodes.has(error.code) ? error.code : 'TEAM_LEASE_RECOVERY_FAILED';
        process.exitCode = 1;
    } finally {
        receipt.finishedAt = new Date().toISOString(); save(); fs.closeSync(fd); DB.db?.close(); DB.db = null;
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return receipt;
}
if (require.main === module) main().catch(() => { process.stderr.write('TEAM_LEASE_ARGUMENT_OR_RECEIPT_FAILED\n'); process.exitCode = 1; });
module.exports = { main };
