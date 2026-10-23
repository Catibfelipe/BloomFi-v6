// Shared spaces on the server: create, invite by link (secret never sent), approve, shared encrypted data,
// leaving/removing, each person keeping their own plan, and what happens when accounts change. Run: node test/spaces.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeServices } from './fake-services.mjs';
import { makeDevice, signup } from './helpers.mjs';
import { generateLicenseKeys, randomId, verifyES, publicFromPrivate } from '../server/crypto.js';
import {
  newSpaceId, newSpaceKey, memberWrapKey, wrapSpaceKey, unwrapSpaceKey, sealSpaceMeta, openSpaceMeta, makeInvite, parseInvite,
  inviteProof, openInviteBox, spaceSyncKey,
} from '../src/lib/spaces.js';
import { sealSnapshot, openSnapshot } from '../src/lib/sync.js';
import { b64u } from '../src/lib/keys.js';

const FP = 4596;
const { server, state } = await startFakeServices(FP);
const { priv } = await generateLicenseKeys();
const blobs = fs.mkdtempSync(path.join(os.tmpdir(), 'bloomfi-spaces-'));
Object.assign(process.env, {
  BLOBS_DIR: blobs, APP_SECRET: randomId(48), LICENSE_PRIVATE_JWK: JSON.stringify(priv),
  STRIPE_SECRET_KEY: 'sk_test_x', RESEND_API_KEY: 're_x', STRIPE_API_BASE: `http://localhost:${FP}`, RESEND_API_BASE: `http://localhost:${FP}`,
  SPACE_MAX_MEMBERS: '3', QUIET_LOGS: '1',
});
const { handle } = await import('../server/handler.js');
const device = makeDevice(handle);
const pub = publicFromPrivate(priv);
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
const lic = async (dev) => verifyES((await dev.call('POST', 'license')).data.license, pub);

// ---- accounts ----
const A = device('iphone');
const ana = await signup(A, state, { name: 'Ana', email: 'ana@casa.com', password: 'girassol azul no quintal 77' });
const B = device('android');
const bia = await signup(B, state, { name: 'Bia', email: 'bia@casa.com', password: 'coruja sabia no galho 42' });
const C = device('mac');
await signup(C, state, { name: 'Caio', email: 'caio@outro.com', password: 'jabuticaba madura 2026 ok' });
const anaWrap = await memberWrapKey(ana.bundle.dataKey);
const biaWrap = await memberWrapKey(bia.bundle.dataKey);

let r = await A.call('GET', 'config');
assert.deepEqual(r.data.spaces, { enabled: true, max: 3 });
assert.equal(r.data.billing.familyPrice, undefined); assert.deepEqual(r.data.billing.plans.map((x) => x.id), ['essencial', 'plus', 'premium']);
ok('config: spaces on; plans by number of banks (no Family plan)');

// ---- create ----
const id = newSpaceId();
const K = newSpaceKey();
r = await A.call('POST', 'spaces', { id, meta: await sealSpaceMeta(K, id, { name: 'Casa', emoji: '🏠' }), key: await wrapSpaceKey(anaWrap, id, K) });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal((await A.call('POST', 'spaces', { id, meta: await sealSpaceMeta(K, id, { name: 'x' }), key: await wrapSpaceKey(anaWrap, id, K) })).data.error, 'space_exists');
assert.equal((await A.call('POST', 'spaces', { id: newSpaceId(), meta: { iv: 'x', ct: 'y' }, key: await wrapSpaceKey(anaWrap, id, K) })).data.error, 'invalid_meta');
r = await A.call('GET', 'spaces');
assert.equal(r.data.spaces.length, 1);
const view = r.data.spaces[0];
assert.equal(view.role, 'owner'); assert.deepEqual(view.members.map((m) => m.name), ['Ana']);
assert.deepEqual(await unwrapSpaceKey(anaWrap, id, view.key), K);
assert.equal((await openSpaceMeta(K, id, view.meta)).name, 'Casa');
const stored = fs.readFileSync(path.join(blobs, 'spaces', `${encodeURIComponent(`s:${id}`)}.json`), 'utf8');
assert.ok(!stored.includes('Casa') && !stored.includes(b64u.enc(K)), 'the server has neither the name nor the key');
ok('a space is created with its name and key encrypted (the server can read neither)');

