import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2, ShieldCheck, FileUp, Check, ArrowRight, Info, Landmark, RefreshCw, Unplug, Plus, Crown, Clock, PauseCircle, ExternalLink,
} from 'lucide-react';
import { useStore } from '../store.jsx';
import { PageHead } from '../components/Common.jsx';
import { Confirm } from '../components/Modal.jsx';
import { SubscribeModal, planName, paidPlan } from '../components/Subscription.jsx';
import { planList, planOf } from '../lib/billing.js';
import { CapturePanel } from '../components/PhoneCapture.jsx';
import { parseStatement, toTransactions, readFileText } from '../lib/importer.js';
import { categoriesFor, BILL_PAYMENT, guessCategory } from '../lib/categories.js';
import { invoiceForPayment } from '../lib/ledger.js';
import { formatDate } from '../lib/format.js';

const BANKS_PT = ['Nubank', 'Itaú', 'Bradesco', 'Banco do Brasil', 'Caixa', 'Santander', 'Inter', 'C6 Bank', 'PicPay', 'Mercado Pago'];
const BANKS_EN = ['Chase', 'Bank of America', 'Wells Fargo', 'Capital One', 'Citi', 'US Bank', 'Revolut', 'Wise'];
const TYPES = ['expense', 'income', 'invest', 'redeem'];

/**
 * Why a new bank can't be connected now (null = it can). Banks cost money every month, so they come with Plus and
 * Premium, from the first payment on; the server has the last word (this only explains it ahead of time).
 */
export function bankBlock(cfg, e, used) {
  if (!cfg?.billing?.enabled) return { block: null, cap: null };
  if (e.status !== 'active') return { block: 'trial', cap: 0 };
  const paid = paidPlan(e);
  const cap = paid ? planOf(cfg, paid)?.banks ?? 0 : e.banks ?? planOf(cfg, e.plan)?.banks ?? null;
  if (cap === 0) return { block: 'essencial', cap };
  if (e.kind === 'trialing') return { block: 'first_payment', cap };
  if (e.kind === 'past_due') return { block: 'payment_failed', cap };
  if (cap != null && used >= cap) return { block: 'full', cap };
  return { block: null, cap };
}
/** A refusal from the server (402 bank_limit) in the same words. */
const blockOfError = (er) => (er.data?.reason === 'plan' ? (er.data?.limit ? 'full' : 'essencial') : er.data?.reason || 'essencial');

