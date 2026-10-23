/**
 * Device sync with end-to-end encryption.
 *
 * Each device keeps its full database. A sync downloads the encrypted copy
 * from the server, merges it with the local data record by record (newest
 * `updatedAt` wins, deletions travel as tombstones), saves the result
 * locally and uploads it again. The server only stores ciphertext: since
 * version 5 the key comes from the account's data key, which the server
 * never sees (see lib/keys.js).
 */
export const SYNC_STORES = ['transactions', 'budgets', 'goals', 'assets', 'connections', 'accounts', 'cards', 'categories', 'rules'];
const SETTINGS_KEYS = ['name', 'lang', 'currency'];
/** Deletions are remembered this long (same as the local database). */
export const TOMBSTONE_DAYS = 180;

const te = new TextEncoder();
const td = new TextDecoder();
const b64 = {
  enc: (u8) => { let s = ''; const b = new Uint8Array(u8); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); },
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

// ---------------- merge (pure, unit-tested) ----------------
const byId = (list) => new Map((list || []).map((r) => [r.id, r]));

/** JSON with sorted keys, so the same record gives the same text on every device. */
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/**
 * Merges two snapshots. Newest `updatedAt` wins; on a tie both devices pick the same copy
 * (by content), so they never keep sending each other their own version. With `preferRemote`
 * (first sync of a device that joins existing data) the cloud copy wins conflicts.
 * Records created automatically (recurring months, bank imports) carry updatedAt 0,
 * so a deletion made anywhere always beats them.
 */
export function mergeSnapshots(local, remote, { preferRemote = false } = {}) {
  if (!remote) return local;
  const tombstones = {};
  const oldest = Date.now() - TOMBSTONE_DAYS * 86400000;
  for (const src of [remote.tombstones, local.tombstones]) {
    for (const [k, ts] of Object.entries(src || {})) if (ts > oldest && !(tombstones[k] >= ts)) tombstones[k] = ts;
  }
  const stores = {};
  for (const s of SYNC_STORES) {
    const map = byId(remote.stores?.[s]);
    for (const r of local.stores?.[s] || []) {
      const o = map.get(r.id);
      if (!o) { map.set(r.id, r); continue; }
      if (preferRemote) continue; // joining existing data: the cloud copy wins (e.g. over a fresh, empty default account)
      const lt = r.updatedAt || 0, rt = o.updatedAt || 0;
      const localWins = lt > rt || (lt === rt && stable(r) > stable(o));
      // A goal both sides added money to (two devices, or two people in a space): nothing is lost.
      if (s === 'goals') map.set(r.id, mergeGoal(localWins ? r : o, localWins ? o : r));
      else if (localWins) map.set(r.id, r);
    }
    for (const [k, ts] of Object.entries(tombstones)) {
      if (!k.startsWith(`${s}:`)) continue;
      const id = k.slice(s.length + 1);
      const rec = map.get(id);
      if (rec && (rec.updatedAt || 0) <= ts) map.delete(id);
    }
    stores[s] = [...map.values()];
  }
  const ls = local.settings || {}, rs = remote.settings || {};
  const settings = (preferRemote && rs.at) || (rs.at || 0) > (ls.at || 0) ? rs : ls;
  return { v: 1, at: Date.now(), stores, tombstones, settings };
}

/**
 * Goals: the newer copy wins, plus the contributions (history entries with an id `h`) only the other copy has.
 * Merging again gives the same result, so every device ends with the sum of everyone's contributions.
 */
export function mergeGoal(win, other) {
  const have = new Set((win.history || []).map((e) => e?.h).filter(Boolean));
  const extra = (other.history || []).filter((e) => e?.h && !have.has(e.h));
  if (!extra.length) return win;
  const add = extra.reduce((a, e) => a + (Number(e.amount) || 0), 0);
  return {
    ...win,
    history: [...(win.history || []), ...extra].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.h || '').localeCompare(String(b.h || ''))),
    current: Math.max(0, Math.round(((Number(win.current) || 0) + add) * 100) / 100),
  };
}

const canon = (snap) => stable(SYNC_STORES.map((s) => [...(snap?.stores?.[s] || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))))
  + stable(Object.entries(snap?.tombstones || {}).sort()) + stable(snap?.settings || {});
export const sameSnapshot = (a, b) => canon(a) === canon(b);
/** Short fingerprint of a snapshot: lets a sync skip the download when nothing changed anywhere. */
export async function snapshotHash(snap) {
  const d = await crypto.subtle.digest('SHA-256', te.encode(canon(snap)));
  return b64.enc(new Uint8Array(d).subarray(0, 16));
}

// ---------------- encryption ----------------
async function gzip(bytes) {
  if (typeof CompressionStream === 'undefined') return { bytes, gz: false };
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return { bytes: new Uint8Array(out), gz: true };
}
async function gunzip(bytes) {
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return new Uint8Array(out);
}

