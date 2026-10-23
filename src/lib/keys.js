/**
 * BloomFi key hierarchy (runs on the user's device; also in Node for tests).
 *
 *   password ─Argon2id─► masterKey ─┬─HKDF("auth")──────────► authKey  (the only thing the server sees)
 *                                   ├─HKDF("enc", share)────► encKey   wraps the data key on the server
 *                                   └─HKDF("local")─────────► localKey wraps the data key on this device
 *   dataKey (random) ─┬─HKDF("db")──► encrypts every record in the local database
 *                     ├─HKDF("sync")► encrypts the cloud copy shared by the user's devices
 *                     └─HKDF("kp")──► wraps the private key that opens phone captures
 *   recovery key (random, shown once) ─HKDF─► wraps the data key (forgot-password path)
 *   PIN ─Argon2id─► h ─┬─HKDF("pin-proof")──► proof (the server releases its PIN secret only for it, 10 tries)
 *                      └─HKDF(h ‖ server PIN secret)─► wraps the data key on this device (quick unlock):
 *                        a copy of the device alone can't be brute-forced, and the server alone has no box
 *   Face ID / fingerprint (WebAuthn PRF) ─HKDF─► wraps the data key on this device
 */
import { argon2id } from 'hash-wasm';

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const b64u = {
  enc(u8) {
    const b = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(s) {
    const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(t + '==='.slice((t.length + 3) % 4)), (c) => c.charCodeAt(0));
  },
};

export const ACCOUNT_KDF = { alg: 'argon2id', m: 65536, t: 3, p: 1 };
export const PIN_KDF = { alg: 'argon2id', m: 47104, t: 2, p: 1 };
const FALLBACK_KDF = { alg: 'pbkdf2', i: 600000 };

/**
 * The account password's settings come from the server: never derive with anything weaker than our own
 * (a server asking for "PBKDF2, 1 round" would get a password that cracks instantly), nor absurdly heavy.
 */
export function accountKdfOk(k) {
  if (!k || typeof k !== 'object' || k.alg !== 'argon2id') return false;
  const m = Number(k.m), t = Number(k.t), p = Number(k.p);
  let salt;
  try { salt = b64u.dec(k.salt); } catch { return false; }
  return Number.isInteger(m) && Number.isInteger(t) && Number.isInteger(p) && m >= 65536 && m <= 262144 && t >= 3 && t <= 10 && p >= 1 && p <= 4
    && salt.length >= 16 && salt.length <= 32;
}
const weakKdf = () => Object.assign(new Error('weak_kdf'), { code: 'weak_kdf' });

let argonOk = null;
/** Argon2 runs in WebAssembly (some browsers in a locked-down mode block it). */
export async function argonAvailable() {
  if (argonOk != null) return argonOk;
  try {
    await argon2id({ password: 'x', salt: new Uint8Array(16), parallelism: 1, iterations: 1, memorySize: 64, hashLength: 16, outputType: 'binary' });
    argonOk = true;
  } catch { argonOk = false; }
  return argonOk;
}

/**
 * New key-derivation settings. Account passwords and PINs always use Argon2id: when the browser blocks
 * WebAssembly (e.g. iPhone Lockdown Mode) this throws 'wasm_blocked' and the app explains how to allow it.
 * kind 'backup' (a password typed for an exported file) falls back to a very slow PBKDF2 instead.
 */
export async function newKdf(kind = 'account') {
  const salt = b64u.enc(rand(16));
  if (await argonAvailable()) return { ...(kind === 'pin' ? PIN_KDF : ACCOUNT_KDF), salt };
  if (kind === 'backup') return { ...FALLBACK_KDF, i: 2000000, salt };
  throw Object.assign(new Error('wasm_blocked'), { code: 'wasm_blocked' });
}

/** Slow, memory-hard derivation of a secret (password or PIN). `account: true` = settings that came from the server. */
/**
 * Argon2id needs 64 MiB at once. A phone short on memory (many tabs open, the app in the background) can refuse
 * it now and then: that is tried again once after a short pause, and otherwise reported as "kdf_failed" (never as a
 * wrong password). Two derivations never run at the same time (a double tap would ask for 128 MiB).
 */
