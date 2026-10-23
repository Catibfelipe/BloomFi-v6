/**
 * BloomFi API — one request handler for every /api/* route.
 *
 * Identity: the account session (HttpOnly cookie, see accounts.js).
 * Payments: Stripe is the source of truth; the app gets a signed license (ES256)
 * it can check offline.
 * Open Finance: fetched from Pluggy on demand, never stored here.
 * Stored here: accounts (PII encrypted), sessions, the encrypted sync copy, the
 * encrypted inbox of phone captures and bill-reminder schedules. Financial data
 * is only ever stored encrypted with keys we don't have.
 */
import { signES, verifyES, verifyHS, parseJwk, publicFromPrivate, now, sha256hex } from './crypto.js';
import { getEnv, HttpError, stripe, pluggy } from './services.js';
import { getKV, update } from './storage.js';
import { vapidPublicKey, sendPush, allowedEndpoint } from './webpush.js';
import { serverKeys, toB64, hmac, sameBytes, sha256 } from './security.js';
import {
  json, httpError, clientIp, geoOf, requireSession, authRoutes, accountRoutes, accountHooks, emailOf, getUser, saveUser,
  hit, cleanupAuth, assertSameOrigin, readLegacy, linkLegacy, claimLegacy, withEvent,
} from './accounts.js';
import { walletRoutes, dropWallet } from './wallet.js';
import { emailEnabled } from './emails.js';
import { spaceRoutes, dropSpaces, staleSpaces, MAX_SPACE_DATA } from './spaces.js';

const DAY = 86400;
const GRACE_DAYS = 3;
const MAX_LICENSE_DAYS = 40;

async function readBody(req, max = 10_000) {
  if (req.method === 'GET' || req.method === 'DELETE' || req.method === 'HEAD') return {};
  if (Number(req.headers.get('content-length')) > max) throw new HttpError(413, 'body_too_large');
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, 'body_too_large');
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { throw new HttpError(400, 'invalid_json'); }
}

function vapidKey(env) {
  try { const jwk = parseJwk(env.vapidJwk); return jwk?.d ? jwk : null; } catch { return null; }
}

// ---------------- push (bill reminders + alerts) ----------------
const MAX_REMINDERS = 60;
function cleanReminders(items) {
  const t = now();
  return (Array.isArray(items) ? items : [])
    .filter((i) => Number.isFinite(i?.at) && i.at > t - DAY && i.at < t + 70 * DAY)
    .slice(0, MAX_REMINDERS)
    .map((i) => ({
      at: Math.floor(i.at),
      title: String(i.title || 'BloomFi').slice(0, 60),
      body: String(i.body || '').slice(0, 160),
      tag: String(i.tag || 'bills').replace(/[^\w:-]/g, '').slice(0, 40) || 'bills',
    }))
    .sort((a, b) => a.at - b.at);
}

/** Sends one notification to every device of the user that allowed notifications. */
export async function notifyUser(env, user, message) {
  const jwk = vapidKey(env);
  if (!jwk || !user?.push?.length) return 0;
  const store = await getKV('push');
  let sent = 0;
  for (const key of user.push) {
    const rec = await store.get(key);
    if (!rec?.sub || rec.userId !== user.id) continue;
    const r = await sendPush(rec.sub, message, { jwk, subject: env.vapidSubject }).catch(() => 'failed');
    if (r === 'gone') {
      await store.delete(key);
      await saveUser(user.id, (u) => (u ? { ...u, push: (u.push || []).filter((k) => k !== key) } : undefined)).catch(() => {});
    } else if (r === 'sent') sent++;
  }
  return sent;
}

/**
 * Banks nobody pays for stop costing: accounts with connections are looked at every 12 hours (a few per run).
 * When the plan no longer covers some of them (subscription ended, smaller plan, payment failing) for 3 days in a
 * row (a week for a failing payment), the extra connections — the newest first — are removed at Pluggy. The data
 * already in the app stays.
 */
export async function trimBanks(env = getEnv(), { at = now(), budget = 40, deadline = Date.now() + 6000 } = {}) {
  if (!env.pluggyId || !env.stripeKey || !env.licenseJwk || !env.appSecret) return 0;
  const idx = await getKV('index');
  const keys = await serverKeys(env.appSecret);
  let removed = 0, checked = 0;
  for (const k of await idx.keys('ofc:')) {
    if (checked >= budget || Date.now() > deadline) break;
    const rec = (await idx.get(k)) || {};
    if (rec.checkedAt > at - 12 * 3600) continue;
    checked++;
    const user = await getUser(k.slice(4));
    const items = user?.of?.items || [];
    if (!user || !items.length) { await idx.delete(k).catch(() => {}); continue; }
    const r = await licenseForUser(env, keys, user).catch(() => null);
    if (!r) continue; // Stripe unreachable: next time
    const banks = r.banks ?? 0;
    if (items.length <= banks) { await idx.set(k, { checkedAt: at }); continue; }
    const since = rec.overSince || at;
    // A failing payment gets a week (Stripe tries the card again meanwhile); a smaller or ended plan, 3 days.
    if (at - since < (r.status === 'past_due' ? 7 : 3) * DAY) { await idx.set(k, { checkedAt: at, overSince: since }); continue; }
    const extra = items.slice(banks);
    for (const itemId of extra) {
      await pluggy(env, 'DELETE', `/items/${encodeURIComponent(itemId)}`).catch(() => {});
      await idx.delete(ofIndex(itemId)).catch(() => {});
      removed++;
    }
    await saveUser(user.id, (u) => (u ? withEvent({ ...u, of: { ...(u.of || {}), items: (u.of?.items || []).filter((x) => !extra.includes(x)) } }, { t: at, type: 'banks_disconnected', n: extra.length }) : undefined));
    if (banks > 0) await idx.set(k, { checkedAt: at }); else await idx.delete(k).catch(() => {});
    const en = user.lang === 'en', n = extra.length;
    await notifyUser(env, user, {
      title: en ? '🏦 Bank connections removed' : '🏦 Bancos desconectados',
      body: en ? `Your plan no longer covers ${n === 1 ? '1 bank connection' : `${n} bank connections`}. What was already in the app stays.`
        : `Seu plano não cobre mais ${n === 1 ? '1 banco conectado' : `${n} bancos conectados`}. O que já estava no app continua.`,
      tag: 'bank', url: '/app/#import', kind: 'bank',
    }).catch(() => {});
  }
  return removed;
}

