/**
 * Shared spaces ("Espaço para casal ou família"): accounts, cards, goals and budgets that several BloomFi
 * accounts see together, each person with their own login.
 *
 * End-to-end encrypted like the rest:
 *  - the space key is made on the owner's device and never reaches this server in the clear;
 *  - each member keeps it here wrapped with a key that comes from their OWN data key (useless to us);
 *  - an invite link carries a secret in its #fragment (browsers never send it here). From it the device
 *    derives a proof (we only keep its hash) and the key that opens the invite box (the space key);
 *  - the owner approves every person who uses a link before they get any data;
 *  - the shared data is one encrypted copy, versioned like the personal sync.
 * Stored here: who belongs to which space, names shown to the other members, the wrapped keys, the boxes
 * of pending invites and the encrypted shared data.
 */
import { getKV, update } from './storage.js';
import { now } from './crypto.js';
import { toB64, fromB64, sha256, sameBytes, unseal, maskEmail } from './security.js';
import { json, httpError, hit, requireSession, getUser, saveUser, withEvent } from './accounts.js';

const SPACE_RE = /^sp_[\w-]{20,40}$/;
const INVITE_RE = /^[\w-]{16,40}$/;
const USER_RE = /^u_[\w-]{10,40}$/;
export const MAX_SPACE_DATA = 4_500_000;
const INVITE_DAYS = 7;
const MAX_INVITES = 5;
const MAX_REQUESTS = 10;
const MAX_SPACES = 3; // spaces one person can be in

const spaceKey = (id) => `s:${id}`;
const dataKey = (id) => `d:${id}`;
const isBox = (b, min, max) => !!b && typeof b === 'object' && typeof b.iv === 'string' && typeof b.ct === 'string'
  && fromB64(b.iv).length === 12 && fromB64(b.ct).length >= min && fromB64(b.ct).length <= max;
const box = (b) => ({ iv: b.iv, ct: b.ct });
// A wrapped space key: 32 bytes + the 16-byte tag. The space name & colour: small.
const keyBox = (b) => { if (!isBox(b, 48, 48)) throw httpError(400, 'invalid_key'); return box(b); };
const metaBox = (b) => { if (!isBox(b, 17, 1500)) throw httpError(400, 'invalid_meta'); return box(b); };
const alive = (i) => i.exp > now();

export async function getSpace(id) {
  if (!SPACE_RE.test(id || '')) return null;
  return (await getKV('spaces')).get(spaceKey(id));
}
async function nameOf(keys, userOrId) {
  const u = typeof userOrId === 'string' ? await getUser(userOrId) : userOrId;
  if (!u) return '';
  return (await unseal(keys, u.pii).catch(() => null))?.name || '';
}
async function emailHint(keys, u) {
  const e = (await unseal(keys, u?.pii).catch(() => null))?.email;
  return e ? maskEmail(e) : '';
}
const addTo = (list, id) => [...new Set([...(list || []), id])];
const dropFrom = (list, id) => (list || []).filter((x) => x !== id);

/** Changes one space with compare-and-set; `fn` returns the new space, null to delete, undefined to keep. */
async function changeSpace(id, fn) {
  let out;
  await update('spaces', spaceKey(id), (cur) => {
    out = undefined;
    if (!cur) throw httpError(404, 'space_not_found');
    const next = fn(structuredClone(cur));
    out = next === undefined ? cur : next;
    return next;
  });
  return out;
}
const memberOf = (sp, userId) => sp?.members.find((m) => m.userId === userId) || null;
function requireMember(sp, userId) {
  const m = memberOf(sp, userId);
  if (!m) throw httpError(404, 'space_not_found');
  return m;
}
/** A member whose wrapped key no longer opens (keys replaced by a reset) can't read or overwrite the shared copy. */
function requireKeyHolder(sp, userId) {
  const m = requireMember(sp, userId);
  if (m.stale) throw httpError(403, 'space_key_stale');
  return m;
}
function requireOwner(sp, userId) {
  const m = requireMember(sp, userId);
  if (m.role !== 'owner') throw httpError(403, 'owner_only');
  return m;
}

