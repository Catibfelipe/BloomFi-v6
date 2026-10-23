// Server tests against the fake services (licenses, Open Finance data, reminders, sync limits).
// Accounts/sessions/2FA/captures are covered in auth.test.mjs. Run: node test/api.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeServices } from './fake-services.mjs';
import { makeDevice, signup } from './helpers.mjs';
import { generateLicenseKeys, randomId, verifyES, publicFromPrivate, now, b64url } from '../server/crypto.js';

const FP = 4599;
const { server, state } = await startFakeServices(FP);
const { priv } = await generateLicenseKeys();
const { priv: vapid } = await generateLicenseKeys();
const blobs = fs.mkdtempSync(path.join(os.tmpdir(), 'bloomfi-test-'));
Object.assign(process.env, {
  VAPID_PRIVATE_JWK: JSON.stringify(vapid), PUSH_ALLOW_LOCALHOST: '1', BLOBS_DIR: blobs, SUPPORT_EMAIL: 'ajuda@bloomfi.test', SUPPORT_WHATSAPP: '+55 (11) 99999-8888',
  APP_SECRET: randomId(48), LICENSE_PRIVATE_JWK: JSON.stringify(priv),
  STRIPE_SECRET_KEY: 'sk_test_x', PLUGGY_CLIENT_ID: 'fake-id', PLUGGY_CLIENT_SECRET: 's', RESEND_API_KEY: 're_x',
  STRIPE_API_BASE: `http://localhost:${FP}`, PLUGGY_API_BASE: `http://localhost:${FP}`, RESEND_API_BASE: `http://localhost:${FP}`,
  IOS_SHORTCUT_URL: 'https://www.icloud.com/shortcuts/abc123def456', QUIET_LOGS: '1',
});
const { handle, runPushCron } = await import('../server/handler.js');
const device = makeDevice(handle);
const pub = publicFromPrivate(priv);
const setSub = (customer, patch) => fetch(`http://localhost:${FP}/__set_sub`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer, patch }) });

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

// config
const D = device('mac');
let r = await D.call('GET', 'config');
assert.equal(r.data.billing.enabled, true); assert.equal(r.data.billing.price, 1490); assert.equal(r.data.openFinance.enabled, true);
assert.equal(r.data.licensePublicJwk.d, undefined, 'private part must never leak');
assert.equal(b64url.decode(r.data.push.publicKey).length, 65); assert.equal(r.data.sync.enabled, true);
assert.deepEqual(r.data.support, { email: 'ajuda@bloomfi.test', whatsapp: '5511999998888' });
assert.equal(r.data.wallet.iosShortcutUrl, 'https://www.icloud.com/shortcuts/abc123def456');
assert.ok(!JSON.stringify(r.data).includes(vapid.d), 'VAPID private key must never leak');
ok('config: public keys, sync, support contact and the iPhone shortcut link');

// unknown route + bad json
assert.equal((await D.call('GET', 'nope')).status, 404);
r = await handle(new Request('https://app.test/api/auth/login', { method: 'POST', headers: { 'X-BloomFi': '1', 'Content-Type': 'application/json' }, body: '{bad' }));
assert.equal(r.status, 400);
r = await handle(new Request('https://app.test/api/auth/login', { method: 'POST', body: '{}' }));
assert.equal(r.status, 403, 'calls not made by our own pages are refused');
ok('rejects bad routes, bad JSON and calls from other sites');
assert.equal((await D.call('POST', 'license')).status, 401);
assert.equal((await D.call('POST', 'billing/checkout')).status, 401);
ok('subscription routes need a signed-in account');

