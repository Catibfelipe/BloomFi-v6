import React, { useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck, KeyRound, Smartphone, Laptop, Monitor, LogOut, Mail, History, Fingerprint, Timer, EyeOff, LifeBuoy, ChevronRight,
  Check, Copy, Download, TriangleAlert, Trash2, RefreshCw, Cloud, CloudOff, BadgeCheck, Lock, Hash, CircleDot, Tablet, ScanFace,
} from 'lucide-react';
import qrcode from 'qrcode-generator';
import { useStore } from '../store.jsx';
import Modal, { Confirm } from './Modal.jsx';
import { PasswordField, PasswordMeter, TwoFactorForm, CodeInput, RecoveryKeyScreen, authError } from './Auth.jsx';
import { PinCreate, PasswordProof } from './QuickUnlock.jsx';
import { passwordIssues } from '../lib/keys.js';
import { pwnedTimes } from '../lib/account.js';
import { biometricAvailable } from '../lib/biometric.js';
import { download } from '../lib/pwa.js';
import { haptic } from '../lib/haptics.js';

const AUTO_LOCK = [0, 1, 5, 15, -1];
const PW_EVERY = [7, 14, 30, 90, 0];

/** "agora", "há 5 min", "há 3 dias" */
export function ago(t, ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return t('time.now');
  const m = Math.round(s / 60);
  if (m < 60) return t('time.min', { n: m });
  const h = Math.round(m / 60);
  if (h < 36) return t('time.hours', { n: h });
  return t('time.days', { n: Math.round(h / 24) });
}