/** The person's view of a space (owners also see requests and open invites). */
async function viewOf(ctx, sp, user) {
  const me = memberOf(sp, user.id);
  const owner = me.role === 'owner';
  const members = [];
  for (const m of sp.members) members.push({ id: m.userId, name: await nameOf(ctx.keys, m.userId), role: m.role, joinedAt: m.joinedAt, ...(m.userId === user.id ? { me: true } : {}) });
  const data = await (await getKV('spacedata')).get(dataKey(sp.id));
  const view = {
    id: sp.id, role: me.role, key: me.key, ...(me.stale ? { keyStale: true } : {}), meta: sp.meta, createdAt: sp.createdAt,
    members, dataVersion: data?.version || 0,
  };
  if (owner) {
    view.requests = [];
    for (const r of sp.requests || []) {
      const u = await getUser(r.userId);
      if (u) view.requests.push({ id: r.userId, name: await nameOf(ctx.keys, u), email: await emailHint(ctx.keys, u), at: r.at });
    }
    view.invites = (sp.invites || []).filter(alive).map((i) => ({ id: i.id, exp: i.exp, createdAt: i.createdAt }));
  }
  return view;
}

/** Takes the space off a person's account (as member and as request). */
async function forget(spaceId, userId) {
  await saveUser(userId, (u) => (u ? { ...u, spaces: dropFrom(u.spaces, spaceId), spaceReqs: dropFrom(u.spaceReqs, spaceId) } : undefined)).catch(() => {});
}

async function deleteSpace(sp) {
  for (const m of sp.members) await forget(sp.id, m.userId);
  for (const r of sp.requests || []) await forget(sp.id, r.userId);
  await (await getKV('spacedata')).delete(dataKey(sp.id)).catch(() => {});
  await (await getKV('spaces')).delete(spaceKey(sp.id)).catch(() => {});
}

/** The invite matches this proof (the hash of a key derived from the link's secret)? Wrong proofs burn it after 5. */
async function checkInvite(spaceId, inviteId, mac) {
  if (!INVITE_RE.test(inviteId || '') || typeof mac !== 'string' || fromB64(mac).length !== 32) throw httpError(404, 'invite_invalid');
  const hash = toB64(await sha256(fromB64(mac)));
  let good = null;
  await update('spaces', spaceKey(spaceId), (cur) => {
    good = null;
    if (!cur) return undefined;
    const inv = (cur.invites || []).find((i) => i.id === inviteId);
    if (!inv || !alive(inv)) return undefined;
    if (sameBytes(hash, inv.macHash)) { good = { sp: cur, inv }; return undefined; }
    const tries = (inv.tries || 0) + 1;
    return { ...cur, invites: tries >= 5 ? cur.invites.filter((i) => i.id !== inviteId) : cur.invites.map((i) => (i.id === inviteId ? { ...i, tries } : i)) };
  });
  if (!good) throw httpError(404, 'invite_invalid');
  return good;
}

/**
 * Routes. `requireLicense(ctx)` -> user (creating a space needs an active plan); `notifyUser(env, user, msg)`
 * sends a push to the person's devices. Each person in a space has their own plan.
 */