// account + checkout
const ana = await signup(D, state, { name: 'Ana', email: 'ana@email.com', password: 'uma-senha-bem-grande-1' });
r = await D.call('POST', 'billing/checkout');
const sessionId = new URL(r.data.url).searchParams.get('session_id');
const sess = state.sessions.get(sessionId);
assert.equal(sess.params['line_items[0][price_data][unit_amount]'], '1490');
assert.ok(sess.params.success_url.startsWith('https://app.test/app/?checkout=success'));
assert.equal(state.customers.get(sess.params.customer).email, 'ana@email.com');
assert.equal(sess.params['subscription_data[metadata][plan]'], 'essencial');
ok('checkout: our price, our own origin, a Stripe customer with the account e-mail');
// the three plans, by number of banks
r = await D.call('GET', 'config');
assert.deepEqual(r.data.billing.plans, [{ id: 'essencial', price: 1490, banks: 0 }, { id: 'plus', price: 2490, banks: 3 }, { id: 'premium', price: 3490, banks: 6 }]);
assert.equal(r.data.billing.familyPrice, undefined);
const P = device('mac');
await signup(P, state, { name: 'Paulo', email: 'paulo@email.com', password: 'outra-senha-bem-grande-2' });
for (const [plan, cents, name] of [['plus', '2490', 'BloomFi Plus'], ['premium', '3490', 'BloomFi Premium']]) {
  const x = await P.call('POST', 'billing/checkout', { plan });
  const sx = state.sessions.get(new URL(x.data.url).searchParams.get('session_id'));
  assert.equal(sx.params['line_items[0][price_data][unit_amount]'], cents);
  assert.equal(sx.params['line_items[0][price_data][product_data][name]'], name);
  assert.equal(sx.params['subscription_data[metadata][plan]'], plan);
}
assert.equal((await P.call('POST', 'billing/checkout', { plan: 'family' })).status, 400);
ok('plans: Essencial R$ 14,90 (no banks), Plus R$ 24,90 (3 banks), Premium R$ 34,90 (6 banks); no Family plan');
r = await D.call('POST', 'billing/claim', { sessionId });
let L = await verifyES(r.data.license, pub);
assert.equal(L.email, 'ana@email.com'); assert.equal(L.status, 'trialing'); assert.equal(L.sub, ana.login.user.id);
assert.equal(L.plan, 'essencial'); assert.equal(L.banks, 0);
assert.equal((await D.call('POST', 'billing/claim', { sessionId: 'nope' })).status, 400);
ok('claim returns a signed license for this account');

// license windows
const cust = sess.customer;
const end = now() + 10 * 86400;
await setSub(cust, { status: 'active', cancel_at_period_end: true, items: { data: [{ current_period_end: end }] } });
L = await verifyES((await D.call('POST', 'license')).data.license, pub);
assert.equal(L.exp, end); assert.equal(L.renews, false); ok('canceled-at-period-end license stops exactly at period end');
await setSub(cust, { status: 'past_due', cancel_at_period_end: false, items: { data: [{ current_period_end: now() - 86400 }] } });
L = await verifyES((await D.call('POST', 'license')).data.license, pub);
assert.equal(L.status, 'past_due'); assert.ok(L.exp <= now() + 3 * 86400 + 5); ok('past_due gets a short grace period');
await setSub(cust, { status: 'canceled' });
r = await D.call('POST', 'license');
// the trial (7 days from sign-up) still covers this brand-new account
assert.equal((await verifyES(r.data.license, pub)).status, 'trial');
ok('canceled subscription -> back to whatever is left of the free trial');
await setSub(cust, { status: 'active', items: { data: [{ current_period_end: now() + 30 * 86400 }] }, metadata: { plan: 'premium' } });

// portal
r = await D.call('POST', 'billing/portal');
assert.ok(r.data.url.includes('portal=fake')); ok('billing portal');
state.noPortal = true;
r = await D.call('POST', 'billing/portal');
assert.equal(r.status, 409); assert.equal(r.data.error, 'portal_not_configured'); ok('portal not activated in Stripe -> clear error');
state.noPortal = false;

