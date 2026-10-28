const fs = require('fs');
const path = require('path');
const { runAll } = require('./test-helper');

async function main() {
    console.log('🔍 Поиск и запуск тестов...');
    const testsDir = __dirname;
    const files = fs.readdirSync(testsDir);
    
    // Find all test files, optionally filtered by CLI arguments
    const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
    const testFiles = files.filter(f => f.endsWith('.test.js') && (args.length === 0 || args.some(a => f.includes(a))));
    console.log(`Found ${testFiles.length} test files: ${testFiles.join(', ')}`);
    
    // Require each test file to register its tests in the helper queue
    for (const file of testFiles) {
        require(path.join(testsDir, file));
    }
    
    // Run all tests sequentially
    // A pending promise alone does not keep Node alive. Keep the suite bounded
    // and fail instead of reporting exit 0 before its final receipt is printed.
    const deadline = setTimeout(() => { console.error('TEST_SUITE_TIMEOUT: no completed receipt'); process.exit(1); }, 120000);
    let success;
    try { success = await runAll(); } finally { clearTimeout(deadline); }
    
    // Exit process with correct status code
    process.exit(success ? 0 : 1);
}

main().catch(err => {
    console.error('❌ Критическая ошибка при запуске тестов:', err);
    process.exit(1);
});
