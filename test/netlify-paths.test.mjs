// Deployment check: every route of the server is reachable through one of the Netlify functions' paths
// (a route missing there works in the tests but answers 404 on the real site). Run: node test/netlify-paths.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.QUIET_LOGS = '1';
const { ROUTE_KEYS } = await import('../server/handler.js');
const dir = path.resolve('netlify/functions');
const patterns = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const m = src.match(/path:\s*\[([\s\S]*?)\]/);
  if (!m) continue;
  for (const [, p] of m[1].matchAll(/'([^']+)'/g)) patterns.push({ f, re: new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`) });
}
const missing = [];
for (const key of ROUTE_KEYS) {
  const p = key.split(' ')[1];
  const url = `/api/${p === 'wallet/in' ? 'wallet/in/bfw_example' : p}`;
  if (!patterns.some((x) => x.re.test(url))) missing.push(url);
}
assert.deepEqual(missing, [], `routes without a Netlify function path: ${missing.join(', ')}`);
console.log(`  ✓ all ${ROUTE_KEYS.length} routes are reachable on Netlify`);
console.log('\n1 checks passed');
process.exit(0);
