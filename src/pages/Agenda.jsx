import React, { useMemo, useState } from 'react';
import { Check, CalendarClock, CreditCard, Repeat, SkipForward, Clock, CalendarCheck } from 'lucide-react';
import { useStore } from '../store.jsx';
import { PageHead, CatIcon, Empty, relDay } from '../components/Common.jsx';
import { PayInvoiceForm } from '../components/WalletSheets.jsx';
import { monthProjection } from '../lib/ledger.js';
import { addDays } from '../lib/dates.js';
import { formatDate } from '../lib/format.js';

export function AgendaRow({ item, onPayInvoice, compact = false }) {
  const { t, money, lang, markPaid, payRecurring, unpayRecurring, skipRecurring, restoreTxs, openTx, toast, accounts } = useStore();
  const inflow = item.type === 'income' || item.type === 'redeem';
  const accName = (() => {
    const tx = item.tx || item.template;
    if (!tx || item.kind === 'invoice') return '';
    const a = accounts.find((x) => x.id === (tx.accountId || 'main'));
    return a?.name || '';
  })();
  const kindLabel = item.kind === 'invoice' ? t('ag.kind.invoice')
    : item.kind === 'recurring' ? (item.template.autoPay === false ? t('ag.kind.recurringManual') : t('ag.kind.recurringAuto'))
    : t('ag.kind.pending');
  const auto = item.kind === 'recurring' && item.template.autoPay !== false;

  const pay = async () => {
    if (item.kind === 'invoice') return onPayInvoice(item.card, item.invoice);
    if (item.kind === 'pending') {
      const prev = item.tx;
      await markPaid(prev);
      toast(inflow ? t('ag.markedReceived') : t('ag.markedPaid'), 'ok', { label: t('common.undo'), run: () => restoreTxs({ removed: [prev] }) });
      return undefined;
    }
    const tx = await payRecurring(item);
    toast(inflow ? t('ag.markedReceived') : t('ag.markedPaid'), 'ok', { label: t('common.undo'), run: () => unpayRecurring(tx, item) });
    return undefined;
  };
  const skip = async () => {
    await skipRecurring(item);
    toast(t('ag.skipped'), 'ok');
  };
  const open = () => {
    if (item.kind === 'pending') openTx(item.tx);
    else if (item.kind === 'recurring') openTx(item.template);
    else onPayInvoice(item.card, item.invoice);
  };

  return (
    <div className={`ag-row ${item.overdue ? 'overdue' : ''} ${item.today ? 'is-today' : ''}`}>
      <div className="ag-date" aria-hidden="true">
        <b>{Number(item.date.slice(8, 10))}</b>
        <span>{formatDate(item.date, lang, { month: 'short' }).replace('.', '')}</span>
      </div>
      <button className="ag-main" onClick={open}>
        <span className="ag-title">
          {item.kind === 'invoice' ? <span className="mini-ico"><CreditCard size={14} /></span> : <CatIcon category={item.category} size={14} />}
          <b>{item.kind === 'invoice' ? t('ag.invoiceOf', { c: item.description }) : item.description || t(`cat.${item.category}`)}</b>
        </span>
        <small>
          {item.overdue ? <em className="late">{t('ag.lateBy', { d: relDay(item.date, t) })}</em> : relDay(item.date, t)}
          {' · '}{kindLabel}{accName && !compact ? ` · ${accName}` : ''}
        </small>
      </button>
      <div className="ag-right">
        <strong className={inflow ? 'positive' : ''}>{inflow ? '+' : '−'}{money(item.amount)}</strong>
        <div className="ag-actions">
          {item.kind === 'recurring' && !compact && (
            <button className="icon-btn sm" onClick={skip} title={t('ag.skip')} aria-label={t('ag.skip')}><SkipForward size={15} /></button>
          )}
          {auto ? (
            <span className="badge"><Repeat size={11} /> {t('ag.auto')}</span>
          ) : (
            <button className="pay-btn" onClick={pay}><Check size={14} /> {item.kind === 'invoice' ? t('inv.pay') : inflow ? t('ag.receive') : t('ag.pay')}</button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Agenda() {
  const { ledger, accounts, txs, cards, t, money, openTx } = useStore();
  const [filter, setFilter] = useState('all');
  const [paying, setPaying] = useState(null);
  const today = ledger.today;
  const proj = useMemo(() => monthProjection({ accounts, txs, cards }, today), [accounts, txs, cards, today]);
  const items = ledger.agenda.filter((i) => filter === 'all' || (filter === 'in' ? i.type === 'income' || i.type === 'redeem' : !(i.type === 'income' || i.type === 'redeem')));
  const week = addDays(today, 7);
  const groups = [
    { key: 'overdue', title: t('ag.g.overdue'), items: items.filter((i) => i.overdue) },
    { key: 'today', title: t('ag.g.today'), items: items.filter((i) => i.today) },
    { key: 'week', title: t('ag.g.week'), items: items.filter((i) => i.date > today && i.date <= week) },
    { key: 'later', title: t('ag.g.later'), items: items.filter((i) => i.date > week) },
  ].filter((g) => g.items.length);

  return (
    <div className="page agenda">
      <PageHead title={t('ag.title')} sub={t('ag.sub')}>
        <button className="secondary slim" onClick={() => openTx({ type: 'expense', status: 'pending', date: addDays(today, 1) })}><CalendarClock size={16} /> {t('ag.schedule')}</button>
      </PageHead>

      <section className="proj">
        <div><span>{t('ag.cashNow')}</span><b>{money(proj.cash)}</b></div>
        <div><span>{t('ag.toPayMonth')}</span><b className="neg-red">−{money(proj.toPay)}</b></div>
        <div><span>{t('ag.toReceiveMonth')}</span><b className="positive">+{money(proj.toReceive)}</b></div>
        <div className="proj-total"><span>{t('ag.projected')}</span><b className={proj.projected < 0 ? 'neg-red' : ''}>{money(proj.projected)}</b></div>
      </section>

      <div className="chips">
        {['all', 'out', 'in'].map((k) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{t(`ag.f.${k}`)}</button>)}
      </div>

      {groups.length ? groups.map((g) => (
        <section key={g.key} className={`panel ag-group ${g.key}`}>
          <div className="panel-head">
            <h2>{g.key === 'overdue' ? <Clock size={16} /> : null}{g.title}</h2>
            <span className="muted">{money(g.items.reduce((s, i) => s + (i.type === 'income' || i.type === 'redeem' ? i.amount : -i.amount), 0), { sign: true })}</span>
          </div>
          {g.items.map((i) => <AgendaRow key={i.key} item={i} onPayInvoice={(card, inv) => setPaying({ card, inv })} />)}
        </section>
      )) : (
        <Empty icon={CalendarCheck} text={t('ag.empty')} action={t('ag.schedule')} onAction={() => openTx({ type: 'expense', status: 'pending', date: addDays(today, 1) })} />
      )}
      <p className="hint center">{t('ag.footer')}</p>
      {paying && <PayInvoiceForm card={paying.card} inv={paying.inv} onClose={() => setPaying(null)} />}
    </div>
  );
}
