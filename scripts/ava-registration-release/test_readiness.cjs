'use strict';
// Execute the operator's exact probe without opening a socket.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const {EventEmitter} = require('events');
const source = fs.readFileSync(require('path').join(__dirname, 'release_operator.py'), 'utf8');
const legacy = source.match(/READINESS_JS = r'''([\s\S]*?)'''/)[1];
const candidate = legacy.replace('const requireWorkerReady=false;', 'const requireWorkerReady=true;');
async function probe(script, role, status, body, expected, failure) {
    const process = {env: {AVA_PROCESS_ROLE: role}, exitCode: 0};
    let output = '', options;
    const request = new EventEmitter();
    request.destroy = () => request.emit('error', Error('synthetic'));
    const http = {get: (opts, callback) => {
        options = opts;
        queueMicrotask(() => {
            if (failure) { request.emit(failure); return; }
            const response = new EventEmitter(); response.statusCode = status;
            callback(response); response.emit('data', body); response.emit('end');
        });
        return request;
    }};
    vm.runInNewContext(script, {require: name => {assert.strictEqual(name, 'http'); return http;},
        process, console: {log: text => {output += text;}}});
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(options.host, '127.0.0.1');
    assert.strictEqual(options.path, role === 'provisioning-worker' ? '/__ava_release_readiness__' : '/api/health');
    assert.strictEqual(process.exitCode === 0, expected);
    assert.strictEqual(output, expected ? '{"ready":true}' : '');
}
(async () => {
    const worker = 'provisioning-worker';
    await probe(legacy, worker, 403, 'IDENTITY_BROKER_ACCESS_DENIED', true);
    await probe(legacy, worker, 200, '{"ready":true}', true);
    await probe(legacy, worker, 200, '{"ready":false}', false);
    await probe(legacy, worker, 200, 'malformed', false);
    await probe(legacy, worker, 503, '{"ready":true}', false);
    await probe(candidate, worker, 403, 'IDENTITY_BROKER_ACCESS_DENIED', false);
    await probe(candidate, worker, 200, '{"ready":true}', true);
    await probe(candidate, worker, 200, '{"ready":false}', false);
    await probe(candidate, worker, 200, '{"ready":"true"}', false);
    await probe(candidate, worker, 200, 'malformed', false);
    await probe(candidate, worker, 503, '{"ready":true}', false);
    await probe(candidate, 'crm', 200, '{}', true);
    await probe(candidate, worker, 0, '', false, 'error');
    await probe(candidate, worker, 0, '', false, 'timeout');
    process.stdout.write('Readiness probe: 14 cases passed (no sockets)\n');
})().catch(error => {console.error(error); process.exitCode = 1;});
