/**
 * Shared spaces — the keys (runs on the device; also in Node for tests).
 *
 *   space key (random, made on the owner's device)
 *     ├─HKDF("space-meta")─► encrypts the space's name and colour
 *     └─HKDF("space-sync")─► encrypts the shared data copy
 *   each member: dataKey ─HKDF("space-wrap")─► wraps the space key (kept on the server, only that member opens it)
 *   invite link …/app/#join=<space>.<invite>.<secret>   (the #part never leaves the browser)
 *     secret ─HKDF("invite-mac")──► proof (the server keeps only its SHA-256)
 *            └HKDF("invite-wrap")─► opens the invite box = the space key
 */
import { hkdf, seal, open, rand, b64u, aesKey } from './keys.js';

const te = new TextEncoder();
const td = new TextDecoder();

export const newSpaceId = () => `sp_${b64u.enc(rand(18))}`;
export const newSpaceKey = () => rand(32);

/** From the member's own data key: the key that wraps every space key of theirs. */
export const memberWrapKey = (dataKey) => hkdf(dataKey, 'bloomfi/space-wrap/v1');
export const wrapSpaceKey = (wrapKey, spaceId, spaceKey) => seal(wrapKey, spaceKey, `space-key:${spaceId}`);
export const unwrapSpaceKey = (wrapKey, spaceId, box) => open(wrapKey, box, `space-key:${spaceId}`);

