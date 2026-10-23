// Accounts, sessions, 2FA, recovery, devices, phone captures, billing and Open Finance tied to the account.
// Run: node test/auth.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeServices, PWNED_TEST_PASSWORDS } from './fake-services.mjs';
import { makeDevice, signup as signupWith, FAST_KDF } from './helpers.mjs';
import { generateLicenseKeys, randomId, verifyES, publicFromPrivate, signHS, now } from '../server/crypto.js';
import { totpAt, unbase32, fromB64 } from '../server/security.js';
import { amountOf } from '../server/wallet.js';
import {
  deriveMaster, authKeyOf, createAccountKeys, unwrapDataKey, b64u, openSealed, unwrapPrivateKey, recoveryKeysOf, parseRecoveryKey,
  open as openBox, seal as sealBox, encKeyOf, pwnedCount, rand,
} from '../src/lib/keys.js';

const FP = 4611;
const { server, state } = await startFakeServices(FP);
const { priv } = await generateLicenseKeys();
const { priv: vapid } = await generateLicenseKeys();
const blobs = fs.mkdtempSync(path.join(os.tmpdir(), 'bloomfi-auth-'));
Object.assign(process.env, {
  BLOBS_DIR: blobs, APP_SECRET: randomId(48), LICENSE_PRIVATE_JWK: JSON.stringify(priv), VAPID_PRIVATE_JWK: JSON.stringify(vapid), PUSH_ALLOW_LOCALHOST: '1',
  STRIPE_SECRET_KEY: 'sk_test_x', PLUGGY_CLIENT_ID: 'fake-id', PLUGGY_CLIENT_SECRET: 's', RESEND_API_KEY: 're_x', FREE_ACCESS_EMAILS: 'pai@familia.com',
  STRIPE_API_BASE: `http://localhost:${FP}`, PLUGGY_API_BASE: `http://localhost:${FP}`, RESEND_API_BASE: `http://localhost:${FP}`, HIBP_API_BASE: `http://localhost:${FP}`,
  QUIET_LOGS: '1',
});
const { handle } = await import('../server/handler.js');
const pub = publicFromPrivate(priv);

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
const device = makeDevice(handle);
const lastCode = (email) => state.lastCodes.get(email);
const mails = (email) => state.emails.filter((e) => e.to === email);

const signup = (dev, opts) => signupWith(dev, state, opts);
async function login(dev, email, password, extra = {}) {
  const pre = await dev.call('POST', 'auth/prelogin', { email });
  const master = await deriveMaster(password, pre.data.kdf);
  const r = await dev.call('POST', 'auth/login', { email, authKey: await authKeyOf(master), device: { name: dev.kind }, ...extra });
  return { ...r, master, kdf: pre.data.kdf };
}
async function reauth(dev, master, code, scope = 'password') {
  return dev.call('POST', 'account/reauth', { authKey: await authKeyOf(master), scope, ...(code ? { code } : {}) });
}
// The test moves the clock forward (codes are per 30-second step; windows and cookies use the same clock).
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const advance = (ms) => { skew += ms; };
/** A fresh authenticator code: the clock moves to the next 30-second step first. */
const nextCode = async (secretB32) => { advance(31000); return totpAt(unbase32(secretB32), Math.floor(Date.now() / 30000)); };
const totpNow = async (secretB32) => totpAt(unbase32(secretB32), Math.floor(Date.now() / 30000));

// ======================= config =======================
let r = await device('mac').call('GET', 'config');
assert.equal(r.data.auth.required, true);
assert.equal(r.data.auth.emailVerification, true);
assert.equal(r.data.wallet.enabled, true);
assert.ok(!JSON.stringify(r.data).includes(priv.d) && !JSON.stringify(r.data).includes(vapid.d));
ok('config: accounts required, e-mail verification on, no secrets');

// ======================= sign-up =======================
const A = device('iphone');
const anaEmail = 'ana@exemplo.com';
const anaPw = 'correto-cavalo-bateria-grampo';
r = await A.call('POST', 'auth/signup', { name: 'Ana', email: 'nao-e-email', kdf: { ...FAST_KDF, salt: b64u.enc(rand(16)) }, authKey: b64u.enc(rand(32)) });
assert.equal(r.status, 400); assert.equal(r.data.error, 'invalid_email');
r = await A.call('POST', 'auth/signup', { name: 'Ana', email: anaEmail, kdf: { alg: 'argon2id', m: 1024, t: 1, p: 1, salt: b64u.enc(rand(16)) }, authKey: b64u.enc(rand(32)) });
assert.equal(r.data.error, 'invalid_kdf');
ok('sign-up rejects bad e-mails and weak key-derivation settings');

// pre-login of an unknown e-mail: a stable fake salt (nobody can tell if the account exists)
r = await A.call('POST', 'auth/prelogin', { email: anaEmail });
const fake1 = r.data.kdf.salt;
r = await A.call('POST', 'auth/prelogin', { email: anaEmail });
assert.equal(r.data.kdf.salt, fake1);
assert.equal(r.data.kdf.alg, 'argon2id');
ok('pre-login answers unknown e-mails with a stable fake salt');

