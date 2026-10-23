/**
 * Wally with AI — the "tools" the local AI can ask for. They run HERE, on the person's device, over the
 * decrypted data, and answer only what was asked: amounts, dates, descriptions, category, account and card
 * nicknames. Never ids, account or card numbers, the person's name, e-mail or anything about the login.
 * (The tool list the local model reads is in aiSpec.js.)
 */
import { summarize, budgetStatus, goalInfo, trend } from './finance.js';
import { portfolio, getKind } from './investments.js';
import { addDays, addMonths, monthKey, daysInMonth } from './dates.js';
import { round2 } from './format.js';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, INVEST_CATEGORIES } from './categories.js';
import { alertText } from './alertText.js';
import { makeT } from '../i18n.js';

export const AI_TOOL_NAMES = [
  'get_overview', 'get_month_summary', 'search_transactions', 'get_monthly_trend', 'get_upcoming',
  'get_subscriptions', 'get_goals_and_budgets', 'get_investments', 'get_alerts',
];

const r2 = (n) => round2(Number(n) || 0);
const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => strip(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const int = (v, def, min, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};

/** Category key from what the model wrote: a key ("groceries") or a name in either language ("Mercado", "Groceries"). */
let EN = null;
export function resolveCategory(text, ctx) {
  const q = norm(text);
  if (!q) return null;
  EN ||= makeT('en');
  const keys = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES, ...INVEST_CATEGORIES].map((c) => c.key)
    .concat((ctx.categories || []).filter((c) => !c.archived).map((c) => c.key), ['transfer']);
  const named = keys.flatMap((k) => [norm(k), norm(ctx.t(`cat.${k}`)), norm(EN(`cat.${k}`))].filter(Boolean).map((n) => ({ k, n })));
  return (named.find((c) => c.n === q)
    || named.find((c) => c.n.startsWith(q) || q.startsWith(c.n))
    || named.find((c) => c.n.split(' ').includes(q) || c.n.includes(q)))?.k || null;
}

function namesOf(ctx) {
  const acc = new Map(ctx.accounts.map((a) => [a.id, a.name]));
  const card = new Map(ctx.cards.map((c) => [c.id, c.name]));
  return (t) => {
    if (t.cardId) return card.get(t.cardId) || ctx.t('card.defaultName');
    const id = t.accountId || 'main';
    return acc.get(id) || (id.startsWith('main@') ? ctx.t('sp.accountOf', { n: ctx.t('sp.someone') }) : ctx.t('acc.defaultName'));
  };
}

function txRow(t, ctx, where) {
  return {
    date: t.date, description: t.description || ctx.t(`cat.${t.category}`), amount: r2(t.amount), type: t.type,
    category: ctx.t(`cat.${t.category}`), where: where(t),
    ...(t.status === 'pending' ? { pending: true } : {}),
  };
}

