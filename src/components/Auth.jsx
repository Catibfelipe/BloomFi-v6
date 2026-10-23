import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, ChevronLeft, ShieldCheck, Smartphone, RefreshCw, Eye, EyeOff, Mail, KeyRound, Copy, Download, Share2, Printer,
  Check, LifeBuoy, LogIn, UserPlus, TriangleAlert, Users,
} from 'lucide-react';
import { useStore } from '../store.jsx';
import Wally from './Wally.jsx';
import Modal from './Modal.jsx';
import { makeT } from '../i18n.js';
import { passwordIssues, passwordScore, parseRecoveryKey } from '../lib/keys.js';
import {
  signupStart, signupVerify, signupFinish, loginStart, login2fa, loginEmail, resendCode, resetStart, resetVerify, resetFinish, pwnedTimes, localSignup, openLogin,
  loginWithMaster,
} from '../lib/account.js';
import { download, linkSaver } from '../lib/pwa.js';
import { haptic } from '../lib/haptics.js';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

/** Error code from the server/crypto -> friendly text. */
export function authError(t, e) {
  const code = e?.code || 'generic';
  if (code === 'account_locked' || code === 'too_many_requests') {
    const s = Number(e?.data?.retryAfter) || 60;
    return t(`auth.err.${code}`, { m: Math.max(1, Math.ceil(s / 60)) });
  }
  if (code === 'invalid_code' && e?.data?.attemptsLeft != null) return t('auth.err.invalid_code_left', { n: e.data.attemptsLeft });
  const k = `auth.err.${code}`;
  const v = t(k);
  return v !== k ? v : t('auth.err.generic');
}

// ---------------- small building blocks ----------------
export function PasswordField({ label, value, onChange, autoComplete = 'current-password', autoFocus, name = 'password', id, placeholder }) {
  const [show, setShow] = useState(false);
  const { t } = useStore();
  return (
    <label className="pw-field">{label}
      <span className="pw-wrap">
        <input id={id} name={name} type={show ? 'text' : 'password'} value={value} autoFocus={autoFocus} autoComplete={autoComplete}
          autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={placeholder} enterKeyHint="go"
          onChange={(e) => onChange(e.target.value)} passwordrules={autoComplete === 'new-password' ? 'minlength: 10; required: lower; required: digit;' : undefined} />
        <button type="button" className="pw-eye" onClick={() => setShow(!show)} aria-label={show ? t('auth.hidePw') : t('auth.showPw')} aria-pressed={show}>
          {show ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </span>
    </label>
  );
}

export function PasswordMeter({ password, email, name }) {
  const { t } = useStore();
  const score = passwordScore(password);
  const issues = passwordIssues(password, { email, name });
  if (!password) return <p className="hint">{t('pw.rules')}</p>;
  const labels = ['pw.s0', 'pw.s1', 'pw.s2', 'pw.s3', 'pw.s4'];
  return (
    <div className={`pw-meter s${issues.length ? Math.min(score, 1) : score}`} aria-live="polite">
      <div className="pw-bars">{[0, 1, 2, 3].map((i) => <i key={i} className={i < (issues.length ? Math.min(score, 1) : score) ? 'on' : ''} />)}</div>
      <span>{t(labels[issues.length ? Math.min(score, 1) : score])}</span>
      {issues.length > 0 && <ul>{issues.map((i) => <li key={i}>{t(`pw.issue.${i}`)}</li>)}</ul>}
    </div>
  );
}

/** One input, big digits, works with the phone's "code from SMS/e-mail" autofill. */
export function CodeInput({ value, onChange, onComplete, autoFocus = true, label }) {
  const ref = useRef();
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  return (
    <label className="code-field">{label}
      <input ref={ref} className="code-input-big" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} value={value}
        enterKeyHint="done" aria-label={label || 'code'}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, '').slice(0, 6);
          onChange(v);
          if (v.length === 6) { haptic(); onComplete?.(v); }
        }} />
    </label>
  );
}

