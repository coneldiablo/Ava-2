'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Entry = require('./twenty-entry.cjs');

test('Twenty entry bridge clears only stale UI caches, sets the cookie-session readiness flag, and uses a fixed local route', () => {
  assert.equal(Entry.READY_PATH, '/ava-auth/ready');
  assert.equal(Entry.SCRIPT_PATH, '/ava-auth/twenty-entry.js');
  assert.match(Entry.READY_DOCUMENT, /<script src="\/ava-auth\/twenty-entry\.js"><\/script>/);
  assert.deepEqual(Entry.HYDRATION_CACHE_KEYS, [
    'currentUserState',
    'currentWorkspaceState',
    'currentUserWorkspaceState',
    'currentWorkspaceMemberState',
  ]);
  for (const key of Entry.HYDRATION_CACHE_KEYS) {
    assert.match(Entry.ENTRY_SCRIPT, new RegExp(`localStorage\\.removeItem\\('${key}'\\)`));
  }
  assert.match(Entry.ENTRY_SCRIPT, /localStorage\.setItem\('isCookieAuthActiveState','true'\);\nlocation\.replace\('\/objects\/companies'\);\n$/);
  assert.doesNotMatch(Entry.ENTRY_SCRIPT, /document\.cookie|nativeCookie|sessionToken|tokenPair|authorization|bearer|https?:|location\.href/i);
  assert.match(Entry.READY_HEADERS['Content-Security-Policy'], /default-src 'none'; script-src 'self'/);
  assert.match(Entry.SCRIPT_HEADERS['Content-Security-Policy'], /default-src 'none'/);
});
