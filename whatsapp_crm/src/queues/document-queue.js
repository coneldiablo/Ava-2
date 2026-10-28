const Logger = require('../utils/logger');
const config = require('../config');

let documentQueue = null;
let queueAvailable = false;

try {
    const { Queue } = require('bullmq');

    documentQueue = new Queue('document-processing', {
        connection: {
            host: config.redis.host,
            port: config.redis.port,
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: null,
            retryStrategy: () => null
        },
        defaultJobOptions: {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 5000
            },
            removeOnComplete: {
                age: 3600,
                count: 1000
            },
            removeOnFail: {
                age: 86400,
                count: 1000
            }
        }
    });

    documentQueue.on('error', (err) => {
        if (queueAvailable) {
            Logger.warn(`BullMQ queue error: ${err.message}`);
        }
        queueAvailable = false;
    });

    documentQueue.on('ready', () => {
        queueAvailable = true;
        Logger.success('BullMQ document queue ready (Redis connected)');
    });

    documentQueue.waitUntilReady().then(() => {
        queueAvailable = true;
        Logger.success('BullMQ document queue initialized');
    }).catch(() => {
        Logger.warn('BullMQ not ready, document processing will be synchronous');
        queueAvailable = false;
    });
} catch (e) {
    Logger.warn(`BullMQ not available, document processing will be synchronous: ${e.message}`);
    queueAvailable = false;
}

async function addDocumentJob(instanceId, buffer, originalName, mimeType) {
    if (!queueAvailable || !documentQueue) {
        return null;
    }

    try {
        const job = await documentQueue.add('process', {
            instanceId,
            buffer: buffer.toString('base64'),
            originalName,
            mimeType
        });

        Logger.info(`Document job ${job.id} queued for ${originalName}`);
        return job.id;
    } catch (e) {
        Logger.warn(`Failed to queue document job: ${e.message}`);
        return null;
    }
}

async function getJobStatus(instanceId, jobId) {
    if (!queueAvailable || !documentQueue) {
        return null;
    }

    try {
        const job = await documentQueue.getJob(jobId);
        if (!job) return null;
        if (Number(job.data?.instanceId) !== Number(instanceId)) {
            return null;
        }

        const state = await job.getState();
        const progress = typeof job.progress === 'object' && job.progress !== null
            ? job.progress
            : { percent: Number(job.progress) || 0, stage: 'queued' };

        return {
            id: job.id,
            state,
            percent: Number(progress.percent) || 0,
            stage: progress.stage || (state === 'completed' ? 'finish' : 'queued'),
            progress,
            result: job.returnvalue || null,
            failedReason: job.failedReason || null
        };
    } catch (e) {
        return null;
    }
}

function getQueue() {
    return documentQueue;
}

function isAvailable() {
    return queueAvailable;
}

module.exports = {
    addDocumentJob,
    getJobStatus,
    getQueue,
    isAvailable
};
