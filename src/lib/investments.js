/**
 * Investment portfolio math.
 *
 * Manual assets: value = last valuation the user typed + money moved in/out
 * after it. With no valuation, value = what was invested. That way edits,
 * deletions and recurring contributions never leave the value out of sync.
 * Open Finance assets: value and invested amount come from the bank.
 */
import {
  PiggyBank, Landmark, BadgePercent, Layers, ChartCandlestick, Building2, ChartPie, Bitcoin, Umbrella, Ellipsis,
} from 'lucide-react';
import { addMonths, currentMonth } from './dates.js';

export const ASSET_KINDS = [
  { key: 'poupanca', icon: PiggyBank, color: '#a3e635' },
  { key: 'tesouro', icon: Landmark, color: '#38bdf8' },
  { key: 'renda_fixa', icon: BadgePercent, color: '#22d3ee' },
  { key: 'fundos', icon: Layers, color: '#818cf8' },
  { key: 'acoes', icon: ChartCandlestick, color: '#f472b6' },
  { key: 'fii', icon: Building2, color: '#fb923c' },
  { key: 'etf', icon: ChartPie, color: '#c084fc' },
  { key: 'cripto', icon: Bitcoin, color: '#facc15' },
  { key: 'previdencia', icon: Umbrella, color: '#34d399' },
  { key: 'outros', icon: Ellipsis, color: '#94a3b8' },
];
const KIND_MAP = Object.fromEntries(ASSET_KINDS.map((k) => [k.key, k]));
export const getKind = (key) => KIND_MAP[key] || KIND_MAP.outros;

const signed = (t) => (t.type === 'invest' ? t.amount : t.type === 'redeem' ? -t.amount : 0);

export function assetStats(asset, txs) {
  if (asset.source === 'openfinance') {
    const value = Number(asset.currentValue) || 0;
    const invested = Number(asset.investedBase ?? value) || 0;
    return { value, invested, profit: value - invested, pct: invested > 0 ? ((value - invested) / invested) * 100 : 0, flows: [] };
  }
  const flows = txs.filter((t) => t.assetId === asset.id && (t.type === 'invest' || t.type === 'redeem'));
  const invested = (Number(asset.initialInvested) || 0) + flows.reduce((a, t) => a + signed(t), 0);
  const vals = (asset.valuations || []).slice().sort((a, b) => a.date.localeCompare(b.date) || a.at - b.at);
  const base = vals[vals.length - 1];
  let value;
  if (base) {
    const after = flows.filter((t) => t.date > base.date || (t.date === base.date && (t.createdAt || 0) > base.at));
    value = base.value + after.reduce((a, t) => a + signed(t), 0);
  } else {
    value = invested;
  }
  value = Math.max(value, 0);
  const profit = value - Math.max(invested, 0);
  return { value, invested, profit, pct: invested > 0 ? (profit / invested) * 100 : 0, flows };
}

export function portfolio(assets, txs) {
  let value = 0, invested = 0;
  const kinds = {};
  const rows = assets.map((a) => {
    const st = assetStats(a, txs);
    value += st.value;
    invested += Math.max(st.invested, 0);
    kinds[a.kind] = (kinds[a.kind] || 0) + st.value;
    return { asset: a, ...st };
  }).sort((x, y) => y.value - x.value);
  const byKind = Object.entries(kinds)
    .map(([key, amount]) => ({ key, amount, pct: value ? (amount / value) * 100 : 0 }))
    .filter((k) => k.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const profit = value - invested;
  return { rows, value, invested, profit, pct: invested > 0 ? (profit / invested) * 100 : 0, byKind };
}

/** Net contributions per month (aportes − resgates), all investment movements. */
export function monthlyContributions(txs, n = 6, end = currentMonth()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const mk = addMonths(end, -i);
    let inv = 0, red = 0;
    for (const t of txs) {
      if (!t.date.startsWith(mk)) continue;
      if (t.type === 'invest') inv += t.amount;
      else if (t.type === 'redeem') red += t.amount;
    }
    out.push({ mk, invested: inv, redeemed: red, net: inv - red });
  }
  return out;
}

/** Pluggy investment types -> our kinds */
export function kindFromPluggy(type, subtype) {
  const st = String(subtype || '').toUpperCase();
  switch (String(type || '').toUpperCase()) {
    case 'FIXED_INCOME': return st === 'TREASURY' ? 'tesouro' : 'renda_fixa';
    case 'SECURITY': return 'previdencia';
    case 'MUTUAL_FUND': return 'fundos';
    case 'EQUITY': return st === 'REAL_ESTATE_FUND' ? 'fii' : 'acoes';
    case 'ETF': return 'etf';
    default: return 'outros';
  }
}
