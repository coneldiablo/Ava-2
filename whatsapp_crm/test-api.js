const assert = require('assert');
const { spawn } = require('child_process');

const PORT = Number(process.env.TEST_PORT || 3107);
const BASE_URL = `http://127.0.0.1:${PORT}/api`;
const TEST_RUN_ID = Date.now();
const INSTANCE_NAME = `RAG Smoke ${TEST_RUN_ID}`;

let serverProcess = null;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
    const response = await fetch(`${BASE_URL}${path}`, options);
    const text = await response.text();
    let data = {};

    try {
        data = text ? JSON.parse(text) : {};
    } catch (error) {
        throw new Error(`Invalid JSON from ${path}: ${text.slice(0, 400)}`);
    }

    if (!response.ok) {
        const message = data.error || data.message || `${response.status} ${response.statusText}`;
        const failure = new Error(`${path} failed: ${message}`);
        failure.status = response.status;
        failure.payload = data;
        throw failure;
    }

    return data;
}

async function waitForHealth() {
    const startedAt = Date.now();
    let lastError = null;

    while (Date.now() - startedAt < 30000) {
        try {
            const health = await request('/health');
            if (health.status === 'ok') {
                return;
            }
        } catch (error) {
            lastError = error;
        }

        await sleep(500);
    }

    throw lastError || new Error('Server did not become healthy in time');
}

