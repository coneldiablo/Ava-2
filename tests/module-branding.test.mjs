import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { moduleDisplayText } from '../admin_ui/frontend/web/src/lib/module-branding.mjs';
const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('vendor names are presentation aliases, not changes to URLs or error codes', () => {
  assert.equal(moduleDisplayText('Onyx недоступен. Twenty отключён.'), 'AVA Знания недоступен. AVA CRM отключён.');
  assert.equal(moduleDisplayText('Onyx https://Onyx.example/api ONYX_NOT_LIVE Twenty'),
    'AVA Знания https://Onyx.example/api ONYX_NOT_LIVE AVA CRM');
  assert.equal(moduleDisplayText(null), null);
});

test('hotel labels use AVA while API routes and schema keys retain their contract', async () => {
  const source = await read('admin_ui/frontend/web/src/app/hotels/page.jsx');
  assert.doesNotMatch(source, /\b(Onyx|Twenty)\b/);
  for (const stable of ['/twenty', '/onyx', 'onyx_version', 'credential_ref', 'workspace_id']) {
    assert.ok(source.includes(stable), stable);
  }
  for (const name of ['AVA CRM', 'AVA Знания']) assert.ok(source.includes(name));
  assert.ok(source.includes('moduleDisplayText(twenty.last_error.message)'));
});

test('canonical module logos are small self-contained accessible vectors', async () => {
  for (const name of ['ava', 'ava-crm', 'ava-knowledge']) {
    const svg = await read(`assets/branding/${name}.svg`);
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.match(svg, /<title>AVA/);
    assert.match(svg, /stroke="currentColor"/);
    assert.doesNotMatch(svg, /<script|<image|<foreignObject|href=|onload=/i);
    assert.ok(Buffer.byteLength(svg) < 1200);
  }
});

test('packaged logos match canonical assets and CRM has an AVA browser title', async () => {
  assert.equal(await read('assets/branding/ava.svg'), await read('admin_ui/frontend/web/src/assets/ava.svg'));
  assert.equal(await read('assets/branding/ava-crm.svg'), await read('whatsapp_crm/frontend/public/branding/ava-crm.svg'));
  const html = await read('whatsapp_crm/frontend/index.html');
  assert.match(html, /<title>AVA CRM<\/title>/);
  assert.match(html, /href="\/branding\/ava-crm.svg"/);
});