const metaKeyOf = (spaceKey) => hkdf(spaceKey, 'bloomfi/space-meta/v1');
export async function sealSpaceMeta(spaceKey, spaceId, meta) {
  const m = { name: String(meta.name || '').trim().slice(0, 40), emoji: String(meta.emoji || '🏠').slice(0, 8), color: /^#[0-9a-f]{6}$/i.test(meta.color || '') ? meta.color : '#0bf28b' };
  return seal(await metaKeyOf(spaceKey), te.encode(JSON.stringify(m)), `space-meta:${spaceId}`);
}
export async function openSpaceMeta(spaceKey, spaceId, box) {
  const m = JSON.parse(td.decode(await open(await metaKeyOf(spaceKey), box, `space-meta:${spaceId}`)));
  // Written by another person's device: only the expected shapes come through.
  return {
    name: typeof m?.name === 'string' ? m.name.trim().slice(0, 40) : '',
    emoji: typeof m?.emoji === 'string' ? m.emoji.slice(0, 8) : '🏠',
    color: typeof m?.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#0bf28b',
  };
}
export const spaceSyncKey = async (spaceKey) => aesKey(await hkdf(spaceKey, 'bloomfi/space-sync/v1'));

// ---------------- invites ----------------
async function inviteKeys(secret) {
  return { mac: await hkdf(secret, 'bloomfi/invite-mac/v1'), wrap: await hkdf(secret, 'bloomfi/invite-wrap/v1') };
}
/** A new invite: what the server keeps ({ id, macHash, box }) and the #fragment that goes in the link. */
export async function makeInvite(spaceKey, spaceId) {
  const id = b64u.enc(rand(12));
  const secret = rand(32);
  const { mac, wrap } = await inviteKeys(secret);
  const macHash = b64u.enc(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', mac)));
  const box = await seal(wrap, spaceKey, `invite:${spaceId}:${id}`);
  return { invite: { id, macHash, box }, fragment: `join=${spaceId}.${id}.${b64u.enc(secret)}` };
}
/** Reads an invite from a link or a pasted text. */
export function parseInvite(text) {
  const m = String(text || '').match(/join=(sp_[\w-]{20,40})\.([\w-]{16,40})\.([\w-]{43})(?![\w-])/);
  return m ? { spaceId: m[1], inviteId: m[2], secret: m[3] } : null;
}
export async function inviteProof(secret) {
  const { mac, wrap } = await inviteKeys(b64u.dec(secret));
  return { mac: b64u.enc(mac), wrap };
}
export const openInviteBox = (wrap, spaceId, inviteId, box) => open(wrap, box, `invite:${spaceId}:${inviteId}`);

// ---------------- which records belong where ----------------
/** Stores whose records can be shared, and the ones that follow a shared account or card. */
export const SHARED_STORES = ['accounts', 'cards', 'transactions', 'goals', 'budgets', 'categories'];

/**
 * The space a transaction belongs to: the one of its account or card (or, for a transfer, of the account or
 * card it goes to). `spaceOf` maps an account/card id to its space id.
 */
export function txSpace(t, spaceOf) {
  return spaceOf(t.accountId) || spaceOf(t.cardId) || spaceOf(t.toAccountId) || spaceOf(t.toCardId) || null;
}

/**
 * Marks transactions that belong to a space (their account or card is shared) and who added them. Only adds
 * marks: taking something out of a space is done on purpose (shareRecord), never guessed here.
 */
export function makeTagger({ accounts, cards }, me) {
  const shared = new Map([...accounts, ...cards].filter((r) => r.space).map((r) => [r.id, r.space]));
  const spaceOf = (id) => (id ? shared.get(id) || null : null);
  return (t) => {
    const sp = txSpace(t, spaceOf);
    if (!sp || t.space === sp) return t;
    return { ...t, space: sp, by: t.by || me || null };
  };
}

/**
 * The view the person picked: 'all', 'me' (only what is theirs alone) or a space id.
 * A transaction is shown when it touches an account or card of that view (a transfer from a personal account
 * to a shared one shows in both, so both balances stay right).
 */
export function scopeFilter(scope, { accounts, cards }) {
  if (!scope || scope === 'all') return null;
  const all = [...accounts, ...cards];
  const ids = (t) => [t.accountId, t.cardId, t.toAccountId, t.toCardId].filter(Boolean);
  if (scope === 'me') {
    const shared = new Set(all.filter((r) => r.space).map((r) => r.id));
    const own = new Set(all.filter((r) => !r.space).map((r) => r.id));
    // The person's own entries (also older ones without an account); a shared entry only when it touches one of
    // their own accounts or cards (money they moved into the space). Another member's transfer stays out.
    return {
      record: (rec) => !rec.space,
      tx: (t) => {
        const x = ids(t);
        if (!t.space) return !x.length || x.some((id) => !shared.has(id));
        return x.some((id) => own.has(id));
      },
    };
  }
  const mine = new Set(all.filter((r) => r.space === scope).map((r) => r.id));
  return { record: (rec) => rec.space === scope, tx: (t) => t.space === scope || ids(t).some((id) => mine.has(id)) };
}

/**
 * Every account has a "main" account with the same id ("main"). In a shared entry written by someone else,
 * "main" means THEIR main account: on this device it becomes "main@<their id>" (not one of mine), so my own
 * balance never moves with their entries. globalizeTx turns it back before saving.
 */
export function localizeTx(t, me) {
  if (!t.space || !t.by || t.by === me) return t;
  const noAccount = t.accountId == null && !t.cardId;
  if (t.accountId !== 'main' && t.toAccountId !== 'main' && !noAccount) return t;
  return {
    ...t,
    accountId: t.accountId === 'main' || noAccount ? `main@${t.by}` : t.accountId,
    toAccountId: t.toAccountId === 'main' ? `main@${t.by}` : t.toAccountId,
  };
}
export function globalizeTx(t) {
  const fix = (id) => (typeof id === 'string' && id.startsWith('main@') && id.slice(5) === t.by ? 'main' : id);
  if (!t || (!String(t.accountId || '').startsWith('main@') && !String(t.toAccountId || '').startsWith('main@'))) return t;
  return { ...t, accountId: fix(t.accountId), toAccountId: fix(t.toAccountId) };
}

/**
 * A shared entry becoming someone's own (space deleted, account taken back): another member's "main" account
 * must not turn into mine, so it becomes an outside account ("ext:<their id>") that no balance of mine uses.
 */
export function detachTx(t, me) {
  if (!t.by || t.by === me) return t;
  const noAccount = t.accountId == null && !t.cardId;
  const ext = `ext:${t.by}`;
  return {
    ...t,
    accountId: t.accountId === 'main' || noAccount || t.accountId === `main@${t.by}` ? ext : t.accountId,
    toAccountId: t.toAccountId === 'main' || t.toAccountId === `main@${t.by}` ? ext : t.toAccountId,
  };
}

/**
 * What comes from a space's shared copy can only be shared records of THAT space: whatever another device
 * wrote, nothing in it can land among the person's own records (or another space's).
 */
// ---------------- shared data from other people ----------------
// The shared copy is written by other members' devices, so each record is checked before it reaches this device:
// plain values only, numbers that are numbers, real dates, colours that are colours. Anything that would break the
// app (or smuggle something in) is fixed or dropped, never trusted.
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const KEY_RE = /^[A-Za-z_][\w]{0,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));
const isColor = (v) => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v);
const TX_TYPES = new Set(['expense', 'income', 'transfer', 'invest', 'redeem']);
const NUMBER_FIELDS = ['amount', 'limit', 'initialBalance', 'target', 'current', 'balance'];
// Generous caps (far above what the app itself writes), so a normal record never changes on the way.
const TEXT_LIMITS = { name: 120, title: 120, institution: 120, category: 80, emoji: 16, icon: 40, brand: 40 };