/**
 * One submission at a time: a code completed by the phone's autofill while the button is tapped, or a double tap,
 * never sends the same step twice (the second would find the code already used and show a false error).
 */
function useOneAtATime() {
  const busy = useRef(false);
  return (fn) => async (...args) => {
    if (busy.current) return undefined;
    busy.current = true;
    try { return await fn(...args); } finally { busy.current = false; }
  };
}

function Cooldown({ until, children }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return children(left);
}

// ---------------- the gate ----------------
export default function AuthGate() {
  const store = useStore();
  const { authCtx, settings, serverCfg, isArtifact, completeAuth, updateSettings } = store;
  const local = isArtifact || !serverCfg;
  const [lang, setLang] = useState(settings.lang);
  const t = makeT(lang);
  const [screen, setScreen] = useState('welcome');
  const [flow, setFlow] = useState({}); // data carried between steps
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const go = (s, extra = {}) => { setError(''); setFlow((f) => ({ ...f, ...extra })); setScreen(s); };
  const fail = (e) => { setError(authError(t, e)); setBusy(false); };
  const once = useOneAtATime();
  // The account was confirmed: create its keys. If that answer got lost but the server finished, sign in instead.
  const finishSignup = async (ctx, v, legacy) => {
    try {
      await finish(await signupFinish(ctx, v, legacy));
    } catch (e) {
      if (e.code !== 'already_set_up') throw e;
      const r = await loginWithMaster(ctx);
      if (r.done) await finish(r.done);
      else if (r.need2fa) go('tfa', { ctx: r.ctx, ticket: r.ticket, from: 'login' });
    }
  };
  const legacyInfo = async () => {
    // A version 4 subscription on this device goes along to the new account.
    const { db } = await import('../db.js');
    const acc = await db.getMeta('account');
    const trialStart = await db.getMeta('trialStart');
    return acc?.token || trialStart ? { accountToken: acc?.token, trialStart: trialStart ?? undefined } : null;
  };
  const finish = async (res) => {
    if (lang !== settings.lang) await updateSettings({ lang });
    await completeAuth(res);
  };

  return (
    <div className="onboarding auth">
      <div className="onb-card">
        {screen !== 'welcome' && (
          <button className="onb-back" onClick={() => go(screen === 'verify' || screen === 'tfa' || screen === 'mailcode' ? (flow.from || 'login') : screen.startsWith('reset') ? 'login' : 'welcome')} aria-label={t('common.back')}>
            <ChevronLeft size={20} />
          </button>
        )}

        {screen === 'welcome' && (
          <>
            <Wally mood="celebrate" size={92} />
            <h1>{t('auth.welcomeTitle')}</h1>
            <p className="sub">{t('auth.welcomeSub')}</p>
            {authCtx.notice && <p className={`auth-note ${authCtx.notice === 'wiped' ? 'warn' : ''}`} role="status">{t(`auth.notice.${authCtx.notice}`)}</p>}
            {store.invite && !local && <p className="auth-note" role="status"><Users size={16} /> {t('sp.authInvite')}</p>}
            {authCtx.legacy && <p className="auth-note"><ShieldCheck size={16} /> {t(local ? 'auth.legacyNoteLocal' : 'auth.legacyNote')}</p>}
            <ul className="onb-feats">
              <li><ShieldCheck size={18} />{t('auth.f1')}</li>
              {!local && <li><Smartphone size={18} />{t('auth.f2')}</li>}
              <li><RefreshCw size={18} />{t(local ? 'auth.f3local' : 'auth.f3')}</li>
            </ul>
            <div className="chips center">
              {[['pt', '🇧🇷 Português'], ['en', '🇺🇸 English']].map(([k, l]) => (
                <button key={k} className={lang === k ? 'on' : ''} onClick={() => setLang(k)} aria-pressed={lang === k}>{l}</button>
              ))}
            </div>
            <button className="primary full" onClick={() => go('signup')}><UserPlus size={18} /> {t('auth.create')}</button>
            {!local && <button className="secondary full" onClick={() => go('login')}><LogIn size={18} /> {t('auth.haveAccount')}</button>}
            {local && <p className="hint center">{t('auth.localNote')}</p>}
            <p className="legal-links">{!isArtifact && <><a href="/termos.html" target="_blank" rel="noopener">{t('legal.terms')}</a> · <a href="/privacidade.html" target="_blank" rel="noopener">{t('legal.privacy')}</a></>}</p>
          </>
        )}

        {screen === 'signup' && (
          <SignupForm t={t} lang={lang} local={local} busy={busy} error={error} setError={setError}
            onSubmit={once(async ({ name, email, password }) => {
              setBusy(true); setError('');
              try {
                if (local) { await finish({ ...(await localSignup({ name, email, password })) }); return; }
                const n = await pwnedTimes(password);
                if (n > 0) { setBusy(false); setError(t('pw.pwned', { n: n.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US') })); return; }
                const r = await signupStart({ name, email, password, lang });
                const legacy = await legacyInfo();
                if (!r.verify) {
                  await finish(await signupFinish(r.ctx, r, legacy));
                  return;
                }
                setBusy(false);
                go('verify', { ctx: r.ctx, challengeId: r.challengeId, emailMasked: r.email, legacy, from: 'signup', sentAt: Date.now(), verified: null });
              } catch (e) { fail(e); }
            })}
            onLogin={() => go('login')} />
        )}

        {screen === 'verify' && (
          <VerifyForm t={t} flow={flow} busy={busy} error={error}
            onResend={once(async () => { try { await resendCode(flow.challengeId); setFlow((f) => ({ ...f, sentAt: Date.now() })); setError(''); } catch (e) { fail(e); } })}
            onLogin={() => go('login', { email: flow.ctx?.email || '' })}
            onSubmit={once(async (code) => {
              setBusy(true); setError('');
              try {
                // The code is checked once; if only the last step failed (connection), trying again skips the code.
                const v = flow.verified || await signupVerify(flow.challengeId, code);
                if (!flow.verified) setFlow((f) => ({ ...f, verified: v }));
                await finishSignup(flow.ctx, v, flow.legacy);
              } catch (e) { fail(e); }
            })} />
        )}

        {screen === 'login' && (
          <LoginForm t={t} busy={busy} error={error} email={flow.email}
            onSubmit={once(async ({ email, password }) => {
              setBusy(true); setError('');
              try {
                const r = await loginStart({ email, password });
                if (r.done) { await finish(r.done); return; }
                setBusy(false);
                if (r.need2fa) go('tfa', { ctx: r.ctx, ticket: r.ticket, from: 'login' });
                else if (r.needEmail) go('mailcode', { ctx: r.ctx, ticket: r.ticket, challengeId: r.challengeId, emailMasked: r.email, from: 'login' });
                else if (r.setup) await finishSignup(r.ctx, r, await legacyInfo());
              } catch (e) { fail(e); }
            })}
            onForgot={(email) => go('reset', { email })} onSignup={() => go('signup')} />
        )}

        {screen === 'tfa' && (
          <TwoFactorForm t={t} busy={busy} error={error}
            onSubmit={once(async (answer) => {
              setBusy(true); setError('');
              try { await finish(await login2fa(flow.ctx, flow.ticket, answer)); } catch (e) { fail(e); }
            })} />
        )}

        {screen === 'mailcode' && (
          <EmailCodeForm t={t} busy={busy} error={error} email={flow.emailMasked} challengeId={flow.challengeId} full
            onSubmit={once(async (code) => {
              setBusy(true); setError('');
              try {
                const r = await loginEmail(flow.ctx, flow.ticket, flow.challengeId, code);
                if (r.done) { await finish(r.done); return; }
                setBusy(false);
                if (r.need2fa) go('tfa', { ctx: r.ctx, ticket: r.ticket, from: 'login' });
                else if (r.setup) await finishSignup(r.ctx, r, await legacyInfo());
              } catch (e) { fail(e); }
            })} />
        )}

        {screen === 'reset' && <ResetFlow t={t} lang={lang} email={flow.email} onDone={finish} onCancel={() => go('login')} />}
      </div>
    </div>
  );
}

function SignupForm({ t, local, busy, error, setError, onSubmit, onLogin }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [agree, setAgree] = useState(false);
  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) return setError(t('auth.err.invalid_name'));
    if (!EMAIL_RE.test(email.trim())) return setError(t('auth.err.invalid_email'));
    const issues = passwordIssues(pw, { email, name });
    if (issues.length) return setError(t(`pw.issue.${issues[0]}`));
    if (pw !== pw2) return setError(t('auth.err.mismatch'));
    if (!agree && !local) return setError(t('auth.err.terms'));
    onSubmit({ name: name.trim(), email: email.trim(), password: pw });
  };
  return (
    <form className="form" onSubmit={submit} noValidate>
      <Wally mood="happy" size={56} />
      <h1>{t('auth.signupTitle')}</h1>
      <p className="sub">{t(local ? 'auth.signupSubLocal' : 'auth.signupSub')}</p>
      <label>{t('auth.name')}<input name="name" autoComplete="name" autoCapitalize="words" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={t('onb.namePh')} enterKeyHint="next" /></label>
      <label>{t('auth.email')}<input name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@email.com" enterKeyHint="next" /></label>
      <PasswordField label={t('auth.password')} value={pw} onChange={setPw} autoComplete="new-password" name="new-password" />
      <PasswordMeter password={pw} email={email} name={name} />
      <PasswordField label={t('auth.password2')} value={pw2} onChange={setPw2} autoComplete="new-password" name="new-password-2" />
      {!local && (
        <label className="check-line">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>{t('auth.terms1')} <a href="/termos.html" target="_blank" rel="noopener">{t('legal.terms')}</a> {t('auth.terms2')} <a href="/privacidade.html" target="_blank" rel="noopener">{t('legal.privacy')}</a></span>
        </label>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary full" disabled={busy}>{busy ? <><span className="spinner" /> {t('auth.protecting')}</> : <>{t('auth.createBtn')} <ArrowRight size={18} /></>}</button>
      <p className="hint">{t('auth.pwHint')}</p>
      {!local && <button type="button" className="link-btn" onClick={onLogin}>{t('auth.haveAccountLink')}</button>}
    </form>
  );
}

function VerifyForm({ t, flow, busy, error, onSubmit, onResend, onLogin }) {
  const [code, setCode] = useState('');
  const retry = !!flow.verified; // the code was right; only the last step has to be tried again
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); if (retry || code.length === 6) onSubmit(code); }}>
      <Wally mood="thinking" size={60} />
      <h1>{t('auth.verifyTitle')}</h1>
      <p className="sub">{t(retry ? 'auth.verifyRetry' : 'auth.verifyText', { e: flow.emailMasked || flow.ctx?.email || '' })}</p>
      {!retry && <CodeInput value={code} onChange={setCode} onComplete={(v) => !busy && onSubmit(v)} label={t('auth.code')} />}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary full" disabled={busy || (!retry && code.length !== 6)}>{busy ? <><span className="spinner" /> {t('auth.checking')}</> : t(retry ? 'auth.tryAgain' : 'auth.verifyBtn')}</button>
      {!retry && (
        <>
          <Cooldown until={(flow.sentAt || 0) + 45000}>
            {(left) => <button type="button" className="link-btn" disabled={left > 0} onClick={onResend}><Mail size={14} /> {left > 0 ? t('auth.resendIn', { s: left }) : t('auth.resend')}</button>}
          </Cooldown>
          <p className="hint center">{t('auth.checkSpam')}</p>
          <p className="hint center">{t('auth.maybeAccount')} <button type="button" className="link-btn inline" onClick={onLogin}>{t('auth.loginInstead')}</button></p>
        </>
      )}
    </form>
  );
}

