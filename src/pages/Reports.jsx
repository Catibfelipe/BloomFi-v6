import React, { useMemo } from 'react';
import { Sparkles, TrendingDown, TrendingUp, CalendarDays, CircleCheck, Zap, BarChart3, Printer } from 'lucide-react';
import { useStore } from '../store.jsx';
import { MonthSwitcher, PageHead, CatIcon, Empty } from '../components/Common.jsx';
import { TrendBars, Progress, Donut } from '../components/Charts.jsx';
import { analyze, trend } from '../lib/finance.js';
import { formatMonth, formatDate } from '../lib/format.js';
import { todayISO } from '../lib/dates.js';

export default function Reports() {
  const { txs, budgets, goals, month, t, money, lang, openTx, isArtifact, settings, ledger } = useStore();
  const a = useMemo(() => analyze({ txs, budgets, goals }, month), [txs, budgets, goals, month]);
  const tr = useMemo(() => trend(txs, month, 6), [txs, month]);
  const s = a.sum;

  if (!txs.length) {
    return (
      <div className="page">
        <PageHead title={t('rep.title')} sub={t('rep.sub')} />
        <Empty icon={BarChart3} text={t('rep.empty')} action={t('tx.add')} onAction={() => openTx({})} />
      </div>
    );
  }

  const insights = [];
  if (s.byCategory.length) {
    const top2 = s.byCategory.slice(0, 2);
    const p = Math.round(top2.reduce((x, c) => x + c.pct, 0));
    insights.push({ icon: Sparkles, title: t('rep.whereTitle'), text: t('rep.whereText', { a: t(`cat.${top2[0].key}`), b: top2[1] ? t(`cat.${top2[1].key}`) : '', p, one: top2.length === 1 }) });
  }
  if (a.shortDays) insights.push({ icon: TrendingDown, danger: true, title: t('rep.riskTitle'), text: t('rep.riskText', { n: a.shortDays }) });
  else if (s.income > 0 && s.isCurrent) insights.push({ icon: CircleCheck, title: t('rep.okTitle'), text: t('rep.okText', { v: money(s.income - s.projectedExpense - s.netInvested) }) });
  if (a.expenseChange !== null && s.expense > 0) {
    const up = a.expenseChange > 0;
    insights.push({ icon: up ? TrendingUp : TrendingDown, danger: up && a.expenseChange > 10, title: t('rep.vsTitle'), text: t(up ? 'rep.vsUp' : 'rep.vsDown', { p: Math.abs(Math.round(a.expenseChange)) }) });
  }
  if (s.income > 0) {
    const ip = (s.netInvested / s.income) * 100;
    insights.push({ icon: TrendingUp, title: t('rep.investTitle'), text: s.netInvested > 0 ? t('rep.investText', { v: money(s.netInvested), p: Math.round(ip) }) : t('rep.investNone') });
  }
  if (a.over.length) insights.push({ icon: Zap, danger: true, title: t('rep.overTitle'), text: t('warn.overText', { cats: a.over.map((b) => t(`cat.${b.category}`)).join(', ') }) });

  return (
    <div className="page">
      <PageHead title={t('rep.title')} sub={t('rep.sub')}>
        <MonthSwitcher />
        {!isArtifact && <button className="secondary slim" onClick={() => window.print()}><Printer size={16} /> {t('rep.pdf')}</button>}
      </PageHead>

      <div className="print-head">
        <b>BloomFi · {t('rep.printTitle', { m: formatMonth(month, lang) })}</b>
        <span>{settings.name ? `${settings.name} · ` : ''}{t('rep.printDate', { d: formatDate(todayISO(), lang) })}</span>
      </div>

      <section className="report-summary">
        <div><span>{t('home.income')}</span><b className="positive">{money(s.income)}</b></div>
        <div><span>{t('home.spent')}</span><b>{money(s.expense)}</b></div>
        <div><span>{t('home.invested')}</span><b className="invest-out">{money(s.netInvested)}</b></div>
        <div><span>{t('spend.balance')}</span><b className={s.net < 0 ? 'neg-red' : ''}>{money(s.net)}</b></div>
        <div><span>{t('home.saved')}</span><b>{s.income ? `${Math.max(Math.round(s.savingsRate), 0)}%` : '—'}</b></div>
        <div><span>{t('home.cash')}</span><b>{money(ledger.cash)}</b></div>
      </section>

      <div className="two-col">
        <div>
          {insights.map((i, k) => {
            const Icon = i.icon;
            return <section key={k} className={`insight ${i.danger ? 'danger' : ''}`}><Icon /><div><b>{i.title}</b><p>{i.text}</p></div></section>;
          })}
          <section className="report-grid">
            <div><CalendarDays /><b>{t('rep.streak', { n: a.streak })}</b><span>{t('rep.streakSub')}</span></div>
            <div><CircleCheck /><b>{t('rep.saved')}</b><span>{money(Math.max(s.saved, 0))} · {s.income ? `${Math.max(Math.round(s.savingsRate), 0)}%` : '—'}</span></div>
            <div><Zap /><b>{t('rep.next')}</b><span>{s.income ? (a.cutPerDay > 0 ? t('rep.cut', { v: money(a.cutPerDay) }) : t('rep.keep')) : t('rep.logIncome')}</span></div>
          </section>
        </div>

        <div>
          <section className="panel">
            <div className="panel-head"><h2>{t('rep.trend')}</h2>
              <div className="key"><i className="inc" />{t('home.income')}<i className="exp" />{t('home.spent')}<i className="inv" />{t('home.invested')}</div>
            </div>
            <TrendBars data={tr} money={money} label={(mk) => formatMonth(mk, lang, true).replace(/ de \d+|\s\d{4}|\.$/g, '').replace('.', '')} />
          </section>

          <section className="panel">
            <div className="panel-head"><h2>{t('rep.categories')}</h2><span className="muted">{formatMonth(month, lang)}</span></div>
            {s.byCategory.length ? (
              <>
                <div className="center-donut"><Donut data={s.byCategory} size={170} center={money(s.expense, { compact: s.expense >= 10000 })} sub={t('home.spent')} /></div>
                {s.byCategory.map((c) => (
                  <div className="cat-line" key={c.key}>
                    <CatIcon category={c.key} size={16} />
                    <div className="cat-line-main">
                      <div><span>{t(`cat.${c.key}`)}</span><b>{money(c.amount)}</b></div>
                      <Progress pct={c.pct} />
                    </div>
                    <small>{Math.round(c.pct)}%</small>
                  </div>
                ))}
              </>
            ) : <p className="muted">{t('home.noSpend')}</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
