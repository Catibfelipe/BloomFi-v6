import React, { useMemo, useState } from 'react';
import {
  Users, UserPlus, Link2, Copy, Share2, Check, X, LogOut, Trash2, Pencil, Crown, ShieldCheck, Lock, Clock, Landmark,
  CreditCard, Target, PieChart, UserMinus, Ticket,
} from 'lucide-react';
import { useStore } from '../store.jsx';
import { PageHead, CatIcon } from '../components/Common.jsx';
import Modal, { Confirm } from '../components/Modal.jsx';
import { spaceError } from '../components/Spaces.jsx';
import { formatDate } from '../lib/format.js';
import { DEFAULT_ACCOUNT_ID } from '../lib/ledger.js';

const EMOJIS = ['🏠', '💑', '👨‍👩‍👧', '👨‍👩‍👧‍👦', '🐾', '✈️', '🌱', '💼'];

/** Family & couple: shared spaces, each person with their own login. */
export default function Space({ go }) {
  const { t, spaces, serverMode, isArtifact } = useStore();
  const [create, setCreate] = useState(false);
  const [paste, setPaste] = useState(false);
  if (!serverMode || isArtifact) {
    return (
      <div className="page space-page">
        <PageHead title={t('sp.title')} sub={t('sp.sub')} />
        <Hero />
      </div>
    );
  }
  const none = !spaces.list.length && !spaces.waiting.length;
  return (
    <div className="page space-page">
      <PageHead title={t('sp.title')} sub={t('sp.sub')} />
      {none && <Hero onCreate={() => setCreate(true)} onPaste={() => setPaste(true)} />}
      {spaces.waiting.map((w) => <Waiting key={w.id} w={w} />)}
      {spaces.list.map((s) => <SpaceCard key={s.id} sp={s} max={spaces.max} go={go} />)}
      {!none && spaces.list.length + spaces.waiting.length < 3 && (
        <div className="space-more">
          <button className="ghost" onClick={() => setCreate(true)}><Users size={16} /> {t('sp.create')}</button>
          <button className="ghost" onClick={() => setPaste(true)}><Ticket size={16} /> {t('sp.haveInvite')}</button>
        </div>
      )}
      {create && <CreateSpace onClose={() => setCreate(false)} />}
      {paste && <PasteInvite onClose={() => setPaste(false)} />}
    </div>
  );
}

function Hero({ onCreate, onPaste }) {
  const { t } = useStore();
  return (
    <section className="space-hero">
      <div className="space-hero-emoji" aria-hidden>👨‍👩‍👧</div>
      <h2>{t('sp.heroTitle')}</h2>
      <ul>
        <li><Users size={17} /><span>{t('sp.hero1')}</span></li>
        <li><Lock size={17} /><span>{t('sp.hero2')}</span></li>
        <li><ShieldCheck size={17} /><span>{t('sp.hero3')}</span></li>
      </ul>
      {onCreate && (
        <div className="btn-col">
          <button className="primary" onClick={onCreate}><Users size={18} /> {t('sp.create')}</button>
          <button className="secondary" onClick={onPaste}><Ticket size={17} /> {t('sp.haveInvite')}</button>
        </div>
      )}
    </section>
  );
}

function CreateSpace({ onClose }) {
  const { t, createSpace, toast } = useStore();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🏠');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError('');
    try { await createSpace({ name: name.trim(), emoji }); toast(t('sp.created')); onClose(); } catch (er) { setError(spaceError(t, er)); setBusy(false); }
  };
  return (
    <Modal title={t('sp.createTitle')} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>{t('sp.name')}<input autoFocus value={name} maxLength={40} placeholder={t('sp.namePh')} onChange={(e) => setName(e.target.value)} /></label>
        <div className="field" role="group" aria-label={t('sp.icon')}>{t('sp.icon')}
          <div className="emoji-row">
            {EMOJIS.map((em) => <button type="button" key={em} className={emoji === em ? 'on' : ''} aria-pressed={emoji === em} onClick={() => setEmoji(em)}>{em}</button>)}
          </div>
        </div>
        <p className="hint"><ShieldCheck size={14} /> {t('sp.hero3')}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary full" disabled={busy || !name.trim()}>{busy ? <span className="spinner" /> : <Users size={17} />} {t('sp.createBtn')}</button>
      </form>
    </Modal>
  );
}

function PasteInvite({ onClose }) {
  const { t, acceptInviteText } = useStore();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const submit = (e) => {
    e.preventDefault();
    if (acceptInviteText(text)) onClose(); else setError(t('sp.pasteBad'));
  };
  return (
    <Modal title={t('sp.pasteTitle')} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="hint">{t('sp.pasteText')}</p>
        <textarea className="textbox short" autoFocus value={text} onChange={(e) => { setText(e.target.value); setError(''); }} placeholder={t('sp.pastePh')} />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary full" disabled={!text.trim()}>{t('sp.continue')}</button>
      </form>
    </Modal>
  );
}