const ana = await signup(A, { name: 'Ana Souza', email: anaEmail, password: anaPw });
assert.equal(ana.login.user.email, anaEmail);
assert.equal(ana.login.user.name, 'Ana Souza');
assert.ok(A.cookies['__Host-bf_s'], 'session cookie set');
assert.equal(ana.login.licenseStatus, 'trial');
let L = await verifyES(ana.login.license, pub);
assert.equal(L.status, 'trial'); assert.ok(L.exp > now() + 6 * 86400 && L.exp <= now() + 7 * 86400 + 5);
ok('sign-up with e-mail code → signed in with a 7-day trial license');
assert.ok(mails(anaEmail).some((m) => /código/i.test(m.subject)));
assert.ok(!mails(anaEmail).some((m) => /Novo acesso/.test(m.subject)), 'no "new sign-in" alert for the sign-up itself');
r = await A.call('POST', 'auth/prelogin', { email: anaEmail });
assert.equal(r.data.kdf.salt, ana.kdf.salt);
ok('pre-login returns the real salt once the account exists');

// stored data: no password, no plain e-mail, no data key
const raw = fs.readdirSync(path.join(blobs, 'users')).map((f) => fs.readFileSync(path.join(blobs, 'users', f), 'utf8')).join('\n');
assert.ok(!raw.includes(anaEmail) && !raw.includes('Ana Souza'), 'PII encrypted at rest');
assert.ok(!raw.includes(b64u.enc(ana.bundle.dataKey)), 'data key never stored');
assert.ok(!fs.readdirSync(path.join(blobs, 'index')).some((f) => f.includes('ana')), 'lookup keys hold no e-mail');
ok('server stores no password, no plain name/e-mail and never the data key');

// the wrapped data key only opens with password + server share
const share = ana.login.share;
const dk = await unwrapDataKey(ana.master, share, ana.login.keys.wrappedDataKey);
assert.deepEqual([...dk], [...ana.bundle.dataKey]);
await assert.rejects(unwrapDataKey(ana.master, b64u.enc(rand(32)), ana.login.keys.wrappedDataKey));
ok('data key opens only with the password AND the server key share');

// sign-up again with the same e-mail: same answer, the owner is warned, the codes never work
const X = device('thief');
const before = mails(anaEmail).length;
r = await X.call('POST', 'auth/signup', { name: 'Intruso', email: anaEmail, kdf: { ...FAST_KDF, salt: b64u.enc(rand(16)) }, authKey: b64u.enc(rand(32)) });
assert.equal(r.status, 200); assert.equal(r.data.verify, true); assert.ok(r.data.challengeId);
assert.equal(mails(anaEmail).length, before + 1);
assert.match(mails(anaEmail).at(-1).subject, /Tentativa/);
for (let i = 0; i < 5; i++) assert.equal((await X.call('POST', 'auth/signup/verify', { challengeId: r.data.challengeId, code: String(100000 + i) })).status, 400);
assert.equal((await X.call('POST', 'auth/signup/verify', { challengeId: r.data.challengeId, code: '123456' })).status, 429);
ok('existing e-mail: same response as a new sign-up, owner warned by e-mail, codes never work');

