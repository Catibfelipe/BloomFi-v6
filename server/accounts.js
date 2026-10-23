/**
 * BloomFi accounts: name + e-mail + password, with a zero-knowledge design.
 *
 *   password ──Argon2id (on the device)──► masterKey
 *   masterKey ─HKDF─► authKey   (sent to us; we keep scrypt(HMAC(pepper, authKey)))
 *   masterKey ─HKDF(+ server key share)─► encKey (never sent; wraps the account data key)
 *
 * We never see the password nor the data key, so we can't read anyone's finances
 * and a copy of our database is useless without the server secrets.
 *
 * Sessions live in an HttpOnly, Secure, SameSite=Strict cookie that rotates every
 * few days; a rotated-out cookie used again revokes the session (theft detection).
 */
import { getKV, update } from './storage.js';
import { signHS, verifyHS, now, randomId, randomDigits } from './crypto.js';
import {
  hashSecret, checkSecret, keyShare, emailIndex, fakeSalt, seal, unseal, sameBytes, sha256, toB64, fromB64, randomBytes,
  normEmail, maskEmail, deviceFromUA, cleanText, verifyTotp, base32, newBackupCodes, normBackup, hmac, validPublicJwk,
} from './security.js';
import { sendAccountEmail, emailEnabled } from './emails.js';
import { HttpError, onNetlify } from './services.js';

const MIN = 60, HOUR = 3600, DAY = 86400;
export const SESSION_IDLE = 45 * DAY;
export const SESSION_MAX = 180 * DAY;
const ROTATE_EVERY = 3 * DAY;
const MAX_SESSIONS = 20;
const ID_RE = /^[\w-]{10,64}$/;

export const httpError = (status, code, extra) => Object.assign(new HttpError(status, code), extra ? { extra } : {});

export const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
});

// ---------------- request context ----------------
export function clientIp(req, context) {
  if (context?.ip) return context.ip;
  // On Netlify the platform always says who is calling; headers sent by the caller could be forged to dodge limits.
  if (onNetlify()) return 'unknown';
  return req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local';
}
export function geoOf(context) {
  const g = context?.geo;
  if (!g) return null;
  return [g.city, g.country?.code].filter(Boolean).join(', ') || null;
}

/** Browser calls must come from our own pages (blocks CSRF even if SameSite were bypassed). */
export function assertSameOrigin(ctx) {
  const { req, env } = ctx;
  if (req.headers.get('x-bloomfi') !== '1') throw httpError(403, 'bad_origin');
  const origin = req.headers.get('origin');
  const own = env.appOrigin || new URL(req.url).origin;
  if (origin && origin !== own) throw httpError(403, 'bad_origin');
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') throw httpError(403, 'bad_origin');
}

// ---------------- persistent rate limits ----------------
const memory = new Map();
function memoryHit(key, max, windowSec) {
  const t = now();
  const b = memory.get(key);
  if (!b || b.reset < t) { memory.set(key, { n: 1, reset: t + windowSec }); return; }
  if (++b.n > max) throw httpError(429, 'too_many_requests', { retryAfter: b.reset - t });
  if (memory.size > 5000) memory.clear();
}

