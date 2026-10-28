#!/usr/bin/env node
'use strict';
// Read-only source inventory. Occurrences are discovery seeds, not accepted user actions.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'whatsapp_crm/frontend/node_modules/typescript'));
const ref = process.argv[2] || 'HEAD';
const prefix = 'whatsapp_crm/frontend/src/';
const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const files = git('ls-tree', '-r', '--name-only', ref).split('\n').filter(f => f.startsWith(prefix) && f.endsWith('.tsx') && !/\.test\./.test(f));
const controls = [], routes = [];
const texts = new Map(files.map(file => [file, git('show', `${ref}:${file}`)]));
function attrs(node, source) {
  return Object.fromEntries(node.attributes.properties.filter(ts.isJsxAttribute).map(a => [a.name.getText(source), a.initializer ? a.initializer.getText(source) : 'true']));
}
function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
for (const [file, text] of texts) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source), a = attrs(node, source);
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      const line = position.line + 1;
      if (tag === 'Route') routes.push({ file, line, path: a.path || (a.index ? '[index]' : '[pathless]'), element: clean(a.element) });
      if (['button', 'a', 'Link', 'NavLink', 'input', 'select', 'textarea', 'form', 'summary'].includes(tag) || a.onClick || a.onSubmit || a.role === '"button"') {
        const container = ts.isJsxOpeningElement(node) ? node.parent : node;
        const conditions = [];
        for (let p = node.parent; p; p = p.parent) {
          if (ts.isConditionalExpression(p)) conditions.push(clean(p.condition.getText(source)));
          if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) conditions.push(clean(p.left.getText(source)));
        }
        controls.push({ id: `SRC-${String(controls.length + 1).padStart(4, '0')}`, file, line, tag,
          label: clean(a['aria-label'] || a.title || a.placeholder || container.getText(source).replace(/<[^>]*>/g, ' ')).slice(0, 500),
          destination: a.to || a.href || '', handler: clean(a.onClick || a.onSubmit || a.onChange || ''),
          attributes: a, conditions, validation: 'NOT_TESTED', local: 'NOT_TESTED', integrated: 'NOT_TESTED', live_provider: 'NOT_TESTED', customer_acceptance: 'NOT_TESTED' });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const result = { generatedAt: new Date().toISOString(), ref, head: git('rev-parse', ref).trim(),
  semantics: 'Source JSX occurrences only. Multiple roles, dynamic list items, repeated components, modal and error states require semantic expansion. This count is NOT the complete action-register denominator.',
  counts: { sourceFiles: files.length, routeEntries: routes.length, controlOccurrences: controls.length }, routes, controls };
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
