/**
 * Web Push (RFC 8030) with VAPID (RFC 8292) and encrypted payloads (RFC 8291, aes128gcm),
 * written on Web Crypto so it runs on Netlify Functions with no extra packages.
 */
import { b64url } from './crypto.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** Public VAPID key as the browser wants it: uncompressed P-256 point (65 bytes), base64url. */
export function vapidPublicKey(jwk) {
  return b64url.encode(concat(new Uint8Array([4]), b64url.decode(jwk.x), b64url.decode(jwk.y)));
}

let vapidKeyCache = null;
async function vapidSigner(jwk) {
  if (!vapidKeyCache || vapidKeyCache.x !== jwk.x) {
    vapidKeyCache = { x: jwk.x, key: await subtle.importKey('jwk', { ...jwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  }
  return vapidKeyCache.key;
}

async function vapidHeader(endpoint, jwk, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64url.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64url.encode(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidSigner(jwk), enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64url.encode(sig)}, k=${vapidPublicKey(jwk)}`;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** Encrypts `plaintext` for one subscription (keys.p256dh, keys.auth). Returns the request body. */
export async function encryptPayload(keys, plaintext) {
  const uaPublic = b64url.decode(keys.p256dh);
  const authSecret = b64url.decode(keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad_subscription_keys');
  const server = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await subtle.exportKey('raw', server.publicKey));
  const uaKey = await subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, server.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const data = concat(enc.encode(plaintext), new Uint8Array([2])); // 0x02 = last record, no padding
  const aes = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, data));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, ct);
}

/**
 * Sends one notification. Returns 'sent', 'gone' (subscription expired: delete it) or 'failed'.
 */
export async function sendPush(sub, message, { jwk, subject, ttl = 24 * 3600 }) {
  const body = await encryptPayload(sub.keys, JSON.stringify(message));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(sub.endpoint, jwk, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'normal',
    },
    body,
  });
  if (res.status === 404 || res.status === 410) return 'gone';
  return res.ok ? 'sent' : 'failed';
}

/** Only real push services (and localhost in test mode) may receive our requests. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /^android\.googleapis\.com$/];
export function allowedEndpoint(endpoint, allowLocal = false) {
  try {
    const u = new URL(endpoint);
    if (allowLocal && u.hostname === 'localhost') return true;
    return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}
