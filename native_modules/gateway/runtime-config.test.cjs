'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { applyNativeScope } = require('./runtime-config.cjs');
test('gateway imports only its native identity from the pinned bootstrap mount', t => {
    const config = { businessId: 7, deploymentId: crypto.randomUUID(), revision: 2, module: 'twenty',
        nativeScopeFile: '/run/ava-bootstrap/bootstrap.json' };
    const scope = crypto.randomUUID();
    let value = { ...config, nativeScope: scope }, closed = 0, mode = 0o100600;
    t.mock.method(fs, 'openSync', path => { assert.equal(path, config.nativeScopeFile); return 123; });
    t.mock.method(fs, 'fstatSync', () => ({ isFile: () => true, size: 500, mode, uid: process.getuid() }));
    t.mock.method(fs, 'readFileSync', () => JSON.stringify(value));
    t.mock.method(fs, 'closeSync', () => closed++);
    assert.equal(applyNativeScope(config).nativeScope, scope);
    for (const patch of [{ businessId: 8 }, { deploymentId: crypto.randomUUID() }, { revision: 1 },
        { nativeScope: 'bad' }, { nativeScope: null }]) {
        value = { ...config, nativeScope: scope, ...patch };
        assert.throws(() => applyNativeScope(config), { code: 'AVA_MODULE_ACCESS_DENIED' });
    }
    value = { ...config, nativeScope: scope }; mode = 0o100640;
    assert.throws(() => applyNativeScope(config), { code: 'AVA_MODULE_ACCESS_DENIED' });
    mode = 0o100600;
    assert.throws(() => applyNativeScope({ ...config, nativeScope: crypto.randomUUID() }), { code: 'AVA_MODULE_ACCESS_DENIED' });
    assert.equal(closed, 8);
});
test('fixed scope mount cannot become an arbitrary credential file reader', () => {
    for (const config of [{ module: 'twenty', nativeScopeFile: '/run/ava/secrets/broker-peer' },
        { module: 'onyx', nativeScopeFile: '/run/ava-bootstrap/bootstrap.json' }]) {
        assert.throws(() => applyNativeScope(config), { code: 'AVA_MODULE_ACCESS_DENIED' });
    }
    const legacy = { nativeScope: 'existing-explicit-scope' };
    assert.equal(applyNativeScope(legacy), legacy);
});
