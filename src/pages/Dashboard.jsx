import React, { useMemo, useState } from 'react';
import {
  Target, ReceiptText, Flame, PieChart, HeartPulse, Trophy, Plus, Landmark, ChevronRight,
  TriangleAlert, X, TrendingUp, ShieldCheck, CalendarDays, CreditCard, Smartphone,
} from 'lucide-react';
import { TrialBanner } from '../components/Subscription.jsx';
import { ReviewBanner } from '../components/PhoneCapture.jsx';
import { InstallHelp } from '../components/InstallHelp.jsx';
import { useInstall } from '../lib/pwa.js';
import { portfolio } from '../lib/investments.js';
import { useStore } from '../store.jsx';
import Wally from '../components/Wally.jsx';
import { MonthSwitcher, TxRow, CatIcon, StatusPill } from '../components/Common.jsx';
import { Donut, Progress, AreaChart } from '../components/Charts.jsx';
import { AgendaRow } from './Agenda.jsx';
import { ForecastCard, SubsCard } from '../components/Forecast.jsx';
import { TopAlert } from '../components/Alerts.jsx';
import { SpaceRequestsBanner } from '../components/Spaces.jsx';
import { PayInvoiceForm } from '../components/WalletSheets.jsx';
import { analyze, achievements, wallyMood, goalInfo, withForecast } from '../lib/finance.js';
import { balanceHistory, monthProjection } from '../lib/ledger.js';
import { wallyLine } from '../lib/advisor.js';
import { formatMonth, formatDate } from '../lib/format.js';

const ACH_ICONS = { goalSetter: Target, firstLog: ReceiptText, streak7: Flame, budgetCheck: PieChart, save10: HeartPulse, goalDone: Trophy, investor: TrendingUp };

