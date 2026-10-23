/**
 * BloomFi local database (IndexedDB on the user's own device).
 *
 * Since version 5 every record is always encrypted (AES-256-GCM) with a key
 * derived from the account's data key (see lib/keys.js). The data key itself
 * is stored only wrapped: by the password (Argon2id), and optionally by a PIN
 * and by the device's biometrics (WebAuthn PRF). Only what is needed before
 * unlocking (language, the wrapped keys, the account's e-mail) stays readable.
 *
 * Older versions are still opened once to move their data in:
 *  - v1 vault: records encrypted with a PIN-wrapped key (version 3/4),
 *  - no vault: plain records (versions 1-4 without PIN).
 */
import { openDB } from 'idb';
import { kekFromPin, kekFromSecret, unwrapKey, encryptJSON, decryptJSON, PBKDF2_ITER } from './lib/vault.js';
import {
  deriveMaster, localKeyOf, pinKeyOf, bioKeyOf, seal, open, dbKeyOf, syncKeyOf, b64u, newKdf, unwrapPrivateKey,
  importPrivateKey, keyFingerprint, pinProofOf, pinKeyV2, idBlinder, argonAvailable, aesKey,
} from './lib/keys.js';
import { memberWrapKey, globalizeTx } from './lib/spaces.js';

const DB_NAME = 'bloomfi';
const DB_VERSION = 5;
export const STORES = ['transactions', 'budgets', 'goals', 'chat', 'assets', 'connections', 'accounts', 'cards', 'categories', 'rules'];
// Encrypted like the data, but never exported or synced (license, capture log…).
const ALL_STORES = [...STORES, 'secrets'];

let dbPromise;
export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const tx = db.createObjectStore('transactions', { keyPath: 'id' });
          tx.createIndex('date', 'date');
          db.createObjectStore('budgets', { keyPath: 'id' });
          db.createObjectStore('goals', { keyPath: 'id' });
          db.createObjectStore('chat', { keyPath: 'id' });
          db.createObjectStore('meta');
        }
        if (oldVersion < 2) {
          db.createObjectStore('assets', { keyPath: 'id' });
          db.createObjectStore('connections', { keyPath: 'id' });
        }
        if (oldVersion < 3) {
          db.createObjectStore('accounts', { keyPath: 'id' });
          db.createObjectStore('cards', { keyPath: 'id' });
        }
        if (oldVersion < 4) {
          db.createObjectStore('categories', { keyPath: 'id' });
          db.createObjectStore('secrets', { keyPath: 'id' });
        }
        // v5: phone-capture rules (which card a wallet alert belongs to, learned categories)
        if (oldVersion < 5) db.createObjectStore('rules', { keyPath: 'id' });
      },
      blocking() { dbPromise?.then((d) => d.close()); dbPromise = null; },
    });
  }
  return dbPromise;
}

// ---------------- encryption state (memory only, while unlocked) ----------------
let recordKey = null; // AES-GCM key of the records (v2 db key, or the v1 key during migration)
let syncKey = null;
let spaceWrap = null; // wraps the keys of the shared spaces (from the data key)
let inboxKey = null;
let blind = null; // keyed fingerprint of import ids
let vaultMeta = null;

class LockedError extends Error { constructor() { super('locked'); this.code = 'locked'; } }

/**
 * Each record is sealed together with its place ("store:id", the `_a` mark): a box copied into another
 * store or id doesn't open. Records written before that mark (moving old data in) still open without it.
 */
async function encode(store, value) {
  if (!vaultMeta) return value; // only before the account exists (old plain data)
  if (!recordKey) throw new LockedError();
  const box = await encryptJSON(recordKey, value, `${store}:${value.id}`);
  return { id: value.id, _iv: box.iv, _ct: box.ct, _a: 1 };
}

async function decode(store, rec) {
  if (!rec || !rec._ct) return rec;
  if (!recordKey) throw new LockedError();
  return decryptJSON(recordKey, { iv: rec._iv, ct: rec._ct }, rec._a ? `${store}:${rec.id}` : undefined);
}

const saveMeta = async (m) => { vaultMeta = m; await (await getDB()).put('meta', m, 'vault'); };
/**
 * Reads, changes and writes the vault record in one transaction (several open tabs can't undo each other).
 * `fn` must be synchronous: awaiting anything else inside would end the transaction early.
 */