/** Counts one request in a window; 429 when over the limit. Stored in Blobs so it holds across instances. */
export async function hit(scope, id, max, windowSec) {
  const key = `rl:${scope}:${toB64((await sha256(String(id))).subarray(0, 12))}`;
  let blocked = null;
  try {
    await update('auth', key, (cur) => {
      blocked = null; // (each compare-and-set retry starts clean)
      const t = now();
      const rec = cur && cur.reset > t ? cur : { n: 0, reset: t + windowSec };
      if (rec.n >= max) { blocked = rec.reset - t; return undefined; }
      return { n: rec.n + 1, reset: rec.reset };
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // Many requests fighting over one counter at the same moment look like an attack: refuse instead of counting less.
    if (e?.code === 'storage_conflict') throw httpError(429, 'too_many_requests', { retryAfter: 5 });
    memoryHit(key, max, windowSec);
  }
  if (blocked != null) throw httpError(429, 'too_many_requests', { retryAfter: Math.max(1, blocked) });
}

/**
 * Wrong passwords, counted per e-mail AND per network: after 5 failures from the same place the waits grow
 * (30 s, 1, 2, 4… up to 30 min). Someone guessing from elsewhere can't lock the owner out; if the account
 * gets many failures from everywhere, signing in on a new device also asks for a code sent by e-mail.
 */
/** The network an address belongs to: IPv4 as is, IPv6 by its /64 (compressed "::" forms expanded first). */
export function netOf(ip) {
  let s = String(ip || '').trim().toLowerCase().split('%')[0];
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(s)) s = s.slice(7);
  if (!s.includes(':')) return s;
  const [head, tail] = s.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = s.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}
const lockKey = async (eh, ip) => `lf:${eh}:${toB64((await sha256(`net:${netOf(ip)}`)).subarray(0, 9))}`;
async function lockOf(eh, ip) { return (await (await getKV('auth')).get(await lockKey(eh, ip))) || { n: 0, until: 0 }; }
async function addFailure(eh, ip) {
  await update('auth', await lockKey(eh, ip), (cur) => {
    const rec = cur && cur.last > now() - DAY ? cur : { n: 0, until: 0 };
    const n = rec.n + 1;
    const wait = n >= 5 ? Math.min(30 * 2 ** (n - 5), 30 * MIN) : 0;
    return { n, until: wait ? now() + wait : 0, last: now() };
  }).catch(() => {});
  const net = toB64((await sha256(`net:${netOf(ip)}`)).subarray(0, 6));
  await update('auth', `lg:${eh}`, (cur) => {
    const rec = cur && cur.since > now() - DAY ? cur : { n: 0, since: now(), nets: [] };
    const nets = [...new Set([...(rec.nets || []), net])].slice(0, 12);
    return { n: rec.n + 1, since: rec.since, last: now(), nets };
  }).catch(() => {});
}
const clearFailures = async (eh, ip) => (await getKV('auth')).delete(await lockKey(eh, ip)).catch(() => {});
/**
 * "Under attack": many wrong passwords today from several networks (someone guessing from many places), or a
 * very large number from anywhere. Typos from the owner's own phone, even many, never turn it on; they only
 * meet the growing waits of the network lock above.
 */
const UNDER_ATTACK = 10, UNDER_ATTACK_NETS = 3, UNDER_ATTACK_ANY = 40;
async function underAttack(eh) {
  const g = await (await getKV('auth')).get(`lg:${eh}`).catch(() => null);
  if (!g || !(g.since > now() - DAY)) return false;
  return (g.n >= UNDER_ATTACK && (g.nets?.length || 0) >= UNDER_ATTACK_NETS) || g.n >= UNDER_ATTACK_ANY;
}

const forgetOnce = async (key) => (await getKV('auth')).delete(`once:${key}`).catch(() => {});
/** True only the first time in `windowSec` (used to avoid repeating notification e-mails). */
async function once(key, windowSec) {
  let first = false;
  await update('auth', `once:${key}`, (cur) => {
    first = false;
    if (cur && cur.until > now()) return undefined;
    first = true;
    return { until: now() + windowSec };
  }).catch(() => {});
  return first;
}

// ---------------- users ----------------
export async function getUser(id) {
  if (!id || !/^u_[\w-]{10,40}$/.test(id)) return null;
  return (await getKV('users')).get(`u:${id}`);
}
export const saveUser = (id, fn) => update('users', `u:${id}`, fn);

async function userByEmail(keys, email) {
  const eh = await emailIndex(keys, email);
  const idx = await (await getKV('index')).get(`e:${eh}`);
  const user = idx?.userId ? await getUser(idx.userId) : await (await getKV('users')).get('u:u_0000000000000000').then(() => null);
  return { eh, user: user && user.emailHash === eh ? user : null };
}

export async function publicUser(keys, u) {
  const pii = (await unseal(keys, u.pii).catch(() => null)) || {};
  return {
    id: u.id, name: pii.name || '', email: pii.email || '', emailVerified: !!u.emailVerified, createdAt: u.createdAt,
    twoFactor: !!u.totp?.enabled, lang: u.lang || 'pt', hasRecovery: !!u.keys?.recovery, prefs: u.prefs || {},
    // Grows on every password change/reset: devices still locked with an older password learn it is stale.
    pwv: u.security?.pwv || 1,
  };
}
export async function emailOf(keys, u) { return (await unseal(keys, u.pii).catch(() => null))?.email || null; }

function eventOf(ctx, type, extra = {}) {
  return { t: now(), type, dev: ctx.deviceName || deviceFromUA(ctx.req.headers.get('user-agent')), geo: ctx.geo || null, ...extra };
}
export const withEvent = (u, ev) => ({ ...u, events: [ev, ...(u.events || [])].slice(0, 60) });

// ---------------- validation ----------------
const isBox = (b, maxCt = 400) => !!b && typeof b.iv === 'string' && typeof b.ct === 'string' && fromB64(b.iv).length === 12 && fromB64(b.ct).length >= 17 && fromB64(b.ct).length <= maxCt;

/**
 * Account passwords always use Argon2id with at least 64 MiB and 3 passes (the app refuses anything weaker
 * too). One setting for everyone also means the fake answer for unknown e-mails looks like a real one.
 */
export function validKdf(k) {
  if (!k || typeof k !== 'object' || typeof k.salt !== 'string') return null;
  const salt = fromB64(k.salt);
  if (salt.length < 16 || salt.length > 32) return null;
  if (k.alg !== 'argon2id') return null;
  const m = Number(k.m), t = Number(k.t), p = Number(k.p);
  if (!(Number.isInteger(m) && Number.isInteger(t) && Number.isInteger(p) && m >= 65536 && m <= 262144 && t >= 3 && t <= 10 && p >= 1 && p <= 4)) return null;
  return { alg: 'argon2id', m, t, p, salt: k.salt };
}
export const DEFAULT_KDF = { alg: 'argon2id', m: 65536, t: 3, p: 1 };

function bytes32(b64) {
  const b = fromB64(b64);
  if (b.length !== 32) throw httpError(400, 'invalid_key');
  return b;
}

function validKeys(k, { full = true } = {}) {
  if (!k || !isBox(k.wrappedDataKey, 64)) throw httpError(400, 'invalid_keys');
  if (!full) return { wrappedDataKey: pick(k.wrappedDataKey) };
  if (!validPublicJwk(k.publicKey) || !isBox(k.wrappedPrivateKey, 600)) throw httpError(400, 'invalid_keys');
  if (!k.recovery || !isBox(k.recovery.wrap, 64)) throw httpError(400, 'invalid_keys');
  bytes32(k.recovery.auth);
  return {
    wrappedDataKey: pick(k.wrappedDataKey),
    publicKey: { kty: 'EC', crv: 'P-256', x: k.publicKey.x, y: k.publicKey.y },
    wrappedPrivateKey: pick(k.wrappedPrivateKey),
    recovery: { wrap: pick(k.recovery.wrap), authB64: k.recovery.auth },
  };
}
const pick = (b) => ({ iv: b.iv, ct: b.ct });

function deviceInfo(ctx, raw) {
  const ua = ctx.req.headers.get('user-agent') || '';
  return {
    name: cleanText(raw?.name, 40) || deviceFromUA(ua),
    platform: ['ios', 'android', 'mac', 'windows', 'linux', 'other'].includes(raw?.platform) ? raw.platform : 'other',
    ua: deviceFromUA(ua),
  };
}

// ---------------- challenges (codes sent by e-mail) ----------------
/**
 * A 6-digit code e-mailed to `to`. `fake: true` makes one that looks exactly the same from outside
 * (same answers, same limits, same resend rules) but no code can open it: used for e-mails without
 * an account, so nobody can find out which e-mails have one.
 */
async function newChallenge(keys, { to, fake = false, ...data }) {
  const id = randomId(18);
  const code = randomDigits(6);
  await (await getKV('auth')).set(`c:${id}`, {
    ...data, id, fake, to: to ? await seal(keys, { email: to }, 'challenge') : null,
    codeHash: fake ? null : toB64(await hmac(keys.pepper, `code:${id}:${code}`)), attempts: 0, sends: 1, sentAt: now(), exp: now() + 15 * MIN,
  });
  return { id, code };
}

/**
 * Codes go out BEFORE the answer: if the e-mail service refuses (sender domain not verified yet, a typo in the
 * address), the person is told right away instead of waiting for a code that never comes. Every answer of these
 * routes, sent or not (unknown e-mail, wrong password), takes at least env.mailFloorMs (plus a little noise), so
 * the answer time tells nothing about whether an e-mail has an account.
 */
async function sendNow(env, to, kind, data = {}, lang = 'pt') {
  const t0 = Date.now();
  try {
    if (to && !(await sendAccountEmail(env, to, kind, data, lang))) throw httpError(502, 'email_failed');
  } finally {
    const floor = env.mailFloorMs ?? 1500;
    const wait = floor ? floor - (Date.now() - t0) + Math.floor(Math.random() * 150) : 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

const MAX_CODE_TRIES = 5;
const MAX_CODE_SENDS = 3;
/**
 * Checks a code. Each try is counted inside the same compare-and-set as the check, so many tries sent at
 * once can't get past the limit, and a correct code is used up atomically (it can't open two sessions).
 * Guessing is also capped per e-mail: 12 tries per network every 6 hours, 60 per day from everywhere
 * (someone guessing from one place can't block the owner's own code; from everywhere it stays hopeless).
 */
async function checkChallenge(ctx, id, code, type, { consume = true } = {}) {
  const { keys } = ctx;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw httpError(400, 'invalid_code');
  const c = String(code || '').replace(/\D/g, '');
  const peek = await (await getKV('auth')).get(`c:${id}`);
  if (!peek || peek.type !== type) throw httpError(400, 'invalid_code');
  const who = peek.emailHash || id;
  await hit(`code-${type}-net`, `${who}:${netOf(ctx.ip)}`, 12, 6 * HOUR);
  await hit(`code-${type}-day`, who, 60, DAY);
  const expected = c.length === 6 ? toB64(await hmac(keys.pepper, `code:${id}:${c}`)) : null;
  let outcome = null;
  let left = 0;
  let rec = null;
  await update('auth', `c:${id}`, (cur) => {
    outcome = null; left = 0; rec = cur;
    if (!cur || cur.type !== type) { outcome = 'invalid'; return undefined; }
    if (cur.exp < now()) { outcome = 'expired'; return null; }
    if (cur.attempts >= MAX_CODE_TRIES) { outcome = 'locked'; return undefined; }
    const attempts = cur.attempts + 1;
    // The newest code, or one of the two before it ("send again" while the first e-mail was still on its way).
    const match = (h) => !!h && sameBytes(expected, h);
    if (!cur.fake && expected && (match(cur.codeHash) || (cur.prevHashes || []).some(match))) {
      outcome = 'ok';
      return consume ? null : { ...cur, attempts };
    }
    outcome = 'wrong';
    left = Math.max(0, MAX_CODE_TRIES - attempts);
    return { ...cur, attempts };
  });
  if (outcome === 'ok') return rec;
  if (outcome === 'expired') throw httpError(400, 'code_expired');
  if (outcome === 'locked') throw httpError(429, 'too_many_attempts');
  if (outcome === 'wrong') throw httpError(400, 'invalid_code', { attemptsLeft: left });
  throw httpError(400, 'invalid_code');
}

/** Where the code of this challenge goes (only real challenges have one). */
async function challengeRecipient(keys, rec) {
  if (!rec?.to || rec.fake) return null;
  return (await unseal(keys, rec.to, 'challenge').catch(() => null))?.email || null;
}
const CHALLENGE_MAIL = { signup: 'verify', reset: 'reset', email_change: 'emailChange', login: 'loginCode' };

// ---------------- tickets (short-lived signed steps) ----------------
const ticket = (keys, payload, ttl) => signHS({ ...payload, n: randomId(8), exp: now() + ttl }, keys.tokens);
async function readTicket(keys, token, typ) {
  const t = await verifyHS(token, keys.tokens);
  if (!t || t.typ !== typ) throw httpError(401, 'invalid_ticket');
  return t;
}
/** Single-use tickets (password reset, sensitive changes): a copy can't be replayed. */
async function consumeTicket(t) {
  let fresh = false;
  await update('auth', `used:${t.n}`, (cur) => {
    fresh = false;
    if (cur) return undefined;
    fresh = true;
    return { until: t.exp };
  });
  if (!fresh) throw httpError(401, 'invalid_ticket');
}

// ---------------- sessions ----------------
export function readCookie(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}
const cookieFor = (env, value, maxAge) => `${env.cookieName}=${value}; Path=/; HttpOnly;${env.cookieSecure === false ? '' : ' Secure;'} SameSite=Strict; Max-Age=${maxAge}`;
export const clearCookie = (env) => cookieFor(env, '', 0);

/** The same browser signing in again (new password, expired session): its previous session is replaced, not duplicated. */
async function previousSessionOf(ctx, userId) {
  const raw = readCookie(ctx.req, ctx.env.cookieName);
  if (!raw) return null;
  const [sid, secret] = raw.split('.');
  if (!ID_RE.test(sid || '') || !/^[\w-]{20,80}$/.test(secret || '')) return null;
  const s = await (await getKV('sessions')).get(`s:${sid}`);
  if (!s || s.userId !== userId) return null;
  const h = toB64(await sha256(secret));
  return sameBytes(h, s.hash) || (s.prev && sameBytes(h, s.prev)) ? sid : null;
}

async function createSession(ctx, user, deviceRaw) {
  const replaced = await previousSessionOf(ctx, user.id).catch(() => null);
  if (replaced) await (await getKV('sessions')).delete(`s:${replaced}`).catch(() => {});
  const sid = randomId(16);
  const secret = randomId(32);
  const t = now();
  const device = deviceInfo(ctx, deviceRaw);
  ctx.deviceName = device.name;
  const s = {
    id: sid, userId: user.id, sv: user.security?.sv || 1, hash: toB64(await sha256(secret)), prev: null, prevUntil: 0, old: [],
    createdAt: t, lastSeen: t, rotatedAt: t, expiresAt: t + SESSION_MAX, device, geo: ctx.geo || null,
  };
  await (await getKV('sessions')).set(`s:${sid}`, s);
  // Keep the list short: the oldest sessions are signed out.
  let dropped = [];
  await saveUser(user.id, (u) => {
    if (!u) return undefined;
    const list = [sid, ...(u.sessions || []).filter((x) => x !== sid && x !== replaced)];
    dropped = list.slice(MAX_SESSIONS);
    return { ...u, sessions: list.slice(0, MAX_SESSIONS) };
  });
  for (const d of dropped) await (await getKV('sessions')).delete(`s:${d}`);
  ctx.setCookie = cookieFor(ctx.env, `${sid}.${secret}`, SESSION_MAX);
  return s;
}

/**
 * The signed-in user of this request (cookie). Rotates the cookie when asked
 * (only from GET account/session, called once when the app opens).
 */
export async function requireSession(ctx, { rotate = false } = {}) {
  assertSameOrigin(ctx);
  const raw = readCookie(ctx.req, ctx.env.cookieName);
  if (!raw) throw httpError(401, 'no_session');
  const [sid, secret] = raw.split('.');
  if (!ID_RE.test(sid || '') || !/^[\w-]{20,80}$/.test(secret || '')) throw httpError(401, 'session_invalid');
  const store = await getKV('sessions');
  const s = await store.get(`s:${sid}`);
  if (!s) throw httpError(401, 'session_expired');
  if (s.revoked) throw httpError(401, 'session_revoked', { wipe: !!s.revoked.wipe, reason: s.revoked.reason || (s.revoked.by ? 'removed' : null) });
  const h = toB64(await sha256(secret));
  const t = now();
  if (!sameBytes(h, s.hash)) {
    const grace = s.prev && sameBytes(h, s.prev) && t < s.prevUntil;
    if (!grace) {
      if ((s.old || []).some((o) => sameBytes(h, o))) {
        // A rotated-out cookie came back: someone may have copied it. End the session.
        await store.set(`s:${sid}`, { ...s, revoked: { at: t, reason: 'reuse' }, purgeAt: t + 30 * DAY });
        await accountHooks.onSessionsEnded?.(s.userId, [sid]);
        const ua = deviceFromUA(ctx.req.headers.get('user-agent'));
        await saveUser(s.userId, (u) => (u ? withEvent({ ...u, sessions: (u.sessions || []).filter((x) => x !== sid) }, eventOf(ctx, 'session_reuse')) : undefined)).catch(() => {});
        const u = await getUser(s.userId);
        // A device that simply lost the new cookie (app killed mid-request) looks the same: only alert when it doesn't.
        if (u && ua !== s.device?.ua) {
          const email = await emailOf(ctx.keys, u);
          if (email) ctx.later(sendAccountEmail(ctx.env, email, 'suspicious', { device: s.device?.name || ua, when: fmtWhen(t, u.lang) }, u.lang));
        }
        throw httpError(401, 'session_revoked', { wipe: false });
      }
      throw httpError(401, 'session_invalid');
    }
  }
  if (t > s.expiresAt || t - s.lastSeen > SESSION_IDLE) { await store.delete(`s:${sid}`); throw httpError(401, 'session_expired'); }
  const user = await getUser(s.userId);
  if (!user) throw httpError(401, 'session_expired');
  if ((s.sv || 1) < (user.security?.sv || 1) || !(user.sessions || []).includes(sid)) throw httpError(401, 'session_revoked', { wipe: false, reason: 'account_changed' });
  ctx.deviceName = s.device?.name;
  // Write only when something changed (not on every request), with compare-and-set: two requests at once
  // can't undo a sign-out/wipe written in between, and only one of them rotates the cookie.
  const presentedCurrent = sameBytes(h, s.hash);
  if ((rotate && presentedCurrent && t - s.rotatedAt > ROTATE_EVERY) || t - s.lastSeen > 10 * MIN) {
    let fresh = null;
    const r = await update('sessions', `s:${sid}`, async (cur) => {
      fresh = null;
      if (!cur || cur.revoked || cur.hash !== s.hash) return undefined; // changed meanwhile: leave it alone
      const next = { ...cur, lastSeen: t, geo: ctx.geo || cur.geo };
      if (rotate && presentedCurrent && t - cur.rotatedAt > ROTATE_EVERY) {
        fresh = randomId(32);
        next.prev = cur.hash; next.prevUntil = t + 120; next.old = [cur.hash, ...(cur.old || [])].slice(0, 6); next.hash = toB64(await sha256(fresh)); next.rotatedAt = t;
      }
      return next;
    }).catch(() => null);
    if (fresh && r?.changed) ctx.setCookie = cookieFor(ctx.env, `${sid}.${fresh}`, Math.max(60, s.expiresAt - t));
    return { session: r?.changed ? r.value : s, user };
  }
  return { session: s, user };
}

/** Writes a "signed out" tombstone on one session (kept a while so the device learns why). */
async function revokeSession(id, revoked) {
  await update('sessions', `s:${id}`, (s) => (s && !s.revoked ? { ...s, revoked: { at: now(), ...revoked }, purgeAt: now() + 30 * DAY } : undefined)).catch(() => {});
}
/** Ends sessions but keeps a tombstone for a while, so those devices learn why they were signed out. */
async function endSessions(userId, ids, reason) {
  for (const id of ids) await revokeSession(id, { reason, wipe: false });
  await accountHooks.onSessionsEnded?.(userId, ids);
}

const fmtWhen = (t, lang) => new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(t * 1000));

async function loginPayload(ctx, u, { share = true } = {}) {
  const user = await publicUser(ctx.keys, u);
  const lic = ctx.licenseFor ? await ctx.licenseFor(u).catch(() => ({ license: null, status: 'unknown' })) : { license: null, status: 'none' };
  return {
    user,
    keys: u.keys ? {
      keyVersion: u.keys.keyVersion || 1, kdf: u.kdf, wrappedDataKey: u.keys.wrappedDataKey, publicKey: u.keys.publicKey,
      wrappedPrivateKey: u.keys.wrappedPrivateKey, hasRecovery: !!u.keys.recovery,
    } : null,
    share: share ? await keyShare(ctx.keys, u.id) : undefined,
    license: lic.license, licenseStatus: lic.status,
  };
}

async function finishLogin(ctx, u, { device, first = false } = {}) {
  const s = await createSession(ctx, u, device);
  await saveUser(u.id, (cur) => (cur ? withEvent(cur, eventOf(ctx, first ? 'signup' : 'login')) : undefined));
  if (!first) {
    const email = await emailOf(ctx.keys, u);
    if (email) ctx.later(sendAccountEmail(ctx.env, email, 'newLogin', { device: s.device.name, where: ctx.geo || '—', when: fmtWhen(now(), u.lang) }, u.lang));
  }
  return json({ ...(await loginPayload(ctx, await getUser(u.id))), session: { id: s.id } });
}

// ---------------- 2FA helpers ----------------
async function totpSecret(ctx, u) {
  const box = await unseal(ctx.keys, u.totp?.secret, 'totp').catch(() => null);
  return box?.s ? fromB64(box.s) : null;
}
const backupHash = async (ctx, userId, code) => toB64(await hmac(ctx.keys.pepper, `backup:${userId}:${normBackup(code)}`));

/** Checks a TOTP code or a backup code and records its use. */
async function checkSecondFactor(ctx, u, { code, backup }) {
  if (backup) {
    const h = await backupHash(ctx, u.id, backup);
    let ok = false;
    await saveUser(u.id, (cur) => {
      ok = false; // (each compare-and-set retry starts clean: a code used meanwhile doesn't count twice)
      const list = cur?.totp?.backup || [];
      const i = list.findIndex((b) => !b.used && sameBytes(b.h, h));
      if (i < 0) return undefined;
      ok = true;
      const next = list.map((b, j) => (j === i ? { ...b, used: now() } : b));
      return withEvent({ ...cur, totp: { ...cur.totp, backup: next } }, eventOf(ctx, 'backup_code_used'));
    });
    return ok;
  }
  const secret = await totpSecret(ctx, u);
  if (!secret) return false;
  const step = await verifyTotp(secret, code, { lastStep: u.totp.lastStep ?? -1 });
  if (step == null) return false;
  let fresh = false;
  await saveUser(u.id, (cur) => {
    fresh = false;
    if (!cur?.totp || (cur.totp.lastStep ?? -1) >= step) return undefined; // same code twice: refused
    fresh = true;
    return { ...cur, totp: { ...cur.totp, lastStep: step } };
  });
  return fresh;
}

/**
 * Re-authentication tickets: password (+ 2FA) again before a sensitive change. Each ticket is for one
 * kind of change, lasts 10 minutes, belongs to this session and is used up by the change it allowed.
 */
export const REAUTH_SCOPES = ['password', 'recovery', '2fa', 'email', 'delete', 'pin'];
async function readReauth(ctx, token, { session, user }, scope) {
  const t = await readTicket(ctx.keys, token, 'reauth');
  if (t.sub !== user.id || t.sid !== session.id || t.scope !== scope) throw httpError(401, 'invalid_ticket');
  return t;
}
/** Uses up a re-authentication ticket (call after the request was validated, right before the change). */
const spendReauth = (t) => consumeTicket(t);

// ---------------- hooks set by the handler (sync copy, inbox, Stripe, Pluggy…) ----------------
// onDelete(ctx, user): erase everything else the account owns.
// onKeysReplaced(userId): a password reset without the recovery key made the old ciphertexts unreadable.
// onSessionsEnded(userId, sessionIds): those devices were signed out (drop their notification subscriptions).
export const accountHooks = { onDelete: null, onKeysReplaced: null, onSessionsEnded: null };

// ======================= routes =======================
export const authRoutes = {
  // Which key-derivation settings to use for this e-mail (fake but stable ones for unknown e-mails).
  'POST auth/prelogin': async (ctx) => {
    const email = normEmail(ctx.body.email);
    if (!email) throw httpError(400, 'invalid_email');
    await hit('prelogin-ip', ctx.ip, 60, 15 * MIN);
    const { user } = await userByEmail(ctx.keys, email);
    const kdf = user?.kdf || { ...DEFAULT_KDF, salt: await fakeSalt(ctx.keys, email) };
    return json({ kdf });
  },

  'POST auth/signup': async (ctx) => {
    const { env, keys, body } = ctx;
    const email = normEmail(body.email);
    if (!email) throw httpError(400, 'invalid_email');
    const name = cleanText(body.name, 60);
    if (!name) throw httpError(400, 'invalid_name');
    const kdf = validKdf(body.kdf);
    if (!kdf) throw httpError(400, 'invalid_kdf');
    const authKey = bytes32(body.authKey);
    const lang = body.lang === 'en' ? 'en' : 'pt';
    if (!emailEnabled(env)) throw httpError(503, 'email_not_configured');
    await hit('signup-ip', ctx.ip, 12, HOUR);
    const { eh, user: existing } = await userByEmail(keys, email);
    await hit('signup-email', eh, 6, HOUR);
    const auth = await hashSecret(keys, authKey); // the same work whether or not the e-mail has an account
    if (existing?.emailVerified) {
      // Same answer as a new sign-up (no "this e-mail exists"); the owner gets an e-mail saying so instead of a
      // code, at most once an hour (someone trying again and again can't flood their inbox).
      const fake = await newChallenge(keys, { type: 'signup', emailHash: eh, fake: true, lang });
      if (await once(`exists:${eh}`, HOUR)) {
        // Not sent (e-mail service down): the hour doesn't start, and the answer is the same as for a new sign-up.
        try { await sendNow(env, email, 'exists', {}, existing.lang); } catch (e) { await forgetOnce(`exists:${eh}`); throw e; }
      } else await sendNow(env, null);
      return json({ verify: true, challengeId: fake.id, email: maskEmail(email) });
    }
    // Nothing is created until the code comes back. Each sign-up keeps its own password inside its own
    // challenge, so someone signing up again with the same e-mail can't replace the real owner's password.
    const ch = await newChallenge(keys, {
      type: 'signup', emailHash: eh, to: email, lang,
      pending: { userId: `u_${randomId(16)}`, pii: await seal(keys, { email, name }), kdf, auth },
    });
    await sendNow(env, email, 'verify', { code: ch.code }, lang);
    return json({ verify: true, challengeId: ch.id, email: maskEmail(email) });
  },

  'POST auth/resend': async (ctx) => {
    const { keys, env, body } = ctx;
    const id = String(body.challengeId || '');
    if (!ID_RE.test(id)) throw httpError(400, 'invalid_code');
    await hit('resend-ip', ctx.ip, 20, HOUR);
    // Real and fake challenges go through exactly the same steps (nobody can tell them apart).
    let out = null;
    let code = null;
    let rec = null;
    await update('auth', `c:${id}`, async (cur) => {
      out = null; code = null; rec = cur;
      if (!cur || cur.exp < now()) { out = { status: 400 }; return undefined; }
      if (now() - cur.sentAt < 45) { out = { retryAfter: 45 - (now() - cur.sentAt) }; return undefined; }
      if (cur.sends >= MAX_CODE_SENDS) { out = { retryAfter: Math.max(1, cur.exp - now()) }; return undefined; }
      code = randomDigits(6);
      const prevHashes = [cur.codeHash, ...(cur.prevHashes || [])].filter(Boolean).slice(0, 2);
      return { ...cur, codeHash: cur.fake ? null : toB64(await hmac(keys.pepper, `code:${id}:${code}`)), prevHashes, sends: cur.sends + 1, sentAt: now(), attempts: 0, exp: now() + 15 * MIN };
    });
    if (out?.status === 400) throw httpError(400, 'code_expired');
    if (out) throw httpError(429, 'too_many_requests', { retryAfter: out.retryAfter });
    const to = await challengeRecipient(keys, rec);
    await sendNow(env, to && CHALLENGE_MAIL[rec.type] ? to : null, CHALLENGE_MAIL[rec.type], { code }, rec.lang || 'pt');
    return json({ ok: true });
  },

  'POST auth/signup/verify': async (ctx) => {
    const { keys, body } = ctx;
    await hit('verify-ip', ctx.ip, 40, HOUR);
    const rec = await checkChallenge(ctx, body.challengeId, body.code, 'signup');
    const p = rec.pending;
    if (!p || !/^u_[\w-]{10,40}$/.test(p.userId || '')) throw httpError(400, 'invalid_code');
    const t = now();
    const users = await getKV('users');
    await users.set(`u:${p.userId}`, {
      id: p.userId, v: 5, emailHash: rec.emailHash, pii: p.pii, lang: rec.lang === 'en' ? 'en' : 'pt',
      emailVerified: true, verifiedAt: t, createdAt: t, pendingUntil: null, kdf: p.kdf, auth: p.auth, keys: null, totp: null,
      billing: { trialStart: null }, security: { sv: 1, pwv: 1 }, sessions: [], events: [], wallet: { tokens: [] }, push: [], of: { items: [] }, prefs: {},
    });
    // The e-mail now points to this account, unless another confirmed account took it meanwhile.
    let taken = false;
    await update('index', `e:${rec.emailHash}`, async (cur) => {
      taken = false;
      if (cur?.userId && cur.userId !== p.userId && (await getUser(cur.userId))?.emailVerified) { taken = true; return undefined; }
      return { userId: p.userId };
    });
    if (taken) { await users.delete(`u:${p.userId}`); throw httpError(409, 'account_exists'); }
    return json({ ticket: await ticket(keys, { typ: 'setup', sub: p.userId }, 30 * MIN), userId: p.userId, share: await keyShare(keys, p.userId) });
  },

  // Stores the wrapped keys of a new (or half-created) account and signs in.
  'POST auth/signup/finish': async (ctx) => {
    const { keys, body, env } = ctx;
    const t = await readTicket(keys, body.ticket, 'setup');
    const u = await getUser(t.sub);
    if (!u?.emailVerified) throw httpError(400, 'invalid_ticket');
    if (u.keys) throw httpError(409, 'already_set_up');
    const k = validKeys(body.keys);
    const recoveryAuth = await hashSecret(keys, bytes32(k.recovery.authB64));
    // A subscription or gift from version 4 on this device goes along (once, and gifts only to their own e-mail).
    let legacy = await readLegacy(env, body.legacy);
    if (legacy) legacy = await claimLegacy(legacy, u, await emailOf(keys, u)).catch(() => null);
    const trial = Number(body.legacy?.trialStart);
    const trialStart = Number.isFinite(trial) && trial > Date.now() - 365 * DAY * 1000 && trial < Date.now() ? Math.floor(trial / 1000) : now();
    await saveUser(u.id, (cur) => {
      if (!cur || cur.keys) return undefined;
      return {
        ...cur,
        keys: {
          keyVersion: 1, wrappedDataKey: k.wrappedDataKey, publicKey: k.publicKey, wrappedPrivateKey: k.wrappedPrivateKey,
          recovery: { wrap: k.recovery.wrap, auth: recoveryAuth }, setAt: now(),
        },
        billing: { ...(cur.billing || {}), trialStart: Math.min(cur.billing?.trialStart || trialStart, trialStart), ...linkLegacy(cur.billing, legacy) },
      };
    });
    if (legacy?.sub) await (await getKV('index')).set(`legacy:${toB64(await sha256(legacy.sub))}`, { userId: u.id }).catch(() => {});
    const fresh = await getUser(u.id);
    if (!fresh.keys) throw httpError(409, 'already_set_up');
    return finishLogin(ctx, fresh, { device: body.device, first: true });
  },

  'POST auth/login': async (ctx) => {
    const { keys, body } = ctx;
    const email = normEmail(body.email);
    if (!email) throw httpError(400, 'invalid_email');
    const authKey = bytes32(body.authKey);
    await hit('login-ip', ctx.ip, 40, 15 * MIN);
    const { eh, user: found } = await userByEmail(keys, email);
    const u = found?.emailVerified ? found : null;
    const lock = await lockOf(eh, ctx.ip);
    if (lock.until > now()) throw httpError(429, 'account_locked', { retryAfter: lock.until - now() });
    const ok = await checkSecret(keys, authKey, u?.auth);
    // Many wrong passwords from many places today: every answer is "we e-mailed you a code", right password
    // or not (only the right one really sends a code), so guessing from many networks tells nothing.
    const attacked = await underAttack(eh);
    if (!u || !ok) {
      await addFailure(eh, ctx.ip);
      if (u) ctx.later(saveUser(u.id, (cur) => (cur ? withEvent(cur, eventOf(ctx, 'login_failed')) : undefined)));
      if (attacked) return startLoginCode(ctx, u, email, eh, { fake: true });
      throw httpError(401, 'invalid_credentials');
    }
    await clearFailures(eh, ctx.ip);
    if (attacked) return startLoginCode(ctx, u, email, eh);
    return afterPassword(ctx, u, body.device);
  },

  'POST auth/login/2fa': async (ctx) => {
    const { keys, body } = ctx;
    const t = await readTicket(keys, body.ticket, 'mfa');
    const u = await getUser(t.sub);
    if (!u?.totp?.enabled || (u.security?.sv || 1) !== t.sv) throw httpError(401, 'invalid_ticket');
    await hit('mfa', u.id, 10, 15 * MIN);
    if (!(await checkSecondFactor(ctx, u, body))) {
      ctx.later(saveUser(u.id, (cur) => (cur ? withEvent(cur, eventOf(ctx, 'mfa_failed')) : undefined)));
      throw httpError(400, 'invalid_code');
    }
    return finishLogin(ctx, await getUser(u.id), { device: body.device });
  },

  // The code e-mailed when the account is under attack (see auth/login).
  'POST auth/login/email': async (ctx) => {
    const { keys, body } = ctx;
    const t = await readTicket(keys, body.ticket, 'login-email');
    if (t.ch !== body.challengeId) throw httpError(400, 'invalid_code');
    await hit('verify-ip', ctx.ip, 40, HOUR);
    const rec = await checkChallenge(ctx, body.challengeId, body.code, 'login');
    const u = await getUser(t.sub);
    if (!u || rec.userId !== u.id || (u.security?.sv || 1) !== t.sv) throw httpError(401, 'invalid_ticket');
    // Password AND the e-mail code: it is the owner, so this network's waits end (the count of wrong passwords
    // from everywhere stays: someone else may still be guessing).
    await clearFailures(u.emailHash, ctx.ip);
    return afterPassword(ctx, u, body.device);
  },

  'POST auth/reset/start': async (ctx) => {
    const { keys, env, body } = ctx;
    const email = normEmail(body.email);
    if (!email) throw httpError(400, 'invalid_email');
    if (!emailEnabled(env)) throw httpError(503, 'email_not_configured');
    await hit('reset-ip', ctx.ip, 20, HOUR);
    const { eh, user: u } = await userByEmail(keys, email);
    await hit('reset-email', eh, 5, HOUR);
    if (!u?.emailVerified) {
      const fake = await newChallenge(keys, { type: 'reset', emailHash: eh, fake: true, lang: 'pt' });
      await sendNow(env, null);
      return json({ challengeId: fake.id, email: maskEmail(email) });
    }
    const ch = await newChallenge(keys, { type: 'reset', userId: u.id, emailHash: eh, to: email, lang: u.lang });
    await sendNow(env, email, 'reset', { code: ch.code }, u.lang);
    return json({ challengeId: ch.id, email: maskEmail(email) });
  },

  // Code from the e-mail (+ authenticator code when 2FA is on) -> what the device needs to set a new password.
  'POST auth/reset/verify': async (ctx) => {
    const { keys, body } = ctx;
    await hit('verify-ip', ctx.ip, 40, HOUR);
    const rec = await checkChallenge(ctx, body.challengeId, body.code, 'reset', { consume: false });
    const u = await getUser(rec.userId);
    if (!u) throw httpError(400, 'invalid_code');
    if (u.totp?.enabled) {
      if (!body.totp && !body.backup) return json({ need2fa: true });
      await hit('mfa', u.id, 10, 15 * MIN);
      if (!(await checkSecondFactor(ctx, u, { code: body.totp, backup: body.backup }))) throw httpError(400, 'invalid_2fa');
    }
    // Used up atomically: two requests with the same code can't both get a reset ticket.
    const used = await update('auth', `c:${rec.id}`, (cur) => (cur ? null : undefined));
    if (!used.changed) throw httpError(400, 'invalid_code');
    return json({
      ticket: await ticket(keys, { typ: 'reset', sub: u.id, kv: u.keys?.keyVersion || 0 }, 20 * MIN),
      share: await keyShare(keys, u.id),
      recovery: u.keys?.recovery ? { wrap: u.keys.recovery.wrap } : null,
      hasKeys: !!u.keys,
    });
  },

  // mode "recovery": the recovery key opened the data key -> same data, new password.
  // mode "fresh": no recovery key -> new keys; the old encrypted cloud copy can't be opened anymore.
  'POST auth/reset/finish': async (ctx) => {
    const { keys, body, env } = ctx;
    const t = await readTicket(keys, body.ticket, 'reset');
    const u = await getUser(t.sub);
    if (!u || (u.keys?.keyVersion || 0) !== t.kv) throw httpError(401, 'invalid_ticket');
    const kdf = validKdf(body.kdf);
    if (!kdf) throw httpError(400, 'invalid_kdf');
    const auth = await hashSecret(keys, bytes32(body.authKey));
    let nextKeys;
    if (body.mode === 'recovery') {
      if (!u.keys?.recovery) throw httpError(400, 'no_recovery');
      if (!(await checkSecret(keys, bytes32(body.recoveryAuth), u.keys.recovery.auth))) throw httpError(400, 'invalid_recovery');
      const k = validKeys(body.keys, { full: false });
      nextKeys = { ...u.keys, wrappedDataKey: k.wrappedDataKey };
    } else if (body.mode === 'fresh') {
      const k = validKeys(body.keys);
      nextKeys = {
        keyVersion: (u.keys?.keyVersion || 0) + 1, wrappedDataKey: k.wrappedDataKey, publicKey: k.publicKey, wrappedPrivateKey: k.wrappedPrivateKey,
        recovery: { wrap: k.recovery.wrap, auth: await hashSecret(keys, bytes32(k.recovery.authB64)) }, setAt: now(),
      };
    } else throw httpError(400, 'invalid_mode');
    const fresh = body.mode === 'fresh';
    await consumeTicket(t);
    const oldSessions = u.sessions || [];
    await saveUser(u.id, (cur) => (cur ? withEvent({
      ...cur, kdf, auth, keys: nextKeys, sessions: [], security: { ...(cur.security || {}), sv: (cur.security?.sv || 1) + 1, pwv: (cur.security?.pwv || 1) + 1 },
      // New keys: the phone links and notifications of the old ones stop (whoever reset must set them up again).
      ...(fresh ? { wallet: { tokens: [] }, push: [], pins: [] } : {}),
    }, eventOf(ctx, fresh ? 'password_reset_fresh' : 'password_reset')) : undefined));
    if (fresh) await dropAllPins(u);
    await endSessions(u.id, oldSessions, 'password_reset');
    await clearFailures(u.emailHash, ctx.ip);
    await (await getKV('auth')).delete(`lg:${u.emailHash}`).catch(() => {});
    if (fresh) await accountHooks.onKeysReplaced?.(u);
    const email = await emailOf(keys, u);
    if (email) ctx.later(sendAccountEmail(env, email, 'passwordChanged', { reset: true, when: fmtWhen(now(), u.lang), device: deviceInfo(ctx, body.device).name }, u.lang));
    return finishLogin(ctx, await getUser(u.id), { device: body.device, first: true });
  },
};

/** The password was right: finish the sign-up, ask for the authenticator code, or sign in. */
async function afterPassword(ctx, u, device) {
  const { keys } = ctx;
  if (!u.keys) {
    // Confirmed but the keys were never saved (app closed in the middle of sign-up): finish now.
    return json({ setup: true, ticket: await ticket(keys, { typ: 'setup', sub: u.id }, 30 * MIN), userId: u.id, share: await keyShare(keys, u.id) });
  }
  if (u.totp?.enabled) {
    return json({ need2fa: true, ticket: await ticket(keys, { typ: 'mfa', sub: u.id, sv: u.security?.sv || 1 }, 5 * MIN) });
  }
  return finishLogin(ctx, u, { device });
}

/**
 * Account under attack: a code sent to the e-mail (see auth/login). fake = wrong password or unknown e-mail:
 * the same answer, but no code is sent and none can work (nobody learns whether the password was right).
 */
async function startLoginCode(ctx, u, email, eh, { fake = false } = {}) {
  // Separate budgets: wrong guesses (counted per network) never use up the owner's own codes.
  if (fake) await hit('login-code-net', `${eh}:${netOf(ctx.ip)}`, 6, HOUR);
  else await hit('login-code', eh, 6, HOUR);
  const sub = u?.id || `u_${toB64((await hmac(ctx.keys.pepper, `fake-user:${eh}`)).subarray(0, 12))}`;
  const ch = fake
    ? await newChallenge(ctx.keys, { type: 'login', emailHash: eh, fake: true, lang: u?.lang || 'pt' })
    : await newChallenge(ctx.keys, { type: 'login', userId: u.id, emailHash: eh, to: email, lang: u.lang });
  await sendNow(ctx.env, fake ? null : email, 'loginCode', { code: ch.code }, u?.lang || 'pt');
  return json({
    needEmail: true, challengeId: ch.id, email: maskEmail(email),
    ticket: await ticket(ctx.keys, { typ: 'login-email', sub, sv: u?.security?.sv || 1, ch: ch.id }, 45 * MIN),
  });
}

export const accountRoutes = {
  // Called when the app opens: is this device still signed in? (and rotates the cookie now and then)
  'GET account/session': async (ctx) => {
    const { user, session } = await requireSession(ctx, { rotate: true });
    return json({
      user: await publicUser(ctx.keys, user), keyVersion: user.keys?.keyVersion || 0, sessionId: session.id,
      ofSignal: user.of?.signal || 0,
    });
  },

  'POST account/logout': async (ctx) => {
    let s = null;
    try { ({ session: s } = await requireSession(ctx)); } catch { /* already gone */ }
    if (s) {
      await (await getKV('sessions')).delete(`s:${s.id}`);
      await saveUser(s.userId, (u) => (u ? withEvent({ ...u, sessions: (u.sessions || []).filter((x) => x !== s.id) }, eventOf(ctx, 'logout')) : undefined)).catch(() => {});
      await accountHooks.onSessionsEnded?.(s.userId, [s.id]);
    }
    ctx.setCookie = clearCookie(ctx.env);
    return json({ ok: true });
  },

  'GET account/devices': async (ctx) => {
    const { user, session } = await requireSession(ctx);
    const store = await getKV('sessions');
    const out = [];
    for (const sid of user.sessions || []) {
      const s = await store.get(`s:${sid}`);
      if (!s || s.revoked) continue;
      out.push({ id: s.id, name: s.device?.name, platform: s.device?.platform, createdAt: s.createdAt, lastSeen: s.lastSeen, geo: s.geo, current: s.id === session.id });
    }
    return json({ devices: out });
  },

  // Signs one device out. wipe=true also erases the BloomFi data on it the next time it goes online.
  'POST account/devices/revoke': async (ctx) => {
    const { user, session } = await requireSession(ctx);
    const id = String(ctx.body.id || '');
    if (!(user.sessions || []).includes(id) || id === session.id) throw httpError(404, 'not_found');
    const s = await (await getKV('sessions')).get(`s:${id}`);
    await revokeSession(id, { wipe: !!ctx.body.wipe, by: session.id });
    await saveUser(user.id, (u) => (u ? withEvent({ ...u, sessions: (u.sessions || []).filter((x) => x !== id) }, eventOf(ctx, ctx.body.wipe ? 'device_wiped' : 'device_removed', { target: s?.device?.name || '' })) : undefined));
    await accountHooks.onSessionsEnded?.(user.id, [id]);
    return json({ ok: true });
  },

  'POST account/devices/revoke-others': async (ctx) => {
    const { user, session } = await requireSession(ctx);
    const others = (user.sessions || []).filter((x) => x !== session.id);
    for (const id of others) await revokeSession(id, { wipe: !!ctx.body.wipe, by: session.id });
    // A new "session version" also ends any session we may not know about. This device moves first,
    // so its own requests keep working while the account changes.
    const sv = (user.security?.sv || 1) + 1;
    await update('sessions', `s:${session.id}`, (cur) => (cur && !cur.revoked ? { ...cur, sv: Math.max(sv, cur.sv || 1) } : undefined));
    await saveUser(user.id, (u) => (u ? withEvent({ ...u, sessions: [session.id], security: { ...(u.security || {}), sv: Math.max(sv, u.security?.sv || 1) } }, eventOf(ctx, 'signed_out_everywhere')) : undefined));
    await accountHooks.onSessionsEnded?.(user.id, others);
    return json({ ok: true, removed: others.length });
  },

  'GET account/activity': async (ctx) => {
    const { user } = await requireSession(ctx);
    return json({ events: (user.events || []).slice(0, 40) });
  },

  // Password (+ 2FA code) again before one sensitive change. Returns a 10-minute, single-use ticket for it.
  'POST account/reauth': async (ctx) => {
    const { user, session } = await requireSession(ctx);
    const scope = String(ctx.body.scope || '');
    if (!REAUTH_SCOPES.includes(scope)) throw httpError(400, 'invalid_scope');
    // Counted per device: guesses on a stolen, unlocked phone are slow, and too many sign that device out.
    await hit('reauth', session.id, 6, 15 * MIN);
    if (!(await checkSecret(ctx.keys, bytes32(ctx.body.authKey), user.auth))) {
      let n = 0;
      await update('auth', `rf:${session.id}`, (cur) => {
        const rec = cur && cur.since > now() - DAY ? cur : { n: 0, since: now() };
        n = rec.n + 1;
        return { n, since: rec.since, until: now() + DAY };
      }).catch(() => {});
      ctx.later(saveUser(user.id, (u) => (u ? withEvent(u, eventOf(ctx, 'reauth_failed')) : undefined)));
      if (n >= 10) {
        await revokeSession(session.id, { reason: 'reauth_failures', wipe: false });
        await saveUser(user.id, (u) => (u ? { ...u, sessions: (u.sessions || []).filter((x) => x !== session.id) } : undefined)).catch(() => {});
        await accountHooks.onSessionsEnded?.(user.id, [session.id]);
        throw httpError(401, 'session_revoked', { wipe: false, reason: 'reauth_failures' });
      }
      throw httpError(401, 'invalid_credentials');
    }
    let mfa = false;
    if (user.totp?.enabled) {
      if (!ctx.body.code && !ctx.body.backup) return json({ need2fa: true });
      if (!(await checkSecondFactor(ctx, user, ctx.body))) throw httpError(400, 'invalid_2fa');
      mfa = true;
    }
    await (await getKV('auth')).delete(`rf:${session.id}`).catch(() => {});
    return json({
      ticket: await ticket(ctx.keys, { typ: 'reauth', sub: user.id, sid: session.id, mfa, scope }, 10 * MIN),
      share: await keyShare(ctx.keys, user.id),
    });
  },

  'POST account/password': async (ctx) => {
    const ss = await requireSession(ctx);
    const t = await readReauth(ctx, ctx.body.reauth, ss, 'password');
    const kdf = validKdf(ctx.body.kdf);
    if (!kdf) throw httpError(400, 'invalid_kdf');
    const auth = await hashSecret(ctx.keys, bytes32(ctx.body.authKey));
    const k = validKeys(ctx.body.keys, { full: false });
    await spendReauth(t);
    const others = !!ctx.body.signOutOthers;
    const drop = (ss.user.sessions || []).filter((x) => x !== ss.session.id);
    const sv = (ss.user.security?.sv || 1) + 1;
    if (others) await update('sessions', `s:${ss.session.id}`, (cur) => (cur && !cur.revoked ? { ...cur, sv: Math.max(sv, cur.sv || 1) } : undefined));
    let pwv = 1;
    await saveUser(ss.user.id, (u) => {
      if (!u) return undefined;
      pwv = (u.security?.pwv || 1) + 1;
      return withEvent({
        ...u, kdf, auth, keys: { ...u.keys, wrappedDataKey: k.wrappedDataKey },
        security: { ...(u.security || {}), pwv, ...(others ? { sv: Math.max(sv, u.security?.sv || 1) } : {}) },
        ...(others ? { sessions: [ss.session.id] } : {}),
      }, eventOf(ctx, 'password_changed'));
    });
    if (others) await endSessions(ss.user.id, drop, 'password_changed');
    await (await getKV('auth')).delete(`lg:${ss.user.emailHash}`).catch(() => {});
    const email = await emailOf(ctx.keys, ss.user);
    if (email) ctx.later(sendAccountEmail(ctx.env, email, 'passwordChanged', { when: fmtWhen(now(), ss.user.lang), device: ss.session.device?.name || '' }, ss.user.lang));
    return json({ ok: true, pwv });
  },

  'POST account/recovery': async (ctx) => {
    const ss = await requireSession(ctx);
    const t = await readReauth(ctx, ctx.body.reauth, ss, 'recovery');
    const wrap = ctx.body.wrap;
    if (!isBox(wrap, 64)) throw httpError(400, 'invalid_keys');
    const auth = await hashSecret(ctx.keys, bytes32(ctx.body.auth));
    await spendReauth(t);
    await saveUser(ss.user.id, (u) => (u?.keys ? withEvent({ ...u, keys: { ...u.keys, recovery: { wrap: pick(wrap), auth } } }, eventOf(ctx, 'recovery_key_changed')) : undefined));
    return json({ ok: true });
  },

  'POST account/2fa/setup': async (ctx) => {
    const ss = await requireSession(ctx);
    const t = await readReauth(ctx, ctx.body.reauth, ss, '2fa');
    await spendReauth(t);
    const secret = randomBytes(20);
    const email = (await emailOf(ctx.keys, ss.user)) || 'conta';
    const sealed = await seal(ctx.keys, { s: toB64(secret) }, 'totp');
    await saveUser(ss.user.id, (u) => (u ? { ...u, totpPending: { secret: sealed, exp: now() + 15 * MIN } } : undefined));
    const b32 = base32(secret);
    return json({ secret: b32, uri: `otpauth://totp/BloomFi:${encodeURIComponent(email)}?secret=${b32}&issuer=BloomFi&algorithm=SHA1&digits=6&period=30` });
  },

  'POST account/2fa/enable': async (ctx) => {
    const ss = await requireSession(ctx);
    const u = ss.user;
    await hit('mfa', u.id, 10, 15 * MIN);
    if (!u.totpPending || u.totpPending.exp < now()) throw httpError(400, 'setup_expired');
    const box = await unseal(ctx.keys, u.totpPending.secret, 'totp');
    const step = await verifyTotp(fromB64(box.s), ctx.body.code);
    if (step == null) throw httpError(400, 'invalid_code');
    const codes = newBackupCodes();
    const backup = [];
    for (const c of codes) backup.push({ h: await backupHash(ctx, u.id, c), used: 0 });
    let done = false;
    await saveUser(u.id, (cur) => {
      done = false;
      if (!cur?.totpPending || cur.totpPending.secret?.ct !== u.totpPending.secret?.ct) return undefined; // finished meanwhile
      done = true;
      return withEvent({ ...cur, totpPending: null, totp: { secret: cur.totpPending.secret, enabled: true, lastStep: step, backup, at: now() } }, eventOf(ctx, '2fa_on'));
    });
    if (!done) throw httpError(400, 'setup_expired');
    const email = await emailOf(ctx.keys, u);
    if (email) ctx.later(sendAccountEmail(ctx.env, email, 'twoFactor', { on: true }, u.lang));
    return json({ ok: true, backupCodes: codes });
  },

  'POST account/2fa/disable': async (ctx) => {
    const ss = await requireSession(ctx);
    const t = await readReauth(ctx, ctx.body.reauth, ss, '2fa');
    if (ss.user.totp?.enabled && !t.mfa) throw httpError(401, 'invalid_ticket');
    await spendReauth(t);
    await saveUser(ss.user.id, (u) => (u ? withEvent({ ...u, totp: null, totpPending: null }, eventOf(ctx, '2fa_off')) : undefined));
    const email = await emailOf(ctx.keys, ss.user);
    if (email) ctx.later(sendAccountEmail(ctx.env, email, 'twoFactor', { on: false }, ss.user.lang));
    return json({ ok: true });
  },

  'POST account/2fa/backup': async (ctx) => {
    const ss = await requireSession(ctx);
    const t = await readReauth(ctx, ctx.body.reauth, ss, '2fa');
    if (!ss.user.totp?.enabled || !t.mfa) throw httpError(400, 'invalid_ticket');
    await spendReauth(t);
    const codes = newBackupCodes();
    const backup = [];
    for (const c of codes) backup.push({ h: await backupHash(ctx, ss.user.id, c), used: 0 });
    await saveUser(ss.user.id, (u) => (u?.totp ? withEvent({ ...u, totp: { ...u.totp, backup } }, eventOf(ctx, 'backup_codes_new')) : undefined));
    return json({ backupCodes: codes });
  },

  // ----- PIN with the server's help -----
  // The device keeps the PIN box; the server keeps a secret it gives back only for the right PIN (10 tries,
  // then the PIN is erased). A copy of the device can't be brute-forced offline, and the server alone has no box.
  'POST account/pin': async (ctx) => {
    const { user } = await requireSession(ctx);
    await hit('pin-set', user.id, 10, HOUR);
    const proof = bytes32(ctx.body.proof);
    const old = String(ctx.body.replace || '');
    const id = randomId(12);
    const pepper = randomBytes(32);
    await (await getKV('auth')).set(`pin:${id}`, {
      id, userId: user.id, proof: await hashSecret(ctx.keys, proof), pepper: await seal(ctx.keys, { p: toB64(pepper) }, 'pin'), fails: 0, at: now(), lastAt: now(),
    });
    let dropped = [];
    await saveUser(user.id, (u) => {
      if (!u) return undefined;
      const list = [...(u.pins || []).filter((x) => x !== old && x !== id), id];
      dropped = list.slice(0, Math.max(0, list.length - 20));
      return { ...u, pins: list.slice(-20) };
    });
    if (ID_RE.test(old)) await dropPin(user.id, old);
    for (const d of dropped) await dropPin(user.id, d);
    return json({ id, pepper: toB64(pepper) });
  },

  'POST account/pin/unlock': async (ctx) => {
    const { user } = await requireSession(ctx);
    const id = String(ctx.body.id || '');
    if (!ID_RE.test(id) || !(user.pins || []).includes(id)) throw httpError(404, 'no_pin');
    await hit('pin', `${user.id}:${id}`, 12, 15 * MIN);
    const proof = bytes32(ctx.body.proof);
    const peek = await (await getKV('auth')).get(`pin:${id}`);
    if (!peek || peek.userId !== user.id) throw httpError(404, 'no_pin');
    const good = await checkSecret(ctx.keys, proof, peek.proof);
    // Counted in the same compare-and-set as the check: many tries at once still stop at 10.
    let outcome = null;
    let left = 0;
    let rec = null;
    await update('auth', `pin:${id}`, (cur) => {
      outcome = null; left = 0; rec = cur;
      if (!cur || cur.userId !== user.id || cur.proof?.hash !== peek.proof?.hash) { outcome = 'gone'; return undefined; }
      if (cur.fails >= PIN_TRIES) { outcome = 'locked'; return null; }
      if (good) { outcome = 'ok'; return { ...cur, fails: 0, lastAt: now() }; }
      const fails = cur.fails + 1;
      left = Math.max(0, PIN_TRIES - fails);
      outcome = fails >= PIN_TRIES ? 'locked' : 'wrong';
      return fails >= PIN_TRIES ? null : { ...cur, fails };
    });
    if (outcome === 'ok') return json({ pepper: (await unseal(ctx.keys, rec.pepper, 'pin')).p });
    if (outcome === 'locked') {
      ctx.later(saveUser(user.id, (u) => (u ? withEvent({ ...u, pins: (u.pins || []).filter((x) => x !== id) }, eventOf(ctx, 'pin_locked')) : undefined)));
      throw httpError(423, 'pin_locked');
    }
    if (outcome === 'wrong') throw httpError(400, 'wrong_pin', { attemptsLeft: left });
    throw httpError(404, 'no_pin');
  },

  'POST account/pin/remove': async (ctx) => {
    const { user } = await requireSession(ctx);
    const id = String(ctx.body.id || '');
    if (ID_RE.test(id)) await dropPin(user.id, id);
    return json({ ok: true });
  },

  'POST account/profile': async (ctx) => {
    const { user } = await requireSession(ctx);
    const name = ctx.body.name != null ? cleanText(ctx.body.name, 60) : null;
    if (ctx.body.name != null && !name) throw httpError(400, 'invalid_name');
    const pii = name ? { ...(await unseal(ctx.keys, user.pii)), name } : null;
    const sealed = pii ? await seal(ctx.keys, pii) : null;
    await saveUser(user.id, (u) => {
      if (!u) return undefined;
      const prefs = { ...(u.prefs || {}) };
      if (typeof ctx.body.pushDetail === 'boolean') prefs.pushDetail = ctx.body.pushDetail;
      if (typeof ctx.body.captureAlerts === 'boolean') prefs.captureAlerts = ctx.body.captureAlerts;
      // Instant alert for phone payments above this amount (0 = off).
      if (ctx.body.bigPurchase !== undefined) {
        const v = Number(ctx.body.bigPurchase);
        if (!Number.isFinite(v) || v < 0 || v > 10_000_000) throw httpError(400, 'invalid_amount');
        prefs.bigPurchase = Math.round(v * 100) / 100;
      }
      if (typeof ctx.body.currency === 'string' && /^[A-Z]{3}$/.test(ctx.body.currency)) prefs.currency = ctx.body.currency;
      return { ...u, ...(sealed ? { pii: sealed } : {}), ...(ctx.body.lang === 'en' || ctx.body.lang === 'pt' ? { lang: ctx.body.lang } : {}), prefs };
    });
    return json({ ok: true });
  },

  'POST account/email': async (ctx) => {
    const ss = await requireSession(ctx);
    const t = await readReauth(ctx, ctx.body.reauth, ss, 'email');
    const email = normEmail(ctx.body.email);
    if (!email) throw httpError(400, 'invalid_email');
    if (!emailEnabled(ctx.env)) throw httpError(503, 'email_not_configured');
    await hit('email-change', ss.user.id, 5, HOUR);
    await spendReauth(t);
    const { eh, user: other } = await userByEmail(ctx.keys, email);
    if (other?.emailVerified) {
      // Same answer as a free e-mail (no "this e-mail has an account"); that address gets a short notice.
      const fake = await newChallenge(ctx.keys, { type: 'email_change', emailHash: eh, fake: true, lang: ss.user.lang });
      if (await once(`inuse:${eh}`, HOUR)) await sendNow(ctx.env, email, 'emailInUse', {}, other.lang).catch(() => {});
      else await sendNow(ctx.env, null);
      return json({ challengeId: fake.id, email: maskEmail(email) });
    }
    const ch = await newChallenge(ctx.keys, { type: 'email_change', userId: ss.user.id, emailHash: eh, to: email, lang: ss.user.lang, newEmail: await seal(ctx.keys, { email }) });
    await sendNow(ctx.env, email, 'emailChange', { code: ch.code }, ss.user.lang);
    return json({ challengeId: ch.id, email: maskEmail(email) });
  },

  'POST account/email/verify': async (ctx) => {
    const ss = await requireSession(ctx);
    const rec = await checkChallenge(ctx, ctx.body.challengeId, ctx.body.code, 'email_change');
    if (rec.userId !== ss.user.id) throw httpError(400, 'invalid_code');
    const { email } = await unseal(ctx.keys, rec.newEmail);
    const oldEmail = await emailOf(ctx.keys, ss.user);
    // Takes the new e-mail only if it is still free (compare-and-set), then frees the old one.
    let taken = false;
    await update('index', `e:${rec.emailHash}`, async (cur) => {
      taken = false;
      if (cur?.userId && cur.userId !== ss.user.id && (await getUser(cur.userId))?.emailVerified) { taken = true; return undefined; }
      return { userId: ss.user.id };
    });
    if (taken) throw httpError(409, 'email_taken');
    const oldHash = ss.user.emailHash;
    const pii = { ...(await unseal(ctx.keys, ss.user.pii)), email };
    const sealed = await seal(ctx.keys, pii);
    await saveUser(ss.user.id, (u) => (u ? withEvent({ ...u, pii: sealed, emailHash: rec.emailHash, emailVerified: true }, eventOf(ctx, 'email_changed')) : undefined));
    if (oldHash !== rec.emailHash) await (await getKV('index')).delete(`e:${oldHash}`);
    // The old address is told (if someone else did this, the owner finds out right away).
    if (oldEmail && oldEmail !== email) {
      ctx.later(sendAccountEmail(ctx.env, oldEmail, 'emailChanged', { to: maskEmail(email), when: fmtWhen(now(), ss.user.lang), device: ss.session.device?.name || '' }, ss.user.lang));
    }
    return json({ ok: true, email });
  },

  // LGPD: deletes the account and everything we keep about it.
  'POST account/delete': async (ctx) => {
    const ss = await requireSession(ctx);
    const t = await readReauth(ctx, ctx.body.reauth, ss, 'delete');
    await spendReauth(t);
    const u = await getUser(ss.user.id);
    const email = await emailOf(ctx.keys, u);
    await accountHooks.onDelete?.(ctx, u);
    await dropAllPins(u);
    const store = await getKV('sessions');
    for (const sid of u.sessions || []) await store.delete(`s:${sid}`).catch(() => {});
    await (await getKV('index')).delete(`e:${u.emailHash}`);
    await (await getKV('users')).delete(`u:${u.id}`);
    if (email) ctx.later(sendAccountEmail(ctx.env, email, 'deleted', {}, u.lang));
    ctx.setCookie = clearCookie(ctx.env);
    return json({ ok: true });
  },
};

const PIN_TRIES = 10;
async function dropPin(userId, id) {
  await update('auth', `pin:${id}`, (cur) => (cur && cur.userId === userId ? null : undefined)).catch(() => {});
  await saveUser(userId, (u) => (u && (u.pins || []).includes(id) ? { ...u, pins: u.pins.filter((x) => x !== id) } : undefined)).catch(() => {});
}
async function dropAllPins(user) {
  const store = await getKV('auth');
  for (const id of user.pins || []) await store.delete(`pin:${id}`).catch(() => {});
}

// ---------------- legacy (v3/v4) subscriptions ----------------
async function readLegacy(env, legacy) {
  if (!legacy?.accountToken) return null;
  const t = await verifyHS(String(legacy.accountToken), env.appSecret);
  if (!t || t.typ !== 'account') return null;
  return { kind: t.kind, sub: t.sub, email: t.email || null, until: t.until || null, plan: typeof t.plan === 'string' ? t.plan.slice(0, 20) : null };
}
/**
 * Gift codes and old subscription tokens: a gift made for an e-mail only works for the account with that
 * (confirmed) e-mail, and each code/token belongs to the first account that uses it.
 */
async function claimLegacy(legacy, user, email) {
  if (!legacy?.sub) throw httpError(400, 'invalid_code');
  if (legacy.kind === 'gift' && legacy.email && normEmail(legacy.email) !== email) throw httpError(403, 'code_other_email');
  let mine = false;
  await update('index', `redeem:${toB64((await sha256(`${legacy.kind}:${legacy.sub}`)).subarray(0, 24))}`, (cur) => {
    mine = false;
    if (cur?.userId && cur.userId !== user.id) return undefined;
    mine = true;
    return cur?.userId ? undefined : { userId: user.id, at: now() };
  });
  if (!mine) throw httpError(409, 'code_used');
  return legacy;
}
function linkLegacy(billing = {}, legacy) {
  if (!legacy) return {};
  const out = { legacySubs: [...new Set([...(billing.legacySubs || []), legacy.sub])] };
  if (legacy.kind === 'stripe' && !billing.stripeCustomer) out.stripeCustomer = legacy.sub;
  if (legacy.kind === 'gift' && legacy.until) {
    out.giftUntil = Math.max(billing.giftUntil || 0, legacy.until);
    out.giftPlan = legacy.plan || null; // the plan the code gives (the last code used counts); none = the first plan
  }
  return out;
}
export { linkLegacy, readLegacy, claimLegacy };

/** Hourly cleanup of expired challenges, rate limits, unverified sign-ups and old sessions. */
export async function cleanupAuth(budgetMs = 15000) {
  const started = Date.now();
  const t = now();
  let removed = 0;
  const auth = await getKV('auth');
  for (const k of await auth.keys()) {
    if (Date.now() - started > budgetMs) break;
    const v = await auth.get(k);
    const dead = !v || (k.startsWith('c:') && v.exp < t - HOUR) || (k.startsWith('rl:') && v.reset < t)
      || (k.startsWith('lf:') && v.last < t - DAY) || (k.startsWith('lg:') && v.since < t - DAY)
      || ((k.startsWith('once:') || k.startsWith('used:') || k.startsWith('rf:')) && v.until < t)
      || (k.startsWith('pin:') && (v.lastAt || 0) < t - 400 * DAY);
    if (dead) { await auth.delete(k); removed++; }
  }
  const sessions = await getKV('sessions');
  for (const k of await sessions.keys('s:')) {
    if (Date.now() - started > budgetMs * 1.6) break;
    const s = await sessions.get(k);
    if (!s || (s.purgeAt && s.purgeAt < t) || s.expiresAt < t || t - s.lastSeen > SESSION_IDLE) { await sessions.delete(k); removed++; }
  }
  const users = await getKV('users');
  const idx = await getKV('index');
  for (const k of await users.keys('u:')) {
    if (Date.now() - started > budgetMs * 2) break;
    const u = await users.get(k);
    if (u && !u.emailVerified && u.pendingUntil && u.pendingUntil < t) {
      if ((await idx.get(`e:${u.emailHash}`))?.userId === u.id) await idx.delete(`e:${u.emailHash}`);
      await users.delete(k);
      removed++;
    }
  }
  return { removed };
}