// ---- invite ----
const { invite, fragment } = await makeInvite(K, id);
r = await A.call('POST', 'spaces/invite', { id, invite });
assert.equal(r.status, 200); assert.ok(r.data.exp > Date.now() / 1000 + 6 * 86400);
const link = `https://app.test/app/#${fragment}`;
const parsed = parseInvite(`Entra no nosso espaço: ${link} 🙂`);
assert.deepEqual([parsed.spaceId, parsed.inviteId], [id, invite.id]);
assert.equal(parseInvite('https://app.test/app/#join=sp_x.y.z'), null);
assert.ok(!JSON.stringify(state).includes(parsed.secret), 'the link secret never reached the server or any service');
const invStored = fs.readFileSync(path.join(blobs, 'spaces', `${encodeURIComponent(`s:${id}`)}.json`), 'utf8');
assert.ok(!invStored.includes(parsed.secret));
assert.equal((await B.call('POST', 'spaces/invite', { id, invite: (await makeInvite(K, id)).invite })).data.error, 'space_not_found', 'only members (owners) invite');
ok('an invite keeps only a proof hash and the encrypted key; the secret travels only in the link');

// ---- someone with a wrong secret ----
const wrong = await inviteProof(b64u.enc(new Uint8Array(32)));
r = await C.call('POST', 'spaces/peek', { id, inviteId: invite.id, mac: wrong.mac });
assert.equal(r.status, 404); assert.equal(r.data.error, 'invite_invalid');
ok('a wrong secret gets nothing');

// ---- Bia opens the link ----
const proof = await inviteProof(parsed.secret);
r = await B.call('POST', 'spaces/peek', { id, inviteId: invite.id, mac: proof.mac });
assert.equal(r.status, 200);
assert.equal(r.data.ownerName, 'Ana'); assert.equal(r.data.members, 1);
const Kb = await openInviteBox(proof.wrap, id, invite.id, r.data.box);
assert.deepEqual(Kb, K);
assert.equal((await openSpaceMeta(Kb, id, r.data.meta)).name, 'Casa');
r = await B.call('POST', 'spaces/join', { id, inviteId: invite.id, mac: proof.mac, key: await wrapSpaceKey(biaWrap, id, Kb) });
assert.equal(r.status, 200); assert.equal(r.data.pending, true);
r = await C.call('POST', 'spaces/join', { id, inviteId: invite.id, mac: proof.mac, key: await wrapSpaceKey(biaWrap, id, Kb) });
assert.equal(r.data.error, 'invite_invalid', 'each link works once');
r = await B.call('GET', 'spaces');
assert.equal(r.data.spaces.length, 0);
assert.equal(r.data.waiting.length, 1); assert.equal(r.data.waiting[0].ownerName, 'Ana');
assert.equal((await B.call('GET', `spaces/data?id=${id}`)).status, 404, 'no data before the owner approves');
ok('the invited person sees who invited and the space name, asks to join, and waits (link used up)');

// ---- Ana approves ----
r = await A.call('GET', 'spaces');
const req = r.data.spaces[0].requests[0];
assert.equal(req.name, 'Bia'); assert.equal(req.email, 'b••@casa.com');
assert.equal(r.data.spaces[0].invites.length, 0);
assert.equal((await B.call('POST', 'spaces/approve', { id, userId: req.id, ok: true })).status, 404, 'only the owner approves');
r = await A.call('POST', 'spaces/approve', { id, userId: req.id, ok: true });
assert.equal(r.status, 200);
r = await B.call('GET', 'spaces');
assert.equal(r.data.spaces.length, 1); assert.equal(r.data.waiting.length, 0);
assert.deepEqual(r.data.spaces[0].members.map((m) => m.name).sort(), ['Ana', 'Bia']);
assert.deepEqual(await unwrapSpaceKey(biaWrap, id, r.data.spaces[0].key), K, 'Bia opens the key with her own data key');
assert.equal(r.data.spaces[0].requests, undefined, 'members don’t see requests');
ok('the owner sees the request (name + hidden e-mail) and approves; then the member has the key');