function plainValue(v, depth) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= 1e13 ? v : undefined;
  if (typeof v === 'string') return v.slice(0, 2000);
  if (depth > 2 || typeof v !== 'object') return undefined; // records nest at most two levels (e.g. a goal's history)
  if (Array.isArray(v)) return v.slice(0, 5000).map((x) => plainValue(x, depth + 1)).filter((x) => x !== undefined);
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return undefined;
  const out = {};
  let n = 0;
  for (const [k, x] of Object.entries(v)) {
    if (n >= 40 || BAD_KEYS.has(k) || !KEY_RE.test(k)) continue;
    const y = plainValue(x, depth + 1);
    if (y !== undefined) { out[k] = y; n++; }
  }
  return out;
}

/** One shared record made safe for this device, or null when it can't be used at all. */
export function sanitizeRecord(store, r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const id = typeof r.id === 'number' && Number.isFinite(r.id) ? r.id : typeof r.id === 'string' && r.id && r.id.length <= 200 ? r.id : null;
  if (id == null) return null;
  const x = plainValue(r, 0) || {};
  x.id = id;
  for (const k of NUMBER_FIELDS) {
    if (k in x && typeof x[k] !== 'number') {
      const v = Number(x[k]);
      x[k] = Number.isFinite(v) && Math.abs(v) <= 1e13 ? v : 0;
    }
  }
  for (const [k, max] of Object.entries(TEXT_LIMITS)) if (typeof x[k] === 'string') x[k] = x[k].slice(0, max);
  if ('color' in x && !isColor(x.color)) x.color = store === 'cards' ? '#8b5cf6' : store === 'accounts' ? '#10b981' : '#94a3b8';
  if (store === 'transactions') {
    if (!TX_TYPES.has(x.type) || !isDate(x.date) || typeof x.amount !== 'number') return null;
    if ('invoice' in x && !(typeof x.invoice === 'string' && /^\d{4}-\d{2}$/.test(x.invoice))) x.invoice = null;
    if ('loggedOn' in x && !isDate(x.loggedOn)) delete x.loggedOn;
    if (x.category != null && typeof x.category !== 'string') x.category = 'other';
  } else if (store === 'accounts') {
    if (typeof x.name !== 'string') x.name = '';
    if (typeof x.initialBalance !== 'number') x.initialBalance = 0;
  } else if (store === 'cards') {
    if (typeof x.name !== 'string') x.name = '';
    if (typeof x.limit !== 'number') x.limit = 0;
    for (const [k, d] of [['closingDay', 1], ['dueDay', 10]]) if (!(Number.isInteger(x[k]) && x[k] >= 1 && x[k] <= 31)) x[k] = d;
  } else if (store === 'goals') {
    if (typeof x.title !== 'string') x.title = '';
    if (typeof x.target !== 'number') x.target = 0;
    if (typeof x.current !== 'number') x.current = 0;
    if ('deadline' in x && x.deadline != null && !isDate(x.deadline)) x.deadline = null;
    x.history = (Array.isArray(x.history) ? x.history : [])
      .filter((h) => h && typeof h === 'object' && isDate(h.date) && typeof h.amount === 'number')
      .map((h) => ({ date: h.date, amount: h.amount, ...(typeof h.h === 'string' ? { h: h.h.slice(0, 64) } : {}) }));
  } else if (store === 'budgets') {
    if (typeof x.category !== 'string') return null;
    if (typeof x.limit !== 'number') x.limit = 0;
  } else if (store === 'categories') {
    if (typeof x.key !== 'string' || !/^[\w-]{1,60}$/.test(x.key)) return null;
    if (typeof x.name !== 'string') x.name = '';
    x.type = x.type === 'income' ? 'income' : 'expense';
  }
  return x;
}

/** The shared copy as received: only shared stores, every record checked and tagged with this space. */
export function sanitizeSpaceSnap(snap, spaceId) {
  if (!snap || typeof snap !== 'object') return null;
  const stores = {};
  for (const s of SHARED_STORES) {
    stores[s] = (Array.isArray(snap.stores?.[s]) ? snap.stores[s] : [])
      .slice(0, 50000)
      .map((r) => sanitizeRecord(s, r))
      .filter(Boolean)
      .map((r) => (r.space === spaceId ? r : { ...r, space: spaceId }));
  }
  const tombstones = {};
  for (const [k, ts] of Object.entries(snap.tombstones || {})) {
    if (SHARED_STORES.some((s) => k.startsWith(`${s}:`)) && Number.isFinite(ts)) tombstones[k] = ts;
  }
  return { v: 1, at: Number(snap.at) || 0, stores, tombstones, settings: {} };
}