/** Runs every hour (Netlify scheduled function): sends the reminders that are due, then tidies up. */
export async function runPushCron(env = getEnv(), at = now()) {
  const jwk = vapidKey(env);
  let sent = 0, removed = 0, pending = 0, banksRemoved = 0;
  // Banks first, with their own short time budget (the whole run must end within Netlify's 30 seconds).
  try { banksRemoved = await trimBanks(env, { at }); } catch { /* next hour */ }
  if (jwk) {
    const store = await getKV('push');
    const one = async (key) => {
      const rec = await store.get(key);
      if (!rec?.sub) return;
      const items = rec.items || [];
      const due = items.filter((i) => i.at <= at && i.at > at - 6 * 3600);
      const keep = items.filter((i) => i.at > at);
      if (due.length) {
        const last = due[due.length - 1]; // several due at once: only the latest, no spam
        const r = await sendPush(rec.sub, { title: last.title, body: last.body, tag: last.tag, url: '/app/#agenda' }, { jwk, subject: env.vapidSubject }).catch(() => 'failed');
        if (r === 'gone') { await store.delete(key); removed++; return; }
        if (r === 'sent') sent++;
      }
      if (keep.length !== items.length) await update('push', key, (cur) => (cur ? { ...cur, items: (cur.items || []).filter((i) => i.at > at) } : undefined));
      else if (!keep.length && (rec.updatedAt || 0) < at - 30 * DAY) { await store.delete(key); removed++; }
    };
    // Many devices share the same hour: work in parallel (bounded), shuffled so nobody is always last.
    const keys = (await store.keys()).sort(() => Math.random() - 0.5);
    const started = Date.now();
    let next = 0;
    const worker = async () => {
      while (next < keys.length && Date.now() - started < 15000) await one(keys[next++]).catch(() => {});
    };
    await Promise.all(Array.from({ length: 24 }, worker));
    pending = Math.max(keys.length - next, 0);
  }
  let cleaned = 0;
  try { cleaned = (await cleanupAuth(4000)).removed; } catch { /* next hour */ }
  // Wally's AI now runs on each person's device: the monthly question counts of the old cloud AI are cleared.
  try {
    const ai = await getKV('ai');
    for (const k of (await ai.keys('q:')).slice(0, 2000)) { await ai.delete(k).catch(() => {}); cleaned++; }
  } catch { /* next hour */ }
  return { sent, removed, pending, cleaned, banksRemoved, ...(jwk ? {} : { skipped: 'vapid_not_configured' }) };
}

// ---------------- licenses ----------------
function licenseKeys(env) {
  const priv = parseJwk(env.licenseJwk);
  if (!priv?.d) throw new HttpError(503, 'license_key_missing');
  return { priv, pub: publicFromPrivate(priv) };
}

const STATUS_RANK = { active: 0, trialing: 0, past_due: 1, unpaid: 2, incomplete: 3, paused: 4, canceled: 5, incomplete_expired: 6 };
const periodEnd = (s) => s.current_period_end ?? s.items?.data?.[0]?.current_period_end ?? null;

const LIVE = ['active', 'trialing', 'past_due'];

/**
 * The subscription that counts for a Stripe customer. Each person has one plan: a second live subscription only
 * appears when someone changed plans and never came back from the payment page to finish the switch. The newest
 * one is the plan they chose; the older ones end now (Stripe credits the unused days), so nobody pays twice.
 */
