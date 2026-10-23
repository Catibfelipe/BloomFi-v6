import React, { useMemo, useState } from 'react';
import { Plus, Search, ReceiptText } from 'lucide-react';
import { useStore } from '../store.jsx';
import { MonthSwitcher, TxRow, Empty, PageHead } from '../components/Common.jsx';
import { WeekBars } from '../components/Charts.jsx';
import { lastDays, summarize } from '../lib/finance.js';
import { todayISO, currentMonth, daysInMonth } from '../lib/dates.js';
import { formatDate, formatMonth } from '../lib/format.js';
import { categoriesFor } from '../lib/categories.js';

export default function Spend() {
  const { txs, month, t, money, lang, openTx, activeAccounts, activeCards } = useStore();
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [cat, setCat] = useState('');
  const [where, setWhere] = useState('');

  const today = todayISO();
  const endDay = month === currentMonth() ? today : `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  const week = useMemo(() => lastDays(txs, 7, endDay), [txs, endDay]);
  const weekTotal = week.reduce((a, d) => a + d.amount, 0);
  const sum = useMemo(() => summarize(txs, month), [txs, month]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return txs
      .filter((x) => x.date.startsWith(month))
      .filter((x) => type === 'all' || x.type === type || (type === 'invest' && x.type === 'redeem') || (type === 'pending' && x.status === 'pending'))
      .filter((x) => !cat || x.category === cat)
      .filter((x) => {
        if (!where) return true;
        const [kind, id] = [where.slice(0, where.indexOf(':')), where.slice(where.indexOf(':') + 1)];
        if (kind === 'card') return x.cardId === id || x.toCardId === id;
        return (!x.cardId && (x.accountId || 'main') === id) || x.toAccountId === id;
      })
      .filter((x) => !needle || (x.description || '').toLowerCase().includes(needle) || t(`cat.${x.category}`).toLowerCase().includes(needle))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  }, [txs, month, q, type, cat, where, t]);

  const groups = useMemo(() => {
    const g = [];
    for (const tx of list) {
      if (!g.length || g[g.length - 1].date !== tx.date) g.push({ date: tx.date, items: [], total: 0 });
      const cur = g[g.length - 1];
      cur.items.push(tx);
      if (tx.type !== 'transfer' && tx.status !== 'pending') cur.total += tx.type === 'income' || tx.type === 'redeem' ? tx.amount : -tx.amount;
    }
    return g;
  }, [list]);

  const dayLabel = (iso) => new Intl.DateTimeFormat(lang === 'pt' ? 'pt-BR' : 'en-US', { weekday: 'narrow' }).format(new Date(`${iso}T12:00`));

  return (
    <div className="page">
      <PageHead title={t('spend.title')} sub={t('spend.sub')}><MonthSwitcher /></PageHead>
      <button className="primary add-wide" onClick={() => openTx({})}><Plus size={18} /> {t('tx.add')}</button>

      <div className="two-col">
        <section className="spend-chart">
          <div>
            <b>{money(weekTotal)}</b>
            <span>{t('spend.week')}</span>
          </div>
          <WeekBars days={week} label={dayLabel} money={money} today={today} />
        </section>
        <section className="month-totals">
          <div><span>{t('home.income')}</span><b className="positive">{money(sum.income)}</b></div>
          <div><span>{t('home.spent')}</span><b>{money(sum.expense)}</b></div>
          <div><span>{t('home.invested')}</span><b className="invest-out">{money(sum.netInvested)}</b></div>
          <div><span>{t('spend.balance')}</span><b className={sum.net < 0 ? 'neg-red' : ''}>{money(sum.net)}</b></div>
        </section>
      </div>

      <div className="filters">
        <div className="search"><Search size={16} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('spend.search')} /></div>
        <div className="chips">
          {['all', 'expense', 'income', 'invest', 'transfer', 'pending'].map((k) => (
            <button key={k} className={type === k ? 'on' : ''} onClick={() => { setType(k); setCat(''); }}>{t(`spend.f.${k}`)}</button>
          ))}
          {activeAccounts.length + activeCards.length > 1 && (
            <select value={where} onChange={(e) => setWhere(e.target.value)} aria-label={t('spend.where')}>
              <option value="">{t('spend.allWhere')}</option>
              {activeAccounts.map((a) => <option key={a.id} value={`acc:${a.id}`}>{a.name}</option>)}
              {activeCards.map((c) => <option key={c.id} value={`card:${c.id}`}>{c.name}</option>)}
            </select>
          )}
          {(type === 'all' || type === 'expense' || type === 'income') && <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t('tx.category')}>
            <option value="">{t('spend.allCats')}</option>
            {(type === 'income' ? categoriesFor('income') : type === 'expense' ? categoriesFor('expense') : [...categoriesFor('expense'), ...categoriesFor('income')])
              .map((c) => <option key={c.key} value={c.key}>{t(`cat.${c.key}`)}</option>)}
          </select>}
        </div>
      </div>

      {groups.length ? (
        <section className="panel list-panel">
          {groups.map((g) => (
            <div key={g.date} className="day-group">
              <div className="day-head">
                <span>{formatDate(g.date, lang, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
                <span className={g.total > 0 ? 'positive' : ''}>{g.total ? money(g.total, { sign: true }) : ''}</span>
              </div>
              {g.items.map((tx) => <TxRow key={tx.id} tx={tx} />)}
            </div>
          ))}
        </section>
      ) : (
        <Empty icon={ReceiptText} text={q || cat || type !== 'all' ? t('spend.noMatch') : t('spend.empty', { m: formatMonth(month, lang) })}
          action={t('tx.add')} onAction={() => openTx({})} />
      )}
    </div>
  );
}
