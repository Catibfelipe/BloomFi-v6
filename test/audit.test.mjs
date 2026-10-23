// Security audit: the API attacked on purpose — every route without a session, from another site and with the
// wrong content type; other people's spaces; a member after losing the keys; banks beyond the plan (borrowed or
// forged licenses, a connect window used again); push to internal addresses; oversized bodies; spoofed client
// addresses. Run: node test/audit.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeServices } from './fake-services.mjs';
import { makeDevice, signup } from './helpers.mjs';
import { generateLicenseKeys, randomId, verifyES, publicFromPrivate, signES, now } from '../server/crypto.js';
import {
  newSpaceId, newSpaceKey, memberWrapKey, wrapSpaceKey, sealSpaceMeta, makeInvite, parseInvite, inviteProof, openInviteBox,
} from '../src/lib/spaces.js';

const FP = 4598;
const { server, state } = await startFakeServices(FP);
const { priv } = await generateLicenseKeys();
const { priv: vapid } = await generateLicenseKeys();
const blobs = fs.mkdtempSync(path.join(os.tmpdir(), 'bloomfi-audit-'));
Object.assign(process.env, {
  BLOBS_DIR: blobs, APP_SECRET: randomId(48), LICENSE_PRIVATE_JWK: JSON.stringify(priv), VAPID_PRIVATE_JWK: JSON.stringify(vapid),
  STRIPE_SECRET_KEY: 'sk_test_x', RESEND_API_KEY: 're_x', STRIPE_API_BASE: `http://localhost:${FP}`, RESEND_API_BASE: `http://localhost:${FP}`,
  PLUGGY_CLIENT_ID: 'fake-id', PLUGGY_CLIENT_SECRET: 's', PLUGGY_API_BASE: `http://localhost:${FP}`,
  SPACE_MAX_MEMBERS: '2', QUIET_LOGS: '1',
});
const { handle, ROUTE_KEYS } = await import('../server/handler.js');
const device = makeDevice(handle);
const pub = publicFromPrivate(priv);
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
const lic = async (dev) => verifyES((await dev.call('POST', 'license')).data.license, pub);

const A = device('iphone');
const ana = await signup(A, state, { name: 'Ana', email: 'ana@audit.com', password: 'girassol azul no quintal 77' });
const B = device('android');
const bia = await signup(B, state, { name: 'Bia', email: 'bia@audit.com', password: 'coruja sabia no galho 42' });
const C = device('mac');
const caio = await signup(C, state, { name: 'Caio', email: 'caio@audit.com', password: 'jabuticaba madura 2026 ok' });
const D = device('android');
const duda = await signup(D, state, { name: 'Duda', email: 'duda@audit.com', password: 'pitanga vermelha no pe 31' });

// ---- 1. every route without a session ----
const PUBLIC = new Set(['GET config', 'POST wallet/in', 'POST of/webhook']);
const anon = device('thief');
const leaks = [];
for (const key of ROUTE_KEYS) {
  const [method, p] = key.split(' ');
  const r = await anon.call(method, p, method === 'GET' || method === 'DELETE' ? undefined : {});
  if (r.status >= 500) leaks.push(`${key} → ${r.status}`);
  // (signing out without a session only clears the cookie)
  else if (r.status === 200 && !PUBLIC.has(key) && !p.startsWith('auth/') && key !== 'POST account/logout') leaks.push(`${key} → 200 without a session`);
}
assert.deepEqual(leaks, []);
ok(`all ${ROUTE_KEYS.length} routes: nothing answers without a session (except the public ones), and nothing crashes`);