let argonQueue = Promise.resolve();
function argonOnce(opts) {
  const run = async () => {
    try { return await argon2id(opts); } catch {
      await new Promise((r) => setTimeout(r, 400));
      try { return await argon2id(opts); } catch (e2) { throw Object.assign(new Error('kdf_failed'), { code: 'kdf_failed', cause: e2 }); }
    }
  };
  const next = argonQueue.then(run, run);
  argonQueue = next.catch(() => {});
  return next;
}

export async function deriveMaster(secret, kdf, { account = false } = {}) {
  if (account && !accountKdfOk(kdf)) throw weakKdf();
  const pw = te.encode(String(secret).normalize('NFKC'));
  const salt = b64u.dec(kdf.salt);
  if (kdf.alg === 'argon2id') {
    // Bounds even for local settings (a crafted backup file can't freeze the phone with 4 GB of memory).
    if (!(kdf.m >= 8192 && kdf.m <= 262144 && kdf.t >= 1 && kdf.t <= 10 && kdf.p >= 1 && kdf.p <= 4)) throw weakKdf();
    return argonOnce({ password: pw, salt, parallelism: kdf.p, iterations: kdf.t, memorySize: kdf.m, hashLength: 32, outputType: 'binary' });
  }
  if (kdf.alg === 'pbkdf2') {
    if (!(kdf.i >= 600000 && kdf.i <= 5000000)) throw weakKdf();
    const base = await subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: kdf.i }, base, 256));
  }
  throw Object.assign(new Error('unsupported_kdf'), { code: 'unsupported_kdf' });
}

export async function hkdf(ikm, info, salt = new Uint8Array(0), length = 32) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, key, length * 8));
}

const INFO = {
  auth: 'bloomfi/auth/v1', enc: 'bloomfi/enc/v1', local: 'bloomfi/local/v1', db: 'bloomfi/db/v1', sync: 'bloomfi/sync/v1',
  kp: 'bloomfi/keypair/v1', rec: 'bloomfi/recovery/v1', recAuth: 'bloomfi/recovery-auth/v1', pin: 'bloomfi/pin/v1', inbox: 'bloomfi/inbox/v1',
};

export const authKeyOf = async (master) => b64u.enc(await hkdf(master, INFO.auth));
export const encKeyOf = (master, share) => hkdf(master, INFO.enc, b64u.dec(share));
export const localKeyOf = (master) => hkdf(master, INFO.local);
/** PIN of a device-only account (no server): the box opens with the PIN alone. */
export const pinKeyOf = (pinMaster) => hkdf(pinMaster, INFO.pin);
/** PIN of a server account: what the server checks, and the key that also needs the server's PIN secret. */
export const pinProofOf = async (pinMaster) => b64u.enc(await hkdf(pinMaster, 'bloomfi/pin-proof/v1'));
export async function pinKeyV2(pinMaster, pepperB64) {
  const pepper = b64u.dec(pepperB64);
  if (pepper.length !== 32) throw Object.assign(new Error('wrong_key'), { code: 'wrong_key' });
  const ikm = new Uint8Array(64);
  ikm.set(pinMaster, 0);
  ikm.set(pepper, 32);
  return hkdf(ikm, 'bloomfi/pin-wrap/v2');
}
/** Short, keyed fingerprints of import ids (a copy of the device can't read amounts and dates from them). */
export async function idBlinder(dataKey) {
  const k = await subtle.importKey('raw', await hkdf(dataKey, 'bloomfi/import-ids/v1'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return async (id) => `b:${b64u.enc(new Uint8Array(await subtle.sign('HMAC', k, te.encode(String(id)))).subarray(0, 16))}`;
}

// ---------------- AES-GCM boxes ----------------
export async function aesKey(bytes, usages = ['encrypt', 'decrypt']) {
  return subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, usages);
}
/** Encrypts bytes with a raw 32-byte key -> { iv, ct } (base64url). */
export async function seal(keyBytes, plain, aad) {
  const key = keyBytes instanceof CryptoKey ? keyBytes : await aesKey(keyBytes, ['encrypt']);
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, ...(aad ? { additionalData: te.encode(aad) } : {}) }, key, plain);
  return { iv: b64u.enc(iv), ct: b64u.enc(new Uint8Array(ct)) };
}
/** Throws { code: 'wrong_key' } when the key doesn't open the box. */
export async function open(keyBytes, box, aad) {
  try {
    const key = keyBytes instanceof CryptoKey ? keyBytes : await aesKey(keyBytes, ['decrypt']);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(box.iv), ...(aad ? { additionalData: te.encode(aad) } : {}) }, key, b64u.dec(box.ct)));
  } catch {
    throw Object.assign(new Error('wrong_key'), { code: 'wrong_key' });
  }
}