const TOOLS = {
  get_overview(_, ctx) {
    const { ledger } = ctx;
    const p = portfolio(ctx.assets, ctx.txs);
    return {
      today: ctx.today,
      accounts: ledger.accRows.map((r) => ({ name: r.account.name, type: r.account.type || 'checking', balance: r2(r.balance) })),
      cash_total: r2(ledger.cash),
      cards: ledger.cardRows.map((r) => ({
        name: r.card.name, limit: r2(r.usage.limit), used: r2(r.usage.used), available: r2(r.usage.available),
        open_statement: { month: r.open.mk, total: r2(r.open.total), closing_date: r.open.closing, due_date: r.open.due },
        statement_to_pay: r.toPay ? { month: r.toPay.mk, left_to_pay: r2(r.toPay.remaining), due_date: r.toPay.due, status: r.toPay.status } : null,
      })),
      card_debt_total: r2(ledger.cardDebt),
      investments_total: r2(p.value),
    };
  },

  get_month_summary(input, ctx) {
    const cur = monthKey(ctx.today);
    const mk = isMonth(input?.month) ? input.month : cur;
    const s = summarize(ctx.txs, mk, ctx.today);
    const prev = summarize(ctx.txs, addMonths(mk, -1), ctx.today);
    const budgets = budgetStatus(ctx.budgets, s, ctx.txs).map((b) => ({ category: ctx.t(`cat.${b.category}`), limit: r2(b.limit), spent: r2(b.spent), left: r2(b.left), used_pct: Math.round(b.pct) }));
    return {
      month: mk, is_current_month: mk === cur, days_in_month: daysInMonth(mk),
      ...(mk === cur ? { day_of_month: s.dayOfMonth, projected_spending_at_this_pace: r2(s.projectedExpense) } : {}),
      income: r2(s.income), spending: r2(s.expense), invested: r2(s.invested), redeemed: r2(s.redeemed), kept: r2(s.saved),
      savings_rate_pct: Math.round(s.savingsRate), transactions: s.count,
      still_pending: { to_receive: r2(s.pendingIn), to_pay: r2(s.pendingOut) },
      spending_by_category: s.byCategory.slice(0, 15).map((c) => ({ category: ctx.t(`cat.${c.key}`), amount: r2(c.amount), share_pct: Math.round(c.pct) })),
      budgets,
      previous_month: { month: prev.mk, income: r2(prev.income), spending: r2(prev.expense), invested: r2(prev.invested), kept: r2(prev.saved) },
    };
  },

  search_transactions(input = {}, ctx) {
    const where = namesOf(ctx);
    const type = ['expense', 'income', 'invest', 'redeem', 'transfer'].includes(input.type) ? input.type : 'any';
    let cat = null;
    if (input.category) {
      cat = resolveCategory(String(input.category), ctx);
      if (!cat) return { error: 'unknown_category', categories: [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES].map((c) => ctx.t(`cat.${c.key}`)) };
    }
    const q = norm(input.text);
    const from = isDay(input.from) ? input.from : null;
    const to = isDay(input.to) ? input.to : null;
    const min = Number.isFinite(Number(input.min_amount)) && input.min_amount !== null && input.min_amount !== '' ? Number(input.min_amount) : null;
    const max = Number.isFinite(Number(input.max_amount)) && input.max_amount !== null && input.max_amount !== '' ? Number(input.max_amount) : null;
    const limit = int(input.limit, 30, 1, 60);
    const base = ctx.txs.filter((t) => (type === 'any' || t.type === type)
      && (!cat || t.category === cat) && (!from || t.date >= from) && (!to || t.date <= to)
      && (min == null || t.amount >= min) && (max == null || t.amount <= max));
    let found = q ? base.filter((t) => norm(t.description).includes(q)) : base;
    let matchedBy = 'text';
    // "uber" found nothing in the descriptions but is a category name: search the category.
    if (q && !found.length && !cat) {
      const c = resolveCategory(input.text, ctx);
      if (c) { found = base.filter((t) => t.category === c); matchedBy = 'category'; }
    }
    found.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
    const totals = {};
    for (const t of found) totals[t.type] = r2((totals[t.type] || 0) + t.amount);
    return {
      count: found.length, totals_by_type: totals, shown: Math.min(found.length, limit),
      ...(q && matchedBy === 'category' ? { note: 'no description matched; these are the transactions of the category with that name' } : {}),
      transactions: found.slice(0, limit).map((t) => txRow(t, ctx, where)),
    };
  },

  get_monthly_trend(input = {}, ctx) {
    const n = int(input.months, 6, 2, 12);
    const end = monthKey(ctx.today);
    const cat = input.category ? resolveCategory(String(input.category), ctx) : null;
    if (input.category && !cat) return { error: 'unknown_category' };
    const rows = trend(ctx.txs, end, n).map((m) => {
      const row = { month: m.mk, income: r2(m.income), spending: r2(m.expense), invested: r2(m.invested), kept: r2(m.income - m.expense) };
      if (cat) {
        row.category_spending = r2(ctx.txs.filter((t) => t.date.startsWith(m.mk) && t.category === cat && t.type === 'expense' && t.status !== 'pending').reduce((s, t) => s + t.amount, 0));
      }
      return row;
    });
    return { ...(cat ? { category: ctx.t(`cat.${cat}`) } : {}), current_month_is_partial: true, months: rows };
  },

  get_upcoming(input = {}, ctx) {
    const days = int(input.days, 30, 1, 45);
    const end = addDays(ctx.today, days);
    const items = ctx.ledger.agenda.filter((i) => i.date <= end && !(i.type === 'transfer' && i.kind !== 'invoice')).slice(0, 60).map((i) => ({
      date: i.date,
      description: i.kind === 'invoice' ? ctx.t('ag.invoiceOf', { c: i.card?.name || i.description }) : i.description || ctx.t(`cat.${i.category}`),
      amount: r2(i.amount), direction: i.type === 'income' || i.type === 'redeem' ? 'in' : 'out',
      kind: i.kind === 'invoice' ? 'card_statement' : i.kind === 'recurring' ? 'recurring' : 'scheduled',
      ...(i.overdue ? { overdue: true } : {}),
    }));
    const f = ctx.forecast;
    return {
      today: ctx.today, days, items,
      total_out: r2(items.filter((i) => i.direction === 'out').reduce((s, i) => s + i.amount, 0)),
      total_in: r2(items.filter((i) => i.direction === 'in').reduce((s, i) => s + i.amount, 0)),
      forecast_30_days: f ? {
        balance_today: r2(f.start), lowest: { date: f.min.date, balance: r2(f.min.balance) },
        first_day_negative: f.firstNegative || null, short_by: r2(f.shortBy), balance_in_30_days: r2(f.endBalance),
        usual_daily_spending_included: r2(f.daily),
      } : null,
    };
  },

  get_subscriptions(_, ctx) {
    const s = ctx.subs;
    const row = (x) => ({
      name: x.name, amount: r2(x.amount), frequency: x.cadence, per_month: r2(x.monthly), next_charge: x.next, last_charge: x.last,
      ...(x.increased ? { price_increase: { from: x.increased.from, to: x.increased.to, pct: x.increased.pct } } : {}),
      ...(x.duplicate ? { charged_twice_on: x.duplicate.date } : {}),
      ...(x.isNew && x.status !== 'confirmed' ? { new: true } : {}),
      ...(x.status === 'confirmed' ? { confirmed_by_person: true } : {}),
    });
    return {
      subscriptions_per_month: r2(s.monthly), subscriptions_per_year: r2(s.yearly),
      subscriptions: s.services.map(row), fixed_bills: s.bills.map(row), fixed_bills_per_month: r2(s.billsMonthly),
      seem_stopped: s.stopped.map((x) => ({ name: x.name, last_charge: x.last })),
      hidden_by_person: s.ignored.length,
    };
  },

  get_goals_and_budgets(_, ctx) {
    const s = summarize(ctx.txs, monthKey(ctx.today), ctx.today);
    return {
      goals: ctx.goals.map((g) => {
        const gi = goalInfo(g, ctx.today);
        return { title: g.title, target: r2(g.target), saved: r2(g.current), pct: Math.round(gi.pct), deadline: g.deadline || null, needed_per_month: gi.done ? 0 : r2(gi.perMonth), done: gi.done, ...(gi.overdue ? { past_deadline: true } : {}) };
      }),
      budgets_this_month: budgetStatus(ctx.budgets, s, ctx.txs).map((b) => ({ category: ctx.t(`cat.${b.category}`), limit: r2(b.limit), spent: r2(b.spent), left: r2(b.left), used_pct: Math.round(b.pct) })),
    };
  },

  get_investments(_, ctx) {
    const p = portfolio(ctx.assets, ctx.txs);
    const kind = (k) => ctx.t(`kind.${getKind(k).key}`);
    return {
      total_value: r2(p.value), total_invested: r2(p.invested), profit: r2(p.profit), profit_pct: Math.round(p.pct * 10) / 10,
      by_type: p.byKind.map((k) => ({ type: kind(k.key), value: r2(k.amount), share_pct: Math.round(k.pct) })),
      assets: p.rows.slice(0, 40).map((r) => ({ name: r.asset.name, type: kind(r.asset.kind), institution: r.asset.institution || '', value: r2(r.value), invested: r2(r.invested), profit: r2(r.profit) })),
    };
  },

  get_alerts(_, ctx) {
    return {
      alerts: ctx.alerts.slice(0, 15).map((a) => {
        const x = alertText(ctx.t, ctx.money, a, ctx.lang);
        return { level: a.level, title: x.title, text: x.text };
      }),
    };
  },
};

/** Runs one tool. Always returns something JSON-friendly (an { error } instead of throwing). */
export function runAiTool(name, input, ctx) {
  const fn = TOOLS[name];
  if (!fn) return { error: 'unknown_tool' };
  try {
    return fn(input && typeof input === 'object' ? input : {}, ctx);
  } catch (e) {
    return { error: 'tool_failed' };
  }
}
