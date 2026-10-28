'use strict';
// Explicit env-only entrypoint: do not load a shared .env with bootstrap secrets.
process.env.AVA_PROCESS_ROLE = 'module-access-broker';
const DB = require('./src/services/database.service');
async function main() {
    await DB.init();
    const server = require('./src/services/identity/module-access-broker').createServer();
    const collector = setInterval(() => {
        try { require('./src/services/identity/module-access-store').collectRevocations(); }
        catch (_) { process.stderr.write('MODULE_REVOCATION_COLLECTION_FAILED\n'); }
    }, 3000);
    server.listen(3901, '0.0.0.0');
    let stopping = false;
    const stop = () => {
        if (stopping) return;
        stopping = true;
        clearInterval(collector);
        server.close(() => { DB.db.close(); process.exit(0); });
        setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}
if (require.main === module) main().catch(() => {
    process.stderr.write('MODULE_BROKER_START_FAILED\n');
    process.exitCode = 1;
});
module.exports = { main };