export const SYNC_ITERATIONS = 600000;
export async function deriveSyncKey(password, saltB64) {
  const base = await crypto.subtle.importKey('raw', te.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64.dec(saltB64), iterations: SYNC_ITERATIONS }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
export const newSalt = () => b64.enc(crypto.getRandomValues(new Uint8Array(16)));
export const exportKey = async (key) => b64.enc(await crypto.subtle.exportKey('raw', key));
export const importKey = (raw) => crypto.subtle.importKey('raw', b64.dec(raw), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);

/**
 * v2: the format flags (version, compressed) are sealed with the data, so nobody can flip them unnoticed.
 * A shared space's copy also seals its space id (`tag`), so it can't be passed off as another copy.
 */
const aadOf = (gz, tag) => te.encode(`bloomfi-sync:v2:gz=${gz ? 1 : 0}${tag ? `:${tag}` : ''}`);
export async function sealSnapshot(snap, key, salt, { tag = '' } = {}) {
  const { bytes, gz } = await gzip(te.encode(JSON.stringify(snap)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadOf(gz, tag) }, key, bytes);
  return JSON.stringify({ v: 2, salt, iv: b64.enc(iv), gz, ct: b64.enc(ct) });
}

/** Throws { code: 'wrong_password' } when the key doesn't match (or the copy was tampered with). */
export async function openSnapshot(data, key, { tag = '' } = {}) {
  const box = JSON.parse(data);
  let plain;
  try {
    const params = { name: 'AES-GCM', iv: b64.dec(box.iv), ...(box.v === 2 ? { additionalData: aadOf(!!box.gz, tag) } : {}) };
    plain = new Uint8Array(await crypto.subtle.decrypt(params, key, b64.dec(box.ct)));
  } catch {
    throw Object.assign(new Error('wrong_password'), { code: 'wrong_password' });
  }
  return JSON.parse(td.decode(box.gz ? await gunzip(plain) : plain));
}
export const saltOf = (data) => JSON.parse(data).salt;

// ---------------- local database <-> snapshot ----------------
/**
 * The person's own records (the personal copy). Records shared in a space (`space` set) travel in that space's
 * copy instead. Sample data stays on the device (unless `includeSample`).
 */
export async function readLocal(db, settings, { includeSample = false } = {}) {
  const stores = {};
  const isSample = (r) => r.source === 'sample' || (r.sample && !r.isDefault);
  for (const s of SYNC_STORES) stores[s] = (await db.all(s)).filter((r) => !r.space && (includeSample || !isSample(r)));
  if (!includeSample) {
    const sampleTpl = new Set((await db.all('transactions')).filter((r) => r.source === 'sample').map((r) => r.id));
    stores.transactions = stores.transactions.filter((r) => !sampleTpl.has(r.recurringOf));
  }
  const picked = Object.fromEntries(SETTINGS_KEYS.map((k) => [k, settings?.[k]]));
  return { v: 1, at: Date.now(), stores, tombstones: await db.getTombstones(), settings: { ...picked, at: settings?.settingsAt || 0 } };
}

/**
 * Writes the merged snapshot into the local database (only what changed).
 * Anything the user changed on this device while the sync was running is kept:
 * it goes up with the next sync.
 */
export const writeLocal = (db, merged, current) => writeScoped(db, merged, current, null);

/**
 * Same, for one scope: null = the person's own records, or a space id. A record taken back from a space
 * (it arrives from the person's own copy) replaces the shared copy here when it is newer. The other way, a
 * space's copy never overwrites one of the person's own records: those only change through their own devices.
 */
export async function writeScoped(db, merged, current, scope) {
  let changed = false;
  const inScope = (r) => (r?.space || null) === (scope || null);
  for (const s of SYNC_STORES) {
    const now = byId(current.stores?.[s]);
    const next = byId(merged.stores?.[s]);
    if (!now.size && !next.size) continue;
    const untouched = async (id) => {
      const was = now.get(id);
      const is = await db.get(s, id);
      return was ? !!is && (is.updatedAt || 0) === (was.updatedAt || 0) : !is;
    };
    const put = [];
    for (const r of next.values()) {
      if (JSON.stringify(now.get(r.id)) === JSON.stringify(r)) continue;
      if (await untouched(r.id)) { put.push(r); continue; }
      if (!scope && !now.has(r.id)) {
        const is = await db.get(s, r.id);
        if (is && !inScope(is) && (r.updatedAt || 0) > (is.updatedAt || 0)) put.push(r);
      }
    }
    if (put.length) { await db.putMany(s, put, { touch: false }); changed = true; }
    for (const id of now.keys()) {
      if (next.has(id) || !(await untouched(id))) continue;
      await db.remove(s, id, { tomb: false });
      changed = true;
    }
  }
  // Deletions made here during the sync stay too.
  const tombs = { ...(merged.tombstones || {}) };
  const local = scope ? await db.getSpaceTombs(scope) : await db.getTombstones();
  for (const [k, ts] of Object.entries(local)) if (!tombs[k] || ts > tombs[k]) tombs[k] = ts;
  if (scope) await db.setSpaceTombs(scope, tombs); else await db.setTombstones(tombs);
  return changed;
}

/** One space's records (and its deletions) as a snapshot, like readLocal for the personal copy. */
export async function readScoped(db, scope) {
  const stores = {};
  for (const s of SYNC_STORES) stores[s] = (await db.all(s)).filter((r) => r.space === scope);
  return { v: 1, at: Date.now(), stores, tombstones: await db.getSpaceTombs(scope), settings: {} };
}