function Waiting({ w }) {
  const { t, cancelJoin, toast } = useStore();
  const [busy, setBusy] = useState(false);
  return (
    <section className="panel space-waiting">
      <h3><Clock size={17} /> {t('sp.waitingTitle')}</h3>
      <p className="muted">{t('sp.waitingText', { o: w.ownerName || t('sp.someone'), s: w.name ? t('sp.waitingIn', { e: w.emoji, n: w.name }) : '' })}</p>
      <button className="ghost small" disabled={busy} onClick={async () => { setBusy(true); try { await cancelJoin(w.id); } catch (e) { toast(spaceError(t, e), 'err'); } setBusy(false); }}>
        <X size={15} /> {t('sp.cancelReq')}
      </button>
    </section>
  );
}

function SpaceCard({ sp, max, go }) {
  const store = useStore();
  const {
    t, lang, all, myId, approveMember, removeMember, leaveSpace, deleteSpace, inviteToSpace, cancelInvite, toast, serverCfg,
  } = store;
  const owner = sp.role === 'owner';
  const [ask, setAsk] = useState(null); // { kind: 'remove'|'leave'|'delete', member? }
  const [link, setLink] = useState(null);
  const [pick, setPick] = useState(false);
  const [rename, setRename] = useState(false);
  const [busy, setBusy] = useState('');
  const day = (s) => formatDate(new Date(s * 1000).toISOString().slice(0, 10), lang, { day: 'numeric', month: 'short', year: 'numeric' });
  const run = async (key, fn, ok) => {
    setBusy(key);
    try { await fn(); if (ok) toast(ok); } catch (e) { toast(spaceError(t, e), 'err'); }
    setBusy('');
  };
  const shared = useMemo(() => ({
    accounts: all.accounts.filter((x) => x.space === sp.id && !x.archived),
    cards: all.cards.filter((x) => x.space === sp.id && !x.archived),
    goals: all.goals.filter((x) => x.space === sp.id),
    budgets: all.budgets.filter((x) => x.space === sp.id),
  }), [all, sp.id]);
  const nShared = shared.accounts.length + shared.cards.length + shared.goals.length + shared.budgets.length;
  const billing = serverCfg?.billing?.enabled;
  const full = sp.members.length >= max;
  const ownerName = sp.members.find((m) => m.role === 'owner')?.name || '';

  if (!sp.ok) {
    return (
      <section className="panel space-card">
        <div className="space-head"><span className="space-emoji" aria-hidden>{sp.emoji}</span><div><h2>{sp.name || '…'}</h2></div></div>
        <p className="sub-note"><Lock size={15} /> {t('sp.stale')}</p>
        {!owner && <button className="ghost small" onClick={() => setAsk({ kind: 'leave' })}><LogOut size={15} /> {t('sp.leave')}</button>}
        {ask && <SpaceConfirm sp={sp} ask={ask} onClose={() => setAsk(null)} />}
      </section>
    );
  }

  return (
    <section className="panel space-card" style={{ '--c': sp.color }}>
      <div className="space-head">
        <span className="space-emoji" aria-hidden>{sp.emoji}</span>
        <div>
          <h2>{sp.name}</h2>
          <p className="muted">{t('sp.people', { n: sp.members.length })} · {owner ? t('sp.owner') : ownerName}</p>
        </div>
        {owner && <button className="icon-btn" onClick={() => setRename(true)} aria-label={t('sp.rename')} title={t('sp.rename')}><Pencil size={16} /></button>}
      </div>

      {owner && sp.requests.length > 0 && (
        <div className="space-requests">
          <h3>{t('sp.requests')}</h3>
          {sp.requests.map((r) => (
            <div key={r.id} className="space-req">
              <div className="space-req-who">
                <span className="mavatar">{(r.name || '?').slice(0, 1).toUpperCase()}</span>
                <span className="who"><b>{r.name || t('sp.someone')}</b><small>{r.email} · {t('sp.wants')}</small></span>
              </div>
              <div className="space-req-actions">
                <button className="ghost small" disabled={!!busy} onClick={() => run(`no:${r.id}`, () => approveMember(sp.id, r.id, false), t('sp.refused'))}>{t('sp.refuse')}</button>
                <button className="primary small" disabled={!!busy || full} onClick={() => run(`ok:${r.id}`, () => approveMember(sp.id, r.id, true), t('sp.approved', { n: r.name }))}><Check size={15} /> {t('sp.approve')}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 className="space-sub">{t('sp.members')}</h3>
      <ul className="space-members">
        {sp.members.map((m) => (
          <li key={m.id}>
            <span className="mavatar">{(m.name || '?').slice(0, 1).toUpperCase()}</span>
            <span className="who">
              <b>{m.name || t('sp.someone')}{m.id === myId && <em className="pill-on">{t('sp.you')}</em>}</b>
              <small>{m.role === 'owner' ? <><Crown size={11} /> {t('sp.owner')}</> : t('sp.since', { d: day(m.joinedAt) })}</small>
            </span>
            {owner && m.id !== myId && (
              <button className="icon-btn" onClick={() => setAsk({ kind: 'remove', member: m })} aria-label={t('sp.remove')} title={t('sp.remove')}><UserMinus size={16} /></button>
            )}
          </li>
        ))}
      </ul>
      {owner && (
        full ? <p className="hint">{t('sp.full', { n: max })}</p> : (
          <button className="secondary full" disabled={busy === 'invite'} onClick={() => run('invite', async () => setLink(await inviteToSpace(sp.id)))}>
            <UserPlus size={17} /> {t('sp.invite')}
          </button>
        )
      )}
      {owner && sp.invites.length > 0 && (
        <div className="space-invites">
          <small className="muted">{t('sp.openInvites')}</small>
          {sp.invites.map((i) => (
            <div key={i.id} className="space-invite"><Link2 size={14} /> <span>{t('sp.inviteUntil', { d: day(i.exp) })}</span>
              <button className="link-btn" onClick={() => run(`ci:${i.id}`, () => cancelInvite(sp.id, i.id), t('sp.inviteCanceled'))}>{t('sp.cancelInvite')}</button>
            </div>
          ))}
        </div>
      )}

      <h3 className="space-sub">{t('sp.shared')}</h3>
      {nShared ? (
        <div className="space-shared">
          {[['accounts', Landmark], ['cards', CreditCard], ['goals', Target], ['budgets', PieChart]].map(([k, Icon]) => shared[k].map((x) => (
            <span key={`${k}:${x.id}`} className="space-chip">
              {k === 'budgets' ? <CatIcon category={x.category} size={13} /> : k === 'goals' ? <span aria-hidden>{x.emoji || '🎯'}</span> : <Icon size={14} />}
              {k === 'budgets' ? t(`cat.${x.category}`) : x.name || x.title}
              {x.sharedBy && x.sharedBy !== myId && <small>{t('sp.sharedBy', { n: store.memberName(x.sharedBy) || t('sp.someone') })}</small>}
            </span>
          )))}
        </div>
      ) : <p className="muted">{t('sp.sharedNone')}</p>}
      <button className="secondary full" onClick={() => setPick(true)}><Share2 size={16} /> {t('sp.pick')}</button>

      {billing && <p className="hint own-plan"><Crown size={13} /> {t('sp.ownPlan')}</p>}

      <div className="space-foot">
        {owner
          ? <button className="link-btn danger" onClick={() => setAsk({ kind: 'delete' })}><Trash2 size={14} /> {t('sp.delete')}</button>
          : <button className="link-btn danger" onClick={() => setAsk({ kind: 'leave' })}><LogOut size={14} /> {t('sp.leave')}</button>}
      </div>

      {ask && <SpaceConfirm sp={sp} ask={ask} onClose={() => setAsk(null)} />}
      {link && <InviteLink sp={sp} link={link} onClose={() => setLink(null)} />}
      {pick && <PickShared sp={sp} onClose={() => setPick(false)} />}
      {rename && <RenameSpace sp={sp} onClose={() => setRename(false)} />}
    </section>
  );
}

function SpaceConfirm({ sp, ask, onClose }) {
  const { t, removeMember, leaveSpace, deleteSpace, toast } = useStore();
  const n = ask.member?.name || t('sp.someone');
  const cfg = {
    remove: { title: t('sp.removeTitle', { n }), text: t('sp.removeText', { n }), label: t('sp.remove'), run: () => removeMember(sp.id, ask.member.id), ok: t('sp.removed', { n }) },
    leave: { title: t('sp.leaveTitle', { n: `${sp.emoji} ${sp.name}` }), text: t('sp.leaveText'), label: t('sp.leave'), run: () => leaveSpace(sp.id), ok: t('sp.left') },
    delete: { title: t('sp.deleteTitle', { n: `${sp.emoji} ${sp.name}` }), text: t('sp.deleteText'), label: t('sp.delete'), run: () => deleteSpace(sp.id), ok: t('sp.deleted') },
  }[ask.kind];
  return (
    <Confirm title={cfg.title} text={cfg.text} danger confirmLabel={cfg.label} cancelLabel={t('common.cancel')} onClose={onClose}
      onConfirm={async () => { try { await cfg.run(); toast(cfg.ok); } catch (e) { toast(spaceError(t, e), 'err'); } }} />
  );
}

function InviteLink({ sp, link, onClose }) {
  const { t, toast } = useStore();
  const msg = t('sp.shareMsg', { n: `${sp.emoji} ${sp.name}`, l: link.link });
  const copy = async () => {
    try { await navigator.clipboard.writeText(link.link); toast(t('sp.copied')); } catch { /* the text is selectable below */ }
  };
  const share = async () => {
    try { await navigator.share({ title: 'BloomFi', text: msg }); } catch (e) { if (e?.name !== 'AbortError') copy(); }
  };
  return (
    <Modal title={t('sp.inviteTitle')} onClose={onClose}>
      <p className="hint">{t('sp.inviteText')}</p>
      <input className="invite-link" readOnly value={link.link} onFocus={(e) => e.target.select()} aria-label={t('sp.inviteTitle')} />
      <div className="btn-col">
        {typeof navigator !== 'undefined' && navigator.share && <button className="primary" onClick={share}><Share2 size={17} /> {t('sp.share')}</button>}
        <button className={navigator.share ? 'secondary' : 'primary'} onClick={copy}><Copy size={16} /> {t('sp.copy')}</button>
      </div>
    </Modal>
  );
}

function RenameSpace({ sp, onClose }) {
  const { t, renameSpace, toast } = useStore();
  const [name, setName] = useState(sp.name);
  const [emoji, setEmoji] = useState(sp.emoji);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={t('sp.renameTitle')} onClose={onClose}>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true);
        try { await renameSpace(sp.id, { name: name.trim(), emoji, color: sp.color }); toast(t('sp.renamed')); onClose(); } catch (er) { toast(spaceError(t, er), 'err'); setBusy(false); }
      }}>
        <label>{t('sp.name')}<input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
        <div className="emoji-row">{EMOJIS.map((em) => <button type="button" key={em} className={emoji === em ? 'on' : ''} onClick={() => setEmoji(em)}>{em}</button>)}</div>
        <button className="primary full" disabled={busy || !name.trim()}>{t('common.save')}</button>
      </form>
    </Modal>
  );
}

/** Ticks what goes into the space (and what comes back to being only the person's). */
function PickShared({ sp, onClose }) {
  const { t, all, myId, shareRecord, toast } = useStore();
  const [busy, setBusy] = useState('');
  // What this person can move: their own records, and the shared records they shared themselves (or, as owner, any).
  const mine = (x) => !x.space || (x.space === sp.id && (sp.role === 'owner' || !x.sharedBy || x.sharedBy === myId));
  const groups = [
    ['accounts', Landmark, all.accounts.filter((a) => !a.archived && a.id !== DEFAULT_ACCOUNT_ID && mine(a)), (a) => a.name],
    ['cards', CreditCard, all.cards.filter((c) => !c.archived && mine(c)), (c) => c.name],
    ['goals', Target, all.goals.filter(mine), (g) => `${g.emoji || '🎯'} ${g.title}`],
    ['budgets', PieChart, all.budgets.filter(mine), (b) => t(`cat.${b.category}`)],
  ].filter(([, , list]) => list.length);
  const toggle = async (store, rec) => {
    const on = rec.space === sp.id;
    setBusy(`${store}:${rec.id}`);
    try {
      await shareRecord(store, rec, on ? null : sp.id);
      toast(on ? t('sp.unsharedToast') : t('sp.sharedToast', { n: `${sp.emoji} ${sp.name}` }));
    } catch (e) { toast(spaceError(t, e), 'err'); }
    setBusy('');
  };
  return (
    <Modal title={t('sp.pickTitle', { e: sp.emoji, n: sp.name })} onClose={onClose}>
      <p className="hint">{t('sp.pickText')}</p>
      {!groups.length && <p className="muted">{t('sp.nothingToShare')}</p>}
      {groups.map(([store, Icon, list, label]) => (
        <div key={store} className="pick-group">
          <h3><Icon size={15} /> {t(`sp.kind.${store}`)}</h3>
          {list.map((rec) => {
            const on = rec.space === sp.id;
            const other = rec.space && rec.space !== sp.id;
            return (
              <button key={rec.id} type="button" className={`toggle compact pick-row ${on ? 'on' : ''}`} aria-pressed={on} disabled={!!busy || other} onClick={() => toggle(store, rec)}>
                <span>{label(rec)}</span><i aria-hidden />
              </button>
            );
          })}
        </div>
      ))}
      <p className="hint">{t('sp.mainAccount')}</p>
    </Modal>
  );
}