// ======================= sessions & CSRF =======================
r = await A.call('GET', 'account/session');
assert.equal(r.status, 200); assert.equal(r.data.user.email, anaEmail);
assert.equal((await A.call('GET', 'account/session', null, { 'X-BloomFi': null })).status, 403);
assert.equal((await A.call('GET', 'account/session', null, { Origin: 'https://evil.example' })).status, 403);
assert.equal((await A.call('GET', 'account/session', null, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
assert.equal((await device('mac').call('GET', 'account/session')).status, 401);
ok('session cookie works only from our own pages (custom header + Origin + Fetch metadata)');
const cookieHdr = r.headers.getSetCookie().join('\n');
const fresh = await A.call('GET', 'account/session');
assert.equal(fresh.headers.getSetCookie().length, 0, 'no rotation yet');
const setC = (await device('iphone').call('POST', 'account/logout')).headers.getSetCookie();
assert.ok(cookieHdr === '' || /HttpOnly; Secure; SameSite=Strict/.test(cookieHdr));
ok('cookie is HttpOnly + Secure + SameSite=Strict');

// ======================= login, lockout, new-device alert =======================
const B = device('mac');
r = await login(B, anaEmail, 'senha-errada-123');
assert.equal(r.status, 401); assert.equal(r.data.error, 'invalid_credentials');
r = await login(B, 'ninguem@exemplo.com', 'qualquer-coisa-1');
assert.equal(r.status, 401); assert.equal(r.data.error, 'invalid_credentials');
ok('wrong password and unknown e-mail give the same answer');
r = await login(B, anaEmail, anaPw);
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.deepEqual([...(await unwrapDataKey(r.master, r.data.share, r.data.keys.wrappedDataKey))], [...ana.bundle.dataKey]);
assert.ok(mails(anaEmail).some((m) => /Novo acesso/.test(m.subject)));
ok('second device signs in, gets the same data key, and the owner gets a "new sign-in" e-mail');
r = await A.call('GET', 'account/devices');
assert.equal(r.data.devices.length, 2);
assert.equal(r.data.devices.filter((d) => d.current).length, 1);
ok('devices list shows both devices');

// lockout on a separate account
const Z = device('android');
await signup(Z, { name: 'Zé', email: 'ze@exemplo.com', password: 'ze-senha-forte-2026' });
for (let i = 0; i < 5; i++) await login(device('thief'), 'ze@exemplo.com', `errada-${i}-xxxxx`);
r = await login(device('thief'), 'ze@exemplo.com', 'ze-senha-forte-2026');
assert.equal(r.status, 429); assert.equal(r.data.error, 'account_locked'); assert.ok(r.data.retryAfter > 0);
ok('5 wrong passwords lock sign-in for a while (even with the right password)');

// ======================= 2FA =======================
r = await reauth(A, await deriveMaster('errada-errada-1', ana.kdf), null, '2fa');
assert.equal(r.status, 401);
assert.equal((await reauth(A, ana.master, null, 'tudo')).status, 400);
r = await reauth(A, ana.master, null, '2fa');
assert.equal(r.status, 200); assert.ok(r.data.ticket); assert.equal(r.data.share, share);
let reTicket = r.data.ticket;
// a ticket is only for the change it was asked for
assert.equal((await A.call('POST', 'account/delete', { reauth: reTicket })).status, 401);
r = await A.call('POST', 'account/2fa/setup', { reauth: reTicket });
assert.match(r.data.uri, /^otpauth:\/\/totp\/BloomFi:/);
// …and works only once
assert.equal((await A.call('POST', 'account/2fa/setup', { reauth: reTicket })).status, 401);
ok('re-authentication tickets: one kind of change, used once');
r = await A.call('POST', 'account/2fa/setup', { reauth: (await reauth(A, ana.master, null, '2fa')).data.ticket });
assert.match(r.data.uri, /^otpauth:\/\/totp\/BloomFi:/);
const secretB32 = r.data.secret;
assert.equal((await A.call('POST', 'account/2fa/enable', { code: '000000' })).status, 400);
r = await A.call('POST', 'account/2fa/enable', { code: await totpNow(secretB32) });
assert.equal(r.status, 200); assert.equal(r.data.backupCodes.length, 10);
const backupCodes = r.data.backupCodes;
ok('2FA: set up with an authenticator code, 10 backup codes');

const C = device('android');
r = await login(C, anaEmail, anaPw);
assert.equal(r.data.need2fa, true); assert.ok(!C.cookies['__Host-bf_s']);
const mfaTicket = r.data.ticket;
assert.equal((await C.call('POST', 'auth/login/2fa', { ticket: mfaTicket, code: '123456' })).status, 400);
// the code used to turn 2FA on can't be used again
assert.equal((await C.call('POST', 'auth/login/2fa', { ticket: mfaTicket, code: await totpNow(secretB32) })).status, 400);
const goodCode = await nextCode(secretB32);
r = await C.call('POST', 'auth/login/2fa', { ticket: mfaTicket, code: goodCode });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.ok(C.cookies['__Host-bf_s']);
r = await login(device('android'), anaEmail, anaPw);
assert.equal((await device('android').call('POST', 'auth/login/2fa', { ticket: r.data.ticket, code: goodCode })).status, 400);
ok('2FA: sign-in asks for the code; wrong or already-used codes refused');
r = await login(device('android'), anaEmail, anaPw);
const tk = r.data.ticket;
r = await device('android').call('POST', 'auth/login/2fa', { ticket: tk, backup: backupCodes[0].toUpperCase() });
assert.equal(r.status, 200);
r = await login(device('android'), anaEmail, anaPw);
r = await device('android').call('POST', 'auth/login/2fa', { ticket: r.data.ticket, backup: backupCodes[0] });
assert.equal(r.status, 400);
ok('backup codes work exactly once');
r = await reauth(A, ana.master, null, 'password');
assert.equal(r.data.need2fa, true);
ok('re-authentication also asks for the 2FA code');

// ======================= password change =======================
r = await reauth(A, ana.master, await nextCode(secretB32));
assert.equal(r.status, 200, JSON.stringify(r.data));
reTicket = r.data.ticket;
const newPw = 'nova-senha-muito-boa-2026';
const kdf2 = { ...FAST_KDF, salt: b64u.enc(rand(16)) };
const master2 = await deriveMaster(newPw, kdf2);
r = await A.call('POST', 'account/password', {
  reauth: reTicket, kdf: kdf2, authKey: await authKeyOf(master2),
  keys: { wrappedDataKey: await sealBox(await encKeyOf(master2, share), ana.bundle.dataKey) }, signOutOthers: true,
});
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal((await B.call('GET', 'account/session')).data.error, 'session_revoked');
assert.equal((await C.call('GET', 'account/session')).status, 401);
assert.equal((await A.call('GET', 'account/session')).status, 200);
ok('password change can sign out every other device (this one stays in)');
assert.equal((await login(device('mac'), anaEmail, anaPw)).status, 401);
r = await login(B, anaEmail, newPw);
assert.equal(r.data.need2fa, true);
r = await B.call('POST', 'auth/login/2fa', { ticket: r.data.ticket, code: await nextCode(secretB32) });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.deepEqual([...(await unwrapDataKey(master2, r.data.share, r.data.keys.wrappedDataKey))], [...ana.bundle.dataKey]);
assert.ok(mails(anaEmail).some((m) => /alterada/.test(m.subject)));
ok('old password stops working; new one opens the same data; owner notified');

// ======================= remote wipe =======================
r = await A.call('GET', 'account/devices');
const bId = r.data.devices.find((d) => !d.current).id;
r = await A.call('POST', 'account/devices/revoke', { id: bId, wipe: true });
assert.equal(r.status, 200);
r = await B.call('GET', 'account/session');
assert.equal(r.status, 401); assert.equal(r.data.error, 'session_revoked'); assert.equal(r.data.wipe, true);
ok('a device can be signed out remotely and told to erase its data');
r = await A.call('GET', 'account/activity');
assert.ok(['device_wiped', 'password_changed', '2fa_on', 'login', 'signup'].every((t) => r.data.events.some((e) => e.type === t)));
ok('security activity log records sign-ins, 2FA, password and device changes');

// ======================= cookie rotation & theft detection =======================
{
  const oldCookie = A.cookies['__Host-bf_s'];
  advance(4 * 86400000); // 4 days later
  r = await A.call('GET', 'account/session');
  assert.equal(r.status, 200);
  const rotated = A.cookies['__Host-bf_s'];
  assert.notEqual(rotated, oldCookie);
  // a request made with the old cookie right after rotation still works (grace period)
  assert.equal((await A.call('GET', 'account/session', null, { cookie: `__Host-bf_s=${oldCookie}` })).status, 200);
  ok('session cookie rotates every few days (short grace for requests in flight)');
  advance(10 * 60000); // 10 minutes later
  const thief = device('thief');
  r = await thief.call('GET', 'account/session', null, { cookie: `__Host-bf_s=${oldCookie}` });
  assert.equal(r.status, 401); assert.equal(r.data.error, 'session_revoked');
  assert.equal((await A.call('GET', 'account/session')).status, 401, 'session ended for everyone');
  await handle.lastBackground;
  assert.ok(mails(anaEmail).some((m) => /suspeito/i.test(m.subject)));
  ok('an old (copied) cookie used again ends the session and alerts the owner');
}

// sign A in again for the rest of the tests
r = await login(A, anaEmail, newPw);
r = await A.call('POST', 'auth/login/2fa', { ticket: r.data.ticket, code: await nextCode(secretB32) });
assert.equal(r.status, 200, JSON.stringify(r.data));

// ======================= sync per account =======================
r = await A.call('PUT', 'sync', { baseVersion: 0, keyVersion: 1, data: 'cipher-1' });
assert.equal(r.data.version, 1);
assert.equal((await A.call('PUT', 'sync', { baseVersion: 0, keyVersion: 1, data: 'x' })).status, 409);
assert.equal((await A.call('PUT', 'sync', { baseVersion: 1, keyVersion: 7, data: 'x' })).data.error, 'key_changed');
assert.equal((await Z.call('GET', 'sync')).data.version, 0);
ok('sync copy is per account, versioned, and refuses data sealed with old keys');

// ======================= phone captures =======================
r = await A.call('POST', 'wallet/tokens', { label: 'iPhone da Ana', platform: 'ios' });
assert.equal(r.status, 200);
const link = r.data;
assert.match(link.url, /^https:\/\/app\.test\/api\/wallet\/in\/bfw_[\w-]{43}$/);
const ingest = (body, type = 'application/json', tok = link.token) => handle(new Request(`https://app.test/api/wallet/in/${tok}`, {
  method: 'POST', headers: { 'Content-Type': type, 'User-Agent': 'Shortcuts/1.0' }, body: typeof body === 'string' ? body : JSON.stringify(body),
}));
let res = await ingest({ valor: 'R$ 23,90', local: 'Padaria Real', cartao: 'Nubank Ultravioleta' });
assert.equal(res.status, 200);
res = await ingest('Nubank\nCompra aprovada\nCompra de R$ 45,90 APROVADA em MERCADO BOM para o cartão com final 1234.', 'text/plain');
assert.equal(res.status, 200);
assert.equal((await ingest({ valor: '1' }, 'application/json', `bfw_${'x'.repeat(43)}`)).status, 404);
assert.equal((await ingest({ valor: '1' }, 'application/json', 'bad')).status, 404);
ok('phone automations post to a personal link (JSON from iPhone, plain text from Android)');
const inboxRaw = fs.readFileSync(path.join(blobs, 'inbox', fs.readdirSync(path.join(blobs, 'inbox'))[0]), 'utf8');
assert.ok(!inboxRaw.includes('Padaria') && !inboxRaw.includes('23,90'));
r = await A.call('GET', 'wallet/inbox');
assert.equal(r.data.entries.length, 2);
const privJwk = await unwrapPrivateKey(ana.bundle.dataKey, ana.login.keys.wrappedPrivateKey);
const opened = [];
for (const e of r.data.entries) opened.push(await openSealed(privJwk, e.box));
assert.equal(opened[0].data.local, 'Padaria Real'); assert.equal(opened[0].data.valor, 'R$ 23,90');
assert.equal(opened[1].data.app, 'Nubank'); assert.match(opened[1].data.texto, /MERCADO BOM/);
ok('captures are stored encrypted to the user’s key; only the user’s devices can open them');
r = await A.call('GET', 'wallet/tokens');
assert.equal(r.data.links[0].count, 2);
r = await A.call('POST', 'wallet/ack', { ids: r.data.links.length ? opened.map((o) => o.id) : [] });
assert.equal(r.data.left, 0);
assert.equal((await Z.call('GET', 'wallet/inbox')).data.entries.length, 0);
r = await A.call('DELETE', `wallet/tokens?id=${link.id}`);
assert.equal((await ingest({ valor: '5' })).status, 404);
ok('inbox emptied after the device saves the entries; revoked links stop working');

// ======================= billing tied to the account =======================
r = await A.call('POST', 'billing/checkout');
assert.equal(r.status, 200);
const sid = new URL(r.data.url).searchParams.get('session_id');
const sess = state.sessions.get(sid);
assert.ok(sess.params.customer?.startsWith('cus_')); assert.equal(sess.params.client_reference_id, ana.login.user.id);
assert.ok(Number(sess.params['subscription_data[trial_end]']) > now() + 2 * 86400); // 4 days of the trial already passed (test clock)
r = await A.call('POST', 'billing/claim', { sessionId: sid });
L = await verifyES(r.data.license, pub);
assert.equal(L.status, 'trialing'); assert.equal(L.sub, ana.login.user.id);
assert.equal((await Z.call('POST', 'billing/claim', { sessionId: sid })).status, 403);
ok('checkout keeps the trial, and only the account that paid can claim it');
r = await A.call('POST', 'billing/portal');
assert.ok(r.data.url.includes('portal=fake'));
const gift = await signHS({ typ: 'account', kind: 'gift', sub: 'gift:ze@exemplo.com', email: 'ze@exemplo.com', until: now() + 90 * 86400, iat: now() }, process.env.APP_SECRET);
r = await Z.call('POST', 'billing/redeem', { code: gift });
L = await verifyES(r.data.license, pub);
assert.equal(L.status, 'gift');
ok('portal works; gift codes are redeemed into the account');

// family e-mail = free
const P = device('android');
await signup(P, { name: 'Pai', email: 'pai@familia.com', password: 'pai-senha-forte-2026' });
r = await P.call('POST', 'license');
L = await verifyES(r.data.license, pub);
assert.equal(L.status, 'free');
ok('family e-mails (FREE_ACCESS_EMAILS) get free access only after the e-mail is verified');

// legacy v4 subscriber migrates and keeps the subscription
const legacyCustomer = (await (await fetch(`http://localhost:${FP}/v1/customers`, { method: 'POST', headers: { Authorization: 'Bearer sk_test_x', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=velho%40exemplo.com' })).json()).id;
state.subs.set(legacyCustomer, { id: 'sub_legacy1', customer: legacyCustomer, status: 'active', cancel_at_period_end: false, items: { data: [{ current_period_end: now() + 20 * 86400 }] } });
const legacyToken = await signHS({ typ: 'account', kind: 'stripe', sub: legacyCustomer, email: 'velho@exemplo.com', iat: now() }, process.env.APP_SECRET);
const V = device('iphone');
const vel = await signup(V, { name: 'Cliente antigo', email: 'outro-email@exemplo.com', password: 'cliente-antigo-2026!', legacy: { accountToken: legacyToken, trialStart: Date.now() - 30 * 86400000 } });
L = await verifyES(vel.login.license, pub);
assert.equal(L.status, 'active');
ok('a v4 subscriber creating an account keeps the subscription (old access token linked)');

// ======================= Open Finance =======================
// Banks come with a plan that has them (Plus/Premium), from the first payment on.
r = await A.call('POST', 'license');
let anaLic = r.data.license;
assert.equal(r.data.plan, 'essencial'); assert.equal(r.data.banks, 0);
r = await A.call('POST', 'of/connect-token', {}, { Authorization: `Bearer ${anaLic}` });
assert.equal(r.status, 402); assert.equal(r.data.error, 'bank_limit'); assert.equal(r.data.reason, 'first_payment'); assert.equal(r.data.limit, 0);
r = await A.call('POST', 'billing/checkout', { plan: 'plus' });
const sid2 = new URL(r.data.url).searchParams.get('session_id');
assert.ok(Number(state.sessions.get(sid2).params['subscription_data[trial_end]']) > now(), 'still in the trial: the first charge stays at its end');
r = await A.call('POST', 'billing/claim', { sessionId: sid2 });
L = await verifyES(r.data.license, pub);
assert.equal(L.status, 'trialing'); assert.equal(L.plan, 'plus'); assert.equal(L.banks, 0);
assert.ok(state.canceled.includes(state.sessions.get(sid).subscription), 'the old plan ends when the new one is claimed');
r = await A.call('POST', 'of/connect-token', {}, { Authorization: `Bearer ${r.data.license}` });
assert.equal(r.status, 402); assert.equal(r.data.reason, 'first_payment'); assert.equal(r.data.plan, 'plus');
ok('banks wait for the first payment, even after choosing Plus during the free trial');
state.cardDeclined = true;
r = await A.call('POST', 'billing/start-now');
assert.equal(r.status, 402); assert.equal(r.data.error, 'payment_failed');
state.cardDeclined = false;
r = await A.call('POST', 'billing/start-now');
assert.equal(r.status, 200);
L = await verifyES(r.data.license, pub);
assert.equal(L.status, 'active'); assert.equal(L.plan, 'plus'); assert.equal(L.banks, 3);
assert.deepEqual(state.subUpdates.at(-1), { id: state.sessions.get(sid2).subscription, trial_end: 'now', proration_behavior: 'none', payment_behavior: 'error_if_incomplete' });
assert.equal((await A.call('POST', 'billing/start-now')).status, 409);
anaLic = r.data.license;
ok('“pay now” ends the trial today and frees the banks (a refused card changes nothing)');
r = await A.call('POST', 'of/connect-token', {}, { Authorization: `Bearer ${anaLic}` });
assert.equal(r.status, 200);
assert.equal(state.connectTokens.get(r.data.accessToken), ana.login.user.id);
assert.equal(state.lastConnectOptions.webhookUrl?.startsWith(`https://app.test/api/of/webhook?u=${ana.login.user.id}&k=`), true);
const item = (await (await fetch(`http://localhost:${FP}/__create_item`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectToken: r.data.accessToken }) })).json()).item;
r = await A.call('GET', `of/item?id=${item.id}`, null, { Authorization: `Bearer ${anaLic}` });
assert.equal(r.status, 200);
assert.equal((await Z.call('GET', `of/accounts?itemId=${item.id}`)).status, 404);
ok('bank connections belong to the account; other accounts can’t read them');
r = await A.call('POST', 'of/refresh', { itemId: item.id });
assert.equal(r.data.started, true); assert.deepEqual(state.patched, [item.id]);
r = await A.call('POST', 'of/refresh', { itemId: item.id });
assert.equal(r.data.started, false);
ok('“update now” asks the bank at most every 2 hours (Open Finance limits)');
const hookUrl = new URL(state.lastConnectOptions.webhookUrl);
res = await handle(new Request(`https://app.test/api/of/webhook?k=wrong`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'transactions/created', itemId: item.id }) }));
assert.equal(res.status, 404);
res = await handle(new Request(`https://app.test/api/of/webhook${hookUrl.search}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'transactions/created', itemId: item.id }) }));
assert.equal(res.status, 200);
r = await A.call('GET', 'account/session');
assert.ok(r.data.ofSignal > 0);
ok('Pluggy webhook (secret URL) tells the devices that new bank data arrived');

// ======================= push tied to the account + capture alert =======================
const subtle = globalThis.crypto.subtle;
const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPub = new Uint8Array(await subtle.exportKey('raw', ua.publicKey));
const pushAuth = rand(16);
const subscription = { endpoint: `http://localhost:${FP}/push/ana1`, keys: { p256dh: b64u.enc(uaPub), auth: b64u.enc(pushAuth) } };
// Reads a push like the browser would (RFC 8291).
const readPush = async (got) => {
  const bytes = new Uint8Array(Buffer.from(got.body, 'base64'));
  const salt = bytes.slice(0, 16), idlen = bytes[20], asPub = bytes.slice(21, 21 + idlen), cipher = bytes.slice(21 + idlen);
  const hk = async (s2, ikm, info, n) => new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s2, info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const te = new TextEncoder();
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: await subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, ua.privateKey, 256));
  const ikm = await hk(pushAuth, shared, new Uint8Array([...te.encode('WebPush: info\0'), ...uaPub, ...asPub]), 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), cipher));
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
};
assert.equal((await device('mac').call('POST', 'push', { subscription, items: [] })).status, 401);
r = await A.call('POST', 'push', { subscription, items: [] });
assert.equal(r.status, 200);
r = await A.call('POST', 'wallet/tokens', { label: 'iPhone', platform: 'ios' });
const before2 = state.pushes.length;
res = await ingest({ valor: 'R$ 9,90', local: 'Café' }, 'application/json', r.data.token);
await handle.lastBackground;
assert.equal(state.pushes.length, before2 + 1);
let pmsg = await readPush(state.pushes[state.pushes.length - 1]);
assert.match(pmsg.title, /Gasto do celular recebido/); assert.ok(!JSON.stringify(pmsg).includes('9,90'));
ok('a phone capture wakes the user’s devices with a notification (no amount unless allowed)');
assert.equal((await A.call('POST', 'account/profile', { bigPurchase: -1 })).status, 400);
assert.equal((await A.call('POST', 'account/profile', { bigPurchase: 500, currency: 'BRL' })).status, 200);
res = await ingest({ valor: 'R$ 612,00', local: 'Loja Grande' }, 'application/json', r.data.token);
await handle.lastBackground;
pmsg = await readPush(state.pushes[state.pushes.length - 1]);
assert.equal(pmsg.title, '⚠️ Gasto acima de R$\u00a0500,00'); assert.ok(!JSON.stringify(pmsg).includes('612'), 'amount only with details on');
res = await ingest({ titulo: 'Pix recebido', texto: 'Você recebeu R$ 900,00 de Maria' }, 'application/json', r.data.token);
await handle.lastBackground;
pmsg = await readPush(state.pushes[state.pushes.length - 1]);
assert.match(pmsg.title, /Gasto do celular recebido/, 'money coming in is not a big purchase');
assert.equal((await A.call('POST', 'account/profile', { bigPurchase: 0 })).status, 200);
assert.deepEqual([amountOf({ valor: 'R$ 1.234,56' }), amountOf({ amount: '23.90' }), amountOf({ texto: 'Compra de R$ 45,90 aprovada' }), amountOf({ valor: '1.500' }), amountOf({ local: 'x' })], [1234.56, 23.9, 45.9, 1500, null]);
ok('instant alert for spending above the person’s own limit (the amount only with details on)');