function LoginForm({ t, busy, error, onSubmit, onForgot, onSignup, email: email0 }) {
  const [email, setEmail] = useState(email0 || '');
  const [pw, setPw] = useState('');
  const [missing, setMissing] = useState('');
  const submit = (e) => {
    e.preventDefault();
    // Read what is really in the fields: some password managers fill them without telling the page.
    const f = e.currentTarget.elements;
    const em = String(f.username?.value || email).trim();
    const p = String(f.password?.value || pw);
    if (!em || !p) { setMissing(t(!em ? 'auth.err.invalid_email' : 'auth.err.no_password')); return; }
    setMissing('');
    onSubmit({ email: em, password: p });
  };
  return (
    <form className="form" onSubmit={submit}>
      <Wally mood="happy" size={56} />
      <h1>{t('auth.loginTitle')}</h1>
      <label>{t('auth.email')}<input name="username" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus={!email0} enterKeyHint="next" /></label>
      <PasswordField label={t('auth.password')} value={pw} onChange={setPw} autoComplete="current-password" autoFocus={!!email0} />
      {(error || missing) && <p className="form-error" role="alert">{missing || error}</p>}
      <button className="primary full" disabled={busy}>{busy ? <><span className="spinner" /> {t('auth.checking')}</> : <>{t('auth.loginBtn')} <ArrowRight size={18} /></>}</button>
      <button type="button" className="link-btn" onClick={() => onForgot(email)}>{t('auth.forgot')}</button>
      <button type="button" className="link-btn" onClick={onSignup}>{t('auth.noAccount')}</button>
    </form>
  );
}

