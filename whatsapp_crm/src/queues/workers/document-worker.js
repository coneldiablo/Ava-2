const Logger = require('../../utils/logger');
const config = require('../../config');

let worker = null;
let workerAvailable = false;

try {
    const { Worker } = require('bullmq');
    const RAGService = require('../../services/rag.service');

    worker = new Worker('document-processing', async (job) => {
        const { instanceId, buffer, originalName, mimeType } = job.data;
        const bufferData = Buffer.from(buffer, 'base64');

        Logger.info(`Processing queued document: ${originalName} (job ${job.id})`);

        await job.updateProgress({ percent: 5, stage: 'queued' });

        const result = await RAGService.processDocument(
            instanceId,
            bufferData,
            originalName,
            mimeType,
            {
                onProgress: async (payload) => {
                    await job.updateProgress({
                        percent: payload.percent,
                        stage: payload.stage,
                        ...payload
                    });
                }
            }
        );

        await job.updateProgress({
            percent: 100,
            stage: result.success ? 'finish' : 'error',
            result
        });
        return result;
    }, {
        connection: {
            host: config.redis.host,
            port: config.redis.port,
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: null,
            retryStrategy: () => null
        },
        concurrency: 1
    });

    worker.on('completed', (job) => {
        Logger.success(`Document job ${job.id} completed`);
    });

    worker.on('failed', (job, err) => {
        Logger.error(`Document job ${job?.id} failed: ${err.message}`);
    });

    worker.on('progress', (job, progress) => {
        Logger.info(`Document job ${job.id} progress: ${progress}%`);
    });

    workerAvailable = true;
    Logger.success('BullMQ document worker initialized');
} catch (e) {
    Logger.warn(`BullMQ worker not available: ${e.message}`);
    workerAvailable = false;
}

module.exports = {
    isAvailable: () => workerAvailable,
    getWorker: () => worker
};
