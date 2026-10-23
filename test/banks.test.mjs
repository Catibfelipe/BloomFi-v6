// Plans by number of banks: Essencial (no banks), Plus (3), Premium (6). Banks only once the plan has been paid;
// a smaller plan pauses the newest connections; disconnecting always works; the hourly check removes, at Pluggy,
// the connections nobody pays for any more (3 days later; a week while a payment is failing); older connections
// are paused, not removed at once; gift codes carry a plan. Run: node test/banks.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeServices } from './fake-services.mjs';
import { makeDevice, signup } from './helpers.mjs';
import { generateLicenseKeys, randomId, verifyES, publicFromPrivate, signHS, now } from '../server/crypto.js';
import { b64u, rand } from '../src/lib/keys.js';

const FP = 4602;
const { server, state } = await startFakeServices(FP);
const { priv } = await generateLicenseKeys();
const { priv: vapid } = await generateLicenseKeys();
const blobs = fs.mkdtempSync(path.join(os.tmpdir(), 'bloomfi-banks-'));
Object.assign(process.env, {
  BLOBS_DIR: blobs, APP_SECRET: randomId(48), LICENSE_PRIVATE_JWK: JSON.stringify(priv), VAPID_PRIVATE_JWK: JSON.stringify(vapid), PUSH_ALLOW_LOCALHOST: '1',
  STRIPE_SECRET_KEY: 'sk_test_x', PLUGGY_CLIENT_ID: 'fake-id', PLUGGY_CLIENT_SECRET: 's', RESEND_API_KEY: 're_x',
  STRIPE_API_BASE: `http://localhost:${FP}`, PLUGGY_API_BASE: `http://localhost:${FP}`, RESEND_API_BASE: `http://localhost:${FP}`,
  QUIET_LOGS: '1',
});
const { handle, trimBanks } = await import('../server/handler.js');
const { getUser, saveUser } = await import('../server/accounts.js');
const { getKV } = await import('../server/storage.js');
const device = makeDevice(handle);
const pub = publicFromPrivate(priv);
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const H = 3600, DAY = 86400;

const setSub = (customer, patch) => fetch(`http://localhost:${FP}/__set_sub`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer, patch }) });
const newItem = async (connectToken, extra = {}) => (await (await fetch(`http://localhost:${FP}/__create_item`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectToken, ...extra }) })).json()).item;
const bearer = (tok) => (tok ? { Authorization: `Bearer ${tok}` } : {});
async function person(name, email) {
  const dev = device('iphone');
  const acct = await signup(dev, state, { name, email, password: `${name.toLowerCase()} senha bem comprida 2026` });
  return { dev, id: acct.login.user.id, lic: null };
}
async function license(p) {
  const r = await p.dev.call('POST', 'license');
  p.lic = r.data.license;
  return r.data;
}
async function subscribe(p, plan) {
  const r = await p.dev.call('POST', 'billing/checkout', { plan, startNow: true });
  const sid = new URL(r.data.url).searchParams.get('session_id');
  const c = await p.dev.call('POST', 'billing/claim', { sessionId: sid });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  p.lic = c.data.license;
  p.customer = state.sessions.get(sid).customer;
  return verifyES(c.data.license, pub);
}
async function connect(p, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = await p.dev.call('POST', 'of/connect-token', {}, bearer(p.lic));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const item = await newItem(r.data.accessToken);
    assert.equal((await read(p, item.id)).status, 200);
    out.push(item.id);
  }
  return out;
}
const read = (p, id) => p.dev.call('GET', `of/item?id=${id}`, null, bearer(p.lic));
const sync = (p, id) => p.dev.call('GET', `of/accounts?itemId=${id}`, null, bearer(p.lic));
const statuses = async (p, ids) => { const out = []; for (const id of ids) out.push((await read(p, id)).status); return out; };
const ofc = async (id) => (await getKV('index')).get(`ofc:${id}`);

// ---- config ----
let r = await device('mac').call('GET', 'config');
assert.deepEqual(r.data.billing.plans, [{ id: 'essencial', price: 1490, banks: 0 }, { id: 'plus', price: 2490, banks: 3 }, { id: 'premium', price: 3490, banks: 6 }]);
ok('three plans: Essencial R$ 14,90 (no banks), Plus R$ 24,90 (3 banks), Premium R$ 34,90 (6 banks)');

// ---- Essencial has no banks; Plus has 3 ----
const bruno = await person('Bruno', 'bruno@exemplo.com');
let L = await subscribe(bruno, 'essencial');
assert.equal(L.status, 'active'); assert.equal(L.plan, 'essencial'); assert.equal(L.banks, 0);
r = await bruno.dev.call('POST', 'of/connect-token', {}, bearer(bruno.lic));
assert.equal(r.status, 402); assert.equal(r.data.reason, 'plan'); assert.equal(r.data.limit, 0); assert.equal(r.data.plan, 'essencial');
L = await subscribe(bruno, 'premium');
assert.equal(L.plan, 'premium'); assert.equal(L.banks, 6);
const bItems = await connect(bruno, 5);
assert.deepEqual((await getUser(bruno.id)).of.items, bItems);
ok('Essencial can’t connect banks; after moving to Premium the banks connect (and are counted on the account)');

