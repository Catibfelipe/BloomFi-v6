import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, CornerDownLeft, Plus, ArrowLeftRight, CreditCard, Landmark, CalendarClock, TrendingUp } from 'lucide-react';
import { useStore } from '../store.jsx';
import { CatIcon } from './Common.jsx';
import { formatDate } from '../lib/format.js';

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Ctrl/Cmd + K: jump to any page, run an action or find a transaction. */
export default function CommandPalette({ nav, go, onClose }) {
  const { t, txs, money, lang, openTx } = useStore();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef();
  const listRef = useRef();

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 20); document.body.classList.add('no-scroll'); return () => document.body.classList.remove('no-scroll'); }, []);

  const results = useMemo(() => {
    const n = norm(q.trim());
    const match = (s) => !n || norm(s).includes(n);
    const actions = [
      { id: 'a-exp', icon: Plus, label: t('cmd.newExpense'), run: () => openTx({ type: 'expense' }) },
      { id: 'a-inc', icon: Plus, label: t('cmd.newIncome'), run: () => openTx({ type: 'income' }) },
      { id: 'a-trf', icon: ArrowLeftRight, label: t('cmd.transfer'), run: () => openTx({ type: 'transfer' }) },
      { id: 'a-inv', icon: TrendingUp, label: t('cmd.invest'), run: () => openTx({ type: 'invest' }) },
      { id: 'a-sch', icon: CalendarClock, label: t('cmd.schedule'), run: () => openTx({ type: 'expense', status: 'pending' }) },
      { id: 'a-card', icon: CreditCard, label: t('cmd.card'), run: () => go('wallet') },
      { id: 'a-acc', icon: Landmark, label: t('cmd.account'), run: () => go('wallet') },
    ].filter((a) => match(a.label)).map((a) => ({ ...a, group: 'actions' }));
    const pages = nav.filter(([, , label]) => match(t(label))).map(([key, Icon, label]) => ({ id: `p-${key}`, icon: Icon, label: t(label), group: 'pages', run: () => go(key) }));
    const found = n.length >= 2
      ? txs.filter((x) => match(x.description) || match(t(`cat.${x.category}`)) || String(x.amount).includes(n.replace(',', '.')))
        .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8)
        .map((x) => ({ id: `t-${x.id}`, tx: x, label: x.description || t(`cat.${x.category}`), group: 'txs', run: () => openTx(x) }))
      : [];
    return [...pages, ...actions, ...found];
  }, [q, nav, t, txs, openTx, go]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const run = (r) => { onClose(); setTimeout(r.run, 0); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter' && results[sel]) { e.preventDefault(); run(results[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };
  let lastGroup = null;

  return createPortal(
    <div className="cmd-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmd" role="dialog" aria-modal="true" aria-label={t('cmd.title')}>
        <div className="cmd-input">
          <Search size={18} />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder={t('cmd.placeholder')}
            role="combobox" aria-expanded="true" aria-controls="cmd-list" aria-activedescendant={results[sel]?.id} />
          <kbd>Esc</kbd>
        </div>
        <div className="cmd-list" id="cmd-list" role="listbox" ref={listRef}>
          {results.map((r, i) => {
            const head = r.group !== lastGroup ? <div className="cmd-group" key={`g-${r.group}`}>{t(`cmd.g.${r.group}`)}</div> : null;
            lastGroup = r.group;
            const Icon = r.icon;
            return (
              <React.Fragment key={r.id}>
                {head}
                <button id={r.id} role="option" aria-selected={i === sel} className={i === sel ? 'sel' : ''} onMouseEnter={() => setSel(i)} onClick={() => run(r)}>
                  {r.tx ? <CatIcon category={r.tx.type === 'transfer' ? 'transfer' : r.tx.category} size={14} /> : <span className="cmd-ico"><Icon size={16} /></span>}
                  <span className="cmd-label">{r.label}{r.tx && <small>{formatDate(r.tx.date, lang)}</small>}</span>
                  {r.tx ? <b className={r.tx.type === 'income' || r.tx.type === 'redeem' ? 'positive' : ''}>{money(r.tx.amount)}</b> : i === sel && <CornerDownLeft size={14} className="cmd-enter" />}
                </button>
              </React.Fragment>
            );
          })}
          {!results.length && <p className="muted cmd-empty">{t('cmd.none')}</p>}
        </div>
        <div className="cmd-foot"><span><kbd>↑</kbd><kbd>↓</kbd> {t('cmd.move')}</span><span><kbd>Enter</kbd> {t('cmd.open')}</span></div>
      </div>
    </div>,
    document.body,
  );
}
