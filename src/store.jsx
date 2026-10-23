import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { db, vault, sync, requestPersistence } from './db.js';
import { pendingRecurring } from './lib/finance.js';
import { setCustomCategories } from './lib/categories.js';
import {
  readLocal, writeLocal, mergeSnapshots, sameSnapshot, snapshotHash, sealSnapshot, openSnapshot, readScoped, writeScoped,
} from './lib/sync.js';
import {
  enableReminders, disableReminders, currentSubscription, buildReminders, sendSchedule, sendTest, localReminder, pushSupported,
} from './lib/push.js';
import { makeMoney, uid, round2 } from './lib/format.js';
import {
  DEFAULT_ACCOUNT_ID, defaultAccount, buildInstallments, invoiceForPayment, accountBalance, totals, agenda,
} from './lib/ledger.js';
import { currentMonth, monthKey, todayISO, addDays, toISO } from './lib/dates.js';
import { makeT } from './i18n.js';
import { registerBiometric, biometricSecret } from './lib/biometric.js';
import { encryptBackup, decryptBackup } from './lib/vault.js';
import {
  api, loadServerConfig, verifyLicense, computeEntitlement, takeCheckoutReturn, IS_ARTIFACT, sessionHooks,
} from './lib/billing.js';
import { openConnect, fetchItemData, deleteItem, mapItemData } from './lib/openfinance.js';
import { findSubscriptions } from './lib/subscriptions.js';
import { dailyForecast } from './lib/forecast.js';
import { computeAlerts, DEFAULT_CFG as ALERT_CFG } from './lib/alerts.js';
import { alertText } from './lib/alertText.js';
import { askAi as runAi, historyFor } from './lib/aiChat.js';
import { localAiSupport, modelFor, isDownloaded, prepareModel, removeModel, unloadModel } from './lib/localAi.js';
import { executeAction, undoAction } from './lib/aiActions.js';
import { authKeyOf, openSealedWithKey, keyFingerprint, b64u } from './lib/keys.js';
import {
  newSpaceId, newSpaceKey, wrapSpaceKey, unwrapSpaceKey, sealSpaceMeta, openSpaceMeta, spaceSyncKey, makeInvite, parseInvite,
  inviteProof, openInviteBox, makeTagger, scopeFilter, txSpace, localizeTx, detachTx, sanitizeSpaceSnap, SHARED_STORES,
} from './lib/spaces.js';
import {
  sessionInfo, logoutApi, reauth as reauthApi, changePassword as changePasswordApi, newRecoveryKeyFor, twoFactor, devicesApi, activityApi,
  updateProfile, deleteAccountApi, thisDevice, openLogin, localReset, changeEmailStart, changeEmailVerify, loginStart, loginEmail,
  setLeakCheckTestBase,
} from './lib/account.js';
import {
  capturesToTxs, rulesMap, linkBankRows, ruleKeys, merchantKey, parseCapture,
} from './lib/capture.js';

const Ctx = createContext(null);
export const useStore = () => useContext(Ctx);

const browserLang = () => ((navigator.language || 'pt').toLowerCase().startsWith('pt') ? 'pt' : 'en');
export const defaultSettings = () => {
  const lang = browserLang();
  return {
    name: '', lang, currency: lang === 'pt' ? 'BRL' : 'USD', onboarded: false, pinHash: null, dismissed: {},
    autoLockMin: 5, hideValues: false, textSize: 'normal', reminders: { enabled: false, hour: 9, detail: false },
    pwEveryDays: 30, recoverySaved: true, quickUnlockAsked: false, forecastDaily: true,
  };
};