// ---- a smaller plan pauses the newest ----
await setSub(bruno.customer, { metadata: { plan: 'plus' } });
await license(bruno); // (the app asks for its license when it opens)
assert.deepEqual(await statuses(bruno, bItems), [200, 200, 200, 402, 402]);
r = await sync(bruno, bItems[4]);
assert.equal(r.status, 402); assert.equal(r.data.reason, 'plan'); assert.equal(r.data.limit, 3); assert.equal(r.data.plan, 'plus');
r = await bruno.dev.call('POST', 'of/connect-token', { itemId: bItems[3] }, bearer(bruno.lic));
assert.equal(r.status, 402, 'no new sign-in for a paused bank');
// disconnecting works with just the session (no license), and the next one is covered again
r = await bruno.dev.call('DELETE', `of/item?id=${bItems[1]}`);
assert.equal(r.status, 200);
assert.ok(!state.items.has(bItems[1]));
assert.deepEqual(await statuses(bruno, [bItems[0], bItems[2], bItems[3], bItems[4]]), [200, 200, 200, 402]);
ok('moving down to Plus pauses the newest banks; disconnecting one (always allowed) frees its place');

// ---- the hourly check removes what the plan doesn't cover, 3 days later ----
const subtle = globalThis.crypto.subtle;
const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const subscription = { endpoint: `http://localhost:${FP}/push/bruno1`, keys: { p256dh: b64u.enc(new Uint8Array(await subtle.exportKey('raw', ua.publicKey))), auth: b64u.enc(rand(16)) } };
assert.equal((await bruno.dev.call('POST', 'push', { subscription, items: [] })).status, 200);
const t0 = now();
assert.equal(await trimBanks(undefined, { at: t0 + 13 * H }), 0);
assert.equal((await ofc(bruno.id)).overSince, t0 + 13 * H);
assert.equal(await trimBanks(undefined, { at: t0 + 2 * DAY + 13 * H }), 0, 'not before 3 days');
const pushes = state.pushes.length;
assert.equal(await trimBanks(undefined, { at: t0 + 3 * DAY + 14 * H }), 1);
assert.ok(!state.items.has(bItems[4]) && state.items.has(bItems[3]));
assert.deepEqual((await getUser(bruno.id)).of.items, [bItems[0], bItems[2], bItems[3]]);
assert.equal((await getUser(bruno.id)).events[0].type, 'banks_disconnected');
assert.equal(state.pushes.length, pushes + 1, 'the person is told');
assert.ok(!(await ofc(bruno.id)).overSince);
assert.equal(await trimBanks(undefined, { at: t0 + 5 * DAY }), 0);
ok('3 days after the plan stopped covering a bank, it is removed at Pluggy (newest first) and the person is told');

// ---- subscription over: nothing covered; disconnecting still works; all removed after 3 days ----
const carla = await person('Carla', 'carla@exemplo.com');
await subscribe(carla, 'plus');
const cItems = await connect(carla, 2);
await setSub(carla.customer, { status: 'canceled' });
await saveUser(carla.id, (u) => ({ ...u, billing: { ...u.billing, trialStart: now() - 30 * DAY } }));
r = await license(carla);
assert.equal(r.license, null);
r = await read(carla, cItems[0]);
assert.equal(r.status, 402); assert.equal(r.data.error, 'subscription_required');
assert.equal((await carla.dev.call('DELETE', `of/item?id=${cItems[0]}`)).status, 200);
await trimBanks(undefined, { at: t0 + 13 * H });
assert.equal(await trimBanks(undefined, { at: t0 + 3 * DAY + 14 * H }), 1);
assert.ok(!state.items.has(cItems[1]));
assert.equal(await ofc(carla.id), null, 'nothing left to watch');
ok('when the subscription ends the banks stop at once and are removed 3 days later (disconnecting needs no plan)');

// ---- a failing payment: paused at once, removed only after a week; paying again before that keeps them ----
const davi = await person('Davi', 'davi@exemplo.com');
await subscribe(davi, 'plus');
const dItems = await connect(davi, 1);
await setSub(davi.customer, { status: 'past_due' });
await license(davi);
r = await sync(davi, dItems[0]);
assert.equal(r.status, 402); assert.equal(r.data.reason, 'payment_failed');
await trimBanks(undefined, { at: t0 + 13 * H });
assert.equal(await trimBanks(undefined, { at: t0 + 3 * DAY + 14 * H }), 0, 'a week for a failing payment');
await setSub(davi.customer, { status: 'active' });
await license(davi);
assert.equal((await sync(davi, dItems[0])).status, 200);
assert.equal(await trimBanks(undefined, { at: t0 + 7 * DAY + 15 * H }), 0);
assert.ok(state.items.has(dItems[0]));
const davi2 = await person('Davi Dois', 'davi2@exemplo.com');
await subscribe(davi2, 'plus');
const d2Items = await connect(davi2, 1);
await setSub(davi2.customer, { status: 'past_due' });
await license(davi2);
await trimBanks(undefined, { at: t0 + 13 * H });
assert.equal(await trimBanks(undefined, { at: t0 + 7 * DAY + 14 * H }), 1);
assert.ok(!state.items.has(d2Items[0]));
ok('a failing payment pauses the banks at once; they are removed only if it still fails a week later');

