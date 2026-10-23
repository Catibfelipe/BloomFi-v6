import React, { useEffect, useRef, useState } from 'react';
import { Delete, Fingerprint, ShieldCheck, KeyRound, LogOut, Hash } from 'lucide-react';
import { useStore } from '../store.jsx';
import Wally from './Wally.jsx';
import Modal, { Confirm } from './Modal.jsx';
import { PasswordField, ResetFlow, TwoFactorForm, EmailCodeForm, authError } from './Auth.jsx';
import { login2fa, loginEmail } from '../lib/account.js';
import { haptic } from '../lib/haptics.js';

export function PinPad({ onComplete, error, length = 6, disabled = false, busy = false }) {
  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(false);

  useEffect(() => {
    if (!error) return undefined;
    setShake(true);
    setPin('');
    haptic('error');
    const id = setTimeout(() => setShake(false), 400);
    return () => clearTimeout(id);
  }, [error]);

  const press = (d) => {
    if (disabled || busy) return;
    haptic();
    setPin((p) => {
      if (p.length >= length) return p;
      const next = p + d;
      if (next.length === length) setTimeout(() => { onComplete(next); setPin(''); }, 120);
      return next;
    });
  };

  useEffect(() => {
    const onKey = (e) => {
      if (/input|textarea/i.test(document.activeElement?.tagName)) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className={`pinpad ${disabled ? 'disabled' : ''}`}>
      <div className={`pin-dots ${shake ? 'shake' : ''} ${busy ? 'busy' : ''}`} aria-label={`${pin.length}/${length}`}>
        {Array.from({ length }).map((_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}
      </div>
      {error && <p className="form-error center" role="alert">{error}</p>}
      <div className="keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((k, i) =>
          k === '' ? <span key={i} /> :
            k === 'del'
              ? <button key={i} type="button" onClick={() => setPin((p) => p.slice(0, -1))} aria-label="delete"><Delete size={20} /></button>
              : <button key={i} type="button" onClick={() => press(k)} disabled={disabled}>{k}</button>
        )}
      </div>
    </div>
  );
}

/** Account lock screen: PIN / biometrics for every day, the password every few weeks (or whenever wanted). */
export default function LockScreen() {
  const s = useStore();
  const { unlock, unlockBiometric, unlockPassword, unlockViaAccount, t, settings, vaultInfo, guard, phase, serverCfg, isArtifact, logout, completeAuth, localResetPassword, lang } = s;
  const [tfa, setTfa] = useState(null); // { ticket, ctx } when the account asks for the 2FA code
  const [mail, setMail] = useState(null); // { ticket, challengeId, email, ctx } when a code was e-mailed (account under attack)
  const legacy = phase === 'legacy';
  const days = Number(settings.pwEveryDays) || 0;
  const pwDue = !legacy && (!vaultInfo.hasPin && !vaultInfo.hasBio ? true : days > 0 && Date.now() - (vaultInfo.pwAt || 0) > days * 86400000);
  const [mode, setMode] = useState(legacy || (vaultInfo.hasPin && !pwDue) ? 'pin' : 'password');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState('');
  const pwBusy = useRef(false);
  const [modal, setModal] = useState(null); // forgot | other | legacyForgot | localReset
  const [wait, setWait] = useState(Math.max(0, (guard.until || 0) - Date.now()));
  const length = legacy ? (vaultInfo.kind === 'v1' ? vaultInfo.pinLength : 4) : vaultInfo.pinLength;
  const bio = !pwDue && (legacy ? vaultInfo.kind === 'v1' && vaultInfo.hasBio : vaultInfo.hasBio);
  const local = isArtifact || !serverCfg || vaultInfo.local;

  useEffect(() => {
    if (wait <= 0) return undefined;
    const id = setInterval(() => setWait((w) => Math.max(0, w - 1000)), 1000);
    return () => clearInterval(id);
  }, [wait > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!vaultInfo.hasPin && mode === 'pin' && !legacy) setMode('password'); }, [vaultInfo.hasPin]); // eslint-disable-line

  const tryBio = async () => {
    try {
      setBusy(true);
      if (!(await unlockBiometric())) setErr(t('sec.bioFail'));
    } catch {
      setErr(t('sec.bioFail'));
    } finally {
      setBusy(false);
    }
  };

  const onPin = async (p) => {
    setBusy(true);
    const r = await unlock(p);
    setBusy(false);
    if (r.ok) return;
    if (r.pinOff) { setMode('password'); setErr(r.reason === 'no_pin' ? t('auth.err.no_pin') : t('lock.pinOff')); return; }
    // Account PINs are checked by the server: without internet (or a session) the password opens the app.
    if (r.reason === 'pin_offline' || r.reason === 'signed_out') { setMode('password'); setErr(t(r.reason === 'pin_offline' ? 'auth.err.pin_offline' : 'lock.pinNeedsSession')); return; }
    if (r.reason) { setErr(authError(t, { code: r.reason, data: { retryAfter: r.retryAfter } })); return; }
    if (r.waitMs) { setWait(r.waitMs); setErr(t('pin.tooMany')); return; }
    const left = r.serverLeft != null && r.serverLeft <= 5 ? r.serverLeft : r.left;
    setErr(`${t('pin.wrong')}${left ? ` · ${t('pin.left', { n: left })}` : ''}${'​'.repeat(Math.floor(Math.random() * 5))}`);
  };

  const onPassword = async (e) => {
    e.preventDefault();
    // What is really in the field counts (a password manager may fill it without telling the page).
    const typed = String(e.currentTarget.elements.password?.value || pw);
    if (!typed || pwBusy.current) return;
    pwBusy.current = true;
    setBusy(true); setErr('');
    const r = await unlockPassword(typed).finally(() => { pwBusy.current = false; });
    setBusy(false);
    if (r.ok) return;
    if (r.need2fa) { setTfa({ ticket: r.ticket, ctx: r.ctx }); return; }
    if (r.needEmail) { setMail({ ticket: r.ticket, challengeId: r.challengeId, email: r.email, ctx: r.ctx }); return; }
    haptic('error');
    setErr(r.reason === 'keys_changed' ? t('lock.keysChanged') : r.reason ? authError(t, { code: r.reason, data: { retryAfter: r.retryAfter } }) : t('lock.pwWrong'));
  };

  return (
    <div className="lock-screen">
      <Wally mood="thinking" size={70} />
      <h1>{settings.name || vaultInfo.name ? t('pin.welcome', { name: (settings.name || vaultInfo.name).split(' ')[0] }) : 'BloomFi'}</h1>
      <p className="sub">
        {wait > 0 ? t('pin.waitFor', { s: Math.ceil(wait / 1000) })
          : busy ? t('pin.checking')
            : mode === 'pin' ? t('pin.enter') : pwDue && (vaultInfo.hasPin || vaultInfo.hasBio) ? t('lock.pwPeriodic', { n: days }) : t('lock.pwEnter')}
      </p>

      {tfa ? (
        <div className="lock-pw">
          <TwoFactorForm t={t} busy={busy} error={err} compact onSubmit={async (a) => {
            setBusy(true); setErr('');
            try { await unlockViaAccount(await login2fa(tfa.ctx, tfa.ticket, a)); } catch (e) { setErr(e.code === 'keys_changed' ? t('lock.keysChanged') : authError(t, e)); setBusy(false); }
          }} />
        </div>
      ) : mail ? (
        <div className="lock-pw">
          <EmailCodeForm t={t} busy={busy} error={err} email={mail.email} challengeId={mail.challengeId} onSubmit={async (code) => {
            setBusy(true); setErr('');
            try {
              const r = await loginEmail(mail.ctx, mail.ticket, mail.challengeId, code);
              if (r.need2fa) { setMail(null); setTfa({ ticket: r.ticket, ctx: r.ctx }); setBusy(false); return; }
              if (r.done) await unlockViaAccount(r.done);
            } catch (e) { setErr(e.code === 'keys_changed' ? t('lock.keysChanged') : authError(t, e)); setBusy(false); }
          }} />
        </div>
      ) : mode === 'pin' ? (
        <PinPad length={length} error={err} disabled={wait > 0} busy={busy} onComplete={onPin} />
      ) : (
        <form className="form lock-pw" onSubmit={onPassword}>
          <input type="email" name="username" autoComplete="username" value={vaultInfo.email || ''} readOnly hidden />
          <PasswordField label={t('auth.password')} value={pw} onChange={(v) => { setPw(v); setErr(''); }} autoFocus />
          {err && <p className="form-error" role="alert">{err}</p>}
          <button className="primary full" disabled={busy}>{busy ? <><span className="spinner" /> {t('pin.checking')}</> : t('lock.unlock')}</button>
        </form>
      )}

      {bio && <button className="bio-btn" onClick={tryBio} disabled={busy}><Fingerprint size={20} /> {t('sec.bioUnlock')}</button>}
      {!legacy && mode === 'pin' && <button className="link-btn" onClick={() => { setMode('password'); setErr(''); }}><KeyRound size={14} /> {t('lock.usePassword')}</button>}
      {!legacy && mode === 'password' && vaultInfo.hasPin && !pwDue && <button className="link-btn" onClick={() => { setMode('pin'); setErr(''); }}><Hash size={14} /> {t('lock.usePin')}</button>}
      {vaultInfo.pwStale && mode === 'password' && !tfa && !mail && <p className="hint center lock-hint">{t('lock.pwStale')}</p>}
      <p className="lock-badge"><ShieldCheck size={13} /> {t('sec.encryptedBadge')}</p>
      <div className="lock-links">
        {legacy
          ? <button className="link-btn" onClick={() => setModal('legacyForgot')}>{t('pin.forgot')}</button>
          : <button className="link-btn" onClick={() => setModal(local ? (vaultInfo.hasRecovery ? 'localReset' : 'other') : 'forgot')}>{t('lock.forgot')}</button>}
        {!legacy && <button className="link-btn" onClick={() => setModal('other')}><LogOut size={13} /> {t('lock.other')}</button>}
      </div>

      {modal === 'legacyForgot' && (
        <Confirm title={t('pin.forgot')} text={t('lock.legacyForgotText')} danger confirmLabel={t('set.wipeConfirm')} cancelLabel={t('common.cancel')}
          onClose={() => setModal(null)} onConfirm={() => logout({ force: true })} />
      )}
      {modal === 'other' && (
        <Confirm title={t('lock.other')} text={t(local ? 'lock.otherTextLocal' : 'lock.otherText')} danger confirmLabel={t('lock.otherConfirm')} cancelLabel={t('common.cancel')}
          onClose={() => setModal(null)} onConfirm={() => logout({ force: true })} />
      )}
      {modal === 'forgot' && (
        <Modal title={t('rst.title')} onClose={() => setModal(null)}>
          <p className="hint">{t(vaultInfo.hasPin || vaultInfo.hasBio ? 'lock.forgotQuick' : 'lock.forgotText')}</p>
          <ResetFlow t={t} lang={lang} email={vaultInfo.email}
            onDone={(res) => completeAuth(res)} />
        </Modal>
      )}
      {modal === 'localReset' && <LocalReset onClose={() => setModal(null)} onDone={localResetPassword} />}
    </div>
  );
}

/** Device-only account (no server): the recovery key sets a new password. */
function LocalReset({ onClose, onDone }) {
  const { t } = useStore();
  const [rk, setRk] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title={t('rst.title')} onClose={onClose}>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        if (pw.length < 10) return setError(t('pw.issue.short'));
        setBusy(true); setError('');
        try { await onDone({ recoveryText: rk, password: pw }); onClose(); } catch { setError(t('auth.err.invalid_recovery')); setBusy(false); }
      }}>
        <p className="sub">{t('rst.localText')}</p>
        <label>{t('rk.label')}<textarea className="textbox short mono" value={rk} onChange={(e) => setRk(e.target.value)} placeholder="XXXX-XXXX-…" /></label>
        <PasswordField label={t('auth.newPassword')} value={pw} onChange={setPw} autoComplete="new-password" name="new-password" />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary full" disabled={busy}>{t('rst.save')}</button>
      </form>
    </Modal>
  );
}
