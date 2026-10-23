/**
 * Phone captures ("gastos do celular").
 *
 * Phones can't give a website the Apple Pay / Google Wallet history, but an
 * automation on the phone can forward each payment the moment it happens:
 *   - iPhone: Shortcuts automations "Transaction" (Apple Pay), "Message" (bank SMS)
 *     and, on iOS 27+, "Notification" (bank app alerts, which cover virtual cards);
 *   - Android: an automation app (MacroDroid) forwarding Google Wallet / bank notifications.
 *
 * Each automation posts to a personal link: /api/wallet/in/<token>. The token only
 * allows *adding* to the user's inbox (it can't read anything), is stored hashed and
 * can be revoked at any time. Each entry is encrypted to the user's public key right
 * away, so the inbox holds only ciphertext until one of the user's devices opens it.
 */
import { getKV, update } from './storage.js';
import { randomId, now } from './crypto.js';
import { sha256, toB64, sealTo, cleanText } from './security.js';
import { json, httpError, hit, requireSession, getUser, saveUser } from './accounts.js';

const MAX_TOKENS = 5;
const MAX_ENTRIES = 300;
const ENTRY_TTL = 60 * 86400;
const TOKEN_RE = /^bfw_[\w-]{43}$/;

const tokenKey = async (token) => `wt:${toB64(await sha256(token))}`;

/** Keeps a small, flat copy of what the automation sent (no nested objects, short strings). */
export function cleanCapture(obj) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj || {})) {
    if (n >= 14) break;
    if (v == null || typeof v === 'object') continue;
    const key = String(k).normalize('NFKD').replace(/[^\w]/g, '').toLowerCase().slice(0, 24);
    if (!key) continue;
    out[key] = String(v).replace(/\u0000/g, '').slice(0, 1500);
    n++;
  }
  return out;
}