// ---- banks wait for the first payment; paying (or the trial ending) frees them within minutes ----
const eva = await person('Eva', 'eva@exemplo.com');
await license(eva);
r = await eva.dev.call('POST', 'of/connect-token', {}, bearer(eva.lic));
assert.equal(r.status, 402); assert.equal(r.data.reason, 'trial');
r = await eva.dev.call('POST', 'billing/checkout', { plan: 'plus' });
const esid = new URL(r.data.url).searchParams.get('session_id');
r = await eva.dev.call('POST', 'billing/claim', { sessionId: esid });
eva.lic = r.data.license;
r = await eva.dev.call('POST', 'of/connect-token', {}, bearer(eva.lic));
assert.equal(r.status, 402); assert.equal(r.data.reason, 'first_payment');
await setSub(state.sessions.get(esid).customer, { status: 'active', items: { data: [{ current_period_end: now() + 30 * DAY }] } }); // the trial ended and Stripe charged
skew += 3 * 60 * 1000;
r = await eva.dev.call('POST', 'of/connect-token', {}, bearer(eva.lic));
assert.equal(r.status, 200, 'the server asks Stripe again before saying no');
ok('banks wait for the first payment; once Stripe charges, they work without waiting for the app');

// ---- older connections (from before plans counted banks) are paused, not removed at once ----
const fabi = await person('Fabi', 'fabi@exemplo.com');
await license(fabi);
state.connectTokens.set('ct_antigo_fabi', fabi.id);
const old = await newItem('ct_antigo_fabi', { createdAt: new Date(Date.now() - 2 * DAY * 1000).toISOString() });
const fresh = await newItem('ct_antigo_fabi');
r = await read(fabi, old.id);
assert.equal(r.status, 402); assert.equal(r.data.reason, 'trial');
assert.ok(state.items.has(old.id), 'paused: still at Pluggy');
assert.equal((await read(fabi, fresh.id)).status, 402);
assert.ok(!state.items.has(fresh.id), 'a new one beyond the plan is removed at once');
await trimBanks(undefined, { at: t0 + 13 * H });
assert.equal(await trimBanks(undefined, { at: t0 + 3 * DAY + 14 * H }), 1);
assert.ok(!state.items.has(old.id));
ok('a connection from before plans counted banks is paused (removed after 3 days); a new one beyond the plan, at once');

// ---- a gift code gives the plan written on it ----
const gus = await person('Gus', 'gus@exemplo.com');
const gift = await signHS({ typ: 'account', kind: 'gift', sub: 'gift:gus@exemplo.com', email: 'gus@exemplo.com', until: now() + 90 * DAY, iat: now(), plan: 'plus' }, process.env.APP_SECRET);
r = await gus.dev.call('POST', 'billing/redeem', { code: gift });
L = await verifyES(r.data.license, pub);
assert.equal(L.status, 'gift'); assert.equal(L.plan, 'plus'); assert.equal(L.banks, 3);
gus.lic = r.data.license;
// Pluggy's "item created" notice counts a connection within the plan too (without the app reading it)
r = await gus.dev.call('POST', 'of/connect-token', {}, bearer(gus.lic));
const hook = new URL(state.lastConnectOptions.webhookUrl);
const gi = await newItem(r.data.accessToken);
const res = await handle(new Request(`https://app.test/api/of/webhook${hook.search}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'item/created', itemId: gi.id }) }));
assert.equal(res.status, 200);
await handle.lastBackground;
assert.deepEqual((await getUser(gus.id)).of.items, [gi.id]);
assert.ok(state.items.has(gi.id));
const plain = await signHS({ typ: 'account', kind: 'gift', sub: 'gift:hana@exemplo.com', email: 'hana@exemplo.com', until: now() + 90 * DAY, iat: now() }, process.env.APP_SECRET);
const hana = await person('Hana', 'hana@exemplo.com');
L = await verifyES((await hana.dev.call('POST', 'billing/redeem', { code: plain })).data.license, pub);
assert.equal(L.plan, 'essencial'); assert.equal(L.banks, 0);
ok('gift codes carry a plan (Plus = 3 banks); older codes give Essencial; Pluggy’s notice counts new connections');

server.close();
console.log(`\n${passed} checks passed`);
process.exit(0);