async function bestSubscription(env, customerId) {
  const list = await stripe(env, 'GET', '/subscriptions', { customer: customerId, status: 'all', limit: 10 });
  const all = list.data || [];
  const live = all.filter((x) => LIVE.includes(x.status));
  if (live.length > 1) {
    const newest = live.slice().sort((a, b) => (b.created || 0) - (a.created || 0))[0];
    for (const old of live) if (old.id !== newest.id) await stripe(env, 'DELETE', `/subscriptions/${old.id}`, { prorate: 'true' }).catch(() => {});
    return newest;
  }
  const subs = all.slice().sort((a, b) =>
    (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || (periodEnd(b) || 0) - (periodEnd(a) || 0));
  return subs[0] || null;
}

async function issueLicense(env, payload) {
  const { priv } = licenseKeys(env);
  const exp = Math.min(payload.exp, now() + MAX_LICENSE_DAYS * DAY);
  if (exp <= now()) return null;
  return signES({ ...payload, iat: now(), exp }, priv);
}

// ---------------- plans (by number of connected banks) ----------------
const planById = (env, id) => env.plans.find((p) => p.id === id) || null;
/** The plan of a Stripe subscription: written on it when bought, or found by its Stripe price. Older ones = the first plan. */
function planOfSub(env, sub) {
  if (planById(env, sub?.metadata?.plan)) return sub.metadata.plan;
  const prices = (sub?.items?.data || []).map((i) => i.price?.id).filter(Boolean);
  return env.plans.find((p) => p.stripePrice && prices.includes(p.stripePrice))?.id || env.plans[0].id;
}
/**
 * How many banks a license window allows. Banks cost money every month, so they come only with a plan that has
 * been paid at least once (Stripe "active"): not during the free trial, not while the first charge is pending
 * (subscribed during the trial) and not while a payment is failing. Free-access e-mails get the top plan; a gift
 * code, the plan written on it.
 */
function banksFor(env, best) {
  if (best?.status === 'free') return env.plans[env.plans.length - 1].banks;
  // A gift code gives the plan written on it (the owner chose to cover its banks).
  if (best?.status === 'active' || best?.status === 'gift') return planById(env, best.plan)?.banks ?? 0;
  return 0;
}

/** Stripe subscription -> license window, or null. */
async function stripeWindow(env, customerId) {
  const sub = await bestSubscription(env, customerId);
  if (!sub) return { status: 'none' };
  const end = periodEnd(sub) || now();
  const plan = planOfSub(env, sub);
  if (sub.status === 'active' || sub.status === 'trialing') {
    return { status: sub.status, renews: !sub.cancel_at_period_end, periodEnd: end, exp: sub.cancel_at_period_end ? end : end + GRACE_DAYS * DAY, subId: sub.id, plan };
  }
  if (sub.status === 'past_due') {
    // Payment failed and Stripe is retrying: short grace so the person can fix the card.
    return { status: 'past_due', renews: true, periodEnd: end, exp: Math.min(now() + GRACE_DAYS * DAY, end + 10 * DAY), subId: sub.id, plan };
  }
  return { status: sub.status, plan };
}

/**
 * What this account may use right now: free (family e-mails), gift code, Stripe subscription,
 * or the free trial (counted on the server from the day the account was created).
 */
async function licenseForUser(env, keys, user) {
  if (!env.stripeKey || !env.licenseJwk) return { license: null, status: 'free_mode' };
  const email = await emailOf(keys, user);
  const base = { sub: user.id, email };
  const trialDays = env.trialDays;
  if (user.emailVerified && email && env.freeEmails.includes(email)) {
    const top = env.plans[env.plans.length - 1];
    const banks = banksFor(env, { status: 'free' });
    await rememberBanks(user, banks, 'free', top.id);
    return { license: await issueLicense(env, { ...base, status: 'free', renews: true, exp: now() + 30 * DAY, plan: top.id, banks }), status: 'free', plan: top.id, banks };
  }
  const b = user.billing || {};
  let best = null;
  let customer = b.stripeCustomer || null;
  // Subscribers from before accounts existed: find them by their (verified) e-mail.
  if (!customer && user.emailVerified && email) {
    const found = await stripe(env, 'GET', '/customers', { email, limit: 10 }).catch(() => ({ data: [] }));
    for (const c of found.data || []) {
      const w = await stripeWindow(env, c.id).catch(() => null);
      if (w?.exp) { customer = c.id; break; }
    }
    if (customer) await saveUser(user.id, (u) => (u ? { ...u, billing: { ...(u.billing || {}), stripeCustomer: customer } } : undefined)).catch(() => {});
  }
  if (customer) {
    const w = await stripeWindow(env, customer);
    if (w.exp) best = w;
    else if (w.status !== 'none') best = { status: w.status };
  }
  if (!best?.exp && b.giftUntil > now()) best = { status: 'gift', renews: false, periodEnd: b.giftUntil, exp: b.giftUntil, plan: planById(env, b.giftPlan)?.id || env.plans[0].id };
  if (!best?.exp && b.trialStart) {
    const end = b.trialStart + trialDays * DAY;
    if (end > now()) best = { status: 'trial', renews: false, periodEnd: end, exp: end, trialStart: b.trialStart, plan: 'trial' };
  }
  if (!best?.exp) {
    const status = best?.status || (customer ? 'expired' : 'trial_over');
    await rememberBanks(user, 0, status, null);
    return { license: null, status, banks: 0 };
  }
  const plan = best.plan || env.plans[0].id;
  const banks = banksFor(env, best);
  await rememberBanks(user, banks, best.status, plan);
  const lic = await issueLicense(env, {
    ...base, status: best.status, renews: !!best.renews, periodEnd: best.periodEnd, exp: best.exp, plan, banks,
    ...(best.trialStart ? { trialStart: best.trialStart } : {}),
  });
  return { license: lic, status: lic ? best.status : 'expired', plan, banks: lic ? banks : 0 };
}

/**
 * The bank allowance is checked on the server, not taken from the license the app shows (that one can be up to
 * 40 days old). It is kept on the account for a few hours; when it would say no, Stripe is asked again first (at
 * most every 2 minutes), so a plan just paid for or upgraded works at once.
 */
const BANKS_FRESH = 6 * 3600;
const BANKS_RECHECK = 120;
async function rememberBanks(user, banks, status, plan) {
  const b = user.billing || {};
  if (b.banks === banks && b.planStatus === status && b.planId === plan && b.banksAt > now() - BANKS_RECHECK) return;
  await saveUser(user.id, (u) => (u ? { ...u, billing: { ...(u.billing || {}), banks, planStatus: status, planId: plan, banksAt: now() } } : undefined)).catch(() => {});
}
/** How many banks the account may have connected now (`need`: how many this request needs). */
async function banksAllowed(ctx, user, need = 1) {
  const { env } = ctx;
  if (!env.stripeKey || !env.licenseJwk) return Infinity; // server without billing: no limit
  const b = user.billing || {};
  if (Number.isFinite(b.banks) && b.banksAt > now() - BANKS_FRESH && (b.banks >= need || b.banksAt > now() - BANKS_RECHECK)) {
    ctx.planNow = { status: b.planStatus, plan: b.planId, banks: b.banks };
    return b.banks;
  }
  const r = await licenseForUser(env, ctx.keys, user);
  ctx.planNow = { status: r.status, plan: r.plan || null, banks: r.banks ?? 0 };
  return ctx.planNow.banks;
}
/**
 * Why a bank can't be used, for the app to explain: still in the free trial, subscribed but the first charge is
 * still to come, a payment failing, or the plan (none of its banks, or all of them in use).
 */
function bankLimitError(ctx, banks) {
  const status = ctx.planNow?.status ?? ctx.lic?.status;
  const reason = status === 'trial' ? 'trial' : status === 'trialing' ? 'first_payment' : status === 'past_due' ? 'payment_failed' : 'plan';
  return Object.assign(new HttpError(402, 'bank_limit'), {
    extra: { limit: Number.isFinite(banks) ? banks : null, reason, plan: ctx.planNow?.plan ?? ctx.lic?.plan ?? null },
  });
}

/**
 * Signed-in subscriber. The app sends its license (checked here offline, like on the device),
 * so a bank sync doesn't ask Stripe again on every request.
 */
async function requireLicense(ctx) {
  const { user } = await requireSession(ctx);
  if (!ctx.env.stripeKey || !ctx.env.licenseJwk) { ctx.lic = { status: 'free_mode' }; return user; } // server without billing: everything is free
  const auth = ctx.req.headers.get('authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const lic = await verifyES(auth.slice(7), licenseKeys(ctx.env).pub);
    if (lic?.sub === user.id) { ctx.lic = lic; return user; }
  }
  const r = await licenseForUser(ctx.env, ctx.keys, user);
  if (!r.license) throw new HttpError(402, 'subscription_required');
  ctx.lic = { status: r.status, plan: r.plan, banks: r.banks };
  return user;
}

// ---------------- Open Finance helpers ----------------
const ofIndex = (itemId) => `of:${itemId}`;
async function ownedItem(env, itemId, user, { allowSandbox = false } = {}) {
  if (!/^[\w-]{6,64}$/.test(itemId || '')) throw new HttpError(400, 'invalid_item');
  const item = await pluggy(env, 'GET', `/items/${encodeURIComponent(itemId)}`);
  const mine = item && (item.clientUserId === user.id || (user.billing?.legacySubs || []).includes(item.clientUserId));
  if (!mine) throw new HttpError(404, 'item_not_found');
  // Official site (PLUGGY_SANDBOX off): Pluggy's test bank has made-up numbers, so none of it reaches the app.
  // The app then removes that connection (deleting it is still allowed).
  if (item.connector?.isSandbox && !env.pluggySandbox && !allowSandbox) throw new HttpError(410, 'sandbox_item');
  // Remember the owner (for the bank webhook) the first time we see the item.
  const idx = await getKV('index');
  if (!(await idx.get(ofIndex(item.id)))) await idx.set(ofIndex(item.id), { userId: user.id, at: now() }).catch(() => {});
  return item;
}

const slimItem = (i) => ({
  id: i.id, status: i.status, executionStatus: i.executionStatus, lastUpdatedAt: i.lastUpdatedAt, createdAt: i.createdAt,
  connector: i.connector ? { id: i.connector.id, name: i.connector.name, imageUrl: i.connector.imageUrl, primaryColor: i.connector.primaryColor, sandbox: !!i.connector.isSandbox } : null,
});
const slimAccount = (a) => ({
  id: a.id, itemId: a.itemId, type: a.type, subtype: a.subtype, name: a.marketingName || a.name, number: a.number,
  balance: a.balance, currencyCode: a.currencyCode,
  credit: a.creditData ? {
    limit: a.creditData.creditLimit ?? null, available: a.creditData.availableCreditLimit ?? null, brand: a.creditData.brand || null,
    closeDate: a.creditData.balanceCloseDate || null, dueDate: a.creditData.balanceDueDate || null,
  } : null,
});
const slimTx = (t) => ({
  id: t.id, accountId: t.accountId, description: t.description || t.descriptionRaw || '', amount: t.amount,
  date: t.date, type: t.type, category: t.category || null, status: t.status,
  installment: t.creditCardMetadata?.installmentNumber ? `${t.creditCardMetadata.installmentNumber}/${t.creditCardMetadata.totalInstallments}` : null,
  card: t.creditCardMetadata?.cardNumber ? String(t.creditCardMetadata.cardNumber).replace(/\D/g, '').slice(-4) : null,
});
const slimInvestment = (v) => ({
  id: v.id, itemId: v.itemId, name: v.name, code: v.code, type: v.type, subtype: v.subtype,
  balance: v.balance, amount: v.amount, amountOriginal: v.amountOriginal, amountProfit: v.amountProfit,
  date: v.date, dueDate: v.dueDate, issuer: v.issuer, status: v.status,
});

/**
 * The bank connections of an account, oldest first, are written on it; the plan covers the first ones (after a
 * downgrade, the newest pause). A connection is used only while covered.
 */
async function coveredItem(ctx, user, itemId, opts) {
  const item = await ownedItem(ctx.env, itemId, user, opts);
  await registerItem(ctx, user, item);
  return item;
}

const MAX_ITEMS = 30;
/**
 * Counts a connection on the account (the first time the app reads it, or when Pluggy says it was made) and checks
 * the plan covers it. A new one beyond the plan (say, the connect window used again) would cost every month, so it
 * is removed at Pluggy right away. One made before plans counted banks stays for now, paused: the hourly check
 * removes it after 3 days if the plan still doesn't cover it.
 */
async function registerItem(ctx, user, item) {
  const list = user.of?.items || [];
  const pos = list.indexOf(item.id);
  if (pos >= 0) {
    const banks = await banksAllowed(ctx, user, pos + 1);
    if (pos >= banks) throw bankLimitError(ctx, banks);
    return;
  }
  const banks = await banksAllowed(ctx, user, list.length + 1);
  const older = Date.parse(item.createdAt || '') < Date.now() - 3600 * 1000;
  let res = 'full';
  await saveUser(user.id, (u) => {
    res = 'full';
    if (!u) return undefined;
    const cur = u.of?.items || [];
    if (cur.includes(item.id)) { res = cur.indexOf(item.id) < banks ? 'in' : 'over'; return undefined; }
    if (cur.length >= MAX_ITEMS) return undefined;
    if (cur.length < banks) res = 'in';
    else if (older) res = 'over';
    else return undefined;
    return { ...u, of: { ...(u.of || {}), items: [...cur, item.id] } };
  });
  if (res === 'full') {
    await pluggy(ctx.env, 'DELETE', `/items/${encodeURIComponent(item.id)}`).catch(() => {});
    await (await getKV('index')).delete(ofIndex(item.id)).catch(() => {});
    throw bankLimitError(ctx, banks);
  }
  // Watched by the hourly check (banks that stop being paid for are disconnected).
  await update('index', `ofc:${user.id}`, (cur) => {
    if (!cur) return { checkedAt: now(), ...(res === 'over' ? { overSince: now() } : {}) };
    return res === 'over' && !cur.overSince ? { ...cur, overSince: now() } : undefined;
  }).catch(() => {});
  if (res === 'over') throw bankLimitError(ctx, banks);
}

/** Pluggy says a connection was just made with this account's connect window: it counts against the plan at once. */
async function countNewItem(ctx, userId, itemId) {
  const user = await getUser(userId);
  if (!user || (user.of?.items || []).includes(itemId)) return;
  const item = await pluggy(ctx.env, 'GET', `/items/${encodeURIComponent(itemId)}`).catch(() => null);
  if (item?.clientUserId !== user.id) return;
  if (item.connector?.isSandbox && !ctx.env.pluggySandbox) return; // the app removes test-bank connections itself
  await (await getKV('index')).set(ofIndex(item.id), { userId: user.id, at: now() }).catch(() => {});
  await registerItem(ctx, user, item).catch(() => {});
}

async function listTransactions(env, accountId, from) {
  const out = [];
  const q = new URLSearchParams({ accountId });
  if (from) q.set('dateFrom', from);
  let path = `/v2/transactions?${q}`;
  try {
    for (let pages = 0; path && pages < 30; pages++) {
      const d = await pluggy(env, 'GET', path);
      out.push(...(d.results || []));
      path = d.next ? `/v2/transactions${d.next.startsWith('?') ? d.next : `?${d.next}`}` : null;
    }
    return out;
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 404) throw e;
  }
  // Older API (page based)
  for (let page = 1; page <= 30; page++) {
    const p = new URLSearchParams({ accountId, pageSize: '500', page: String(page) });
    if (from) p.set('from', from);
    const d = await pluggy(env, 'GET', `/transactions?${p}`);
    out.push(...(d.results || []));
    if (!d.totalPages || page >= d.totalPages) break;
  }
  return out;
}

