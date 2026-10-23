import React, { useState } from 'react';
import {
  Repeat, TrendingUp, Copy, Sparkles, BellRing, BellOff, Ban, Check, CircleSlash, ChevronDown, ChevronUp, CreditCard, Wallet, RotateCcw,
} from 'lucide-react';
import { useStore } from '../store.jsx';
import { PageHead, CatIcon, Empty } from '../components/Common.jsx';
import Modal from '../components/Modal.jsx';
import { formatDate } from '../lib/format.js';

/** Subscription hunter: everything the person pays again and again, found in their own data. */
export default function Subscriptions({ go }) {
  const { subs, t, money, lang, ledger } = useStore();
  const [open, setOpen] = useState(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const day = (iso) => formatDate(iso, lang, { day: 'numeric', month: 'short' });
  const row = (s) => (
    <button key={s.key} className={`sub-row ${s.increased || s.duplicate ? 'hot' : ''}`} onClick={() => setOpen(s)}>
      <CatIcon category={s.category} size={18} />
      <span className="sub-main">
        <b>{s.name}</b>
        <small>
          {s.stale ? t('subs.lastOn', { d: day(s.last) }) : s.next < ledger.today ? t('subs.expectedOn', { d: day(s.next) }) : s.cadence === 'yearly' ? t('subs.yearlyOn', { d: day(s.next) }) : t('subs.nextOn', { d: day(s.next) })}
          {s.increased && <em className="tag up"><TrendingUp size={11} /> +{s.increased.pct}%</em>}
          {s.duplicate && <em className="tag dup"><Copy size={11} /> {t('subs.double')}</em>}
          {s.isNew && s.status !== 'confirmed' && !s.increased && !s.duplicate && <em className="tag new"><Sparkles size={11} /> {t('subs.new')}</em>}
          {s.remind && <BellRing size={12} className="bell" />}
        </small>
      </span>
      <span className="sub-amount"><b>{money(s.amount)}</b><small>{s.cadence === 'yearly' ? t('subs.perYear') : t('subs.perMonth')}</small></span>
    </button>
  );
  const empty = !subs.list.length;
  return (
    <div className="page subs-page">
      <PageHead title={t('subs.title')} sub={t('subs.sub')} />
      {empty ? (
        <Empty icon={Repeat} text={t('subs.empty')} action={t('nav.import')} onAction={() => go('import')} />
      ) : (
        <>
          <section className="subs-hero">
            <div><span>{t('subs.monthTotal')}</span><b>{money(subs.monthly)}</b><small>{t('subs.yearTotal', { v: money(subs.yearly) })}</small></div>
            <div><span>{t('subs.count')}</span><b>{subs.services.length}</b><small>{subs.attention.length ? t('subs.attention', { n: subs.attention.length }) : t('subs.allGood')}</small></div>
          </section>
          {subs.services.length > 0 && (
            <section className="panel">
              <div className="panel-head"><h2><Repeat size={16} /> {t('subs.services')}</h2></div>
              {subs.services.map(row)}
            </section>
          )}
          {subs.bills.length > 0 && (
            <section className="panel">
              <div className="panel-head"><h2>{t('subs.bills')}</h2><span className="muted">{t('subs.billsTotal', { v: money(subs.billsMonthly) })}</span></div>
              {subs.bills.map(row)}
            </section>
          )}
          {subs.stopped.length > 0 && (
            <section className="panel">
              <div className="panel-head"><h2><CircleSlash size={16} /> {t('subs.stopped')}</h2></div>
              <p className="muted">{t('subs.stoppedText')}</p>
              {subs.stopped.map(row)}
            </section>
          )}
          {subs.ignored.length > 0 && (
            <button className="link-btn" onClick={() => setShowIgnored(!showIgnored)}>
              {showIgnored ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {t('subs.hidden', { n: subs.ignored.length })}
            </button>
          )}
          {showIgnored && <section className="panel">{subs.ignored.map(row)}</section>}
          <p className="hint center">{t('subs.privacy')}</p>
        </>
      )}
      {open && <SubSheet sub={subs.list.find((s) => s.key === open.key) || open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function SubSheet({ sub, onClose }) {
  const { t, money, lang, setSubPref, cards, accounts, toast } = useStore();
  const day = (iso) => formatDate(iso, lang, { day: 'numeric', month: 'short', year: 'numeric' });
  const where = sub.cardId ? cards.find((c) => c.id === sub.cardId) : accounts.find((a) => a.id === (sub.accountId || 'main'));
  const set = async (patch, msg) => { await setSubPref(sub.key, patch); if (msg) toast(msg); };
  return (
    <Modal title={sub.name} onClose={onClose}>
      <div className="sub-sheet-top">
        <b>{money(sub.amount)}</b>
        <span>{sub.cadence === 'yearly' ? t('subs.perYear') : t('subs.perMonth')} · {t('subs.inYear', { v: money(sub.yearly) })}</span>
      </div>
      {sub.increased && <p className="sub-note up"><TrendingUp size={15} /> {t('subs.upText', { a: money(sub.increased.from), b: money(sub.increased.to), p: sub.increased.pct })}</p>}
      {sub.duplicate && <p className="sub-note dup"><Copy size={15} /> {t('subs.dupText', { d: day(sub.duplicate.date), v: money(sub.duplicate.amount) })}</p>}
      {sub.stale && <p className="sub-note"><CircleSlash size={15} /> {t('subs.staleText', { d: day(sub.last) })}</p>}
      <ul className="sub-facts">
        <li><span>{t('subs.next')}</span><b>{sub.stale ? '—' : day(sub.next)}</b></li>
        <li><span>{t('subs.since')}</span><b>{day(sub.first)}</b></li>
        {where && <li><span>{t('subs.paidWith')}</span><b>{sub.cardId ? <CreditCard size={13} /> : <Wallet size={13} />} {where.name}</b></li>}
      </ul>
      <h3 className="sub-title">{t('subs.history')}</h3>
      <div className="sub-history">
        {[...sub.charges].reverse().slice(0, 12).map((c) => <div key={c.id}><span>{day(c.date)}</span><b>{money(c.amount)}</b></div>)}
      </div>
      <div className="btn-col">
        {sub.status === 'active' || sub.status === 'confirmed' ? (
          <>
            <button className="secondary" onClick={() => set({ remind: !sub.remind }, sub.remind ? t('subs.remindOff') : t('subs.remindOn'))}>
              {sub.remind ? <><BellOff size={16} /> {t('subs.noRemind')}</> : <><BellRing size={16} /> {t('subs.remind')}</>}
            </button>
            {sub.isNew && sub.status !== 'confirmed' && <button className="secondary" onClick={() => set({ status: 'confirmed' }, t('subs.confirmed'))}><Check size={16} /> {t('subs.itsMine')}</button>}
            <button className="secondary" onClick={() => { set({ status: 'cancelled', remind: false }, t('subs.cancelledMsg')); onClose(); }}><Ban size={16} /> {t('subs.cancelled')}</button>
            <button className="ghost" onClick={() => { set({ status: 'ignored', remind: false }, t('subs.ignoredMsg')); onClose(); }}><CircleSlash size={16} /> {t('subs.notSub')}</button>
          </>
        ) : (
          <button className="secondary" onClick={() => set({ status: 'active' }, t('subs.restored'))}><RotateCcw size={16} /> {t('subs.restore')}</button>
        )}
      </div>
      <p className="hint">{t('subs.cancelHint')}</p>
    </Modal>
  );
}
