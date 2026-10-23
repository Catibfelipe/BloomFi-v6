/**
 * Account flows on the device: sign up, sign in (with 2FA), reset, password change,
 * recovery key, devices. The password never leaves the device: it is turned into keys
 * here (lib/keys.js) and only `authKey` is sent.
 *
 * Without a server (the single-page link), accounts live only on this device: the
 * password still encrypts everything, and the recovery key can reset it.
 */
import { api } from './billing.js';
import {
  deriveMaster, authKeyOf, createAccountKeys, unwrapDataKey, newKdf, encKeyOf, seal, open, recoveryKeysOf, parseRecoveryKey,
  newRecoveryKey, pwnedCount, rand, b64u, newKeyPair, wrapPrivateKey,
} from './keys.js';

export function thisDevice() {
  const ua = navigator.userAgent || '';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Navegador';
  const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  const platform = os === 'iPhone' || os === 'iPad' ? 'ios' : os === 'Android' ? 'android' : os === 'Mac' ? 'mac' : os === 'Windows' ? 'windows' : os === 'Linux' ? 'linux' : 'other';
  return { name: `${os}${br ? ` · ${standalone ? 'app' : br}` : ''}`, platform };
}

// ---------------- sign up ----------------
export async function signupStart({ name, email, password, lang }) {
  const kdf = await newKdf('account');
  const master = await deriveMaster(password, kdf);
  const r = await api('auth/signup', { method: 'POST', body: { name, email, kdf, authKey: await authKeyOf(master), lang } });
  return { ...r, ctx: { master, kdf, email: email.trim().toLowerCase(), name } };
}

export const signupVerify = (challengeId, code) => api('auth/signup/verify', { method: 'POST', body: { challengeId, code } });
export const resendCode = (challengeId) => api('auth/resend', { method: 'POST', body: { challengeId } });

/** Creates the keys and finishes the account. legacy = { accountToken, trialStart } from version 4. */
export async function signupFinish(ctx, { ticket, share }, legacy) {
  const bundle = await createAccountKeys(ctx.master, share);
  const login = await api('auth/signup/finish', { method: 'POST', body: { ticket, keys: bundle.keys, device: thisDevice(), legacy: legacy || undefined }, timeout: 30000 });
  return { login, dataKey: bundle.dataKey, recoveryText: bundle.recoveryText, master: ctx.master, kdf: ctx.kdf, isNew: true };
}

// ---------------- sign in ----------------
/**
 * Returns one of:
 *  { done: {…} }                                  signed in
 *  { need2fa: true, ticket, ctx }                 ask for the authenticator code
 *  { needEmail: true, ticket, challengeId, ctx }  many wrong passwords lately: a code was e-mailed
 *  { setup: true, ticket, share, ctx }            confirmed but keys never saved (interrupted sign-up)
 */
export async function loginStart({ email, password }) {
  const mail = email.trim().toLowerCase();
  const { kdf } = await api('auth/prelogin', { method: 'POST', body: { email: mail } });
  // The settings come from the server: refused if weaker than the app's own (account: true).
  const master = await deriveMaster(password, kdf, { account: true });
  const ctx = { master, kdf, email: mail };
  const r = await api('auth/login', { method: 'POST', body: { email: mail, authKey: await authKeyOf(master), device: thisDevice() } });
  return loginNext(ctx, r);
}
/**
 * Signs in with keys already derived (no second Argon2 run): after a sign-up whose last step reached the server
 * but whose answer was lost, the account is there and complete.
 */
export async function loginWithMaster(ctx) {
  const r = await api('auth/login', { method: 'POST', body: { email: ctx.email, authKey: await authKeyOf(ctx.master), device: thisDevice() } });
  return loginNext(ctx, r);
}
function loginNext(ctx, r) {
  if (r.need2fa) return { need2fa: true, ticket: r.ticket, ctx };
  if (r.needEmail) return { needEmail: true, ticket: r.ticket, challengeId: r.challengeId, email: r.email, ctx };
  if (r.setup) return { setup: true, ticket: r.ticket, share: r.share, ctx };
  return openLogin(ctx, r).then((done) => ({ done }));
}

