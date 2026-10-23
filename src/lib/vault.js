/**
 * AES-GCM helpers for the local records and password-protected backups, plus the
 * old (version 3/4) PIN vault, still opened once to move its data into the account:
 * there, the record key was wrapped by the PIN (PBKDF2-SHA256, 600k iterations)
 * and optionally by the device's biometrics (WebAuthn PRF).
 */
import { deriveMaster, hkdf, newKdf } from './keys.js';

const subtle = crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITER = 600_000;

export const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

export async function newDataKey() {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function kekFromPin(pin, salt, iterations = PBKDF2_ITER) {
  const base = await subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']);
}

export async function kekFromSecret(secretBytes, salt) {
  const base = await subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('bloomfi-bio-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

export async function wrapKey(dek, kek) {
  const iv = rand(12);
  const ct = await subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv });
  return { iv, ct: new Uint8Array(ct) };
}

/** Throws when the KEK is wrong (e.g. wrong PIN). */
export async function unwrapKey(wrapped, kek) {
  return subtle.unwrapKey('raw', wrapped.ct, kek, { name: 'AES-GCM', iv: wrapped.iv }, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** aad (optional) ties the box to its place, e.g. "transactions:tx_123": moved elsewhere, it won't open. */
export async function encryptJSON(key, value, aad) {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, ...(aad ? { additionalData: enc.encode(aad) } : {}) }, key, enc.encode(JSON.stringify(value)));
  return { iv, ct: new Uint8Array(ct) };
}

export async function decryptJSON(key, box, aad) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: box.iv, ...(aad ? { additionalData: enc.encode(aad) } : {}) }, key, box.ct);
  return JSON.parse(dec.decode(pt));
}

// ---- password-protected backups (portable text) ----
const toB64 = (u8) => btoa(String.fromCharCode(...u8));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function chunkedB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * v2: the backup password goes through Argon2id (64 MiB, 3 passes), like the account password, so a stolen
 * file is as slow to attack as the account itself. v1 files (PBKDF2) still open.
 */
async function backupKey(password, kdf) {
  const raw = await hkdf(await deriveMaster(password, kdf), 'bloomfi/backup/v2');
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
export async function encryptBackup(data, password) {
  const kdf = await newKdf('backup');
  const key = await backupKey(password, kdf);
  const iv = rand(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('bloomfi-backup-v2') }, key, enc.encode(JSON.stringify(data))));
  return { app: 'BloomFi', encrypted: true, v: 2, kdf, iv: toB64(iv), ct: chunkedB64(ct) };
}

export async function decryptBackup(box, password) {
  if (box.v === 2) {
    const key = await backupKey(password, box.kdf);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv), additionalData: enc.encode('bloomfi-backup-v2') }, key, fromB64(box.ct));
    return JSON.parse(dec.decode(pt));
  }
  const iter = Number(box.iter) || PBKDF2_ITER;
  if (iter < 100000 || iter > 5000000) throw new Error('invalid-backup');
  const key = await kekFromPin(password, fromB64(box.salt), iter);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.ct));
  return JSON.parse(dec.decode(pt));
}