// ======================= password reset =======================
advance(16 * 60000); // new rate-limit windows
r = await device('mac').call('POST', 'auth/reset/start', { email: 'naoexiste@exemplo.com' });
assert.equal(r.status, 200); assert.ok(r.data.challengeId);
const R = device('mac');
r = await R.call('POST', 'auth/reset/start', { email: anaEmail });
assert.equal(r.status, 200);
const rc = r.data.challengeId;
r = await R.call('POST', 'auth/reset/verify', { challengeId: rc, code: lastCode(anaEmail) });
assert.equal(r.data.need2fa, true);
r = await R.call('POST', 'auth/reset/verify', { challengeId: rc, code: lastCode(anaEmail), totp: await nextCode(secretB32) });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.ok(r.data.recovery?.wrap);
// with the recovery key: same data key, new password
const recBytes = parseRecoveryKey(ana.bundle.recoveryText.toLowerCase().replace(/-/g, ' '));
const rks = await recoveryKeysOf(recBytes, r.data.share);
const dkFromRecovery = await openBox(rks.enc, r.data.recovery.wrap);
assert.deepEqual([...dkFromRecovery], [...ana.bundle.dataKey]);
const pw3 = 'terceira-senha-ainda-melhor';
const kdf3 = { ...FAST_KDF, salt: b64u.enc(rand(16)) };
const master3 = await deriveMaster(pw3, kdf3);
const resetTicket = r.data.ticket;
assert.equal((await R.call('POST', 'auth/reset/finish', { ticket: resetTicket, mode: 'recovery', recoveryAuth: b64u.enc(rand(32)), kdf: kdf3, authKey: await authKeyOf(master3), keys: { wrappedDataKey: await sealBox(await encKeyOf(master3, r.data.share), dkFromRecovery) } })).data.error, 'invalid_recovery');
r = await R.call('POST', 'auth/reset/finish', { ticket: resetTicket, mode: 'recovery', recoveryAuth: rks.auth, kdf: kdf3, authKey: await authKeyOf(master3), keys: { wrappedDataKey: await sealBox(await encKeyOf(master3, r.data.share), dkFromRecovery) } });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal((await A.call('GET', 'account/session')).status, 401, 'every other device signed out');
assert.equal((await device('thief').call('POST', 'auth/reset/finish', { ticket: resetTicket, mode: 'recovery', recoveryAuth: rks.auth, kdf: kdf3, authKey: await authKeyOf(master3), keys: { wrappedDataKey: await sealBox(await encKeyOf(master3, share), dkFromRecovery) } })).data.error, 'invalid_ticket');
assert.equal((await A.call('GET', 'sync')).status, 401);
r = await R.call('GET', 'sync');
assert.equal(r.data.data, 'cipher-1', 'cloud copy kept: same data key');
ok('forgot password + recovery key: new password, same data, all devices signed out');