export async function login2fa(ctx, ticket, { code, backup }) {
  const r = await api('auth/login/2fa', { method: 'POST', body: { ticket, code, backup, device: thisDevice() } });
  return openLogin(ctx, r);
}
/** The code e-mailed when the account had many wrong passwords. Same answers as loginStart. */
export async function loginEmail(ctx, ticket, challengeId, code) {
  const r = await api('auth/login/email', { method: 'POST', body: { ticket, challengeId, code, device: thisDevice() } });
  return loginNext(ctx, r);
}

/** Opens the data key sent by the server with the password + the server's key share. */
export async function openLogin(ctx, r) {
  let dataKey;
  try { dataKey = await unwrapDataKey(ctx.master, r.share, r.keys.wrappedDataKey); } catch { throw Object.assign(new Error('key_mismatch'), { code: 'key_mismatch' }); }
  return { login: r, dataKey, master: ctx.master, kdf: ctx.kdf, isNew: false };
}

// ---------------- forgot password ----------------
export const resetStart = (email) => api('auth/reset/start', { method: 'POST', body: { email: email.trim().toLowerCase() } });
export const resetVerify = (challengeId, code, extra = {}) => api('auth/reset/verify', { method: 'POST', body: { challengeId, code, ...extra } });

/**
 * With the recovery key: same data key (everything kept), new password.
 * Without it: brand-new keys (and a new recovery key); the old cloud copy can't be opened anymore,
 * but a device that still has the data puts it back after signing in again.
 */
export async function resetFinish({ ticket, share, recovery, recoveryText, password, email }) {
  const kdf = await newKdf('account');
  const master = await deriveMaster(password, kdf);
  const authKey = await authKeyOf(master);
  if (recoveryText) {
    const bytes = parseRecoveryKey(recoveryText);
    if (!bytes || !recovery?.wrap) throw Object.assign(new Error('invalid_recovery'), { code: 'invalid_recovery' });
    const rk = await recoveryKeysOf(bytes, share);
    let dataKey;
    try { dataKey = await open(rk.enc, recovery.wrap); } catch { throw Object.assign(new Error('invalid_recovery'), { code: 'invalid_recovery' }); }
    const login = await api('auth/reset/finish', {
      method: 'POST',
      body: { ticket, mode: 'recovery', recoveryAuth: rk.auth, kdf, authKey, keys: { wrappedDataKey: await seal(await encKeyOf(master, share), dataKey) }, device: thisDevice() },
    });
    return { login, dataKey, master, kdf, email, isNew: false, mode: 'recovery' };
  }
  const bundle = await createAccountKeys(master, share);
  const login = await api('auth/reset/finish', { method: 'POST', body: { ticket, mode: 'fresh', kdf, authKey, keys: bundle.keys, device: thisDevice() } });
  return { login, dataKey: bundle.dataKey, master, kdf, email, recoveryText: bundle.recoveryText, isNew: false, mode: 'fresh' };
}

// ---------------- signed-in actions ----------------
/**
 * Password (+ 2FA) again before one sensitive change. scope = password | recovery | 2fa | email | delete | pin.
 * Returns { ticket, share, master } (the ticket works once, for that change only) or { need2fa }.
 */
export async function reauth(password, kdf, extra = {}) {
  const master = await deriveMaster(password, kdf, { account: true });
  const r = await api('account/reauth', { method: 'POST', body: { authKey: await authKeyOf(master), ...extra } });
  return { ...r, master };
}

/** New password: same data key, re-wrapped. Returns what the local vault needs. */
export async function changePassword({ ticket, share, dataKey, newPassword, signOutOthers }) {
  const kdf = await newKdf('account');
  const master = await deriveMaster(newPassword, kdf);
  const r = await api('account/password', {
    method: 'POST',
    body: { reauth: ticket, kdf, authKey: await authKeyOf(master), keys: { wrappedDataKey: await seal(await encKeyOf(master, share), dataKey) }, signOutOthers: !!signOutOthers },
  });
  return { master, kdf, pwv: r.pwv };
}

export async function newRecoveryKeyFor({ ticket, share, dataKey }) {
  const rk = newRecoveryKey();
  const rks = await recoveryKeysOf(rk.bytes, share);
  await api('account/recovery', { method: 'POST', body: { reauth: ticket, wrap: await seal(rks.enc, dataKey), auth: rks.auth } });
  return rk.text;
}