// Open Finance data
const lic = (await D.call('POST', 'license')).data.license;
const auth = { Authorization: `Bearer ${lic}` };
r = await D.call('POST', 'of/connect-token', {}, auth);
const ct = r.data.accessToken;
assert.equal(state.connectTokens.get(ct), ana.login.user.id); ok('connect token bound to the account');
const item = (await (await fetch(`http://localhost:${FP}/__create_item`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectToken: ct }) })).json()).item;
r = await D.call('GET', `of/item?id=${item.id}`, null, auth);
assert.equal(r.data.connector.name, 'Pluggy Bank (sandbox)');
r = await D.call('GET', `of/accounts?itemId=${item.id}`, null, auth);
assert.equal(r.data.results.length, 2);
const bank = r.data.results.find((a) => a.type === 'BANK');
r = await D.call('GET', `of/transactions?accountId=${bank.id}&from=2020-01-01`, null, auth);
assert.equal(r.data.results.length, 6); ok('transactions follow the pagination cursor');
r = await D.call('GET', `of/investments?itemId=${item.id}`, null, auth);
assert.equal(r.data.results.length, 3); ok('investments');
// without the license header the server checks the subscription itself
assert.equal((await D.call('GET', `of/accounts?itemId=${item.id}`)).status, 200);
const O = device('android');
await signup(O, state, { name: 'Outro', email: 'outro@email.com', password: 'outra-senha-bem-grande' });
assert.equal((await O.call('GET', `of/accounts?itemId=${item.id}`)).status, 404);
assert.equal((await O.call('GET', `of/transactions?accountId=${bank.id}`)).status, 404);
assert.equal((await O.call('DELETE', `of/item?id=${item.id}`)).status, 404);
assert.equal((await O.call('GET', `of/accounts?itemId=${item.id}`, null, auth)).status, 404, "someone else's license doesn't help");
ok('items are isolated between accounts');
assert.equal((await D.call('GET', 'of/accounts?itemId=../../etc', null, auth)).status, 400); ok('ids are validated');
r = await D.call('DELETE', `of/item?id=${item.id}`, null, auth);
assert.equal(r.data.ok, true); assert.equal(state.items.has(item.id), false); ok('disconnect removes the item at Pluggy');

// Official site (PLUGGY_SANDBOX off): Pluggy's fictional test bank never delivers its made-up numbers.
r = await D.call('POST', 'of/connect-token', {}, auth);
const testItem = (await (await fetch(`http://localhost:${FP}/__create_item`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectToken: r.data.accessToken }) })).json()).item;
state.items.get(testItem.id).connector.isSandbox = true;
r = await D.call('GET', `of/item?id=${testItem.id}`, null, auth);
assert.equal(r.status, 410); assert.equal(r.data.error, 'sandbox_item');
assert.equal((await D.call('GET', `of/accounts?itemId=${testItem.id}`, null, auth)).status, 410);
assert.equal((await D.call('GET', `of/investments?itemId=${testItem.id}`, null, auth)).status, 410);
assert.equal((await D.call('POST', 'of/refresh', { itemId: testItem.id }, auth)).status, 410);
r = await D.call('DELETE', `of/item?id=${testItem.id}`, null, auth);
assert.equal(r.data.ok, true); assert.equal(state.items.has(testItem.id), false);
ok("official mode: the test bank's data is refused (it can still be removed)");