async function changeMeta(fn) {
  const d = await getDB();
  const tx = d.transaction('meta', 'readwrite');
  const cur = await tx.store.get('vault');
  const next = fn(cur);
  if (next) await tx.store.put(next, 'vault');
  await tx.done;
  vaultMeta = next || cur || vaultMeta;
  return vaultMeta;
}
const wrongKey = () => Object.assign(new Error('wrong_key'), { code: 'wrong_key' });
/** The vault record as stored now (another tab may have changed it: a stale copy in memory must not win). */
async function readVault() {
  const m = (await (await getDB()).get('meta', 'vault')) || null;
  if (m) vaultMeta = m;
  return m || vaultMeta;
}

export const vault = {
  async load() { vaultMeta = (await (await getDB()).get('meta', 'vault')) || null; return vaultMeta; },
  /** 'none' (no account yet), 'v1' (old PIN vault) or 'v2' (account). */
  get kind() { return !vaultMeta ? 'none' : vaultMeta.v === 2 ? 'v2' : 'v1'; },
  get unlocked() { return !vaultMeta || !!recordKey; },
  get info() {
    const m = vaultMeta;
    if (!m) return { kind: 'none' };
    if (m.v !== 2) return { kind: 'v1', pinLength: m.pinLength || 6, hasBio: !!m.bio };
    return {
      kind: 'v2', userId: m.userId, email: m.email, name: m.name, local: !!m.local, keyVersion: m.keyVersion || 1, kdf: m.kdf,
      hasPin: !!m.pin, pinLength: m.pin?.length || 6, pinServer: m.pin?.v === 2, hasBio: !!m.bio, pwAt: m.pwAt || 0, hasRecovery: !!m.recovery,
      pwStale: !!m.pwStale, pwv: m.pwv || 1,
    };
  },
  get bioInfo() {
    const b = vaultMeta?.bio;
    if (!b) return null;
    return vaultMeta.v === 2 ? { credId: b64u.dec(b.credId), prfSalt: b64u.dec(b.prfSalt) } : { credId: b.credId, prfSalt: b.prfSalt };
  },
  keys() { return { syncKey, inboxKey, spaceWrap }; },

  // ----- old vault (versions 3 and 4) -----
  async legacyUnlock(pin) {
    if (vaultMeta?.v === 2 || !vaultMeta) return false;
    try {
      recordKey = await unwrapKey(vaultMeta.pin, await kekFromPin(pin, vaultMeta.salt, vaultMeta.iter || PBKDF2_ITER));
      return true;
    } catch { return false; }
  },
  async legacyUnlockBio(secret) {
    if (!vaultMeta?.bio || vaultMeta.v === 2) return false;
    try {
      recordKey = await unwrapKey(vaultMeta.bio.wrapped, await kekFromSecret(secret, vaultMeta.bio.prfSalt));
      return true;
    } catch { return false; }
  },

  // ----- account vault -----
  /** Turns the raw data key into the working keys. */
  async open(dataKey) {
    recordKey = await dbKeyOf(dataKey);
    syncKey = await syncKeyOf(dataKey);
    blind = await idBlinder(dataKey);
    spaceWrap = await aesKey(await memberWrapKey(dataKey));
    inboxKey = null;
    if (vaultMeta?.wpk) {
      try { inboxKey = await importPrivateKey(await unwrapPrivateKey(dataKey, vaultMeta.wpk)); } catch { inboxKey = null; }
    }
  },
  /** Password -> data key (works offline). Also returns the master key so the session can be renewed. */
  async unlockPassword(password) {
    const { dataKey, master } = await this.dataKeyFromPassword(password);
    await this.open(dataKey);
    await changeMeta((cur) => ({ ...cur, pwAt: Date.now(), pinFails: 0 }));
    // A device-only vault made where WebAssembly was blocked (PBKDF2): moved up to Argon2id when possible.
    const m = vaultMeta;
    if (m.local && m.kdf?.alg !== 'argon2id' && (await argonAvailable())) {
      const kdf = await newKdf('account');
      const m2 = await deriveMaster(password, kdf);
      const pw = await seal(await localKeyOf(m2), dataKey);
      await changeMeta((cur) => ({ ...cur, kdf, pw }));
      return { dataKey, master: m2 };
    }
    return { dataKey, master };
  },
  /** Checks a password without changing anything (for re-wrapping while unlocked). */
  async dataKeyFromPassword(password) {
    // Read again: the account password may have changed in another tab (the old one no longer opens this device).
    const m = await readVault();
    if (m.pwStale || !m.pw) throw wrongKey();
    // Server accounts: never anything weaker than Argon2id 64 MiB. Device-only vaults may be older PBKDF2 ones.
    const master = await deriveMaster(password, m.kdf, { account: !m.local });
    return { dataKey: await open(await localKeyOf(master), m.pw), master };
  },
  /**
   * PIN of a device-only account (no server). The stored record is read again first: a PIN turned off
   * in another tab (10 wrong tries) stays off.
   */
  async unlockPin(pin) {
    const dataKey = await this.dataKeyFromPin(pin);
    await this.open(dataKey);
    return dataKey;
  },
  async dataKeyFromPin(pin) {
    const m = (await (await getDB()).get('meta', 'vault')) || vaultMeta;
    if (!m?.pin || m.pin.v === 2) throw Object.assign(new Error('no_pin'), { code: 'no_pin' });
    const k = await pinKeyOf(await deriveMaster(pin, m.pin.kdf));
    return open(k, m.pin.box);
  },
  // ----- PIN of a server account (v2): the server releases its secret only for the right PIN -----
  /** What to send the server for this PIN: { id, proof } (+ h and the box, kept here to open it after). */
  async pinProof(pin) {
    const m = await readVault();
    if (m?.pin?.v !== 2) throw Object.assign(new Error('no_pin'), { code: 'no_pin' });
    const h = await deriveMaster(pin, m.pin.kdf);
    return { id: m.pin.id, proof: await pinProofOf(h), h, box: m.pin.box };
  },
  async dataKeyFromPinSecret(h, pepper, box) {
    return open(await pinKeyV2(h, pepper), box);
  },
  /** register(proof, replaceId) -> { id, pepper } is the server call. */
  async setPinServer(pin, dataKey, register) {
    const kdf = await newKdf('pin');
    const h = await deriveMaster(pin, kdf);
    const { id, pepper } = await register(await pinProofOf(h), vaultMeta.pin?.v === 2 ? vaultMeta.pin.id : null);
    const box = await seal(await pinKeyV2(h, pepper), dataKey);
    await changeMeta((cur) => ({ ...cur, pin: { v: 2, id, kdf, box, length: String(pin).length }, pinFails: 0 }));
  },
  async unlockBio(secret) {
    const k = await bioKeyOf(secret, b64u.dec(vaultMeta.bio.prfSalt));
    const dataKey = await open(k, vaultMeta.bio.box);
    await this.open(dataKey);
    return dataKey;
  },
  lock() { if (vaultMeta) { recordKey = null; syncKey = null; inboxKey = null; blind = null; spaceWrap = null; } },

  /**
   * Creates (or refreshes) the account vault on this device. Existing records are moved in:
   * plain records, the old PIN vault (must be unlocked) or a previous account key (must be unlocked).
   * When the key changes and the old data can't be read (locked), the old records are dropped.
   */
  async setupAccount({ userId, email, name, kdf, master, dataKey, keyVersion = 1, wpk = null, local = false, recovery = null, pwv = 1 }) {
    const d = await getDB();
    const fp = await keyFingerprint(dataKey);
    const prev = await readVault();
    const sameKey = prev?.v === 2 && prev.fp === fp && prev.userId === userId;
    const meta = {
      v: 2, userId, email, name, kdf, keyVersion, fp, local, createdAt: prev?.v === 2 && prev.userId === userId ? prev.createdAt : Date.now(),
      pw: await seal(await localKeyOf(master), dataKey),
      pin: sameKey ? prev.pin || null : null,
      bio: sameKey ? prev.bio || null : null,
      wpk: wpk || (sameKey ? prev.wpk : null),
      recovery: recovery || (sameKey ? prev.recovery || null : null),
      pwAt: Date.now(), pinFails: 0, pwv: pwv || 1, pwStale: false,
    };
    if (sameKey) {
      await saveMeta(meta);
      await this.open(dataKey);
      return { moved: 0, sameKey: true };
    }
    // Read everything that can be read with the current state…
    const otherAccount = prev?.v === 2 && prev.userId !== userId;
    const readable = !otherAccount && (!prev || !!recordKey);
    const plain = {};
    let moved = 0;
    for (const s of ALL_STORES) {
      plain[s] = [];
      if (!readable) continue;
      for (const r of await d.getAll(s)) {
        try { plain[s].push(await decode(s, r)); moved++; } catch { /* unreadable record: dropped */ }
      }
    }
    // …encrypt it with the new key, then write records and keys in one transaction (all or nothing).
    const newKey = await dbKeyOf(dataKey);
    const enc = {};
    for (const s of ALL_STORES) {
      enc[s] = [];
      for (const v of plain[s]) {
        const box = await encryptJSON(newKey, v, `${s}:${v.id}`);
        enc[s].push({ id: v.id, _iv: box.iv, _ct: box.ct, _a: 1 });
      }
    }
    const tx = d.transaction([...ALL_STORES, 'meta'], 'readwrite');
    for (const s of ALL_STORES) {
      const st = tx.objectStore(s);
      st.clear();
      for (const v of enc[s]) st.put(v);
    }
    tx.objectStore('meta').put(meta, 'vault');
    if (!readable) {
      // Nothing old survives: forget sync state and tombstones too.
      for (const k of ['sync', 'tombstones', 'deletedImports']) tx.objectStore('meta').delete(k);
    }
    await tx.done;
    vaultMeta = meta;
    await this.open(dataKey);
    return { moved, sameKey: false };
  },

  /** PIN of a device-only account. */
  async setPin(pin, dataKey) {
    const kdf = await newKdf('pin');
    const box = await seal(await pinKeyOf(await deriveMaster(pin, kdf)), dataKey);
    await changeMeta((cur) => ({ ...cur, pin: { kdf, box, length: String(pin).length }, pinFails: 0 }));
  },
  async removePin() { await changeMeta((cur) => ({ ...cur, pin: null, pinFails: 0 })); },
  async enableBio({ credId, prfSalt, secret }, dataKey) {
    const box = await seal(await bioKeyOf(secret, prfSalt), dataKey);
    await changeMeta((cur) => ({ ...cur, bio: { credId: b64u.enc(credId), prfSalt: b64u.enc(prfSalt), box } }));
  },
  async disableBio() { await changeMeta((cur) => ({ ...cur, bio: null })); },
  /** New password: re-wrap the same data key. */
  async rewrapPassword({ master, kdf, dataKey, pwv }) {
    const pw = await seal(await localKeyOf(master), dataKey);
    await changeMeta((cur) => ({ ...cur, kdf, pw, pwAt: Date.now(), pwStale: false, ...(pwv ? { pwv } : {}) }));
  },
  /** Local-only accounts keep the recovery box on the device. */
  async setLocalRecovery(recovery) { await changeMeta((cur) => ({ ...cur, recovery })); },
  /** Changes only the given fields of the stored record (never writes back a stale copy). */
  async patchMeta(patch) { await changeMeta((cur) => ({ ...cur, ...patch })); },
  /** Wrong PINs of a device-only account: after 10 the PIN is turned off (counted in one transaction). */
  async pinFailed() {
    let fails = 0;
    await changeMeta((cur) => {
      fails = (cur?.pinFails || 0) + 1;
      return { ...cur, pinFails: fails, ...(fails >= 10 ? { pin: null } : {}) };
    });
    return fails;
  },
  async pinOk() { if (vaultMeta?.pinFails) await changeMeta((cur) => ({ ...cur, pinFails: 0 })); },
  get meta() { return vaultMeta; },
};