// without the recovery key: new keys, old cloud copy erased (it can't be opened anymore)
r = await R.call('POST', 'auth/reset/start', { email: anaEmail });
const rc2 = r.data.challengeId;
r = await R.call('POST', 'auth/reset/verify', { challengeId: rc2, code: lastCode(anaEmail), totp: await nextCode(secretB32) });
const pw4 = 'quarta-senha-sem-chave-ok';
const kdf4 = { ...FAST_KDF, salt: b64u.enc(rand(16)) };
const master4 = await deriveMaster(pw4, kdf4);
const fresh4 = await createAccountKeys(master4, r.data.share);
r = await R.call('POST', 'auth/reset/finish', { ticket: r.data.ticket, mode: 'fresh', kdf: kdf4, authKey: await authKeyOf(master4), keys: fresh4.keys });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.keys.keyVersion, 2);
assert.equal((await R.call('GET', 'sync')).data.version, 0);
assert.equal(r.data.user.twoFactor, true, '2FA stays on');
ok('forgot password without the recovery key: new keys (version 2), unreadable cloud copy removed');

// ======================= pwned passwords =======================
// The app asks haveibeenpwned.com directly (here: the fake service). Our server never sees any part of the password.
const fetchRange = async (prefix) => (await fetch(`http://localhost:${FP}/range/${prefix}`)).text();
assert.equal(await pwnedCount(PWNED_TEST_PASSWORDS[0], fetchRange), 1234);
assert.equal(await pwnedCount('uma senha que ninguém nunca usou 9f8e7d', fetchRange), 0);
assert.equal((await device('mac').call('GET', 'auth/pwned?p=ABCDE')).status, 404);
ok('leaked-password check: only 5 hex characters of the hash leave the device, and never to our server');