/** "Confirm it's you": the 6-digit code e-mailed when the account had many wrong passwords. */
export function EmailCodeForm({ t, busy, error, email, challengeId, onSubmit, full = false }) {
  const [code, setCode] = useState('');
  const [sentAt, setSentAt] = useState(Date.now());
  const [note, setNote] = useState('');
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); if (code.length === 6) onSubmit(code); }}>
      {full && <Wally mood="thinking" size={60} />}
      {full && <h1>{t('auth.loginCodeTitle')}</h1>}
      <p className="sub">{t('auth.loginCodeText', { e: email || '' })}</p>
      <CodeInput value={code} onChange={setCode} onComplete={(v) => !busy && onSubmit(v)} label={t('auth.code')} />
      {(error || note) && <p className="form-error" role="alert">{error || note}</p>}
      <button className="primary full" disabled={busy || code.length !== 6}>{busy ? <><span className="spinner" /> {t('auth.checking')}</> : t('auth.verifyBtn')}</button>
      <Cooldown until={sentAt + 45000}>
        {(left) => <button type="button" className="link-btn" disabled={left > 0} onClick={async () => { try { await resendCode(challengeId); setSentAt(Date.now()); setNote(''); } catch (er) { setNote(authError(t, er)); } }}><Mail size={14} /> {left > 0 ? t('auth.resendIn', { s: left }) : t('auth.resend')}</button>}
      </Cooldown>
      <p className="hint center">{t('auth.checkSpam')}</p>
    </form>
  );
}