function startServer() {
    serverProcess = spawn('node', ['server.js'], {
        cwd: __dirname,
        env: {
            ...process.env,
            PORT: String(PORT),
            NODE_ENV: 'test',
            HYDE_ENABLED: 'false',
            RERANKING_ENABLED: 'false',
            OCR_ENABLED: 'false',
            EMBEDDINGS_API_URL: 'http://127.0.0.1:9',
            EMBEDDINGS_API_KEY: 'test-disabled',
            COHERE_API_KEY: '',
            REDIS_HOST: '127.0.0.1',
            REDIS_PORT: '6399'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProcess.stdout.on('data', (chunk) => {
        process.stdout.write(`[server] ${chunk}`);
    });

    serverProcess.stderr.on('data', (chunk) => {
        process.stderr.write(`[server] ${chunk}`);
    });
}

async function stopServer() {
    if (!serverProcess || serverProcess.killed) return;

    serverProcess.kill('SIGTERM');
    await Promise.race([
        new Promise((resolve) => serverProcess.once('exit', resolve)),
        sleep(5000)
    ]);

    if (!serverProcess.killed) {
        serverProcess.kill('SIGKILL');
    }
}

async function ensureInstance() {
    const instancesResponse = await request('/instances');
    const existing = (instancesResponse.instances || []).find((instance) => instance.name === INSTANCE_NAME);
    if (existing) return existing.id;

    const created = await request('/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: INSTANCE_NAME })
    });

    return created.instance.id;
}

async function uploadDocument(instanceId, fieldName, originalName, content) {
    const formData = new FormData();
    formData.append(fieldName, new Blob([content], { type: 'text/plain' }), originalName);

    const response = await fetch(`${BASE_URL}/knowledge-base/${instanceId}/upload`, {
        method: 'POST',
        body: formData
    });

    const payload = await response.json();
    if (!response.ok) {
        const message = payload.error || payload.results?.[0]?.error || response.statusText;
        throw new Error(`Upload failed for ${originalName}: ${message}`);
    }

    const results = payload.results || [payload];
    const first = results[0];
    assert(first, `Upload did not return a result for ${originalName}`);

    if (first.queued && first.jobId) {
        for (let attempt = 0; attempt < 30; attempt++) {
            const status = await request(`/knowledge-base/${instanceId}/upload-status/${first.jobId}`);
            if (status.state === 'completed') {
                assert(status.result?.success, `Queued upload completed without success for ${originalName}`);
                return status.result;
            }
            if (status.state === 'failed') {
                throw new Error(`Queued upload failed for ${originalName}: ${status.failedReason || 'unknown error'}`);
            }
            await sleep(1000);
        }
        throw new Error(`Queued upload did not finish in time for ${originalName}`);
    }

    assert(first.success, `Synchronous upload failed for ${originalName}`);
    return first;
}

async function main() {
    const initialContent = [
        'Смоук-тест RAG.',
        'Женская стрижка стоит от 2500 рублей.',
        'Мужская стрижка стоит 1800 рублей.',
        'Доставка подарочного сертификата по Москве стоит 700 рублей.',
        `Уникальный маркер запуска: ${TEST_RUN_ID}.`
    ].join('\n');

    const nextVersionContent = [
        'Смоук-тест RAG версия 2.',
        'Комплекс стрижка + борода стоит 2800 рублей.',
        'Маникюр с покрытием гель-лаком стоит 3000 рублей.',
        `Версия документа обновлена: ${TEST_RUN_ID}.`
    ].join('\n');

    startServer();
    await waitForHealth();

    const instanceId = await ensureInstance();
    console.log(`Using instance ${instanceId}`);

    const beforeVersions = await request(`/knowledge-base/${instanceId}/versions/${encodeURIComponent('smoke-rag.txt')}`);
    const initialUpload = await uploadDocument(instanceId, 'files', 'smoke-rag.txt', initialContent);
    assert(initialUpload.success, 'Initial upload should succeed');

    const keywordSearch = await request(`/knowledge-base/${instanceId}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query: 'стрижкой',
            searchType: 'keyword',
            k: 3
        })
    });
    assert(keywordSearch.resultsCount > 0, 'Keyword search should return results for Russian inflection');

    const hybridSearch = await request(`/knowledge-base/${instanceId}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query: 'мужская стрижка сколько стоит',
            searchType: 'hybrid',
            k: 3
        })
    });
    assert(hybridSearch.resultsCount > 0, 'Hybrid search should return results');

    const filesResponse = await request(`/knowledge-base/${instanceId}`);
    const currentDocument = (filesResponse.files || []).find((file) => file.id === initialUpload.kbId);
    assert(currentDocument, 'Uploaded document should be listed');

    const chunksResponse = await request(`/knowledge-base/${instanceId}/document/${initialUpload.kbId}/chunks`);
    assert((chunksResponse.chunks || []).length > 0, 'Uploaded document should have chunks');

    const chunkToEdit = chunksResponse.chunks[0];
    const marker = `smoke-marker-${TEST_RUN_ID}`;
    const updateResponse = await request(`/knowledge-base/${instanceId}/chunks/${chunkToEdit.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text: `${chunkToEdit.text}\n\n${marker}`,
            section: 'smoke-edit'
        })
    });
    assert(updateResponse.success, 'Chunk update should succeed');

    const markerSearch = await request(`/knowledge-base/${instanceId}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query: marker,
            searchType: 'keyword',
            k: 3
        })
    });
    assert(markerSearch.results.some((result) => result.text.includes(marker)), 'Updated marker should be searchable');

    const deleteChunkResponse = await request(`/knowledge-base/${instanceId}/chunks/${chunkToEdit.id}`, {
        method: 'DELETE'
    });
    assert(deleteChunkResponse.success, 'Chunk delete should succeed');

    const markerSearchAfterDelete = await request(`/knowledge-base/${instanceId}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query: marker,
            searchType: 'keyword',
            k: 3
        })
    });
    assert(markerSearchAfterDelete.resultsCount === 0, 'Deleted chunk should disappear from search');

    const secondUpload = await uploadDocument(instanceId, 'file', 'smoke-rag.txt', nextVersionContent);
    assert(secondUpload.success, 'Legacy file upload should succeed');
    assert(secondUpload.version >= 2, 'Second upload should create a new version');

    let duplicateRejected = false;
    try {
        await uploadDocument(instanceId, 'files', 'duplicate-rag.txt', nextVersionContent);
    } catch (error) {
        duplicateRejected = /duplicate|дубликат/i.test(String(error.message));
    }
    assert(duplicateRejected, 'Duplicate content should be rejected regardless of filename');

    const afterVersions = await request(`/knowledge-base/${instanceId}/versions/${encodeURIComponent('smoke-rag.txt')}`);
    assert((afterVersions.versions || []).length >= (beforeVersions.versions || []).length + 1, 'Version history should grow after uploading new content');
    assert((afterVersions.versions || []).some((version) => Number(version.isCurrent) === 1), 'Version history should contain a current version');

    const deleteCurrentVersion = await request(`/knowledge-base/${instanceId}/${secondUpload.kbId}`, {
        method: 'DELETE'
    });
    assert(deleteCurrentVersion.success, 'Deleting current version should succeed');

    const restoredVersions = await request(`/knowledge-base/${instanceId}/versions/${encodeURIComponent('smoke-rag.txt')}`);
    assert((restoredVersions.versions || []).some((version) => Number(version.isCurrent) === 1), 'Previous version should become current after deleting latest version');

    const statsResponse = await request(`/knowledge-base/${instanceId}/stats`);
    assert(statsResponse.stats.totalDocuments >= 1, 'Stats should report documents');
    assert(typeof statsResponse.stats.vectorSearchAvailable === 'boolean', 'Stats should expose vectorSearchAvailable');

    const analyticsResponse = await request(`/knowledge-base/${instanceId}/analytics`);
    assert((analyticsResponse.analytics.totalSearches || 0) >= 4, 'Analytics should log search requests');

    const rebuildResponse = await request(`/knowledge-base/${instanceId}/rebuild-embeddings`, {
        method: 'POST'
    });
    assert.strictEqual(typeof rebuildResponse.success, 'boolean', 'Rebuild endpoint should return success flag');

    console.log('RAG smoke test passed');
}

main()
    .catch(async (error) => {
        console.error('RAG smoke test failed');
        console.error(error);
        await stopServer();
        process.exit(1);
    })
    .then(async () => {
        await stopServer();
    });