/** Legacy (v2) PIN check, only used once to move the old data into the account. */
async function legacyHash(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bloomfi:${pin}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const EMPTY = { txs: [], budgets: [], goals: [], chat: [], assets: [], connections: [], accounts: [], cards: [], categories: [], rules: [] };
const LOAD_ORDER = ['transactions', 'budgets', 'goals', 'chat', 'assets', 'connections', 'accounts', 'cards', 'categories', 'rules'];
const clampDay = (d, fb) => Math.min(Math.max(Math.round(Number(d)) || fb, 1), 31);
/**
 * A bank whose numbers are made up: the "demonstration" bank of earlier versions, or Pluggy's test bank
 * once the server is the official one (PLUGGY_SANDBOX off). Only known once the server's settings arrived.
 */
const isExampleBank = (c, cfg) => !!c.demo || (!!c.sandbox && !!cfg && !cfg.openFinance?.sandbox);

/**
 * Records the app creates by itself (a recurring month, a bank movement) get the same id on every
 * device and updatedAt 0: if the user deleted one anywhere, the deletion wins over the copy
 * another device creates later.
 */
const autoRecord = (r) => ({ ...r, updatedAt: 0 });
const notDeleted = (tombs, store = 'transactions') => (r) => !tombs[`${store}:${r.id}`];
function hashId(text) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
/** Same imported movement -> same id on every device, so two devices importing it never duplicate it. */
export const importedId = (importId) => `imp_${hashId(String(importId))}`;
const MAX_TRIES = 5;
const DAY = 86400000;
const NO_SPACES = { list: [], waiting: [], max: 5, loaded: false };
/** An invite link (…/app/#join=…) works like a key: read it once, then take it out of the address bar. */
function takeInviteFromUrl() {
  try {
    const inv = parseInvite(window.location.hash);
    if (!inv) return null;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#space`);
    return inv;
  } catch { return null; }
}
const INITIAL_INVITE = typeof window !== 'undefined' ? takeInviteFromUrl() : null;
const serverMode = (cfg) => !IS_ARTIFACT && !!cfg;

/** Cards from Wally being confirmed or undone right now (never twice at the same time). */
const runningActions = new Set();

export function StoreProvider({ children }) {
  const [ready, setReady] = useState(false);
  // boot -> auth (no account on this device) | legacy (old PIN to unlock first) | locked | app
  const [phase, setPhase] = useState('boot');
  const [authCtx, setAuthCtx] = useState({ legacy: false, notice: null });
  const [settings, setSettings] = useState(defaultSettings);
  const [data, setDataRaw] = useState(EMPTY);
  // Async actions (and "Undo" buttons) always read and update the latest data, never a stale copy.
  const dataRef = useRef(EMPTY);
  dataRef.current = data;
  const setData = useCallback((v) => setDataRaw((d) => {
    const n = typeof v === 'function' ? v(d) : v;
    dataRef.current = n;
    return n;
  }), []);
  const [vaultInfo, setVaultInfo] = useState({ kind: 'none' });
  const [month, setMonth] = useState(currentMonth());
  const [toastMsg, setToastMsg] = useState(null);
  const [txModal, setTxModal] = useState(null);
  const [serverCfg, setServerCfg] = useState(null);
  const serverCfgRef = useRef(null);
  serverCfgRef.current = serverCfg;
  const [license, setLicense] = useState(null); // { token, checkedAt } — kept encrypted on the device
  const licenseRef = useRef(null);
  licenseRef.current = license;
  const [tick, setTick] = useState(0);
  const [guard, setGuard] = useState({ fails: 0, until: 0 });
  const [syncing, setSyncing] = useState(null);
  const [cloud, setCloud] = useState({ status: 'idle', lastSyncAt: null, error: null });
  // ok | signedOut | offline | unknown | local
  const [session, setSessionRaw] = useState({ status: 'unknown', user: null });
  const sessionRef = useRef(session);
  const setSession = useCallback((v) => setSessionRaw((s) => { const n = typeof v === 'function' ? v(s) : v; sessionRef.current = n; return n; }), []);
  const [captureState, setCaptureState] = useState({ log: [], lastPull: 0, busy: false });
  const [pendingRecovery, setPendingRecovery] = useState(null); // recovery key to show once after sign-up
  const [refreshing, setRefreshing] = useState(false);
  // Wally with AI, on this device: can it run here, is the model downloaded, is it loading (with progress).
  // status: 'checking' | 'none' (not downloaded) | 'downloading' | 'ready' (files here) | 'loaded' (in memory) | 'error'
  const [aiLocal, setAiLocal] = useState({ support: null, status: 'checking', progress: 0, error: null });
  const aiLocalRef = useRef(aiLocal);
  aiLocalRef.current = aiLocal;
  // What the AI tools read (balances, subscriptions, forecast, alerts…), always the latest.
  const derivedRef = useRef({});
  // Shared spaces: the list (names decrypted here), their keys (memory + the encrypted local copy), a pending invite.
  const [spaces, setSpaces] = useState(NO_SPACES);
  const spacesRef = useRef(spaces);
  spacesRef.current = spaces;
  const spaceKeys = useRef(new Map());
  const [invite, setInvite] = useState(INITIAL_INVITE);
  // The data key right after typing the password (sign-in, password unlock): lets the user turn on
  // the PIN or biometrics without typing it again. Forgotten after 10 minutes.
  const freshKey = useRef(null);
  const keepFresh = (dataKey) => { freshKey.current = { dataKey, at: Date.now() }; };
  const cloudBusy = useRef(null);
  const cloudTimer = useRef(null);
  const toastTimer = useRef();
  const lastActive = useRef(Date.now());
  const hiddenAt = useRef(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  /** action = { label, run } shows a button in the toast (e.g. "Desfazer"). */
  const toast = useCallback((text, kind = 'ok', action = null) => {
    clearTimeout(toastTimer.current);
    setToastMsg({ text, kind, id: Date.now(), action });
    toastTimer.current = setTimeout(() => setToastMsg(null), action ? 7000 : 3200);
  }, []);
  const dismissToast = useCallback(() => { clearTimeout(toastTimer.current); setToastMsg(null); }, []);

  const refreshVaultInfo = () => setVaultInfo(vault.info);
  const canServer = () => serverMode(serverCfgRef.current) && vault.kind === 'v2' && !vault.info.local && vault.unlocked && phaseRef.current === 'app';

  const loadData = useCallback(async () => {
    if (!vault.unlocked) return false;
    const [t, b, g, c, a, cn, ac, cd, cats, rules] = await Promise.all(LOAD_ORDER.map((s) => db.all(s)));
    let txs = t;
    let accounts = ac;
    if (!accounts.some((x) => x.id === DEFAULT_ACCOUNT_ID)) {
      // Every user has at least one account: the one all older transactions belong to.
      const st = (await db.getMeta('settings')) || {};
      const main = defaultAccount(makeT(st.lang || browserLang())('acc.defaultName'));
      await db.put('accounts', main);
      accounts = [main, ...accounts];
    }
    // v3 -> v4: bank movements imported before accounts existed belong to an unknown bank account,
    // so they must not change the main account balance.
    const legacy = txs.filter((x) => x.source === 'openfinance' && !x.accountId && !x.cardId);
    if (legacy.length) {
      const fixed = new Map(legacy.map((x) => [x.id, { ...x, accountId: 'of:legacy' }]));
      await db.putMany('transactions', [...fixed.values()]);
      txs = txs.map((x) => fixed.get(x.id) || x);
    }
    // Automatic recurring items whose first date has arrived are confirmed (e.g. the salary set up at onboarding).
    const today = todayISO();
    const due = txs.filter((x) => ((x.recurring && !x.recurringOf) || x.autoConfirm) && x.status === 'pending' && x.autoPay !== false && x.date <= today);
    if (due.length) {
      const done = new Map(due.map((x) => [x.id, { ...x, status: 'paid' }]));
      await db.putMany('transactions', [...done.values()]);
      txs = txs.map((x) => done.get(x.id) || x);
    }
    // A month the user deleted (on any device) is not created again.
    const tagNew = makeTagger({ accounts, cards: cd }, vault.info.userId);
    const gen = pendingRecurring(txs).filter(notDeleted(await db.getAllTombstones())).map(autoRecord).map(tagNew);
    if (gen.length) { await db.putMany('transactions', gen, { touch: false }); txs = [...txs, ...gen]; }
    setData({ txs, budgets: b, goals: g, chat: c.sort((x, y) => x.at - y.at), assets: a, connections: cn, accounts, cards: cd, categories: cats, rules });
    return true;
  }, []);

  const loadSettings = useCallback(async () => {
    const s = await db.getMeta('settings');
    const st = { ...defaultSettings(), ...(s || {}) };
    setSettings(st);
    settingsRef.current = st;
    return st;
  }, []);

  // ---------- boot ----------
  useEffect(() => {
    (async () => {
      const st = await loadSettings();
      await vault.load();
      refreshVaultInfo();
      setGuard((await db.getMeta('pinGuard')) || { fails: 0, until: 0 });
      if (vault.kind === 'v2') setPhase('locked');
      else if (vault.kind === 'v1' || st.pinHash) setPhase('legacy');
      else { setAuthCtx({ legacy: await db.hasLegacyData(), notice: null }); setPhase('auth'); }
      setReady(true);
      // Server config arrives later; the lock screen is usable meanwhile.
      const cfg = await loadServerConfig();
      setServerCfg(cfg);
      serverCfgRef.current = cfg;
      setLeakCheckTestBase(cfg?.hibpTest);
      // Even while locked: was this device signed out (and told to erase its data) from another device?
      if (vault.kind === 'v2' && !vault.info.local && serverMode(cfg)) checkSession();
      finishPendingLogout();
    })().catch((e) => { console.error(e); setReady('error'); });
    window.addEventListener('online', finishPendingLogout);
    return () => window.removeEventListener('online', finishPendingLogout);
  }, [loadSettings]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A sign-out made without internet: tell the server now (its cookie would still work until then). */
  async function finishPendingLogout() {
    try {
      if (!(await db.getMeta('pendingLogout')) || vault.kind === 'v2') return;
      await logoutApi();
      await db.delMeta('pendingLogout');
    } catch { /* still offline */ }
  }

  // other tabs/windows
  useEffect(() => sync.listen(async (kind) => {
    if (kind === 'logout') { window.location.reload(); return; }
    await loadSettings();
    await vault.load();
    refreshVaultInfo();
    if (kind === 'lock' && vault.kind === 'v2') { vault.lock(); setData(EMPTY); setPhase('locked'); return; }
    if (phaseRef.current !== 'app' || !vault.unlocked) return;
    setLicense((await db.getSecret('license')) || null);
    await loadData();
  }), [loadData, loadSettings]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { document.documentElement.lang = settings.lang === 'pt' ? 'pt-BR' : 'en'; }, [settings.lang]);
  // Wally with AI on this device: can this browser run it, and are the model's files already here?
  useEffect(() => {
    let dead = false;
    (async () => {
      const support = IS_ARTIFACT ? { ok: false, reason: 'artifact' } : await localAiSupport();
      if (dead) return;
      if (!support.ok) { setAiLocal((x) => ({ ...x, support, status: 'none' })); return; }
      const id = modelFor(settings.localAi?.model || support.recommended, support);
      const has = await isDownloaded(id);
      if (!dead) setAiLocal((x) => (x.status === 'downloading' || x.status === 'loaded' ? { ...x, support } : { ...x, support, status: has ? 'ready' : 'none', modelId: has ? id : null }));
    })();
    return () => { dead = true; };
  }, [settings.localAi?.model]); // eslint-disable-line react-hooks/exhaustive-deps
  // Bigger text for people who need it (everything scales together, layout included).
  useEffect(() => {
    const z = { normal: 1, large: 1.12, xlarge: 1.25 }[settings.textSize] || 1;
    document.body.style.zoom = z === 1 ? '' : String(z);
  }, [settings.textSize]);

  // After any change: tell other tabs, and send it to the user's other devices a few seconds later.
  const changed = () => { sync.notify(); scheduleCloud(); };
  function scheduleCloud(ms = 4000, opts) {
    clearTimeout(cloudTimer.current);
    cloudTimer.current = setTimeout(() => { runCloudRef.current?.(opts); spacesSyncRef.current?.(); }, ms);
  }
  const runCloudRef = useRef(null);
  const spacesSyncRef = useRef(null);

  // ---------- lock / auto-lock ----------
  const lock = useCallback((broadcast = true) => {
    if (vault.kind !== 'v2') return;
    vault.lock();
    freshKey.current = null; // the raw data key kept after typing the password goes too
    setData(EMPTY);
    setCaptureState({ log: [], lastPull: 0, busy: false });
    setTxModal(null);
    spaceKeys.current = new Map();
    setSpaces(NO_SPACES);
    setPhase('locked');
    if (broadcast) sync.notify('lock');
  }, [setData]);

  useEffect(() => {
    if (phase !== 'app') return undefined;
    const bump = () => { lastActive.current = Date.now(); };
    const limitMs = () => {
      const m = Number(settingsRef.current.autoLockMin);
      return m < 0 ? Infinity : m * 60000;
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now();
        // Privacy: blur what's on screen before the phone takes the app-switcher snapshot.
        document.documentElement.classList.add('privacy-blur');
        if (Number(settingsRef.current.autoLockMin) === 0) lock();
      } else {
        document.documentElement.classList.remove('privacy-blur');
        if (hiddenAt.current && Date.now() - hiddenAt.current > limitMs()) lock();
        hiddenAt.current = null;
        bump();
        loadData();
      }
    };
    const timer = setInterval(() => { if (Date.now() - lastActive.current > Math.max(limitMs(), 60000)) lock(); }, 15000);
    ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((ev) => window.addEventListener(ev, bump, { passive: true }));
    document.addEventListener('visibilitychange', onVis);
    bump();
    return () => {
      clearInterval(timer);
      ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((ev) => window.removeEventListener(ev, bump));
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [phase, lock, loadData]);

  // ---------- session (server account) ----------
  /** The server says this device is signed out. With wipe=true (asked from another device), erase it now. */
  const handleSignedOut = useCallback(async (err) => {
    if (vault.kind !== 'v2' || vault.info.local) return;
    if (err?.data?.wipe) {
      freshKey.current = null;
      await stopCloud();
      await disableReminders(null).catch(() => {}); // this browser stops getting notifications (the server already forgot it)
      await db.wipe();
      sync.notify('logout');
      setData(EMPTY);
      setLicense(null);
      setSession({ status: 'unknown', user: null });
      refreshVaultInfo();
      await loadSettings();
      setAuthCtx({ legacy: false, notice: 'wiped' });
      setPhase('auth');
      return;
    }
    // Signed out because the password changed: the old password must not open this device anymore.
    // The box opened by the old password is dropped too (a copy of the device can't use the old password).
    if (['password_changed', 'password_reset'].includes(err?.data?.reason) && !vault.info.pwStale) {
      await vault.patchMeta({ pwStale: true, pw: null });
      refreshVaultInfo();
    }
    setSession((s) => ({ ...s, status: 'signedOut', reason: err?.code || 'session_expired' }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { sessionHooks.onSignedOut = handleSignedOut; return () => { sessionHooks.onSignedOut = null; }; }, [handleSignedOut]);

  const lastSessionCheck = useRef(0);
  async function checkSession() {
    lastSessionCheck.current = Date.now();
    try {
      const r = await sessionInfo();
      setSession({ status: 'ok', user: r.user, ofSignal: r.ofSignal || 0 });
      const info = vault.info;
      if (info.kind === 'v2' && (r.user.email !== info.email || r.user.name !== info.name)) {
        await vault.patchMeta({ email: r.user.email, name: r.user.name });
        refreshVaultInfo();
      }
      // Keys replaced elsewhere (password reset without the recovery key): this device must sign in again.
      if (info.kind === 'v2' && r.keyVersion && r.keyVersion !== info.keyVersion) setSession((s) => ({ ...s, status: 'signedOut', reason: 'keys_changed' }));
      // Password changed on another device: this device's lock still uses the old one.
      if (info.kind === 'v2' && (r.user.pwv || 1) > (info.pwv || 1) && !info.pwStale) { await vault.patchMeta({ pwStale: true, pw: null }); refreshVaultInfo(); }
      return r;
    } catch (e) {
      if (e.status === 401) return null; // handled by sessionHooks
      setSession((s) => ({ ...s, status: s.status === 'ok' ? 'ok' : 'offline' }));
      return null;
    }
  }

  // ---------- subscription ----------
  const [licPayload, setLicPayload] = useState(null);
  // A saved license the server's key no longer signs (that key was replaced): a fresh one is fetched once,
  // and meanwhile the app counts as "checking" instead of showing the paywall.
  const [licUnverified, setLicUnverified] = useState(false);
  const relicensed = useRef('');
  useEffect(() => {
    let alive = true;
    (async () => {
      const canCheck = !!(license?.token && serverCfg?.licensePublicJwk);
      const p = canCheck ? await verifyLicense(license.token, serverCfg.licensePublicJwk) : null;
      if (!alive) return;
      setLicPayload(p);
      const retry = canCheck && !p && relicensed.current !== license.token;
      setLicUnverified(retry);
      if (retry && phase === 'app') {
        const r = await refreshLicense({ force: true });
        if (r) relicensed.current = license.token;
        if (alive) setLicUnverified(false);
      }
    })();
    return () => { alive = false; };
  }, [license, serverCfg, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const id = setInterval(() => setTick((n) => n + 1), 60000); return () => clearInterval(id); }, []);

  const entitlement = useMemo(
    () => computeEntitlement({ cfg: serverCfg, license: licPayload, pending: (!license && session.status !== 'ok') || licUnverified }),
    [serverCfg, licPayload, license, session.status, tick, licUnverified], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const saveLicense = useCallback(async (token) => {
    const rec = token ? { token, checkedAt: Date.now() } : null;
    if (rec) await db.putSecret('license', rec); else await db.delSecret('license');
    setLicense(rec);
  }, []);

  const refreshLicense = useCallback(async ({ force = false } = {}) => {
    if (!canServer() || !serverCfgRef.current?.billing?.enabled) return null;
    const lic = licenseRef.current;
    const age = Date.now() - (lic?.checkedAt || 0);
    if (!force && lic && age < 12 * 3600000) return null;
    try {
      const r = await api('license', { method: 'POST' });
      await saveLicense(r.license || null);
      return r;
    } catch {
      return null;
    }
  }, [saveLicense]); // eslint-disable-line react-hooks/exhaustive-deps

  // Coming back from Stripe Checkout
  useEffect(() => {
    if (phase !== 'app' || !serverCfg?.billing?.enabled) return;
    const ret = takeCheckoutReturn();
    if (!ret) return;
    const t = makeT(settingsRef.current.lang);
    if (ret.state === 'cancel') { toast(t('bill.canceled'), 'info'); return; }
    if (ret.state === 'success' && ret.sessionId) {
      (async () => {
        try {
          const r = await api('billing/claim', { method: 'POST', body: { sessionId: ret.sessionId } });
          await saveLicense(r.license);
          toast(t('bill.welcome'));
        } catch {
          toast(t('bill.claimErr'), 'err');
        }
      })();
    }
  }, [phase, serverCfg]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- sync between devices (automatic, end-to-end encrypted) ----------
  const cloudDirty = useRef(false);
  const cloudStop = useRef(false);
  async function runCloud({ first = false, manual = false } = {}) {
    if (cloudBusy.current) {
      // Something changed while a sync was running: sync again right after it.
      cloudDirty.current = true;
      return manual ? cloudBusy.current : null;
    }
    if (cloudStop.current || !canServer() || sessionRef.current.status === 'signedOut') return null;
    cloudDirty.current = false;
    const job = (async () => {
      const { syncKey: key } = vault.keys();
      if (!key) return null;
      const kv = vault.info.keyVersion || 1;
      const meta = (await db.getMeta('sync')) || {};
      const firstRun = first || !meta.version;
      setCloud((c) => ({ ...c, status: 'syncing', error: null }));
      try {
        // Nothing changed here nor in the cloud since the last sync: no need to download it all.
        if (!firstRun && meta.lastHash && meta.version) {
          const head = await api('sync?meta=1');
          if (head.version === meta.version && (await snapshotHash(await readLocal(db, settingsRef.current))) === meta.lastHash) {
            const at = Date.now();
            await db.setMeta('sync', { ...meta, lastSyncAt: at });
            setCloud({ status: 'ok', lastSyncAt: at, error: null });
            return { ok: true, changed: false };
          }
        }
        let changedHere = false;
        let version = meta.version || 0;
        let hash = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          const remote = await api('sync', { timeout: 60000 });
          if (cloudStop.current) return null;
          if (remote.keyVersion && remote.keyVersion !== kv) {
            // The cloud copy was sealed with other keys: this device must sign in again first.
            setSession((s) => ({ ...s, status: 'signedOut', reason: 'keys_changed' }));
            throw Object.assign(new Error('keys_changed'), { code: 'keys_changed' });
          }
          let remoteSnap = null;
          if (remote.data) {
            try { remoteSnap = await openSnapshot(remote.data, key); } catch {
              setSession((s) => ({ ...s, status: 'signedOut', reason: 'keys_changed' }));
              throw Object.assign(new Error('keys_changed'), { code: 'keys_changed' });
            }
          }
          const local = await readLocal(db, settingsRef.current);
          // A device joining the account: the cloud wins conflicts (e.g. over a fresh, empty default account).
          const merged = mergeSnapshots(local, remoteSnap, { preferRemote: firstRun && !!remoteSnap });
          if (await writeLocal(db, merged, local)) changedHere = true;
          // Name, language and currency follow the newest change (or the cloud, when joining it).
          const rs = merged.settings || {};
          const cur = settingsRef.current;
          if (rs.at && (rs.at !== (cur.settingsAt || 0) || ['name', 'lang', 'currency'].some((k) => rs[k] != null && rs[k] !== cur[k]))) {
            const next = { ...cur, name: rs.name ?? cur.name, lang: rs.lang || cur.lang, currency: rs.currency || cur.currency, settingsAt: rs.at };
            settingsRef.current = next;
            setSettings(next);
            await db.setMeta('settings', next);
          }
          version = remote.version || 0;
          if (!remoteSnap || !sameSnapshot(merged, remoteSnap)) {
            try {
              version = (await api('sync', { method: 'PUT', timeout: 60000, body: { baseVersion: remote.version || 0, keyVersion: kv, data: await sealSnapshot(merged, key, null) } })).version;
            } catch (e) {
              if (e.status === 409 && e.code === 'conflict') continue; // another device synced meanwhile: merge again
              if (e.code === 'key_changed') setSession((s) => ({ ...s, status: 'signedOut', reason: 'keys_changed' }));
              throw e;
            }
          }
          hash = await snapshotHash(merged);
          break;
        }
        const at = Date.now();
        if (cloudStop.current) return null;
        await db.setMeta('sync', { version, lastSyncAt: at, lastHash: hash });
        if (changedHere) { await loadData(); sync.notify(); }
        setCloud({ status: 'ok', lastSyncAt: at, error: null });
        return { ok: true, changed: changedHere };
      } catch (e) {
        setCloud((c) => ({ ...c, status: 'error', error: e.code || 'generic' }));
        if (manual) throw e;
        return null;
      }
    })();
    cloudBusy.current = job;
    try {
      return await job;
    } finally {
      cloudBusy.current = null;
      if (cloudDirty.current && !cloudStop.current) { cloudDirty.current = false; scheduleCloud(1500); }
    }
  }
  runCloudRef.current = (opts) => runCloud(opts).catch(() => {});
  /** Stops syncing on this device: waits for a sync in progress to finish first. */
  async function stopCloud() {
    cloudStop.current = true;
    clearTimeout(cloudTimer.current);
    try { await cloudBusy.current; } catch { /* already reported */ }
  }

  // ---------- phone captures (Apple Pay, Google Wallet, bank alerts) ----------
  const captureBusy = useRef(false);
  async function pullCaptures({ manual = false } = {}) {
    if (!canServer() || captureBusy.current || sessionRef.current.status === 'signedOut') return null;
    const { inboxKey } = vault.keys();
    if (!inboxKey) return null;
    captureBusy.current = true;
    setCaptureState((c) => ({ ...c, busy: true }));
    try {
      const { entries } = await api('wallet/inbox');
      if (!entries?.length) { setCaptureState((c) => ({ ...c, busy: false, lastPull: Date.now() })); return { added: 0 }; }
      const opened = [];
      for (const e of entries) {
        try { opened.push(await openSealedWithKey(inboxKey, e.box)); } catch { opened.push({ id: e.id, at: e.at, bad: true }); }
      }
      const D = dataRef.current;
      const tombs = await db.getAllTombstones();
      const deleted = new Set(Object.keys(tombs).filter((k) => k.startsWith('transactions:')).map((k) => k.slice(13)));
      const res = capturesToTxs(opened, { txs: D.txs, accounts: D.accounts, cards: D.cards, rules: rulesMap(D.rules), deleted });
      res.added = res.added.map(makeTagger(D, vault.info.userId));
      if (res.added.length) await db.putMany('transactions', res.added);
      const prevLog = (await db.getSecret('captureLog'))?.items || [];
      const items = [...res.log.reverse(), ...prevLog].slice(0, 80);
      await db.putSecret('captureLog', { items });
      await api('wallet/ack', { method: 'POST', body: { ids: entries.map((e) => e.id) } });
      if (res.added.length) setData((d) => ({ ...d, txs: d.txs.filter((t) => !res.added.some((a) => a.id === t.id)).concat(res.added) }));
      setCaptureState({ log: items, lastPull: Date.now(), busy: false, lastTest: res.tests ? Date.now() : captureState.lastTest });
      const t = makeT(settingsRef.current.lang);
      if (res.added.length) {
        toast(t('cap.addedToast', { n: res.added.length }));
        changed();
      } else if (res.tests && manual !== 'silent') toast(t('cap.testOk'));
      return { added: res.added.length, tests: res.tests };
    } catch (e) {
      setCaptureState((c) => ({ ...c, busy: false }));
      if (manual === true) throw e;
      return null;
    } finally {
      captureBusy.current = false;
    }
  }
  const pullRef = useRef(null);
  pullRef.current = pullCaptures;

  // ---------- staying up to date: open, come back, every 2 minutes, pull-to-refresh, push ----------
  const ofAutoRef = useRef(null);
  async function refreshAll({ manual = false } = {}) {
    if (phaseRef.current !== 'app') return;
    if (manual) setRefreshing(true);
    try {
      if (serverMode(serverCfgRef.current) && !vault.info.local) {
        if (manual || Date.now() - lastSessionCheck.current > 15 * 60000 || sessionRef.current.status !== 'ok') await checkSession();
        await Promise.all([runCloud({ manual: false }).catch(() => {}), pullRef.current?.({ manual: manual ? 'silent' : false }).catch(() => {}), refreshLicense()]);
        await spacesRefreshRef.current?.();
        await spacesSyncRef.current?.();
        await ofAutoRef.current?.({ manual });
      }
    } finally {
      if (manual) setRefreshing(false);
    }
  }
  const refreshRef = useRef(null);
  refreshRef.current = refreshAll;
  useEffect(() => {
    if (phase !== 'app') return undefined;
    refreshRef.current({});
    const id = setInterval(() => document.visibilityState === 'visible' && refreshRef.current({}), 2 * 60000);
    const onVis = () => { if (document.visibilityState === 'visible') setTimeout(() => refreshRef.current({}), 600); };
    document.addEventListener('visibilitychange', onVis);
    // A push about a capture or new bank data while the app is open: fetch it right away.
    const onSW = (e) => { if (e.data?.type === 'push') setTimeout(() => refreshRef.current({}), 300); };
    navigator.serviceWorker?.addEventListener?.('message', onSW);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); navigator.serviceWorker?.removeEventListener?.('message', onSW); };
  }, [phase]);

  // ---------- shared spaces (couple / family) ----------
  // A link opened while the app is already open.
  useEffect(() => {
    const on = () => { const inv = takeInviteFromUrl(); if (inv) setInvite(inv); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  async function saveSpacesCache(next, keys) {
    const ids = new Set([...next.list.map((x) => x.id), ...next.waiting.map((w) => w.id)]);
    await db.putSecret('spaces', {
      list: next.list, waiting: next.waiting, max: next.max,
      keys: Object.fromEntries([...keys].filter(([id]) => ids.has(id)).map(([id, k]) => [id, b64u.enc(k)])),
    });
  }
  /** What this device knew about the spaces (works offline). */
  async function loadSpacesCache() {
    const c = await db.getSecret('spaces').catch(() => null);
    spaceKeys.current = new Map(Object.entries(c?.keys || {}).map(([id, k]) => [id, b64u.dec(k)]));
    setSpaces(c ? { list: c.list || [], waiting: c.waiting || [], max: c.max || 5, loaded: true } : NO_SPACES);
  }
  /** The spaces from the server: keys opened with this account's own key, names decrypted here. */
  async function refreshSpaces() {
    if (!canServer() || sessionRef.current.status === 'signedOut') return null;
    const { spaceWrap } = vault.keys();
    if (!spaceWrap) return null;
    let r;
    try { r = await api('spaces'); } catch { return null; }
    const keys = new Map(spaceKeys.current);
    const list = [];
    for (const x of r.spaces || []) {
      let K = null;
      if (!x.keyStale) { try { K = await unwrapSpaceKey(spaceWrap, x.id, x.key); } catch { K = null; } }
      K ||= keys.get(x.id) || null;
      let meta = null;
      if (K) { try { meta = await openSpaceMeta(K, x.id, x.meta); keys.set(x.id, K); } catch { meta = null; } }
      list.push({
        id: x.id, role: x.role, members: x.members || [], requests: x.requests || [], invites: x.invites || [], createdAt: x.createdAt,
        name: meta?.name || '', emoji: meta?.emoji || '🏠', color: meta?.color || '#0bf28b', ok: !!meta, keyStale: !meta,
      });
    }
    const waiting = [];
    for (const w of r.waiting || []) {
      let meta = null;
      const K = keys.get(w.id);
      if (K) { try { meta = await openSpaceMeta(K, w.id, w.meta); } catch { /* not this key */ } }
      waiting.push({ id: w.id, at: w.at, ownerName: w.ownerName, name: meta?.name || '', emoji: meta?.emoji || '🏠' });
    }
    // Shared records of a space this account is no longer in (left, removed, space deleted) leave this device.
    const inNow = new Set(list.map((x) => x.id));
    const D0 = dataRef.current;
    const stray = new Set([...D0.accounts, ...D0.cards, ...D0.txs, ...D0.goals, ...D0.budgets, ...D0.categories].map((x) => x.space).filter((id) => id && !inNow.has(id)));
    for (const id of stray) await db.dropSpace(id, SHARED_STORES);
    const next = { list, waiting, max: r.max || 5, loaded: true };
    spaceKeys.current = keys;
    await saveSpacesCache(next, keys);
    setSpaces(next);
    if (stray.size) { await loadData(); sync.notify(); }
    return next;
  }
  const spacesRefreshRef = useRef(null);
  spacesRefreshRef.current = () => refreshSpaces().catch(() => null);

  /** One space's shared copy: download, merge with what this device has, upload (like the personal sync). */
  async function syncOneSpace(sp) {
    const K = spaceKeys.current.get(sp.id);
    if (!K || !sp.ok) return false;
    const key = await spaceSyncKey(K);
    const tag = `space:${sp.id}`;
    const mkey = `spaceSync:${sp.id}`;
    const meta = (await db.getMeta(mkey)) || {};
    const path = `spaces/data?id=${encodeURIComponent(sp.id)}`;
    if (meta.version && meta.lastHash) {
      const head = await api(`${path}&meta=1`);
      if (head.version === meta.version && (await snapshotHash(await readScoped(db, sp.id))) === meta.lastHash) return false;
    }
    let changedHere = false;
    let version = meta.version || 0;
    let hash = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await api(path, { timeout: 60000 });
      const remoteSnap = remote.data ? sanitizeSpaceSnap(await openSnapshot(remote.data, key, { tag }), sp.id) : null;
      const local = await readScoped(db, sp.id);
      const merged = mergeSnapshots(local, remoteSnap);
      if (await writeScoped(db, merged, local, sp.id)) changedHere = true;
      version = remote.version || 0;
      if (!remoteSnap || !sameSnapshot(merged, remoteSnap)) {
        try {
          version = (await api('spaces/data', { method: 'PUT', timeout: 60000, body: { id: sp.id, baseVersion: remote.version || 0, data: await sealSnapshot(merged, key, null, { tag }) } })).version;
        } catch (e) {
          if (e.status === 409 && e.code === 'conflict') continue;
          throw e;
        }
      }
      hash = await snapshotHash(merged);
      break;
    }
    await db.setMeta(mkey, { version, lastHash: hash, at: Date.now() });
    return changedHere;
  }
  const spaceBusy = useRef(false);
  const spaceDirty = useRef(false);
  async function syncSpaces() {
    if (spaceBusy.current) { spaceDirty.current = true; return; }
    if (!canServer() || sessionRef.current.status === 'signedOut' || !spacesRef.current.list.length) return;
    spaceBusy.current = true;
    let changedAny = false;
    try {
      for (const sp of spacesRef.current.list) {
        try { if (await syncOneSpace(sp)) changedAny = true; } catch { /* next time */ }
      }
    } finally { spaceBusy.current = false; }
    if (changedAny) { await loadData(); sync.notify(); }
    if (spaceDirty.current) { spaceDirty.current = false; setTimeout(() => spacesSyncRef.current?.(), 1500); }
  }
  spacesSyncRef.current = () => syncSpaces().catch(() => {});

  // ---------- account: finishing a sign-in / sign-up ----------
  const completeAuth = useCallback(async (res) => {
    const { login, dataKey, master, kdf, isNew, local } = res;
    const user = login.user;
    keepFresh(dataKey);
    // Version 4 leftovers (plain subscription token, trial date) are not needed anymore.
    const legacyAccount = await db.getMeta('account');
    const { sameKey } = await vault.setupAccount({
      userId: user.id, email: user.email, name: user.name, kdf, master, dataKey,
      keyVersion: login.keys?.keyVersion || 1, wpk: login.keys?.wrappedPrivateKey || null, local: !!local, recovery: local ? res.recovery : null,
      pwv: user.pwv || 1,
    });
    for (const k of ['account', 'license', 'trialStart', 'pendingLogout']) await db.delMeta(k);
    // Same account and key on this device: keep its sync history, so edits made here aren't lost to the cloud copy.
    if (!sameKey) await db.delMeta('sync');
    await db.delSecret('syncKey');
    cloudStop.current = false;
    if (login.license) await saveLicense(login.license); else setLicense((await db.getSecret('license')) || null);
    // An existing account signing in on a device with an old subscription: link it to the account.
    if (!isNew && !local && legacyAccount?.token) api('billing/redeem', { method: 'POST', body: { code: legacyAccount.token } }).then((r) => r.license && saveLicense(r.license)).catch(() => {});
    const cur = settingsRef.current;
    const next = {
      ...cur, name: cur.name || user.name,
      // A new device of an existing account gets its data from the cloud: no onboarding there.
      onboarded: cur.onboarded || !isNew,
      recoverySaved: res.recoveryText ? false : cur.recoverySaved !== false,
      quickUnlockAsked: false,
    };
    settingsRef.current = next;
    setSettings(next);
    await db.setMeta('settings', next);
    setSession({ status: local ? 'local' : 'ok', user });
    refreshVaultInfo();
    if (res.recoveryText) setPendingRecovery(res.recoveryText);
    await db.setMeta('pinGuard', { fails: 0, until: 0 });
    setGuard({ fails: 0, until: 0 });
    await loadData();
    await loadSpacesCache();
    lastActive.current = Date.now();
    setAuthCtx({ legacy: false, notice: null });
    setPhase('app');
    requestPersistence();
    if (!local && serverMode(serverCfgRef.current)) setTimeout(() => runCloudRef.current?.({ first: !sameKey }), 200);
    sync.notify();
  }, [loadData, saveLicense, setSession]);

  /** Signs out of the account: the data on this device is erased (it stays in the account, encrypted). */
  const logout = useCallback(async ({ force = false } = {}) => {
    if (!force && canServer() && sessionRef.current.status === 'ok') {
      try { await runCloud({ manual: true }); } catch (e) { if (!force) throw Object.assign(new Error('unsynced'), { code: 'unsynced' }); }
    }
    await stopCloud();
    try { await disableReminders(await db.getMeta('pushSub')); } catch { /* offline */ }
    let signedOut = true;
    if (!vault.info.local) {
      if (vault.meta?.pin?.v === 2) await api('account/pin/remove', { method: 'POST', body: { id: vault.meta.pin.id }, timeout: 5000 }).catch(() => {});
      try { await logoutApi(); } catch { signedOut = false; }
    }
    await db.wipe();
    freshKey.current = null;
    // Offline: the server still has the session. It is ended as soon as this browser is online again.
    if (!signedOut) await db.setMeta('pendingLogout', Date.now());
    sync.notify('logout');
    pushedSchedule.current = '';
    setData(EMPTY);
    setLicense(null);
    setSession({ status: 'unknown', user: null });
    setCloud({ status: 'idle', lastSyncAt: null, error: null });
    cloudStop.current = false;
    setMonth(currentMonth());
    refreshVaultInfo();
    await loadSettings();
    setAuthCtx({ legacy: false, notice: 'logged_out' });
    setPhase('auth');
  }, [loadSettings]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- data helpers ----------
  const setPart = (key, fn) => setData((d) => ({ ...d, [key]: typeof fn === 'function' ? fn(d[key]) : fn }));

  const actions = useMemo(() => { const tr = makeT(settingsRef.current.lang); const D = () => dataRef.current; const A = {
    /** The data as it is right now (for helpers like Wally's actions that run several steps). */
    data: () => D(),
    async updateSettings(patch) {
      const synced = ['name', 'lang', 'currency'].some((k) => k in patch && patch[k] !== settingsRef.current[k]);
      const next = { ...settingsRef.current, ...patch, ...(synced ? { settingsAt: Date.now() } : {}) };
      setSettings(next);
      await db.setMeta('settings', next);
      changed();
    },

    /**
     * Saves one transaction. A new card purchase with `installments` > 1 becomes N monthly parcels.
     * Types: expense | income | invest | redeem | transfer (transfer to a card = paying its invoice).
     */
    async saveTx(input) {
      const type = input.type;
      const onCard = !!input.cardId && (type === 'expense' || type === 'income');
      const date = input.date || todayISO();
      const toCard = type === 'transfer' && input.toCardId ? D().cards.find((c) => c.id === input.toCardId) : null;
      const base = {
        id: input.id || uid(),
        type,
        amount: round2(Math.abs(Number(input.amount))),
        category: type === 'transfer' ? 'transfer' : input.category,
        description: (input.description || '').trim(),
        date,
        accountId: onCard ? null : input.accountId || DEFAULT_ACCOUNT_ID,
        cardId: onCard ? input.cardId : null,
        toAccountId: type === 'transfer' && !input.toCardId ? input.toAccountId || null : null,
        toCardId: type === 'transfer' ? input.toCardId || null : null,
        invoice: toCard ? input.invoice || invoiceForPayment(toCard, date) : onCard && input.installment ? input.invoice || null : null,
        status: !onCard && input.status === 'pending' ? 'pending' : 'paid',
        autoPay: input.autoPay !== false,
        recurring: !!input.recurring && !input.installment,
        recurringOf: input.recurringOf || null,
        forMonth: input.forMonth || null,
        skipMonths: input.skipMonths || [],
        installment: input.installment || null,
        assetId: input.assetId || null,
        goalId: input.goalId || null,
        source: input.source || 'manual',
        importId: input.importId || null,
        connectionId: input.connectionId || null,
        createdAt: input.createdAt || Date.now(),
        loggedOn: input.loggedOn || todayISO(),
      };
      // A phone capture edited by hand: keep where it came from, it is now reviewed, and learn from the changes.
      const prev = input.id ? D().txs.find((t) => t.id === input.id) : null;
      const learned = [];
      if (prev?.capture) {
        base.capture = { ...prev.capture, review: false };
        const dest = base.cardId ? `card:${base.cardId}` : `acc:${base.accountId}`;
        const prevDest = prev.cardId ? `card:${prev.cardId}` : `acc:${prev.accountId}`;
        const key = ruleKeys({ card: { name: prev.capture.cardName, last4: prev.capture.last4 }, bank: prev.capture.bank, method: prev.capture.method })[0];
        if (key && dest !== prevDest && (type === 'expense' || type === 'income')) learned.push({ id: `map:${key}`, kind: 'map', key, dest, createdAt: Date.now() });
        const mk = merchantKey(base.description || prev.description);
        if (mk && base.category !== prev.category && (type === 'expense' || type === 'income')) learned.push({ id: `cat:${mk}`, kind: 'cat', key: mk, category: base.category, createdAt: Date.now() });
      }
      if (learned.length) {
        await db.putMany('rules', learned);
        setPart('rules', (l) => l.filter((r) => !learned.some((n) => n.id === r.id)).concat(learned));
      }
      // Shared account or card: the entry belongs to that space (and says who added it). Moved to a personal
      // account: it leaves the space (the other members see it go).
      const spaceOf = (id) => (id ? [...D().accounts, ...D().cards].find((x) => x.id === id)?.space || null : null);
      const sp = txSpace(base, spaceOf);
      if (sp) { base.space = sp; base.by = prev?.by || vault.info.userId || null; }
      else if (prev?.space && spacesRef.current.list.some((x) => x.id === prev.space)) {
        const known = [prev.accountId, prev.cardId, prev.toAccountId, prev.toCardId].filter(Boolean).every((id) => [...D().accounts, ...D().cards].some((x) => x.id === id) || id === DEFAULT_ACCOUNT_ID);
        if (known) await db.addSpaceTombs(prev.space, { [`transactions:${prev.id}`]: Date.now() - 1 });
        else { base.space = prev.space; base.by = prev.by || null; }
      }
      let rows = [base];
      if (!input.id && onCard && type === 'expense' && Number(input.installments) > 1) {
        rows = buildInstallments(base, Number(input.installments), D().cards.find((c) => c.id === input.cardId));
      }
      await db.putMany('transactions', rows);
      const ids = new Set(rows.map((r) => r.id));
      const gen = pendingRecurring(D().txs.filter((t) => !ids.has(t.id)).concat(rows)).filter(notDeleted(await db.getAllTombstones())).map(autoRecord)
        .map(makeTagger(D(), vault.info.userId));
      if (gen.length) await db.putMany('transactions', gen, { touch: false });
      setData((d) => ({ ...d, txs: d.txs.filter((t) => !ids.has(t.id)).concat(rows, gen) }));
      changed();
      return rows[0];
    },

    /** Deletes a transaction (or every parcel of an installment purchase). Returns what's needed to undo. */
    /** skip=false is used by "Undo" of a payment: the month goes back to being due instead of skipped. */
    async deleteTx(tx, { group = false, skip = true } = {}) {
      const removed = group && tx.installment?.group ? D().txs.filter((t) => t.installment?.group === tx.installment.group) : [tx];
      const ids = new Set(removed.map((r) => r.id));
      for (const r of removed) await db.remove('transactions', r.id);
      let prevTpl = null;
      let upd = null;
      if (tx.recurringOf && skip) {
        const tpl = D().txs.find((t) => t.id === tx.recurringOf);
        if (tpl) {
          prevTpl = tpl;
          upd = { ...tpl, skipMonths: [...new Set([...(tpl.skipMonths || []), tx.forMonth || monthKey(tx.date)])] };
          await db.put('transactions', upd);
        }
      }
      // A deleted bank transaction must not come back on the next sync.
      const gone = removed.map((r) => r.importId).filter(Boolean);
      if (gone.length) await db.addDeletedImports(gone);
      setData((d) => ({ ...d, txs: d.txs.filter((t) => !ids.has(t.id)).map((t) => (upd && t.id === upd.id ? upd : t)) }));
      changed();
      return { removed, prevTpl };
    },
    async restoreTxs({ removed, prevTpl }) {
      const rows = [...removed, ...(prevTpl ? [prevTpl] : [])];
      await db.putMany('transactions', rows);
      await db.dropTombstones('transactions', removed.map((r) => r.id));
      const back = removed.map((r) => r.importId).filter(Boolean);
      if (back.length) await db.dropDeletedImports(back);
      const ids = new Set(rows.map((r) => r.id));
      setPart('txs', (l) => l.filter((t) => !ids.has(t.id)).concat(rows));
      changed();
    },
    /** Deletes with an "Undo" button in the toast. */
    async deleteTxUndo(tx, opts) {
      const snap = await A.deleteTx(tx, opts);
      toast(snap.removed.length > 1 ? tr('tx.deletedN', { n: snap.removed.length }) : tr('tx.deleted'), 'ok', {
        label: tr('common.undo'), run: () => A.restoreTxs(snap),
      });
    },

    // ----- bills agenda -----
    async markPaid(tx) {
      const today = todayISO();
      const upd = {
        ...tx, status: 'paid', date: tx.date > today ? today : tx.date,
        forMonth: tx.recurringOf ? tx.forMonth || monthKey(tx.date) : tx.forMonth || null,
        // A recurring template paid early keeps its original day for the next months.
        anchorDate: tx.recurring && !tx.recurringOf ? tx.anchorDate || tx.date : tx.anchorDate,
      };
      await db.put('transactions', upd);
      setPart('txs', (l) => l.map((t) => (t.id === upd.id ? upd : t)));
      changed();
      return upd;
    },
    /** Pays (or receives) a future occurrence of a recurring transaction now. */
    async payRecurring(item) {
      const tpl = item.template;
      const today = todayISO();
      return A.saveTx({
        id: `rec_${tpl.id}_${item.mk}`, // same id the automatic generation would use: never two for one month
        type: tpl.type, amount: tpl.amount, category: tpl.category, description: tpl.description,
        accountId: tpl.accountId, cardId: tpl.cardId, toAccountId: tpl.toAccountId, toCardId: tpl.toCardId,
        assetId: tpl.assetId, goalId: tpl.goalId, date: item.date > today ? today : item.date,
        recurringOf: tpl.id, forMonth: item.mk, source: 'recurring', status: 'paid',
      });
    },
    /** "Undo" of payRecurring: the month goes back to being due (kept, not deleted, so no device loses it). */
    async unpayRecurring(tx, item) {
      const cur = D().txs.find((t) => t.id === tx.id) || tx;
      const auto = item.template?.autoPay !== false;
      const upd = { ...cur, status: 'pending', date: item.date, ...(auto ? { autoConfirm: true } : {}) };
      await db.put('transactions', upd);
      setPart('txs', (l) => l.map((t) => (t.id === upd.id ? upd : t)));
      changed();
    },
    async skipRecurring(item) {
      const tpl = D().txs.find((t) => t.id === item.template.id);
      if (!tpl) return;
      const upd = { ...tpl, skipMonths: [...new Set([...(tpl.skipMonths || []), item.mk])] };
      await db.put('transactions', upd);
      setPart('txs', (l) => l.map((t) => (t.id === upd.id ? upd : t)));
      changed();
    },
    async payInvoice({ card, mk, amount, accountId, date }) {
      return A.saveTx({
        type: 'transfer', amount, accountId: accountId || card.payFrom || DEFAULT_ACCOUNT_ID, toCardId: card.id, invoice: mk,
        description: tr('card.payDesc', { c: card.name }), date: date || todayISO(), status: 'paid',
      });
    },

    // ----- the user's own categories -----
    async saveCategory(c) {
      const prev = D().categories.find((x) => x.id === c.id);
      const id = c.id || uid();
      const item = {
        ...prev, ...c, id, key: prev?.key || `c_${id.replace(/-/g, '').slice(0, 10)}`,
        name: (c.name || '').trim().slice(0, 30), type: c.type === 'income' ? 'income' : 'expense',
        icon: c.icon || 'tag', color: c.color || '#94a3b8', createdAt: prev?.createdAt || Date.now(),
      };
      await db.put('categories', item);
      setPart('categories', (l) => l.filter((x) => x.id !== item.id).concat(item));
      changed();
      return item;
    },
    /** Removes a category; its transactions and budget move to "Outros". */
    async deleteCategory(cat) {
      const fallback = cat.type === 'income' ? 'other_income' : 'other';
      const moved = D().txs.filter((x) => x.category === cat.key).map((x) => ({ ...x, category: fallback }));
      if (moved.length) await db.putMany('transactions', moved);
      const budgets = D().budgets.filter((b) => b.category === cat.key);
      for (const b of budgets) await db.remove('budgets', b.id);
      await db.remove('categories', cat.id);
      const ids = new Map(moved.map((x) => [x.id, x]));
      setData((d) => ({
        ...d,
        categories: d.categories.filter((x) => x.id !== cat.id),
        budgets: d.budgets.filter((b) => b.category !== cat.key),
        txs: d.txs.map((x) => ids.get(x.id) || x),
      }));
      changed();
      return moved.length;
    },

    // ----- accounts & cards -----
    async saveAccountItem(a) {
      const prev = D().accounts.find((x) => x.id === a.id);
      const item = {
        type: 'checking', color: '#10b981', institution: '', initialBalance: 0, ...prev, ...a,
        id: a.id || uid(), name: (a.name || '').trim() || prev?.name || tr('acc.defaultName'),
        initialBalance: round2(Number(a.initialBalance ?? prev?.initialBalance ?? 0) || 0), createdAt: prev?.createdAt || Date.now(),
      };
      await db.put('accounts', item);
      setPart('accounts', (l) => l.filter((x) => x.id !== item.id).concat(item));
      changed();
      return item;
    },
    /** Makes the account show `target` today by moving its starting balance (reports are not affected). */
    async setAccountBalance(acc, target) {
      const current = accountBalance(acc, D().txs);
      return A.saveAccountItem({ ...acc, initialBalance: round2((Number(acc.initialBalance) || 0) + Number(target) - current) });
    },
    async deleteAccountItem(acc) {
      if (acc.id === DEFAULT_ACCOUNT_ID) return 'kept';
      const used = D().txs.some((t) => t.accountId === acc.id || t.toAccountId === acc.id);
      if (used) { await A.saveAccountItem({ ...acc, archived: true }); return 'archived'; }
      await db.remove('accounts', acc.id);
      setPart('accounts', (l) => l.filter((x) => x.id !== acc.id));
      changed();
      return 'deleted';
    },
    async saveCard(c) {
      const prev = D().cards.find((x) => x.id === c.id);
      const item = {
        brand: 'other', color: '#8b5cf6', ...prev, ...c,
        id: c.id || uid(), name: (c.name || '').trim() || prev?.name || tr('card.defaultName'),
        limit: round2(Number(c.limit ?? prev?.limit ?? 0) || 0),
        closingDay: clampDay(c.closingDay ?? prev?.closingDay, 1), dueDay: clampDay(c.dueDay ?? prev?.dueDay, 10),
        createdAt: prev?.createdAt || Date.now(),
      };
      await db.put('cards', item);
      setPart('cards', (l) => l.filter((x) => x.id !== item.id).concat(item));
      changed();
      return item;
    },
    async deleteCard(card) {
      const used = D().txs.some((t) => t.cardId === card.id || t.toCardId === card.id);
      if (used) { await A.saveCard({ ...card, archived: true }); return 'archived'; }
      await db.remove('cards', card.id);
      setPart('cards', (l) => l.filter((x) => x.id !== card.id));
      changed();
      return 'deleted';
    },

    /** Imported statement rows go to the chosen account, or onto a card (card bill). */
    async importTxs(items, { accountId = DEFAULT_ACCOUNT_ID, cardId = null } = {}) {
      const have = new Set(D().txs.map((t) => t.importId).filter(Boolean));
      const ids = new Set(D().txs.map((t) => t.id));
      const tombs = await db.getTombstones();
      const cardOf = (id) => D().cards.find((c) => c.id === id);
      const rows = items.filter((i) => i.type !== 'skip' && (!i.importId || !have.has(i.importId))).map((i) => {
        const pay = i.type === 'cardpay' && !cardId;
        const onCard = !!cardId && (i.type === 'expense' || i.type === 'income');
        return {
          id: i.importId ? importedId(i.importId) : uid(), type: pay ? 'transfer' : i.type, amount: Math.abs(i.amount), category: pay ? 'transfer' : i.category, description: i.description,
          date: i.date, recurring: false, recurringOf: null, assetId: i.assetId || null, source: i.source || 'import',
          accountId: onCard ? null : accountId, cardId: onCard ? cardId : null,
          toCardId: pay ? i.toCardId : null, invoice: pay && cardOf(i.toCardId) ? invoiceForPayment(cardOf(i.toCardId), i.date) : null,
          status: 'paid', importId: i.importId, connectionId: i.connectionId || null, createdAt: Date.now(), loggedOn: todayISO(),
        };
      }).filter((r) => !ids.has(r.id)).map(makeTagger(D(), vault.info.userId));
      // Rows picked by the user count as new; a row the user had deleted comes back only if picked again here.
      await db.putMany('transactions', rows);
      await db.dropTombstones('transactions', rows.map((r) => r.id).filter((id) => tombs[`transactions:${id}`]));
      setPart('txs', (l) => l.concat(rows));
      changed();
      return rows.length;
    },

    async saveBudget(b) {
      const prev = b.id ? D().budgets.find((x) => x.id === b.id) : null;
      const space = b.space !== undefined ? b.space || null : prev?.space || null;
      // One budget per category on each side (the person's own, and each space).
      const existing = D().budgets.find((x) => x.category === b.category && x.id !== b.id && (x.space || null) === space);
      const item = {
        id: b.id || existing?.id || uid(), category: b.category, limit: Number(b.limit),
        ...(space ? { space, sharedBy: prev?.sharedBy || vault.info.userId || null } : {}),
      };
      if (prev && (prev.space || null) !== space) { await A.shareRecord('budgets', prev, space); }
      await db.put('budgets', item);
      setPart('budgets', (l) => l.filter((x) => x.id !== item.id).concat(item));
      changed();
    },
    async deleteBudget(id) {
      await db.remove('budgets', id);
      setPart('budgets', (l) => l.filter((x) => x.id !== id));
      changed();
    },

    async saveGoal(g) {
      const prev = D().goals.find((x) => x.id === g.id);
      const space = g.space !== undefined ? g.space || null : prev?.space || null;
      if (prev && (prev.space || null) !== space) await A.shareRecord('goals', prev, space);
      const item = {
        id: g.id || uid(), title: g.title.trim(), emoji: g.emoji || '🎯', target: Number(g.target),
        current: Number(g.current || 0), deadline: g.deadline || null,
        history: g.history || prev?.history || [], createdAt: g.createdAt || Date.now(),
        ...(space ? { space, sharedBy: prev?.sharedBy || vault.info.userId || null } : {}),
      };
      await db.put('goals', item);
      setPart('goals', (l) => l.filter((x) => x.id !== item.id).concat(item));
      changed();
      return item;
    },
    /** amount > 0 = save, < 0 = withdraw. With record=true the money also leaves/returns to the account. */
    async addFunds(goal, amount, { record = true, txId } = {}) {
      const item = {
        ...goal,
        current: Math.max(0, Math.round((goal.current + amount) * 100) / 100),
        history: [...(goal.history || []), { date: todayISO(), amount, h: uid() }],
      };
      await db.put('goals', item);
      setPart('goals', (l) => l.map((x) => (x.id === item.id ? item : x)));
      if (record && amount !== 0) {
        const tx = {
          id: txId || uid(), type: amount > 0 ? 'invest' : 'redeem', amount: Math.abs(amount), category: amount > 0 ? 'goal_save' : 'redeem',
          description: goal.title, date: todayISO(), recurring: false, recurringOf: null, goalId: goal.id, accountId: DEFAULT_ACCOUNT_ID, status: 'paid',
          source: 'manual', createdAt: Date.now(), loggedOn: todayISO(),
        };
        await db.put('transactions', tx);
        setPart('txs', (l) => l.concat(tx));
      }
      changed();
      return item;
    },
    async deleteGoal(id) {
      await db.remove('goals', id);
      setPart('goals', (l) => l.filter((x) => x.id !== id));
      changed();
    },

    // ----- investments -----
    async saveAsset(a) {
      const prev = D().assets.find((x) => x.id === a.id);
      const item = {
        ...prev, ...a,
        id: a.id || uid(), name: (a.name || '').trim(), kind: a.kind || 'outros', institution: (a.institution || '').trim(),
        source: a.source || prev?.source || 'manual', valuations: a.valuations || prev?.valuations || [],
        initialInvested: Number(a.initialInvested ?? prev?.initialInvested ?? 0), createdAt: prev?.createdAt || Date.now(),
      };
      await db.put('assets', item);
      setPart('assets', (l) => l.filter((x) => x.id !== item.id).concat(item));
      changed();
      return item;
    },
    async addValuation(asset, value) {
      const v = { date: todayISO(), at: Date.now(), value: Math.max(0, Number(value)) };
      const item = { ...asset, valuations: [...(asset.valuations || []), v].slice(-120) };
      await db.put('assets', item);
      setPart('assets', (l) => l.map((x) => (x.id === item.id ? item : x)));
      changed();
    },
    async deleteAsset(asset) {
      await db.remove('assets', asset.id);
      // Keep the cash movements (they really happened), just unlink them.
      const linked = D().txs.filter((t) => t.assetId === asset.id).map((t) => ({ ...t, assetId: null }));
      if (linked.length) await db.putMany('transactions', linked);
      setData((d) => ({
        ...d,
        assets: d.assets.filter((x) => x.id !== asset.id),
        txs: d.txs.map((t) => (t.assetId === asset.id ? { ...t, assetId: null } : t)),
      }));
      changed();
    },

    async addChat(msgs) {
      const rows = msgs.map((m, i) => ({ id: uid(), at: Date.now() + i, ...m }));
      await db.putMany('chat', rows);
      setPart('chat', (l) => l.concat(rows));
      return rows;
    },
    async clearChat() { await db.clear('chat'); setPart('chat', []); },
    async updateChat(id, patch) {
      const cur = D().chat.find((m) => m.id === id);
      if (!cur) return null;
      const row = { ...cur, ...patch };
      await db.put('chat', row);
      setPart('chat', (l) => l.map((m) => (m.id === id ? row : m)));
      return row;
    },

    // ----- Wally adds things (a card in the chat; nothing is saved before the person confirms) -----
    /** What Wally's actions read: every account (the main one first), card, investment, goal, budget, category. */
    actionCtx() {
      const d = D();
      const st = settingsRef.current;
      const accounts = d.accounts.filter((a) => !a.archived);
      if (!accounts.some((a) => a.id === DEFAULT_ACCOUNT_ID)) accounts.unshift(defaultAccount(tr('acc.defaultName')));
      accounts.sort((a, b) => (b.id === DEFAULT_ACCOUNT_ID) - (a.id === DEFAULT_ACCOUNT_ID) || (a.createdAt || 0) - (b.createdAt || 0));
      return {
        accounts, cards: d.cards.filter((c) => !c.archived), assets: d.assets, goals: d.goals, budgets: d.budgets, categories: d.categories,
        t: derivedRef.current.t || tr, money: derivedRef.current.rawMoney || makeMoney(st.lang, st.currency), lang: st.lang, today: todayISO(),
      };
    },
    async confirmAction(msg) {
      const cur = D().chat.find((m) => m.id === msg.id) || msg;
      // once only, even with a double tap or "sim" said while the button is pressed (a failed one can be tried again)
      if (!cur.action || !['pending', 'failed'].includes(cur.state) || runningActions.has(cur.id)) return null;
      runningActions.add(cur.id);
      try {
        const result = await executeAction(cur.action, A);
        return await A.updateChat(cur.id, { state: 'done', result, doneAt: Date.now() });
      } catch (e) {
        await A.updateChat(cur.id, { state: 'failed' });
        throw e;
      } finally {
        runningActions.delete(cur.id);
      }
    },
    async cancelAction(msg) {
      const cur = D().chat.find((m) => m.id === msg.id) || msg;
      if (!['pending', 'failed'].includes(cur.state) || runningActions.has(cur.id)) return null;
      return A.updateChat(cur.id, { state: 'canceled' });
    },
    async undoChatAction(msg) {
      const cur = D().chat.find((m) => m.id === msg.id) || msg;
      if (cur.state !== 'done' || runningActions.has(cur.id)) return null;
      runningActions.add(cur.id);
      try {
        await undoAction(cur.action, cur.result, A);
        return await A.updateChat(cur.id, { state: 'undone' });
      } finally {
        runningActions.delete(cur.id);
      }
    },

    // ----- Wally with AI on this device (optional: the person downloads the model once) -----
    /** Downloads (first time) and loads the model; `key` = 'light' | 'full'. Turns the AI on when it's ready. */
    async aiDownload(key) {
      const support = aiLocalRef.current.support || await localAiSupport();
      if (!support?.ok) throw Object.assign(new Error('ai_unsupported'), { code: 'ai_unsupported' });
      const id = modelFor(key, support);
      setAiLocal((x) => ({ ...x, status: 'downloading', progress: 0, error: null, modelId: id }));
      try {
        await prepareModel(id, (p) => setAiLocal((x) => (x.modelId === id ? { ...x, progress: p.value, text: p.text } : x)));
        setAiLocal((x) => ({ ...x, status: 'loaded', progress: 1, modelId: id }));
        await A.updateSettings({ localAi: { on: true, model: key } });
      } catch (e) {
        setAiLocal((x) => ({ ...x, status: 'error', error: e.code || 'ai_failed' }));
        throw e;
      }
    },
    /** Off: the model leaves the memory; with `remove`, its files leave this device too. */
    async aiTurnOff({ remove = false } = {}) {
      const cur = settingsRef.current.localAi || {};
      await A.updateSettings({ localAi: { ...cur, on: false } });
      if (remove) {
        const support = aiLocalRef.current.support;
        for (const k of ['light', 'full']) await removeModel(modelFor(k, support)).catch(() => {});
        setAiLocal((x) => ({ ...x, status: 'none', progress: 0, modelId: null }));
      } else {
        unloadModel();
        setAiLocal((x) => (x.status === 'loaded' ? { ...x, status: 'ready' } : x));
      }
    },
    // ----- shared spaces (couple / family) -----
    refreshSpaces: () => refreshSpaces(),
    syncSpaces: () => syncSpaces(),
    async setScope(scope) { await A.updateSettings({ scope }); },
    async createSpace({ name, emoji = '🏠' }) {
      const { spaceWrap } = vault.keys();
      if (!spaceWrap) throw Object.assign(new Error('locked'), { code: 'locked' });
      const id = newSpaceId();
      const K = newSpaceKey();
      await api('spaces', { method: 'POST', token: licenseRef.current?.token, body: { id, meta: await sealSpaceMeta(K, id, { name, emoji }), key: await wrapSpaceKey(spaceWrap, id, K) } });
      spaceKeys.current.set(id, K);
      await refreshSpaces();
      return id;
    },
    async renameSpace(id, meta) {
      const K = spaceKeys.current.get(id);
      if (!K) throw Object.assign(new Error('no_key'), { code: 'no_key' });
      await api('spaces/update', { method: 'POST', body: { id, meta: await sealSpaceMeta(K, id, meta) } });
      await refreshSpaces();
    },
    /** A new single-use invite link (valid 7 days). Its secret part only exists in the link itself. */
    async inviteToSpace(id) {
      const K = spaceKeys.current.get(id);
      if (!K) throw Object.assign(new Error('no_key'), { code: 'no_key' });
      const { invite: inv, fragment } = await makeInvite(K, id);
      const r = await api('spaces/invite', { method: 'POST', token: licenseRef.current?.token, body: { id, invite: inv } });
      await refreshSpaces();
      return { link: `${window.location.origin}/app/#${fragment}`, exp: r.exp };
    },
    async cancelInvite(id, inviteId) { await api('spaces/invite/cancel', { method: 'POST', body: { id, inviteId } }); await refreshSpaces(); },
    acceptInviteText(text) { const inv = parseInvite(text); if (inv) setInvite(inv); return !!inv; },
    dismissInvite() { setInvite(null); },
    /** What an invite is about (space name, who invited), opened with the link's secret. */
    async peekInvite(inv) {
      const proof = await inviteProof(inv.secret);
      const r = await api('spaces/peek', { method: 'POST', body: { id: inv.spaceId, inviteId: inv.inviteId, mac: proof.mac } });
      const K = await openInviteBox(proof.wrap, inv.spaceId, inv.inviteId, r.box);
      const meta = await openSpaceMeta(K, inv.spaceId, r.meta);
      return { ...meta, ownerName: r.ownerName, members: r.members, already: !!r.already, exp: r.exp };
    },
    async joinSpace(inv) {
      const { spaceWrap } = vault.keys();
      if (!spaceWrap) throw Object.assign(new Error('locked'), { code: 'locked' });
      const proof = await inviteProof(inv.secret);
      const p = await api('spaces/peek', { method: 'POST', body: { id: inv.spaceId, inviteId: inv.inviteId, mac: proof.mac } });
      const K = await openInviteBox(proof.wrap, inv.spaceId, inv.inviteId, p.box);
      const r = await api('spaces/join', { method: 'POST', body: { id: inv.spaceId, inviteId: inv.inviteId, mac: proof.mac, key: await wrapSpaceKey(spaceWrap, inv.spaceId, K) } });
      spaceKeys.current.set(inv.spaceId, K);
      setInvite(null);
      await refreshSpaces();
      if (r.joined) syncSpaces();
      return r;
    },
    async cancelJoin(id) { await api('spaces/cancel', { method: 'POST', body: { id } }); await refreshSpaces(); },
    async approveMember(id, userId, ok) { await api('spaces/approve', { method: 'POST', body: { id, userId, ok } }); await refreshSpaces(); },
    async removeMember(id, userId) { await api('spaces/remove', { method: 'POST', body: { id, userId } }); await refreshSpaces(); },
    /** Leaving: the shared records leave this device (they stay with the others). */
    async leaveSpace(id) {
      await api('spaces/leave', { method: 'POST', body: { id } });
      await db.dropSpace(id, SHARED_STORES);
      if (settingsRef.current.scope === id) await A.updateSettings({ scope: 'all' });
      await refreshSpaces();
      await loadData();
      sync.notify();
    },
    /** Deleting (owner): everything shared comes back to the owner as their own; the others lose it. */
    async deleteSpace(id) {
      const d = D();
      const moved = {};
      for (const st of SHARED_STORES) {
        const key = st === 'transactions' ? 'txs' : st;
        const list = d[key].filter((x) => x.space === id).map(({ space, sharedBy, ...x }) => (st === 'transactions' ? detachTx(x, vault.info.userId) : x));
        if (list.length) moved[st] = list;
      }
      for (const [st, list] of Object.entries(moved)) await db.putMany(st, list);
      await runCloud({ manual: false }).catch(() => {});
      await api('spaces/delete', { method: 'POST', body: { id } });
      await db.dropSpace(id, SHARED_STORES);
      if (settingsRef.current.scope === id) await A.updateSettings({ scope: 'all' });
      await refreshSpaces();
      await loadData();
      changed();
    },
    /**
     * Shares an account, card, goal or budget with a space (spaceId), or takes it back (null). An account or card
     * brings its transactions along, and the person's own categories they use. Whoever takes something back keeps it
     * as their own; the other members stop seeing it.
     */
    async shareRecord(store, rec, spaceId) {
      const to = spaceId || null;
      const from = rec.space || null;
      if (to === from) return rec;
      if (store === 'accounts' && rec.id === DEFAULT_ACCOUNT_ID) throw Object.assign(new Error('main_account'), { code: 'main_account' });
      const me = vault.info.userId || null;
      const d = D();
      const untag = ({ space, sharedBy, ...x }) => x;
      // Taking back: another member's entries keep pointing to THEIR accounts (detachTx), never to mine.
      const tagged = (r, extra = {}) => (to ? { ...r, space: to, ...extra } : detachTx(untag(r), me));
      const moved = { [store]: [tagged(rec, { sharedBy: me })] };
      if (store === 'accounts' || store === 'cards') {
        moved.transactions = d.txs.filter((t) => [t.accountId, t.cardId, t.toAccountId, t.toCardId].includes(rec.id) && (t.space || null) === from)
          .map((t) => tagged(t, { by: t.by || me }));
      }
      if (to) {
        const used = new Set([...(moved.transactions || []), ...(store === 'budgets' ? [rec] : [])].map((x) => x.category));
        const cats = d.categories.filter((c) => used.has(c.key) && !c.space).map((c) => tagged(c, { sharedBy: me }));
        if (cats.length) moved.categories = cats;
      }
      // The scope they leave forgets them (dated just before the new copies, which win everywhere).
      const ts = Date.now() - 1;
      const gone = Object.fromEntries(Object.entries(moved).flatMap(([st, list]) => list.map((r) => [`${st}:${r.id}`, ts])));
      if (from) await db.addSpaceTombs(from, gone);
      else await db.setTombstones({ ...(await db.getTombstones()), ...gone });
      for (const [st, list] of Object.entries(moved)) await db.putMany(st, list);
      await loadData();
      changed();
      return moved[store][0];
    },
    /** The name of a member of one of the spaces (for "added by …"). */
    memberName(userId) {
      for (const sp of spacesRef.current.list) {
        const m = sp.members.find((x) => x.id === userId);
        if (m) return m.name;
      }
      return '';
    },

    /** One question to Wally with AI. The model, the tools and the data are all on this device. */
    async askAi(question, { onStep, onLoading } = {}) {
      const dv = derivedRef.current;
      const st = settingsRef.current;
      const ctx = {
        ...(dv.view || D()), ledger: dv.ledger, subs: dv.subs, forecast: dv.forecast, alerts: dv.alerts,
        today: todayISO(), t: dv.t, lang: st.lang, money: dv.rawMoney,
      };
      const modelId = modelFor(st.localAi?.model, aiLocalRef.current.support);
      if (aiLocalRef.current.status !== 'loaded') {
        // First question since the app opened: the model goes from the cache into memory (a few seconds).
        onLoading?.(true);
        setAiLocal((x) => ({ ...x, status: 'downloading', progress: 0, modelId }));
        try {
          await prepareModel(modelId, (p) => setAiLocal((x) => ({ ...x, progress: p.value, text: p.text })));
          setAiLocal((x) => ({ ...x, status: 'loaded', progress: 1, error: null }));
        } catch (e) {
          setAiLocal((x) => ({ ...x, status: 'error', error: e.code || 'ai_failed' }));
          throw e;
        } finally { onLoading?.(false); }
      }
      try {
        return await runAi(question, {
          history: historyFor(D().chat), ctx, actionCtx: A.actionCtx(), lang: st.lang, currency: st.currency, today: todayISO(), modelId, onStep,
        });
      } catch (e) {
        if (e.code === 'ai_device_lost' || e.code === 'ai_memory') setAiLocal((x) => ({ ...x, status: 'ready' }));
        throw e;
      }
    },

    // ----- subscriptions and Wally's alerts (kept with the synced, encrypted rules) -----
    async putRule(rec) {
      await db.put('rules', rec);
      setPart('rules', (l) => l.filter((r) => r.id !== rec.id).concat(rec));
      changed();
      return rec;
    },
    /** The person's choice about one subscription: status 'ignored' | 'cancelled' | 'confirmed' | 'active', remind before it renews. */
    async setSubPref(key, patch) {
      const id = `sub:${key}`;
      const prev = D().rules.find((r) => r.id === id) || { id, kind: 'sub', key };
      return A.putRule({ ...prev, ...patch, updatedAt: Date.now() });
    },
    async saveAlertRule(rule) {
      const prev = rule.id ? D().rules.find((r) => r.id === rule.id) : null;
      const what = ['category', 'merchant', 'any'].includes(rule.what) ? rule.what : 'any';
      return A.putRule({
        ...prev, kind: 'alert', on: rule.on !== false, what, period: rule.period === 'purchase' ? 'purchase' : 'month',
        category: what === 'category' ? rule.category || 'other' : null, text: what === 'merchant' ? String(rule.text || '').trim().slice(0, 40) : '',
        limit: round2(Math.max(Number(rule.limit) || 0, 0)), id: rule.id || `alert:${uid()}`, createdAt: prev?.createdAt || Date.now(), updatedAt: Date.now(),
      });
    },
    async deleteAlertRule(id) {
      await db.remove('rules', id);
      setPart('rules', (l) => l.filter((r) => r.id !== id));
      changed();
    },
    async setAlertCfg(patch) {
      const prev = D().rules.find((r) => r.id === 'alertcfg') || { id: 'alertcfg', kind: 'alertcfg', ...ALERT_CFG };
      return A.putRule({ ...prev, ...patch, off: { ...(prev.off || {}), ...(patch.off || {}) }, updatedAt: Date.now() });
    },
    /** Hides alerts on every device (old dismissals are forgotten after 120 days). */
    async dismissAlerts(keys) {
      const now = Date.now();
      const recs = keys.map((key) => ({ id: `seen:${key}`, kind: 'seen', key, at: now }));
      const old = D().rules.filter((r) => r.kind === 'seen' && now - (r.at || 0) > 120 * DAY).map((r) => r.id);
      if (recs.length) await db.putMany('rules', recs);
      for (const id of old) await db.remove('rules', id);
      setPart('rules', (l) => l.filter((r) => !old.includes(r.id) && !recs.some((n) => n.id === r.id)).concat(recs));
      changed();
    },

    /** First steps: only the person's own numbers (the account starts with what they have today, nothing made up). */
    async finishOnboarding({ name, lang, currency, income, incomeDay = 5, balance = null }) {
      const next = { ...settingsRef.current, name: name.trim(), lang, currency, onboarded: true, seenV4: true, settingsAt: Date.now() };
      await db.setMeta('settings', next);
      const T = makeT(lang);
      const day = String(Math.min(Math.max(Number(incomeDay) || 5, 1), 28)).padStart(2, '0');
      const first = `${currentMonth()}-${day}`;
      // `balance` is what the account has today; a salary already received this month is part of it.
      const received = income > 0 && first <= todayISO() ? income : 0;
      await db.put('accounts', { ...defaultAccount(T('acc.defaultName')), initialBalance: balance == null || Number.isNaN(Number(balance)) ? 0 : round2(Number(balance) - received) });
      if (income > 0) {
        await db.put('transactions', {
          id: uid(), type: 'income', amount: income, category: 'salary', accountId: DEFAULT_ACCOUNT_ID,
          description: T('onb.salaryDesc'), date: first, status: first > todayISO() ? 'pending' : 'paid', autoPay: true,
          recurring: true, recurringOf: null, skipMonths: [], source: 'manual', createdAt: Date.now(), loggedOn: todayISO(),
        });
      }
      requestPersistence();
      setSettings(next);
      await loadData();
      changed();
    },

    // ----- backup -----
    async exportBackup(password) {
      const plain = await db.exportAll();
      return password ? encryptBackup(plain, password) : plain;
    },
    async readBackup(obj, password) {
      if (obj?.encrypted) return decryptBackup(obj, password);
      return obj;
    },
    async restoreBackup(plain) { await db.importAll(plain); await loadSettings(); await loadData(); changed(); },
    /** Erases every financial record (here, in the cloud copy and on the other devices). The account stays. */
    async wipeAll() {
      for (const c of D().connections.filter((x) => !x.demo)) { try { await deleteItem({ license: license?.token, itemId: c.id }); } catch { /* already gone */ } }
      // What is shared in a space belongs to the space (the other members keep it): only the person's own records go.
      for (const s of ['assets', 'connections', 'rules', 'chat']) await db.removeAll(s);
      for (const s of SHARED_STORES) for (const r of await db.all(s)) if (!r.space) await db.remove(s, r.id);
      await db.delSecret('captureLog');
      await db.delMeta('deletedImports');
      const next = { ...settingsRef.current, onboarded: false, dismissed: {}, quickUnlockAsked: true };
      settingsRef.current = next;
      setSettings(next);
      await db.setMeta('settings', next);
      setMonth(currentMonth());
      await loadData();
      changed();
    },

    /**
     * Earlier versions could load example entries and connect a "demonstration" bank with made-up numbers
     * (and a test server could connect Pluggy's fictional test bank). The official version removes them by itself
     * (the person's own entries stay; anything that pointed to an example account or card moves to the main
     * account). Returns true when something was removed.
     */
    async cleanupExamples() {
      const d = D();
      const demo = d.connections.filter((c) => isExampleBank(c, serverCfgRef.current));
      const sample = d.txs.some((x) => x.source === 'sample') || ['budgets', 'goals', 'assets', 'accounts', 'cards'].some((k) => d[k].some((x) => x.sample));
      if (!demo.length && !sample) return false;
      for (const c of demo) await A.disconnectBank(c, { removeData: true });
      if (sample) await A.removeSample();
      // Nothing may point to an account or card that is gone.
      const [txs, accounts, cards] = await Promise.all([db.all('transactions'), db.all('accounts'), db.all('cards')]);
      const accIds = new Set(accounts.map((a) => a.id));
      const cardIds = new Set(cards.map((c) => c.id));
      const lostAcc = (id) => id && id !== DEFAULT_ACCOUNT_ID && !accIds.has(id);
      const fixed = [];
      for (const x of txs) {
        let y = x;
        if (lostAcc(y.accountId)) y = { ...y, accountId: DEFAULT_ACCOUNT_ID };
        if (lostAcc(y.toAccountId)) y = { ...y, toAccountId: DEFAULT_ACCOUNT_ID };
        if (y.cardId && !cardIds.has(y.cardId)) y = { ...y, cardId: null, accountId: y.accountId || DEFAULT_ACCOUNT_ID };
        if (y.toCardId && !cardIds.has(y.toCardId)) y = { ...y, toCardId: null };
        if (y !== x) fixed.push(y);
      }
      if (fixed.length) await db.putMany('transactions', fixed);
      await loadData();
      changed();
      return true;
    },

    async removeSample() {
      const sampleIds = new Set(D().txs.filter((x) => x.source === 'sample').map((x) => x.id));
      for (const t of D().txs.filter((x) => sampleIds.has(x.id) || sampleIds.has(x.recurringOf))) await db.remove('transactions', t.id);
      for (const b of D().budgets.filter((x) => x.sample)) await db.remove('budgets', b.id);
      for (const g of D().goals.filter((x) => x.sample)) await db.remove('goals', g.id);
      for (const a of D().assets.filter((x) => x.sample)) await db.remove('assets', a.id);
      // Sample accounts/cards the user already uses for real transactions are kept (no longer marked as sample).
      const left = D().txs.filter((x) => !sampleIds.has(x.id) && !sampleIds.has(x.recurringOf));
      const usedBy = (id) => left.some((t) => t.accountId === id || t.toAccountId === id || t.cardId === id || t.toCardId === id);
      for (const c of D().cards.filter((x) => x.sample)) {
        if (usedBy(c.id)) await db.put('cards', { ...c, sample: false }); else await db.remove('cards', c.id);
      }
      for (const a of D().accounts.filter((x) => x.sample)) {
        if (a.id === DEFAULT_ACCOUNT_ID) await db.put('accounts', { ...defaultAccount(tr('acc.defaultName')), createdAt: a.createdAt });
        else if (usedBy(a.id)) await db.put('accounts', { ...a, sample: false });
        else await db.remove('accounts', a.id);
      }
      await loadData();
      changed();
    },

    // ----- unlocking -----
    /**
     * PIN of the account vault, or of an older version (before the account existed).
     * Account PINs are checked by the server (10 tries in all, then the PIN is erased): it needs internet.
     */
    async unlock(pin) {
      const g = (await db.getMeta('pinGuard')) || { fails: 0, until: 0 };
      if (g.until > Date.now()) return { ok: false, waitMs: g.until - Date.now() };
      let ok = false;
      let serverLeft = null;
      if (vault.kind === 'v2' && vault.meta?.pin?.v === 2) {
        try {
          await vault.open(await A.dataKeyFromServerPin(pin));
          ok = true;
        } catch (e) {
          if (e.code === 'wrong_pin') serverLeft = e.data?.attemptsLeft ?? null;
          else if (e.code === 'pin_locked' || e.code === 'no_pin') { await vault.removePin(); refreshVaultInfo(); return { ok: false, pinOff: true, reason: e.code }; }
          else if (e.status === 401) return { ok: false, reason: 'signed_out' };
          else return { ok: false, reason: ['offline', 'pin_offline', 'no_server'].includes(e.code) ? 'pin_offline' : e.code || 'generic', retryAfter: e.data?.retryAfter };
        }
      } else if (vault.kind === 'v2') {
        try {
          const dk = await vault.unlockPin(pin);
          ok = true;
          // A PIN saved before the server checked PINs (server account): move it to the server check now.
          if (!vault.info.local && serverMode(serverCfgRef.current)) A.setPin(pin, { dataKey: dk }).catch(() => {});
        } catch { ok = false; }
      } else if (vault.kind === 'v1') {
        ok = await vault.legacyUnlock(pin);
      } else if (settingsRef.current.pinHash) {
        ok = (await legacyHash(pin)) === settingsRef.current.pinHash;
      }
      if (!ok) {
        const fails = g.fails + 1;
        const waitSec = fails >= MAX_TRIES ? Math.min(30 * 2 ** (fails - MAX_TRIES), 900) : 0;
        const ng = { fails, until: waitSec ? Date.now() + waitSec * 1000 : 0 };
        await db.setMeta('pinGuard', ng);
        setGuard(ng);
        let pinOff = false;
        if (vault.kind === 'v2' && serverLeft == null) { pinOff = (await vault.pinFailed()) >= 10; refreshVaultInfo(); }
        return { ok: false, waitMs: waitSec * 1000, left: Math.max(MAX_TRIES - fails, 0), pinOff, serverLeft };
      }
      await db.setMeta('pinGuard', { fails: 0, until: 0 });
      setGuard({ fails: 0, until: 0 });
      if (vault.kind !== 'v2') {
        // Old data unlocked: now create (or sign in to) the account to keep it.
        setAuthCtx({ legacy: true, notice: null });
        setPhase('auth');
        return { ok: true };
      }
      await vault.pinOk();
      await A.afterUnlock();
      return { ok: true };
    },
    /**
     * The account password unlocks offline; when online it also renews the session if needed.
     * If the password was changed on another device, the typed (new) password is checked with the
     * account instead, and this device's lock is updated to it. Returns { ok } or { need2fa, ticket, ctx }.
     */
    async unlockPassword(password) {
      let res;
      try { res = await vault.unlockPassword(password); } catch (e0) {
        if (e0?.code === 'weak_kdf' || e0?.code === 'kdf_failed') return { ok: false, reason: e0.code };
        const info = vault.info;
        if (info.local || !serverMode(serverCfgRef.current) || navigator.onLine === false) return { ok: false };
        try {
          // Same salt on the server = the password didn't change: it was simply wrong (no sign-in attempt).
          const { kdf } = await api('auth/prelogin', { method: 'POST', body: { email: info.email }, timeout: 8000 });
          if (!kdf?.salt || kdf.salt === info.kdf?.salt) return { ok: false };
          const r = await loginStart({ email: info.email, password });
          if (r.need2fa) return { ok: false, need2fa: true, ticket: r.ticket, ctx: r.ctx };
          if (r.needEmail) return { ok: false, needEmail: true, ticket: r.ticket, challengeId: r.challengeId, email: r.email, ctx: r.ctx };
          if (r.done) { await A.unlockViaAccount(r.done); return { ok: true }; }
        } catch (e) {
          if (e.code === 'keys_changed') return { ok: false, reason: 'keys_changed' };
          if (e.code === 'account_locked' || e.code === 'too_many_requests' || e.code === 'weak_kdf') return { ok: false, reason: e.code, retryAfter: e.data?.retryAfter };
        }
        return { ok: false };
      }
      keepFresh(res.dataKey);
      await db.setMeta('pinGuard', { fails: 0, until: 0 });
      setGuard({ fails: 0, until: 0 });
      await A.afterUnlock();
      if (!vault.info.local && serverMode(serverCfgRef.current)) A.silentRelogin(res.master);
      return { ok: true };
    },
    /** A locked device opened with the account (new password): same data key required, then the local lock follows the new password. */
    async unlockViaAccount(res) {
      const fp = await keyFingerprint(res.dataKey);
      if (vault.meta?.fp && fp !== vault.meta.fp) throw Object.assign(new Error('keys_changed'), { code: 'keys_changed' });
      await A.finishRelogin(res);
      await db.setMeta('pinGuard', { fails: 0, until: 0 });
      setGuard({ fails: 0, until: 0 });
      await A.afterUnlock();
    },
    async unlockBiometric() {
      const secret = await biometricSecret(vault.bioInfo);
      if (vault.kind === 'v1') {
        const ok = await vault.legacyUnlockBio(secret);
        if (ok) { setAuthCtx({ legacy: true, notice: null }); setPhase('auth'); }
        return ok;
      }
      try { await vault.unlockBio(secret); } catch { return false; }
      await db.setMeta('pinGuard', { fails: 0, until: 0 });
      await A.afterUnlock();
      return true;
    },
    async afterUnlock() {
      refreshVaultInfo();
      setLicense((await db.getSecret('license')) || null);
      const log = (await db.getSecret('captureLog'))?.items || [];
      setCaptureState((c) => ({ ...c, log }));
      await loadData();
      await loadSpacesCache();
      lastActive.current = Date.now();
      setSession((s) => (vault.info.local ? { status: 'local', user: { email: vault.info.email, name: vault.info.name } } : s));
      setPhase('app');
    },
    /** Signs this device in again with the password just typed (no 2FA prompt possible here). */
    async silentRelogin(master) {
      try {
        const st = sessionRef.current.status;
        if (st === 'ok') return;
        if (st !== 'signedOut') { const r = await checkSession(); if (r) return; if (sessionRef.current.status !== 'signedOut') return; }
        const info = vault.info;
        const r = await api('auth/login', { method: 'POST', body: { email: info.email, authKey: await authKeyOf(master), device: thisDevice() } });
        if (r.need2fa || r.setup) return; // the banner offers a full sign-in
        await A.finishRelogin({ login: r, master, kdf: info.kdf });
      } catch { /* offline or wrong: the banner stays */ }
    },
    /** A full sign-in on a device that already has the account (session expired, password or keys changed elsewhere). */
    async finishRelogin({ login, master, kdf, dataKey }) {
      const dk = dataKey || (await openLogin({ master, kdf }, login)).dataKey;
      keepFresh(dk);
      const { sameKey } = await vault.setupAccount({
        userId: login.user.id, email: login.user.email, name: login.user.name, kdf, master, dataKey: dk,
        keyVersion: login.keys?.keyVersion || 1, wpk: login.keys?.wrappedPrivateKey || null, pwv: login.user.pwv || 1,
      });
      refreshVaultInfo();
      if (login.license) await saveLicense(login.license);
      setSession({ status: 'ok', user: login.user });
      // Same key: this device keeps its sync history (edits made here while signed out still win when newer).
      // New keys: merge everything again with the cloud copy.
      if (!sameKey) await db.delMeta('sync');
      cloudStop.current = false;
      await loadData();
      setTimeout(() => runCloudRef.current?.({ first: !sameKey }), 100);
    },
    lock,
    logout,
    completeAuth,

    // ----- quick unlock (PIN / biometrics) -----
    /** { dataKey } if the password was typed in the last 10 minutes (no need to ask again), else null. */
    quickProof() {
      const f = freshKey.current;
      return f && Date.now() - f.at < 10 * 60000 ? { dataKey: f.dataKey } : null;
    },
    /** proof = { password } or { pin } (or a data key right after sign-in) to get the data key again. */
    async dataKeyFrom(proof) {
      if (proof?.dataKey) return proof.dataKey;
      if (proof?.password) return (await vault.dataKeyFromPassword(proof.password)).dataKey;
      if (proof?.pin) return vault.meta?.pin?.v === 2 ? A.dataKeyFromServerPin(proof.pin) : vault.dataKeyFromPin(proof.pin);
      throw Object.assign(new Error('proof_required'), { code: 'proof_required' });
    },
    /** Account PIN: the server gives its secret back only for the right PIN; with it, the box on this device opens. */
    async dataKeyFromServerPin(pin) {
      if (navigator.onLine === false) throw Object.assign(new Error('pin_offline'), { code: 'pin_offline' });
      const { id, proof, h, box } = await vault.pinProof(pin);
      const r = await api('account/pin/unlock', { method: 'POST', body: { id, proof }, timeout: 10000 });
      return vault.dataKeyFromPinSecret(h, r.pepper, box);
    },
    async setPin(pin, proof) {
      const dk = await A.dataKeyFrom(proof);
      if (vault.info.local) await vault.setPin(pin, dk);
      else await vault.setPinServer(pin, dk, (p, replace) => api('account/pin', { method: 'POST', body: { proof: p, ...(replace ? { replace } : {}) } }));
      refreshVaultInfo();
    },
    async removePin() {
      const id = vault.meta?.pin?.v === 2 ? vault.meta.pin.id : null;
      await vault.removePin();
      refreshVaultInfo();
      if (id) api('account/pin/remove', { method: 'POST', body: { id } }).catch(() => {});
    },
    async enableBiometric(proof) {
      const dk = await A.dataKeyFrom(proof);
      const reg = await registerBiometric(settingsRef.current.name || vault.info.email || 'BloomFi');
      await vault.enableBio(reg, dk);
      refreshVaultInfo();
    },
    async disableBiometric() { await vault.disableBio(); refreshVaultInfo(); },

    // ----- account & security (server) -----
    /** Password (+2FA) again. Returns { ticket, share, master } or { need2fa: true }. */
    async reauth(password, extra) { return reauthApi(password, vault.info.kdf, extra); },
    async changePassword({ ticket, share, currentPassword, newPassword, signOutOthers }) {
      const { dataKey } = await vault.dataKeyFromPassword(currentPassword);
      if (vault.info.local) {
        const { newKdf, deriveMaster } = await import('./lib/keys.js');
        const kdf = await newKdf('account');
        await vault.rewrapPassword({ master: await deriveMaster(newPassword, kdf), kdf, dataKey });
      } else {
        const r = await changePasswordApi({ ticket, share, dataKey, newPassword, signOutOthers });
        await vault.rewrapPassword({ master: r.master, kdf: r.kdf, dataKey, pwv: r.pwv });
        keepFresh(dataKey);
      }
      refreshVaultInfo();
    },
    async newRecoveryKey({ ticket, share, currentPassword }) {
      const { dataKey } = await vault.dataKeyFromPassword(currentPassword);
      const text = await newRecoveryKeyFor({ ticket, share, dataKey });
      await A.updateSettings({ recoverySaved: false });
      return text;
    },
    /** Device-only account: a new recovery key (the old one stops working). */
    async newLocalRecoveryKey(currentPassword) {
      const { dataKey } = await vault.dataKeyFromPassword(currentPassword);
      const { newRecoveryKey: nrk, recoveryKeysOf, seal, b64u } = await import('./lib/keys.js');
      const rk = nrk();
      const rks = await recoveryKeysOf(rk.bytes, b64u.enc(new Uint8Array(32)));
      await vault.setLocalRecovery({ wrap: await seal(rks.enc, dataKey) });
      refreshVaultInfo();
      await A.updateSettings({ recoverySaved: false });
      return rk.text;
    },
    async localResetPassword({ recoveryText, password }) {
      const r = await localReset({ recoveryText, recovery: vault.meta.recovery, password });
      await vault.rewrapPassword({ master: r.master, kdf: r.kdf, dataKey: r.dataKey });
      await vault.open(r.dataKey);
      await A.afterUnlock();
    },
    twoFactor,
    devices: devicesApi,
    activity: activityApi,
    async setName(name) {
      await A.updateSettings({ name });
      if (!vault.info.local && canServer()) await updateProfile({ name }).catch(() => {});
      await vault.patchMeta({ name });
      refreshVaultInfo();
    },
    async setPushPrefs(patch) { if (canServer()) await updateProfile(patch); },
    changeEmailStart,
    async changeEmailVerify(challengeId, code) {
      const r = await changeEmailVerify(challengeId, code);
      await vault.patchMeta({ email: r.email });
      refreshVaultInfo();
      setSession((s) => ({ ...s, user: { ...(s.user || {}), email: r.email } }));
      return r;
    },
    async deleteAccount(ticket) {
      await stopCloud();
      await deleteAccountApi(ticket);
      await logout({ force: true });
    },
    checkSession,
    refreshAll,
    ackRecovery() { setPendingRecovery(null); return A.updateSettings({ recoverySaved: true }); },

    // ----- subscription -----
    /**
     * plan: 'essencial', 'plus' or 'premium' (by how many banks connect). During the free trial the first charge is
     * when it ends, unless startNow (pay today, to connect banks right away). Changing plans later: the old
     * subscription ends with credit for the unused days.
     */
    async startCheckout(plan, { startNow = false } = {}) {
      const r = await api('billing/checkout', { method: 'POST', body: { plan, ...(startNow ? { startNow: true } : {}) } });
      window.location.href = r.url;
    },
    /** Subscribed during the free trial: pay the first month today so the banks connect now. */
    async startPlanNow() {
      const r = await api('billing/start-now', { method: 'POST' });
      if (r.license) await saveLicense(r.license);
      changed();
      return r;
    },
    async redeemAccessCode(code) {
      const r = await api('billing/redeem', { method: 'POST', body: { code: code.trim() } });
      if (!r.license) throw Object.assign(new Error('no_license'), { code: r.status || 'no_license' });
      await saveLicense(r.license);
      changed();
      return r;
    },
    async openPortal() {
      const r = await api('billing/portal', { method: 'POST' });
      window.location.href = r.url;
    },
    refreshLicense,

    // ----- sync -----
    cloudSyncNow: () => runCloud({ manual: true }),

    // ----- phone captures -----
    pullCaptures: (opts) => pullCaptures({ manual: true, ...opts }),
    async captureLinks() { return (await api('wallet/tokens')).links; },
    /** New personal link. A copy is kept with the (end-to-end encrypted) data so the user's devices can show it again. */
    async createCaptureLink(label, platform) {
      const r = await api('wallet/tokens', { method: 'POST', body: { label, platform } });
      const rec = { id: `link:${r.id}`, kind: 'link', linkId: r.id, url: r.url, label: r.label, platform: r.platform, createdAt: Date.now() };
      await db.put('rules', rec);
      setPart('rules', (l) => l.filter((x) => x.id !== rec.id).concat(rec));
      changed();
      return r;
    },
    async revokeCaptureLink(id) {
      await api(`wallet/tokens?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (D().rules.some((x) => x.id === `link:${id}`)) {
        await db.remove('rules', `link:${id}`);
        setPart('rules', (l) => l.filter((x) => x.id !== `link:${id}`));
        changed();
      }
    },
    /** Sends a test through the personal link (like the phone automation would) and fetches it back. */
    async sendCaptureTest(url) {
      if (!/^https?:\/\/[^/]+\/api\/wallet\/in\/bfw_[\w-]{43}$/.test(url || '')) throw Object.assign(new Error('bad_link'), { code: 'bad_link' });
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teste: '1', app: 'BloomFi' }), cache: 'no-store', credentials: 'omit' });
      if (!res.ok) throw Object.assign(new Error('test_failed'), { code: res.status === 404 ? 'link_revoked' : res.status === 429 ? 'too_many_requests' : 'test_failed' });
      await new Promise((r) => setTimeout(r, 300));
      return pullCaptures({ manual: true });
    },
    /** The user confirmed/changed where a captured transaction goes: save it and learn for next time. */
    async reviewCapture(tx, { dest, category, remember = true }) {
      const next = { ...tx, capture: { ...(tx.capture || {}), review: false } };
      if (dest) {
        if (dest.startsWith('card:')) { next.cardId = dest.slice(5); next.accountId = null; } else { next.accountId = dest.slice(4); next.cardId = null; }
      }
      if (category) next.category = category;
      await db.put('transactions', next);
      const rules = [];
      if (remember) {
        const p = { card: { name: tx.capture?.cardName, last4: tx.capture?.last4 }, bank: tx.capture?.bank, method: tx.capture?.method };
        const key = ruleKeys(p)[0];
        if (key && dest) rules.push({ id: `map:${key}`, kind: 'map', key, dest, createdAt: Date.now() });
        const mk = merchantKey(tx.description);
        if (mk && category) rules.push({ id: `cat:${mk}`, kind: 'cat', key: mk, category, createdAt: Date.now() });
        if (rules.length) await db.putMany('rules', rules);
      }
      setData((d) => ({
        ...d,
        txs: d.txs.map((t) => (t.id === next.id ? next : t)),
        rules: d.rules.filter((r) => !rules.some((n) => n.id === r.id)).concat(rules),
      }));
      changed();
      return next;
    },
    async deleteRule(id) {
      await db.remove('rules', id);
      setPart('rules', (l) => l.filter((r) => r.id !== id));
      changed();
    },
    parseCapturePreview: parseCapture,

    async remindersOn() {
      const sub = await enableReminders(serverCfg?.push?.enabled ? serverCfg.push.publicKey : null);
      if (sub) await db.setMeta('pushSub', sub); else await db.delMeta('pushSub');
      await A.updateSettings({ reminders: { ...settingsRef.current.reminders, enabled: true } });
      pushedSchedule.current = '';
      return { push: !!sub };
    },
    async remindersOff() {
      await disableReminders(await db.getMeta('pushSub'));
      await db.delMeta('pushSub');
      await A.updateSettings({ reminders: { ...settingsRef.current.reminders, enabled: false } });
    },
    async remindersSet(patch) {
      await A.updateSettings({ reminders: { ...settingsRef.current.reminders, ...patch } });
      pushedSchedule.current = '';
    },
    async remindersTest() {
      const sub = await db.getMeta('pushSub');
      const tr2 = makeT(settingsRef.current.lang);
      if (sub && serverCfg?.push?.enabled) return sendTest(sub.endpoint, settingsRef.current.lang);
      const reg = await navigator.serviceWorker?.ready;
      await reg?.showNotification(tr2('rem.testTitle'), { body: tr2('rem.testBody'), icon: '/pwa-192.png', tag: 'test' });
      return { ok: true, local: true };
    },

    // ----- Open Finance -----
    /** Only real banks, through Pluggy (Open Finance). Without the server keys the option isn't offered. */
    async connectBank() {
      if (!serverCfg?.openFinance?.enabled) throw Object.assign(new Error('of_unavailable'), { code: 'of_unavailable' });
      const item = await openConnect({ license: license?.token, sandbox: serverCfg.openFinance.sandbox, lang: settingsRef.current.lang });
      if (!item) return null;
      const conn = {
        id: item.id, name: item.connector?.name || 'Banco', color: item.connector?.primaryColor ? `#${String(item.connector.primaryColor).replace('#', '')}` : '#0bf28b',
        imageUrl: item.connector?.imageUrl || '', createdAt: Date.now(), lastSync: null, status: 'UPDATING',
        ...(item.connector?.isSandbox ? { sandbox: true } : {}),
      };
      await db.put('connections', conn);
      setPart('connections', (l) => l.filter((c) => c.id !== conn.id).concat(conn));
      changed();
      return conn;
    },

    async syncConnection(conn, { quiet = false } = {}) {
      if (!quiet) setSyncing(conn.id);
      try {
        // Re-read from 10 days before the last sync (never more than 90 days back), so a long gap loses nothing.
        const lastDay = conn.lastSync ? toISO(new Date(conn.lastSync)) : null;
        const from = lastDay ? [addDays(lastDay, -10), addDays(todayISO(), -90)].sort().pop() : addDays(todayISO(), -90);
        let raw;
        try {
          raw = await fetchItemData({ license: license?.token, itemId: conn.id, from });
        } catch (e) {
          // The official site doesn't accept Pluggy's test bank (made-up numbers): it is removed with its data.
          // Beyond what the plan covers (or before its first payment): the bank shows as paused, with the reason.
          // Gone at Pluggy (removed when the plan stopped covering it, or at the bank): shown as disconnected.
          const mark = e.code === 'sandbox_item' ? { sandbox: true } : e.code === 'bank_limit' ? { paused: e.data?.reason || 'plan' }
            : e.status === 404 ? { paused: 'removed' } : null;
          if (mark && !(mark.paused && conn.paused === mark.paused)) {
            const marked = { ...conn, ...mark };
            await db.put('connections', marked);
            setPart('connections', (l) => l.map((c) => (c.id === conn.id ? marked : c)));
          }
          throw e;
        }
        const mapped = mapItemData(raw, conn.id);
        const { txs, assets } = mapped;
        // Keep what the user customised (name, colour, hidden, card digits) when the bank sends fresh numbers.
        const merge = (list, prevList) => list.map((n) => {
          const p = prevList.find((x) => x.id === n.id);
          return p ? {
            ...n, name: p.name, color: p.color, archived: !!p.archived, createdAt: p.createdAt, last4: p.last4 || n.last4,
            ...(p.space ? { space: p.space, sharedBy: p.sharedBy || null } : {}),
          } : n;
        });
        const accounts = merge(mapped.accounts, D().accounts);
        const cards = merge(mapped.cards, D().cards);
        const have = new Set(D().txs.map((t) => t.importId).filter(Boolean));
        const deletedRows = await db.deletedImports();
        const fresh0 = [];
        for (const t of txs) if (!have.has(t.importId) && !(t.importId && await db.isDeletedImport(deletedRows, t.importId))) fresh0.push(t);
        const ids = new Set(D().txs.map((t) => t.id));
        const keep = notDeleted(await db.getAllTombstones());
        const candidates = fresh0.map((i) => autoRecord({
          ...i, id: importedId(i.importId), recurring: false, recurringOf: null, assetId: null, createdAt: Date.now(),
        })).filter((r) => !ids.has(r.id) && keep(r));
        // Purchases already captured from the phone are the same: link the bank row to them instead of adding it again.
        const { links, rest: fresh0b } = linkBankRows(candidates, D().txs);
        // (the bank's accounts as they will be saved: a shared one keeps its space)
        const tagBank = makeTagger({ accounts: [...D().accounts.filter((a) => !accounts.some((n) => n.id === a.id)), ...accounts], cards: [...D().cards.filter((c) => !cards.some((n) => n.id === c.id)), ...cards] }, vault.info.userId);
        const fresh = fresh0b.map(tagBank);
        const learned = [];
        const linked = links.map(({ captureId, row }) => {
          const cap = D().txs.find((t) => t.id === captureId);
          const dest = row.cardId ? `card:${row.cardId}` : `acc:${row.accountId}`;
          if (cap.capture?.review) {
            const key = ruleKeys({ card: { name: cap.capture.cardName, last4: cap.capture.last4 }, bank: cap.capture.bank, method: cap.capture.method })[0];
            if (key) learned.push({ id: `map:${key}`, kind: 'map', key, dest, createdAt: Date.now() });
          }
          return {
            ...cap, importId: row.importId, connectionId: row.connectionId, accountId: row.cardId ? null : row.accountId, cardId: row.cardId || null,
            invoice: cap.invoice || null, category: cap.category && cap.category !== 'other' ? cap.category : row.category,
            description: cap.description || row.description, capture: { ...(cap.capture || {}), review: false, linked: true },
          };
        }).map(tagBank);
        if (accounts.length) await db.putMany('accounts', accounts);
        if (cards.length) await db.putMany('cards', cards);
        if (fresh.length) await db.putMany('transactions', fresh, { touch: false });
        if (linked.length) await db.putMany('transactions', linked);
        if (learned.length) await db.putMany('rules', learned);
        if (assets.length) await db.putMany('assets', assets);
        const upd = { ...conn, lastSync: Date.now(), status: raw.item?.status || 'UPDATED', name: raw.item?.connector?.name || conn.name, paused: null, ...(raw.item?.connector?.sandbox ? { sandbox: true } : {}) };
        await db.put('connections', upd);
        const linkedIds = new Map(linked.map((x) => [x.id, x]));
        setData((d) => ({
          ...d,
          txs: d.txs.map((t) => linkedIds.get(t.id) || t).concat(fresh),
          rules: d.rules.filter((r) => !learned.some((n) => n.id === r.id)).concat(learned),
          assets: d.assets.filter((a) => !assets.some((n) => n.id === a.id)).concat(assets),
          accounts: d.accounts.filter((a) => !accounts.some((n) => n.id === a.id)).concat(accounts),
          cards: d.cards.filter((a) => !cards.some((n) => n.id === a.id)).concat(cards),
          connections: d.connections.map((c) => (c.id === upd.id ? upd : c)),
        }));
        changed();
        return { added: fresh.length, linked: linked.length, assets: assets.length, accounts: accounts.length + cards.length };
      } finally {
        if (!quiet) setSyncing(null);
      }
    },

    async disconnectBank(conn, { removeData = false } = {}) {
      if (!conn.demo) {
        try { await deleteItem({ license: license?.token, itemId: conn.id }); } catch (e) { if (e.status !== 404) throw e; }
      }
      await db.remove('connections', conn.id);
      const mine = (x) => x.connectionId === conn.id;
      for (const a of D().assets.filter(mine)) await db.remove('assets', a.id);
      // Bank accounts/cards stop updating: delete them, or keep them hidden so old transactions keep their names.
      const hide = (x) => ({ ...x, archived: true, source: 'manual', bankBalance: undefined, bankUsed: undefined, bankAvailable: undefined });
      if (removeData) {
        for (const t of D().txs.filter(mine)) await db.remove('transactions', t.id);
        for (const a of D().accounts.filter(mine)) await db.remove('accounts', a.id);
        for (const c of D().cards.filter(mine)) await db.remove('cards', c.id);
      } else {
        const ha = D().accounts.filter(mine).map(hide), hc = D().cards.filter(mine).map(hide);
        if (ha.length) await db.putMany('accounts', ha);
        if (hc.length) await db.putMany('cards', hc);
      }
      setData((d) => ({
        ...d,
        txs: removeData ? d.txs.filter((x) => !mine(x)) : d.txs,
        accounts: removeData ? d.accounts.filter((x) => !mine(x)) : d.accounts.map((x) => (mine(x) ? hide(x) : x)),
        cards: removeData ? d.cards.filter((x) => !mine(x)) : d.cards.map((x) => (mine(x) ? hide(x) : x)),
        assets: d.assets.filter((a) => !mine(a)),
        connections: d.connections.filter((c) => c.id !== conn.id),
      }));
      changed();
    },
  }; return A; }, [data, license, serverCfg, entitlement, lock, loadData, loadSettings, saveLicense, refreshLicense, settings.lang, completeAuth, logout]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open Finance: refresh the connections when the bank said there is news, or every 6 hours.
  ofAutoRef.current = async ({ manual = false } = {}) => {
    if (!canServer() || !serverCfgRef.current?.openFinance?.enabled) return;
    const conns = dataRef.current.connections.filter((c) => !c.demo && c.paused !== 'removed');
    for (const c of conns) {
      const stale = Date.now() - (c.lastSync || 0) > 6 * 3600000;
      const signal = (sessionRef.current.ofSignal || 0) * 1000 > (c.lastSync || 0);
      if (manual) api('of/refresh', { method: 'POST', body: { itemId: c.id } }).catch(() => {});
      if (manual || stale || signal) {
        try { await actions.syncConnection(c, { quiet: true }); } catch { /* next time */ }
      }
    }
  };

  // The user's own categories: registered for icons/colours and translated by their own name.
  const t = useMemo(() => {
    setCustomCategories(data.categories);
    const base = makeT(settings.lang);
    const names = new Map(data.categories.map((c) => [`cat.${c.key}`, c.name]));
    return (key, vars) => names.get(key) ?? base(key, vars);
  }, [settings.lang, data.categories]);
  const rawMoney = useMemo(() => makeMoney(settings.lang, settings.currency), [settings.lang, settings.currency]);
  const money = useMemo(() => {
    if (!settings.hideValues) return rawMoney;
    const symbol = rawMoney(0).replace(/[\d.,\s ]/g, '');
    return () => `${symbol} •••••`;
  }, [rawMoney, settings.hideValues]);

  // The view the person picked — everything, only their own, or one shared space — is what every page shows and counts.
  const scope = spaces.list.length && settings.scope && settings.scope !== 'all' && (settings.scope === 'me' || spaces.list.some((x) => x.id === settings.scope)) ? settings.scope : 'all';
  const me = vaultInfo.userId || null;
  // Shared entries written by others: their "main" account is not mine (see localizeTx).
  const localTxs = useMemo(() => (data.txs.some((x) => x.space) ? data.txs.map((x) => localizeTx(x, me)) : data.txs), [data.txs, me]);
  const view = useMemo(() => {
    const base = localTxs === data.txs ? data : { ...data, txs: localTxs };
    if (scope === 'all') return base;
    const f = scopeFilter(scope, base);
    return {
      ...base, txs: base.txs.filter(f.tx), accounts: base.accounts.filter(f.record), cards: base.cards.filter(f.record),
      budgets: base.budgets.filter(f.record), goals: base.goals.filter(f.record),
    };
  }, [data, localTxs, scope]);

  // Balances, invoices and the bills agenda, shared by every page.
  const today = todayISO();
  const sortedAccounts = useMemo(() => [...view.accounts].sort((a, b) => (b.id === DEFAULT_ACCOUNT_ID) - (a.id === DEFAULT_ACCOUNT_ID) || (a.createdAt || 0) - (b.createdAt || 0)), [view.accounts]);
  const sortedCards = useMemo(() => [...view.cards].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)), [view.cards]);
  const ledger = useMemo(() => {
    const tot = totals({ accounts: sortedAccounts, cards: sortedCards, txs: view.txs }, today);
    const ag = agenda({ txs: view.txs, cards: sortedCards }, today, 45);
    // Only what needs the user's action counts for the badge (automatic recurring items post themselves).
    const actionable = ag.filter((i) => i.type !== 'income' && i.type !== 'redeem' && !(i.kind === 'recurring' && i.template.autoPay !== false) && !i.tx?.autoConfirm);
    return {
      ...tot, agenda: ag, today,
      overdue: actionable.filter((i) => i.overdue).length,
      dueSoon: actionable.filter((i) => !i.overdue && i.date <= addDays(today, 3)).length,
    };
  }, [sortedAccounts, sortedCards, view.txs, today]);
  const activeAccounts = useMemo(() => sortedAccounts.filter((a) => !a.archived), [sortedAccounts]);
  const toReview = useMemo(() => data.txs.filter((x) => x.source === 'capture' && x.capture?.review).sort((a, b) => (b.capture?.at || 0) - (a.capture?.at || 0)), [data.txs]);

  // ---------- subscriptions, forecast and Wally's alerts (all computed here, on the device) ----------
  const prefs = useMemo(() => {
    const subPrefs = {}, alertRules = [], seen = new Set();
    let alertCfg = ALERT_CFG;
    for (const r of data.rules) {
      if (r.kind === 'sub') subPrefs[r.key] = r;
      else if (r.kind === 'alert') alertRules.push(r);
      else if (r.kind === 'alertcfg') alertCfg = { ...ALERT_CFG, ...r, off: { ...(r.off || {}) } };
      else if (r.kind === 'seen') seen.add(r.key);
    }
    alertRules.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return { subPrefs, alertRules, alertCfg, seen };
  }, [data.rules]);
  const subs = useMemo(() => findSubscriptions(view.txs, { today, prefs: prefs.subPrefs }), [view.txs, today, prefs.subPrefs]);
  const forecast = useMemo(
    () => dailyForecast({ accounts: sortedAccounts, cards: sortedCards, txs: view.txs }, { today, days: 30, withDaily: settings.forecastDaily !== false }),
    [sortedAccounts, sortedCards, view.txs, today, settings.forecastDaily],
  );
  const alerts = useMemo(() => computeAlerts({
    txs: view.txs, cards: sortedCards, budgets: view.budgets, ledger, subs, forecast,
    rules: prefs.alertRules, cfg: prefs.alertCfg, seen: prefs.seen, today,
  }), [view.txs, sortedCards, view.budgets, ledger, subs, forecast, prefs, today]);

  // New alerts are announced once on this device (a short notice; the list lives with Wally).
  const announcing = useRef(false);
  useEffect(() => {
    if (phase !== 'app' || !alerts.length || announcing.current) return;
    announcing.current = true;
    (async () => {
      try {
        const had = (await db.getMeta('alertsAnnounced')) || {};
        const fresh = alerts.filter((a) => !had[a.key]);
        if (!fresh.length) return;
        const now = Date.now();
        const next = Object.fromEntries(Object.entries(had).filter(([, at]) => now - at < 120 * DAY));
        for (const a of alerts) next[a.key] = next[a.key] || now;
        await db.setMeta('alertsAnnounced', next);
        const tt = makeT(settingsRef.current.lang);
        const first = alertText(tt, rawMoney, fresh[0], settingsRef.current.lang);
        toast(fresh.length > 1 ? tt('alert.toastN', { n: fresh.length, t: first.title }) : `🦉 ${first.title}`, fresh[0].level === 'bad' ? 'err' : 'info', {
          label: tt('alert.see'), run: () => { window.location.hash = 'ai'; },
        });
      } catch { /* next time */ } finally { announcing.current = false; }
    })();
  }, [phase, alerts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Official version: example entries and the demonstration bank of earlier versions go away by themselves,
  // so every number on screen is the person's own (also when they arrive later from an older device).
  const hasExamples = useMemo(
    () => data.connections.some((c) => isExampleBank(c, serverCfg)) || data.txs.some((x) => x.source === 'sample')
      || ['budgets', 'goals', 'assets', 'accounts', 'cards'].some((k) => data[k].some((x) => x.sample)),
    [data, serverCfg],
  );
  const cleaning = useRef(false);
  useEffect(() => {
    if (phase !== 'app' || !hasExamples || cleaning.current) return;
    cleaning.current = true;
    actions.cleanupExamples()
      .then((removed) => { if (removed) toast(makeT(settingsRef.current.lang)('set.sampleRemoved')); })
      .catch(() => { /* tried again the next time the data changes */ })
      .finally(() => { cleaning.current = false; });
  }, [phase, hasExamples]); // eslint-disable-line react-hooks/exhaustive-deps

  // App icon badge (installed app): bills that need attention + captures to review.
  useEffect(() => {
    if (phase !== 'app' || !('setAppBadge' in navigator)) return;
    const n = ledger.overdue + ledger.dueSoon + toReview.length;
    (n ? navigator.setAppBadge(n) : navigator.clearAppBadge?.())?.catch?.(() => {});
  }, [phase, ledger.overdue, ledger.dueSoon, toReview.length]);

  // ---------- bill reminders ----------
  const pushedSchedule = useRef('');
  const rem = settings.reminders || {};
  useEffect(() => {
    if (phase !== 'app' || !rem.enabled || !pushSupported()) return undefined;
    const tt = makeT(settings.lang);
    const label = (i) => (i.kind === 'invoice' ? tt('ag.invoiceOf', { c: i.description }) : i.description || tt(`cat.${i.category}`));
    const timer = setTimeout(async () => {
      // 1) once a day, when the app opens
      const last = await db.getMeta('lastLocalReminder');
      const shown = await localReminder({ agenda: ledger.agenda, t: tt, money: rawMoney, label, detail: rem.detail }, last);
      if (shown) await db.setMeta('lastLocalReminder', shown);
      // 2) schedule push notifications for the coming days
      if (!serverCfg?.push?.enabled || !canServer() || sessionRef.current.status === 'signedOut') return;
      // The browser may renew the subscription (or it may come from a backup): always use the current one.
      const saved = await db.getMeta('pushSub');
      const sub = await currentSubscription(serverCfg.push.publicKey);
      if (!sub) return;
      if (saved?.endpoint !== sub.endpoint) {
        if (saved?.endpoint) disableReminders({ endpoint: saved.endpoint }, { keepLocal: true });
        await db.setMeta('pushSub', sub);
        pushedSchedule.current = '';
      }
      const items = buildReminders(ledger.agenda, { hour: rem.hour ?? 9, detail: !!rem.detail, t: tt, money: rawMoney, label });
      const sig = JSON.stringify(items);
      if (sig === pushedSchedule.current) return;
      try { await sendSchedule(sub, items); pushedSchedule.current = sig; } catch { /* offline: try again later */ }
    }, 2500);
    return () => clearTimeout(timer);
  }, [phase, rem.enabled, rem.hour, rem.detail, ledger.agenda, serverCfg, settings.lang, session.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeCards = useMemo(() => sortedCards.filter((c) => !c.archived), [sortedCards]);
  derivedRef.current = { ledger, subs, forecast, alerts, t, rawMoney, view };
  const aiAvailable = !IS_ARTIFACT && !!aiLocal.support?.ok;

  const value = {
    ready, phase, authCtx, settings, locked: phase === 'locked' || phase === 'legacy', vaultInfo, guard, month, setMonth, t, money, rawMoney, lang: settings.lang,
    ...view, ledger, activeAccounts, activeCards, toReview,
    // everything on this device, whatever the view (forms that pick an account, the space screen…)
    all: data, spaces, scope, invite, hasSpaces: spaces.list.length > 0, myId: vaultInfo.userId || null,
    toast, dismissToast, toastMsg, txModal, openTx: (tx = {}) => setTxModal(tx), closeTx: () => setTxModal(null),
    serverCfg, entitlement, licensePayload: licPayload, syncing, session, captureState, pendingRecovery, refreshing,
    ofMode: serverCfg?.openFinance?.enabled ? 'live' : 'off',
    subs, forecast, alerts, alertRules: prefs.alertRules, alertCfg: prefs.alertCfg, subPrefs: prefs.subPrefs,
    aiAvailable, aiLocal, aiOn: aiAvailable && !!settings.localAi?.on && ['ready', 'loaded', 'error'].includes(aiLocal.status) && !!aiLocal.modelId,
    isArtifact: IS_ARTIFACT,
    serverMode: serverMode(serverCfg) && !vaultInfo.local,
    cloud,
    ...actions,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