export function TwoFactorForm({ t, busy, error, onSubmit, compact = false }) {
  const [code, setCode] = useState('');
  const [backup, setBackup] = useState(null);
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); if (backup != null) onSubmit({ backup }); else if (code.length === 6) onSubmit({ code }); }}>
      {!compact && <Wally mood="thinking" size={60} />}
      {!compact && <h1>{t('auth.tfaTitle')}</h1>}
      <p className="sub">{backup != null ? t('auth.tfaBackupText') : t('auth.tfaText')}</p>
      {backup == null
        ? <CodeInput value={code} onChange={setCode} onComplete={(v) => !busy && onSubmit({ code: v })} label={t('auth.code')} />
        : <label>{t('auth.backupCode')}<input className="mono" autoCapitalize="none" autoCorrect="off" autoFocus value={backup} onChange={(e) => setBackup(e.target.value)} placeholder="abcd-1234" /></label>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary full" disabled={busy || (backup == null ? code.length !== 6 : backup.replace(/\W/g, '').length < 8)}>{busy ? <><span className="spinner" /> {t('auth.checking')}</> : t('auth.verifyBtn')}</button>
      <button type="button" className="link-btn" onClick={() => setBackup(backup == null ? '' : null)}>{backup == null ? t('auth.useBackup') : t('auth.useApp')}</button>
    </form>
  );
}

