'use strict';
// Executes the operator's exact gate against synthetic SQLite files only.
// AVA_RELEASE_APP_ROOT supplies the reviewed runtime's SQLite dependency;
// no application modules, containers, network clients, or production DB are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

try {
    const app = process.env.AVA_RELEASE_APP_ROOT;
    assert.ok(app && path.isAbsolute(app), 'ABSOLUTE_CANDIDATE_RUNTIME_REQUIRED');
    const SQLite = createRequire(path.join(app, 'package.json'))('better-sqlite3');
    const source = fs.readFileSync(path.join(__dirname, 'release_operator.py'), 'utf8');
    const match = source.match(/^ROLLBACK_ELIGIBILITY_JS = r'''([\s\S]*?)'''/m);
    assert.ok(match, 'OPERATOR_GATE_CONSTANT_REQUIRED');
    const gate = match[1];
    const gateSha256 = crypto.createHash('sha256').update(gate).digest('hex');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-rollback-gate-'));
    const baseline = `
        CREATE TABLE ava_invitations(id INTEGER PRIMARY KEY, createdBy TEXT, userId INTEGER, leaseToken TEXT);
        CREATE TABLE ava_identity_outbox(id INTEGER PRIMARY KEY, userId INTEGER, state TEXT);
        CREATE TABLE ava_self_registrations(id INTEGER PRIMARY KEY, state TEXT);
        CREATE TABLE production_only(id INTEGER PRIMARY KEY, retained TEXT);
        INSERT INTO production_only VALUES(1, 'must remain unchanged');
    `;
    let count = 0;
    const noBarriers = { invitationLease: false, pendingRevocation: false, enrollingRegistration: false };
    const cases = [
        ['empty migrated database', '', true, true, noBarriers],
        ['invitation lease', "INSERT INTO ava_invitations VALUES(1,'self-registration:private-fixture',10,'private-lease-secret')", true, false, { ...noBarriers, invitationLease: true }],
        ['empty nonnull invitation lease', "INSERT INTO ava_invitations VALUES(1,'self-registration:fixture',10,'')", true, false, { ...noBarriers, invitationLease: true }],
        ['pending revocation', "INSERT INTO ava_invitations VALUES(1,'self-registration:fixture',10,NULL); INSERT INTO ava_identity_outbox VALUES(1,10,'pending')", true, false, { ...noBarriers, pendingRevocation: true }],
        ['null revocation state', "INSERT INTO ava_invitations VALUES(1,'self-registration:fixture',10,NULL); INSERT INTO ava_identity_outbox VALUES(1,10,NULL)", true, false, { ...noBarriers, pendingRevocation: true }],
        ['completed registration with retry revocation', "INSERT INTO ava_self_registrations VALUES(1,'completed'); INSERT INTO ava_invitations VALUES(1,'self-registration:fixture',10,NULL); INSERT INTO ava_identity_outbox VALUES(1,10,'retry')", true, false, { ...noBarriers, pendingRevocation: true }],
        ['enrolling registration', "INSERT INTO ava_self_registrations VALUES(1,'enrolling')", true, false, { ...noBarriers, enrollingRegistration: true }],
        ['all three barriers', "INSERT INTO ava_self_registrations VALUES(1,'enrolling'); INSERT INTO ava_invitations VALUES(1,'self-registration:fixture',10,'lease'); INSERT INTO ava_identity_outbox VALUES(1,10,'processing')", true, false, { invitationLease: true, pendingRevocation: true, enrollingRegistration: true }],
        ['terminal registration and done revocation', "INSERT INTO ava_self_registrations VALUES(1,'completed'),(2,'failed'),(3,'expired'),(4,'cancelled'); INSERT INTO ava_invitations VALUES(1,'self-registration:fixture',10,NULL); INSERT INTO ava_identity_outbox VALUES(1,10,'done')", true, true, noBarriers],
        ['non signup identity work excluded', "INSERT INTO ava_invitations VALUES(1,'admin',10,'unrelated-lease'); INSERT INTO ava_identity_outbox VALUES(1,10,'pending')", true, true, noBarriers],
        ['unrelated user revocation excluded', "INSERT INTO ava_invitations VALUES(1,'self-registration:fixture',10,NULL); INSERT INTO ava_identity_outbox VALUES(1,11,'pending')", true, true, noBarriers],
        ['pre migration no signups', 'DROP TABLE ava_self_registrations', true, true, noBarriers],
        ['missing registrations with existing signup', "DROP TABLE ava_self_registrations; INSERT INTO ava_invitations VALUES(1,'self-registration:fixture',10,NULL)", false, false],
        ['missing invitations', 'DROP TABLE ava_invitations', false, false],
        ['missing outbox', 'DROP TABLE ava_identity_outbox', false, false],
        ['missing invitation column', 'ALTER TABLE ava_invitations RENAME COLUMN leaseToken TO wrongColumn', false, false],
        ['missing outbox column', 'ALTER TABLE ava_identity_outbox RENAME COLUMN state TO wrongColumn', false, false],
        ['malformed registrations table', 'ALTER TABLE ava_self_registrations RENAME COLUMN state TO wrongColumn', false, false],
        ['registrations view rejected', 'DROP TABLE ava_self_registrations; CREATE VIEW ava_self_registrations AS SELECT 1 AS state', false, false],
        ['invitations view rejected', 'DROP TABLE ava_invitations; CREATE VIEW ava_invitations AS SELECT 1 AS createdBy,2 AS userId,3 AS leaseToken', false, false],
    ];
    try {
        for (const [label, sql, schemaValid, eligible, barriers] of cases) {
            const target = path.join(directory, 'fixture-' + count + '.db');
            const writer = new SQLite(target);
            writer.exec(baseline + sql);
            writer.close();
            const before = fs.readFileSync(target);
            const output = [];
            let opens = 0;
            const sandbox = {
                require(name) {
                    assert.equal(name, '/app/node_modules/better-sqlite3', 'GATE_UNEXPECTED_DEPENDENCY');
                    return function ReadOnlySQLite(filename, options) {
                        assert.equal(filename, target, 'GATE_TARGET_CHANGED');
                        assert.deepEqual(JSON.parse(JSON.stringify(options)), { readonly: true, fileMustExist: true });
                        opens += 1;
                        return new SQLite(filename, options);
                    };
                },
                process: { env: { DB_PATH: target } },
                console: { log: value => output.push(String(value)) },
            };
            vm.runInNewContext(gate, sandbox, { timeout: 5000 });
            assert.equal(opens, 1, label + ': exactly one read-only DB');
            assert.equal(output.length, 1, label + ': one sanitized receipt');
            const result = JSON.parse(output[0]);
            assert.equal(result.schemaValid, schemaValid, label);
            assert.equal(result.rollbackEligible, eligible, label);
            if (schemaValid) assert.deepEqual(result.barriers, barriers, label);
            else assert.deepEqual(result, { schemaValid: false, rollbackEligible: false }, label);
            assert.deepEqual(fs.readFileSync(target), before, label + ': DB bytes unchanged');
            assert.ok(!fs.existsSync(target + '-wal'), label + ': no WAL writes');
            assert.ok(!output[0].includes('private-lease-secret'), label + ': no DB row secrets');
            count += 1;
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    process.stdout.write(JSON.stringify({ rollbackGateVerified: true, caseCount: count,
        exactOperatorConstant: true, databaseReadOnly: true, productionDatabaseUsed: false, gateSha256 }) + '\n');
} catch (_) {
    process.stderr.write('SYNTHETIC_ROLLBACK_GATE_FAILED\n');
    process.exitCode = 1;
}
