// Attacks found in the independent security review, each one tried for real against the server.
// Run: node test/security.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeServices } from './fake-services.mjs';
import { makeDevice, signup as signupWith, FAST_KDF } from './helpers.mjs';
import { generateLicenseKeys, randomId, signHS, now } from '../server/crypto.js';
import { totpAt, unbase32 } from '../server/security.js';
import { getKV } from '../server/storage.js';
import { deriveMaster, authKeyOf, createAccountKeys, b64u, rand } from '../src/lib/keys.js';

const FP = 4613;
const { state } = await startFakeServices(FP);
const { priv } = await generateLicenseKeys();
const { priv: vapid } = await generateLicenseKeys();
const blobs = fs.mkdtempSync(path.join(os.tmpdir(), 'bloomfi-sec-'));
Object.assign(process.env, {
  BLOBS_DIR: blobs, APP_SECRET: randomId(48), LICENSE_PRIVATE_JWK: JSON.stringify(priv), VAPID_PRIVATE_JWK: JSON.stringify(vapid), PUSH_ALLOW_LOCALHOST: '1',
  STRIPE_SECRET_KEY: 'sk_test_x', PLUGGY_CLIENT_ID: 'fake-id', PLUGGY_CLIENT_SECRET: 's', RESEND_API_KEY: 're_x',
  FREE_ACCESS_EMAILS: 'ze@exemplo.com,caio@exemplo.com', // (free access = the top plan, so both can connect banks)
  STRIPE_API_BASE: `http://localhost:${FP}`, PLUGGY_API_BASE: `http://localhost:${FP}`, RESEND_API_BASE: `http://localhost:${FP}`,
  QUIET_LOGS: '1',
});
const { handle } = await import('../server/handler.js');

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
const device = makeDevice(handle);
const lastCode = (email) => state.lastCodes.get(email);
const mails = (email) => state.emails.filter((e) => e.to === email);
const signup = (dev, opts) => signupWith(dev, state, opts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const advance = (ms) => { skew += ms; };
const nextCode = async (secretB32) => { advance(31000); return totpAt(unbase32(secretB32), Math.floor(Date.now() / 30000)); };
const net = (n) => ({ 'x-nf-client-connection-ip': `203.0.113.${n}` });

async function login(dev, email, password, extra = {}) {
  const pre = await dev.call('POST', 'auth/prelogin', { email }, extra);
  const master = await deriveMaster(password, pre.data.kdf);
  const r = await dev.call('POST', 'auth/login', { email, authKey: await authKeyOf(master), device: { name: dev.kind } }, extra);
  return { ...r, master, kdf: pre.data.kdf };
}
const reauth = async (dev, master, scope, code) => dev.call('POST', 'account/reauth', { authKey: await authKeyOf(master), scope, ...(code ? { code } : {}) });
/** Storage as slow as Netlify Blobs over the network: concurrent requests really interleave. */
async function slowStore(name, ms = 150) {
  const s = await getKV(name);
  const { getVersioned, setVersioned } = s;
  s.getVersioned = async (k) => { const r = await getVersioned.call(s, k); await sleep(ms); return r; };
  s.setVersioned = async (...a) => { await sleep(ms / 3); return setVersioned.apply(s, a); };
  return () => { Object.assign(s, { getVersioned, setVersioned }); };
}

// ======================= sign-up can't be hijacked =======================
{
  const email = 'nova@exemplo.com';
  const V = device('iphone');
  const X = device('thief');
  const kdfV = { ...FAST_KDF, salt: b64u.enc(rand(16)) };
  const masterV = await deriveMaster('senha-da-dona-verdadeira', kdfV);
  let r = await V.call('POST', 'auth/signup', { name: 'Dona', email, kdf: kdfV, authKey: await authKeyOf(masterV) });
  const chV = r.data.challengeId;
  const codeV = lastCode(email);
  // the attacker signs up again with the same e-mail before she types the code
  const kdfX = { ...FAST_KDF, salt: b64u.enc(rand(16)) };
  const masterX = await deriveMaster('senha-do-intruso-123', kdfX);
  r = await X.call('POST', 'auth/signup', { name: 'Intruso', email, kdf: kdfX, authKey: await authKeyOf(masterX) });
  assert.equal(r.status, 200);
  assert.equal((await X.call('POST', 'auth/signup/verify', { challengeId: r.data.challengeId, code: codeV })).status, 400, 'her code does not open his sign-up');
  r = await V.call('POST', 'auth/signup/verify', { challengeId: chV, code: codeV });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const bundle = await createAccountKeys(masterV, r.data.share);
  r = await V.call('POST', 'auth/signup/finish', { ticket: r.data.ticket, keys: bundle.keys });
  assert.equal(r.status, 200);
  assert.equal((await login(device('thief'), email, 'senha-do-intruso-123')).status, 401, 'his password never worked');
  assert.equal((await login(device('mac'), email, 'senha-da-dona-verdadeira')).status, 200);
  ok('signing up again with someone’s e-mail before they confirm it can’t take the account over');
}

// ======================= one-time codes really are one-time =======================
const ana = { email: 'ana@exemplo.com', pw: 'correto-cavalo-bateria-grampo' };
const A = device('iphone');
const anaAcc = await signup(A, { name: 'Ana', email: ana.email, password: ana.pw });
let r = await reauth(A, anaAcc.master, '2fa');
r = await A.call('POST', 'account/2fa/setup', { reauth: r.data.ticket });
const secret = r.data.secret;
r = await A.call('POST', 'account/2fa/enable', { code: await nextCode(secret) });
const backup = r.data.backupCodes;
{
  const tickets = [];
  for (let i = 0; i < 5; i++) tickets.push((await login(device('android'), ana.email, ana.pw)).data.ticket);
  const restore = await slowStore('users');
  const res = await Promise.all(tickets.map((t) => device('android').call('POST', 'auth/login/2fa', { ticket: t, backup: backup[0] })));
  restore();
  assert.equal(res.filter((x) => x.status === 200).length, 1, res.map((x) => x.status).join(','));
  ok('one backup code sent five times at once opens exactly one session');
}
advance(16 * 60000);
{
  const tickets = [];
  for (let i = 0; i < 4; i++) tickets.push((await login(device('android'), ana.email, ana.pw)).data.ticket);
  const code = await nextCode(secret);
  const restore = await slowStore('users');
  const res = await Promise.all(tickets.map((t) => device('android').call('POST', 'auth/login/2fa', { ticket: t, code })));
  restore();
  assert.equal(res.filter((x) => x.status === 200).length, 1, res.map((x) => x.status).join(','));
  ok('one authenticator code sent four times at once opens exactly one session');
}

// ======================= e-mail code guesses are counted atomically =======================
{
  const email = 'chute@exemplo.com';
  const kdf = { ...FAST_KDF, salt: b64u.enc(rand(16)) };
  const G = device('mac');
  r = await G.call('POST', 'auth/signup', { name: 'Chute', email, kdf, authKey: await authKeyOf(await deriveMaster('qualquer-senha-boa-1', kdf)) });
  const ch = r.data.challengeId;
  const right = lastCode(email);
  const wrong = (i) => String((Number(right) + 1 + i) % 1000000).padStart(6, '0');
  const restore = await slowStore('auth');
  const res = await Promise.all(Array.from({ length: 30 }, (_, i) => device(`x${i}`).call('POST', 'auth/signup/verify', { challengeId: ch, code: wrong(i) }, net(i + 1))));
  restore();
  const checked = res.filter((x) => x.data.error === 'invalid_code').length;
  assert.ok(checked <= 5, `${checked} guesses were checked`);
  assert.equal((await G.call('POST', 'auth/signup/verify', { challengeId: ch, code: right })).status, 429, 'the real code is refused after the limit');
  ok(`30 guesses at once from 30 places: only ${checked} checked (limit 5), then the code is dead`);
}

// ======================= no hints about which e-mails have accounts =======================
advance(61 * 60000);
{
  // a resend gives a fake challenge (no account) the same fresh tries as a real one
  const real = await device('mac').call('POST', 'auth/reset/start', { email: ana.email });
  const fake = await device('mac').call('POST', 'auth/reset/start', { email: 'ninguem-aqui@exemplo.com' });
  for (const c of [real.data.challengeId, fake.data.challengeId]) {
    for (let i = 0; i < 5; i++) await device('mac').call('POST', 'auth/reset/verify', { challengeId: c, code: '000001' });
  }
  const locked = await Promise.all([real, fake].map((x) => device('mac').call('POST', 'auth/reset/verify', { challengeId: x.data.challengeId, code: '000001' })));
  assert.deepEqual(locked.map((x) => x.status), [429, 429]);
  advance(46000);
  for (const x of [real, fake]) assert.equal((await device('mac').call('POST', 'auth/resend', { challengeId: x.data.challengeId })).status, 200);
  const after = await Promise.all([real, fake].map((x) => device('mac').call('POST', 'auth/reset/verify', { challengeId: x.data.challengeId, code: '000001' })));
  assert.deepEqual(after.map((x) => [x.status, x.data.error]), [[400, 'invalid_code'], [400, 'invalid_code']]);
  ok('codes for e-mails with and without an account behave the same, even after a resend');
}
{
  const Z = device('android');
  await signup(Z, { name: 'Zé', email: 'ze@exemplo.com', password: 'ze-senha-forte-2026' });
  const tk = async () => (await reauth(A, anaAcc.master, 'email', await nextCode(secret))).data.ticket;
  const taken = await A.call('POST', 'account/email', { reauth: await tk(), email: 'ze@exemplo.com' });
  const free = await A.call('POST', 'account/email', { reauth: await tk(), email: 'livre@exemplo.com' });
  assert.equal(taken.status, 200); assert.equal(free.status, 200);
  assert.deepEqual(Object.keys(taken.data).sort(), Object.keys(free.data).sort());
  assert.ok(mails('ze@exemplo.com').some((m) => /Tentativa de usar/.test(m.subject)), 'the owner of the address is told');
  assert.ok(mails('livre@exemplo.com').some((m) => /\d{6}/.test(m.subject)));
  // the e-mail change goes through and the OLD address is told
  r = await A.call('POST', 'account/email/verify', { challengeId: free.data.challengeId, code: lastCode('livre@exemplo.com') });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(mails(ana.email).some((m) => /e-mail da sua conta BloomFi foi trocado/i.test(m.subject)));
  ana.email = 'livre@exemplo.com';
  ok('changing to an e-mail that has an account looks like any other; the old address is told about a change');
}

// ======================= online, e-mail is required =======================
{
  const saved = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  r = await device('mac').call('POST', 'auth/signup', { name: 'Sem', email: 'sem-email@exemplo.com', kdf: { ...FAST_KDF, salt: b64u.enc(rand(16)) }, authKey: b64u.enc(rand(32)) });
  assert.equal(r.status, 503); assert.equal(r.data.error, 'email_not_configured');
  process.env.RESEND_API_KEY = saved;
  ok('without an e-mail service the server refuses sign-ups (no account is ever trusted unconfirmed)');
}

// ======================= access codes belong to one person =======================
{
  const gift = await signHS({ typ: 'account', kind: 'gift', sub: 'gift:pai@familia.com', email: 'pai@familia.com', until: now() + 90 * 86400, iat: now() }, process.env.APP_SECRET);
  r = await A.call('POST', 'billing/redeem', { code: gift });
  assert.equal(r.status, 403); assert.equal(r.data.error, 'code_other_email');
  const P = device('android');
  await signup(P, { name: 'Pai', email: 'pai@familia.com', password: 'pai-senha-forte-2026' });
  assert.equal((await P.call('POST', 'billing/redeem', { code: gift })).status, 200);
  const old = await signHS({ typ: 'account', kind: 'stripe', sub: 'cus_antigo123', email: 'x@exemplo.com', iat: now() }, process.env.APP_SECRET);
  assert.equal((await P.call('POST', 'billing/redeem', { code: old })).status, 200);
  assert.equal((await P.call('POST', 'billing/redeem', { code: old })).status, 200, 'same account again is fine');
  r = await A.call('POST', 'billing/redeem', { code: old });
  assert.equal(r.status, 409); assert.equal(r.data.error, 'code_used');
  ok('a gift code works only for its own e-mail, and each code for one account only');
}

// ======================= no login CSRF, no cross-site logout =======================
{
  const M = device('mac');
  const kdf = (await M.call('POST', 'auth/prelogin', { email: ana.email })).data.kdf;
  const authKey = await authKeyOf(await deriveMaster(ana.pw, kdf));
  assert.equal((await M.call('POST', 'auth/login', { email: ana.email, authKey }, { 'X-BloomFi': null })).status, 403);
  assert.equal((await M.call('POST', 'auth/login', { email: ana.email, authKey }, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await M.call('POST', 'auth/login', JSON.stringify({ email: ana.email, authKey }), { 'Content-Type': 'text/plain' })).status, 415);
  assert.ok(!M.cookies['__Host-bf_s']);
  r = await A.call('POST', 'account/logout', null, { 'X-BloomFi': null, Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(r.status, 403);
  assert.equal((await A.call('GET', 'account/session')).status, 200, 'still signed in');
  ok('sign-in and sign-out only answer our own pages (no login CSRF, no forced logout)');
}

// ======================= wrong passwords: per place, then an e-mail code =======================
{
  const email = 'trava@exemplo.com';
  const pw = 'senha-certa-da-trava-1';
  await signup(device('iphone'), { name: 'Trava', email, password: pw });
  for (let i = 0; i < 5; i++) await login(device('thief'), email, `errada-${i}-xyz`, net(50));
  assert.equal((await login(device('thief'), email, pw, net(50))).status, 429, 'the guessing network is slowed down');
  r = await login(device('mac'), email, pw, net(60));
  assert.equal(r.status, 200, 'the owner, elsewhere, still gets in');
  for (let i = 0; i < 5; i++) await login(device('thief'), email, `outra-${i}-xyz`, net(70 + i));
  const D = device('android');
  r = await login(D, email, pw, net(90));
  assert.equal(r.status, 200); assert.equal(r.data.needEmail, true, 'many failures from many places: a code by e-mail too');
  assert.ok(!D.cookies['__Host-bf_s']);
  const t = r.data.ticket;
  const ch = r.data.challengeId;
  assert.equal((await D.call('POST', 'auth/login/email', { ticket: t, challengeId: ch, code: '000000' }, net(90))).status, 400);
  r = await D.call('POST', 'auth/login/email', { ticket: t, challengeId: ch, code: lastCode(email), device: { name: 'Android' } }, net(90));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(D.cookies['__Host-bf_s']);
  ok('wrong passwords lock only the place guessing; an account under attack also asks for an e-mail code');

  // under attack, a wrong password gets exactly the same kind of answer (no hint that the password was right)
  const mailsBefore = mails(email).length;
  const W = device('thief');
  const wrongPw = await login(W, email, 'chute-errado-qualquer', net(120));
  const right = await login(device('mac'), email, pw, net(121));
  assert.equal(wrongPw.status, 200); assert.equal(right.status, 200);
  assert.deepEqual(Object.keys(wrongPw.data).sort(), Object.keys(right.data).sort());
  assert.equal(wrongPw.data.needEmail, true);
  assert.equal(mails(email).length, mailsBefore + 1, 'only the right password really sends a code');
  for (const code of [lastCode(email), '000000']) {
    assert.equal((await W.call('POST', 'auth/login/email', { ticket: wrongPw.data.ticket, challengeId: wrongPw.data.challengeId, code }, net(120))).status, 400);
  }
  const nobody = await login(device('thief'), 'ninguem-mesmo@exemplo.com', 'qualquer-senha-123', net(122));
  assert.equal(nobody.status, 401, 'e-mails without failures behave normally');
  ok('under attack, right and wrong passwords get the same answer (only the right one gets a real code)');

  // re-authentication on a stolen, unlocked device: slow, and too many failures sign it out
  const wrong = await deriveMaster('nao-e-a-senha-1', (await D.call('POST', 'auth/prelogin', { email })).data.kdf);
  let last;
  for (let i = 0; i < 10; i++) {
    if (i && i % 5 === 0) advance(16 * 60000);
    last = await reauth(D, wrong, 'password');
  }
  assert.equal(last.status, 401); assert.equal(last.data.error, 'session_revoked');
  assert.equal((await D.call('GET', 'account/session')).status, 401);
  ok('ten wrong passwords on a signed-in device sign that device out');
}

// ======================= sessions under concurrency =======================
{
  advance(4 * 86400000);
  const restore = await slowStore('sessions');
  const res = await Promise.all([1, 2, 3].map(() => A.call('GET', 'account/session')));
  restore();
  assert.ok(res.every((x) => x.status === 200));
  assert.equal(res.filter((x) => x.headers.getSetCookie().length).length, 1, 'the cookie rotates once');
  assert.equal((await A.call('GET', 'account/session')).status, 200, 'and the device stays signed in');
  ok('three requests at the moment the cookie rotates: it rotates once and nobody is signed out');
}

// ======================= what dies with a device or a reset =======================
{
  const subtle = globalThis.crypto.subtle;
  const k = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await subtle.exportKey('raw', k.publicKey));
  const mk = (n) => ({ endpoint: `http://localhost:${FP}/push/sec${n}`, keys: { p256dh: b64u.enc(raw), auth: b64u.enc(rand(16)) } });
  // a second device of Ana with notifications on
  const B = device('mac');
  r = await login(B, ana.email, ana.pw);
  r = await B.call('POST', 'auth/login/2fa', { ticket: r.data.ticket, code: await nextCode(secret) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await B.call('POST', 'push', { subscription: mk(2), items: [] })).status, 200);
  assert.equal((await A.call('POST', 'push', { subscription: mk(1), items: [] })).status, 200);
  const pushStore = await getKV('push');
  assert.equal((await pushStore.keys()).length >= 2, true);
  const bId = (await A.call('GET', 'account/devices')).data.devices.find((d) => !d.current).id;
  await A.call('POST', 'account/devices/revoke', { id: bId, wipe: true });
  const left = [];
  for (const key of await pushStore.keys()) left.push((await pushStore.get(key))?.sub?.endpoint);
  assert.ok(!left.some((e) => e?.endsWith('/sec2')), 'the wiped phone gets no more notifications');
  assert.ok(left.some((e) => e?.endsWith('/sec1')));
  ok('a device signed out remotely stops getting notifications');

  // a reset without the recovery key: the phone links of the old keys stop
  r = await A.call('POST', 'wallet/tokens', { label: 'iPhone', platform: 'ios' });
  const token = r.data.token;
  const ingest = () => handle(new Request(`https://app.test/api/wallet/in/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ valor: 'R$ 1,00', local: 'Teste' }) }));
  assert.equal((await ingest()).status, 200);
  const R = device('mac');
  r = await R.call('POST', 'auth/reset/start', { email: ana.email });
  r = await R.call('POST', 'auth/reset/verify', { challengeId: r.data.challengeId, code: lastCode(ana.email), totp: await nextCode(secret) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const kdf = { ...FAST_KDF, salt: b64u.enc(rand(16)) };
  const master = await deriveMaster('senha-nova-sem-chave-9', kdf);
  const fresh = await createAccountKeys(master, r.data.share);
  r = await R.call('POST', 'auth/reset/finish', { ticket: r.data.ticket, mode: 'fresh', kdf, authKey: await authKeyOf(master), keys: fresh.keys });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await ingest()).status, 404);
  ok('a reset without the recovery key stops the old phone links (new captures can’t go to the new keys)');
}

// ======================= billing and bank webhooks =======================
{
  const C = device('iphone');
  await signup(C, { name: 'Caio', email: 'caio@exemplo.com', password: 'caio-senha-forte-2026' });
  state.sessions.set('cs_test_semreferencia1', { id: 'cs_test_semreferencia1', status: 'complete', customer: 'cus_alheio123', client_reference_id: null });
  r = await C.call('POST', 'billing/claim', { sessionId: 'cs_test_semreferencia1' });
  assert.equal(r.status, 403);
  ok('a checkout can only be claimed by the account that started it');

  // Zé connects a bank; Caio's own webhook address can't poke Zé's account
  const Z = device('android');
  r = await login(Z, 'ze@exemplo.com', 'ze-senha-forte-2026');
  const zLic = (await Z.call('POST', 'license')).data.license;
  r = await Z.call('POST', 'of/connect-token', {}, { Authorization: `Bearer ${zLic}` });
  const item = (await (await fetch(`http://localhost:${FP}/__create_item`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectToken: r.data.accessToken }) })).json()).item;
  await Z.call('GET', `of/item?id=${item.id}`, null, { Authorization: `Bearer ${zLic}` });
  const before = (await Z.call('GET', 'account/session')).data.ofSignal;
  const cLic = (await C.call('POST', 'license')).data.license;
  await C.call('POST', 'of/connect-token', {}, { Authorization: `Bearer ${cLic}` });
  const caioHook = new URL(state.lastConnectOptions.webhookUrl);
  const poke = (search, body) => handle(new Request(`https://app.test/api/of/webhook${search}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  assert.equal((await poke(caioHook.search, { event: 'transactions/created', itemId: item.id })).status, 200);
  assert.equal((await poke(caioHook.search, { event: 'transactions/created', itemId: 'item-desconhecido-1', clientUserId: (await Z.call('GET', 'account/session')).data.user.id })).status, 200);
  assert.equal((await Z.call('GET', 'account/session')).data.ofSignal, before, 'nothing reached Zé');
  ok('each account has its own bank-webhook secret; it can’t be used to poke other accounts');
}

// ======================= the PIN is checked by the server =======================
{
  advance(16 * 60000);
  const P = device('iphone');
  await signup(P, { name: 'Pina', email: 'pina@exemplo.com', password: 'pina-senha-forte-2026' });
  const O = device('android');
  await signup(O, { name: 'Outra', email: 'outra@exemplo.com', password: 'outra-senha-forte-2026' });
  const proof = b64u.enc(rand(32));
  r = await P.call('POST', 'account/pin', { proof });
  assert.equal(r.status, 200);
  const { id, pepper } = r.data;
  assert.equal(b64u.dec(pepper).length, 32);
  r = await P.call('POST', 'account/pin/unlock', { id, proof });
  assert.equal(r.status, 200); assert.equal(r.data.pepper, pepper);
  assert.equal((await device('mac').call('POST', 'account/pin/unlock', { id, proof })).status, 401, 'needs a signed-in device');
  assert.equal((await O.call('POST', 'account/pin/unlock', { id, proof })).status, 404, 'another account gets nothing');
  const stored = JSON.stringify(await (await getKV('auth')).get(`pin:${id}`));
  assert.ok(!stored.includes(pepper) && !stored.includes(proof), 'the server keeps the PIN secret sealed and only a hash of the proof');
  ok('the PIN secret comes back only to the account’s own signed-in device, with the right PIN');
  {
    // a PIN that is no longer in the account's list doesn't open anything
    const p2 = b64u.enc(rand(32));
    const extra = (await P.call('POST', 'account/pin', { proof: p2 })).data;
    assert.equal((await P.call('POST', 'account/pin/unlock', { id: extra.id, proof: p2 })).status, 200);
    assert.equal((await P.call('POST', 'account/pin/remove', { id: extra.id })).status, 200);
    assert.equal((await P.call('POST', 'account/pin/unlock', { id: extra.id, proof: p2 })).status, 404);
    ok('a removed PIN stops working at once');
  }
  // many wrong tries at once: each one that gets through is counted (the rest are turned away), never lost
  const restore = await slowStore('auth');
  const res = await Promise.all(Array.from({ length: 10 }, () => P.call('POST', 'account/pin/unlock', { id, proof: b64u.enc(rand(32)) })));
  restore();
  assert.ok(res.every((x) => x.status === 400 || x.status === 429 || x.status === 423), res.map((x) => x.status).join(','));
  let counted = res.filter((x) => x.data.error === 'wrong_pin').length;
  const lefts = res.filter((x) => x.data.error === 'wrong_pin').map((x) => x.data.attemptsLeft).sort((a, b) => a - b);
  assert.deepEqual(lefts, Array.from({ length: counted }, (_, i) => 10 - counted + i), 'every counted try took one away');
  let last = null;
  while (counted < 10) {
    advance(16 * 60000);
    last = await P.call('POST', 'account/pin/unlock', { id, proof: b64u.enc(rand(32)) });
    counted++;
  }
  if (last) assert.equal(last.status, 423, 'the 10th wrong PIN erases it');
  advance(16 * 60000);
  r = await P.call('POST', 'account/pin/unlock', { id, proof });
  assert.ok([404, 423].includes(r.status), `right PIN after 10 wrong ones: ${r.status}`);
  ok('10 wrong PINs, even sent at once, erase the PIN for good (only the password opens the device then)');
}

// ======================= someone else's guesses never block the owner's code =======================
{
  advance(7 * 3600000);
  const email = 'dani@exemplo.com';
  await signup(device('iphone'), { name: 'Dani', email, password: 'dani-senha-forte-2026' });
  const X = device('thief');
  let x = await X.call('POST', 'auth/reset/start', { email }, net(200));
  for (let i = 0; i < 4; i++) {
    if (i) { advance(46000); await X.call('POST', 'auth/resend', { challengeId: x.data.challengeId }, net(200)); }
    for (let j = 0; j < 5; j++) await X.call('POST', 'auth/reset/verify', { challengeId: x.data.challengeId, code: String(111111 + j) }, net(200));
  }
  r = await X.call('POST', 'auth/reset/verify', { challengeId: x.data.challengeId, code: '123123' }, net(200));
  assert.equal(r.status, 429, 'the guessing network is stopped');
  const O = device('mac');
  r = await O.call('POST', 'auth/reset/start', { email }, net(201));
  r = await O.call('POST', 'auth/reset/verify', { challengeId: r.data.challengeId, code: lastCode(email) }, net(201));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  ok('someone guessing reset codes for an e-mail can’t block the owner’s own code');

  // two requests with the same right code at the same time: one reset ticket only
  advance(16 * 60000);
  r = await O.call('POST', 'auth/reset/start', { email }, net(202));
  const chId = r.data.challengeId;
  const code = lastCode(email);
  const restore = await slowStore('auth');
  const both = await Promise.all([1, 2].map(() => device('mac').call('POST', 'auth/reset/verify', { challengeId: chId, code }, net(202))));
  restore();
  assert.equal(both.filter((x) => x.status === 200 && x.data.ticket).length, 1, both.map((x) => x.status).join(','));
  ok('one code used twice at the same moment gives one reset ticket');
}

{
  const { netOf } = await import('../server/accounts.js');
  assert.equal(netOf('2001:db8::1:2:3:4'), netOf('2001:db8::5:6:7:8'));
  assert.equal(netOf('2001:db8::9'), netOf('2001:0db8:0000:0000:1111:2222:3333:4444'));
  assert.notEqual(netOf('2001:db8:0:1::9'), netOf('2001:db8:0:2::9'));
  assert.equal(netOf('::ffff:203.0.113.7'), '203.0.113.7');
  ok('IPv6 addresses are grouped by their real /64, however they are written');
}

console.log(`\n${passed} checks passed`);
process.exit(0);
