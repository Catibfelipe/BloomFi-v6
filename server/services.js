/**
 * Thin clients for the outside services. Base URLs can be overridden by
 * environment variables so the whole server can be tested locally against
 * fake services.
 */

/**
 * Running on Netlify (not the local server or the tests). There, request headers such as X-Forwarded-For can be
 * forged and the test switches (LOCAL_HTTP, FAKE, PUSH_ALLOW_LOCALHOST) are ignored even if someone sets them.
 */
export const onNetlify = () => !!(globalThis.Netlify || process.env.NETLIFY_BLOBS_CONTEXT || process.env.AWS_LAMBDA_FUNCTION_NAME);

/**
 * Plans, by how many banks each one connects through Open Finance (each connection has a monthly cost at Pluggy).
 * Prices and bank counts can be changed with PLAN_<ID>_CENTS / PLAN_<ID>_BANKS; a Stripe price can be used
 * instead of the inline price with STRIPE_PRICE_<ID> (STRIPE_PRICE_ID / PRICE_CENTS still work for Essencial).
 */
export const PLAN_DEFAULTS = [
  { id: 'essencial', name: 'BloomFi Essencial', cents: 1490, banks: 0 },
  { id: 'plus', name: 'BloomFi Plus', cents: 2490, banks: 3 },
  { id: 'premium', name: 'BloomFi Premium', cents: 3490, banks: 6 },
];
function plansFrom(e) {
  return PLAN_DEFAULTS.map((p) => {
    const up = p.id.toUpperCase();
    const cents = Number(e[`PLAN_${up}_CENTS`] || (p.id === 'essencial' ? e.PRICE_CENTS : '') || p.cents);
    const rawBanks = e[`PLAN_${up}_BANKS`];
    const banks = rawBanks != null && rawBanks !== '' && Number.isFinite(Number(rawBanks)) ? Math.min(Math.max(Math.floor(Number(rawBanks)), 0), 30) : p.banks;
    const stripePrice = e[`STRIPE_PRICE_${up}`] || (p.id === 'essencial' ? e.STRIPE_PRICE_ID : '') || '';
    return { ...p, cents: Number.isFinite(cents) && cents > 0 ? Math.round(cents) : p.cents, banks, stripePrice };
  });
}

export function getEnv() {
  const e = process.env;
  const local = e.LOCAL_HTTP === '1' && !onNetlify();
  return {
    appSecret: e.APP_SECRET || '',
    licenseJwk: e.LICENSE_PRIVATE_JWK || '',
    stripeKey: e.STRIPE_SECRET_KEY || '',
    plans: plansFrom(e),
    priceCents: plansFrom(e)[0].cents, // the lowest plan (shown as "a partir de")
    currency: (e.PRICE_CURRENCY || 'brl').toLowerCase(),
    trialDays: Number(e.TRIAL_DAYS || 7),
    pluggyId: e.PLUGGY_CLIENT_ID || '',
    pluggySecret: e.PLUGGY_CLIENT_SECRET || '',
    pluggySandbox: e.PLUGGY_SANDBOX === 'true',
    resendKey: e.RESEND_API_KEY || '',
    emailFrom: e.EMAIL_FROM || 'BloomFi <onboarding@resend.dev>',
    freeEmails: (e.FREE_ACCESS_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    stripeBase: e.STRIPE_API_BASE || 'https://api.stripe.com',
    pluggyBase: e.PLUGGY_API_BASE || 'https://api.pluggy.ai',
    resendBase: e.RESEND_API_BASE || 'https://api.resend.com',
    supportEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.SUPPORT_EMAIL || '') ? e.SUPPORT_EMAIL.trim() : null,
    supportWhatsapp: (e.SUPPORT_WHATSAPP || '').replace(/\D/g, '') || null,
    vapidJwk: e.VAPID_PRIVATE_JWK || '',
    vapidSubject: e.VAPID_SUBJECT || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.SUPPORT_EMAIL || '') ? `mailto:${e.SUPPORT_EMAIL.trim()}` : 'mailto:suporte@bloomfi.app'),
    pushAllowLocal: e.PUSH_ALLOW_LOCALHOST === '1' && !onNetlify(),
    // ---- v5: accounts ----
    // The local server on your computer (plain http): e-mail codes show in the Terminal when there is no Resend key.
    localHttp: local,
    // Test mode only: the app checks leaked passwords against the fake service instead of haveibeenpwned.com.
    fakeHibp: local && e.FAKE === '1',
    // Session cookie: "__Host-" + Secure on the real site (HTTPS). Only the local test server (plain http,
    // where Safari refuses Secure cookies) sets LOCAL_HTTP=1 and gets a plain cookie name.
    cookieName: local ? 'bf_s' : e.COOKIE_NAME || '__Host-bf_s',
    cookieSecure: !local,
    // Optional: only accept browser requests from this origin (e.g. https://bloomfi.com.br)
    appOrigin: (e.APP_ORIGIN || '').replace(/\/+$/, ''),
    // Ready-made iPhone shortcut (iCloud link) shown in the phone-capture setup, optional.
    iosShortcutUrl: /^https:\/\/www\.icloud\.com\/shortcuts\/[\w-]+$/.test(e.IOS_SHORTCUT_URL || '') ? e.IOS_SHORTCUT_URL : null,
    quiet: e.QUIET_LOGS === '1',
    // Account e-mails (codes, "you already have an account") answer no sooner than this, sent or not, so the
    // answer time doesn't tell whether an e-mail has an account. Tests set EMAIL_MIN_MS=0.
    mailFloorMs: Math.min(Math.max(e.EMAIL_MIN_MS === undefined || e.EMAIL_MIN_MS === '' ? 1500 : Number(e.EMAIL_MIN_MS) || 0, 0), 10000),
    // ---- v6: shared spaces (each person has their own plan) ----
    spaceMax: Math.min(Math.max(Number(e.SPACE_MAX_MEMBERS) || 5, 2), 10),
  };
}

