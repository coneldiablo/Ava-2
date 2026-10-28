#!/usr/bin/env node
// Copy canonical vector assets; no source-code, database or vendor-bundle rewriting.
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const [source, target] of [
  ['ava.svg', 'admin_ui/frontend/web/src/assets/ava.svg'],
  ['ava-crm.svg', 'whatsapp_crm/frontend/public/branding/ava-crm.svg'],
]) {
  const output = resolve(root, target);
  await mkdir(dirname(output), { recursive: true });
  await copyFile(resolve(root, 'assets/branding', source), output);
}
console.log('AVA module SVG assets synchronized.');
