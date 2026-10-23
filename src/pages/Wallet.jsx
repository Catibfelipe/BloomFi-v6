import React, { useMemo, useState } from 'react';
import { Plus, ArrowLeftRight, CreditCard, Landmark, ChevronRight, Wallet as WalletIcon, PiggyBank, Banknote, Building2 } from 'lucide-react';
import { useStore } from '../store.jsx';
import { SpaceTag } from '../components/Spaces.jsx';
import { PageHead, StatusPill, Empty } from '../components/Common.jsx';
import { Progress } from '../components/Charts.jsx';
import { AccountForm, CardForm, AccountSheet, InvoiceSheet, PayInvoiceForm } from '../components/WalletSheets.jsx';
import { portfolio } from '../lib/investments.js';
import { formatDate, formatMonth, monthInText } from '../lib/format.js';

const TYPE_ICON = { checking: Landmark, savings: PiggyBank, cash: Banknote, wallet: WalletIcon, other: Building2 };

function CardTile({ row, onOpen, onPay }) {
  const { t, money, lang } = useStore();
  const { card, open, toPay, usage } = row;
  const focus = toPay || open;
  return (
    <article className="card-tile" style={{ '--c': card.color }}>
      <button className="card-face" onClick={() => onOpen(card, focus.mk)} aria-label={`${card.name} — ${t('inv.see')}`}>
        <div className="card-top">
          <span className="card-name">{card.name} <SpaceTag id={card.space} /></span>
          <span className="card-brand">{t(`card.brand.${card.brand || 'other'}`)}</span>
        </div>
        <div className="card-mid">
          <span>{t('invc.current', { d: formatDate(open.closing, lang, { day: 'numeric', month: 'short' }) })}</span>
          <strong>{money(open.total)}</strong>
        </div>
        {card.limit > 0 && (
          <div className="card-limit">
            <Progress pct={usage.pct} tone={usage.pct > 90 ? 'bad' : usage.pct > 70 ? 'warn' : ''} />
            <div><span>{t('card.available', { v: money(usage.available) })}</span><span>{t('card.limitOf', { v: money(usage.limit) })}</span></div>
          </div>
        )}
      </button>
      {toPay ? (
        <div className="card-due">
          <div>
            <span>{t('inv.ofMonth', { m: monthInText(toPay.mk, lang) })} · {t('inv.due', { d: formatDate(toPay.due, lang, { day: 'numeric', month: 'short' }) })}</span>
            <b>{money(toPay.remaining)}</b>
          </div>
          <StatusPill status={toPay.status} />
          <button className="primary slim" onClick={() => onPay(card, toPay)}>{t('inv.pay')}</button>
        </div>
      ) : (
        <div className="card-due calm"><span>{t('inv.nothingDue')}</span></div>
      )}
    </article>
  );
}

