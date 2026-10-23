/**
 * Balance forecast, day by day: what the accounts should have on each of the next days, from today's
 * balance, the bills and income already known (agenda: scheduled entries, recurring ones, card invoices)
 * and, optionally, the person's usual day-to-day spending (average of the last 60 days).
 */
import { addDays, daysBetween, todayISO } from './dates.js';
import { round2 } from './format.js';
import { accountBalance, agenda } from './ledger.js';

const FIXED = new Set(['housing', 'bills', 'debt']);

/** Usual spending per day paid straight from the accounts (debit, Pix, cash), leaving out fixed bills. */
export function dailySpending(txs, { today = todayISO(), days = 60 } = {}) {
  const from = addDays(today, -days);
  let first = null;
  const amounts = [];
  for (const t of txs) {
    if (t.date > today || t.date < from) continue;
    if (!first || t.date < first) first = t.date;
    if (t.type !== 'expense' || t.status === 'pending' || t.cardId) continue;
    if (t.recurring || t.recurringOf || t.source === 'recurring' || FIXED.has(t.category)) continue;
    amounts.push(Number(t.amount) || 0);
  }
  if (!first) return { perDay: 0, basis: 0 };
  const basis = Math.min(days, daysBetween(first, today) + 1);
  if (basis < 14 || !amounts.length) return { perDay: 0, basis };
  // One unusual purchase shouldn't move the forecast for every day ahead.
  const sorted = [...amounts].sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
  const cap = Math.max(p90 * 3, 1);
  const total = amounts.reduce((s, v) => s + Math.min(v, cap), 0);
  return { perDay: round2(total / basis), basis };
}

/**
 * The next `days` days. Each point: { date, balance, in, out, items }.
 * Overdue items count today. Card purchases reach the accounts through their invoices.
 */
export function dailyForecast({ accounts, cards, txs }, { today = todayISO(), days = 30, withDaily = true } = {}) {
  const live = accounts.filter((a) => !a.archived);
  const start = round2(live.reduce((s, a) => s + accountBalance(a, txs, today), 0));
  const end = addDays(today, days);
  const byDay = new Map();
  for (const i of agenda({ txs, cards }, today, days)) {
    if (i.type === 'transfer') continue; // between the person's own accounts: the total doesn't change
    if (i.kind === 'pending' && i.tx?.cardId) continue; // goes into an invoice
    const date = i.date < today ? today : i.date;
    if (date > end) continue;
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push(i);
  }
  const daily = withDaily ? dailySpending(txs, { today }).perDay : 0;
  const points = [];
  let balance = start;
  let min = { date: today, balance: start };
  let firstNegative = start < 0 ? today : null;
  for (let n = 0; n <= days; n++) {
    const date = addDays(today, n);
    let inflow = 0, outflow = 0;
    const items = byDay.get(date) || [];
    for (const i of items) {
      if (i.type === 'income' || i.type === 'redeem') inflow += i.amount;
      else outflow += i.amount;
    }
    if (n > 0) outflow += daily;
    balance = round2(balance + inflow - outflow);
    points.push({ date, balance, in: round2(inflow), out: round2(outflow), items });
    if (balance < min.balance) min = { date, balance };
    if (balance < 0 && !firstNegative) firstNegative = date;
  }
  return {
    start, points, daily, min, firstNegative,
    endBalance: points[points.length - 1].balance,
    shortBy: firstNegative ? round2(-min.balance) : 0,
  };
}