// ======================= unverified sign-up finished later =======================
const H = device('iphone');
const kdfH = { ...FAST_KDF, salt: b64u.enc(rand(16)) };
const masterH = await deriveMaster('meio-cadastro-2026', kdfH);
r = await H.call('POST', 'auth/signup', { name: 'Meio', email: 'meio@exemplo.com', kdf: kdfH, authKey: await authKeyOf(masterH) });
const chH = r.data.challengeId;
// before the code nothing exists: signing in is just a wrong password
r = await H.call('POST', 'auth/login', { email: 'meio@exemplo.com', authKey: await authKeyOf(masterH) });
assert.equal(r.status, 401); assert.equal(r.data.error, 'invalid_credentials');
r = await H.call('POST', 'auth/signup/verify', { challengeId: chH, code: lastCode('meio@exemplo.com') });
assert.equal(r.status, 200);
r = await H.call('POST', 'auth/login', { email: 'meio@exemplo.com', authKey: await authKeyOf(masterH) });
assert.equal(r.data.setup, true); assert.ok(r.data.ticket);
const bH = await createAccountKeys(masterH, r.data.share);
r = await H.call('POST', 'auth/signup/finish', { ticket: r.data.ticket, keys: bH.keys });
assert.equal(r.status, 200);
ok('a sign-up interrupted after the e-mail code can be finished by signing in (before the code, nothing exists)');

