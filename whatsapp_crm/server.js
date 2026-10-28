// server.js - Entry Point
// MUST be first import: patches sharp module for environments where native binary is unavailable
require('./src/utils/sharp-mock');
const app = require('./src/app');
const Logger = require('./src/utils/logger');

const config = require('./src/config');

(async () => {
  try {
    const port = config.port || 3000;
    await app.start(port);

    try {
      require('./src/queues/workers/document-worker');
      Logger.success('Document processing worker started');
    } catch (e) {
      Logger.warn('Document worker not started (BullMQ/Redis may not be available)');
    }

    // Module provisioning runs in the dedicated, non-public worker process.
  } catch (err) {
    Logger.error('Failed to start application', err);
    process.exit(1);
  }
})();
