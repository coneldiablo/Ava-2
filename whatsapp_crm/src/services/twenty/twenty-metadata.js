function contractError() {
    return Object.assign(new Error('Twenty metadata response is incomplete or unsupported'),
        { code: 'TWENTY_METADATA_CONTRACT_INVALID', retryable: false });
}

// v2.37.0 can return either the direct or the legacy envelope, selected
// by its metadata feature flag. Never interpret an unknown envelope as empty.
async function listMetadata(client, kind) {
    const result = [], cursors = new Set();
    let after;
    for (let page = 0; page < 100; page++) {
        const response = await client.request('GET', `/rest/metadata/${kind}`,
            { params: { limit: 100, ...(after ? { starting_after: after } : {}) } });
        const rows = Array.isArray(response) ? response
            : Array.isArray(response?.data) ? response.data : response?.data?.[kind];
        if (!Array.isArray(rows) || rows.some(row => !row?.id)) throw contractError();
        result.push(...rows);
        if (!response.pageInfo?.hasNextPage) return result;
        after = response.pageInfo.endCursor;
        if (!after || cursors.has(after)) throw contractError();
        cursors.add(after);
    }
    throw contractError();
}

function createdMetadata(response, kind) {
    const item = response?.data?.[`createOne${kind}`] || response?.data || response;
    if (!item?.id) throw contractError();
    return item;
}

module.exports = { listMetadata, createdMetadata };