// ---- shared data ----
const sk = await spaceSyncKey(K);
const snap = { v: 1, at: Date.now(), stores: { accounts: [{ id: 'acc_joint', name: 'Conta conjunta', space: id }], transactions: [] }, tombstones: {} };
r = await A.call('PUT', 'spaces/data', { id, baseVersion: 0, data: await sealSnapshot(snap, sk, null) });
assert.equal(r.status, 200); assert.equal(r.data.version, 1);
r = await B.call('PUT', 'spaces/data', { id, baseVersion: 0, data: 'x' });
assert.equal(r.status, 409, 'based on an old version: merge first');
r = await B.call('GET', `spaces/data?id=${id}`);
const got = await openSnapshot(r.data.data, await spaceSyncKey(await unwrapSpaceKey(biaWrap, id, (await B.call('GET', 'spaces')).data.spaces[0].key)));
assert.equal(got.stores.accounts[0].name, 'Conta conjunta');
assert.equal((await C.call('GET', `spaces/data?id=${id}`)).status, 404);
assert.equal((await B.call('GET', `spaces/data?id=${id}&meta=1`)).data.version, 1);
ok('members share one encrypted copy (versioned); outsiders get nothing');

// ---- limits ----
const D = device('iphone');
await signup(D, state, { name: 'Dani', email: 'dani@casa.com', password: 'mais uma senha comprida 9' });
const E = device('android');
await signup(E, state, { name: 'Edu', email: 'edu@casa.com', password: 'outra senha muito longa 8' });
const inv2 = await makeInvite(K, id);
await A.call('POST', 'spaces/invite', { id, invite: inv2.invite });
const p2 = await inviteProof(parseInvite(inv2.fragment).secret);
await D.call('POST', 'spaces/join', { id, inviteId: inv2.invite.id, mac: p2.mac, key: await wrapSpaceKey(await memberWrapKey(new Uint8Array(32)), id, K) });
const dani = (await A.call('GET', 'spaces')).data.spaces[0].requests.find((x) => x.name === 'Dani');
await A.call('POST', 'spaces/approve', { id, userId: dani.id, ok: true });
const inv3 = await makeInvite(K, id);
r = await A.call('POST', 'spaces/invite', { id, invite: inv3.invite });
assert.equal(r.data.error, 'space_full');
ok('a space holds up to SPACE_MAX_MEMBERS people');

// ---- removing and leaving ----
r = await A.call('POST', 'spaces/remove', { id, userId: dani.id });
assert.equal(r.status, 200);
assert.equal((await D.call('GET', 'spaces')).data.spaces.length, 0);
assert.equal((await D.call('GET', `spaces/data?id=${id}`)).status, 404, 'a removed member loses access at once');
assert.equal((await A.call('POST', 'spaces/leave', { id })).data.error, 'owner_cannot_leave');
r = await A.call('GET', 'account/activity');
assert.ok(r.data.events.some((e) => e.type === 'space_created'));
ok('the owner removes people (access ends at once); the owner can’t just leave');