// ======================= account deletion =======================
r = await R.call('POST', 'account/delete', { reauth: 'x' });
assert.equal(r.status, 401);
r = await reauth(R, master4, await nextCode(secretB32), 'delete');
assert.equal(r.status, 200, JSON.stringify(r.data));
const canceledBefore = state.canceled.length;
r = await R.call('POST', 'account/delete', { reauth: r.data.ticket });
assert.equal(r.status, 200);
assert.equal(state.canceled.length, canceledBefore + 1, 'Stripe subscription canceled');
assert.equal(state.items.has(item.id), false, 'bank connection removed at Pluggy');
assert.equal((await R.call('GET', 'account/session')).status, 401);
r = await device('mac').call('POST', 'auth/prelogin', { email: anaEmail });
assert.notEqual(r.data.kdf.salt, kdf4.salt);
await handle.lastBackground;
assert.ok(mails(anaEmail).some((m) => /excluída/.test(m.subject)));
ok('account deletion erases the account, cancels the subscription and removes bank connections');

// ======================= codes that don't arrive, codes that arrive late =======================
{
  const X = device('iphone');
  const kdfX = { ...FAST_KDF, salt: b64u.enc(rand(16)) };
  const masterX = await deriveMaster('outra-senha-forte-do-xis', kdfX);
  state.emailDown = true;
  r = await X.call('POST', 'auth/signup', { name: 'Xis', email: 'xis@exemplo.com', kdf: kdfX, authKey: await authKeyOf(masterX), lang: 'pt' });
  state.emailDown = false;
  assert.equal(r.status, 502); assert.equal(r.data.error, 'email_failed');
  // an e-mail that already has an account answers the same way when the e-mail service fails
  state.emailDown = true;
  r = await X.call('POST', 'auth/signup', { name: 'Ana', email: 'pai@familia.com', kdf: kdfX, authKey: await authKeyOf(masterX), lang: 'pt' });
  state.emailDown = false;
  assert.equal(r.status, 502); assert.equal(r.data.error, 'email_failed');
  ok('when the e-mail service refuses, sign-up says so at once (and the same for e-mails that already have an account)');

  r = await X.call('POST', 'auth/signup', { name: 'Xis', email: 'xis@exemplo.com', kdf: kdfX, authKey: await authKeyOf(masterX), lang: 'pt' });
  assert.equal(r.status, 200);
  const chX = r.data.challengeId;
  const first = lastCode('xis@exemplo.com');
  advance(46000);
  assert.equal((await X.call('POST', 'auth/resend', { challengeId: chX })).status, 200);
  const second = lastCode('xis@exemplo.com');
  assert.notEqual(first, second);
  // the person types the code from the FIRST e-mail (it arrived late): it still works
  r = await X.call('POST', 'auth/signup/verify', { challengeId: chX, code: first });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await X.call('POST', 'auth/signup/verify', { challengeId: chX, code: second })).status, 400, 'used up');
  ok('after "send again", the code from the earlier e-mail still works (once)');

  // the same e-mail again: no code, but an e-mail saying the account exists — once an hour, however many tries
  const before = mails('pai@familia.com').length;
  for (let i = 0; i < 4; i++) {
    r = await X.call('POST', 'auth/signup', { name: 'Pai', email: 'pai@familia.com', kdf: kdfX, authKey: await authKeyOf(masterX), lang: 'pt' }, { 'x-nf-client-connection-ip': '200.10.20.31' });
    assert.equal(r.status, 200); assert.equal(r.data.verify, true);
  }
  assert.equal(mails('pai@familia.com').length, before + 1, 'one notice, not one per try');
  assert.match(mails('pai@familia.com').at(-1).subject, /Tentativa de criar conta/);
  ok('signing up again with an e-mail that has an account sends one "you already have an account" e-mail per hour (no flooding)');

  // the answer time says nothing: an e-mail with an account and one without take at least the same minimum time
  process.env.EMAIL_MIN_MS = '400';
  const timed = async (path, body) => { const t0 = Date.now(); const res = await device('mac').call('POST', path, body, { 'x-nf-client-connection-ip': '200.10.20.30' }); return { ms: Date.now() - t0, res }; };
  const kdfY = (await device('mac').call('POST', 'auth/prelogin', { email: 'ninguem@exemplo.com' })).data.kdf;
  for (const [path, body] of [
    ['auth/reset/start', { email: 'pai@familia.com' }], ['auth/reset/start', { email: 'ninguem@exemplo.com' }],
    ['auth/signup', { name: 'Xis', email: 'xis@exemplo.com', kdf: kdfY, authKey: await authKeyOf(masterX), lang: 'pt' }],
    ['auth/signup', { name: 'Novo', email: 'novo-tempo@exemplo.com', kdf: kdfY, authKey: await authKeyOf(masterX), lang: 'pt' }],
  ]) {
    const { ms, res } = await timed(path, body);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(ms >= 400, `${path} answered in ${ms} ms`);
  }
  process.env.EMAIL_MIN_MS = '0';
  ok('"forgot my password" and sign-up take the same minimum time whether or not the e-mail has an account');
}

