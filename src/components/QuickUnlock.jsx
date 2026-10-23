import React, { useEffect, useState } from 'react';
import { Fingerprint, KeyRound, ArrowRight } from 'lucide-react';
import { useStore } from '../store.jsx';
import Wally from './Wally.jsx';
import Modal from './Modal.jsx';
import { PinPad } from './Lock.jsx';
import { PasswordField, authError } from './Auth.jsx';
import { biometricAvailable } from '../lib/biometric.js';

const weakPin = (p) => /^(\d)\1{5}$/.test(p) || '0123456789'.includes(p) || '9876543210'.includes(p) || ['123123', '121212', '112233', '102030', '010203'].includes(p);

/** Two entries of a new 6-digit PIN. onDone(pin) does the saving. */
export function PinCreate({ onDone, onClose, title }) {
  const { t } = useStore();
  const [first, setFirst] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={first ? t('pin.confirm') : title || t('pin.new')} onClose={busy ? () => {} : onClose}>
      <PinPad key={first ? 'b' : 'a'} length={6} error={err} busy={busy} onComplete={async (p) => {
        if (!first) {
          if (weakPin(p)) { setErr(t('pin.weak')); return; }
          setFirst(p); setErr(''); return;
        }
        if (p !== first) { setFirst(null); setErr(t('pin.mismatch')); return; }
        setBusy(true);
        // Account PINs are registered with the server (it checks them later): this step needs internet.
        try { await onDone(p); } catch (e) { setBusy(false); setFirst(null); setErr(authError(t, e)); }
      }} />
      <p className="hint center">{busy ? t('sec.encrypting') : t('pin.hint')}</p>
    </Modal>
  );
}

/** Password again (when the data key isn't at hand anymore). onProof({ password }). */
export function PasswordProof({ onProof, onClose, text }) {
  const { t } = useStore();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title={t('qu.confirmPw')} onClose={onClose}>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setError('');
        try { await onProof({ password: pw }); } catch (er) { setError(er.code === 'wrong_key' ? t('lock.pwWrong') : t('auth.err.generic')); setBusy(false); }
      }}>
        <p className="sub">{text || t('qu.confirmPwText')}</p>
        <PasswordField label={t('auth.password')} value={pw} onChange={setPw} autoFocus />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary full" disabled={busy || !pw}>{busy ? <><span className="spinner" /> {t('pin.checking')}</> : t('common.confirm')}</button>
      </form>
    </Modal>
  );
}

/** Shown once after signing in on a device: Face ID / fingerprint or a PIN for everyday unlocking. */
export default function QuickUnlockSetup() {
  const { t, updateSettings, setPin, enableBiometric, quickProof, toast, isArtifact, dataKeyFrom } = useStore();
  const [bioOk, setBioOk] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [askPw, setAskPw] = useState(null); // 'pin' | 'bio'
  const [proof, setProof] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!isArtifact) biometricAvailable().then(setBioOk); }, [isArtifact]);
  const getProof = () => proof || quickProof();
  const done = () => updateSettings({ quickUnlockAsked: true });

  const bio = async (p = getProof()) => {
    if (!p) { setAskPw('bio'); return; }
    setBusy(true);
    try { await enableBiometric(p); toast(t('sec.bioOn')); await done(); } catch (e) { toast(e.code === 'prf-unsupported' ? t('sec.bioUnsupported') : t('sec.bioFail'), 'err'); setBusy(false); }
  };

  return (
    <div className="onboarding auth">
      <div className="onb-card">
        <Wally mood="happy" size={80} />
        <h1>{t('qu.title')}</h1>
        <p className="sub">{t('qu.text')}</p>
        {bioOk && <button className="primary full" disabled={busy} onClick={() => bio()}><Fingerprint size={18} /> {t('qu.bio')}</button>}
        <button className={bioOk ? 'secondary full' : 'primary full'} disabled={busy} onClick={() => (getProof() ? setPinOpen(true) : setAskPw('pin'))}><KeyRound size={18} /> {t('qu.pin')}</button>
        <button className="link-btn" onClick={done}>{t('qu.skip')} <ArrowRight size={14} /></button>
        <p className="hint center">{t('qu.note')}</p>
      </div>
      {pinOpen && (
        <PinCreate onClose={() => setPinOpen(false)} onDone={async (p) => { await setPin(p, getProof()); toast(t('pin.saved')); await done(); }} />
      )}
      {askPw && (
        <PasswordProof onClose={() => setAskPw(null)} onProof={async (p) => {
          const checked = { dataKey: await dataKeyFrom(p) }; // wrong password -> error shown in the dialog
          setProof(checked);
          const which = askPw;
          setAskPw(null);
          if (which === 'pin') setPinOpen(true); else await bio(checked);
        }} />
      )}
    </div>
  );
}
