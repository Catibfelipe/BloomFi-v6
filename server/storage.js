/**
 * Key-value storage for what the server must keep: accounts (with PII encrypted),
 * sessions, short-lived challenges, rate limits, encrypted sync copies, the
 * encrypted inbox of phone captures and bill-reminder schedules.
 *
 * - On Netlify: Netlify Blobs with strong consistency (no setup needed).
 * - Locally / in tests: JSON files in BLOBS_DIR (or the system temp folder).
 *
 * update() is the safe way to change a record: it retries a compare-and-set
 * until no other request changed the record in between. Deleting through update()
 * is also a compare-and-set: it writes a small "deleted" marker (read back as
 * nothing), so two requests can't both "use up" the same code or ticket.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const cache = new Map();
/** A record deleted through update(): reads see nothing; the hourly cleanup removes the marker. */
const isGone = (v) => !!v && typeof v === 'object' && v.__deleted != null;

function fileStore(name) {
  const dir = path.join(process.env.BLOBS_DIR || path.join(os.tmpdir(), 'bloomfi-blobs'), name);
  const file = (key) => path.join(dir, `${encodeURIComponent(key)}.json`);
  // One process: a per-key queue makes check-then-write atomic.
  const locks = new Map();
  const locked = async (key, fn) => {
    const prev = locks.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    locks.set(key, prev.then(() => mine));
    await prev;
    try { return await fn(); } finally { release(); if (locks.get(key) === mine) locks.delete(key); }
  };
  const readRaw = async (key) => { try { return await fs.readFile(file(key), 'utf8'); } catch { return null; } };
  const tagOf = (raw) => (raw == null ? null : createHash('sha1').update(raw).digest('hex'));
  const writeRaw = async (key, value) => {
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file(key)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value));
    await fs.rename(tmp, file(key));
  };
  return {
    async get(key) { const raw = await readRaw(key); try { const v = raw == null ? null : JSON.parse(raw); return isGone(v) ? null : v; } catch { return null; } },
    set: (key, value) => locked(key, () => writeRaw(key, value)),
    delete: (key) => locked(key, async () => { try { await fs.unlink(file(key)); } catch { /* already gone */ } }),
    async getVersioned(key) {
      const raw = await readRaw(key);
      if (raw == null) return { value: null, tag: null };
      try { const v = JSON.parse(raw); return { value: isGone(v) ? null : v, tag: tagOf(raw) }; } catch { return { value: null, tag: null }; }
    },
    setVersioned(key, value, tag) {
      return locked(key, async () => {
        if (tagOf(await readRaw(key)) !== (tag || null)) return false;
        await writeRaw(key, value);
        return true;
      });
    },
    async keys(prefix = '') {
      try {
        return (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => decodeURIComponent(f.slice(0, -5))).filter((k) => k.startsWith(prefix));
      } catch { return []; }
    },
  };
}

async function netlifyStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const s = getStore({ name, consistency: 'strong' });
  return {
    get: async (key) => { const v = await s.get(key, { type: 'json' }); return isGone(v) ? null : v; },
    set: (key, value) => s.setJSON(key, value),
    delete: (key) => s.delete(key),
    async keys(prefix = '') {
      const out = [];
      for await (const page of s.list({ prefix: prefix || undefined, paginate: true })) out.push(...page.blobs.map((b) => b.key));
      return out;
    },
    // Atomic compare-and-set with the blob's ETag: two requests saving at once can't overwrite each other.
    async getVersioned(key) {
      const r = await s.getWithMetadata(key, { type: 'json' });
      return r ? { value: isGone(r.data) ? null : r.data, tag: r.etag || null } : { value: null, tag: null };
    },
    async setVersioned(key, value, tag) {
      const r = await s.setJSON(key, value, tag ? { onlyIfMatch: tag } : { onlyIfNew: true });
      return r?.modified !== false;
    },
  };
}

export async function getKV(name) {
  if (cache.has(name)) return cache.get(name);
  let store;
  const onNetlify = !process.env.BLOBS_DIR && (process.env.NETLIFY_BLOBS_CONTEXT || globalThis.Netlify);
  if (onNetlify) {
    try { store = await netlifyStore(name); } catch (e) { console.error('[storage] Netlify Blobs unavailable, using temp files', e?.message); }
  }
  store ||= fileStore(name);
  cache.set(name, store);
  return store;
}

/**
 * Read-modify-write with compare-and-set. `fn(current)` returns the new value,
 * `null` to delete, or `undefined` to leave the record as it is.
 * Returns { value, changed }.
 */
export async function update(storeName, key, fn, { tries = 8 } = {}) {
  const store = await getKV(storeName);
  for (let i = 0; i < tries; i++) {
    const { value, tag } = await store.getVersioned(key);
    const next = await fn(value ?? null);
    if (next === undefined) return { value, changed: false };
    if (next === null) {
      if (value == null) return { value: null, changed: false };
      // Compare-and-set to a "deleted" marker: if two requests delete at once, only one of them wins.
      if (await store.setVersioned(key, { __deleted: Math.floor(Date.now() / 1000) }, tag)) return { value: null, changed: true };
      await new Promise((r) => setTimeout(r, 15 + Math.random() * 40 * (i + 1)));
      continue;
    }
    if (await store.setVersioned(key, next, tag)) return { value: next, changed: true };
    await new Promise((r) => setTimeout(r, 15 + Math.random() * 40 * (i + 1)));
  }
  const e = new Error('storage_conflict');
  e.code = 'storage_conflict';
  throw e;
}

/** For tests: forget cached stores (e.g. after changing BLOBS_DIR). */
export function resetKV() { cache.clear(); }
