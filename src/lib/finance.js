import {
  monthKey, daysInMonth, todayISO, addDays, addMonths, sameDayIn, monthsBetween, daysBetween, currentMonth,
} from './dates.js';
import { uid, round2 } from './format.js';

export const inMonth = (txs, mk) => txs.filter((t) => t.date.startsWith(mk));

export function summarize(txs, mk, today = todayISO()) {
  const list = inMonth(txs, mk);
  let income = 0, expense = 0, invested = 0, redeemed = 0, pendingIn = 0, pendingOut = 0;
  const cats = {};
  for (const t of list) {
    if (t.type === 'transfer') continue; // moving money between own accounts/cards is not income or spending
    if (t.status === 'pending') {
      if (t.type === 'income' || t.type === 'redeem') pendingIn += t.amount; else pendingOut += t.amount;
      continue;
    }
    if (t.type === 'income') income += t.amount;
    else if (t.type === 'invest') invested += t.amount;
    else if (t.type === 'redeem') redeemed += t.amount;
    else if (t.type === 'expense') {
      expense += t.amount;
      cats[t.category] = (cats[t.category] || 0) + t.amount;
    }
  }
  const byCategory = Object.entries(cats)
    .map(([key, amount]) => ({ key, amount, pct: expense ? (amount / expense) * 100 : 0 }))
    .sort((a, b) => b.amount - a.amount);

  const dim = daysInMonth(mk);
  const isCurrent = mk === monthKey(today);
  const isPast = mk < monthKey(today);
  const dayOfMonth = isCurrent ? Number(today.slice(8, 10)) : isPast ? dim : 0;
  const daysLeft = isCurrent ? dim - dayOfMonth + 1 : isPast ? 0 : dim;
  // What was kept (not spent) — investing counts as saving.
  const saved = income - expense;
  // Cash left in the account: money moved to investments leaves it (debit).
  const net = saved - invested + redeemed;
  const dailyLeft = daysLeft > 0 ? Math.max(net, 0) / daysLeft : 0;
  const projectedExpense = isCurrent && dayOfMonth > 0 ? (expense / dayOfMonth) * dim : expense;
  const savingsRate = income > 0 ? (saved / income) * 100 : 0;

  return {
    mk, income, expense, invested, redeemed, netInvested: invested - redeemed, saved, net, savingsRate, byCategory, pendingIn, pendingOut,
    dailyLeft, daysLeft, dayOfMonth, projectedExpense, count: list.length, isCurrent, dim,
  };
}

export function lastDays(txs, n = 7, end = todayISO()) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) days.push({ date: addDays(end, -i), amount: 0 });
  const idx = Object.fromEntries(days.map((d, i) => [d.date, i]));
  for (const t of txs) if (t.type === 'expense' && t.status !== 'pending' && idx[t.date] !== undefined) days[idx[t.date]].amount += t.amount;
  return days;
}

export function trend(txs, endMk, n = 6) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const mk = addMonths(endMk, -i);
    let income = 0, expense = 0, invested = 0;
    for (const t of txs) {
      if (!t.date.startsWith(mk) || t.status === 'pending' || t.type === 'transfer') continue;
      if (t.type === 'income') income += t.amount;
      else if (t.type === 'invest') invested += t.amount;
      else if (t.type === 'redeem') invested -= t.amount;
      else if (t.type === 'expense') expense += t.amount;
    }
    out.push({ mk, income, expense, invested: Math.max(invested, 0) });
  }
  return out;
}