// ---------------- forgot password ----------------
/** E-mail code (+2FA) -> recovery key (or not) -> new password. onDone receives what completeAuth needs. */
export function ResetFlow({ t, lang, email: email0, onDone, onCancel }) {
  const [step, setStep] = useState('email');
  const [email, setEmail] = useState(email0 || '');
  const [ch, setCh] = useState(null);
  const [code, setCode] = useState('');
  const [need2fa, setNeed2fa] = useState(false);
  const [v, setV] = useState(null); // { ticket, share, recovery }
  const [rk, setRk] = useState('');
  const [noKey, setNoKey] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fail = (e) => { setError(authError(t, e)); setBusy(false); };

  const verify = async (extra = {}, c = code) => {
    setBusy(true); setError('');
    try {
      const r = await resetVerify(ch.challengeId, c, extra);
      setBusy(false);
      if (r.need2fa) { setNeed2fa(true); return; }
      setV(r);
      setStep(r.recovery ? 'key' : 'password');
      if (!r.recovery) setNoKey(true);
    } catch (e) { fail(e); }
  };

  return (
    <div className="form">
      <Wally mood="thinking" size={56} />
      <h1>{t('rst.title')}</h1>
      {step === 'email' && (
        <form className="form" onSubmit={async (e) => {
          e.preventDefault();
          if (!EMAIL_RE.test(email.trim())) return setError(t('auth.err.invalid_email'));
          setBusy(true); setError('');
          try { const r = await resetStart(email); setCh({ ...r, sentAt: Date.now() }); setStep('code'); setBusy(false); } catch (er) { fail(er); }
        }}>
          <p className="sub">{t('rst.emailText')}</p>
          <label>{t('auth.email')}<input type="email" inputMode="email" autoComplete="username" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary full" disabled={busy}><Mail size={17} /> {t('rst.send')}</button>
          {onCancel && <button type="button" className="link-btn" onClick={onCancel}>{t('common.cancel')}</button>}
        </form>
      )}
      {step === 'code' && (
        <form className="form" onSubmit={(e) => { e.preventDefault(); if (need2fa) return; verify(); }}>
          <p className="sub">{t('auth.verifyText', { e: ch?.email || email })}</p>
          <CodeInput value={code} onChange={setCode} onComplete={(v) => !need2fa && !busy && verify({}, v)} label={t('auth.code')} autoFocus={!need2fa} />
          {!need2fa && <button className="primary full" disabled={busy || code.length !== 6}>{busy ? t('auth.checking') : t('auth.verifyBtn')}</button>}
          {need2fa && <TwoFactorForm t={t} busy={busy} error={error} compact onSubmit={(a) => verify(a.backup ? { backup: a.backup } : { totp: a.code })} />}
          {!need2fa && error && <p className="form-error" role="alert">{error}</p>}
          <Cooldown until={(ch?.sentAt || 0) + 45000}>
            {(left) => <button type="button" className="link-btn" disabled={left > 0} onClick={async () => { try { await resendCode(ch.challengeId); setCh((c) => ({ ...c, sentAt: Date.now() })); } catch (er) { fail(er); } }}>{left > 0 ? t('auth.resendIn', { s: left }) : t('auth.resend')}</button>}
          </Cooldown>
        </form>
      )}
      {step === 'key' && (
        <div className="form">
          <p className="sub">{t('rst.keyQ')}</p>
          <label>{t('rk.label')}<textarea className="textbox short mono" autoCapitalize="characters" autoCorrect="off" spellCheck={false} value={rk} onChange={(e) => { setRk(e.target.value); setError(''); }} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary full" disabled={!parseRecoveryKey(rk)} onClick={() => { setNoKey(false); setStep('password'); }}><KeyRound size={17} /> {t('rst.useKey')}</button>
          <button className="secondary full" onClick={() => { setNoKey(true); setRk(''); setStep('password'); }}>{t('rst.noKey')}</button>
        </div>
      )}
      {step === 'password' && (
        <form className="form" onSubmit={async (e) => {
          e.preventDefault();
          const issues = passwordIssues(pw, { email });
          if (issues.length) return setError(t(`pw.issue.${issues[0]}`));
          if (pw !== pw2) return setError(t('auth.err.mismatch'));
          setBusy(true); setError('');
          try {
            const n = await pwnedTimes(pw);
            if (n > 0) { setBusy(false); setError(t('pw.pwned', { n: n.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US') })); return; }
            const res = await resetFinish({ ticket: v.ticket, share: v.share, recovery: v.recovery, recoveryText: noKey ? null : rk, password: pw, email });
            await onDone(res);
          } catch (er) {
            if (er.code === 'invalid_recovery') { setStep('key'); }
            fail(er);
          }
        }}>
          {noKey && <p className="auth-note warn"><TriangleAlert size={16} /> {t('rst.noKeyText')}</p>}
          {!noKey && <p className="auth-note"><Check size={16} /> {t('rst.keyOk')}</p>}
          <PasswordField label={t('auth.newPassword')} value={pw} onChange={setPw} autoComplete="new-password" name="new-password" autoFocus />
          <PasswordMeter password={pw} email={email} />
          <PasswordField label={t('auth.password2')} value={pw2} onChange={setPw2} autoComplete="new-password" name="new-password-2" />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary full" disabled={busy}>{busy ? <><span className="spinner" /> {t('auth.protecting')}</> : t('rst.save')}</button>
        </form>
      )}
    </div>
  );
}

// ---------------- recovery key (shown once) ----------------
export function RecoveryKeyScreen({ text, onDone, modal = false }) {
  const { t, settings, toast, isArtifact } = useStore();
  const [saved, setSaved] = useState(false);
  // The link version saves files only through claude.ai (the person confirms there); elsewhere: copy, share or print.
  const [canSave, setCanSave] = useState(!isArtifact);
  useEffect(() => { if (isArtifact) linkSaver().then((x) => setCanSave(!!x)); }, [isArtifact]);
  const groups = useMemo(() => text.split('-'), [text]);
  const file = () => `${t('rk.fileHead')}\n\n${text}\n\n${t('rk.fileFoot', { e: settings.name || '' })}\n`;
  const copy = async () => { try { await navigator.clipboard.writeText(text); toast(t('set.copied')); } catch { toast(t('set.copyManual'), 'info'); } };
  const share = async () => { try { await navigator.share({ title: 'BloomFi', text: file() }); } catch { /* closed */ } };
  const print = () => {
    // A sheet only the printer sees (no new window: nothing to block, nothing left open).
    const sheet = document.createElement('pre');
    sheet.className = 'print-sheet';
    sheet.textContent = file();
    document.body.appendChild(sheet);
    document.documentElement.classList.add('printing');
    const done = () => { sheet.remove(); document.documentElement.classList.remove('printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => { window.print(); setTimeout(done, 1500); }, 50);
  };
  const body = (
    <div className="form rk">
      {!modal && <Wally mood="celebrate" size={64} />}
      {!modal && <h1>{t('rk.title')}</h1>}
      <p className="sub">{t('rk.text')}</p>
      <div className="rk-box" aria-label={t('rk.label')}>{groups.map((g, i) => <code key={i}>{g}</code>)}</div>
      <div className="rk-actions">
        <button type="button" className="secondary" onClick={copy}><Copy size={16} /> {t('set.copy')}</button>
        {canSave && <button type="button" className="secondary" onClick={async () => { if ((await download('bloomfi-chave-de-recuperacao.txt', file(), 'text/plain')) === 'unavailable') { setCanSave(false); toast(t('rk.saveOff'), 'info'); } }}><Download size={16} /> {t('rk.download')}</button>}
        {typeof navigator.share === 'function' && <button type="button" className="secondary" onClick={share}><Share2 size={16} /> {t('rk.share')}</button>}
        <button type="button" className="secondary" onClick={print}><Printer size={16} /> {t('rk.print')}</button>
      </div>
      <p className="hint"><LifeBuoy size={14} /> {t('rk.hint')}</p>
      <label className="check-line"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /><span>{t('rk.saved')}</span></label>
      <button className="primary full" disabled={!saved} onClick={onDone}>{t('common.next')} <ArrowRight size={18} /></button>
    </div>
  );
  if (modal) return <Modal title={t('rk.title')} onClose={() => {}}>{body}</Modal>;
  return <div className="onboarding auth"><div className="onb-card">{body}</div></div>;
}

// ---------------- signing in again on this device ----------------
/** The session ended (or the password changed elsewhere): password (+2FA) to reconnect. Data stays. */
export function ReloginModal({ onClose }) {
  const { t, vaultInfo, session, finishRelogin, toast } = useStore();
  const [pw, setPw] = useState('');
  const [state, setState] = useState(null); // { ticket, ctx } when 2FA is needed
  const [mail, setMail] = useState(null); // { ticket, challengeId, email, ctx } when a code was e-mailed
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const done = async (res) => { await finishRelogin(res); toast(t('auth.reloginOk')); onClose(); };
  const fail = (e) => { setError(authError(t, e)); setBusy(false); };
  return (
    <Modal title={t('auth.reloginTitle')} onClose={onClose}>
      {mail && !state ? (
        <EmailCodeForm t={t} busy={busy} error={error} email={mail.email} challengeId={mail.challengeId} onSubmit={async (code) => {
          setBusy(true); setError('');
          try {
            const r = await loginEmail(mail.ctx, mail.ticket, mail.challengeId, code);
            if (r.done) return await done(r.done);
            if (r.need2fa) { setState({ ticket: r.ticket, ctx: r.ctx }); setBusy(false); return; }
            setBusy(false);
          } catch (er) { fail(er); }
        }} />
      ) : !state ? (
        <form className="form" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true); setError('');
          try {
            const r = await loginStart({ email: vaultInfo.email, password: pw });
            if (r.done) return await done(r.done);
            if (r.need2fa) { setState({ ticket: r.ticket, ctx: r.ctx }); setBusy(false); return; }
            if (r.needEmail) { setMail({ ticket: r.ticket, challengeId: r.challengeId, email: r.email, ctx: r.ctx }); setBusy(false); return; }
            setBusy(false);
            setError(t('auth.err.generic'));
          } catch (er) { fail(er); }
        }}>
          <p className="sub">{t(vaultInfo.pwStale || session.reason === 'keys_changed' ? 'auth.reloginKeys' : 'auth.reloginText', { e: vaultInfo.email })}</p>
          <input type="email" name="username" autoComplete="username" value={vaultInfo.email || ''} readOnly hidden />
          <PasswordField label={t('auth.password')} value={pw} onChange={setPw} autoFocus />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary full" disabled={busy || !pw}>{busy ? <><span className="spinner" /> {t('auth.checking')}</> : t('auth.loginBtn')}</button>
        </form>
      ) : (
        <TwoFactorForm t={t} busy={busy} error={error} compact onSubmit={async (a) => {
          setBusy(true); setError('');
          try { await done(await login2fa(state.ctx, state.ticket, a)); } catch (er) { fail(er); }
        }} />
      )}
    </Modal>
  );
}

export { openLogin };