export const twoFactor = {
  setup: (ticket) => api('account/2fa/setup', { method: 'POST', body: { reauth: ticket } }),
  enable: (code) => api('account/2fa/enable', { method: 'POST', body: { code } }),
  disable: (ticket) => api('account/2fa/disable', { method: 'POST', body: { reauth: ticket } }),
  backup: (ticket) => api('account/2fa/backup', { method: 'POST', body: { reauth: ticket } }),
};

export const devicesApi = {
  list: () => api('account/devices'),
  revoke: (id, wipe) => api('account/devices/revoke', { method: 'POST', body: { id, wipe: !!wipe } }),
  revokeOthers: (wipe) => api('account/devices/revoke-others', { method: 'POST', body: { wipe: !!wipe } }),
};
export const activityApi = () => api('account/activity');
export const sessionInfo = () => api('account/session', { timeout: 8000 });
export const logoutApi = () => api('account/logout', { method: 'POST', timeout: 6000 });
export const updateProfile = (patch) => api('account/profile', { method: 'POST', body: patch });
export const changeEmailStart = (ticket, email) => api('account/email', { method: 'POST', body: { reauth: ticket, email } });
export const changeEmailVerify = (challengeId, code) => api('account/email/verify', { method: 'POST', body: { challengeId, code } });
export const deleteAccountApi = (ticket) => api('account/delete', { method: 'POST', body: { reauth: ticket } });

/**
 * Times a password appears in known leaks. Asked straight to haveibeenpwned.com with only 5 characters of
 * its SHA-1 (k-anonymity) and padded answers: our own server never sees any part of the password.
 * 0 when unknown/offline. `testBase` (local test server only) points to the fake service.
 */
let hibpTest = null;
/** Test mode only (set from the local test server's config; ignored anywhere but localhost). */
export const setLeakCheckTestBase = (base) => { hibpTest = base || null; };
export async function pwnedTimes(password, { testBase = hibpTest } = {}) {
  const local = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const base = local && typeof testBase === 'string' && testBase.startsWith('/') ? testBase : 'https://api.pwnedpasswords.com';
  const get = async (prefix, padded) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(`${base}/range/${prefix}`, {
        headers: padded ? { 'Add-Padding': 'true' } : {}, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`http_${r.status}`);
      return await r.text();
    } finally { clearTimeout(timer); }
  };
  try {
    // Padding hides even the size of the answer; if the browser refuses the extra header, ask plainly.
    return await pwnedCount(password, (prefix) => get(prefix, true).catch(() => get(prefix, false)));
  } catch { return 0; }
}

// ---------------- device-only accounts (no server) ----------------
const LOCAL_SHARE = b64u.enc(new Uint8Array(32));
export async function localSignup({ name, email, password }) {
  const kdf = await newKdf('account');
  const master = await deriveMaster(password, kdf);
  const dataKey = rand(32);
  const rk = newRecoveryKey();
  const rks = await recoveryKeysOf(rk.bytes, LOCAL_SHARE);
  const kp = await newKeyPair();
  return {
    local: true, isNew: true, master, kdf, dataKey, recoveryText: rk.text,
    recovery: { wrap: await seal(rks.enc, dataKey) },
    login: { user: { id: `local_${b64u.enc(rand(9))}`, name: name.trim(), email: email.trim().toLowerCase(), emailVerified: false }, keys: { keyVersion: 1, wrappedPrivateKey: await wrapPrivateKey(dataKey, kp.privateJwk) } },
  };
}
/** Device-only account: the recovery key opens the data key, then a new password wraps it. */
export async function localReset({ recoveryText, recovery, password }) {
  const bytes = parseRecoveryKey(recoveryText);
  if (!bytes) throw Object.assign(new Error('invalid_recovery'), { code: 'invalid_recovery' });
  const rk = await recoveryKeysOf(bytes, LOCAL_SHARE);
  let dataKey;
  try { dataKey = await open(rk.enc, recovery.wrap); } catch { throw Object.assign(new Error('invalid_recovery'), { code: 'invalid_recovery' }); }
  const kdf = await newKdf('account');
  return { dataKey, kdf, master: await deriveMaster(password, kdf) };
}
