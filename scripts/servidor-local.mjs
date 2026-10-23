/**
 * Local server: serves the built app (dist/) and the /api routes.
 *
 *   npm run build && npm run local          -> uses your real keys from .env
 *   npm run build && npm run local:teste    -> FAKE=1: fake Stripe/Pluggy/e-mail, no accounts needed
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8888);
const FAKE = process.env.FAKE === '1';

// Load .env if present
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

let fakeState = null;
if (FAKE) {
  const { startFakeServices } = await import('../test/fake-services.mjs');
  const { generateLicenseKeys, randomId } = await import('../server/crypto.js');
  const fp = PORT + 1;
  ({ state: fakeState } = await startFakeServices(fp));
  const { priv } = await generateLicenseKeys();
  const { priv: vapid } = await generateLicenseKeys();
  Object.assign(process.env, {
    VAPID_PRIVATE_JWK: process.env.VAPID_PRIVATE_JWK || JSON.stringify(vapid), PUSH_ALLOW_LOCALHOST: '1',
    APP_SECRET: process.env.APP_SECRET || randomId(48),
    LICENSE_PRIVATE_JWK: JSON.stringify(priv),
    STRIPE_SECRET_KEY: 'sk_test_fake', PLUGGY_CLIENT_ID: 'fake-id', PLUGGY_CLIENT_SECRET: 'fake-secret', PLUGGY_SANDBOX: process.env.FAKE_PLUGGY_SANDBOX || 'true',
    RESEND_API_KEY: 're_fake', FREE_ACCESS_EMAILS: process.env.FREE_ACCESS_EMAILS || 'familia@exemplo.com',
    STRIPE_API_BASE: `http://localhost:${fp}`, PLUGGY_API_BASE: `http://localhost:${fp}`, RESEND_API_BASE: `http://localhost:${fp}`, HIBP_API_BASE: `http://localhost:${fp}`,
  });
  console.log(`[fake] Stripe/Pluggy/e-mail simulados em http://localhost:${fp}`);
}
// Plain http on your computer: a session cookie without "Secure" (Safari refuses Secure cookies on http://localhost).
process.env.LOCAL_HTTP ||= '1';
// Sync copies and reminder schedules are kept in this folder when running on your computer.
process.env.BLOBS_DIR ||= path.join(root, FAKE ? '.dados-teste' : '.dados-locais');
const { handle, runPushCron } = await import('../server/handler.js');
// Sends due reminders every 5 minutes while the local server runs (on Netlify: every hour).
setInterval(() => runPushCron().catch(() => {}), 5 * 60000);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain',
  '.webp': 'image/webp', '.woff2': 'font/woff2',
};
const dist = path.join(root, 'dist');

// The same security headers as on Netlify (netlify.toml), so testing here shows the real behavior.
// Over plain http (your computer) HSTS and "upgrade-insecure-requests" are left out.
function readHeaderRules() {
  const rules = [];
  try {
    const toml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');
    for (const block of toml.split('[[headers]]').slice(1)) {
      const forM = block.match(/for\s*=\s*"([^"]+)"/);
      if (!forM) continue;
      const values = {};
      const part = block.split('[headers.values]')[1] || '';
      for (const line of part.split('\n')) {
        const m = line.match(/^\s*([A-Za-z-]+)\s*=\s*"(.*)"\s*$/);
        if (m) values[m[1]] = m[2];
        else if (/^\s*\[/.test(line)) break;
      }
      rules.push({ pattern: forM[1], values });
    }
  } catch { /* no netlify.toml */ }
  return rules;
}
const HEADER_RULES = readHeaderRules();
function headersFor(pathname) {
  const out = {};
  for (const r of HEADER_RULES) {
    const ok = r.pattern.endsWith('/*') ? pathname.startsWith(r.pattern.slice(0, -1)) || pathname === r.pattern.slice(0, -2) : pathname === r.pattern;
    if (ok) Object.assign(out, r.values);
  }
  delete out['Strict-Transport-Security'];
  if (out['Content-Security-Policy']) out['Content-Security-Policy'] = out['Content-Security-Policy'].replace(/;\s*upgrade-insecure-requests/, '');
  return out;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await handle(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  // Test helper used by the fake Pluggy widget
  if (FAKE && url.pathname === '/__fake/create-item') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await fetch(`${process.env.PLUGGY_API_BASE}/__create_item`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: Buffer.concat(chunks) });
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    return res.end(await r.text());
  }
  if (FAKE && url.pathname === '/__fake/push-cron') {
    const r = await runPushCron(undefined, Number(url.searchParams.get('at')) || undefined);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  if (FAKE && url.pathname.startsWith('/__fake/')) {
    const r = await fetch(`${process.env.STRIPE_API_BASE}${url.pathname.replace('/__fake', '')}${url.search}`, {
      method: req.method, headers: { 'Content-Type': 'application/json' },
      body: req.method === 'POST' ? await new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => ok(b)); }) : undefined,
    });
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    return res.end(await r.text());
  }
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory() && fs.existsSync(path.join(file, 'index.html'))) file = path.join(file, 'index.html');
  else if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, url.pathname.startsWith('/app') ? 'app/index.html' : 'index.html');
  res.writeHead(200, { ...headersFor(url.pathname), 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
// Only this computer can open it (not other devices on the same Wi-Fi); HOST=0.0.0.0 opens it to the network on purpose.
}).listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`BloomFi rodando em http://localhost:${PORT}${FAKE ? ' (modo teste: pagamentos e bancos simulados)' : ''}`));