export const dbKeyOf = async (dataKey) => aesKey(await hkdf(dataKey, INFO.db));
export const syncKeyOf = async (dataKey) => aesKey(await hkdf(dataKey, INFO.sync));
const kpKeyOf = (dataKey) => hkdf(dataKey, INFO.kp);

// ---------------- recovery key ----------------
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function recoveryText(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += CROCK[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += CROCK[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join('-');
}
export function newRecoveryKey() {
  const bytes = rand(20);
  return { bytes, text: recoveryText(bytes) };
}
/** Accepts the key typed in any case, with or without dashes/spaces; O→0 and I/L→1. */
export function parseRecoveryKey(text) {
  const s = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 32 || /[^0-9A-HJKMNP-TV-Z]/.test(s)) return null;
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    value = (value << 5) | CROCK.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
export async function recoveryKeysOf(bytes, share) {
  return { enc: await hkdf(bytes, INFO.rec, b64u.dec(share)), auth: b64u.enc(await hkdf(bytes, INFO.recAuth)) };
}

// ---------------- key pair (phone captures are encrypted to it) ----------------
export async function newKeyPair() {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const jwk = await subtle.exportKey('jwk', kp.privateKey);
  return { publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, privateJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d } };
}
export async function wrapPrivateKey(dataKey, privateJwk) {
  return seal(await kpKeyOf(dataKey), te.encode(JSON.stringify(privateJwk)));
}
export async function unwrapPrivateKey(dataKey, box) {
  return JSON.parse(td.decode(await open(await kpKeyOf(dataKey), box)));
}
/** Opens an entry the server sealed to our public key (ECIES: ECDH P-256 + HKDF + AES-GCM). */
export async function openSealed(privateJwk, box) {
  const priv = await subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const epk = b64u.dec(box.epk);
  const eph = await subtle.importKey('raw', epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: eph }, priv, 256));
  const aes = await hkdf(shared, INFO.inbox, epk);
  return JSON.parse(td.decode(await open(aes, box)));
}

// ---------------- whole account bundles ----------------
/** New account (or a reset without the recovery key): fresh data key, recovery key and key pair. */
export async function createAccountKeys(master, share) {
  const dataKey = rand(32);
  const wrappedDataKey = await seal(await encKeyOf(master, share), dataKey);
  const rk = newRecoveryKey();
  const rks = await recoveryKeysOf(rk.bytes, share);
  const kp = await newKeyPair();
  return {
    dataKey,
    recoveryText: rk.text,
    privateJwk: kp.privateJwk,
    keys: {
      wrappedDataKey,
      recovery: { wrap: await seal(rks.enc, dataKey), auth: rks.auth },
      publicKey: kp.publicJwk,
      wrappedPrivateKey: await wrapPrivateKey(dataKey, kp.privateJwk),
    },
  };
}
export const unwrapDataKey = async (master, share, wrapped) => open(await encKeyOf(master, share), wrapped);

