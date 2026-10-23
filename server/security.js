/**
 * Security building blocks for accounts (Web Crypto + node:crypto, Node 22+).
 *
 * Every server secret is derived from APP_SECRET with HKDF, one key per purpose,
 * so a single environment variable is enough and no key is ever reused.
 *
 *  - pepper : HMAC key applied to the client's authKey before scrypt (a stolen
 *             database alone can't be used to test passwords)
 *  - share  : per-user "server key share" mixed into the client's encryption key
 *             (a stolen database alone can't be used to open anyone's data, even
 *             with a guessed password)
 *  - pii    : AES-256-GCM for names, e-mails and TOTP secrets at rest
 *  - index  : HMAC for lookup keys (e-mail -> user) so storage keys hold no PII
 *  - tokens : HS256 for short-lived tickets (2FA step, re-auth, reset)
 */
import { scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { b64url } from './crypto.js';

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const toB64 = (u8) => b64url.encode(u8);
export const fromB64 = (s) => b64url.decode(String(s || ''));

export async function hkdf(ikm, { salt = new Uint8Array(0), info = '', length = 32 } = {}) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, key, length * 8);
  return new Uint8Array(bits);
}

export async function hmac(keyBytes, data) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, typeof data === 'string' ? te.encode(data) : data));
}

export async function sha256(data) {
  return new Uint8Array(await subtle.digest('SHA-256', typeof data === 'string' ? te.encode(data) : data));
}

/** Constant-time comparison of two byte arrays (or base64url strings). */
export function sameBytes(a, b) {
  const x = typeof a === 'string' ? fromB64(a) : a;
  const y = typeof b === 'string' ? fromB64(b) : b;
  if (!x || !y || x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(Buffer.from(x), Buffer.from(y));
}

// ---------------- per-purpose server keys ----------------
const keyCache = new Map();
export async function serverKeys(appSecret) {
  if (!appSecret || appSecret.length < 32) throw new Error('APP_SECRET missing or too short (min 32 chars)');
  if (keyCache.has(appSecret)) return keyCache.get(appSecret);
  const ikm = te.encode(appSecret);
  const salt = te.encode('bloomfi-server-v5');
  const one = (info) => hkdf(ikm, { salt, info });
  const k = {
    pepper: await one('pepper'),
    share: await one('key-share'),
    pii: await one('pii-aes'),
    index: await one('lookup-index'),
    fake: await one('fake-salt'),
    hook: await one('webhook'),
    tokens: toB64(await one('tickets')), // used as an HS256 secret string (43 chars)
  };
  keyCache.set(appSecret, k);
  return k;
}

// ---------------- password verifier ----------------
// The client never sends the password, only authKey = HKDF(Argon2id(password)).
// We store scrypt(HMAC(pepper, authKey), salt): slow to brute force, and useless
// without the pepper (which lives in the environment, not in the database).
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
function scrypt(pw, salt) {
  return new Promise((ok, fail) => scryptCb(pw, salt, 32, SCRYPT, (e, k) => (e ? fail(e) : ok(new Uint8Array(k)))));
}

export async function hashSecret(keys, secretBytes, saltB64 = toB64(randomBytes(16))) {
  const peppered = await hmac(keys.pepper, secretBytes);
  const hash = await scrypt(peppered, fromB64(saltB64));
  return { salt: saltB64, hash: toB64(hash) };
}

export async function checkSecret(keys, secretBytes, stored) {
  if (!stored?.salt || !stored?.hash) {
    await hashSecret(keys, secretBytes); // same work when there is nothing to compare (no timing hint)
    return false;
  }
  const { hash } = await hashSecret(keys, secretBytes, stored.salt);
  return sameBytes(hash, stored.hash);
}

/** Server half of the user's encryption key (never stored). */
export async function keyShare(keys, userId) {
  return toB64(await hmac(keys.share, `share:${userId}`));
}

/** Lookup key for an e-mail address (no PII in storage keys). */
export async function emailIndex(keys, email) {
  return toB64(await hmac(keys.index, `email:${email}`));
}

/** Stable fake salt for unknown e-mails, so "does this account exist?" can't be answered from /prelogin. */
export async function fakeSalt(keys, email) {
  return toB64((await hmac(keys.fake, `salt:${email}`)).subarray(0, 16));
}

// ---------------- AES-GCM at rest (PII, TOTP secrets) ----------------
export async function seal(keys, obj, purpose = 'pii') {
  const key = await subtle.importKey('raw', keys.pii, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(purpose) }, key, te.encode(JSON.stringify(obj)));
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export async function unseal(keys, box, purpose = 'pii') {
  if (!box?.iv || !box?.ct) return null;
  const key = await subtle.importKey('raw', keys.pii, 'AES-GCM', false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv), additionalData: te.encode(purpose) }, key, fromB64(box.ct));
  return JSON.parse(td.decode(pt));
}

// ---------------- sealed boxes to the user's public key (ECIES, P-256) ----------------
// Phone captures arrive in plain text over TLS and are immediately encrypted to the
// user's public key; only the user's devices hold the private key.
export const INBOX_INFO = 'bloomfi/inbox/v1';
export async function sealTo(publicJwk, obj) {
  const pub = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256));
  const epk = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const aes = await hkdf(shared, { salt: epk, info: INBOX_INFO });
  const key = await subtle.importKey('raw', aes, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)));
  return { epk: toB64(epk), iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export function validPublicJwk(j) {
  return !!j && j.kty === 'EC' && j.crv === 'P-256' && typeof j.x === 'string' && typeof j.y === 'string'
    && fromB64(j.x).length === 32 && fromB64(j.y).length === 32 && j.d === undefined;
}

// ---------------- TOTP (RFC 6238) ----------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function unbase32(text) {
  const s = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(out);
}

export async function totpAt(secretBytes, step) {
  const msg = new Uint8Array(8);
  let s = step;
  for (let i = 7; i >= 0; i--) { msg[i] = s & 0xff; s = Math.floor(s / 256); }
  const key = await subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** Returns the matching time step (to block reuse of the same code) or null. */
export async function verifyTotp(secretBytes, code, { lastStep = -1, at = Date.now() } = {}) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return null;
  const now = Math.floor(at / 30000);
  for (const step of [now, now - 1, now + 1]) {
    if (step <= lastStep) continue;
    const want = await totpAt(secretBytes, step);
    if (sameBytes(te.encode(want), te.encode(c))) return step;
  }
  return null;
}

/** Ten one-time backup codes like "k7d2-9xqf". */
export function newBackupCodes(n = 10) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => {
    const b = randomBytes(8);
    const s = [...b].map((x) => alphabet[x % alphabet.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}
export const normBackup = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------------- misc ----------------
export function normEmail(raw) {
  const e = String(raw || '').normalize('NFKC').trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(e)) return null;
  return e;
}

/** "f•••@yahoo.com" for messages that should not echo the full address. */
export function maskEmail(email) {
  const [u, d] = String(email).split('@');
  if (!d) return '•••';
  return `${u.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(u.length - 1, 5)))}@${d}`;
}

/** Short human device name from a user agent. */
export function deviceFromUA(ua = '') {
  const s = String(ua);
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android'
    : /Macintosh|Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'Chromebook' : /Linux/.test(s) ? 'Linux' : 'Navegador';
  const br = /Edg\//.test(s) ? 'Edge' : /SamsungBrowser/.test(s) ? 'Samsung Internet' : /OPR\//.test(s) ? 'Opera'
    : /Firefox\//.test(s) ? 'Firefox' : /CriOS|Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}

export const cleanText = (v, max = 80) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
