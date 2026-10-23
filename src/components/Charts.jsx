import React, { useEffect, useId, useRef, useState } from 'react';
import { getCategory } from '../lib/categories.js';

export function Donut({ data, size = 150, stroke = 20, center, sub, colorOf }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = data.reduce((a, d) => a + d.amount, 0);
  let offset = 0;
  return (
    <div className="donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth={stroke} />
        {total > 0 && data.map((d) => {
          const len = (d.amount / total) * c;
          const gap = data.length > 1 ? Math.min(3, len * 0.3) : 0;
          const el = (
            <circle key={d.key} cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={colorOf ? colorOf(d.key) : getCategory(d.key).color} strokeWidth={stroke} strokeLinecap="butt"
              strokeDasharray={`${Math.max(len - gap, 0)} ${c}`} strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`} />
          );
          offset += len;
          return el;
        })}
      </svg>
      <div className="donut-center"><b>{center}</b><span>{sub}</span></div>
    </div>
  );
}

export function WeekBars({ days, label, money, today }) {
  const max = Math.max(...days.map((d) => d.amount), 1);
  return (
    <div className="bars" role="img" aria-label="weekly spending">
      {days.map((d) => (
        <div key={d.date} className={`bar-col ${d.date === today ? 'today' : ''}`} title={money(d.amount)}>
          <div className="bar-track"><i style={{ height: `${Math.max((d.amount / max) * 100, d.amount ? 6 : 2)}%` }} /></div>
          <span>{label(d.date)}</span>
        </div>
      ))}
    </div>
  );
}

export function TrendBars({ data, label, money }) {
  const max = Math.max(...data.flatMap((d) => [d.income, d.expense, d.invested || 0]), 1);
  return (
    <div className="trend" role="img" aria-label="income vs expenses">
      {data.map((d) => (
        <div key={d.mk} className="trend-col" title={`${money(d.income)} / ${money(d.expense)} / ${money(d.invested || 0)}`}>
          <div className="trend-bars">
            <i className="inc" style={{ height: `${(d.income / max) * 100}%` }} />
            <i className="exp" style={{ height: `${(d.expense / max) * 100}%` }} />
            <i className="inv" style={{ height: `${((d.invested || 0) / max) * 100}%` }} />
          </div>
          <span>{label(d.mk)}</span>
        </div>
      ))}
    </div>
  );
}

export function Progress({ pct, tone }) {
  return <div className={`progress ${tone || ''}`}><i style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} /></div>;
}

/**
 * Balance over time. Draws at the real pixel width (no stretching) and shows
 * the value under the pointer.
 */
export function AreaChart({ data, height = 120, format, dateLabel, ariaLabel }) {
  const ref = useRef(null);
  const [w, setW] = useState(320);
  const [hover, setHover] = useState(null);
  const gid = useId().replace(/:/g, '');
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(e.contentRect.width, 50)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  if (!data.length) return null;
  const vals = data.map((d) => d.value);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max - min < 1) { max += 1; min -= 1; }
  const padT = 10, padB = 6;
  const n = data.length;
  const x = (i) => (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v) => padT + (1 - (v - min) / (max - min)) * (height - padT - padB);
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join('');
  const area = `${line}L${w.toFixed(1)},${height}L0,${height}Z`;
  const zero = min < 0 && max > 0 ? y(0) : null;
  const onMove = (e) => {
    const r = ref.current.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
    setHover(Math.min(Math.max(i, 0), n - 1));
  };
  const h = hover != null ? data[hover] : null;
  return (
    <div className="area-chart" ref={ref} style={{ height }} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={ariaLabel}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--chart)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {zero != null && <line x1="0" x2={w} y1={zero} y2={zero} className="zero" />}
        <path d={area} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke="var(--chart)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {h && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1="0" y2={height} className="cursor" />
            <circle cx={x(hover)} cy={y(h.value)} r="4" fill="var(--chart)" stroke="var(--surface)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {h && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(x(hover), 60), w - 60) }}>
          <b>{format(h.value)}</b><span>{dateLabel(h.date)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Forecast of the balance for the next days: the part below zero turns red, the lowest day is marked,
 * and tapping a day opens what happens on it.
 */
export function ForecastChart({ points, height = 120, format, dateLabel, ariaLabel, onPick, lowest }) {
  const ref = useRef(null);
  const [w, setW] = useState(320);
  const [hover, setHover] = useState(null);
  const gid = useId().replace(/:/g, '');
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(e.contentRect.width, 50)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  if (!points.length) return null;
  const vals = points.map((d) => d.balance);
  let min = Math.min(...vals, 0), max = Math.max(...vals, 0);
  if (max - min < 1) { max += 1; min -= 1; }
  const padT = 12, padB = 8;
  const n = points.length;
  const x = (i) => (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v) => padT + (1 - (v - min) / (max - min)) * (height - padT - padB);
  const line = points.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.balance).toFixed(1)}`).join('');
  const zero = y(0);
  const area = `${line}L${w.toFixed(1)},${zero.toFixed(1)}L0,${zero.toFixed(1)}Z`;
  const indexAt = (e) => {
    const r = ref.current.getBoundingClientRect();
    return Math.min(Math.max(Math.round(((e.clientX - r.left) / r.width) * (n - 1)), 0), n - 1);
  };
  const low = lowest ? points.findIndex((p) => p.date === lowest) : -1;
  const h = hover != null ? points[hover] : null;
  return (
    <div className="area-chart forecast-chart" ref={ref} style={{ height }} role="img" aria-label={ariaLabel}
      onPointerMove={(e) => setHover(indexAt(e))} onPointerLeave={() => setHover(null)} onClick={(e) => onPick?.(indexAt(e))}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`}>
        <defs>
          <linearGradient id={`${gid}g`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="var(--chart)" stopOpacity="0.02" />
          </linearGradient>
          <clipPath id={`${gid}up`}><rect x="0" y="0" width={w} height={zero} /></clipPath>
          <clipPath id={`${gid}down`}><rect x="0" y={zero} width={w} height={Math.max(height - zero, 0)} /></clipPath>
        </defs>
        <line x1="0" x2={w} y1={zero} y2={zero} className="zero" />
        <path d={area} fill={`url(#${gid}g)`} clipPath={`url(#${gid}up)`} />
        <path d={area} fill="var(--red)" fillOpacity="0.22" clipPath={`url(#${gid}down)`} />
        <path d={line} fill="none" stroke="var(--chart)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" clipPath={`url(#${gid}up)`} />
        <path d={line} fill="none" stroke="var(--red)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" clipPath={`url(#${gid}down)`} />
        {points.map((p, i) => (p.items.length ? <circle key={p.date} cx={x(i)} cy={y(p.balance)} r="2.6" className="fc-dot" /> : null))}
        {low >= 0 && <circle cx={x(low)} cy={y(points[low].balance)} r="4.5" className={`fc-low ${points[low].balance < 0 ? 'neg' : ''}`} />}
        {h && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1="0" y2={height} className="cursor" />
            <circle cx={x(hover)} cy={y(h.balance)} r="4" fill={h.balance < 0 ? 'var(--red)' : 'var(--chart)'} stroke="var(--surface)" strokeWidth="2" />
          </g>
        )}
      </svg>
      {h && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(x(hover), 60), w - 60) }}>
          <b className={h.balance < 0 ? 'neg-red' : ''}>{format(h.balance)}</b><span>{dateLabel(h.date)}</span>
        </div>
      )}
    </div>
  );
}
