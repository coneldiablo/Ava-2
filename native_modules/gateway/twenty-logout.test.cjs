'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspect } = require('./twenty-logout.cjs');

function request(body, headers = {}) {
    const listeners = {};
    return { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        on(name, fn) { listeners[name] = fn; if (name === 'data') fn(Buffer.from(JSON.stringify(body))); if (name === 'end') fn(); },
        destroy() {}, listeners };
}

test('recognizes canonical, aliased and fragment signOut fields', async () => {
    for (const query of [
        'mutation SignOut { signOut }',
        'mutation { bye: signOut(refreshToken: null) }',
        'mutation { ...Logout } fragment Logout on Mutation { out: signOut }',
        'mutation { ... on Mutation { out: signOut } }',
    ]) assert.equal((await inspect(request({ query }))).matched, true);
});

test('does not trust operationName and rejects ambiguous or foreign requests', async () => {
    assert.equal((await inspect(request({ query: 'query { currentUser }', operationName: 'SignOut' }))).matched, false);
    assert.equal((await inspect(request([{ query: 'mutation { signOut }' }]))).ambiguous, true);
    assert.equal((await inspect(request({ query: 'mutation A { signOut } mutation B { currentUser }' }))).ambiguous, true);
    assert.equal((await inspect(request({ query: 'mutation A { signOut } mutation B { currentUser }', operationName: 'A' }))).matched, true);
    assert.equal((await inspect(request({ query: 'mutation { signOut currentUser }' }))).matched, false);
    assert.equal((await inspect(request({ query: 'mutation { signOut @include(if: true) }' }))).ambiguous, true);
    assert.equal((await inspect(request({ query: 'mutation { ...Missing } fragment Other on Mutation { signOut }' }))).ambiguous, true);
    assert.equal((await inspect(request({ query: 'mutation A { signOut } mutation B { currentUser }', operationName: 'B' }))).ambiguous, true);
    assert.equal((await inspect(request({ query: 'mutation { signOut }' }, { origin: 'https://evil.test' }))).matched, true);
});
