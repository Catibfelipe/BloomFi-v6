import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Pencil, Scale, ArrowLeftRight, Archive } from 'lucide-react';
import Modal, { Confirm } from './Modal.jsx';
import { useStore } from '../store.jsx';
import { ShareField, useDefaultSpace } from './Spaces.jsx';
import { TxRow, StatusPill } from './Common.jsx';
import { Progress } from './Charts.jsx';
import { parseAmount, formatMonth, monthInText, formatDate } from '../lib/format.js';
import { addMonths, todayISO } from '../lib/dates.js';
import {
  ACCOUNT_TYPES, CARD_BRANDS, ACCOUNT_COLORS, DEFAULT_ACCOUNT_ID, accountBalance, invoice, cardSnapshot, invoiceMonthOf,
} from '../lib/ledger.js';

const toInput = (n, lang) => (n ? String(n).replace('.', lang === 'pt' ? ',' : '.') : '');

function ColorPicker({ value, onChange, label }) {
  return (
    <div className="field-block">
      <span className="field-title">{label}</span>
      <div className="color-row" role="radiogroup" aria-label={label}>
        {ACCOUNT_COLORS.map((c) => (
          <button type="button" key={c} role="radio" aria-checked={value === c} aria-label={c} className={value === c ? 'on' : ''} style={{ '--c': c }} onClick={() => onChange(c)} />
        ))}
      </div>
    </div>
  );
}

export function AccountForm({ acc, onClose }) {
  const { t, lang, saveAccountItem, shareRecord, toast, myId } = useStore();
  const isNew = !acc?.id;
  const defSpace = useDefaultSpace();
  const [space, setSpace] = useState(isNew ? defSpace : acc.space || null);
  const canMove = acc?.id !== DEFAULT_ACCOUNT_ID && (!acc?.space || !acc.sharedBy || acc.sharedBy === myId);
  const [name, setName] = useState(acc?.name || '');
  const [type, setType] = useState(acc?.type || 'checking');
  const [institution, setInstitution] = useState(acc?.institution || '');
  const [color, setColor] = useState(acc?.color || ACCOUNT_COLORS[1]);
  const [balance, setBalance] = useState('');
  const [error, setError] = useState('');
  const bank = acc?.source === 'openfinance';
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError(t('acc.errName'));
    const b = parseAmount(balance || '0', lang);
    if (isNew && Number.isNaN(b)) return setError(t('tx.errAmount'));
    const fields = { ...acc, name, type, institution, color, ...(isNew ? { initialBalance: b } : {}) };
    // Shared or taken back: the account brings its transactions along (shareRecord); otherwise a plain save.
    if (!isNew && (acc.space || null) !== (space || null)) await shareRecord('accounts', fields, space);
    else await saveAccountItem({ ...fields, ...(isNew && space ? { space, sharedBy: myId } : {}) });
    toast(isNew ? t('acc.created') : t('acc.saved'));
    onClose();
  };
  return (
    <Modal title={isNew ? t('acc.new') : t('acc.edit')} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>{t('acc.name')}<input autoFocus={isNew} value={name} maxLength={40} placeholder={t('acc.namePh')} onChange={(e) => { setName(e.target.value); setError(''); }} /></label>
        <div className="form-2">
          <label>{t('acc.type')}
            <select value={type} onChange={(e) => setType(e.target.value)} disabled={bank}>
              {ACCOUNT_TYPES.map((k) => <option key={k} value={k}>{t(`acc.type.${k}`)}</option>)}
            </select>
          </label>
          <label>{t('acc.institution')}<input value={institution} maxLength={40} placeholder={t('acc.institutionPh')} onChange={(e) => setInstitution(e.target.value)} disabled={bank} /></label>
        </div>
        {isNew && (
          <label>{t('acc.currentBalance')}
            <input className="amount" inputMode="decimal" placeholder="0,00" value={balance} onChange={(e) => setBalance(e.target.value)} />
          </label>
        )}
        {isNew && <p className="hint">{t('acc.balanceHint')}</p>}
        <ColorPicker value={color} onChange={setColor} label={t('acc.color')} />
        {acc?.id !== DEFAULT_ACCOUNT_ID ? <ShareField value={space} onChange={setSpace} disabled={!canMove} /> : null}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary full">{isNew ? t('acc.create') : t('common.save')}</button>
      </form>
    </Modal>
  );
}