export function spaceRoutes({ requireLicense, notifyUser }) {
  const L = (u, pt, en) => (u?.lang === 'en' ? en : pt);
  return {
    'GET spaces': async (ctx) => {
      const { user } = await requireSession(ctx);
      const spaces = [];
      const gone = [];
      for (const id of user.spaces || []) {
        const sp = await getSpace(id);
        if (!sp || !memberOf(sp, user.id)) { gone.push(id); continue; }
        spaces.push(await viewOf(ctx, sp, user));
      }
      const waiting = [];
      for (const id of user.spaceReqs || []) {
        const sp = await getSpace(id);
        const r = sp?.requests?.find((x) => x.userId === user.id);
        if (!r) { gone.push(id); continue; }
        const owner = sp.members.find((m) => m.role === 'owner');
        waiting.push({ id, at: r.at, meta: sp.meta, ownerName: await nameOf(ctx.keys, owner?.userId) });
      }
      if (gone.length) await saveUser(user.id, (u) => (u ? { ...u, spaces: (u.spaces || []).filter((x) => !gone.includes(x)), spaceReqs: (u.spaceReqs || []).filter((x) => !gone.includes(x)) } : undefined)).catch(() => {});
      return json({ spaces, waiting, max: ctx.env.spaceMax });
    },

    // A new space: the app made its id, the space key, the encrypted name, and the key wrapped for itself.
    'POST spaces': async (ctx) => {
      const user = await requireLicense(ctx);
      const id = String(ctx.body.id || '');
      if (!SPACE_RE.test(id)) throw httpError(400, 'invalid_space');
      if ((user.spaces || []).length + (user.spaceReqs || []).length >= MAX_SPACES) throw httpError(409, 'too_many_spaces');
      await hit('space-new', user.id, 10, 86400);
      const meta = metaBox(ctx.body.meta);
      const key = keyBox(ctx.body.key);
      const t = now();
      let created = false;
      await update('spaces', spaceKey(id), (cur) => {
        if (cur) return undefined;
        created = true;
        return { id, createdAt: t, updatedAt: t, meta, members: [{ userId: user.id, role: 'owner', key, joinedAt: t }], requests: [], invites: [] };
      });
      if (!created) throw httpError(409, 'space_exists');
      await saveUser(user.id, (u) => (u ? withEvent({ ...u, spaces: addTo(u.spaces, id) }, { t, type: 'space_created' }) : undefined));
      return json({ id });
    },

    'POST spaces/update': async (ctx) => {
      const { user } = await requireSession(ctx);
      const id = String(ctx.body.id || '');
      const meta = metaBox(ctx.body.meta);
      await changeSpace(id, (sp) => { requireOwner(sp, user.id); return { ...sp, meta, updatedAt: now() }; });
      return json({ ok: true });
    },

    // Invite: only a proof hash and the encrypted space key; the link's secret stays with the people.
    'POST spaces/invite': async (ctx) => {
      const { env } = ctx;
      const user = await requireLicense(ctx);
      const id = String(ctx.body.id || '');
      const inv = ctx.body.invite || {};
      if (!INVITE_RE.test(inv.id || '') || typeof inv.macHash !== 'string' || fromB64(inv.macHash).length !== 32) throw httpError(400, 'invalid_invite');
      const b = keyBox(inv.box);
      await hit('space-invite', user.id, 30, 86400);
      const exp = now() + INVITE_DAYS * 86400;
      await changeSpace(id, (sp) => {
        requireOwner(sp, user.id);
        const open = (sp.invites || []).filter(alive);
        if (open.length >= MAX_INVITES) throw httpError(409, 'too_many_invites');
        if (sp.members.length >= env.spaceMax) throw httpError(409, 'space_full');
        if (open.some((i) => i.id === inv.id)) throw httpError(409, 'invite_exists');
        return { ...sp, invites: [...open, { id: inv.id, macHash: inv.macHash, box: b, exp, createdAt: now(), tries: 0 }] };
      });
      return json({ exp });
    },
    'POST spaces/invite/cancel': async (ctx) => {
      const { user } = await requireSession(ctx);
      const id = String(ctx.body.id || '');
      await changeSpace(id, (sp) => { requireOwner(sp, user.id); return { ...sp, invites: (sp.invites || []).filter((i) => i.id !== ctx.body.inviteId && alive(i)) }; });
      return json({ ok: true });
    },

    // Someone opened an invite link: with the right proof they see the encrypted name and get the box to open.
    'POST spaces/peek': async (ctx) => {
      const { user } = await requireSession(ctx);
      await hit('space-peek', user.id, 30, 3600);
      const id = String(ctx.body.id || '');
      if (!SPACE_RE.test(id)) throw httpError(404, 'invite_invalid');
      const { sp, inv } = await checkInvite(id, String(ctx.body.inviteId || ''), ctx.body.mac);
      const owner = sp.members.find((m) => m.role === 'owner');
      return json({
        meta: sp.meta, box: inv.box, exp: inv.exp, ownerName: await nameOf(ctx.keys, owner.userId), members: sp.members.length,
        ...(memberOf(sp, user.id) ? { already: true } : {}),
      });
    },

    // Asking to join: the link is used up here; the owner approves before any data is shared.
    'POST spaces/join': async (ctx) => {
      const { env } = ctx;
      const { user } = await requireSession(ctx);
      await hit('space-join', user.id, 20, 3600);
      const id = String(ctx.body.id || '');
      if (!SPACE_RE.test(id)) throw httpError(404, 'invite_invalid');
      const inviteId = String(ctx.body.inviteId || '');
      const key = keyBox(ctx.body.key);
      const busy = (user.spaces || []).length + (user.spaceReqs || []).filter((x) => x !== id).length;
      if (!(user.spaces || []).includes(id) && busy >= MAX_SPACES) throw httpError(409, 'too_many_spaces');
      await checkInvite(id, inviteId, ctx.body.mac);
      let rejoined = false;
      let ownerId = null;
      await changeSpace(id, (sp) => {
        const invites = (sp.invites || []).filter((i) => i.id !== inviteId && alive(i));
        if (!(sp.invites || []).some((i) => i.id === inviteId && alive(i))) throw httpError(404, 'invite_invalid');
        ownerId = sp.members.find((m) => m.role === 'owner')?.userId;
        const m = memberOf(sp, user.id);
        if (m) {
          // Already in (e.g. after a password reset without the recovery key): the new invite renews the key.
          rejoined = true;
          return { ...sp, invites, members: sp.members.map((x) => (x.userId === user.id ? { ...x, key, stale: undefined } : x)) };
        }
        if (sp.members.length >= env.spaceMax) throw httpError(409, 'space_full');
        if ((sp.requests || []).length >= MAX_REQUESTS && !(sp.requests || []).some((r) => r.userId === user.id)) throw httpError(409, 'too_many_requests');
        return { ...sp, invites, requests: [...(sp.requests || []).filter((r) => r.userId !== user.id), { userId: user.id, key, at: now() }] };
      });
      if (rejoined) return json({ joined: true });
      await saveUser(user.id, (u) => (u ? { ...u, spaceReqs: addTo(u.spaceReqs, id) } : undefined));
      const owner = ownerId && await getUser(ownerId);
      if (owner) {
        const who = (await nameOf(ctx.keys, user)) || L(owner, 'Alguém', 'Someone');
        ctx.later(notifyUser(ctx.env, owner, {
          title: L(owner, '🏠 Pedido para entrar no seu espaço', '🏠 Request to join your space'),
          body: L(owner, `${who} quer participar. Abra o BloomFi para aprovar.`, `${who} wants to join. Open BloomFi to approve.`),
          tag: `space:${id}`, url: '/app/#space', kind: 'space',
        }));
      }
      return json({ pending: true });
    },
    'POST spaces/cancel': async (ctx) => {
      const { user } = await requireSession(ctx);
      const id = String(ctx.body.id || '');
      await changeSpace(id, (sp) => ({ ...sp, requests: (sp.requests || []).filter((r) => r.userId !== user.id) })).catch(() => {});
      await saveUser(user.id, (u) => (u ? { ...u, spaceReqs: dropFrom(u.spaceReqs, id) } : undefined)).catch(() => {});
      return json({ ok: true });
    },

    'POST spaces/approve': async (ctx) => {
      const { env } = ctx;
      const { user } = await requireSession(ctx);
      const id = String(ctx.body.id || '');
      const who = String(ctx.body.userId || '');
      if (!USER_RE.test(who)) throw httpError(400, 'invalid_user');
      const okd = ctx.body.ok === true;
      let found = false;
      await changeSpace(id, (sp) => {
        requireOwner(sp, user.id);
        const r = (sp.requests || []).find((x) => x.userId === who);
        found = !!r;
        if (!r) return undefined;
        const requests = sp.requests.filter((x) => x.userId !== who);
        if (!okd) return { ...sp, requests };
        if (sp.members.length >= env.spaceMax) throw httpError(409, 'space_full');
        return { ...sp, requests, members: [...sp.members, { userId: who, role: 'member', key: r.key, joinedAt: now() }], updatedAt: now() };
      });
      if (!found) throw httpError(404, 'request_not_found');
      const joiner = await getUser(who);
      await saveUser(who, (u) => (u ? withEvent({ ...u, spaceReqs: dropFrom(u.spaceReqs, id), ...(okd ? { spaces: addTo(u.spaces, id) } : {}) }, { t: now(), type: okd ? 'space_joined' : 'space_refused' }) : undefined)).catch(() => {});
      if (joiner && okd) {
        ctx.later(notifyUser(ctx.env, joiner, {
          title: L(joiner, '🏠 Você entrou no espaço', '🏠 You joined the space'),
          body: L(joiner, 'O pedido foi aprovado. Abra o BloomFi para ver o que é compartilhado.', 'Your request was approved. Open BloomFi to see what is shared.'),
          tag: `space:${id}`, url: '/app/#space', kind: 'space',
        }));
      }
      return json({ ok: true });
    },

    'POST spaces/leave': async (ctx) => {
      const { user } = await requireSession(ctx);
      const id = String(ctx.body.id || '');
      await changeSpace(id, (sp) => {
        const m = requireMember(sp, user.id);
        if (m.role === 'owner') throw httpError(409, 'owner_cannot_leave');
        return { ...sp, members: sp.members.filter((x) => x.userId !== user.id), updatedAt: now() };
      });
      await saveUser(user.id, (u) => (u ? withEvent({ ...u, spaces: dropFrom(u.spaces, id) }, { t: now(), type: 'space_left' }) : undefined));
      return json({ ok: true });
    },
    'POST spaces/remove': async (ctx) => {
      const { user } = await requireSession(ctx);
      const id = String(ctx.body.id || '');
      const who = String(ctx.body.userId || '');
      if (!USER_RE.test(who) || who === user.id) throw httpError(400, 'invalid_user');
      await changeSpace(id, (sp) => {
        requireOwner(sp, user.id);
        if (!memberOf(sp, who)) throw httpError(404, 'member_not_found');
        return { ...sp, members: sp.members.filter((x) => x.userId !== who), updatedAt: now() };
      });
      await saveUser(who, (u) => (u ? withEvent({ ...u, spaces: dropFrom(u.spaces, id) }, { t: now(), type: 'space_removed' }) : undefined)).catch(() => {});
      return json({ ok: true });
    },
    'POST spaces/delete': async (ctx) => {
      const { user } = await requireSession(ctx);
      const sp = await getSpace(String(ctx.body.id || ''));
      if (!sp) throw httpError(404, 'space_not_found');
      requireOwner(sp, user.id);
      await deleteSpace(sp);
      await saveUser(user.id, (u) => (u ? withEvent(u, { t: now(), type: 'space_deleted' }) : undefined)).catch(() => {});
      return json({ ok: true });
    },

    // ----- the shared data (ciphertext only), like the personal sync -----
    'GET spaces/data': async (ctx) => {
      const { user } = await requireSession(ctx);
      const sp = await getSpace(ctx.url.searchParams.get('id') || '');
      requireKeyHolder(sp, user.id);
      const rec = await (await getKV('spacedata')).get(dataKey(sp.id));
      if (ctx.url.searchParams.get('meta') === '1') return json({ version: rec?.version || 0, updatedAt: rec?.updatedAt || null });
      return json(rec ? { version: rec.version, updatedAt: rec.updatedAt, data: rec.data } : { version: 0, data: null });
    },
    'PUT spaces/data': async (ctx) => {
      const { user } = await requireSession(ctx);
      const sp = await getSpace(String(ctx.body.id || ''));
      requireKeyHolder(sp, user.id);
      const data = ctx.body.data;
      if (typeof data !== 'string' || !data || data.length > MAX_SPACE_DATA) throw httpError(400, 'invalid_data');
      await hit('space-put', `${sp.id}:${user.id}`, 600, 3600);
      const store = await getKV('spacedata');
      const { value: rec, tag } = await store.getVersioned(dataKey(sp.id));
      const version = rec?.version || 0;
      if (Number(ctx.body.baseVersion) !== version) return json({ error: 'conflict', version }, 409);
      const next = { version: version + 1, updatedAt: now(), data, by: user.id };
      if (!(await store.setVersioned(dataKey(sp.id), next, tag))) return json({ error: 'conflict', version: version + 1 }, 409);
      return json({ version: next.version, updatedAt: next.updatedAt });
    },
  };
}