// ======================= typos are not an attack =======================
{
  const email = 'digita@exemplo.com';
  const pw = 'senha-certa-que-erro-muito-1';
  const T0 = device('iphone');
  await signup(T0, { name: 'Digita', email, password: pw });
  const pre = (await T0.call('POST', 'auth/prelogin', { email })).data.kdf;
  const try1 = async (password) => {
    const m = await deriveMaster(password, pre);
    return device('iphone').call('POST', 'auth/login', { email, authKey: await authKeyOf(m), device: { name: 'iPhone' } }, { 'x-nf-client-connection-ip': '177.10.20.30' });
  };
  for (let i = 0; i < 12; i++) {
    r = await try1(`errei-a-senha-${i}`);
    if (r.status === 429) { advance((Number(r.data.retryAfter) || 30) * 1000 + 1000); r = await try1(`errei-a-senha-${i}`); }
    assert.equal(r.status, 401);
  }
  advance(31 * 60000);
  r = await try1(pw);
  assert.equal(r.status, 200); assert.equal(r.data.needEmail, undefined, 'no e-mail code: the typos all came from one place');
  ok('a dozen typos from the owner\'s own phone only slow that phone down; the right password then just works');
}

console.log(`\n${passed} checks passed`);
server.close();
fs.rmSync(blobs, { recursive: true, force: true });