/**
 * The secret in the bank webhook address. Each account has its own (so a leaked address can only poke that
 * account); connections made before v5 still use the old shared one, but only for banks we already know.
 */
const hookKey = async (keys, userId) => toB64((await hmac(keys.hook, userId ? `pluggy-webhook:${userId}` : 'pluggy-webhook')).subarray(0, 24));

// ---------------- encrypted sync ----------------
const MAX_SYNC = 4_500_000;
const syncKey = (userId) => sha256hex(`sync:${userId}`);

// ---------------- account cascade ----------------
// A password reset without the recovery key (new keys): the old encrypted copy, the phone links and the
// notification subscriptions all belonged to the old keys/devices. `user` is the account as it was before.
accountHooks.onKeysReplaced = async (user) => {
  await (await getKV('sync')).delete(await syncKey(user.id)).catch(() => {});
  await staleSpaces(user).catch(() => {});
  await dropWallet(user).catch(() => {});
  const push = await getKV('push');
  for (const k of user.push || []) await push.delete(k).catch(() => {});
};
// Devices signed out (logout, removed, wiped, password changed…): their notifications stop too.
accountHooks.onSessionsEnded = async (userId, sids) => {
  if (!sids?.length) return;
  const u = await getUser(userId);
  if (!u?.push?.length) return;
  const push = await getKV('push');
  const gone = [];
  for (const k of u.push) {
    const rec = await push.get(k).catch(() => null);
    if (!rec || (rec.sid && sids.includes(rec.sid))) { await push.delete(k).catch(() => {}); gone.push(k); }
  }
  if (gone.length) await saveUser(userId, (cur) => (cur ? { ...cur, push: (cur.push || []).filter((k) => !gone.includes(k)) } : undefined)).catch(() => {});
};
accountHooks.onDelete = async (ctx, user) => {
  const { env } = ctx;
  await (await getKV('sync')).delete(await syncKey(user.id)).catch(() => {});
  await dropSpaces(user).catch(() => {});
  await dropWallet(user).catch(() => {});
  const push = await getKV('push');
  for (const k of user.push || []) await push.delete(k).catch(() => {});
  // Bank connections at Pluggy.
  const idx = await getKV('index');
  for (const itemId of user.of?.items || []) {
    if (env.pluggyId) await pluggy(env, 'DELETE', `/items/${encodeURIComponent(itemId)}`).catch(() => {});
    await idx.delete(ofIndex(itemId)).catch(() => {});
  }
  await idx.delete(`ofc:${user.id}`).catch(() => {});
  // Stop charging: cancel any live subscription.
  if (env.stripeKey && user.billing?.stripeCustomer) {
    const list = await stripe(env, 'GET', '/subscriptions', { customer: user.billing.stripeCustomer, status: 'all', limit: 10 }).catch(() => ({ data: [] }));
    for (const s of list.data || []) {
      if (['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(s.status)) await stripe(env, 'DELETE', `/subscriptions/${s.id}`).catch(() => {});
    }
  }
};

// ---------------- routes ----------------
const routes = {
  ...authRoutes,
  ...accountRoutes,
  ...walletRoutes({ notifyUser }),
  ...spaceRoutes({ requireLicense, notifyUser }),

  'GET config': async (ctx) => {
    const { env } = ctx;
    let licensePublicJwk = null;
    try { licensePublicJwk = licenseKeys(env).pub; } catch { /* not configured */ }
    const billing = !!(env.stripeKey && licensePublicJwk && env.appSecret);
    return json({
      v: 6,
      auth: { required: true, emailVerification: true, reset: emailEnabled(env), email: emailEnabled(env) },
      // Test mode only (local server): leaked-password checks go to the fake service.
      ...(env.fakeHibp ? { hibpTest: '/__fake' } : {}),
      billing: {
        enabled: billing, price: env.priceCents, currency: env.currency, trialDays: env.trialDays, interval: 'month',
        plans: env.plans.map((x) => ({ id: x.id, price: x.cents, banks: x.banks })),
      },
      openFinance: { enabled: !!env.pluggyId, sandbox: env.pluggySandbox },
      support: { email: env.supportEmail, whatsapp: env.supportWhatsapp },
      push: { enabled: !!vapidKey(env), publicKey: vapidKey(env) ? vapidPublicKey(vapidKey(env)) : null },
      sync: { enabled: true },
      wallet: { enabled: true, iosShortcutUrl: env.iosShortcutUrl },
      spaces: { enabled: true, max: env.spaceMax },
      licensePublicJwk,
    }, 200, { 'Cache-Control': 'public, max-age=300' });
  },

  // ----- subscription -----
  'POST license': async (ctx) => {
    const { user } = await requireSession(ctx);
    const r = await licenseForUser(ctx.env, ctx.keys, user);
    return json({ license: r.license, status: r.status, plan: r.plan || null, banks: r.banks ?? null });
  },

  'POST billing/checkout': async (ctx) => {
    const { env, req } = ctx;
    const { user } = await requireSession(ctx);
    const plan = planById(env, String(ctx.body.plan || env.plans[0].id));
    if (!plan) throw new HttpError(400, 'invalid_plan');
    const email = await emailOf(ctx.keys, user);
    const origin = env.appOrigin || new URL(req.url).origin;
    let customer = user.billing?.stripeCustomer || null;
    if (!customer) {
      const c = await stripe(env, 'POST', '/customers', { email, metadata: { app: 'bloomfi', userId: user.id } });
      customer = c.id;
      await saveUser(user.id, (u) => (u ? { ...u, billing: { ...(u.billing || {}), stripeCustomer: customer } } : undefined));
    }
    const params = {
      mode: 'subscription', customer,
      client_reference_id: user.id,
      success_url: `${origin}/app/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/app/?checkout=cancel`,
      locale: user.lang === 'en' ? 'en' : 'pt-BR',
      allow_promotion_codes: 'true',
      line_items: [plan.stripePrice
        ? { price: plan.stripePrice, quantity: 1 }
        : { quantity: 1, price_data: { currency: env.currency, unit_amount: plan.cents, recurring: { interval: 'month' }, product_data: { name: plan.name } } }],
      subscription_data: { metadata: { app: 'bloomfi', userId: user.id, plan: plan.id } },
    };
    // Keep the rest of the free trial: the first charge happens when it ends (banks come with that first charge).
    // `startNow`: pay today instead, to connect banks right away. Someone already paying who changes plans pays
    // the new plan today (the old one ends when they come back, with the unused days credited).
    let ts = ctx.body.startNow === true ? null : user.billing?.trialStart;
    if (ts && customer && user.billing?.stripeCustomer) {
      const cur = await bestSubscription(env, customer).catch(() => null);
      if (cur && ['active', 'past_due'].includes(cur.status)) ts = null;
    }
    if (ts) {
      const te = ts + env.trialDays * DAY;
      if (te > now() + 2 * DAY + 300) params.subscription_data.trial_end = te;
    }
    const s = await stripe(env, 'POST', '/checkout/sessions', params);
    return json({ url: s.url });
  },

  'POST billing/claim': async (ctx) => {
    const { env } = ctx;
    const { user } = await requireSession(ctx);
    const id = String(ctx.body.sessionId || '');
    if (!/^cs_[\w]{10,200}$/.test(id)) throw new HttpError(400, 'invalid_session');
    const s = await stripe(env, 'GET', `/checkout/sessions/${id}`);
    if (s.status !== 'complete' || !s.customer) throw new HttpError(409, 'checkout_not_complete');
    if (s.client_reference_id !== user.id) throw new HttpError(403, 'not_your_checkout');
    if (user.billing?.stripeCustomer && user.billing.stripeCustomer !== s.customer) throw new HttpError(403, 'not_your_checkout');
    await saveUser(user.id, (u) => (u ? { ...u, billing: { ...(u.billing || {}), stripeCustomer: s.customer } } : undefined));
    // Changed plans (e.g. Plus -> Premium): the old subscription ends now; Stripe credits the unused days.
    if (s.subscription) {
      const list = await stripe(env, 'GET', '/subscriptions', { customer: s.customer, status: 'all', limit: 10 }).catch(() => ({ data: [] }));
      for (const old of list.data || []) {
        if (old.id !== s.subscription && ['active', 'trialing', 'past_due'].includes(old.status)) {
          await stripe(env, 'DELETE', `/subscriptions/${old.id}`, { prorate: 'true' }).catch(() => {});
        }
      }
    }
    const r = await licenseForUser(env, ctx.keys, await getUser(user.id));
    return json({ license: r.license, status: r.status });
  },

  // Banks come with the first payment. Someone who subscribed during the free trial can pay now instead of waiting
  // for the trial to end: the trial stops today and the first month starts. A refused card changes nothing.
  'POST billing/start-now': async (ctx) => {
    const { env } = ctx;
    const { user } = await requireSession(ctx);
    await hit('startnow', user.id, 6, 3600);
    const customer = user.billing?.stripeCustomer;
    if (!customer) throw new HttpError(400, 'no_billing_account');
    const sub = await bestSubscription(env, customer);
    if (sub?.status !== 'trialing') throw new HttpError(409, 'not_in_trial');
    try {
      await stripe(env, 'POST', `/subscriptions/${sub.id}`, { trial_end: 'now', proration_behavior: 'none', payment_behavior: 'error_if_incomplete' });
    } catch (e) {
      if (e.stripeStatus === 402) throw new HttpError(402, 'payment_failed');
      throw e;
    }
    const r = await licenseForUser(env, ctx.keys, await getUser(user.id));
    return json({ license: r.license, status: r.status, plan: r.plan || null, banks: r.banks ?? null });
  },

  'POST billing/portal': async (ctx) => {
    const { env, req } = ctx;
    const { user } = await requireSession(ctx);
    const customer = user.billing?.stripeCustomer;
    if (!customer) throw new HttpError(400, 'no_billing_account');
    const origin = env.appOrigin || new URL(req.url).origin;
    try {
      const s = await stripe(env, 'POST', '/billing_portal/sessions', { customer, return_url: `${origin}/app/#settings`, locale: user.lang === 'en' ? 'en' : 'pt-BR' });
      return json({ url: s.url });
    } catch (e) {
      // Stripe refuses portal sessions until the Customer portal is saved in the dashboard.
      if (e instanceof HttpError && /configuration|portal/i.test(e.detail || '')) throw new HttpError(409, 'portal_not_configured');
      throw e;
    }
  },

  // Access codes made with ferramentas/gerar-codigo-acesso.html (gift) and old v3/v4 account tokens.
  'POST billing/redeem': async (ctx) => {
    const { env } = ctx;
    const { user } = await requireSession(ctx);
    await hit('redeem', user.id, 10, 3600);
    const legacy = await readLegacy(env, { accountToken: String(ctx.body.code || '').trim() });
    if (!legacy) throw new HttpError(400, 'invalid_code');
    if (legacy.kind === 'gift' && !(legacy.until > now())) throw new HttpError(400, 'code_expired');
    // A gift for pai@… only works on pai@…'s account, and each code works for one account only.
    await claimLegacy(legacy, user, await emailOf(ctx.keys, user));
    await saveUser(user.id, (u) => (u ? withEvent({ ...u, billing: { ...(u.billing || {}), ...linkLegacy(u.billing, legacy) } }, { t: now(), type: 'code_redeemed', dev: ctx.deviceName || '' }) : undefined));
    if (legacy.sub) await (await getKV('index')).set(`legacy:${toB64(await sha256(legacy.sub))}`, { userId: user.id }).catch(() => {});
    const r = await licenseForUser(env, ctx.keys, await getUser(user.id));
    return json({ license: r.license, status: r.status });
  },

  // ----- Open Finance (subscribers) -----
  'POST of/connect-token': async (ctx) => {
    const { env, req } = ctx;
    const user = await requireLicense(ctx);
    const payload = { options: { clientUserId: user.id, avoidDuplicates: true } };
    // Each bank costs every month: only within the plan, and only once the plan has been paid.
    if (ctx.body.itemId) {
      // Signing in to a connected bank again: one of theirs that the plan covers.
      payload.itemId = (await coveredItem(ctx, user, String(ctx.body.itemId))).id;
    } else {
      const have = (user.of?.items || []).length;
      const banks = await banksAllowed(ctx, user, have + 1);
      if (have >= banks) throw bankLimitError(ctx, banks);
    }
    const origin = env.appOrigin || new URL(req.url).origin;
    // Pluggy tells us when new data arrives (needs a public HTTPS address).
    if (/^https:\/\//.test(origin) && !/localhost|127\.0\.0\.1/.test(origin)) payload.options.webhookUrl = `${origin}/api/of/webhook?u=${user.id}&k=${await hookKey(ctx.keys, user.id)}`;
    const d = await pluggy(env, 'POST', '/connect_token', payload);
    return json({ accessToken: d.accessToken });
  },

  'GET of/item': async (ctx) => {
    const user = await requireLicense(ctx);
    const item = await coveredItem(ctx, user, ctx.url.searchParams.get('id'));
    return json(slimItem(item));
  },

  // Disconnecting always works, with or without a plan (it stops the monthly cost).
  'DELETE of/item': async (ctx) => {
    const { user } = await requireSession(ctx);
    const item = await ownedItem(ctx.env, ctx.url.searchParams.get('id'), user, { allowSandbox: true });
    await pluggy(ctx.env, 'DELETE', `/items/${encodeURIComponent(item.id)}`);
    await (await getKV('index')).delete(ofIndex(item.id)).catch(() => {});
    let left = 0;
    await saveUser(user.id, (u) => {
      if (!u) return undefined;
      const items = (u.of?.items || []).filter((x) => x !== item.id);
      left = items.length;
      return { ...u, of: { ...(u.of || {}), items } };
    }).catch(() => {});
    if (!left) await (await getKV('index')).delete(`ofc:${user.id}`).catch(() => {});
    return json({ ok: true });
  },

  // Asks the bank for fresh data now (at most every 2 hours per connection, to respect Open Finance limits).
  'POST of/refresh': async (ctx) => {
    const user = await requireLicense(ctx);
    const item = await coveredItem(ctx, user, String(ctx.body.itemId || ''));
    let started = false;
    await update('index', ofIndex(item.id), (cur) => {
      if ((cur?.refreshedAt || 0) > now() - 2 * 3600) return undefined;
      started = true;
      return { ...(cur || { userId: user.id }), refreshedAt: now() };
    });
    if (started) await pluggy(ctx.env, 'PATCH', `/items/${encodeURIComponent(item.id)}`, {}).catch(() => { started = false; });
    return json({ started });
  },

  'GET of/accounts': async (ctx) => {
    const user = await requireLicense(ctx);
    const item = await coveredItem(ctx, user, ctx.url.searchParams.get('itemId'));
    const d = await pluggy(ctx.env, 'GET', `/accounts?itemId=${encodeURIComponent(item.id)}`);
    return json({ results: (d.results || []).map(slimAccount) });
  },

  'GET of/transactions': async (ctx) => {
    const user = await requireLicense(ctx);
    const accountId = ctx.url.searchParams.get('accountId') || '';
    if (!/^[\w-]{6,64}$/.test(accountId)) throw new HttpError(400, 'invalid_account');
    const acc = await pluggy(ctx.env, 'GET', `/accounts/${encodeURIComponent(accountId)}`);
    await coveredItem(ctx, user, acc.itemId);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(ctx.url.searchParams.get('from') || '') ? ctx.url.searchParams.get('from') : null;
    const list = await listTransactions(ctx.env, accountId, from);
    return json({ results: list.map(slimTx) });
  },

  'GET of/investments': async (ctx) => {
    const user = await requireLicense(ctx);
    const item = await coveredItem(ctx, user, ctx.url.searchParams.get('itemId'));
    const d = await pluggy(ctx.env, 'GET', `/investments?itemId=${encodeURIComponent(item.id)}`);
    return json({ results: (d.results || []).map(slimInvestment) });
  },

  // Pluggy -> us: "this connection has new data". We only note it and wake the user's devices.
  'POST of/webhook': async (ctx) => {
    const k = ctx.url.searchParams.get('k') || '';
    const u = ctx.url.searchParams.get('u') || '';
    const own = /^u_[\w-]{10,40}$/.test(u) && sameBytes(k, await hookKey(ctx.keys, u));
    if (!own && !sameBytes(k, await hookKey(ctx.keys))) throw new HttpError(404, 'not_found');
    const ev = ctx.body || {};
    const itemId = typeof ev.itemId === 'string' ? ev.itemId : ev.item?.id;
    if (!/^[\w-]{6,64}$/.test(itemId || '')) return json({ ok: true });
    // A connection just made with this account's connect window (even one the app never reads) counts at once.
    if (own && ev.event === 'item/created') { ctx.later(countNewItem(ctx, u, itemId)); return json({ ok: true }); }
    const idx = await getKV('index');
    let userId = (await idx.get(ofIndex(itemId)))?.userId;
    if (own) {
      // Per-account address: only that account, and only for its own banks.
      if (userId && userId !== u) return json({ ok: true });
      if (!userId && ev.clientUserId !== u) return json({ ok: true });
      userId = u;
    } else if (!userId && typeof ev.clientUserId === 'string' && !/^u_/.test(ev.clientUserId)) {
      // Old shared address: only connections from before accounts (mapped when they were made).
      userId = (await idx.get(`legacy:${toB64(await sha256(ev.clientUserId))}`))?.userId;
    }
    const user = userId && await getUser(userId);
    if (!user) return json({ ok: true });
    const interesting = ['transactions/created', 'transactions/updated', 'item/updated', 'transactions/deleted'].includes(ev.event);
    if (!interesting) return json({ ok: true });
    await saveUser(user.id, (u) => (u ? { ...u, of: { ...(u.of || {}), signal: now() } } : undefined)).catch(() => {});
    if (ev.event === 'transactions/created' && user.prefs?.captureAlerts !== false) {
      ctx.later(notifyUser(ctx.env, user, {
        title: user.lang === 'en' ? '🏦 New bank transactions' : '🏦 Novos lançamentos do banco',
        body: user.lang === 'en' ? 'Open BloomFi to update.' : 'Abra o BloomFi para atualizar.', tag: 'bank', url: '/app/#home', kind: 'bank',
      }));
    }
    return json({ ok: true });
  },

  // ----- reminders & alerts (Web Push) -----
  // Saves (or replaces) the reminder schedule of one device. Only times and short texts, never amounts or names
  // unless the user turned that on; the push service gets them encrypted.
  'POST push': async (ctx) => {
    const { env } = ctx;
    if (!vapidKey(env)) throw new HttpError(503, 'push_not_configured');
    const { user, session } = await requireSession(ctx);
    await hit('push', user.id, 60, 3600);
    const sub = ctx.body.subscription || {};
    if (!allowedEndpoint(sub.endpoint, env.pushAllowLocal)) throw new HttpError(400, 'invalid_endpoint');
    if (typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string' || sub.keys.p256dh.length > 120 || sub.keys.auth.length > 60) throw new HttpError(400, 'invalid_keys');
    const key = await sha256hex(sub.endpoint);
    const items = cleanReminders(ctx.body.items);
    // Tied to this device's session (signing it out stops its notifications). If this browser belonged to
    // another account before, the subscription moves to the account signed in now.
    let previous = null;
    await update('push', key, (cur) => {
      previous = cur?.userId && cur.userId !== user.id ? cur.userId : null;
      return { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, items, userId: user.id, sid: session.id, updatedAt: now() };
    });
    if (previous) await saveUser(previous, (u) => (u ? { ...u, push: (u.push || []).filter((k) => k !== key) } : undefined)).catch(() => {});
    if (!(user.push || []).includes(key)) await saveUser(user.id, (u) => (u ? { ...u, push: [...new Set([...(u.push || []), key])].slice(-10) } : undefined));
    return json({ ok: true, scheduled: items.length });
  },
  'POST push/remove': async (ctx) => {
    const { user } = await requireSession(ctx);
    if (typeof ctx.body.endpoint !== 'string' || ctx.body.endpoint.length > 1000) throw new HttpError(400, 'invalid_endpoint');
    const key = await sha256hex(ctx.body.endpoint);
    const store = await getKV('push');
    const rec = await store.get(key);
    if (rec && rec.userId && rec.userId !== user.id) throw new HttpError(404, 'not_found');
    await store.delete(key);
    await saveUser(user.id, (u) => (u ? { ...u, push: (u.push || []).filter((k) => k !== key) } : undefined)).catch(() => {});
    return json({ ok: true });
  },
  'POST push/test': async (ctx) => {
    const { env } = ctx;
    const jwk = vapidKey(env);
    if (!jwk) throw new HttpError(503, 'push_not_configured');
    const { user } = await requireSession(ctx);
    await hit('push-test', user.id, 10, 3600);
    const rec = await (await getKV('push')).get(await sha256hex(String(ctx.body.endpoint || '')));
    if (!rec || rec.userId !== user.id) throw new HttpError(404, 'not_subscribed');
    const en = ctx.body.lang === 'en';
    const r = await sendPush(rec.sub, {
      title: 'BloomFi', body: en ? 'Notifications are working ✓' : 'As notificações estão funcionando ✓', tag: 'test', url: '/app/#agenda',
    }, { jwk, subject: env.vapidSubject });
    return json({ ok: r === 'sent', result: r });
  },

  // ----- encrypted sync (the server only ever sees ciphertext) -----
  'GET sync': async (ctx) => {
    const { user } = await requireSession(ctx);
    const rec = await (await getKV('sync')).get(await syncKey(user.id));
    if (ctx.url.searchParams.get('meta') === '1') return json({ exists: !!rec, version: rec?.version || 0, updatedAt: rec?.updatedAt || null, keyVersion: rec?.keyVersion || null });
    return json(rec ? { version: rec.version, updatedAt: rec.updatedAt, keyVersion: rec.keyVersion || null, data: rec.data } : { version: 0, data: null });
  },
  'PUT sync': async (ctx) => {
    const { user } = await requireSession(ctx);
    const body = ctx.body;
    if (typeof body.data !== 'string' || !body.data || body.data.length > MAX_SYNC) throw new HttpError(400, 'invalid_data');
    const kv = user.keys?.keyVersion || 0;
    if (Number(body.keyVersion) !== kv) throw new HttpError(409, 'key_changed');
    const store = await getKV('sync');
    const key = await syncKey(user.id);
    const { value: rec, tag } = await store.getVersioned(key);
    const version = rec?.version || 0;
    if (Number(body.baseVersion) !== version) return json({ error: 'conflict', version }, 409);
    const next = { version: version + 1, updatedAt: now(), keyVersion: kv, data: body.data };
    // Compare-and-set: if another device wrote in between, this one merges again.
    if (!(await store.setVersioned(key, next, tag))) return json({ error: 'conflict', version: version + 1 }, 409);
    return json({ version: next.version, updatedAt: next.updatedAt });
  },
  'DELETE sync': async (ctx) => {
    const { user } = await requireSession(ctx);
    await (await getKV('sync')).delete(await syncKey(user.id));
    return json({ ok: true });
  },
};

/** For the deployment test: every route must be reachable through a Netlify function path. */
export const ROUTE_KEYS = Object.keys(routes);
const PUBLIC_ROUTES = new Set(['GET config', 'POST wallet/in', 'POST of/webhook']);
const BODY_LIMIT = (path) => (path === 'sync' ? MAX_SYNC + 1000 : path === 'spaces/data' ? MAX_SPACE_DATA + 1000 : path.startsWith('push') ? 40_000 : 20_000);

export async function handle(req, context) {
  const url = new URL(req.url);
  let path = url.pathname.replace(/^.*?\/api\//, '').replace(/\/+$/, '');
  let pathParam = null;
  const m = path.match(/^wallet\/in\/([^/]+)$/);
  if (m) { pathParam = m[1]; path = 'wallet/in'; }
  const route = routes[`${req.method} ${path}`];
  if (!route) return json({ error: 'not_found' }, 404);
  const env = getEnv();
  const pending = [];
  const ctx = {
    env, req, url, pathParam, ip: clientIp(req, context), geo: geoOf(context), body: {},
    later: (p) => {
      const safe = Promise.resolve(p).catch(() => {});
      if (context?.waitUntil) context.waitUntil(safe); else pending.push(safe);
    },
  };
  try {
    // Every route the app calls only answers our own pages (X-BloomFi header + Origin + Sec-Fetch-Site):
    // no login CSRF, no cross-site logout. Public: the config, the phone automation and the bank webhook.
    if (!PUBLIC_ROUTES.has(`${req.method} ${path}`)) {
      assertSameOrigin(ctx);
      const type = req.headers.get('content-type') || '';
      if (!['GET', 'HEAD', 'DELETE'].includes(req.method) && req.headers.get('content-length') !== '0' && type && !/^application\/json\b/i.test(type)) throw new HttpError(415, 'json_only');
    }
    if (path !== 'config' && !env.appSecret) throw new HttpError(503, 'server_not_configured');
    if (path !== 'config') ctx.keys = await serverKeys(env.appSecret);
    ctx.licenseFor = (user) => licenseForUser(env, ctx.keys, user);
    // The phone automation sends raw text; everything else is JSON.
    if (path !== 'wallet/in') ctx.body = await readBody(req, BODY_LIMIT(path));
    const res = await route(ctx);
    if (ctx.setCookie) res.headers.append('Set-Cookie', ctx.setCookie);
    return res;
  } catch (e) {
    if (e instanceof HttpError) {
      const res = json({ error: e.code, ...(e.extra || {}) }, e.status, e.extra?.retryAfter ? { 'Retry-After': String(e.extra.retryAfter) } : {});
      if (ctx.setCookie) res.headers.append('Set-Cookie', ctx.setCookie);
      // A dead session: drop the cookie too.
      if (e.status === 401 && /^session_|^no_session/.test(e.code)) res.headers.append('Set-Cookie', `${env.cookieName}=; Path=/; HttpOnly;${env.cookieSecure === false ? '' : ' Secure;'} SameSite=Strict; Max-Age=0`);
      return res;
    }
    if (e?.code === 'storage_conflict') return json({ error: 'busy' }, 503, { 'Retry-After': '2' });
    console.error('[api]', e?.message || e);
    return json({ error: 'server_error' }, 500);
  } finally {
    // Locally (no waitUntil) background work still finishes; tests can await it.
    if (pending.length) handle.lastBackground = Promise.all(pending);
  }
}
export { assertSameOrigin };
