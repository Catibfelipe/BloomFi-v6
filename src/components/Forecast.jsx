import React, { useState } from 'react';
import { LineChart, TriangleAlert, CalendarDays, ArrowDownLeft, ArrowUpRight, Repeat, ChevronRight, CreditCard } from 'lucide-react';
import { useStore } from '../store.jsx';
import Modal from './Modal.jsx';
import { ForecastChart } from './Charts.jsx';
import { formatDate } from '../lib/format.js';

/** "Next 30 days": the balance day by day and the day the money runs out, if it does. */
export function ForecastCard() {
  const { forecast, t, money, lang, settings, updateSettings } = useStore();
  const [pick, setPick] = useState(null);
  const day = (iso) => formatDate(iso, lang, { day: 'numeric', month: 'short' });
  const dayLong = (iso) => formatDate(iso, lang, { day: 'numeric', month: 'long' });
  const f = forecast;
  const daily = settings.forecastDaily !== false;
  return (
    <section className={`panel forecast-card ${f.firstNegative ? 'bad' : ''}`} id="forecast">
      <div className="panel-head">
        <h2><LineChart size={16} /> {t('fc.title')}</h2>
        <button onClick={() => setPick(-1)}>{t('fc.details')}</button>
      </div>
      {f.firstNegative
        ? <p className="fc-line bad"><TriangleAlert size={15} /> {t('fc.runsOut', { d: dayLong(f.firstNegative), v: money(f.shortBy) })}</p>
        : <p className="fc-line">{t('fc.lowest', { v: money(f.min.balance), d: dayLong(f.min.date) })}</p>}
      <ForecastChart points={f.points} height={96} format={(v) => money(v)} dateLabel={day} ariaLabel={t('fc.title')} lowest={f.min.date} onPick={(i) => setPick(i)} />
      <div className="fc-foot">
        <span>{t('fc.in30', { v: money(f.endBalance) })}</span>
        <button className={`chip-toggle ${daily ? 'on' : ''}`} aria-pressed={daily} onClick={() => updateSettings({ forecastDaily: !daily })}>
          {daily && f.daily > 0 ? t('fc.dailyOn', { v: money(f.daily) }) : t('fc.dailyOff')}
        </button>
      </div>
      {pick !== null && <ForecastDays start={pick} onClose={() => setPick(null)} />}
    </section>
  );
}

/** Every day with something happening, with the balance after it. */
function ForecastDays({ start, onClose }) {
  const { forecast, t, money, lang } = useStore();
  const day = (iso) => formatDate(iso, lang, { weekday: 'short', day: 'numeric', month: 'short' });
  const shown = forecast.points.filter((p, i) => p.items.length || i === start || i === 0 || p.date === forecast.firstNegative);
  const label = (i) => (i.kind === 'invoice' ? t('ag.invoiceOf', { c: i.card?.name || i.description }) : i.description || t(`cat.${i.category}`));
  const Icon = (i) => (i.kind === 'invoice' ? CreditCard : i.kind === 'recurring' ? Repeat : i.type === 'income' || i.type === 'redeem' ? ArrowDownLeft : ArrowUpRight);
  return (
    <Modal title={t('fc.daysTitle')} onClose={onClose}>
      <p className="muted">{forecast.daily > 0 ? t('fc.daysTextDaily', { v: money(forecast.daily) }) : t('fc.daysText')}</p>
      <div className="fc-days">
        {shown.map((p) => (
          <div key={p.date} className={`fc-day ${p.balance < 0 ? 'neg' : ''} ${p.date === forecast.firstNegative ? 'first' : ''}`}>
            <div className="fc-day-head"><b><CalendarDays size={13} /> {day(p.date)}</b><span className={p.balance < 0 ? 'neg-red' : ''}>{money(p.balance)}</span></div>
            {p.items.map((i) => {
              const I = Icon(i);
              const inflow = i.type === 'income' || i.type === 'redeem';
              return <div key={i.key} className="fc-item"><I size={13} /><span>{label(i)}{i.overdue ? ` · ${t('ag.overdueShort')}` : ''}</span><b className={inflow ? 'positive' : ''}>{inflow ? '+' : '−'}{money(i.amount)}</b></div>;
            })}
            {!p.items.length && <div className="fc-item muted"><span>{t('fc.nothing')}</span></div>}
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** Dashboard summary of the subscription hunter. */
export function SubsCard({ go }) {
  const { subs, t, money } = useStore();
  if (!subs.list.length) return null;
  const hot = subs.attention.length;
  return (
    <section className="panel subs-card" onClick={() => go('subs')} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && go('subs')}>
      <div className="panel-head"><h2><Repeat size={16} /> {t('subs.title')}</h2><ChevronRight size={18} /></div>
      <div className="subs-card-row">
        <div><span>{t('subs.perMonthShort')}</span><b>{money(subs.monthly)}</b></div>
        <div><span>{t('subs.perYearShort')}</span><b>{money(subs.yearly)}</b></div>
        <div><span>{t('subs.countShort')}</span><b>{subs.services.length}</b></div>
      </div>
      {hot > 0 && <p className="subs-card-hot"><TriangleAlert size={14} /> {t('subs.attention', { n: hot })}</p>}
    </section>
  );
}