export function BalanceForm({ acc, onClose }) {
  const { t, lang, txs, money, setAccountBalance, toast } = useStore();
  const current = accountBalance(acc, txs);
  const [value, setValue] = useState(toInput(current, lang));
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    const v = parseAmount(value, lang);
    if (Number.isNaN(v)) return setError(t('tx.errAmount'));
    await setAccountBalance(acc, v);
    toast(t('acc.balanceSet', { v: money(v) }));
    onClose();
  };
  return (
    <Modal title={t('acc.adjust')} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="hint">{t('acc.adjustHint', { a: acc.name })}</p>
        <label>{t('acc.balanceToday')}<input autoFocus className="amount" inputMode="decimal" value={value} onChange={(e) => { setValue(e.target.value); setError(''); }} /></label>
        <p className="hint">{t('acc.adjustNote')}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary full">{t('acc.adjustBtn')}</button>
      </form>
    </Modal>
  );
}

export function CardForm({ card, onClose }) {
  const { t, lang, saveCard, shareRecord, toast, activeAccounts, myId } = useStore();
  const isNew = !card?.id;
  const defSpace = useDefaultSpace();
  const [space, setSpace] = useState(isNew ? defSpace : card.space || null);
  const canMove = !card?.space || !card.sharedBy || card.sharedBy === myId;
  const bank = card?.source === 'openfinance';
  const [name, setName] = useState(card?.name || '');
  const [brand, setBrand] = useState(card?.brand || 'mastercard');
  const [limit, setLimit] = useState(toInput(card?.limit, lang));
  const [closingDay, setClosingDay] = useState(card?.closingDay || 1);
  const [dueDay, setDueDay] = useState(card?.dueDay || 10);
  const [payFrom, setPayFrom] = useState(card?.payFrom || DEFAULT_ACCOUNT_ID);
  const [color, setColor] = useState(card?.color || ACCOUNT_COLORS[1]);
  const [error, setError] = useState('');
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError(t('card.errName'));
    const l = parseAmount(limit || '0', lang);
    if (Number.isNaN(l) || l < 0) return setError(t('card.errLimit'));
    const fields = { ...card, name, brand, limit: l, closingDay, dueDay, payFrom, color };
    if (!isNew && (card.space || null) !== (space || null)) await shareRecord('cards', { ...fields, closingDay: Number(closingDay), dueDay: Number(dueDay) }, space);
    else await saveCard({ ...fields, ...(isNew && space ? { space, sharedBy: myId } : {}) });
    toast(isNew ? t('card.created') : t('card.saved'));
    onClose();
  };
  return (
    <Modal title={isNew ? t('card.new') : t('card.edit')} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>{t('card.name')}<input autoFocus={isNew} value={name} maxLength={40} placeholder={t('card.namePh')} onChange={(e) => { setName(e.target.value); setError(''); }} /></label>
        <div className="form-2">
          <label>{t('card.brand')}
            <select value={brand} onChange={(e) => setBrand(e.target.value)} disabled={bank}>
              {CARD_BRANDS.map((b) => <option key={b} value={b}>{t(`card.brand.${b}`)}</option>)}
            </select>
          </label>
          <label>{t('card.limit')}<input inputMode="decimal" value={limit} placeholder="0,00" onChange={(e) => setLimit(e.target.value)} disabled={bank} /></label>
        </div>
        <div className="form-2">
          <label>{t('card.closing')}
            <select value={closingDay} onChange={(e) => setClosingDay(Number(e.target.value))} disabled={bank}>
              {days.map((d) => <option key={d} value={d}>{t('card.dayN', { n: d })}</option>)}
            </select>
          </label>
          <label>{t('card.due')}
            <select value={dueDay} onChange={(e) => setDueDay(Number(e.target.value))} disabled={bank}>
              {days.map((d) => <option key={d} value={d}>{t('card.dayN', { n: d })}</option>)}
            </select>
          </label>
        </div>
        <p className="hint">{t('card.daysHint')}</p>
        {activeAccounts.length > 1 && (
          <label>{t('card.payFrom')}
            <select value={payFrom} onChange={(e) => setPayFrom(e.target.value)}>
              {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        )}
        <ColorPicker value={color} onChange={setColor} label={t('acc.color')} />
        <ShareField value={space} onChange={setSpace} disabled={!canMove} />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary full">{isNew ? t('card.create') : t('common.save')}</button>
      </form>
    </Modal>
  );
}