// ---------------- data access ----------------
export const db = {
  async get(store, id) { return decode(store, await (await getDB()).get(store, id)); },
  async all(store) {
    const rows = await (await getDB()).getAll(store);
    const out = [];
    for (const r of rows) {
      try { out.push(await decode(store, r)); } catch (e) { if (e.code === 'locked') throw e; /* corrupted record: skip */ }
    }
    return out;
  },
  /**
   * touch=false keeps the record's updatedAt (used when applying synced data). A change always counts as
   * newer than the version it changes, even if another device's clock was ahead.
   */
  async put(store, value0, { touch = true } = {}) {
    const value = store === 'transactions' ? globalizeTx(value0) : value0;
    return (await getDB()).put(store, await encode(store, touch ? { ...value, updatedAt: newerThan(value) } : value));
  },
  async putMany(store, values, { touch = true } = {}) {
    if (!values.length) return;
    const encoded = [];
    for (const v0 of values) {
      const v = store === 'transactions' ? globalizeTx(v0) : v0;
      encoded.push(await encode(store, touch ? { ...v, updatedAt: newerThan(v) } : v));
    }
    const tx = (await getDB()).transaction(store, 'readwrite');
    await Promise.all([...encoded.map((v) => tx.store.put(v)), tx.done]);
  },
  /**
   * Deletions are remembered for a while so other synced devices delete the record too. The deletion is
   * dated after the record's last change (a record dated in the future by a wrong clock can still be deleted).
   */
  async remove(store, id, { tomb = true } = {}) {
    const d = await getDB();
    if (tomb && store !== 'chat') {
      let rec = null;
      try { rec = await this.get(store, id); } catch { /* unreadable: now */ }
      const ts = Math.max(Date.now(), (rec?.updatedAt || 0) + 1);
      // A shared record's deletion travels with its space's copy (the other members delete it too).
      if (rec?.space) await this.addSpaceTombs(rec.space, { [`${store}:${id}`]: ts });
      else {
        const tombs = (await d.get('meta', 'tombstones')) || {};
        tombs[`${store}:${id}`] = ts;
        await d.put('meta', tombs, 'tombstones');
      }
    }
    return d.delete(store, id);
  },
  /** Deletes every record of a store, remembering the deletions for the other devices. */
  async removeAll(store) {
    const d = await getDB();
    const ids = await d.getAllKeys(store);
    if (store !== 'chat' && ids.length) {
      const last = new Map();
      try { for (const r of await this.all(store)) last.set(r.id, r); } catch { /* locked: now */ }
      const tombs = (await d.get('meta', 'tombstones')) || {};
      const shared = {};
      const t = Date.now();
      for (const id of ids) {
        const r = last.get(id);
        const ts = Math.max(t, (r?.updatedAt || 0) + 1);
        if (r?.space) (shared[r.space] ||= {})[`${store}:${id}`] = ts;
        else tombs[`${store}:${id}`] = ts;
      }
      await d.put('meta', tombs, 'tombstones');
      for (const [sp, map] of Object.entries(shared)) await this.addSpaceTombs(sp, map);
    }
    await d.clear(store);
    return ids.length;
  },
  async getTombstones() {
    const tombs = (await (await getDB()).get('meta', 'tombstones')) || {};
    const limit = Date.now() - 180 * 86400000;
    return Object.fromEntries(Object.entries(tombs).filter(([, ts]) => ts > limit));
  },
  async setTombstones(tombs) { return (await getDB()).put('meta', tombs, 'tombstones'); },
  /** Brings records back to life (undo, restore): forget that they were deleted (here and in the spaces). */
  async dropTombstones(store, ids) {
    const d = await getDB();
    const tombs = (await d.get('meta', 'tombstones')) || {};
    let n = 0;
    for (const id of ids) if (delete tombs[`${store}:${id}`]) n++;
    if (n) await d.put('meta', tombs, 'tombstones');
    const all = (await d.get('meta', 'spaceTombs')) || {};
    let m = 0;
    for (const map of Object.values(all)) for (const id of ids) if (delete map[`${store}:${id}`]) m++;
    if (m) await d.put('meta', all, 'spaceTombs');
  },
  /** Every deletion known here, personal and of each space ("was this record deleted anywhere?"). */
  async getAllTombstones() {
    const out = { ...(await this.getTombstones()) };
    const all = (await (await getDB()).get('meta', 'spaceTombs')) || {};
    const limit = Date.now() - 180 * 86400000;
    for (const map of Object.values(all)) for (const [k, ts] of Object.entries(map)) if (ts > limit && !(out[k] >= ts)) out[k] = ts;
    return out;
  },
  // ----- deletions of shared records, per space -----
  async getSpaceTombs(spaceId) {
    const map = ((await (await getDB()).get('meta', 'spaceTombs')) || {})[spaceId] || {};
    const limit = Date.now() - 180 * 86400000;
    return Object.fromEntries(Object.entries(map).filter(([, ts]) => ts > limit));
  },
  async setSpaceTombs(spaceId, tombs) {
    const d = await getDB();
    const all = (await d.get('meta', 'spaceTombs')) || {};
    all[spaceId] = tombs;
    await d.put('meta', all, 'spaceTombs');
  },
  async addSpaceTombs(spaceId, add) {
    const d = await getDB();
    const all = (await d.get('meta', 'spaceTombs')) || {};
    all[spaceId] = { ...(all[spaceId] || {}), ...add };
    await d.put('meta', all, 'spaceTombs');
  },
  /** Leaving a space (or it was deleted): its records go away from this device, without telling anyone. */
  async dropSpace(spaceId, stores) {
    const d = await getDB();
    let n = 0;
    for (const s of stores) {
      for (const r of await this.all(s)) if (r.space === spaceId) { await d.delete(s, r.id); n++; }
    }
    const all = (await d.get('meta', 'spaceTombs')) || {};
    if (all[spaceId]) { delete all[spaceId]; await d.put('meta', all, 'spaceTombs'); }
    await d.delete('meta', `spaceSync:${spaceId}`);
    return n;
  },
  async getSecret(id) { try { return await decode('secrets', await (await getDB()).get('secrets', id)); } catch (e) { if (e.code === 'locked') throw e; return null; } },
  async putSecret(id, value) { return (await getDB()).put('secrets', await encode('secrets', { ...value, id })); },
  // ----- bank/file rows the user deleted (so they don't come back on the next import) -----
  // Kept as keyed fingerprints: a copy of the device can't read the amounts and dates of the deleted rows.
  async deletedImports() {
    const list = (await this.getMeta('deletedImports')) || [];
    if (!blind) throw new LockedError();
    if (!list.some((x) => !String(x).startsWith('b:'))) return new Set(list);
    // older plain entries: turn them into fingerprints now
    const out = [];
    for (const x of list) out.push(String(x).startsWith('b:') ? x : await blind(x));
    await this.setMeta('deletedImports', [...new Set(out)].slice(-5000));
    return new Set(out);
  },
  async addDeletedImports(ids) {
    if (!ids.length) return;
    const have = await this.deletedImports();
    for (const id of ids) have.add(await blind(id));
    await this.setMeta('deletedImports', [...have].slice(-5000));
  },
  async dropDeletedImports(ids) {
    if (!ids.length) return;
    const have = await this.deletedImports();
    for (const id of ids) have.delete(await blind(id));
    await this.setMeta('deletedImports', [...have]);
  },
  async isDeletedImport(set, id) { return set.has(await blind(id)); },
  async delSecret(id) { return (await getDB()).delete('secrets', id); },
  async clear(store) { return (await getDB()).clear(store); },
  async getMeta(key) { return (await getDB()).get('meta', key); },
  async setMeta(key, value) { return (await getDB()).put('meta', value, key); },
  async delMeta(key) { return (await getDB()).delete('meta', key); },
  async count(store) { return (await getDB()).count(store); },

  /**
   * Plain JSON of everything (requires unlocked). The personal links of the phone automations are left out:
   * they work like passwords, and a backup file travels around.
   */
  async exportAll() {
    const out = { app: 'BloomFi', version: 6, exportedAt: new Date().toISOString() };
    for (const s of STORES) out[s] = await this.all(s);
    out.rules = out.rules.filter((r) => r.kind !== 'link');
    const settings = await this.getMeta('settings');
    out.settings = settings ? pickSettings(settings) : null;
    return out;
  },

  /**
   * Restores a backup. The backup becomes the current version of the data: restored records
   * count as changed now, and records it doesn't have count as deleted now, so devices that
   * sync agree with it instead of bringing the old state back.
   */
  async importAll(data) {
    if (!data || data.app !== 'BloomFi') throw new Error('invalid-backup');
    const d = await getDB();
    const now = Date.now();
    const tombs = (await d.get('meta', 'tombstones')) || {};
    for (const s of STORES) {
      if (s === 'rules' && !data.rules) continue; // backups from before v5
      // Shared records come from their space (an old file must not undo what the other members did).
      let list = (Array.isArray(data[s]) ? data[s] : []).filter((v) => v && typeof v === 'object' && (typeof v.id === 'string' || typeof v.id === 'number') && !v.space);
      // Links are never restored from a file (and the ones on this device stay).
      if (s === 'rules') list = [...list.filter((r) => r.kind !== 'link'), ...(await this.all('rules')).filter((r) => r.kind === 'link')];
      const sharedNow = s === 'chat' ? [] : (await this.all(s)).filter((r) => r.space);
      if (s !== 'chat') {
        const keep = new Set(list.map((v) => v.id));
        // Records the backup doesn't have count as deleted now (dated after their last change, so they stay deleted everywhere).
        for (const r of await this.all(s)) if (!keep.has(r.id) && !r.space) tombs[`${s}:${r.id}`] = Math.max(now, (Number(r.updatedAt) || 0) + 1);
        for (const id of keep) delete tombs[`${s}:${id}`];
        list = list.filter((v) => !sharedNow.some((r) => r.id === v.id));
      }
      const rows = [];
      for (const v of list) rows.push(await encode(s, s === 'chat' ? v : { ...v, updatedAt: Math.max(now, (Number(v.updatedAt) || 0) + 1) }));
      const tx = d.transaction(s, 'readwrite');
      await tx.store.clear();
      // (the shared records already here stay as they are)
      await Promise.all([...rows.map((v) => tx.store.put(v)), ...(await Promise.all(sharedNow.map((r) => encode(s, r)))).map((v) => tx.store.put(v)), tx.done]);
    }
    await d.put('meta', tombs, 'tombstones');
    // Only preferences come from a file; security settings (auto-lock, password checks, reminders…) stay as they are.
    const current = (await d.get('meta', 'settings')) || {};
    if (data.settings) await d.put('meta', { ...current, ...pickSettings(data.settings), onboarded: true, settingsAt: now }, 'settings');
  },

  /** Is there anything from an older version on this device (before accounts existed)? */
  async hasLegacyData() {
    const d = await getDB();
    const s = await d.get('meta', 'settings');
    if (s?.onboarded) return true;
    for (const st of ['transactions', 'accounts', 'cards', 'goals', 'budgets']) if ((await d.count(st)) > 0) return true;
    return false;
  },

  async wipe() {
    const d = await getDB();
    const tx = d.transaction([...ALL_STORES, 'meta'], 'readwrite');
    for (const s of [...ALL_STORES, 'meta']) await tx.objectStore(s).clear();
    await tx.done;
    // Then the whole database goes (its files too), not just its contents. It is created again, empty, when needed.
    d.close();
    dbPromise = null;
    await new Promise((done) => {
      try {
        const rq = indexedDB.deleteDatabase(DB_NAME);
        rq.onsuccess = rq.onerror = rq.onblocked = () => done();
      } catch { done(); }
    });
    recordKey = null;
    syncKey = null;
    inboxKey = null;
    blind = null;
    spaceWrap = null;
    vaultMeta = null;
  },
};