// ---------------- passwords ----------------
const COMMON = new Set(`123456 1234567 12345678 123456789 1234567890 12345678910 password senha senha123 senha1234 qwerty qwerty123
abc123 abcd1234 111111 000000 123123 654321 iloveyou admin admin123 brasil brasil123 flamengo corinthians palmeiras
saopaulo santos gremio vasco cruzeiro internacional botafogo fluminense atletico bahia 102030 10203040 101010 121212 696969
mudar123 mudar@123 senha@123 teste teste123 bloomfi bloomfi123 dinheiro familia jesus deusefiel deus amor amor123 felicidade
princesa beatriz gabriel matheus lucas pedro julia maria joao jose ana carlos paulo rafael bruna amanda camila fernanda
letmein welcome monkey dragon football baseball sunshine master shadow superman batman trustno1 passw0rd p@ssw0rd 1q2w3e4r
1q2w3e 1qaz2wsx zaq12wsx asdfgh asdfghjkl zxcvbnm qazwsx 7777777 88888888 99999999 11111111 12341234 qwertyuiop 147258369
159753 963852741 13579 a1b2c3 a1b2c3d4 abcdef abcdefgh 112233 123321 123qwe qwe123 q1w2e3r4 q1w2e3r4t5 iloveyou1`.split(/\s+/));

/** Problems with a new password (empty array = good). */
export function passwordIssues(pw, { email = '', name = '' } = {}) {
  const issues = [];
  const p = String(pw || '');
  const low = p.toLowerCase();
  if (p.length < 10) issues.push('short');
  if (p.length > 200) issues.push('long');
  const core = low.replace(/[^a-z0-9]/g, '');
  if (COMMON.has(low) || COMMON.has(core) || COMMON.has(core.replace(/\d+$/, ''))) issues.push('common');
  const user = String(email).toLowerCase().split('@')[0];
  const first = String(name).toLowerCase().split(/\s+/)[0];
  if ((user.length >= 4 && low.includes(user)) || (first.length >= 4 && low.includes(first))) issues.push('personal');
  if (/^(.)\1+$/.test(p) || /^\d+$/.test(p) || new Set(p).size < 5) issues.push('simple');
  return issues;
}

/** 0 (very weak) to 4 (very strong): rough entropy estimate, good enough for a meter. */
export function passwordScore(pw) {
  const p = String(pw || '');
  if (!p) return 0;
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/\d/.test(p)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(p)) pool += 33;
  const uniq = new Set(p).size;
  const bits = Math.log2(Math.max(pool, 2)) * Math.min(p.length, uniq * 2);
  if (passwordIssues(p).some((i) => i === 'common' || i === 'simple')) return Math.min(1, bits > 30 ? 1 : 0);
  return bits >= 80 ? 4 : bits >= 60 ? 3 : bits >= 45 ? 2 : bits >= 30 ? 1 : 0;
}

/** Times this password appeared in known leaks (Have I Been Pwned, k-anonymity: only 5 hex chars leave the device). */
export async function pwnedCount(pw, fetchRange) {
  const h = [...new Uint8Array(await subtle.digest('SHA-1', te.encode(String(pw))))].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const text = await fetchRange(h.slice(0, 5));
  const rest = h.slice(5);
  for (const line of String(text).split('\n')) {
    const [suffix, count] = line.trim().split(':');
    if (suffix === rest) return Number(count) || 0;
  }
  return 0;
}

/** The inbox private key as a non-extractable CryptoKey (kept only in memory while unlocked). */
export async function importPrivateKey(privateJwk) {
  return subtle.importKey('jwk', privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}
/** Same as openSealed, with a key already imported. */
export async function openSealedWithKey(privKey, box) {
  const epk = b64u.dec(box.epk);
  const eph = await subtle.importKey('raw', epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: eph }, privKey, 256));
  return JSON.parse(td.decode(await open(await hkdf(shared, INFO.inbox, epk), box)));
}
/** Short public fingerprint of a data key (tells whether two devices hold the same key). */
export const keyFingerprint = async (dataKey) => b64u.enc((await hkdf(dataKey, 'bloomfi/fingerprint/v1')).subarray(0, 12));
export const bioKeyOf = (prfSecret, prfSalt) => hkdf(prfSecret, 'bloomfi-bio-v1', prfSalt);