function OpenFinance() {
  const {
    t, lang, connections, connectBank, syncConnection, disconnectBank, syncing, ofMode, entitlement, toast, isArtifact, serverCfg,
    startPlanNow, openPortal, refreshLicense,
  } = useStore();
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(null);
  const [subscribe, setSubscribe] = useState(null);
  const real = connections.filter((c) => !c.demo && c.paused !== 'removed');
  const { block, cap } = ofMode === 'live' ? bankBlock(serverCfg, entitlement, real.length) : { block: null, cap: null };
  const plans = planList(serverCfg);
  const top = plans[plans.length - 1];
  const nextPlan = plans.find((p) => p.banks > (cap || 0)) || top;
  const day = (ms) => formatDate(new Date(ms).toISOString().slice(0, 10), lang);
  const limitText = (b) => {
    if (b === 'first_payment') return t('of.lim.first_payment', { d: entitlement.periodEnd ? day(entitlement.periodEnd) : '—' });
    if (b === 'full') return t(cap >= (top?.banks || 0) ? 'of.lim.fullTop' : 'of.lim.full', { n: cap });
    return t(`of.lim.${b}`);
  };
  const ofErr = (e) => {
    if (e.code === 'bank_limit') { refreshLicense({ force: true }); return limitText(blockOfError(e)); }
    if (e.status === 404) return t('of.pausedHint.removed');
    return t(`of.err.${e.code}`) !== `of.err.${e.code}` ? t(`of.err.${e.code}`) : t('of.err.generic');
  };

  const connect = async () => {
    setBusy(true);
    try {
      const conn = await connectBank();
      if (conn) {
        const r = await syncConnection(conn);
        toast(t('of.synced', { n: r.added, a: r.assets }));
      }
    } catch (e) {
      // Pluggy's test bank on the official site: the app removes it (and says so) by itself.
      if (e.code !== 'sandbox_item') toast(ofErr(e), 'err');
    }
    setBusy(false);
  };
  const resync = async (c) => {
    try { const r = await syncConnection(c); toast(t('of.synced', { n: r.added, a: r.assets })); }
    catch (e) { if (e.code !== 'sandbox_item') toast(ofErr(e), 'err'); }
  };
  const payNow = async () => {
    setBusy(true);
    try { await startPlanNow(); toast(t('plan.paidNow')); } catch (e) { toast(t(`bill.err.${e.code}`) !== `bill.err.${e.code}` ? t(`bill.err.${e.code}`) : t('bill.err.generic'), 'err'); }
    setBusy(false);
  };
  const portal = async () => { setBusy(true); try { await openPortal(); } catch { toast(t('bill.err.generic'), 'err'); setBusy(false); } };

  return (
    <section className="panel of-panel">
      <div className="panel-head">
        <h2><Landmark size={18} /> {t('of.title')}</h2>
      </div>
      <p className="muted">{t('of.text')}</p>

      {ofMode === 'live' && cap > 0 && (
        <p className="of-usage"><Landmark size={14} /> {t('of.usage', { p: planName(t, paidPlan(entitlement) || entitlement.plan), u: Math.min(real.length, cap), n: cap })}</p>
      )}

      {connections.map((c) => (
        <div className={`conn ${c.paused ? 'paused' : ''}`} key={c.id}>
          <div className="conn-logo" style={{ '--c': c.color }}>{c.imageUrl ? <img src={c.imageUrl} alt="" /> : c.name.slice(0, 1)}</div>
          <div className="conn-main">
            <b>{c.name}{c.paused && <em className="pill-off"><PauseCircle size={11} /> {t(c.paused === 'removed' ? 'of.removed' : 'of.paused')}</em>}</b>
            <span>{c.paused ? t(`of.pausedHint.${c.paused}`) !== `of.pausedHint.${c.paused}` ? t(`of.pausedHint.${c.paused}`) : t('of.pausedHint.plan')
              : c.lastSync ? t('of.lastSync', { d: new Intl.DateTimeFormat(lang === 'pt' ? 'pt-BR' : 'en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(c.lastSync)) }) : t('of.never')}</span>
          </div>
          <button className="icon-btn" onClick={() => resync(c)} disabled={syncing === c.id} aria-label={t('of.sync')} title={t('of.sync')}>
            <RefreshCw size={16} className={syncing === c.id ? 'spin' : ''} />
          </button>
          <button className="icon-btn" onClick={() => setDel(c)} aria-label={t('of.disconnect')} title={t('of.disconnect')}><Unplug size={16} /></button>
        </div>
      ))}

      {ofMode === 'live' && block && (
        <div className="of-limit">
          <p><Info size={15} /> <span>{limitText(block)}</span></p>
          <div className="btn-row wrap">
            {block === 'first_payment' && <button className="primary" onClick={payNow} disabled={busy}><Landmark size={16} /> {t('plan.payNow')}</button>}
            {(block === 'trial' || block === 'essencial' || (block === 'full' && cap < (top?.banks || 0))) && (
              <button className="primary" onClick={() => setSubscribe(nextPlan?.id || 'plus')}><Crown size={16} /> {t('of.seePlans')}</button>
            )}
            {block === 'payment_failed' && <button className="secondary" onClick={portal} disabled={busy}><ExternalLink size={16} /> {t('bill.manage')}</button>}
          </div>
        </div>
      )}
      {ofMode === 'live' ? (!block && (
        <button className="primary" onClick={connect} disabled={busy}>
          <Plus size={17} /> {busy ? t('of.connecting') : t('of.connect')}
        </button>
      )) : (
        <p className="of-off"><Clock size={16} /> {t(isArtifact || !serverCfg ? 'of.unavailableLocal' : 'of.unavailable')}</p>
      )}
      <ul className="of-facts">
        <li><ShieldCheck size={15} /> {t('of.fact1')}</li>
        <li><Check size={15} /> {t('of.fact2')}</li>
        <li><Unplug size={15} /> {t('of.fact3')}</li>
      </ul>

      {del && (
        <Confirm title={t('of.disconnectTitle', { b: del.name })} text={t('of.disconnectText')} danger confirmLabel={t('of.disconnect')} cancelLabel={t('common.cancel')}
          onClose={() => setDel(null)} onConfirm={async () => { try { await disconnectBank(del); toast(t('of.disconnected')); } catch { toast(t('of.err.generic'), 'err'); } }} />
      )}
      {subscribe && <SubscribeModal plan={subscribe} onClose={() => setSubscribe(null)} />}
    </section>
  );
}

/** Adapts the parsed rows to where they are going: an account (bank statement) or a card (card bill). */
function adaptTo(list, dest, cards) {
  const [kind, id] = [dest.slice(0, dest.indexOf(':')), dest.slice(dest.indexOf(':') + 1)];
  return list.map((x) => {
    const bill = BILL_PAYMENT.test(x.description);
    if (kind === 'card') {
      // On the card bill, the payment line is the money that came from the bank: not a purchase, not income.
      if (bill) return { ...x, type: 'skip', selected: false };
      if (x.type === 'invest') return { ...x, type: 'expense', category: guessCategory(x.description, 'expense') };
      if (x.type === 'redeem') return { ...x, type: 'income', category: 'other_income' };
      return x;
    }
    if (bill && x.type === 'expense' && cards.length) {
      const card = cards.find((c) => c.payFrom === id) || cards[0];
      return { ...x, type: 'cardpay', toCardId: card.id, category: 'transfer' };
    }
    return x;
  });
}

export default function Import({ go }) {
  const { t, lang, money, txs, importTxs, toast, activeAccounts, activeCards } = useStore();
  const [dest, setDest] = useState('acc:main');
  const fileRef = useRef();
  const [rows, setRows] = useState(null);
  const [items, setItems] = useState([]);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [positiveIsExpense, setPIE] = useState(false);
  const [drag, setDrag] = useState(false);
  // #capture (home-screen shortcut, notifications) opens the phone setup right away.
  const [autoCapture] = useState(() => window.location.hash === '#capture');
  useEffect(() => { if (autoCapture) window.history.replaceState(null, '', '#import'); }, [autoCapture]);

  const existing = useMemo(() => new Set(txs.map((x) => x.importId).filter(Boolean)), [txs]);

  const build = (raw, pie, to = dest) => {
    const list = toTransactions(raw, { positiveIsExpense: pie }).map((x) => ({ ...x, dup: existing.has(x.importId), selected: !existing.has(x.importId) }));
    setItems(adaptTo(list, to, activeCards).map((x) => (x.dup ? { ...x, selected: false } : x)).sort((a, b) => b.date.localeCompare(a.date)));
  };

  const handleFile = async (file) => {
    if (!file) return;
    setError('');
    setFileName(file.name);
    try {
      const text = await readFileText(file);
      const res = parseStatement(text, file.name, lang);
      if (res.error) { setRows(null); setItems([]); return setError(t(`imp.err.${res.error}`)); }
      // Card bills usually list purchases as positive numbers (and the payment as negative).
      const positives = res.rows.filter((r) => r.amount > 0).length;
      const looksLikeCard = positives > res.rows.length / 2;
      const to = looksLikeCard && activeCards.length ? `card:${activeCards[0].id}` : 'acc:main';
      setPIE(looksLikeCard);
      setRows(res.rows);
      setDest(to);
      build(res.rows, looksLikeCard, to);
    } catch (e) {
      console.error(e);
      setError(t('imp.err.read'));
    }
  };

  const selected = items.filter((x) => x.selected);
  const totals = selected.reduce((a, x) => { a[x.type] = (a[x.type] || 0) + x.amount; return a; }, { income: 0, expense: 0, invest: 0, redeem: 0, cardpay: 0 });
  const toCard = dest.startsWith('card:');
  const types = toCard ? ['expense', 'income'] : [...TYPES, ...(activeCards.length ? ['cardpay'] : [])];
  const update = (i, patch) => setItems((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const changeType = (i, type) => update(i, type === 'cardpay'
    ? { type, category: 'transfer', toCardId: items[i].toCardId || activeCards[0]?.id }
    : { type, category: categoriesFor(type)[type === 'redeem' ? 2 : 0].key });

  const doImport = async () => {
    const id = dest.slice(dest.indexOf(':') + 1);
    const n = await importTxs(selected, toCard ? { cardId: id } : { accountId: id });
    toast(t('imp.done', { n }));
    setRows(null); setItems([]); setFileName('');
    go('spend');
  };

  const banks = lang === 'pt' ? BANKS_PT : BANKS_EN;

  return (
    <div className="page">
      <PageHead title={t('conn.title')} sub={t('conn.sub')} />

      {!rows && (
        <>
          <CapturePanel autoOpen={autoCapture} />

          <OpenFinance />

          <h3 className="section-title">{t('imp.fileTitle')}</h3>
          <section
            className={`drop ${drag ? 'drag' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}
            role="button" tabIndex={0}
          >
            <FileUp size={40} />
            <h2>{t('imp.choose')}</h2>
            <p>{t('imp.formats')}</p>
            <input ref={fileRef} type="file" accept=".ofx,.qfx,.csv,.txt,text/csv,application/x-ofx" hidden onChange={(e) => { handleFile(e.target.files[0]); e.target.value = ''; }} />
          </section>
          {error && <p className="form-error center">{fileName}: {error}</p>}

          <ol className="steps">
            <li>{t('imp.step1')}</li>
            <li>{t('imp.step2')}</li>
            <li>{t('imp.step3')}</li>
          </ol>
          <div className="bank-list">
            {banks.map((b) => <div className="bank" key={b}><div><Building2 size={19} /><b>{b}</b></div><Check size={16} /></div>)}
          </div>
          <section className="trust"><Info size={18} /> {t('imp.trust')}</section>
        </>
      )}

      {rows && (
        <>
          <section className="import-summary">
            <div>
              <b>{fileName}</b>
              <span>{t('imp.found', { n: items.length, d: items.filter((x) => x.dup).length })}</span>
            </div>
            <label className="field">{t('imp.dest')}
              <select value={dest} onChange={(e) => {
                const to = e.target.value;
                const pie = to.startsWith('card:') ? rows.filter((r) => r.amount > 0).length > rows.length / 2 : false;
                setDest(to); setPIE(pie); build(rows, pie, to);
              }}>
                <optgroup label={t('wal.accounts')}>{activeAccounts.map((a) => <option key={a.id} value={`acc:${a.id}`}>{a.name}</option>)}</optgroup>
                {activeCards.length > 0 && <optgroup label={t('wal.cards')}>{activeCards.map((c) => <option key={c.id} value={`card:${c.id}`}>{c.name}</option>)}</optgroup>}
              </select>
            </label>
            <p className="hint">{toCard ? t('imp.destCardHint') : t('imp.destAccHint')}</p>
            <button className={`toggle compact ${positiveIsExpense ? 'on' : ''}`} onClick={() => { setPIE(!positiveIsExpense); build(rows, !positiveIsExpense); }}>
              <span>{t('imp.cardMode')}<small>{t('imp.cardModeHint')}</small></span><i />
            </button>
          </section>

          <div className="import-actions">
            <button className="ghost" onClick={() => setItems((l) => l.map((x) => ({ ...x, selected: true })))}>{t('imp.selectAll')}</button>
            <button className="ghost" onClick={() => setItems((l) => l.map((x) => ({ ...x, selected: false })))}>{t('imp.selectNone')}</button>
            <span className="muted">{t('imp.selected', { n: selected.length })} · <span className="positive">+{money(totals.income + totals.redeem)}</span> · −{money(totals.expense + totals.invest + totals.cardpay)}</span>
          </div>
          {selected.some((x) => x.type === 'invest' || x.type === 'redeem') && <p className="hint debit-note">{t('imp.investFound')}</p>}

          <section className="panel import-list">
            {items.map((x, i) => (
              <div className={`imp-row ${x.selected ? '' : 'off'}`} key={x.importId}>
                <button className={`check ${x.selected ? 'on' : ''}`} onClick={() => x.type !== 'skip' && update(i, { selected: !x.selected })} aria-label="select" disabled={x.type === 'skip'}><Check size={14} /></button>
                <div className="imp-main">
                  <b>{x.description}</b>
                  <span>{formatDate(x.date, lang)}{x.dup && <em> · {t('imp.dup')}</em>}{x.type === 'skip' && <em> · {t('imp.billSkipped')}</em>}</span>
                </div>
                <div className="imp-selects">
                  {x.type !== 'skip' && (
                    <select value={x.type} onChange={(e) => changeType(i, e.target.value)} aria-label={t('imp.type')}>
                      {types.map((ty) => <option key={ty} value={ty}>{ty === 'cardpay' ? t('tx.invoicePayment') : t(`txtype.${ty}`)}</option>)}
                    </select>
                  )}
                  {x.type === 'cardpay' && activeCards.length > 1 && (
                    <select value={x.toCardId} onChange={(e) => update(i, { toCardId: e.target.value })} aria-label={t('tx.to')}>
                      {activeCards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  )}
                  {(x.type === 'expense' || x.type === 'income') && (
                    <select value={x.category} onChange={(e) => update(i, { category: e.target.value })} aria-label={t('tx.category')}>
                      {categoriesFor(x.type).map((c) => <option key={c.key} value={c.key}>{t(`cat.${c.key}`)}</option>)}
                    </select>
                  )}
                </div>
                <strong className={x.type === 'income' || x.type === 'redeem' ? 'positive' : x.type === 'invest' ? 'invest-out' : x.type === 'skip' || x.type === 'cardpay' ? 'neutral' : ''}>
                  {x.type === 'income' || x.type === 'redeem' ? '+' : '−'}{money(x.amount)}
                </strong>
              </div>
            ))}
          </section>

          <div className="btn-row sticky-actions">
            <button className="ghost" onClick={() => { setRows(null); setItems([]); }}>{t('common.cancel')}</button>
            <button className="primary" disabled={!selected.length} onClick={doImport}>{t('imp.import', { n: selected.length })} <ArrowRight size={18} /></button>
          </div>
        </>
      )}
    </div>
  );
}