// ---- refusing ----
const inv4 = await makeInvite(K, id);
await A.call('POST', 'spaces/invite', { id, invite: inv4.invite });
const p4 = await inviteProof(parseInvite(inv4.fragment).secret);
await E.call('POST', 'spaces/join', { id, inviteId: inv4.invite.id, mac: p4.mac, key: await wrapSpaceKey(await memberWrapKey(new Uint8Array(32)), id, K) });
const edu = (await A.call('GET', 'spaces')).data.spaces[0].requests.find((x) => x.name === 'Edu');
await A.call('POST', 'spaces/approve', { id, userId: edu.id, ok: false });
r = await E.call('GET', 'spaces');
assert.equal(r.data.spaces.length, 0); assert.equal(r.data.waiting.length, 0);
ok('a refused request disappears');

// ---- each person in a space has their own plan ----
const trialEnd = (await lic(B)).exp;
assert.equal((await lic(B)).status, 'trial');
assert.equal((await A.call('POST', 'billing/checkout', { plan: 'family' })).status, 400);
r = await A.call('POST', 'billing/checkout', { plan: 'premium', startNow: true });
const sid = new URL(r.data.url).searchParams.get('session_id');
const sess = state.sessions.get(sid);
assert.equal(sess.params['line_items[0][price_data][unit_amount]'], '3490');
assert.equal(sess.params['subscription_data[trial_end]'], undefined, 'pay today: no trial carried over');
r = await A.call('POST', 'billing/claim', { sessionId: sid });
let La = await verifyES(r.data.license, pub);
assert.equal(La.status, 'active'); assert.equal(La.plan, 'premium'); assert.equal(La.banks, 6);
const Lb = await lic(B);
assert.equal(Lb.status, 'trial'); assert.equal(Lb.exp, trialEnd); assert.equal(Lb.banks, 0);
ok('the owner’s Premium is the owner’s: members of the space keep their own plan (or trial)');

// someone already paying who changes plans pays the new one today; the old one ends with credit
r = await A.call('POST', 'billing/checkout', { plan: 'plus' });
const sid2 = new URL(r.data.url).searchParams.get('session_id');
assert.equal(state.sessions.get(sid2).params['subscription_data[trial_end]'], undefined, 'no new trial for a paying customer');
r = await A.call('POST', 'billing/claim', { sessionId: sid2 });
La = await verifyES(r.data.license, pub);
assert.equal(La.plan, 'plus'); assert.equal(La.banks, 3);
assert.ok(state.cancelParams.some((c) => c.id === sess.subscription && c.prorate === 'true'));
// paid but never came back to the app: the next license check ends the older plan, so nobody pays twice
r = await A.call('POST', 'billing/checkout', { plan: 'premium' });
const sid3 = new URL(r.data.url).searchParams.get('session_id');
La = await lic(A);
assert.equal(La.plan, 'premium');
assert.ok(state.cancelParams.some((c) => c.id === state.sessions.get(sid2).subscription && c.prorate === 'true'));
assert.ok(!state.canceled.includes(state.sessions.get(sid3).subscription));
ok('changing plans ends the old subscription with credit (even if the app never got back from the payment page)');

// ---- the owner's account is deleted: the space goes on with the oldest member as owner ----
const { dropSpaces } = await import('../server/spaces.js');
const { getUser } = await import('../server/accounts.js');
const anaUser = await getUser(ana.login.user.id);
await dropSpaces(anaUser);
r = await B.call('GET', 'spaces');
assert.equal(r.data.spaces[0].role, 'owner');
assert.deepEqual(r.data.spaces[0].members.map((m) => m.name), ['Bia']);
ok('if the owner’s account is deleted, the space stays with the oldest member as the new owner');

// ---- deleting the space ----
r = await B.call('POST', 'spaces/delete', { id });
assert.equal(r.status, 200);
assert.equal((await B.call('GET', 'spaces')).data.spaces.length, 0);
assert.equal((await B.call('GET', `spaces/data?id=${id}`)).status, 404);
assert.ok(!fs.existsSync(path.join(blobs, 'spacedata', `${encodeURIComponent(`d:${id}`)}.json`)));
ok('the owner can delete the space (and its shared copy)');

server.close();
console.log(`\n${passed} checks passed`);
process.exit(0);