export class HttpError extends Error {
  constructor(status, code, detail) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

// ---------------- Stripe ----------------
/** Encodes nested objects the way Stripe expects: a[b][0][c]=1 */
function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe(env, method, path, params) {
  if (!env.stripeKey) throw new HttpError(503, 'billing_not_configured');
  let url = `${env.stripeBase}/v1${path}`;
  const init = { method, headers: { Authorization: `Bearer ${env.stripeKey}` } };
  if (params && method === 'GET') url += `?${formEncode(params)}`;
  else if (params) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = formEncode(params).toString();
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Shows up in the Netlify function log: a restricted key (rk_...) missing a permission, a wrong key, the
    // Customer portal not saved yet... Stripe's message names what is missing and never contains the whole key.
    if (res.status !== 404 && !env.quiet) console.error(`[stripe] ${method} ${path.replace(/\/[a-z]{2,8}_\w*[A-Z0-9]\w*/g, '/…')} → ${res.status}: ${data?.error?.message || 'sem resposta'}`);
    throw Object.assign(new HttpError(res.status === 404 ? 404 : 502, 'stripe_error', data?.error?.message), { stripeStatus: res.status, stripeCode: data?.error?.code || null });
  }
  return data;
}

// ---------------- Pluggy ----------------
let pluggyKey = null; // { key, exp }

export async function pluggy(env, method, path, body) {
  if (!env.pluggyId || !env.pluggySecret) throw new HttpError(503, 'openfinance_not_configured');
  if (!pluggyKey || pluggyKey.exp < Date.now()) {
    const r = await fetch(`${env.pluggyBase}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: env.pluggyId, clientSecret: env.pluggySecret }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.apiKey) throw new HttpError(502, 'pluggy_auth_failed');
    // API keys last 2 hours; renew a little earlier.
    pluggyKey = { key: d.apiKey, exp: Date.now() + 100 * 60 * 1000 };
  }
  const res = await fetch(`${env.pluggyBase}${path}`, {
    method,
    headers: { 'X-API-KEY': pluggyKey.key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) pluggyKey = null;
  if (method === 'DELETE' && res.ok) return { ok: true };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, 'pluggy_error', data?.message);
  return data;
}

export function resetPluggyKey() { pluggyKey = null; }