// ---- 2. another site, with Ana's real cookie ----
const crossSite = [];
for (const key of ROUTE_KEYS) {
  if (PUBLIC.has(key)) continue;
  const [method, p] = key.split(' ');
  const r = await A.call(method, p, method === 'GET' || method === 'DELETE' ? undefined : {}, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' });
  if (r.status !== 403) crossSite.push(`${key} → ${r.status}`);
}
assert.deepEqual(crossSite, []);
const noHeader = await A.call('POST', 'account/profile', { name: 'Hacked' }, { 'X-BloomFi': null });
assert.equal(noHeader.status, 403);
const plain = await A.call('POST', 'account/profile', 'name=Hacked', { 'Content-Type': 'text/plain' });
assert.equal(plain.status, 415);
assert.equal((await A.call('GET', 'account/session')).data.user.name, 'Ana');
ok('from another site (or a plain form post) every route refuses, even with the victim’s cookie');

// ---- 3. other people's spaces ----
const anaWrap = await memberWrapKey(ana.bundle.dataKey);
const biaWrap = await memberWrapKey(bia.bundle.dataKey);
const s1 = newSpaceId();
const K1 = newSpaceKey();
let r = await A.call('POST', 'spaces', { id: s1, meta: await sealSpaceMeta(K1, s1, { name: 'Casa', emoji: '🏠' }), key: await wrapSpaceKey(anaWrap, s1, K1) });
assert.equal(r.status, 200, JSON.stringify(r.data));
const join = async (dev, wrap, sid, K) => {
  const { invite, fragment } = await makeInvite(K, sid);
  assert.equal((await A.call('POST', 'spaces/invite', { id: sid, invite })).status, 200);
  const proof = await inviteProof(parseInvite(fragment).secret);
  const peek = await dev.call('POST', 'spaces/peek', { id: sid, inviteId: invite.id, mac: proof.mac });
  const Kx = await openInviteBox(proof.wrap, sid, invite.id, peek.data.box);
  assert.equal((await dev.call('POST', 'spaces/join', { id: sid, inviteId: invite.id, mac: proof.mac, key: await wrapSpaceKey(wrap, sid, Kx) })).status, 200);
  const who = (await A.call('GET', 'spaces')).data.spaces.find((x) => x.id === sid).requests[0].id;
  assert.equal((await A.call('POST', 'spaces/approve', { id: sid, userId: who, ok: true })).status, 200);
  return who;
};
const biaId = await join(B, biaWrap, s1, K1);
assert.equal((await A.call('PUT', 'spaces/data', { id: s1, baseVersion: 0, data: 'ciphertext-1' })).status, 200);
const outsider = [
  await C.call('GET', `spaces/data?id=${s1}`),
  await C.call('PUT', 'spaces/data', { id: s1, baseVersion: 1, data: 'garbage' }),
  await C.call('POST', 'spaces/update', { id: s1, meta: await sealSpaceMeta(K1, s1, { name: 'x' }) }),
  await C.call('POST', 'spaces/invite', { id: s1, invite: (await makeInvite(K1, s1)).invite }),
  await C.call('POST', 'spaces/approve', { id: s1, userId: biaId, ok: false }),
  await C.call('POST', 'spaces/remove', { id: s1, userId: biaId }),
  await C.call('POST', 'spaces/delete', { id: s1 }),
  await C.call('POST', 'spaces/leave', { id: s1 }),
];
assert.ok(outsider.every((x) => x.status === 404 || x.status === 403), outsider.map((x) => x.status).join(','));
const member = [
  await B.call('POST', 'spaces/update', { id: s1, meta: await sealSpaceMeta(K1, s1, { name: 'x' }) }),
  await B.call('POST', 'spaces/remove', { id: s1, userId: ana.login.user.id }),
  await B.call('POST', 'spaces/delete', { id: s1 }),
  await B.call('POST', 'spaces/invite', { id: s1, invite: (await makeInvite(K1, s1)).invite }),
];
assert.ok(member.every((x) => x.status === 403), member.map((x) => x.status).join(','));
r = await A.call('GET', `spaces/data?id=${s1}`);
assert.equal(r.data.data, 'ciphertext-1');
assert.deepEqual((await A.call('GET', 'spaces')).data.spaces[0].members.map((m) => m.name).sort(), ['Ana', 'Bia']);
ok('someone outside a space can’t read, write, rename, invite, approve, remove or delete; a member can’t do owner things');

// a stolen or guessed link: 5 wrong proofs burn the invite
const { invite: inv2 } = await makeInvite(K1, s1);
await A.call('POST', 'spaces/remove', { id: s1, userId: biaId }); // room for one more (2 per space here)
assert.equal((await A.call('POST', 'spaces/invite', { id: s1, invite: inv2 })).status, 200);
for (let i = 0; i < 5; i++) {
  const wrong = await inviteProof(Buffer.from(new Uint8Array(32).fill(i + 1)).toString('base64url'));
  assert.equal((await C.call('POST', 'spaces/peek', { id: s1, inviteId: inv2.id, mac: wrong.mac })).status, 404);
}
assert.equal((await A.call('GET', 'spaces')).data.spaces[0].invites.length, 0);
ok('guessing an invite: after 5 wrong proofs the link is gone');

// ---- 4. a member whose keys were replaced (password reset without the recovery key) ----
const biaBack = await join(B, biaWrap, s1, K1);
assert.equal(biaBack, biaId);
const { staleSpaces } = await import('../server/spaces.js');
const { getUser } = await import('../server/accounts.js');
await staleSpaces(await getUser(biaId));
r = await B.call('PUT', 'spaces/data', { id: s1, baseVersion: 1, data: 'overwrite-everything' });
assert.notEqual(r.status, 200, 'a member without the key can’t overwrite the shared copy');
assert.notEqual((await B.call('GET', `spaces/data?id=${s1}`)).status, 200);
assert.equal((await A.call('GET', `spaces/data?id=${s1}`)).data.data, 'ciphertext-1');
ok('after losing the keys, a member can’t read or overwrite the shared copy until a new invite renews the key');

// ---- 5. banks beyond the plan (each connection costs every month) ----
const bearer = (tok) => (tok ? { Authorization: `Bearer ${tok}` } : {});
const newItem = async (connectToken) => (await (await fetch(`http://localhost:${FP}/__create_item`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectToken }) })).json()).item;
r = await C.call('POST', 'billing/checkout', { plan: 'plus', startNow: true });
assert.equal((await C.call('POST', 'billing/claim', { sessionId: new URL(r.data.url).searchParams.get('session_id') })).status, 200);
const caioLic = (await C.call('POST', 'license')).data.license;
assert.equal((await verifyES(caioLic, pub)).banks, 3);
// Ana is in the free trial: Caio's license, or one she signs herself, doesn't give her banks
r = await A.call('POST', 'of/connect-token', {}, bearer(caioLic));
assert.equal(r.status, 402); assert.equal(r.data.error, 'bank_limit'); assert.equal(r.data.reason, 'trial');
const { priv: other } = await generateLicenseKeys();
const forged = await signES({ sub: ana.login.user.id, status: 'active', plan: 'premium', banks: 6, exp: now() + 30 * 86400 }, other);
assert.equal((await A.call('POST', 'of/connect-token', {}, bearer(forged))).status, 402);
// Caio (Plus, 3 banks) uses one connect window four times: the 4th connection is removed at Pluggy at once
r = await C.call('POST', 'of/connect-token', {}, bearer(caioLic));
assert.equal(r.status, 200);
const tok = r.data.accessToken;
const hook = new URL(state.lastConnectOptions.webhookUrl);
const items = [];
for (let i = 0; i < 4; i++) items.push(await newItem(tok));
const reads = [];
for (const it of items) reads.push((await C.call('GET', `of/item?id=${it.id}`, null, bearer(caioLic))).status);
assert.deepEqual(reads, [200, 200, 200, 402]);
assert.ok(!state.items.has(items[3].id), 'the extra connection no longer exists at Pluggy');
r = await C.call('POST', 'of/connect-token', {}, bearer(caioLic));
assert.equal(r.status, 402); assert.equal(r.data.reason, 'plan'); assert.equal(r.data.limit, 3);
// a 5th made with the old window that the app never reads: Pluggy's "item created" notice is enough to remove it
const sneaky = await newItem(tok);
const res = await handle(new Request(`https://app.test/api/of/webhook${hook.search}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'item/created', itemId: sneaky.id }) }));
assert.equal(res.status, 200);
await handle.lastBackground;
assert.ok(!state.items.has(sneaky.id), 'counted (and removed) without the app');
assert.ok(items.slice(0, 3).every((it) => state.items.has(it.id)), 'the 3 covered ones stay');
ok('banks need a paid plan with room: borrowed or forged licenses and a connect window used again don’t add any');

// ---- 6. push only to real push services ----
for (const endpoint of ['http://169.254.169.254/latest/meta-data', 'https://evil.example/push', 'https://fcm.googleapis.com.evil.example/x', 'file:///etc/passwd', 'https://localhost:8080/x']) {
  r = await A.call('POST', 'push', { subscription: { endpoint, keys: { p256dh: 'x'.repeat(87), auth: 'y'.repeat(22) } }, items: [] });
  assert.equal(r.status, 400, endpoint);
}
ok('notifications can’t be pointed at internal or foreign addresses (no SSRF)');

// ---- 7. sizes and shapes ----
r = await A.call('POST', 'account/profile', JSON.stringify({ name: 'x'.repeat(30000) }));
assert.equal(r.status, 413);
r = await A.call('POST', 'account/profile', '{"name":');
assert.equal(r.status, 400);
r = await A.call('POST', 'account/profile', '{"__proto__":{"admin":true},"constructor":{"prototype":{"admin":true}},"name":"Ana"}');
assert.equal(r.status, 200);
assert.equal(({}).admin, undefined);
r = await A.call('POST', 'account/profile', { name: '<img src=x onerror=alert(1)>' });
assert.equal(r.status, 200);
assert.ok(!(await A.call('GET', 'account/session')).data.user.name.includes('<'));
await A.call('POST', 'account/profile', { name: 'Ana' });
ok('oversized, broken and booby-trapped bodies are refused or neutralised (no prototype pollution, no HTML in names)');

// ---- 8. the session cookie on the real site ----
const { authKeyOf } = await import('../src/lib/keys.js');
const L = device('mac');
r = await L.call('POST', 'auth/login', { email: 'caio@audit.com', authKey: await authKeyOf(caio.master), device: { name: 'Teste' } });
assert.equal(r.status, 200, JSON.stringify(r.data));
const sc = r.headers.get('set-cookie') || '';
assert.match(sc, /^__Host-bf_s=[\w-]+\.[\w-]+;/);
assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Path=\//);
ok('the session cookie is __Host-, HttpOnly, Secure and SameSite=Strict');

// ---- 9. client address: on Netlify only the platform's address counts ----
const { clientIp } = await import('../server/accounts.js');
const spoof = new Request('https://app.test/api/auth/login', { headers: { 'x-forwarded-for': '1.2.3.4', 'x-nf-client-connection-ip': '5.6.7.8' } });
assert.equal(clientIp(spoof, { ip: '9.9.9.9' }), '9.9.9.9');
globalThis.Netlify = {};
assert.notEqual(clientIp(spoof, {}), '1.2.3.4', 'on Netlify a forged X-Forwarded-For is ignored');
assert.notEqual(clientIp(spoof, {}), '5.6.7.8');
delete globalThis.Netlify;
ok('rate limits can’t be dodged by forging client-address headers');

console.log(`\n${passed} checks passed`);
server.close();
process.exit(0);