export function PayInvoiceForm({ card, inv, onClose }) {
  const { t, lang, money, payInvoice, toast, activeAccounts, txs } = useStore();
  const [amount, setAmount] = useState(toInput(inv.remaining, lang));
  const [from, setFrom] = useState(card.payFrom && activeAccounts.some((a) => a.id === card.payFrom) ? card.payFrom : DEFAULT_ACCOUNT_ID);
  const [date, setDate] = useState(todayISO());
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    const v = parseAmount(amount, lang);
    if (!v || Number.isNaN(v) || v <= 0) return setError(t('tx.errAmount'));
    await payInvoice({ card, mk: inv.mk, amount: v, accountId: from, date });
    toast(t('tx.invoicePaid'));
    onClose();
  };
  const fromAcc = activeAccounts.find((a) => a.id === from);
  return (
    <Modal title={t('inv.payTitle', { c: card.name })} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="pay-summary">
          <div><span>{t('inv.ofMonth', { m: monthInText(inv.mk, lang) })}</span><b>{money(inv.total)}</b></div>
          <div><span>{t('inv.due', { d: formatDate(inv.due, lang, { day: 'numeric', month: 'short' }) })}</span><StatusPill status={inv.status} /></div>
        </div>
        <label>{t('inv.amountToPay')}<input autoFocus className="amount" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setError(''); }} /></label>
        {inv.remaining > 0 && <p className="hint">{t('inv.partialHint')}</p>}
        <div className="form-2">
          <label>{t('tx.from')}
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label>{t('tx.date')}<input type="date" value={date} onChange={(e) => setDate(e.target.value || todayISO())} /></label>
        </div>
        {fromAcc && <p className="hint">{t('inv.balanceAfter', { a: fromAcc.name, v: money(accountBalance(fromAcc, txs) - (parseAmount(amount, lang) || 0)) })}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary full">{t('tx.payInvoiceBtn')}</button>
      </form>
    </Modal>
  );
}

/** Invoice by month: items, totals, payment. */
export function InvoiceSheet({ card, mk: startMk, onClose }) {
  const { t, lang, money, txs, openTx } = useStore();
  const today = todayISO();
  const [mk, setMk] = useState(startMk || invoiceMonthOf(card, today));
  const [pay, setPay] = useState(false);
  const [edit, setEdit] = useState(false);
  const [remove, setRemove] = useState(false);
  const inv = useMemo(() => invoice(card, txs, mk, today), [card, txs, mk, today]);
  const snap = useMemo(() => cardSnapshot(card, txs, today), [card, txs, today]);
  const payments = txs.filter((x) => x.type === 'transfer' && x.toCardId === card.id && x.invoice === mk).sort((a, b) => b.date.localeCompare(a.date));
  if (pay) return <PayInvoiceForm card={card} inv={inv} onClose={() => setPay(false)} />;
  if (edit) return <CardForm card={card} onClose={() => setEdit(false)} />;
  return (
    <Modal title={card.name} onClose={onClose} wide>
      <div className="inv-head">
        <div className="month-switch">
          <button onClick={() => setMk(addMonths(mk, -1))} aria-label={t('common.prev')}><ChevronLeft size={18} /></button>
          <span className="label">{formatMonth(mk, lang)}</span>
          <button onClick={() => setMk(addMonths(mk, 1))} aria-label={t('common.fwd')}><ChevronRight size={18} /></button>
        </div>
        <StatusPill status={inv.status} />
      </div>
      <div className="inv-totals">
        <div><span>{t('invc.total')}</span><b>{money(inv.total)}</b></div>
        <div><span>{t('inv.paid')}</span><b>{money(inv.paid)}</b></div>
        <div><span>{t('inv.closes')}</span><b>{formatDate(inv.closing, lang, { day: 'numeric', month: 'short' })}</b></div>
        <div><span>{t('inv.dueLabel')}</span><b>{formatDate(inv.due, lang, { day: 'numeric', month: 'short' })}</b></div>
      </div>
      {card.limit > 0 && (
        <div className="inv-limit">
          <Progress pct={snap.usage.pct} tone={snap.usage.pct > 90 ? 'bad' : snap.usage.pct > 70 ? 'warn' : ''} />
          <div><span>{t('card.used', { v: money(snap.usage.used) })}</span><span>{t('card.available', { v: money(snap.usage.available) })}</span></div>
        </div>
      )}
      <div className="btn-row">
        <button className="secondary" onClick={() => setEdit(true)}><Pencil size={16} /> {t('card.edit')}</button>
        {inv.remaining > 0 && <button className="primary" onClick={() => setPay(true)}>{t('tx.payInvoiceBtn')}</button>}
      </div>
      <h3 className="sheet-sub">{t('inv.items', { n: inv.items.length })}</h3>
      {inv.items.length ? inv.items.map((x) => <TxRow key={x.id} tx={x} hidePlace />) : <p className="muted">{t('inv.noItems')}</p>}
      {payments.length > 0 && (
        <>
          <h3 className="sheet-sub">{t('inv.payments')}</h3>
          {payments.map((x) => <TxRow key={x.id} tx={x} />)}
        </>
      )}
      <div className="sheet-foot">
        <button className="link-btn" onClick={() => { onClose(); openTx({ type: 'expense', cardId: card.id }); }}>{t('card.addPurchase')}</button>
        <button className="link-btn danger" onClick={() => setRemove(true)}><Archive size={14} /> {t('card.remove')}</button>
      </div>
      {remove && <CardRemove card={card} onClose={() => { setRemove(false); }} onDone={onClose} />}
    </Modal>
  );
}

