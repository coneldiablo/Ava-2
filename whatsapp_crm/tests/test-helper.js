const assert = require('assert');
const DB = require('../src/services/database.service');
const Database = require('better-sqlite3');

const testsQueue = [];

function describe(name, fn) {
    testsQueue.push({ type: 'describe', name });
    fn();
}

function it(name, fn) {
    testsQueue.push({ type: 'it', name, fn });
}

async function runAll() {
    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;
    const failures = [];

    for (const item of testsQueue) {
        if (item.type === 'describe') {
            console.log(`\n\x1b[1m📦 ${item.name}\x1b[0m`);
        } else if (item.type === 'it') {
            totalTests++;
            try {
                await item.fn();
                passedTests++;
                console.log(`  \x1b[32m✓\x1b[0m ${item.name}`);
            } catch (e) {
                failedTests++;
                failures.push({ suite: item.name, error: e.stack || e.message });
                console.log(`  \x1b[31m✗ ${item.name}\x1b[0m`);
                console.log(`    \x1b[31m${e.message}\x1b[0m`);
            }
        }
    }

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Total: ${totalTests} | \x1b[32mPassed: ${passedTests}\x1b[0m | \x1b[31mFailed: ${failedTests}\x1b[0m`);
    if (failures.length > 0) {
        console.log(`\n\x1b[31mFailures:\x1b[0m`);
        failures.forEach(f => {
            console.log(`  - ${f.suite}`);
            console.log(`    \x1b[31m${f.error}\x1b[0m`);
        });
    }
    console.log();
    return failedTests === 0;
}

function createTestDB() {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    
    // Point the database service to the in-memory database
    DB.db = db;
    
    // Run real tables and columns initialization
    DB.createTables();
    DB.ensureColumns();
    DB.migrateRagSchema();
    DB.createSalesBrainTables();
    DB.createPmsTables();
    DB.createTwentyTables();
    DB.createOnyxTables();
    DB.createProvisioningTables();
    
    return db;
}

module.exports = { describe, it, assert, runAll, createTestDB };
