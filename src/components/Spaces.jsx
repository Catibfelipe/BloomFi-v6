import React, { useEffect, useState } from 'react';
import { Users, User, Layers, X, ChevronRight, ShieldCheck } from 'lucide-react';
import { useStore } from '../store.jsx';
import Modal from './Modal.jsx';

/** Words for what went wrong with a space action. */
export function spaceError(t, e) {
  const k = `sp.err.${e?.code}`;
  const v = t(k);
  if (v !== k) return v;
  return e?.code === 'offline' || e?.code === 'no_server' ? t('sp.err.offline') : t('sp.err.generic');
}

/** Small label "🏠 Casa" on things that are shared. */
export function SpaceTag({ id }) {
  const { spaces } = useStore();
  const sp = id && spaces.list.find((x) => x.id === id);
  if (!sp) return null;
  return <em className="space-tag" title={sp.name}><span aria-hidden>{sp.emoji}</span> {sp.name}</em>;
}

/** "Quem vê": only the person, or one of their spaces. Hidden when they have no space. */
export function ShareField({ value, onChange, disabled = false, hint }) {
  const { t, spaces } = useStore();
  const usable = spaces.list.filter((s) => s.ok);
  if (!usable.length) return null;
  return (
    <div className="field share-field" role="group" aria-label={t('sp.shareWith')}>
      {t('sp.shareWith')}
      <div className="chips">
        <button type="button" className={!value ? 'on' : ''} aria-pressed={!value} onClick={() => onChange(null)} disabled={disabled}><User size={14} /> {t('sp.onlyMe')}</button>
        {usable.map((s) => (
          <button type="button" key={s.id} className={value === s.id ? 'on' : ''} aria-pressed={value === s.id} onClick={() => onChange(s.id)} disabled={disabled}>
            <span aria-hidden>{s.emoji}</span> {s.name}
          </button>
        ))}
      </div>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

/** Where a new record goes by default: the space being viewed, or the person's own. */
export function useDefaultSpace() {
  const { scope, spaces } = useStore();
  return scope !== 'all' && scope !== 'me' && spaces.list.some((s) => s.id === scope && s.ok) ? scope : null;
}

/** The view picker: everything, only mine, or one space. Only shown to people in a space. */
export function ScopeBar() {
  const { t, spaces, scope, setScope, hasSpaces } = useStore();
  if (!hasSpaces) return null;
  const opts = [['all', <Layers key="i" size={14} />, t('sp.scope.all')], ['me', <User key="i" size={14} />, t('sp.scope.me')],
    ...spaces.list.filter((s) => s.ok).map((s) => [s.id, <span key="i" aria-hidden>{s.emoji}</span>, s.name])];
  return (
    <div className="scope-bar" role="group" aria-label={t('sp.scopeLabel')}>
      {opts.map(([k, icon, label]) => (
        <button key={k} className={scope === k ? 'on' : ''} aria-pressed={scope === k} onClick={() => setScope(k)}>{icon} {label}</button>
      ))}
    </div>
  );
}

/** Someone asked to join a space this person owns. */
export function SpaceRequestsBanner({ go }) {
  const { t, spaces } = useStore();
  const req = spaces.list.flatMap((s) => (s.role === 'owner' ? s.requests.map((r) => ({ r, s })) : []))[0];
  if (!req) return null;
  return (
    <button className="space-banner" onClick={() => go('space')}>
      <Users size={18} />
      <span>{t('sp.requestBanner', { n: req.r.name || t('sp.someone'), s: `${req.s.emoji} ${req.s.name}` })}</span>
      <b>{t('sp.see')} <ChevronRight size={15} /></b>
    </button>
  );
}

/** Opened from an invite link (…/app/#join=…): who invited, which space, and the request to join. */
export function JoinSheet() {
  const { t, invite, peekInvite, joinSpace, dismissInvite, toast } = useStore();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setInfo(null); setError('');
    if (invite) peekInvite(invite).then((r) => alive && setInfo(r)).catch((e) => alive && setError(e?.code === 'invite_invalid' || e?.code === 'wrong_key' ? t('sp.joinBad') : spaceError(t, e)));
    return () => { alive = false; };
  }, [invite]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!invite) return null;
  const join = async () => {
    setBusy(true);
    try {
      const r = await joinSpace(invite);
      toast(r.joined ? t('sp.joinRenewed') : t('sp.joinSent', { o: info?.ownerName || '' }));
      window.location.hash = 'space';
    } catch (e) {
      setError(e?.code === 'invite_invalid' ? t('sp.joinBad') : spaceError(t, e));
    } finally { setBusy(false); }
  };
  return (
    <Modal title={t('sp.joinTitle')} onClose={dismissInvite}>
      {!info && !error && <p className="muted"><span className="spinner" /> {t('sp.joinLoading')}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {info && (
        <>
          <div className="join-hero">
            <span className="join-emoji" aria-hidden>{info.emoji}</span>
            <p>{t('sp.joinText', { o: info.ownerName || t('sp.someone'), e: '', n: info.name, m: t('sp.people', { n: info.members }) })}</p>
          </div>
          {info.already ? <p className="hint">{t('sp.joinAlready')}</p> : <p className="hint">{t('sp.joinWhat')}</p>}
          <p className="hint"><ShieldCheck size={14} /> {t('sp.hero3')}</p>
        </>
      )}
      <div className="btn-col">
        {info && <button className="primary" disabled={busy} onClick={join}><Users size={17} /> {info.already ? t('sp.continue') : t('sp.joinBtn')}</button>}
        <button className="ghost" onClick={dismissInvite}><X size={16} /> {error ? t('common.close') : t('sp.notNow')}</button>
      </div>
    </Modal>
  );
}