export default function Wallet() {
  const { ledger, accounts, cards, assets, txs, t, money, openTx, activeCards } = useStore();
  const [sheet, setSheet] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const pf = useMemo(() => portfolio(assets, txs), [assets, txs]);
  const net = ledger.cash + pf.value - ledger.cardDebt;
  const archived = accounts.filter((a) => a.archived).length + cards.filter((c) => c.archived).length;
  const parts = [
    { key: 'cash', label: t('wal.accounts'), value: Math.max(ledger.cash, 0), color: 'var(--brand)' },
    { key: 'inv', label: t('nav.invest'), value: pf.value, color: 'var(--invest)' },
  ];
  const assetsTotal = parts.reduce((s, p) => s + p.value, 0) || 1;
  const close = () => setSheet(null);

  return (
    <div className="page wallet">
      <PageHead title={t('wal.title')} sub={t('wal.sub')}>
        <button className="secondary slim" onClick={() => openTx({ type: 'transfer' })}><ArrowLeftRight size={16} /> {t('acc.transfer')}</button>
      </PageHead>

      <section className="networth">
        <div className="nw-main">
          <span>{t('wal.netWorth')}</span>
          <strong className={net < 0 ? 'neg-red' : ''}>{money(net)}</strong>
          <small>{t('wal.netWorthHint')}</small>
        </div>
        <div className="nw-bar" aria-hidden="true">
          {parts.map((p) => <i key={p.key} style={{ width: `${(p.value / assetsTotal) * 100}%`, background: p.color }} />)}
        </div>
        <dl className="nw-parts">
          <div><dt><i style={{ background: 'var(--brand)' }} />{t('wal.accounts')}</dt><dd>{money(ledger.cash)}</dd></div>
          <div><dt><i style={{ background: 'var(--invest)' }} />{t('nav.invest')}</dt><dd>{money(pf.value)}</dd></div>
          <div><dt><i style={{ background: 'var(--negative)' }} />{t('wal.cardDebt')}</dt><dd>−{money(ledger.cardDebt)}</dd></div>
        </dl>
      </section>

      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h2>{t('wal.accounts')}</h2>
            <button onClick={() => setSheet({ kind: 'newAccount' })}><Plus size={15} /> {t('acc.new')}</button>
          </div>
          <ul className="acc-list">
            {ledger.accRows.map(({ account: a, balance }) => {
              const Icon = TYPE_ICON[a.type] || Landmark;
              return (
                <li key={a.id}>
                  <button className="acc-row" onClick={() => setSheet({ kind: 'account', id: a.id })}>
                    <span className="acc-icon" style={{ '--c': a.color }}><Icon size={18} /></span>
                    <span className="acc-main">
                      <b>{a.name} <SpaceTag id={a.space} /></b>
                      <small>{[t(`acc.type.${a.type || 'checking'}`), a.institution, a.source === 'openfinance' ? t('acc.viaOF') : ''].filter((x, i) => x && !(i === 0 && x === a.name)).join(' · ')}</small>
                    </span>
                    <strong className={balance < 0 ? 'neg-red' : ''}>{money(balance)}</strong>
                    <ChevronRight size={16} className="chev" />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="acc-total"><span>{t('wal.totalAccounts')}</span><b>{money(ledger.cash)}</b></div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>{t('wal.cards')}</h2>
            <button onClick={() => setSheet({ kind: 'newCard' })}><Plus size={15} /> {t('card.new')}</button>
          </div>
          {activeCards.length ? (
            <div className="card-list">
              {ledger.cardRows.map((row) => (
                <CardTile key={row.card.id} row={row}
                  onOpen={(card, mk) => setSheet({ kind: 'invoice', id: card.id, mk })}
                  onPay={(card, inv) => setSheet({ kind: 'pay', id: card.id, inv })} />
              ))}
            </div>
          ) : (
            <Empty icon={CreditCard} text={t('wal.noCards')} action={t('card.new')} onAction={() => setSheet({ kind: 'newCard' })} />
          )}
        </section>
      </div>

      {archived > 0 && (
        <section className="panel archived">
          <button className="link-btn" onClick={() => setShowArchived(!showArchived)}>{showArchived ? t('wal.hideArchived') : t('wal.showArchived', { n: archived })}</button>
          {showArchived && (
            <ul className="acc-list">
              {accounts.filter((a) => a.archived).map((a) => (
                <li key={a.id}><button className="acc-row" onClick={() => setSheet({ kind: 'account', id: a.id })}><span className="acc-icon" style={{ '--c': a.color }}><Landmark size={18} /></span><span className="acc-main"><b>{a.name}</b><small>{t('wal.archived')}</small></span></button></li>
              ))}
              {cards.filter((c) => c.archived).map((c) => (
                <li key={c.id}><button className="acc-row" onClick={() => setSheet({ kind: 'invoice', id: c.id })}><span className="acc-icon" style={{ '--c': c.color }}><CreditCard size={18} /></span><span className="acc-main"><b>{c.name}</b><small>{t('wal.archived')}</small></span></button></li>
              ))}
            </ul>
          )}
        </section>
      )}

      {sheet?.kind === 'newAccount' && <AccountForm onClose={close} />}
      {sheet?.kind === 'newCard' && <CardForm onClose={close} />}
      {sheet?.kind === 'account' && accounts.find((a) => a.id === sheet.id) && <AccountSheet acc={accounts.find((a) => a.id === sheet.id)} onClose={close} />}
      {sheet?.kind === 'invoice' && cards.find((c) => c.id === sheet.id) && <InvoiceSheet card={cards.find((c) => c.id === sheet.id)} mk={sheet.mk} onClose={close} />}
      {sheet?.kind === 'pay' && cards.find((c) => c.id === sheet.id) && <PayInvoiceForm card={cards.find((c) => c.id === sheet.id)} inv={sheet.inv} onClose={close} />}
    </div>
  );
}