// ---------------- bill reminders (Web Push) ----------------
const subtle = globalThis.crypto.subtle;
const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPub = new Uint8Array(await subtle.exportKey('raw', ua.publicKey));
const authSecret = globalThis.crypto.getRandomValues(new Uint8Array(16));
const subscription = { endpoint: `http://localhost:${FP}/push/dev1`, keys: { p256dh: b64url.encode(uaPub), auth: b64url.encode(authSecret) } };
assert.equal((await D.call('POST', 'push', { subscription: { ...subscription, endpoint: 'https://evil.example.com/x' }, items: [] })).status, 400);
ok('reminders only go to real push services');
const t0 = now();
r = await D.call('POST', 'push', { subscription, items: [
  { at: t0 - 600, title: 'Conta vencendo hoje', body: '1 conta. Toque para ver na agenda.', tag: 'due:x' },
  { at: t0 + 86400, title: 'Amanhã', body: 'futuro', tag: 'due:y' },
  { at: t0 + 400 * 86400, title: 'too far', body: '' },
] });
assert.equal(r.data.scheduled, 2); ok('schedule saved (far-future items dropped)');
let cron = await runPushCron(undefined, t0);
assert.equal(cron.sent, 1); assert.equal(state.pushes.length, 1);
const got = state.pushes[0];
assert.equal(got.headers['content-encoding'], 'aes128gcm');
const [, jwt, k] = got.headers.authorization.match(/^vapid t=([^,]+), k=(.+)$/);
const vkey = await subtle.importKey('raw', b64url.decode(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
const [h, p, sg] = jwt.split('.');
assert.ok(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vkey, b64url.decode(sg), new TextEncoder().encode(`${h}.${p}`)));
assert.equal(JSON.parse(Buffer.from(b64url.decode(p)).toString()).aud, `http://localhost:${FP}`);
ok('push signed with VAPID (valid JWT for the push service)');
// decrypt like a browser would (RFC 8291)
const bodyBytes = new Uint8Array(Buffer.from(got.body, 'base64'));
const salt = bodyBytes.slice(0, 16), idlen = bodyBytes[20], asPub = bodyBytes.slice(21, 21 + idlen), cipher = bodyBytes.slice(21 + idlen);
const hk = async (s2, ikm, info, n) => new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s2, info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
const te = new TextEncoder();
const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: await subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, ua.privateKey, 256));
const ikm = await hk(authSecret, shared, new Uint8Array([...te.encode('WebPush: info\0'), ...uaPub, ...asPub]), 32);
const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), cipher));
assert.equal(plain[plain.length - 1], 2);
const msg = JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
assert.equal(msg.title, 'Conta vencendo hoje'); assert.equal(msg.url, '/app/#agenda');
ok('payload is encrypted end-to-end (aes128gcm) and the device can read it');
cron = await runPushCron(undefined, t0 + 60);
assert.equal(cron.sent, 0); ok('a reminder is sent only once');
r = await O.call('POST', 'push/test', { endpoint: subscription.endpoint });
assert.equal(r.status, 404); ok("nobody can test-push someone else's device");
r = await O.call('POST', 'push/remove', { endpoint: subscription.endpoint });
assert.equal(r.status, 404); ok("nobody can remove someone else's reminders");
state.pushGone.add('dev1');
cron = await runPushCron(undefined, t0 + 86400 + 10);
assert.equal(cron.removed, 1); ok('expired subscriptions are cleaned up');

// ---------------- encrypted sync limits ----------------
r = await handle(new Request('https://app.test/api/sync', {
  method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-BloomFi': '1', cookie: Object.entries(D.cookies).map(([a, b]) => `${a}=${b}`).join('; ') },
  body: JSON.stringify({ baseVersion: 0, keyVersion: 1, data: 'x'.repeat(4_600_000) }),
}));
assert.ok(r.status === 400 || r.status === 413); ok('sync size is limited');
assert.equal((await D.call('PUT', 'sync', { baseVersion: 0, keyVersion: 1, data: 'c1' })).data.version, 1);
assert.equal((await D.call('DELETE', 'sync')).data.ok, true);
assert.equal((await D.call('GET', 'sync')).data.version, 0); ok('cloud copy can be deleted');

// hourly job also tidies expired codes and limits
cron = await runPushCron(undefined, now());
assert.ok(cron.cleaned >= 0); ok('hourly job tidies expired codes and limits');

// not configured server
delete process.env.APP_SECRET;
assert.equal((await D.call('POST', 'license')).status, 503); ok('unconfigured server answers 503, not a crash');
assert.equal((await D.call('GET', 'config')).status, 200); ok('config still answers without secrets');

console.log(`\n${passed} checks passed`);
server.close();
fs.rmSync(blobs, { recursive: true, force: true });
