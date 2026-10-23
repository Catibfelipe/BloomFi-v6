/**
 * Token helpers (Web Crypto, works on Node 20+ and Netlify Functions).
 *
 * - HMAC tokens (APP_SECRET): account tokens and e-mail login challenges.
 *   Only the server can create or read their validity.
 * - ES256 tokens (LICENSE_PRIVATE_JWK): subscription licenses. The app
 *   verifies them offline with the public key, so a subscriber keeps
 *   access without internet until the license expires.
 */
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64url = {
  encode(bytes) {
    const b = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    return new Uint8Array(Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  },
};

const encJSON = (obj) => b64url.encode(enc.encode(JSON.stringify(obj)));
const decJSON = (str) => JSON.parse(dec.decode(b64url.decode(str)));
export const now = () => Math.floor(Date.now() / 1000);

// ---------- HMAC (HS256) ----------
const hmacKeys = new Map();
async function hmacKey(secret) {
  if (!secret || secret.length < 32) throw new Error('APP_SECRET missing or too short (min 32 chars)');
  if (!hmacKeys.has(secret)) {
    hmacKeys.set(secret, await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  }
  return hmacKeys.get(secret);
}

export async function signHS(payload, secret) {
  const head = encJSON({ alg: 'HS256', typ: 'JWT' });
  const body = encJSON(payload);
  const sig = await subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url.encode(sig)}`;
}

export async function verifyHS(token, secret) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const [head, body, sig] = token.split('.');
  if (!head || !body || !sig) return null;
  try {
    const ok = await subtle.verify('HMAC', await hmacKey(secret), b64url.decode(sig), enc.encode(`${head}.${body}`));
    if (!ok) return null;
    const payload = decJSON(body);
    if (payload.exp && payload.exp < now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- ES256 (licenses) ----------
let privKeyCache = null;
export function parseJwk(raw) {
  if (!raw) return null;
  const jwk = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return jwk;
}
export function publicFromPrivate(jwk) {
  if (!jwk) return null;
  const { kty, crv, x, y } = jwk;
  return { kty, crv, x, y, ext: true };
}

async function privateKey(jwk) {
  if (!privKeyCache || privKeyCache.x !== jwk.x) {
    privKeyCache = { x: jwk.x, key: await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  }
  return privKeyCache.key;
}

export async function signES(payload, jwk) {
  const head = encJSON({ alg: 'ES256', typ: 'JWT' });
  const body = encJSON(payload);
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await privateKey(jwk), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url.encode(sig)}`;
}

export async function verifyES(token, publicJwk) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const [head, body, sig] = token.split('.');
  if (!head || !body || !sig) return null;
  try {
    const key = await subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64url.decode(sig), enc.encode(`${head}.${body}`));
    if (!ok) return null;
    const payload = decJSON(body);
    if (payload.exp && payload.exp < now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function generateLicenseKeys() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const priv = await subtle.exportKey('jwk', pair.privateKey);
  const pub = await subtle.exportKey('jwk', pair.publicKey);
  return { priv, pub };
}

export async function sha256hex(text) {
  const buf = await subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomDigits(n) {
  const arr = new Uint32Array(n);
  globalThis.crypto.getRandomValues(arr);
  return [...arr].map((v) => String(v % 10)).join('');
}

export function randomId(bytes = 16) {
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return b64url.encode(arr);
}

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
