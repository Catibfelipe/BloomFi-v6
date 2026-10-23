import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Trash2, Repeat, ArrowUpRight, ArrowDownLeft, Plus, CreditCard, Wallet, BellRing, Smartphone, Mic, Wand2 } from 'lucide-react';
import Modal from './Modal.jsx';
import { CategoryForm } from './Categories.jsx';
import { useStore } from '../store.jsx';
import { categoriesFor } from '../lib/categories.js';
import { ASSET_KINDS } from '../lib/investments.js';
import { parseAmount, formatMonth, monthInText, formatDate } from '../lib/format.js';
import { todayISO } from '../lib/dates.js';
import { DEFAULT_ACCOUNT_ID, invoiceMonthOf, invoiceDates, invoiceForPayment, accountBalance, cardUsage } from '../lib/ledger.js';
import { parseQuick } from '../lib/quickparse.js';

const SpeechRec = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition || null) : null;

/** One sentence, typed or said ("45 mercado ontem no Nubank"), fills the form below to review and save. */
function QuickEntry({ onApply }) {
  const { t, lang, money, activeAccounts, activeCards, categories, toast } = useStore();
  const [q, setQ] = useState('');
  const [listening, setListening] = useState(false);
  const rec = useRef(null);
  const parse = (text) => parseQuick(text, { lang, accounts: activeAccounts, cards: activeCards, categories });
  const p = q.trim() ? parse(q) : null;
  const apply = (pp) => { if (pp) { onApply(pp); setQ(''); } };
  useEffect(() => () => rec.current?.abort?.(), []);
  const listen = () => {
    try {
      const r = new SpeechRec();
      r.lang = lang === 'pt' ? 'pt-BR' : 'en-US';
      r.interimResults = true;
      r.continuous = false;
      r.onresult = (e) => {
        let text = '', done = false;
        for (const res of e.results) { text += res[0].transcript; if (res.isFinal) done = true; }
        setQ(text);
        if (done) apply(parse(text));
      };
      r.onerror = (e) => {
        setListening(false);
        if (e.error !== 'aborted' && e.error !== 'no-speech') toast(t(['not-allowed', 'service-not-allowed'].includes(e.error) ? 'qe.micDenied' : 'qe.micError'), 'info');
      };
      r.onend = () => setListening(false);
      rec.current = r;
      r.start();
      setListening(true);
    } catch { setListening(false); toast(t('qe.micError'), 'info'); }
  };
  const where = p && (p.cardId ? activeCards.find((c) => c.id === p.cardId)?.name : p.accountId ? activeAccounts.find((a) => a.id === p.accountId)?.name : null);
  const when = p && (p.dateWord ? formatDate(p.date, lang, { day: 'numeric', month: 'short' }) : null);
  return (
    <div className={`quick-entry ${listening ? 'listening' : ''}`}>
      <div className="qe-row">
        <Wand2 size={16} aria-hidden="true" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={listening ? t('qe.listening') : t('qe.ph')} aria-label={t('qe.label')} enterKeyHint="done"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(p); } }} />
        {SpeechRec && (
          <button type="button" className={`qe-mic ${listening ? 'on' : ''}`} onClick={() => (listening ? rec.current?.stop() : listen())} aria-label={t('qe.mic')} title={t('qe.mic')}>
            <Mic size={17} />
          </button>
        )}
      </div>
      {p && (
        <button type="button" className="qe-preview" onClick={() => apply(p)}>
          <span>
            <b className={p.type === 'income' || p.type === 'redeem' ? 'positive' : ''}>{money(p.amount)}</b>
            {' · '}{t(p.type === 'invest' || p.type === 'redeem' ? `tx.mode.invest` : `cat.${p.category}`)}
            {p.description ? ` · ${p.description}` : ''}{when ? ` · ${when}` : ''}{where ? ` · ${where}` : ''}{p.installments > 1 ? ` · ${p.installments}x` : ''}
          </span>
          <em>{t('qe.use')}</em>
        </button>
      )}
      {q.trim() && !p && !listening && <p className="hint">{t('qe.noAmount')}</p>}
    </div>
  );
}

