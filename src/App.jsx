import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import {
  House, ReceiptText, PieChart, Target, Bot, Menu, X, Plus, Landmark, BarChart3, Settings as Cog, Lock, RefreshCw, TrendingUp, Eye, EyeOff,
  WalletCards, CalendarDays, Search, KeyRound, WifiOff, Repeat, Users,
} from 'lucide-react';
import { Paywall } from './components/Subscription.jsx';
import { useStore } from './store.jsx';
import Wally from './components/Wally.jsx';
import TxForm from './components/TxForm.jsx';
import Onboarding from './components/Onboarding.jsx';
import LockScreen from './components/Lock.jsx';
import AuthGate, { RecoveryKeyScreen, ReloginModal } from './components/Auth.jsx';
import QuickUnlockSetup from './components/QuickUnlock.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import Dashboard from './pages/Dashboard.jsx';
import { useSWUpdate } from './lib/sw.js';
import { ScopeBar, JoinSheet } from './components/Spaces.jsx';
import { PageBoundary } from './components/ErrorBoundary.jsx';
import { haptic } from './lib/haptics.js';

// Pages other than Home load on demand: the app opens faster on phones.
const Spend = lazy(() => import('./pages/Spend.jsx'));
const Wallet = lazy(() => import('./pages/Wallet.jsx'));
const Agenda = lazy(() => import('./pages/Agenda.jsx'));
const Investments = lazy(() => import('./pages/Investments.jsx'));
const Budgets = lazy(() => import('./pages/Budgets.jsx'));
const Goals = lazy(() => import('./pages/Goals.jsx'));
const Advisor = lazy(() => import('./pages/Advisor.jsx'));
const Import = lazy(() => import('./pages/Import.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Subscriptions = lazy(() => import('./pages/Subscriptions.jsx'));
const Space = lazy(() => import('./pages/Space.jsx'));

const PAGES = {
  home: Dashboard, spend: Spend, wallet: Wallet, agenda: Agenda, invest: Investments, budget: Budgets, goals: Goals,
  ai: Advisor, import: Import, reports: Reports, settings: Settings, subs: Subscriptions, space: Space,
};
// Extra addresses (home-screen shortcuts, notifications): #new opens a new transaction, #capture the phone-capture setup.
const ALIASES = { capture: 'import', new: 'home', security: 'settings', alerts: 'ai', assinaturas: 'subs', familia: 'space', family: 'space' };
const NAV = [
  ['home', House, 'nav.home'], ['spend', ReceiptText, 'nav.spend'], ['subs', Repeat, 'nav.subs'], ['wallet', WalletCards, 'nav.wallet'], ['agenda', CalendarDays, 'nav.agenda'],
  ['invest', TrendingUp, 'nav.invest'], ['budget', PieChart, 'nav.budget'], ['goals', Target, 'nav.goals'], ['space', Users, 'nav.space'], ['ai', Bot, 'nav.ai'],
  ['reports', BarChart3, 'nav.reports'], ['import', Landmark, 'nav.import'], ['settings', Cog, 'nav.settings'],
];
const BOTTOM = ['home', 'spend', 'wallet', 'invest', 'ai'];

function useRoute() {
  const read = () => { const p = window.location.hash.replace(/^#\/?/, '').split('?')[0]; return PAGES[p] ? p : ALIASES[p] || 'home'; };
  const [page, setPage] = useState(read);
  useEffect(() => {
    const on = () => { setPage(read()); window.scrollTo({ top: 0 }); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((p) => { if (p !== read() || ALIASES[window.location.hash.slice(1)]) window.location.hash = p; else window.scrollTo({ top: 0, behavior: 'smooth' }); }, []);
  return [page, go];
}

function useOnline() {
  const [on, setOn] = useState(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  useEffect(() => {
    const a = () => setOn(true), b = () => setOn(false);
    window.addEventListener('online', a); window.addEventListener('offline', b);
    return () => { window.removeEventListener('online', a); window.removeEventListener('offline', b); };
  }, []);
  return on;
}

/** Pull down at the top of the page to sync everything (phones). */
function usePullToRefresh(onRefresh, enabled) {
  const ref = useRef(null);
  useEffect(() => {
    if (!enabled || !('ontouchstart' in window)) return undefined;
    let startY = null, dist = 0, pulling = false;
    const el = () => ref.current;
    const blocked = () => window.scrollY > 0 || document.body.classList.contains('no-scroll') || document.querySelector('.modal-wrap, .cmd');
    const onStart = (e) => { startY = e.touches.length === 1 && !blocked() ? e.touches[0].clientY : null; dist = 0; };
    const onMove = (e) => {
      if (startY == null) return;
      dist = e.touches[0].clientY - startY;
      if (dist > 12 && window.scrollY <= 0) {
        pulling = true;
        el()?.style.setProperty('--pull', String(Math.min(dist * 0.55, 90)));
        el()?.classList.toggle('ready', dist > 110);
      }
    };
    const onEnd = () => {
      if (pulling) {
        if (dist > 110) { haptic(); onRefresh(); }
        el()?.style.setProperty('--pull', '0');
        el()?.classList.remove('ready');
      }
      startY = null; pulling = false;
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
  }, [enabled, onRefresh]);
  return ref;
}

function Brand({ t }) {
  return <div className="brand"><Wally size={34} /><div><strong>BloomFi</strong><span>{t('brand.tag')}</span></div></div>;
}

function Toast() {
  const { toastMsg, dismissToast } = useStore();
  if (!toastMsg) return null;
  return (
    <div key={toastMsg.id} className={`toast ${toastMsg.kind}`} role="status" aria-live="polite">
      <span>{toastMsg.text}</span>
      {toastMsg.action && <button onClick={() => { dismissToast(); toastMsg.action.run(); }}>{toastMsg.action.label}</button>}
    </div>
  );
}

function Splash() { return <div className="splash"><Wally size={72} /></div>; }

/** "Nova versão disponível": shown on every screen, also before signing in or unlocking (security fixes arrive sooner). */
function UpdateBar({ sw, t }) {
  if (!sw.needRefresh) return null;
  return (
    <div className="update-bar"><RefreshCw size={16} /> {t('app.update')}
      <button onClick={sw.update}>{t('app.updateBtn')}</button>
    </div>
  );
}

export default function App() {
  const store = useStore();
  const {
    ready, phase, settings, t, txModal, openTx, lock, vaultInfo, entitlement, updateSettings, ledger, pendingRecovery, ackRecovery,
    session, serverMode, refreshAll, refreshing, toReview, alerts, spaces,
  } = store;
  const [page, go] = useRoute();
  const [menu, setMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const [relogin, setRelogin] = useState(false);
  const online = useOnline();
  const sw = useSWUpdate();
  const { closeTx } = store;
  const inApp = phase === 'app' && settings.onboarded && !pendingRecovery;
  const ptrRef = usePullToRefresh(useCallback(() => refreshAll({ manual: true }), [refreshAll]), inApp && serverMode);
  useEffect(() => { closeTx(); setMenu(false); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  // Home-screen shortcut "Novo gasto".
  useEffect(() => {
    if (!inApp) return;
    if (window.location.hash === '#new') { window.history.replaceState(null, '', '#home'); openTx({ type: 'expense' }); }
  }, [inApp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard: N = new transaction, Ctrl/Cmd+K or / = search
  useEffect(() => {
    const onKey = (e) => {
      if (phase !== 'app') return;
      const typing = /input|textarea|select/i.test(document.activeElement?.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.modal, .cmd')) return;
      if (e.key === '/') { e.preventDefault(); setPalette(true); }
      else if (e.key.toLowerCase() === 'n') { e.preventDefault(); openTx({}); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openTx, phase]);

  if (ready === 'error') return <div className="fatal"><Wally mood="worried" size={70} /><h1>{t('app.oops')}</h1><p>{t('app.dbError')}</p></div>;
  if (!ready || phase === 'boot') return <Splash />;
  if (phase === 'auth') return <><AuthGate /><Toast /><UpdateBar sw={sw} t={t} /></>;
  if (phase === 'legacy' || phase === 'locked') return <><LockScreen /><Toast /><UpdateBar sw={sw} t={t} /></>;
  if (pendingRecovery) return <><RecoveryKeyScreen text={pendingRecovery} onDone={ackRecovery} /><Toast /></>;
  if (!settings.onboarded) return <><Onboarding /><Toast /></>;
  if (!settings.quickUnlockAsked && !vaultInfo.hasPin && !vaultInfo.hasBio) return <><QuickUnlockSetup /><Toast /></>;
  if (!entitlement.canUse) return <><Paywall /><JoinSheet /><Toast /><UpdateBar sw={sw} t={t} /></>;
  const due = ledger.overdue + ledger.dueSoon;
  const spaceReqs = spaces.list.reduce((n, x) => n + (x.role === 'owner' ? x.requests.length : 0), 0);
  // Family & couple needs the account server (not in the single-file link version).
  const nav = serverMode ? NAV : NAV.filter(([k]) => k !== 'space');

  const Page = PAGES[page];
  const navBtn = ([key, Icon, label], onClick, short = false) => (
    <button key={key} className={page === key ? 'active' : ''} onClick={onClick || (() => go(key))} aria-current={page === key ? 'page' : undefined}>
      <Icon size={19} /><span>{t(short && key === 'wallet' ? 'nav.walletShort' : label)}</span>
      {key === 'agenda' && due > 0 && <em className={`count ${ledger.overdue ? 'late' : ''}`} aria-label={t('ag.countLabel', { n: due })}>{due}</em>}
      {key === 'import' && toReview.length > 0 && <em className="count">{toReview.length}</em>}
      {key === 'ai' && alerts.length > 0 && <em className={`count ${alerts.some((a) => a.level === 'bad') ? 'late' : ''}`} aria-label={t('alert.countLabel', { n: alerts.length })}>{alerts.length}</em>}
      {key === 'space' && spaceReqs > 0 && <em className="count">{spaceReqs}</em>}
    </button>
  );
  const eye = (
    <button className="icon-btn" onClick={() => updateSettings({ hideValues: !settings.hideValues })} aria-label={t('sec.hide')} title={t('sec.hide')}>
      {settings.hideValues ? <EyeOff size={18} /> : <Eye size={18} />}
    </button>
  );
  const signedOut = serverMode && session.status === 'signedOut';
  // Still signed in, but the password was changed on another device: confirm the new one to update this device's lock.
  const stale = serverMode && !signedOut && vaultInfo.pwStale;

  return (
    <div className="app">
      <a className="skip" href="#main">{t('app.skip')}</a>
      {/* Desktop / tablet sidebar */}
      <aside className="sidebar">
        <Brand t={t} />
        <button className="primary add-side" onClick={() => openTx({})}><Plus size={18} /> {t('tx.add')} <kbd>N</kbd></button>
        <button className="search-btn" onClick={() => setPalette(true)}><Search size={16} /> <span>{t('cmd.short')}</span> <kbd>{navigator.platform?.startsWith('Mac') ? '⌘K' : 'Ctrl K'}</kbd></button>
        <nav>{nav.map((n) => navBtn(n))}</nav>
        <div className="side-foot">
          <button onClick={() => updateSettings({ hideValues: !settings.hideValues })}>{settings.hideValues ? <EyeOff size={17} /> : <Eye size={17} />} {settings.hideValues ? t('sec.show') : t('sec.hide')}</button>
          <button onClick={() => lock()}><Lock size={17} /> {t('nav.lock')}</button>
          <p>{t(serverMode ? 'app.e2ee' : 'app.local')}</p>
        </div>
      </aside>

      {/* Mobile header */}
      <header className="topbar">
        <Brand t={t} />
        <div className="top-actions">
          <button className="icon-btn" onClick={() => setPalette(true)} aria-label={t('cmd.short')}><Search size={18} /></button>
          {eye}
          <button className="icon-btn" onClick={() => lock()} aria-label={t('nav.lock')}><Lock size={18} /></button>
          <button className={`icon-btn ${due > 0 || toReview.length || alerts.length || spaceReqs ? `menu-dot ${ledger.overdue || alerts.some((a) => a.level === 'bad') ? 'late' : ''}` : ''}`} onClick={() => setMenu(true)} aria-label="menu"><Menu size={20} /></button>
        </div>
      </header>

      <div ref={ptrRef} className={`ptr ${refreshing ? 'busy' : ''}`} aria-hidden={!refreshing}>
        <span className="ptr-ball"><RefreshCw size={18} className={refreshing ? 'spin' : ''} /></span>
      </div>

      {(signedOut || stale || !online) && (
        <div className={`session-bar ${signedOut || stale ? '' : 'off'}`} role="status">
          {signedOut ? <><KeyRound size={16} /><span>{t(session.reason === 'keys_changed' ? 'sess.keys' : 'sess.out')}</span><button onClick={() => setRelogin(true)}>{t('sess.signin')}</button></>
            : stale ? <><KeyRound size={16} /><span>{t('sess.pwStale')}</span><button onClick={() => setRelogin(true)}>{t('common.confirm')}</button></>
              : <><WifiOff size={15} /><span>{t('mob.offline')}</span></>}
        </div>
      )}

      <main id="main" className={`content page-${page}`} key={page}>
        {!['settings', 'import', 'space'].includes(page) && <ScopeBar />}
        <PageBoundary resetKey={page} t={t} go={go} hasSpaces={spaces.list.length > 0}>
          <Suspense fallback={<div className="page-loading"><span className="spinner" /></div>}>
            <Page go={go} page={page} />
          </Suspense>
        </PageBoundary>
      </main>

      {/* Mobile bottom navigation */}
      <nav className="bottom-nav">
        {NAV.filter(([k]) => BOTTOM.includes(k)).map((n) => navBtn(n, undefined, true))}
      </nav>
      {page !== 'ai' && page !== 'import' && page !== 'settings' && (
        <button className="fab" onClick={() => { haptic(); openTx({}); }} aria-label={t('tx.add')}><Plus size={26} /></button>
      )}

      {/* Mobile drawer */}
      <div className={`drawer-wrap ${menu ? 'show' : ''}`} aria-hidden={!menu}>
        <div className="shade" onClick={() => setMenu(false)} />
        <div className="drawer">
          <div className="drawer-brand"><Brand t={t} /><button onClick={() => setMenu(false)} aria-label={t('common.close')}><X size={18} /></button></div>
          {nav.map((n) => navBtn(n, () => { go(n[0]); setMenu(false); }))}
          <button className="signout" onClick={() => { setMenu(false); lock(); }}><Lock size={18} /> {t('nav.lock')}</button>
        </div>
      </div>

      {txModal && <TxForm key={txModal.id || `new-${txModal.type || ''}`} />}
      <JoinSheet />
      {palette && <CommandPalette nav={nav} go={go} onClose={() => setPalette(false)} />}
      {relogin && <ReloginModal onClose={() => setRelogin(false)} />}
      <Toast />
      <UpdateBar sw={sw} t={t} />
    </div>
  );
}
