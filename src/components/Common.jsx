import React from 'react';
import { ChevronLeft, ChevronRight, Repeat, Download, Clock, Smartphone, Users } from 'lucide-react';
import { useStore } from '../store.jsx';
import { getCategory } from '../lib/categories.js';
import { addMonths, currentMonth, todayISO } from '../lib/dates.js';
import { formatMonth, formatDate } from '../lib/format.js';
import { DEFAULT_ACCOUNT_ID } from '../lib/ledger.js';

export function CatIcon({ category, size = 20 }) {
  const c = getCategory(category);
  const Icon = c.icon;
  return <div className="cat-icon" style={{ '--c': c.color }}><Icon size={size} /></div>;
}

export function MonthSwitcher({ value, onChange, max }) {
  const store = useStore();
  const month = value ?? store.month;
  const setMonth = onChange ?? store.setMonth;
  const limit = max === undefined ? currentMonth() : max;
  const atEnd = limit && month >= limit;
  return (
    <div className="month-switch">
      <button onClick={() => setMonth(addMonths(month, -1))} aria-label={store.t('common.prev')}><ChevronLeft size={18} /></button>
      <button className="label" onClick={() => setMonth(limit || currentMonth())} disabled={month === (limit || currentMonth())}>{formatMonth(month, store.lang)}</button>
      <button onClick={() => setMonth(addMonths(month, 1))} aria-label={store.t('common.fwd')} disabled={atEnd}><ChevronRight size={18} /></button>
    </div>
  );
}

/** Where a transaction moves money: account / card names. */
export function useWhere() {
  const { accounts, cards } = useStore();
  const acc = (id) => accounts.find((a) => a.id === (id || DEFAULT_ACCOUNT_ID));
  const card = (id) => cards.find((c) => c.id === id);
  return (tx) => {
    const from = tx.cardId ? card(tx.cardId) : acc(tx.accountId);
    const to = tx.type === 'transfer' ? (tx.toCardId ? card(tx.toCardId) : acc(tx.toAccountId)) : null;
    return { from, to };
  };
}

export function TxRow({ tx, hideDate = false, hidePlace = false }) {
  const { money, openTx, t, lang, assets, activeAccounts, activeCards, myId, memberName } = useStore();
  const where = useWhere()(tx);
  // A shared entry added by someone else: "por Bia"; their own account (not shared with me): "conta de Bia".
  const other = tx.space && tx.by && tx.by !== myId ? memberName(tx.by) || t('sp.someone') : '';
  const theirs = other ? t('sp.accountOf', { n: other }) : '—';
  const multi = activeAccounts.length + activeCards.length > 1;
  const inflow = tx.type === 'income' || tx.type === 'redeem';
  const pending = tx.status === 'pending';
  const asset = tx.assetId ? assets.find((a) => a.id === tx.assetId) : null;
  let label;
  if (tx.type === 'transfer') label = tx.toCardId ? t('tx.invoicePayment') : t('txtype.transfer');
  else if (tx.type === 'invest' || tx.type === 'redeem') label = `${t(`txtype.${tx.type}`)}${asset ? ` · ${asset.name}` : ''}`;
  else label = t(`cat.${tx.category}`);
  const place = tx.type === 'transfer'
    ? (where.to ? `${where.from?.name || theirs} → ${where.to.name}` : where.from ? (other ? `${where.from.name} → ${theirs}` : where.from.name) : '')
    : multi && where.from && !hidePlace ? where.from.name : '';
  const meta = [!hideDate && formatDate(tx.date, lang, { day: 'numeric', month: 'short' }), label, place, other && t('sp.by', { n: other })].filter(Boolean).join(' · ');
  const tone = tx.type === 'transfer' ? 'neutral' : tx.type === 'invest' ? 'invest-out' : inflow ? 'positive' : 'negative';
  const sign = tx.type === 'transfer' ? '' : inflow ? '+' : '−';
  return (
    <button className={`tx ${pending ? 'is-pending' : ''}`} onClick={() => openTx(tx)}>
      <div className="tx-left">
        <CatIcon category={tx.type === 'transfer' ? 'transfer' : tx.category} />
        <div>
          <b>{tx.description || label}</b>
          <span>
            {meta}
            {(tx.recurring || tx.recurringOf) && <Repeat size={11} className="inline-ico" aria-label={t('tx.recurring')} />}
            {(tx.source === 'import' || tx.source === 'openfinance') && <Download size={11} className="inline-ico" aria-label={t('tx.imported')} />}
            {tx.source === 'capture' && <Smartphone size={11} className="inline-ico" aria-label={t('cap.fromPhone')} />}
            {tx.space && <Users size={11} className="inline-ico shared" aria-label={t('sp.shared')} />}
          </span>
        </div>
      </div>
      <div className="tx-right">
        <strong className={tone}>{sign}{money(tx.amount)}</strong>
        {pending && <span className="badge warn"><Clock size={11} /> {inflow ? t('ag.toReceive') : t('ag.toPay')}</span>}
        {tx.capture?.review && <span className="badge info">{t('cap.toReview')}</span>}
      </div>
    </button>
  );
}

export function Empty({ icon: Icon, text, action, onAction, children }) {
  return (
    <div className="empty-card">
      <Icon size={30} />
      <p>{text}</p>
      {children}
      {action && <button className="secondary slim" onClick={onAction}>{action}</button>}
    </div>
  );
}

export function PageHead({ title, sub, children }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

/** Colored status label for invoices and bills. */
export function StatusPill({ status }) {
  const { t } = useStore();
  return <span className={`status-pill ${status}`}>{t(`inv.status.${status}`)}</span>;
}

export function Swatch({ color, size = 10 }) {
  return <i className="swatch" style={{ '--c': color, width: size, height: size }} />;
}

/** "hoje", "amanhã", "em 3 dias", "há 2 dias" */
export function relDay(iso, t, today = todayISO()) {
  const d = Math.round((new Date(`${iso}T12:00`) - new Date(`${today}T12:00`)) / 86400000);
  if (d === 0) return t('rel.today');
  if (d === 1) return t('rel.tomorrow');
  if (d === -1) return t('rel.yesterday');
  return d > 0 ? t('rel.inDays', { n: d }) : t('rel.daysAgo', { n: -d });
}