const MODES = ['expense', 'income', 'invest', 'transfer'];
const key = (kind, id) => `${kind}:${id}`;
const parseKey = (k) => { const i = k.indexOf(':'); return { kind: k.slice(0, i), id: k.slice(i + 1) }; };

/** Horizontal list of accounts (and cards) to pick where the money moves. */
function SourcePicker({ value, onChange, accounts, cards = [], label, exclude, balanceOf, availableOf, money }) {
  const opts = [
    ...accounts.map((a) => ({ k: key('acc', a.id), name: a.name, color: a.color, icon: Wallet, sub: money(balanceOf(a)) })),
    ...cards.map((c) => ({ k: key('card', c.id), name: c.name, color: c.color, icon: CreditCard, sub: money(availableOf(c)) })),
  ].filter((o) => o.k !== exclude);
  return (
    <div className="field-block">
      <span className="field-title">{label}</span>
      <div className="source-picker" role="radiogroup" aria-label={label}>
        {opts.map((o) => {
          const Icon = o.icon;
          return (
            <button type="button" role="radio" aria-checked={value === o.k} key={o.k} className={value === o.k ? 'on' : ''} style={{ '--c': o.color }} onClick={() => onChange(o.k)}>
              <Icon size={15} /><span><b>{o.name}</b><small>{o.sub}</small></span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Add or edit any movement: expense, income, investment (debit/credit) or a transfer between your own accounts/cards. */
export default function TxForm() {
  const {
    txModal, closeTx, saveTx, deleteTxUndo, saveAsset, t, lang, toast, settings, assets, txs, money,
    activeAccounts, activeCards, cards,
  } = useStore();
  const editing = !!txModal?.id;
  const today = todayISO();
  const initialMode = txModal?.type === 'invest' || txModal?.type === 'redeem' ? 'invest' : MODES.includes(txModal?.type) ? txModal.type : 'expense';
  const [mode, setMode] = useState(initialMode);
  const [dir, setDir] = useState(txModal?.type === 'redeem' ? 'redeem' : 'invest');
  const [amount, setAmount] = useState(txModal?.amount ? String(txModal.amount).replace('.', lang === 'pt' ? ',' : '.') : '');
  const [category, setCategory] = useState(initialMode === 'invest' || initialMode === 'transfer' ? '' : txModal?.category || '');
  const [description, setDescription] = useState(txModal?.description || '');
  const [date, setDate] = useState(txModal?.date || today);
  const [recurring, setRecurring] = useState(!!txModal?.recurring);
  const [autoPay, setAutoPay] = useState(txModal?.autoPay !== false);
  const [status, setStatus] = useState(txModal?.status || 'paid');
  const [statusTouched, setStatusTouched] = useState(editing);
  const [assetId, setAssetId] = useState(txModal?.assetId || '');
  const [newAsset, setNewAsset] = useState(null);
  const [installments, setInstallments] = useState(1);
  const [error, setError] = useState('');
  const [askGroup, setAskGroup] = useState(false);
  const [newCat, setNewCat] = useState(false);
  const amountRef = useRef();

  // Accounts/cards: include the one being edited even if it was archived since.
  const accList = activeAccounts;
  const cardList = activeCards.concat(txModal?.cardId && !activeCards.some((c) => c.id === txModal.cardId) ? cards.filter((c) => c.id === txModal.cardId) : []);
  const firstAcc = txModal?.accountId || DEFAULT_ACCOUNT_ID;
  const [source, setSource] = useState(txModal?.cardId ? key('card', txModal.cardId) : key('acc', firstAcc));
  const defaultDest = () => {
    if (txModal?.toCardId) return key('card', txModal.toCardId);
    if (txModal?.toAccountId) return key('acc', txModal.toAccountId);
    const other = accList.find((a) => key('acc', a.id) !== source);
    return other ? key('acc', other.id) : cardList[0] ? key('card', cardList[0].id) : '';
  };
  const [dest, setDest] = useState(defaultDest);
  const src = parseKey(source);
  const dst = dest ? parseKey(dest) : null;
  const onCard = src.kind === 'card' && (mode === 'expense' || mode === 'income');
  const card = onCard ? cards.find((c) => c.id === src.id) : null;
  const destCard = mode === 'transfer' && dst?.kind === 'card' ? cards.find((c) => c.id === dst.id) : null;
  const [invoiceMk, setInvoiceMk] = useState(txModal?.invoice || '');

  useEffect(() => { if (!editing) setTimeout(() => amountRef.current?.focus(), 250); }, [editing]);
  const cats = categoriesFor(mode);
  useEffect(() => { if ((mode === 'expense' || mode === 'income') && category && !cats.some((c) => c.key === category)) setCategory(''); }, [mode]); // eslint-disable-line
  // Cards only take expenses (and refunds). For other kinds, go back to an account.
  useEffect(() => { if (src.kind === 'card' && mode !== 'expense' && mode !== 'income') setSource(key('acc', DEFAULT_ACCOUNT_ID)); }, [mode]); // eslint-disable-line
  useEffect(() => { if (mode === 'transfer' && (!dest || dest === source)) setDest(defaultDest()); }, [mode, source]); // eslint-disable-line
  // A date in the future is usually a scheduled bill, unless the user said otherwise.
  useEffect(() => { if (!statusTouched) setStatus(date > today ? 'pending' : 'paid'); }, [date]); // eslint-disable-line
  useEffect(() => { if (destCard && !txModal?.invoice) setInvoiceMk(invoiceForPayment(destCard, date)); }, [dest, date]); // eslint-disable-line

  const manualAssets = assets.filter((a) => a.source !== 'openfinance');
  const value = parseAmount(amount, lang);
  const balanceOf = (a) => accountBalance(a, txs);
  const availableOf = (c) => cardUsage(c, txs).available;
  const canInstall = onCard && mode === 'expense' && !editing && !recurring;
  const invoiceOptions = useMemo(() => {
    if (!destCard) return [];
    const base = invoiceMonthOf(destCard, date);
    const out = [];
    for (let i = -3; i <= 1; i++) {
      const [y, m] = base.split('-').map(Number);
      const d = new Date(y, m - 1 + i, 1);
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return out;
  }, [destCard, date]);

  const submit = async (e) => {
    e.preventDefault();
    if (!value || Number.isNaN(value) || value <= 0) return setError(t('tx.errAmount'));
    if ((mode === 'expense' || mode === 'income') && !category) return setError(t('tx.errCategory'));
    if (mode === 'transfer' && (!dest || dest === source)) return setError(t('tx.errTransfer'));
    let finalAssetId = mode === 'invest' ? assetId || null : null;
    if (mode === 'invest' && newAsset) {
      if (!newAsset.name.trim()) return setError(t('inv.errName'));
      finalAssetId = (await saveAsset({ name: newAsset.name, kind: newAsset.kind, initialInvested: 0 })).id;
    }
    const type = mode === 'invest' ? dir : mode;
    const cat = mode === 'invest'
      ? (txModal?.category === 'goal_save' && dir === 'invest' ? 'goal_save' : dir === 'invest' ? 'invest' : 'redeem')
      : mode === 'transfer' ? 'transfer' : category;
    const saved = await saveTx({
      ...txModal, type, amount: Math.abs(value), category: cat, description, date, recurring: recurring && !(canInstall && installments > 1),
      autoPay, assetId: finalAssetId,
      accountId: src.kind === 'acc' ? src.id : null,
      cardId: src.kind === 'card' ? src.id : null,
      toAccountId: mode === 'transfer' && dst?.kind === 'acc' ? dst.id : null,
      toCardId: mode === 'transfer' && dst?.kind === 'card' ? dst.id : null,
      // A card parcel keeps its invoice unless its date was changed.
      invoice: destCard ? invoiceMk : onCard && txModal?.installment && date === txModal?.date ? txModal.invoice || null : null,
      status: (mode === 'expense' || mode === 'income') && !onCard ? status : 'paid',
      installments: canInstall ? installments : 1,
    });
    if (editing) toast(t('tx.updated'));
    else if (canInstall && installments > 1) toast(t('tx.addedInstallments', { n: installments }));
    else if (mode === 'invest') toast(t(dir === 'invest' ? 'tx.investAdded' : 'tx.redeemAdded'));
    else if (mode === 'transfer') toast(destCard ? t('tx.invoicePaid') : t('tx.transferAdded'));
    else toast(saved.status === 'pending' ? t('tx.scheduled') : t('tx.added'));
    closeTx();
  };

  const remove = async (group) => { setAskGroup(false); closeTx(); await deleteTxUndo(txModal, { group }); };
  // Quick entry: fills the form; the person checks it and taps the button as usual.
  const applyQuick = (p) => {
    const m = p.type === 'invest' || p.type === 'redeem' ? 'invest' : p.type;
    setMode(m);
    if (m === 'invest') setDir(p.type);
    setAmount(String(p.amount).replace('.', lang === 'pt' ? ',' : '.'));
    if (m === 'expense' || m === 'income') setCategory(p.category);
    if (p.description) setDescription(p.description);
    setDate(p.date);
    setStatusTouched(false);
    if (p.cardId && m === 'expense') setSource(key('card', p.cardId));
    else if (p.accountId) setSource(key('acc', p.accountId));
    else if (m !== 'expense' && m !== 'income') setSource(key('acc', DEFAULT_ACCOUNT_ID));
    setInstallments(p.installments > 1 ? p.installments : 1);
    setError('');
  };
  const currencySymbol = (0).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US', { style: 'currency', currency: settings.currency }).replace(/[\d.,\s]/g, '');
  const showPicker = mode === 'transfer' || accList.length > 1 || (cardList.length > 0 && (mode === 'expense' || mode === 'income'));
  const per = value > 0 && installments > 1 ? value / installments : 0;
  const cardInvoice = card ? invoiceMonthOf(card, date) : null;
  const title = editing ? t('tx.edit') : t('tx.add');
  const submitLabel = editing ? t('common.save')
    : mode === 'invest' ? t(dir === 'invest' ? 'tx.applyBtn' : 'tx.redeemBtn')
    : mode === 'transfer' ? (destCard ? t('tx.payInvoiceBtn') : t('tx.transferBtn'))
    : t('tx.add');

  return (
    <Modal title={title} onClose={closeTx}>
      <form onSubmit={submit} className="form">
        {!editing && <QuickEntry onApply={applyQuick} />}
        <div className="segmented four" role="tablist">
          {MODES.map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? `active ${m}` : ''} onClick={() => { setMode(m); setError(''); }}>
              {t(`tx.mode.${m}`)}
            </button>
          ))}
        </div>

        {mode === 'invest' && (
          <div className="dir-toggle">
            <button type="button" className={dir === 'invest' ? 'on out' : ''} onClick={() => setDir('invest')}>
              <ArrowUpRight size={16} /><span><b>{t('tx.apply')}</b><small>{t('tx.applyHint')}</small></span>
            </button>
            <button type="button" className={dir === 'redeem' ? 'on in' : ''} onClick={() => setDir('redeem')}>
              <ArrowDownLeft size={16} /><span><b>{t('tx.redeem')}</b><small>{t('tx.redeemHint')}</small></span>
            </button>
          </div>
        )}

        {txModal?.capture && (
          <p className="capture-note">
            <Smartphone size={15} />
            <span>{t('cap.formNote', { w: new Intl.DateTimeFormat(lang === 'pt' ? 'pt-BR' : 'en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(txModal.capture.at || txModal.createdAt || Date.now())), s: t(`cap.src.${txModal.capture.src || 'notification'}`) })}{txModal.capture.cardName || txModal.capture.last4 ? ` · ${[txModal.capture.cardName, txModal.capture.last4 ? `•${txModal.capture.last4}` : ''].filter(Boolean).join(' ')}` : ''}{txModal.capture.linked ? ` · ${t('cap.linked')}` : ''}</span>
          </p>
        )}

        <label>{t('tx.amount')} ({currencySymbol})
          <input ref={amountRef} className="amount" inputMode="decimal" placeholder="0,00" value={amount}
            onChange={(e) => { setAmount(e.target.value); setError(''); }} />
        </label>

        {showPicker && (
          <SourcePicker
            label={mode === 'transfer' ? t('tx.from') : mode === 'income' ? t('tx.into') : t('tx.paidWith')}
            value={source} onChange={setSource} accounts={accList}
            cards={mode === 'expense' || mode === 'income' ? cardList : []}
            balanceOf={balanceOf} availableOf={availableOf} money={money}
          />
        )}
        {mode === 'transfer' && (
          accList.length + cardList.length > 1 ? (
            <SourcePicker label={t('tx.to')} value={dest} onChange={setDest} accounts={accList} cards={cardList} exclude={source}
              balanceOf={balanceOf} availableOf={availableOf} money={money} />
          ) : <p className="hint info-note">{t('tx.transferNeedsTwo')}</p>
        )}
        {destCard && (
          <label>{t('tx.whichInvoice')}
            <select value={invoiceMk} onChange={(e) => setInvoiceMk(e.target.value)}>
              {invoiceOptions.map((mk) => <option key={mk} value={mk}>{t('inv.ofMonth', { m: monthInText(mk, lang) })} · {t('inv.due', { d: formatDate(invoiceDates(destCard, mk).due, lang, { day: 'numeric', month: 'short' }) })}</option>)}
            </select>
          </label>
        )}

        {card && (
          <p className="hint card-note"><CreditCard size={14} /> {t('tx.goesToInvoice', { m: monthInText(cardInvoice, lang), d: formatDate(invoiceDates(card, cardInvoice).closing, lang, { day: 'numeric', month: 'short' }) })}</p>
        )}
        {canInstall && (
          <label>{t('tx.installments')}
            <select value={installments} onChange={(e) => setInstallments(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n === 1 ? t('tx.oneShot') : value > 0 ? t('tx.nTimes', { n, v: money(value / n) }) : `${n}x`}</option>
              ))}
            </select>
          </label>
        )}
        {per > 0 && <p className="hint">{t('tx.installmentsHint', { n: installments, v: money(per) })}</p>}

        {(mode === 'expense' || mode === 'income') && (
          <>
            <span className="field-title">{t('tx.category')}</span>
            <div className="cat-grid">
              {cats.map((c) => {
                const Icon = c.icon;
                return (
                  <button type="button" key={c.key} className={category === c.key ? 'on' : ''} style={{ '--c': c.color }}
                    onClick={() => { setCategory(c.key); setError(''); }} aria-pressed={category === c.key}>
                    <Icon size={18} /><span>{t(`cat.${c.key}`)}</span>
                  </button>
                );
              })}
              <button type="button" className="cat-add" onClick={() => setNewCat(true)} aria-label={t('cats.new')}>
                <Plus size={18} /><span>{t('cats.newShort')}</span>
              </button>
            </div>
          </>
        )}

        {mode === 'invest' && (
          <>
            <label htmlFor="tx-asset">{t('tx.asset')}</label>
            {!newAsset ? (
              <div className="inline-input">
                <select id="tx-asset" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                  <option value="">{t('tx.noAsset')}</option>
                  {manualAssets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <button type="button" className="secondary" onClick={() => { setNewAsset({ name: '', kind: 'renda_fixa' }); setAssetId(''); }}>
                  <Plus size={16} /> {t('inv.new')}
                </button>
              </div>
            ) : (
              <div className="new-asset">
                <input id="tx-asset" placeholder={t('inv.namePh')} value={newAsset.name} maxLength={50} onChange={(e) => setNewAsset({ ...newAsset, name: e.target.value })} />
                <select aria-label={t('inv.kind')} value={newAsset.kind} onChange={(e) => setNewAsset({ ...newAsset, kind: e.target.value })}>
                  {ASSET_KINDS.map((k) => <option key={k.key} value={k.key}>{t(`kind.${k.key}`)}</option>)}
                </select>
                <button type="button" className="link-btn" onClick={() => setNewAsset(null)}>{t('common.cancel')}</button>
              </div>
            )}
          </>
        )}

        <div className="form-2">
          <label>{t('tx.description')}
            <input placeholder={mode === 'invest' ? t('tx.investDescPh') : mode === 'transfer' ? t('tx.transferDescPh') : t('tx.descPh')} value={description} maxLength={80} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label>{t('tx.date')}
            <input type="date" value={date} onChange={(e) => setDate(e.target.value || today)} />
          </label>
        </div>

        {(mode === 'expense' || mode === 'income') && !onCard && (
          <div className="field-block">
            <span className="field-title">{t('tx.status')}</span>
            <div className="segmented two small">
              <button type="button" className={status === 'paid' ? 'active' : ''} onClick={() => { setStatus('paid'); setStatusTouched(true); }}>{mode === 'income' ? t('tx.received') : t('tx.paid')}</button>
              <button type="button" className={status === 'pending' ? 'active warn' : ''} onClick={() => { setStatus('pending'); setStatusTouched(true); }}>{mode === 'income' ? t('ag.toReceive') : t('ag.toPay')}</button>
            </div>
            {status === 'pending' && <p className="hint">{t('tx.pendingHint')}</p>}
          </div>
        )}

        {!txModal?.recurringOf && !txModal?.installment && !(mode === 'invest' && dir === 'redeem') && !(canInstall && installments > 1) && (
          <button type="button" className={`toggle ${recurring ? 'on' : ''}`} onClick={() => setRecurring(!recurring)} aria-pressed={recurring}>
            <span><Repeat size={16} /> {t('tx.recurring')}<small>{mode === 'invest' ? t('tx.recurringInvest') : t('tx.recurringHint')}</small></span><i />
          </button>
        )}
        {recurring && (mode === 'expense' || mode === 'income') && !onCard && (
          <button type="button" className={`toggle sub ${!autoPay ? 'on' : ''}`} onClick={() => setAutoPay(!autoPay)} aria-pressed={!autoPay}>
            <span><BellRing size={16} /> {t('tx.confirmEach')}<small>{t('tx.confirmEachHint')}</small></span><i />
          </button>
        )}
        {txModal?.recurringOf && <p className="hint"><Repeat size={14} /> {t('tx.generated')}</p>}
        {txModal?.installment && <p className="hint"><CreditCard size={14} /> {t('tx.installmentOf', { n: txModal.installment.n, of: txModal.installment.of })}</p>}
        {mode === 'invest' && <p className="hint debit-note">{dir === 'invest' ? t('tx.debitNote') : t('tx.creditNote')}</p>}
        {mode === 'transfer' && !destCard && <p className="hint">{t('tx.transferNote')}</p>}
        {destCard && <p className="hint">{t('tx.invoiceNote')}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="btn-row">
          {editing && (
            <button type="button" className="icon-danger" onClick={() => (txModal.installment ? setAskGroup(true) : remove(false))} aria-label={t('common.delete')} title={t('common.delete')}>
              <Trash2 size={18} />
            </button>
          )}
          <button type="submit" className="primary">{submitLabel}</button>
        </div>
      </form>
      {newCat && <CategoryForm type={mode === 'income' ? 'income' : 'expense'} onClose={() => setNewCat(false)} onSaved={(c) => { setCategory(c.key); setError(''); }} />}
      {askGroup && (
        <Modal title={t('tx.deleteInstTitle')} onClose={() => setAskGroup(false)}>
          <p className="confirm-text">{t('tx.deleteInstText', { of: txModal.installment.of })}</p>
          <div className="btn-col">
            <button className="secondary" onClick={() => remove(false)}>{t('tx.deleteThis')}</button>
            <button className="danger-btn" onClick={() => remove(true)}>{t('tx.deleteAll', { n: txModal.installment.of })}</button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