/** Account detail: balance, actions and latest movements. */
export function AccountSheet({ acc, onClose }) {
  const { t, money, txs, openTx, deleteAccountItem, toast } = useStore();
  const [mode, setMode] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const balance = accountBalance(acc, txs);
  const bank = acc.source === 'openfinance';
  const recent = useMemo(
    () => txs.filter((x) => (x.accountId || (x.cardId ? null : DEFAULT_ACCOUNT_ID)) === acc.id || x.toAccountId === acc.id)
      .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 12),
    [txs, acc.id],
  );
  if (mode === 'edit') return <AccountForm acc={acc} onClose={() => setMode(null)} />;
  if (mode === 'balance') return <BalanceForm acc={acc} onClose={() => setMode(null)} />;
  return (
    <Modal title={acc.name} onClose={onClose} wide>
      <div className="acc-hero" style={{ '--c': acc.color }}>
        <span>{bank ? t('acc.bankBalance') : t('acc.balance')}</span>
        <strong className={balance < 0 ? 'neg-red' : ''}>{money(balance)}</strong>
        <small>{[t(`acc.type.${acc.type || 'checking'}`), acc.institution].filter(Boolean).join(' · ')}</small>
      </div>
      <div className="action-row">
        {!bank && <button className="secondary" onClick={() => setMode('balance')}><Scale size={16} /> {t('acc.adjust')}</button>}
        <button className="secondary" onClick={() => { onClose(); openTx({ type: 'transfer', accountId: acc.id }); }}><ArrowLeftRight size={16} /> {t('acc.transfer')}</button>
        <button className="secondary" onClick={() => setMode('edit')}><Pencil size={16} /> {t('common.edit')}</button>
      </div>
      <h3 className="sheet-sub">{t('acc.latest')}</h3>
      {recent.length ? recent.map((x) => <TxRow key={x.id} tx={x} hidePlace={x.type !== 'transfer'} />) : <p className="muted">{t('acc.noTx')}</p>}
      {acc.id !== DEFAULT_ACCOUNT_ID && (
        <button className="link-btn danger" onClick={() => setConfirm(true)}><Archive size={14} /> {t('acc.remove')}</button>
      )}
      {confirm && (
        <Confirm title={t('acc.removeTitle', { a: acc.name })} text={t('acc.removeText')} confirmLabel={t('acc.remove')} cancelLabel={t('common.cancel')} danger
          onClose={() => setConfirm(false)}
          onConfirm={async () => { const r = await deleteAccountItem(acc); toast(t(r === 'archived' ? 'acc.archived' : 'acc.deleted')); onClose(); }} />
      )}
    </Modal>
  );
}

export function CardRemove({ card, onClose, onDone }) {
  const { t, deleteCard, toast } = useStore();
  return (
    <Confirm title={t('card.removeTitle', { c: card.name })} text={t('card.removeText')} confirmLabel={t('card.remove')} cancelLabel={t('common.cancel')} danger
      onClose={onClose}
      onConfirm={async () => { const r = await deleteCard(card); toast(t(r === 'archived' ? 'card.archived' : 'card.deleted')); onDone?.(); }} />
  );
}