// ---------------- QR code (drawn as SVG: no HTML injection) ----------------
export function QrCode({ text, size = 196, label }) {
  const qr = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { n, d };
  }, [text]);
  return (
    <svg className="qr" viewBox={`-3 -3 ${qr.n + 6} ${qr.n + 6}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect x="-3" y="-3" width={qr.n + 6} height={qr.n + 6} rx="2" fill="#fff" />
      <path d={qr.d} fill="#0b0e13" />
    </svg>
  );
}

// ---------------- password (+2FA) again ----------------
/**
 * Asks the password (and the 2FA code when it is on). onDone({ ticket, share, password }) may throw to stay open.
 * scope = the one change the ticket allows (password | recovery | 2fa | email | delete); it works once.
 */
export function ReauthModal({ title, text, onDone, onClose, danger = false, scope }) {
  const { t, reauth, vaultInfo } = useStore();
  const [pw, setPw] = useState('');
  const [step, setStep] = useState('pw');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fail = (e) => { setError(e.code === 'invalid_credentials' || e.code === 'wrong_key' ? t('lock.pwWrong') : authError(t, e)); setBusy(false); haptic('error'); };
  const go = async (extra) => {
    setBusy(true); setError('');
    try {
      const r = await reauth(pw, { ...(extra || {}), scope });
      if (r.need2fa) { setStep('2fa'); setBusy(false); return; }
      await onDone({ ticket: r.ticket, share: r.share, password: pw });
    } catch (e) { fail(e); }
  };
  return (
    <Modal title={title || t('reauth.title')} onClose={busy ? () => {} : onClose}>
      {step === 'pw' ? (
        <form className="form" onSubmit={(e) => { e.preventDefault(); if (pw) go(); }}>
          <p className="sub">{text || t('reauth.text')}</p>
          <input type="email" name="username" autoComplete="username" value={vaultInfo.email || ''} readOnly hidden />
          <PasswordField label={t('auth.password')} value={pw} onChange={(v) => { setPw(v); setError(''); }} autoFocus />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className={danger ? 'danger-btn full' : 'primary full'} disabled={busy || !pw}>{busy ? <><span className="spinner" /> {t('auth.checking')}</> : t('common.confirm')}</button>
        </form>
      ) : (
        <TwoFactorForm t={t} busy={busy} error={error} compact onSubmit={(a) => go(a.backup ? { backup: a.backup } : { code: a.code })} />
      )}
    </Modal>
  );
}

// ---------------- two-step verification ----------------
function BackupCodes({ codes, onDone }) {
  const { t, toast } = useStore();
  const [saved, setSaved] = useState(false);
  const text = codes.join('\n');
  return (
    <div className="form">
      <p className="sub">{t('tfa.codesText')}</p>
      <div className="codes-grid">{codes.map((c) => <code key={c}>{c}</code>)}</div>
      <div className="rk-actions">
        <button type="button" className="secondary" onClick={async () => { try { await navigator.clipboard.writeText(text); toast(t('set.copied')); } catch { toast(t('set.copyManual'), 'info'); } }}><Copy size={16} /> {t('set.copy')}</button>
        <button type="button" className="secondary" onClick={() => download('bloomfi-codigos-reserva.txt', `${t('tfa.fileHead')}\n\n${text}\n`, 'text/plain')}><Download size={16} /> {t('rk.download')}</button>
      </div>
      <label className="check-line"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /><span>{t('tfa.codesSaved')}</span></label>
      <button className="primary full" disabled={!saved} onClick={onDone}>{t('common.done')}</button>
    </div>
  );
}

export function TwoFactorModal({ onClose }) {
  const { t, session, twoFactor, toast, checkSession } = useStore();
  const on = !!session.user?.twoFactor;
  const [step, setStep] = useState(on ? 'menu' : 'reauth');
  const [setup, setSetup] = useState(null); // { secret, uri }
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [action, setAction] = useState(null); // disable | backup (when on)
  const finish = async () => { await checkSession(); onClose(); };

  if (step === 'reauth') {
    return (
      <ReauthModal scope="2fa" title={t('tfa.title')} text={action === 'disable' ? t('tfa.reauthOff') : t('tfa.reauthText')} onClose={onClose} danger={action === 'disable'}
        onDone={async ({ ticket }) => {
          if (action === 'disable') { await twoFactor.disable(ticket); toast(t('tfa.offToast')); await finish(); return; }
          if (action === 'backup') { const r = await twoFactor.backup(ticket); setCodes(r.backupCodes); setStep('codes'); return; }
          setSetup(await twoFactor.setup(ticket));
          setStep('scan');
        }} />
    );
  }
  return (
    <Modal title={t('tfa.title')} onClose={busy ? () => {} : step === 'codes' ? () => {} : onClose}>
      {step === 'menu' && (
        <div className="form">
          <p className="status-line ok"><BadgeCheck size={18} /> {t('tfa.isOn')}</p>
          <p className="sub">{t('tfa.onText')}</p>
          <button className="secondary full" onClick={() => { setAction('backup'); setStep('reauth'); }}><RefreshCw size={16} /> {t('tfa.newCodes')}</button>
          <button className="danger-btn full" onClick={() => { setAction('disable'); setStep('reauth'); }}>{t('tfa.turnOff')}</button>
        </div>
      )}
      {step === 'scan' && setup && (
        <form className="form" onSubmit={async (e) => {
          e.preventDefault();
          if (code.length !== 6) return;
          setBusy(true); setError('');
          try { const r = await twoFactor.enable(code); setCodes(r.backupCodes); setStep('codes'); haptic('success'); } catch (er) { setError(authError(t, er)); setBusy(false); setCode(''); }
          setBusy(false);
        }}>
          <ol className="mini-steps">
            <li>{t('tfa.step1')}</li>
            <li>{t('tfa.step2')}</li>
          </ol>
          <div className="qr-wrap"><QrCode text={setup.uri} label={t('tfa.qrLabel')} /></div>
          <a className="secondary full" href={setup.uri}><Smartphone size={16} /> {t('tfa.openApp')}</a>
          <details className="manual-key">
            <summary>{t('tfa.manual')}</summary>
            <code className="mono selectable">{setup.secret.match(/.{1,4}/g).join(' ')}</code>
          </details>
          <CodeInput value={code} onChange={(v) => { setCode(v); setError(''); }} label={t('tfa.step3')} autoFocus={false} />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary full" disabled={busy || code.length !== 6}>{busy ? <><span className="spinner" /> {t('auth.checking')}</> : t('tfa.activate')}</button>
        </form>
      )}
      {step === 'codes' && codes && (
        <>
          {!on && <p className="status-line ok"><BadgeCheck size={18} /> {t('tfa.onToast')}</p>}
          <BackupCodes codes={codes} onDone={finish} />
        </>
      )}
    </Modal>
  );
}

// ---------------- password ----------------
export function ChangePasswordModal({ onClose }) {
  const { t, changePassword, toast, vaultInfo, settings, lang, session } = useStore();
  const [auth, setAuth] = useState(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [others, setOthers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const local = vaultInfo.local;
  if (!auth && !local) return <ReauthModal scope="password" title={t('pwc.title')} text={t('pwc.reauth')} onClose={onClose} onDone={async (a) => setAuth(a)} />;
  if (!auth && local) return <PasswordProof onClose={onClose} text={t('pwc.reauth')} onProof={async ({ password }) => { const { vault } = await import('../db.js'); await vault.dataKeyFromPassword(password); setAuth({ password }); }} />;
  return (
    <Modal title={t('pwc.title')} onClose={busy ? () => {} : onClose}>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        const issues = passwordIssues(pw, { email: vaultInfo.email, name: settings.name });
        if (issues.length) return setError(t(`pw.issue.${issues[0]}`));
        if (pw === auth.password) return setError(t('pwc.same'));
        if (pw !== pw2) return setError(t('auth.err.mismatch'));
        setBusy(true); setError('');
        try {
          if (!local) {
            const n = await pwnedTimes(pw);
            if (n > 0) { setBusy(false); setError(t('pw.pwned', { n: n.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US') })); return; }
          }
          await changePassword({ ticket: auth.ticket, share: auth.share, currentPassword: auth.password, newPassword: pw, signOutOthers: others });
          haptic('success');
          toast(t('pwc.done'));
          onClose();
        } catch (er) { setError(authError(t, er)); setBusy(false); }
      }}>
        <input type="email" name="username" autoComplete="username" value={vaultInfo.email || session.user?.email || ''} readOnly hidden />
        <PasswordField label={t('auth.newPassword')} value={pw} onChange={(v) => { setPw(v); setError(''); }} autoComplete="new-password" name="new-password" autoFocus />
        <PasswordMeter password={pw} email={vaultInfo.email} name={settings.name} />
        <PasswordField label={t('auth.password2')} value={pw2} onChange={(v) => { setPw2(v); setError(''); }} autoComplete="new-password" name="new-password-2" />
        {!local && (
          <button type="button" className={`toggle ${others ? 'on' : ''}`} onClick={() => setOthers(!others)} aria-pressed={others}>
            <span>{t('pwc.others')}<small>{t('pwc.othersHint')}</small></span><i />
          </button>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary full" disabled={busy}>{busy ? <><span className="spinner" /> {t('auth.protecting')}</> : t('pwc.save')}</button>
      </form>
    </Modal>
  );
}

// ---------------- recovery key ----------------
export function RecoveryKeyModal({ onClose }) {
  const { t, newRecoveryKey, newLocalRecoveryKey, updateSettings, vaultInfo, toast } = useStore();
  const [text, setText] = useState(null);
  const [ask, setAsk] = useState(false);
  if (text) return <RecoveryKeyScreen modal text={text} onDone={async () => { await updateSettings({ recoverySaved: true }); toast(t('rkm.saved')); onClose(); }} />;
  if (ask) {
    return vaultInfo.local
      ? <PasswordProof onClose={onClose} text={t('rkm.reauth')} onProof={async ({ password }) => setText(await newLocalRecoveryKey(password))} />
      : <ReauthModal scope="recovery" title={t('rkm.title')} text={t('rkm.reauth')} onClose={onClose} onDone={async (a) => setText(await newRecoveryKey({ ticket: a.ticket, share: a.share, currentPassword: a.password }))} />;
  }
  return (
    <Modal title={t('rkm.title')} onClose={onClose}>
      <div className="form">
        <p className="sub">{t('rkm.text')}</p>
        <ul className="plain-list">
          <li><LifeBuoy size={16} /> {t('rkm.why1')}</li>
          <li><TriangleAlert size={16} /> {t('rkm.why2')}</li>
        </ul>
        <button className="primary full" onClick={() => setAsk(true)}><KeyRound size={17} /> {t('rkm.new')}</button>
      </div>
    </Modal>
  );
}

// ---------------- e-mail ----------------
export function ChangeEmailModal({ onClose }) {
  const { t, changeEmailStart, changeEmailVerify, toast, serverCfg } = useStore();
  const [auth, setAuth] = useState(null);
  const [email, setEmail] = useState('');
  const [ch, setCh] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!(serverCfg?.auth?.email ?? serverCfg?.auth?.emailVerification)) {
    return <Modal title={t('em.title')} onClose={onClose}><p className="confirm-text">{t('em.unavailable')}</p><button className="primary full" onClick={onClose}>{t('common.ok')}</button></Modal>;
  }
  if (!auth) return <ReauthModal scope="email" title={t('em.title')} text={t('em.reauth')} onClose={onClose} onDone={async (a) => setAuth(a)} />;
  return (
    <Modal title={t('em.title')} onClose={busy ? () => {} : onClose}>
      {!ch ? (
        <form className="form" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true); setError('');
          try { setCh(await changeEmailStart(auth.ticket, email.trim())); } catch (er) { setError(authError(t, er)); }
          setBusy(false);
        }}>
          <p className="sub">{t('em.text')}</p>
          <label>{t('em.new')}<input type="email" inputMode="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary full" disabled={busy || !email.includes('@')}><Mail size={17} /> {t('rst.send')}</button>
        </form>
      ) : (
        <form className="form" onSubmit={(e) => e.preventDefault()}>
          <p className="sub">{t('auth.verifyText', { e: ch.email })}</p>
          <CodeInput value={code} onChange={setCode} label={t('auth.code')} onComplete={async (v) => {
            setBusy(true); setError('');
            try { await changeEmailVerify(ch.challengeId, v); toast(t('em.done')); onClose(); } catch (er) { setError(authError(t, er)); setCode(''); setBusy(false); }
          }} />
          {error && <p className="form-error" role="alert">{error}</p>}
          {busy && <p className="hint center"><span className="spinner" /> {t('auth.checking')}</p>}
        </form>
      )}
    </Modal>
  );
}

// ---------------- devices ----------------
const DEV_ICON = { ios: Smartphone, android: Smartphone, mac: Laptop, windows: Monitor, linux: Monitor, other: Tablet };

export function DevicesModal({ onClose }) {
  const { t, devices, toast } = useStore();
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [ask, setAsk] = useState(null); // { dev, wipe } | 'others'
  const load = () => devices.list().then((r) => setList(r.devices)).catch((e) => setError(authError(t, e)));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const others = (list || []).filter((d) => !d.current);
  return (
    <Modal title={t('dev.title')} onClose={onClose}>
      <p className="sub">{t('dev.text')}</p>
      {error && <p className="form-error">{error}</p>}
      {!list && !error && <p className="hint center"><span className="spinner" /></p>}
      <div className="dev-list">
        {(list || []).map((d) => {
          const Icon = DEV_ICON[d.platform] || Smartphone;
          return (
            <div className={`dev ${d.current ? 'current' : ''}`} key={d.id}>
              <div className="dev-ico"><Icon size={20} /></div>
              <div className="dev-main">
                <b>{d.name}{d.current && <em className="pill-on">{t('dev.this')}</em>}</b>
                <span>{d.current ? t('dev.activeNow') : t('dev.lastSeen', { w: ago(t, d.lastSeen * 1000) })}{d.geo ? ` · ${d.geo}` : ''}</span>
                <span className="faint">{t('dev.since', { d: new Date(d.createdAt * 1000).toLocaleDateString() })}</span>
              </div>
              {!d.current && <button className="icon-btn" onClick={() => setAsk({ dev: d, wipe: false })} aria-label={t('dev.remove')}><LogOut size={16} /></button>}
            </div>
          );
        })}
      </div>
      {others.length > 0 && <button className="danger-btn full" onClick={() => setAsk('others')}><LogOut size={16} /> {t('dev.signOutOthers')}</button>}
      {ask && ask !== 'others' && (
        <Modal title={t('dev.removeTitle', { d: ask.dev.name })} onClose={() => setAsk(null)}>
          <p className="confirm-text">{t('dev.removeText')}</p>
          <button type="button" className={`toggle ${ask.wipe ? 'on' : ''}`} onClick={() => setAsk({ ...ask, wipe: !ask.wipe })} aria-pressed={ask.wipe}>
            <span><Trash2 size={16} /> {t('dev.wipe')}<small>{t('dev.wipeHint')}</small></span><i />
          </button>
          <div className="btn-row">
            <button className="ghost" onClick={() => setAsk(null)}>{t('common.cancel')}</button>
            <button className="danger-btn" onClick={async () => {
              try { await devices.revoke(ask.dev.id, ask.wipe); toast(ask.wipe ? t('dev.wipedToast') : t('dev.removedToast')); setAsk(null); load(); } catch (e) { toast(authError(t, e), 'err'); }
            }}>{t('dev.remove')}</button>
          </div>
        </Modal>
      )}
      {ask === 'others' && (
        <Confirm title={t('dev.signOutOthers')} text={t('dev.othersText', { n: others.length })} danger confirmLabel={t('dev.signOutOthersBtn')} cancelLabel={t('common.cancel')}
          onClose={() => setAsk(null)} onConfirm={async () => { try { await devices.revokeOthers(false); toast(t('dev.othersToast')); load(); } catch (e) { toast(authError(t, e), 'err'); } }} />
      )}
    </Modal>
  );
}

// ---------------- activity ----------------
const ACT_TONE = { login_failed: 'warn', mfa_failed: 'warn', session_reuse: 'bad', device_wiped: 'warn', password_reset_fresh: 'warn', '2fa_off': 'warn' };
export function ActivityModal({ onClose }) {
  const { t, activity } = useStore();
  const [events, setEvents] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { activity().then((r) => setEvents(r.events)).catch((e) => setError(authError(t, e))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title={t('act.title')} onClose={onClose}>
      <p className="sub">{t('act.text')}</p>
      {error && <p className="form-error">{error}</p>}
      {!events && !error && <p className="hint center"><span className="spinner" /></p>}
      <ul className="act-list">
        {(events || []).map((e, i) => {
          const label = t(`act.${e.type}`);
          return (
            <li key={`${e.t}-${i}`} className={ACT_TONE[e.type] || ''}>
              <CircleDot size={14} />
              <div>
                <b>{label === `act.${e.type}` ? e.type : label}{e.target ? ` · ${e.target}` : ''}</b>
                <span>{[e.dev, e.geo, new Date(e.t * 1000).toLocaleString()].filter(Boolean).join(' · ')}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {events && !events.length && <p className="muted center">{t('act.empty')}</p>}
      <p className="hint"><ShieldCheck size={14} /> {t('act.hint')}</p>
    </Modal>
  );
}

// ---------------- delete account ----------------
export function DeleteAccountModal({ onClose }) {
  const { t, deleteAccount, lang } = useStore();
  const word = lang === 'pt' ? 'EXCLUIR' : 'DELETE';
  const [typed, setTyped] = useState('');
  const [auth, setAuth] = useState(false);
  if (auth) {
    return <ReauthModal danger scope="delete" title={t('del.title')} text={t('del.reauth')} onClose={onClose} onDone={async ({ ticket }) => { await deleteAccount(ticket); }} />;
  }
  return (
    <Modal title={t('del.title')} onClose={onClose}>
      <div className="form">
        <p className="auth-note warn"><TriangleAlert size={16} /> {t('del.warn')}</p>
        <ul className="plain-list">
          <li>{t('del.l1')}</li>
          <li>{t('del.l2')}</li>
          <li>{t('del.l3')}</li>
        </ul>
        <label>{t('del.type', { w: word })}<input value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="characters" autoCorrect="off" spellCheck={false} /></label>
        <button className="danger-btn full" disabled={typed.trim().toUpperCase() !== word} onClick={() => setAuth(true)}><Trash2 size={16} /> {t('del.btn')}</button>
      </div>
    </Modal>
  );
}

// ---------------- account card (top of Settings) ----------------
export function AccountPanel() {
  const { t, session, vaultInfo, settings, cloud, cloudSyncNow, logout, toast, serverMode, isArtifact } = useStore();
  const [ask, setAsk] = useState(null); // logout | unsynced
  const [busy, setBusy] = useState(false);
  const local = vaultInfo.local || !serverMode;
  const name = settings.name || vaultInfo.name || '';
  const email = session.user?.email || vaultInfo.email || '';
  const verified = !!session.user?.emailVerified;
  const syncText = local ? t('acct.localOnly')
    : session.status === 'signedOut' ? t('sess.out')
      : cloud.status === 'syncing' ? t('acct.syncing')
        : cloud.status === 'error' ? t('acct.syncErr')
          : cloud.lastSyncAt ? t('acct.synced', { w: ago(t, cloud.lastSyncAt) }) : t('acct.syncWaiting');
  const doLogout = async (force = false) => {
    setBusy(true);
    try { await logout({ force }); } catch (e) {
      setBusy(false);
      if (e.code === 'unsynced') setAsk('unsynced'); else toast(authError(t, e), 'err');
    }
  };
  return (
    <section className="panel account-panel">
      <div className="acct-top">
        <div className="avatar" aria-hidden="true">{(name || email || '?').trim().slice(0, 1).toUpperCase()}</div>
        <div className="acct-id">
          <b>{name || t('acct.noName')}</b>
          <span>{email}{!local && verified && <BadgeCheck size={14} className="ok-ico" aria-label={t('acct.verified')} />}</span>
        </div>
      </div>
      <div className={`acct-sync ${cloud.status} ${local ? 'local' : ''}`}>
        {local ? <CloudOff size={16} /> : <Cloud size={16} />}
        <span>{syncText}</span>
        {!local && !isArtifact && (
          <button className="link-btn inline" disabled={cloud.status === 'syncing'} onClick={async () => { try { await cloudSyncNow(); toast(t('sync.done')); } catch (e) { toast(t(`sync.err.${e.code}`) !== `sync.err.${e.code}` ? t(`sync.err.${e.code}`) : t('acct.syncErr'), 'err'); } }}>
            <RefreshCw size={13} className={cloud.status === 'syncing' ? 'spin' : ''} /> {t('sync.now')}
          </button>
        )}
      </div>
      {!local && <p className="hint"><Lock size={13} /> {t('acct.e2ee')}</p>}
      <button className="secondary full" disabled={busy} onClick={() => setAsk('logout')}><LogOut size={16} /> {t('acct.logout')}</button>
      {ask === 'logout' && (
        <Confirm title={t('acct.logoutTitle')} text={t(local ? 'acct.logoutLocal' : 'acct.logoutText')} danger={local} confirmLabel={t('acct.logout')} cancelLabel={t('common.cancel')}
          onClose={() => setAsk(null)} onConfirm={() => doLogout(false)} />
      )}
      {ask === 'unsynced' && (
        <Confirm title={t('acct.unsyncedTitle')} text={t('acct.unsyncedText')} danger confirmLabel={t('acct.logoutAnyway')} cancelLabel={t('common.cancel')}
          onClose={() => setAsk(null)} onConfirm={() => doLogout(true)} />
      )}
    </section>
  );
}

// ---------------- security center ----------------
export function SecurityPanel() {
  const s = useStore();
  const { t, settings, updateSettings, vaultInfo, session, serverMode, toast, isArtifact } = s;
  const [modal, setModal] = useState(null);
  const [bioOk, setBioOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [proofFor, setProofFor] = useState(null); // pin | bio
  const local = vaultInfo.local || !serverMode;
  useEffect(() => { if (!isArtifact) biometricAvailable().then(setBioOk); }, [isArtifact]);

  const tfa = !!session.user?.twoFactor;
  const checks = [
    { key: 'e2ee', ok: true, label: t('sec5.c.e2ee') },
    ...(!local ? [{ key: 'tfa', ok: tfa, label: t('sec5.c.tfa'), fix: () => setModal('tfa'), fixLabel: t('sec5.turnOn') }] : []),
    { key: 'rk', ok: settings.recoverySaved !== false && (local ? vaultInfo.hasRecovery : true), label: t('sec5.c.rk'), fix: () => setModal('rk'), fixLabel: t('sec5.fix') },
    { key: 'quick', ok: vaultInfo.hasPin || vaultInfo.hasBio, label: t('sec5.c.quick'), fix: () => (bioOk ? enableBio() : startPin()), fixLabel: t('sec5.setUp') },
    { key: 'lock', ok: Number(settings.autoLockMin) >= 0 && Number(settings.autoLockMin) <= 15, label: t('sec5.c.lock'), fix: () => updateSettings({ autoLockMin: 5 }), fixLabel: t('sec5.fix') },
  ];
  const score = checks.filter((c) => c.ok).length;

  const proof = () => s.quickProof();
  const startPin = () => (proof() ? setModal('pin') : setProofFor('pin'));
  const enableBio = async (p = proof()) => {
    if (!p) { setProofFor('bio'); return; }
    setBusy(true);
    try { await s.enableBiometric(p); toast(t('sec.bioOn')); haptic('success'); } catch (e) { toast(e.code === 'prf-unsupported' ? t('sec.bioUnsupported') : t('sec.bioFail'), 'err'); }
    setBusy(false);
  };
  const [pinProof, setPinProof] = useState(null);

  const row = (Icon, title, sub, onClick, extra = null) => (
    <button className="set-row" onClick={onClick}>
      <span className="set-ico"><Icon size={18} /></span>
      <span className="set-txt"><b>{title}</b>{sub && <small>{sub}</small>}</span>
      {extra}
      <ChevronRight size={17} className="chev" />
    </button>
  );

  return (
    <section className="panel sec-center">
      <div className="sec-head">
        <h3><ShieldCheck size={17} /> {t('sec5.title')}</h3>
        <div className={`score s${score}`} aria-label={t('sec5.score', { n: score, m: checks.length })}><b>{score}</b>/{checks.length}</div>
      </div>
      <ul className="sec-checks">
        {checks.map((c) => (
          <li key={c.key} className={c.ok ? 'ok' : ''}>
            {c.ok ? <Check size={15} /> : <CircleDot size={15} />}
            <span>{c.label}</span>
            {!c.ok && c.fix && <button onClick={c.fix}>{c.fixLabel}</button>}
          </li>
        ))}
      </ul>

      <h4 className="set-sub">{t('sec5.unlock')}</h4>
      {row(Hash, vaultInfo.hasPin ? t('sec5.pinChange') : t('sec5.pinCreate'), vaultInfo.hasPin ? t('sec5.pinOn') : t('sec5.pinOff'), startPin)}
      {vaultInfo.hasPin && <button className="link-btn left small" onClick={() => setModal('pinOff')}>{t('sec5.pinRemove')}</button>}
      {bioOk && (
        <button className={`toggle ${vaultInfo.hasBio ? 'on' : ''}`} disabled={busy} aria-pressed={vaultInfo.hasBio}
          onClick={async () => { if (vaultInfo.hasBio) { await s.disableBiometric(); toast(t('sec.bioOff')); } else await enableBio(); }}>
          <span><ScanFace size={16} /> {t('sec.bio')}<small>{t('sec.bioHint')}</small></span><i />
        </button>
      )}
      <label className="field"><span className="field-label"><Timer size={14} /> {t('sec.autoLock')}</span>
        <select value={settings.autoLockMin} onChange={(e) => updateSettings({ autoLockMin: Number(e.target.value) })}>
          {AUTO_LOCK.map((m) => <option key={m} value={m}>{t(`sec.lock.${m}`)}</option>)}
        </select>
      </label>
      <label className="field"><span className="field-label"><KeyRound size={14} /> {t('sec5.pwEvery')}</span>
        <select value={Number(settings.pwEveryDays ?? 30)} onChange={(e) => updateSettings({ pwEveryDays: Number(e.target.value) })}>
          {PW_EVERY.map((d) => <option key={d} value={d}>{d ? t('sec5.pwEveryN', { n: d }) : t('sec5.pwNever')}</option>)}
        </select>
      </label>
      <button className={`toggle ${settings.hideValues ? 'on' : ''}`} onClick={() => updateSettings({ hideValues: !settings.hideValues })} aria-pressed={settings.hideValues}>
        <span><EyeOff size={16} /> {t('sec.hide')}<small>{t('sec.hideHint')}</small></span><i />
      </button>

      <h4 className="set-sub">{t('sec5.account')}</h4>
      {!local && row(Fingerprint, t('tfa.title'), tfa ? t('tfa.isOn') : t('tfa.isOff'), () => setModal('tfa'), tfa ? <em className="pill-on">{t('common.on')}</em> : <em className="pill-off">{t('common.off')}</em>)}
      {row(KeyRound, t('pwc.title'), t('pwc.sub'), () => setModal('pw'))}
      {row(LifeBuoy, t('rkm.title'), t('rkm.sub'), () => setModal('rk'))}
      {!local && row(Mail, t('em.title'), session.user?.email || vaultInfo.email, () => setModal('email'))}
      {!local && row(Smartphone, t('dev.title'), t('dev.sub'), () => setModal('devices'))}
      {!local && row(History, t('act.title'), t('act.sub'), () => setModal('activity'))}

      {modal === 'tfa' && <TwoFactorModal onClose={() => setModal(null)} />}
      {modal === 'pw' && <ChangePasswordModal onClose={() => setModal(null)} />}
      {modal === 'rk' && <RecoveryKeyModal onClose={() => setModal(null)} />}
      {modal === 'email' && <ChangeEmailModal onClose={() => setModal(null)} />}
      {modal === 'devices' && <DevicesModal onClose={() => setModal(null)} />}
      {modal === 'activity' && <ActivityModal onClose={() => setModal(null)} />}
      {modal === 'pin' && (
        <PinCreate title={vaultInfo.hasPin ? t('pin.newChange') : t('pin.new')} onClose={() => { setModal(null); setPinProof(null); }}
          onDone={async (p) => { await s.setPin(p, pinProof || proof()); toast(t('pin.saved')); haptic('success'); setModal(null); setPinProof(null); }} />
      )}
      {modal === 'pinOff' && (
        <Confirm title={t('sec5.pinRemove')} text={t(vaultInfo.hasBio ? 'sec5.pinRemoveTextBio' : 'sec5.pinRemoveText')} confirmLabel={t('sec5.pinRemove')} cancelLabel={t('common.cancel')}
          onClose={() => setModal(null)} onConfirm={async () => { await s.removePin(); toast(t('set.pinRemoved')); }} />
      )}
      {proofFor && (
        <PasswordProof onClose={() => setProofFor(null)} onProof={async (p) => {
          const checked = { dataKey: await s.dataKeyFrom(p) };
          const which = proofFor;
          setProofFor(null);
          if (which === 'pin') { setPinProof(checked); setModal('pin'); } else await enableBio(checked);
        }} />
      )}
    </section>
  );
}

/** Danger zone entry: deletes the account (server) — local accounts just erase the device. */
export function DeleteAccountButton() {
  const { t, serverMode, vaultInfo } = useStore();
  const [open, setOpen] = useState(false);
  if (!serverMode || vaultInfo.local) return null;
  return (
    <>
      <button className="link-btn danger left" onClick={() => setOpen(true)}><Trash2 size={14} /> {t('del.title')}</button>
      {open && <DeleteAccountModal onClose={() => setOpen(false)} />}
    </>
  );
}
