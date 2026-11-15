import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = process.env.ADMIN_STATIC_DIR || fileURLToPath(new URL('../admin/', import.meta.url));
const html = await readFile(resolve(root, 'index.html'), 'utf8');
for (const resource of ['/admin/admin.css', '/admin/admin.js']) {
  assert.ok(html.includes(resource), `Missing static resource: ${resource}`);
  await readFile(resolve(root, resource.split('/').at(-1)));
}
assert.match(html, /<html\s+lang="zh-CN"/);
assert.doesNotMatch(html, /<(?:script|style)\b[^>]*>\s*[^<\s][\s\S]*?<\/(?:script|style)>/i);
const source = await readFile(resolve(root, 'admin.js'), 'utf8');
assert.ok(source.includes("const API = '/api/v2'"));
assert.ok(source.includes("credentials: 'same-origin'"));
assert.doesNotMatch(source, /localStorage|sessionStorage|innerHTML|outerHTML/);
console.log('Canonical admin static sources and same-origin contract verified.');
await import('./check-admin-behavior.mjs');