export default function Dashboard({ go }) {
  const {
    txs, budgets, goals, assets, accounts, cards, month, t, money, lang, settings, updateSettings, openTx, toast, vaultInfo, ledger, activeCards,
    serverMode, session, rules, forecast,
  } = useStore();
  const [paying, setPaying] = useState(null);
  const [installHelp, setInstallHelp] = useState(false);
  const install = useInstall();
  // Phones: the installed app keeps data safer from cleanup, gets notifications (iPhone) and opens like an app.
  const showInstall = !install.installed && install.platform !== 'desktop' && !settings.dismissed?.install5;
  const hist = useMemo(() => balanceHistory({ accounts, txs }, 30, ledger.today), [accounts, txs, ledger.today]);
  const proj = useMemo(() => monthProjection({ accounts, txs, cards }, ledger.today), [accounts, txs, cards, ledger.today]);
  const change = hist.length > 1 ? hist[hist.length - 1].value - hist[0].value : 0;
  // v5: phone payments arrive by themselves (shown until the user connects a phone or closes it).
  const hasLink = rules.some((r) => r.kind === 'link');
  const showNews = serverMode && !hasLink && !settings.dismissed?.news5;
  // The most important missing protection, one at a time.
  const nudge = !serverMode ? null
    : settings.recoverySaved === false ? 'rk'
      : !vaultInfo.hasPin && !vaultInfo.hasBio ? 'quick'
        : session.user && !session.user.twoFactor && txs.length > 0 ? 'tfa' : null;
  const showNudge = nudge && !settings.dismissed?.[`nudge5-${nudge}`];
  const pf = useMemo(() => portfolio(assets, txs), [assets, txs]);
  const a = useMemo(() => withForecast(analyze({ txs, budgets, goals }, month), forecast, ledger.today), [txs, budgets, goals, month, forecast, ledger.today]);
  const s = a.sum;
  const mood = wallyMood(a, s.count > 0);
  const [l1, l2] = wallyLine(a, mood, lang);
  const ach = achievements({ txs, goals, budgets, sum: s, streak: a.streak });
  const recent = useMemo(
    () => txs.filter((x) => x.date.startsWith(month) && x.date <= ledger.today).sort((x, y) => y.date.localeCompare(x.date) || (y.createdAt || 0) - (x.createdAt || 0)).slice(0, 6),
    [txs, month, ledger.today]
  );
  const upcoming = ledger.agenda.slice(0, 5);

  // Most important warning for this month
  const warning = (() => {
    if (!s.count) return null;
    if (a.over.length) return { key: `over-${month}`, title: t('warn.overTitle'), text: t('warn.overText', { cats: a.over.map((b) => t(`cat.${b.category}`)).join(', ') }) };
    if (s.income > 0 && s.saved < 0) return { key: `neg-${month}`, title: t('warn.negTitle'), text: t('warn.negText', { v: money(-s.saved) }) };
    if (a.shortDays) return { key: `short-${month}`, title: t('warn.shortTitle'), text: t('warn.shortText', { n: a.shortDays }) };
    if (s.income > 0 && s.savingsRate < 20) return { key: `low-${month}`, title: t('warn.lowTitle'), text: t('warn.lowText', { p: Math.max(Math.round(s.savingsRate), 0) }) };
    if (!s.income && s.expense) return { key: `noinc-${month}`, title: t('warn.noIncTitle'), text: t('warn.noIncText') };
    return null;
  })();
  const showWarning = warning && !settings.dismissed?.[warning.key];

  const bs = a.bs.slice(0, 4);
  const hello = settings.name ? t('home.hello', { name: settings.name }) : t('home.title');

  return (
    <div className="dash">
      <div className="dash-top">
        <div>
          <p className="eyebrow">{formatMonth(month, lang).toUpperCase()}</p>
          <h1>{hello}</h1>
        </div>
        <MonthSwitcher />
      </div>

      <TrialBanner />
      <ReviewBanner />
      <SpaceRequestsBanner go={go} />
      <div className="dash-grid">
        <div className="col">
          <section className="advisor-card" onClick={() => go('ai')} role="button" tabIndex={0}>
            <Wally mood={mood} size={48} />
            <div className="bubble"><b>{l1}</b><br />{l2}<span>— Wally, {t('brand.owl')} 🦉</span></div>
          </section>
          <TopAlert go={go} />

          {showWarning && (
            <section className="warning">
              <button aria-label="dismiss" onClick={() => updateSettings({ dismissed: { ...settings.dismissed, [warning.key]: true } })}><X size={16} /></button>
              <div className="warn-icon"><TriangleAlert size={18} /></div>
              <div><b>{warning.title}</b><p>{warning.text}</p></div>
            </section>
          )}

          <section className="balance-card">
            <span>{t('home.net')}</span>
            <h2>{money(s.net)}</h2>
            <p>{s.net >= 0 ? `✅ ${t('home.ahead', { v: money(s.net) })}` : `⚠️ ${t('home.behind', { v: money(-s.net) })}`}</p>
            <div className="metrics">
              <div>{t('home.income')}<b>{money(s.income)}</b></div>
              <div>{t('home.spent')}<b>{money(s.expense)}</b></div>
              <div>{s.netInvested < 0 ? t('home.redeemed') : t('home.invested')}<b>{money(Math.abs(s.netInvested))}</b></div>
              <div>{t('home.saved')}<b>{s.income ? `${Math.round(s.savingsRate)}%` : '—'}</b></div>
            </div>
            {s.isCurrent && s.net > 0 && <p className="daily-left">{t('home.dailyLeftLine', { v: money(s.dailyLeft) })}</p>}
            <button onClick={() => openTx({})} className="floating-mini" aria-label={t('tx.add')}><Plus size={24} /></button>
          </section>

          <section className="panel accounts-card" onClick={() => go('wallet')} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && go('wallet')}>
            <div className="accounts-top">
              <div>
                <span>{t('home.cash')}</span>
                <b className={ledger.cash < 0 ? 'neg-red' : ''}>{money(ledger.cash)}</b>
                <small>{change >= 0 ? '+' : '−'}{money(Math.abs(change))} {t('home.in30')}</small>
              </div>
              <ChevronRight size={18} />
            </div>
            <AreaChart data={hist} height={70} format={(v) => money(v)} dateLabel={(d) => formatDate(d, lang, { day: 'numeric', month: 'short' })} ariaLabel={t('home.chartLabel')} />
            <div className="accounts-row">
              <div><span>{t('home.endOfMonth')}</span><b className={proj.projected < 0 ? 'neg-red' : ''}>{money(proj.projected)}</b></div>
              <div><span>{t('home.cardsOpen')}</span><b>{money(ledger.cardDebt)}</b></div>
              <div><span>{t('nav.invest')}</span><b>{money(pf.value)}</b></div>
            </div>
          </section>

          <ForecastCard />

          {showNews && (
            <section className="news phone">
              <Smartphone size={22} />
              <div><b>{t('news5.title')}</b><p>{t('news5.text')}</p></div>
              <button className="secondary" onClick={() => go('import')}>{t('news5.cta')}</button>
              <button className="nudge-x" aria-label={t('common.dismiss')} onClick={() => updateSettings({ dismissed: { ...settings.dismissed, news5: true } })}><X size={14} /></button>
            </section>
          )}

          <section className="quick-row">
            {ach.map((x) => {
              const Icon = ACH_ICONS[x.key];
              return (
                <button key={x.key} className={x.done ? 'selected' : ''} onClick={() => toast(`${x.done ? '🏆 ' : '🔒 '}${t(`ach.${x.key}.d`)}`, x.done ? 'ok' : 'info')}>
                  <Icon size={18} /><span>{t(`ach.${x.key}`)}</span>
                  {x.key === 'streak7' && !x.done && a.streak > 0 && <small>{a.streak}/7</small>}
                </button>
              );
            })}
          </section>

          {showInstall && (
            <section className="sec-nudge install-nudge">
              <Smartphone size={22} />
              <div><b>{t('inst5.title')}</b><p>{t(install.platform === 'ios' ? 'inst5.textIos' : 'inst5.text')}</p></div>
              <button className="secondary" onClick={async () => { if (install.canPrompt) await install.prompt(); else setInstallHelp(true); }}>{t('inst5.btn')}</button>
              <button className="nudge-x" aria-label={t('common.dismiss')} onClick={() => updateSettings({ dismissed: { ...settings.dismissed, install5: true } })}><X size={14} /></button>
            </section>
          )}

          {showNudge && (
            <section className="sec-nudge">
              <ShieldCheck size={22} />
              <div><b>{t(`nudge5.${nudge}.title`)}</b><p>{t(`nudge5.${nudge}.text`)}</p></div>
              <button className="secondary" onClick={() => go('settings')}>{t('nudge5.btn')}</button>
              <button className="nudge-x" aria-label={t('common.dismiss')} onClick={() => updateSettings({ dismissed: { ...settings.dismissed, [`nudge5-${nudge}`]: true } })}><X size={14} /></button>
            </section>
          )}

          {!showNews && <section className="connect" onClick={() => go('import')} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && go('import')}>
            <Landmark size={34} />
            <div><b>{t('home.connect')}</b><p>{t('home.connectSub')}</p></div>
            <ChevronRight size={18} />
          </section>}

          <section className="panel">
            <div className="panel-head">
              <h2>{t('home.recent')}</h2>
              <button onClick={() => go('spend')}>{t('common.seeAll')}</button>
            </div>
            {recent.length ? recent.map((tx) => <TxRow key={tx.id} tx={tx} />) : (
              <div className="empty-inline">
                <p>{t('home.noTx')}</p>
                <button className="primary slim" onClick={() => openTx({})}><Plus size={16} /> {t('tx.add')}</button>
              </div>
            )}
          </section>
        </div>

        <div className="col">
          <section className={`panel ${ledger.overdue ? 'has-overdue' : ''}`}>
            <div className="panel-head"><h2><CalendarDays size={16} /> {t('home.bills')}</h2><button onClick={() => go('agenda')}>{t('ag.open')}</button></div>
            {upcoming.length
              ? upcoming.map((i) => <AgendaRow key={i.key} item={i} compact onPayInvoice={(card, inv) => setPaying({ card, inv })} />)
              : <p className="muted">{t('home.noUpcoming')}</p>}
          </section>

          <SubsCard go={go} />

          {activeCards.length > 0 && (
            <section className="panel">
              <div className="panel-head"><h2><CreditCard size={16} /> {t('wal.cards')}</h2><button onClick={() => go('wallet')}>{t('common.seeAll')}</button></div>
              {ledger.cardRows.map(({ card, open, toPay, usage }) => (
                <button className="mini-card" key={card.id} onClick={() => go('wallet')} style={{ '--c': card.color }}>
                  <span className="mini-card-top">
                    <b>{card.name}</b>
                    {toPay ? <StatusPill status={toPay.status} /> : <span className="muted">{t('invc.current', { d: formatDate(open.closing, lang, { day: 'numeric', month: 'short' }) })}</span>}
                  </span>
                  <span className="mini-card-mid">
                    <strong>{money(toPay ? toPay.remaining : open.total)}</strong>
                    <small>{toPay ? t('inv.due', { d: formatDate(toPay.due, lang, { day: 'numeric', month: 'short' }) }) : t('card.available', { v: money(usage.available) })}</small>
                  </span>
                  {card.limit > 0 && <Progress pct={usage.pct} tone={usage.pct > 90 ? 'bad' : usage.pct > 70 ? 'warn' : ''} />}
                </button>
              ))}
            </section>
          )}

          <section className="panel">
            <div className="panel-head"><h2>{t('home.byCategory')}</h2><button onClick={() => go('reports')}>{t('nav.reports')}</button></div>
            {s.byCategory.length ? (
              <div className="cat-summary">
                <Donut data={s.byCategory} center={money(s.expense, { compact: s.expense >= 10000 })} sub={t('home.spent')} />
                <ul className="legend">
                  {s.byCategory.slice(0, 5).map((c) => (
                    <li key={c.key}><CatIcon category={c.key} size={14} /><span>{t(`cat.${c.key}`)}</span><b>{Math.round(c.pct)}%</b></li>
                  ))}
                </ul>
              </div>
            ) : <p className="muted">{t('home.noSpend')}</p>}
          </section>

          <section className="panel">
            <div className="panel-head"><h2>{t('nav.budget')}</h2><button onClick={() => go('budget')}>{bs.length ? t('common.seeAll') : t('budget.set')}</button></div>
            {bs.length ? bs.map((b) => (
              <div className="mini-budget" key={b.id}>
                <div><span>{t(`cat.${b.category}`)}</span><b>{money(b.spent)} <small>/ {money(b.limit)}</small></b></div>
                <Progress pct={b.pct} tone={b.pct > 100 ? 'bad' : b.pct >= 80 ? 'warn' : ''} />
              </div>
            )) : <p className="muted">{t('budget.none')}</p>}
          </section>

          <section className="panel inv-mini" onClick={() => go('invest')} role="button" tabIndex={0}>
            <div className="panel-head"><h2><TrendingUp size={17} /> {t('nav.invest')}</h2><ChevronRight size={18} /></div>
            {assets.length ? (
              <div className="inv-mini-row">
                <div><span>{t('inv.total')}</span><b>{money(pf.value)}</b></div>
                <div><span>{t('inv.return')}</span><b className={pf.profit >= 0 ? 'positive' : 'neg-red'}>{pf.pct >= 0 ? '+' : ''}{pf.pct.toFixed(1).replace('.', lang === 'pt' ? ',' : '.')}%</b></div>
                <div><span>{t('inv.thisMonth')}</span><b>{money(s.invested)}</b></div>
              </div>
            ) : <p className="muted">{t('inv.emptyShort')}</p>}
          </section>

          <section className="panel">
            <div className="panel-head"><h2>{t('nav.goals')}</h2><button onClick={() => go('goals')}>{goals.length ? t('common.seeAll') : t('goals.new')}</button></div>
            {goals.length ? goals.slice(0, 3).map((g) => {
              const gi = goalInfo(g);
              return (
                <div className="mini-budget" key={g.id}>
                  <div><span>{g.emoji} {g.title}</span><b>{Math.round(gi.pct)}%</b></div>
                  <Progress pct={gi.pct} />
                </div>
              );
            }) : <p className="muted">{t('goals.none')}</p>}
          </section>

        </div>
      </div>
      {paying && <PayInvoiceForm card={paying.card} inv={paying.inv} onClose={() => setPaying(null)} />}
      {installHelp && <InstallHelp platform={install.platform} onClose={() => setInstallHelp(false)} />}
    </div>
  );
}