// ---------------- account events ----------------
/** The account is gone: its requests disappear; its spaces go on with the oldest member as owner (or are deleted). */
export async function dropSpaces(user) {
  for (const id of user.spaceReqs || []) {
    await update('spaces', spaceKey(id), (sp) => (sp ? { ...sp, requests: (sp.requests || []).filter((r) => r.userId !== user.id) } : undefined)).catch(() => {});
  }
  for (const id of user.spaces || []) {
    const sp = await getSpace(id);
    if (!sp) continue;
    const rest = sp.members.filter((m) => m.userId !== user.id && !m.stale).sort((a, b) => a.joinedAt - b.joinedAt);
    if (!rest.length) { await deleteSpace(sp); continue; }
    await update('spaces', spaceKey(id), (cur) => {
      if (!cur) return undefined;
      const wasOwner = memberOf(cur, user.id)?.role === 'owner';
      const members = cur.members.filter((m) => m.userId !== user.id).map((m) => (wasOwner && m.userId === rest[0].userId ? { ...m, role: 'owner' } : m));
      return { ...cur, members, ...(wasOwner ? { invites: [] } : {}), updatedAt: now() };
    }).catch(() => {});
  }
}
/**
 * New keys after a password reset without the recovery key: this person's wrapped space keys can't be opened
 * anymore. They stay listed (a new invite renews the key); an owner hands the space to the oldest member.
 */
export async function staleSpaces(user) {
  for (const id of user.spaces || []) {
    const sp = await getSpace(id);
    if (!sp) continue;
    const others = sp.members.filter((m) => m.userId !== user.id && !m.stale).sort((a, b) => a.joinedAt - b.joinedAt);
    if (!others.length) { await deleteSpace(sp); continue; }
    await update('spaces', spaceKey(id), (cur) => {
      if (!cur) return undefined;
      const wasOwner = memberOf(cur, user.id)?.role === 'owner';
      const members = cur.members.map((m) => {
        if (m.userId === user.id) return { ...m, stale: true, role: 'member' };
        if (wasOwner && m.userId === others[0].userId) return { ...m, role: 'owner' };
        return m;
      });
      return { ...cur, members, ...(wasOwner ? { invites: [] } : {}), updatedAt: now() };
    }).catch(() => {});
  }
  for (const id of user.spaceReqs || []) {
    await update('spaces', spaceKey(id), (sp) => (sp ? { ...sp, requests: (sp.requests || []).filter((r) => r.userId !== user.id) } : undefined)).catch(() => {});
  }
}