/** A change is newer than the version it changes (even when that version came from a clock that was ahead). */
const newerThan = (v) => Math.max(Date.now(), (Number(v?.updatedAt) || 0) + 1);

/** The preferences a backup carries (and restores): never security settings. */
function pickSettings(s = {}) {
  const out = {};
  if (typeof s.name === 'string') out.name = s.name.slice(0, 60);
  if (s.lang === 'pt' || s.lang === 'en') out.lang = s.lang;
  if (typeof s.currency === 'string' && /^[A-Z]{3}$/.test(s.currency)) out.currency = s.currency;
  if (['normal', 'large', 'xlarge'].includes(s.textSize)) out.textSize = s.textSize;
  if (typeof s.hideValues === 'boolean') out.hideValues = s.hideValues;
  if (s.dismissed && typeof s.dismissed === 'object' && !Array.isArray(s.dismissed)) {
    out.dismissed = Object.fromEntries(Object.entries(s.dismissed).filter(([k, v]) => /^[\w.:-]{1,40}$/.test(k) && typeof v !== 'object').slice(0, 100));
  }
  return out;
}

/** Ask the browser to never evict our data (important on phones). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return false;
}

export async function storageInfo() {
  try {
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
    return { persisted, usage: est.usage || 0, quota: est.quota || 0 };
  } catch {
    return { persisted: false, usage: 0, quota: 0 };
  }
}

// Keep several open windows/tabs (e.g. on a PC) in sync.
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('bloomfi-sync') : null;
export const sync = {
  notify(kind = 'changed') { channel?.postMessage(kind); },
  listen(fn) {
    if (!channel) return () => {};
    const h = (e) => fn(e.data);
    channel.addEventListener('message', h);
    return () => channel.removeEventListener('message', h);
  },
};
