'use strict';

// This is not an authentication credential. The httpOnly native session has
// already been created and the gateway checks it before either response is
// served. It only lets Twenty's initial client-side effects start as logged in
// so they hydrate their normal current-user/workspace state from that cookie.
const ENTRY_PATH = '/objects/companies';
const READY_PATH = '/ava-auth/ready';
const SCRIPT_PATH = '/ava-auth/twenty-entry.js';
const HYDRATION_CACHE_KEYS = Object.freeze([
  'currentUserState',
  'currentWorkspaceState',
  'currentUserWorkspaceState',
  'currentWorkspaceMemberState',
]);
const READY_DOCUMENT = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Открываем CRM</title></head><body><script src="${SCRIPT_PATH}"></script></body></html>`;
const ENTRY_SCRIPT = `'use strict';\n${HYDRATION_CACHE_KEYS.map((key) => `localStorage.removeItem('${key}');`).join('\n')}\nlocalStorage.setItem('isCookieAuthActiveState','true');\nlocation.replace('${ENTRY_PATH}');\n`;
const READY_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
});
const SCRIPT_HEADERS = Object.freeze({
  'Content-Type': 'application/javascript; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
});

function writeReady(response) {
  response.writeHead(200, READY_HEADERS);
  response.end(READY_DOCUMENT);
}

function writeEntryScript(response) {
  response.writeHead(200, SCRIPT_HEADERS);
  response.end(ENTRY_SCRIPT);
}

module.exports = { ENTRY_PATH, ENTRY_SCRIPT, HYDRATION_CACHE_KEYS, READY_DOCUMENT, READY_HEADERS, READY_PATH, SCRIPT_HEADERS, SCRIPT_PATH, writeEntryScript, writeReady };