/** Consecutive days (ending today or yesterday) on which the user logged something. */
export function logStreak(txs, today = todayISO()) {
  const days = new Set();
  for (const t of txs) {
    if (t.source === 'import' || t.source === 'recurring') continue;
    days.add(t.loggedOn || t.date);
  }
  let d = days.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (days.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

/**
 * Each budget against the month's spending in its category. With shared spaces (`txs` given), a budget counts
 * only its own side: a shared budget the space's spending, a personal budget the person's own spending.
 */
export function budgetStatus(budgets, sum, txs = null) {
  const spentBy = Object.fromEntries(sum.byCategory.map((c) => [c.key, c.amount]));
  const shared = !!txs && (budgets.some((b) => b.space) || txs.some((t) => t.space));
  const scopedSpent = (b) => {
    let v = 0;
    for (const t of txs) {
      if (t.type === 'expense' && t.status !== 'pending' && t.category === b.category && t.date.startsWith(sum.mk) && (t.space || null) === (b.space || null)) v += t.amount;
    }
    return v;
  };
  return budgets
    .map((b) => {
      const spent = shared ? scopedSpent(b) : spentBy[b.category] || 0;
      return { ...b, spent, left: b.limit - spent, pct: b.limit ? (spent / b.limit) * 100 : 0 };
    })
    .sort((a, b) => b.pct - a.pct);
}

export function goalInfo(g, today = todayISO()) {
  const remaining = Math.max(g.target - g.current, 0);
  const daysLeft = g.deadline ? daysBetween(today, g.deadline) : null;
  const monthsLeft = daysLeft !== null ? Math.max(daysLeft / 30.44, 0) : null;
  const perMonth = monthsLeft !== null && monthsLeft > 0 ? remaining / Math.max(monthsLeft, 1) : remaining;
  return {
    remaining, daysLeft, perMonth,
    pct: g.target ? Math.min((g.current / g.target) * 100, 100) : 0,
    done: g.current >= g.target && g.target > 0,
    overdue: daysLeft !== null && daysLeft < 0 && g.current < g.target,
  };
}

export function achievements({ txs, goals, budgets, sum, streak }) {
  const bs = budgetStatus(budgets, sum);
  return [
    { key: 'goalSetter', done: goals.length > 0 },
    { key: 'firstLog', done: txs.length > 0 },
    { key: 'streak7', done: streak >= 7, progress: Math.min(streak, 7) / 7 },
    { key: 'budgetCheck', done: bs.length > 0 && bs.every((b) => b.spent <= b.limit) },
    { key: 'save10', done: sum.income > 0 && sum.savingsRate >= 10 },
    { key: 'goalDone', done: goals.some((g) => g.target > 0 && g.current >= g.target) },
    { key: 'investor', done: txs.some((t) => t.type === 'invest') },
  ];
}

/**
 * Recurring transactions: a transaction marked recurring is a template that
 * repeats every month on the same day, until recurrence is switched off.
 */
export function pendingRecurring(txs, today = todayISO()) {
  const nowMk = monthKey(today);
  const byTemplate = {};
  for (const t of txs) if (t.recurringOf) (byTemplate[t.recurringOf] ||= new Set()).add(t.forMonth || monthKey(t.date));
  const out = [];
  for (const t of txs) {
    if (!t.recurring || t.recurringOf) continue;
    // anchorDate keeps the template's day/month when its first occurrence was paid on another day.
    const anchor = t.anchorDate || t.date;
    const start = monthKey(anchor);
    const skip = new Set(t.skipMonths || []);
    const have = byTemplate[t.id] || new Set();
    const n = monthsBetween(start, nowMk);
    for (let i = Math.max(1, n - 35); i <= n; i++) { // at most the last 36 months
      const mk = addMonths(start, i);
      if (have.has(mk) || skip.has(mk)) continue;
      const date = sameDayIn(anchor, mk);
      if (date > today) continue;
      out.push({
        // Same id on every device, so synced devices never post the same month twice.
        id: `rec_${t.id}_${mk}`, type: t.type, amount: t.amount, category: t.category, description: t.description,
        assetId: t.assetId || null, goalId: t.goalId || null,
        accountId: t.accountId || null, cardId: t.cardId || null, toAccountId: t.toAccountId || null, toCardId: t.toCardId || null,
        status: t.autoPay === false ? 'pending' : 'paid',
        date, forMonth: mk, recurring: false, recurringOf: t.id, source: 'recurring', createdAt: Date.now(),
        // A shared template makes shared months (same id and author on every member's device).
        ...(t.space ? { space: t.space, by: t.by || null } : {}),
      });
    }
  }
  return out;
}

/** Upcoming recurring items for the rest of the current month. */
export function upcomingRecurring(txs, today = todayISO()) {
  const mk = currentMonth();
  const have = new Set(txs.filter((t) => t.recurringOf && (t.forMonth || monthKey(t.date)) === mk).map((t) => t.recurringOf));
  return txs
    .filter((t) => t.recurring && !t.recurringOf && !(t.anchorDate || t.date).startsWith(mk) && !have.has(t.id) && !(t.skipMonths || []).includes(mk))
    .map((t) => ({ ...t, date: sameDayIn(t.anchorDate || t.date, mk) }))
    .filter((t) => t.date > today)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Everything the advisor, warnings and reports need, in one place. */
export function analyze({ txs, budgets, goals }, mk, today = todayISO()) {
  const sum = summarize(txs, mk, today);
  const prev = summarize(txs, addMonths(mk, -1), today);
  const bs = budgetStatus(budgets, sum, txs);
  const streak = logStreak(txs, today);
  const over = bs.filter((b) => b.spent > b.limit);
  const near = bs.filter((b) => b.pct >= 80 && b.spent <= b.limit);
  const top = sum.byCategory[0];
  const flexKeys = ['food', 'shopping', 'entertainment', 'coffee', 'personal', 'travel', 'gifts'];
  const flex = sum.byCategory.filter((c) => flexKeys.includes(c.key));
  const flexTotal = flex.reduce((a, c) => a + c.amount, 0);

  // Days until money runs out at the current pace (current month only).
  let shortDays = 0;
  if (sum.isCurrent && sum.income > 0 && sum.dayOfMonth > 2) {
    const perDay = Math.max(sum.expense, 0) / sum.dayOfMonth;
    if (perDay > 0) {
      const lastsDays = sum.income / perDay;
      if (lastsDays < sum.dim) shortDays = Math.ceil(sum.dim - lastsDays);
    }
  }
  // How much to cut per day to reach a 20% savings rate.
  const targetSave = sum.income * 0.2;
  const gap = Math.max(targetSave - (sum.income - sum.projectedExpense), 0);
  const cutPerDay = sum.isCurrent && sum.daysLeft > 0 ? gap / sum.daysLeft : gap / sum.dim;

  return {
    sum, prev, bs, streak, over, near, top, flexTotal,
    flexPct: sum.expense ? (flexTotal / sum.expense) * 100 : 0,
    shortDays, cutPerDay: round2(cutPerDay),
    goalsSaved: goals.reduce((a, g) => a + g.current, 0),
    goalsTarget: goals.reduce((a, g) => a + g.target, 0),
    expenseChange: prev.expense ? ((sum.expense - prev.expense) / prev.expense) * 100 : null,
  };
}

export function wallyMood(a, hasData) {
  if (!hasData) return 'sleep';
  if (a.sum.income > 0 && a.sum.savingsRate >= 20 && a.over.length === 0) return 'celebrate';
  if (a.over.length || a.shortDays || (a.sum.income > 0 && a.sum.saved < 0)) return 'worried';
  if (a.sum.income > 0 && a.sum.savingsRate < 10) return 'thinking';
  return 'happy';
}

/**
 * The day-by-day forecast knows the bills and income still to come: it replaces the rough
 * "money runs out N days before month end" guess (spending pace vs income) when it is available.
 */
export function withForecast(a, forecast, today = todayISO()) {
  if (!forecast || !a?.sum?.isCurrent) return a;
  const mk = monthKey(today);
  const end = `${mk}-${String(daysInMonth(mk)).padStart(2, '0')}`;
  const neg = forecast.firstNegative;
  return { ...a, shortDays: neg && neg <= end ? Math.max(daysBetween(neg, end), 1) : 0 };
}