export async function parseIngestBody(req) {
  if (Number(req.headers.get('content-length')) > 8000) throw httpError(413, 'body_too_large');
  const text = await req.text();
  if (text.length > 8000) throw httpError(413, 'body_too_large');
  const type = (req.headers.get('content-type') || '').toLowerCase();
  let obj;
  if (type.includes('json') || /^\s*\{/.test(text)) {
    try { obj = JSON.parse(text); } catch { obj = { texto: text }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = { texto: text };
  } else if (type.includes('x-www-form-urlencoded')) {
    obj = Object.fromEntries(new URLSearchParams(text));
  } else {
    const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
    const kv = lines.map((l) => l.match(/^\s*([A-Za-zÀ-ÿ_ ]{2,24}?)\s*[:=]\s*(.*)$/));
    if (lines.length && kv.every(Boolean) && kv.some((m) => /valor|amount|quantia|texto|text/i.test(m[1]))) {
      // A Shortcuts "Text" action written as "valor: …", "local: …", "cartao: …"
      obj = Object.fromEntries(kv.map((m) => [m[1].trim(), m[2].trim()]));
    } else {
      // MacroDroid / Tasker plain text: "app\ntitle\ntext"
      obj = lines.length >= 3 ? { app: lines[0], titulo: lines[1], texto: lines.slice(2).join('\n') } : { texto: text };
    }
  }
  return cleanCapture(obj);
}

/** The amount in a phone payment (fields "valor"/"amount", or "R$ 12,34" in the text), or null. */
export function amountOf(d) {
  const text = String(d.valor ?? d.amount ?? d.quantia ?? '').trim()
    || (String([d.titulo, d.title, d.texto, d.text].filter(Boolean).join(' ')).match(/R\$\s?\d[\d.]*(?:,\d{1,2})?/i) || [''])[0];
  let s = text.replace(/[^\d.,]/g, '');
  if (!s) return null;
  const c = s.lastIndexOf(','), p = s.lastIndexOf('.');
  if (c > p) s = s.replace(/\./g, '').replace(',', '.');
  else if (p > c && c >= 0) s = s.replace(/,/g, '');
  else if (p >= 0 && /\.\d{3}$/.test(s)) s = s.replace(/\./g, '');
  const v = Number(s);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}
const looksIncome = (d) => /recebe|recebid|estorno|reembols|devolu|received|refund/i.test([d.titulo, d.title, d.texto, d.text].filter(Boolean).join(' '));

/** Short summary for the optional detailed push ("R$ 23,90 · Padaria Real"). */
function summary(d) {
  const amount = d.valor || d.amount || d.quantia || '';
  const place = d.local || d.merchant || d.comerciante || '';
  if (amount && place) return cleanText(`${amount} · ${place}`, 80);
  return cleanText(d.titulo || d.title || d.texto || d.text || '', 80);
}

export function walletRoutes({ notifyUser }) {
  return {
    'POST wallet/tokens': async (ctx) => {
      const { user } = await requireSession(ctx);
      if (!user.keys?.publicKey) throw httpError(409, 'keys_missing');
      if ((user.wallet?.tokens || []).length >= MAX_TOKENS) throw httpError(409, 'too_many_links');
      await hit('wallet-token', user.id, 10, 3600);
      const token = `bfw_${randomId(32)}`;
      const id = randomId(9);
      const label = cleanText(ctx.body.label, 40) || 'Celular';
      const platform = ['ios', 'android', 'other'].includes(ctx.body.platform) ? ctx.body.platform : 'other';
      const key = await tokenKey(token);
      await (await getKV('index')).set(key, { userId: user.id, id, label, platform, createdAt: now(), lastAt: 0, count: 0 });
      await saveUser(user.id, (u) => (u ? { ...u, wallet: { ...(u.wallet || {}), tokens: [...(u.wallet?.tokens || []), { id, key, label, platform, createdAt: now() }] } } : undefined));
      const origin = ctx.env.appOrigin || new URL(ctx.req.url).origin;
      return json({ id, token, url: `${origin}/api/wallet/in/${token}`, label, platform });
    },

    'GET wallet/tokens': async (ctx) => {
      const { user } = await requireSession(ctx);
      const idx = await getKV('index');
      const out = [];
      for (const t of user.wallet?.tokens || []) {
        const rec = await idx.get(t.key);
        out.push({ id: t.id, label: t.label, platform: t.platform, createdAt: t.createdAt, lastAt: rec?.lastAt || 0, count: rec?.count || 0 });
      }
      return json({ links: out });
    },

    'DELETE wallet/tokens': async (ctx) => {
      const { user } = await requireSession(ctx);
      const id = String(ctx.url.searchParams.get('id') || '');
      const t = (user.wallet?.tokens || []).find((x) => x.id === id);
      if (!t) throw httpError(404, 'not_found');
      await (await getKV('index')).delete(t.key);
      await saveUser(user.id, (u) => (u ? { ...u, wallet: { ...(u.wallet || {}), tokens: (u.wallet?.tokens || []).filter((x) => x.id !== id) } } : undefined));
      return json({ ok: true });
    },

    // Public: called by the phone automation. No cookies, no CORS, no reflection of input.
    'POST wallet/in': async (ctx) => {
      const token = ctx.pathParam || (ctx.req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!TOKEN_RE.test(token || '')) throw httpError(404, 'not_found');
      await hit('wallet-ip', ctx.ip, 300, 3600);
      const key = await tokenKey(token);
      const idx = await getKV('index');
      const rec = await idx.get(key);
      if (!rec?.userId) throw httpError(404, 'not_found');
      await hit('wallet-in', rec.id, 90, 3600);
      await hit('wallet-day', rec.id, 600, 86400);
      const data = await parseIngestBody(ctx.req);
      if (!Object.keys(data).length) throw httpError(400, 'empty');
      const user = await getUser(rec.userId);
      if (!user?.keys?.publicKey) throw httpError(404, 'not_found');
      const entry = { id: randomId(12), at: Date.now(), link: rec.id, platform: rec.platform, data };
      const box = await sealTo(user.keys.publicKey, entry);
      await update('inbox', `ib:${user.id}`, (cur) => {
        const t = Date.now();
        const list = (cur?.entries || []).filter((e) => e.at > t - ENTRY_TTL * 1000);
        list.push({ id: entry.id, at: entry.at, box });
        return { entries: list.slice(-MAX_ENTRIES), total: (cur?.total || 0) + 1 };
      });
      await update('index', key, (cur) => (cur ? { ...cur, lastAt: now(), count: (cur.count || 0) + 1 } : undefined)).catch(() => {});
      const big = Number(user.prefs?.bigPurchase) || 0;
      const amount = big > 0 ? amountOf(data) : null;
      const pt = user.lang !== 'en';
      const detail = !!user.prefs?.pushDetail;
      if (big > 0 && amount != null && amount >= big && !looksIncome(data)) {
        // The person asked to know right away about spending above this amount (the threshold is theirs, the amount only with details on).
        const limit = new Intl.NumberFormat(pt ? 'pt-BR' : 'en-US', { style: 'currency', currency: user.prefs?.currency || 'BRL' }).format(big);
        ctx.later(notifyUser(ctx.env, user, {
          title: pt ? `⚠️ Gasto acima de ${limit}` : `⚠️ Spending above ${limit}`,
          body: detail ? summary(data) : (pt ? 'Toque para conferir no BloomFi.' : 'Tap to check it in BloomFi.'),
          tag: 'capture', url: '/app/#ai', kind: 'capture',
        }));
      } else if (user.prefs?.captureAlerts !== false) {
        ctx.later(notifyUser(ctx.env, user, {
          title: pt ? '💳 Gasto do celular recebido' : '💳 Phone payment received',
          body: detail ? summary(data) : (pt ? 'Toque para ver no BloomFi.' : 'Tap to see it in BloomFi.'),
          tag: 'capture', url: '/app/#home', kind: 'capture',
        }));
      }
      return json({ ok: true, message: user.lang === 'en' ? 'BloomFi received it ✓' : 'BloomFi recebeu ✓' });
    },

    'GET wallet/inbox': async (ctx) => {
      const { user } = await requireSession(ctx);
      const rec = await (await getKV('inbox')).get(`ib:${user.id}`);
      return json({ entries: (rec?.entries || []).slice(0, MAX_ENTRIES) });
    },

    // The device opened and saved these entries: forget them.
    'POST wallet/ack': async (ctx) => {
      const { user } = await requireSession(ctx);
      const ids = new Set((Array.isArray(ctx.body.ids) ? ctx.body.ids : []).map(String).slice(0, MAX_ENTRIES));
      if (!ids.size) return json({ ok: true, left: 0 });
      let left = 0;
      await update('inbox', `ib:${user.id}`, (cur) => {
        if (!cur) return undefined;
        const entries = (cur.entries || []).filter((e) => !ids.has(e.id));
        left = entries.length;
        return { ...cur, entries };
      });
      return json({ ok: true, left });
    },
  };
}

/** Everything the account owns in this module (account deletion / keys replaced). */
export async function dropWallet(user, { tokens = true } = {}) {
  await (await getKV('inbox')).delete(`ib:${user.id}`);
  if (!tokens) return;
  const idx = await getKV('index');
  for (const t of user.wallet?.tokens || []) await idx.delete(t.key).catch(() => {});
}
