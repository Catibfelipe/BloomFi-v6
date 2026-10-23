/**
 * Wally's watchers: alerts computed on the device from the person's own data, plus the rules they create
 * ("tell me when delivery passes R$ 300 this month"). Each alert has a stable key, so dismissing it on
 * one device hides it everywhere, and it is only announced once.
 *
 * Output items: { key, kind, level: 'bad' | 'warn' | 'info', date, data, go }
 *   go = where the alert leads in the app (page name, optional record id).
 */
import { addDays, daysBetween, monthKey, todayISO } from './dates.js';
import { round2 } from './format.js';
import { cardUsage, isPaid } from './ledger.js';

export const BUILTIN = ['unusual', 'duplicate', 'cardLimit', 'shortfall', 'subs', 'budget', 'overdue'];
export const DEFAULT_CFG = { off: {}, cardPct: 80 };

const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => strip(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const spend = (t) => t.type === 'expense' && isPaid(t);

/** The person's own rule matches this transaction? */
export function ruleMatches(rule, t) {
  if (!spend(t)) return false;
  if (rule.what === 'category') return t.category === rule.category;
  if (rule.what === 'merchant') {
    const q = norm(rule.text);
    return !!q && norm(t.description).includes(q);
  }
  return true; // any purchase
}

/** How a rule stands this month: { spent, pct, over }. */
export function ruleProgress(rule, txs, today = todayISO()) {
  const mk = monthKey(today);
  let spent = 0;
  for (const t of txs) if (t.date.startsWith(mk) && t.date <= today && ruleMatches(rule, t)) spent += t.amount;
  const limit = Number(rule.limit) || 0;
  return { spent: round2(spent), pct: limit ? (spent / limit) * 100 : 0, over: limit > 0 && spent > limit };
}

/**
 * All current alerts, most important first.
 * ctx: { txs, cards, budgets, ledger, subs (findSubscriptions result), forecast (dailyForecast result),
 *        rules (the person's alert rules), cfg, seen (Set of dismissed keys), today }
 */
export function computeAlerts(ctx) {
  const { txs = [], cards = [], budgets = [], ledger = null, subs = null, forecast = null, rules = [], seen = new Set() } = ctx;
  const cfg = { ...DEFAULT_CFG, ...(ctx.cfg || {}), off: { ...(ctx.cfg?.off || {}) } };
  const today = ctx.today || todayISO();
  const mk = monthKey(today);
  const on = (k) => !cfg.off[k];
  const out = [];
  const add = (a) => { if (!seen.has(a.key)) out.push(a); };
  const recent = txs.filter((t) => spend(t) && t.date <= today && t.date >= addDays(today, -7));

  // 1. A purchase far above what the person usually spends in that category.
  if (on('unusual')) {
    const hist = new Map();
    for (const t of txs) {
      if (!spend(t) || t.installment || t.date > addDays(today, -8) || t.date < addDays(today, -120)) continue;
      if (!hist.has(t.category)) hist.set(t.category, []);
      hist.get(t.category).push(t.amount);
    }
    for (const t of recent) {
      if (t.installment || t.recurringOf || t.source === 'recurring' || ['housing', 'bills', 'debt'].includes(t.category)) continue;
      const h = hist.get(t.category) || [];
      if (h.length < 5) continue;
      const usual = median(h);
      if (t.amount >= 80 && t.amount >= usual * 3 && t.amount - usual >= 100) {
        add({ key: `unusual:${t.id}`, kind: 'unusual', level: 'warn', date: t.date, data: { amount: t.amount, usual: round2(usual), category: t.category, description: t.description, txId: t.id }, go: { page: 'spend', id: t.id } });
      }
    }
  }

  // 2. The same charge twice (two different transactions, same amount and place, within 2 days).
  if (on('duplicate')) {
    const list = recent.filter((t) => !t.installment && !t.recurringOf).sort((a, b) => a.date.localeCompare(b.date));
    const done = new Set();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (daysBetween(a.date, b.date) > 2) break;
        if (Math.abs(a.amount - b.amount) > 0.009 || done.has(a.id) || done.has(b.id)) continue;
        const da = norm(a.description), db = norm(b.description);
        if (!da || da !== db) continue;
        if ((a.cardId || a.accountId || 'main') !== (b.cardId || b.accountId || 'main')) continue;
        done.add(a.id); done.add(b.id);
        const ids = [a.id, b.id].sort();
        add({ key: `dup:${ids.join(':')}`, kind: 'duplicate', level: 'warn', date: b.date, data: { amount: a.amount, description: a.description, ids }, go: { page: 'spend', id: b.id } });
      }
    }
    for (const s of subs?.services || []) {
      if (s.duplicate) add({ key: `subdup:${s.key}:${s.duplicate.date}`, kind: 'subDuplicate', level: 'warn', date: s.duplicate.date, data: { name: s.name, amount: s.duplicate.amount }, go: { page: 'subs' } });
    }
  }

  // 3. Credit card close to its limit.
  if (on('cardLimit')) {
    const pct = Math.min(Math.max(Number(cfg.cardPct) || 80, 50), 100);
    for (const c of cards) {
      if (c.archived || !(Number(c.limit) > 0)) continue;
      const u = cardUsage(c, txs);
      if (u.pct >= pct) {
        const step = u.pct >= 100 ? 100 : u.pct >= 90 ? 90 : pct;
        add({ key: `card:${c.id}:${mk}:${step}`, kind: 'cardLimit', level: u.pct >= 95 ? 'bad' : 'warn', date: today, data: { card: c.name, pct: Math.round(u.pct), available: u.available }, go: { page: 'wallet' } });
      }
    }
  }

  // 4. The forecast says the money runs out.
  if (on('shortfall') && forecast?.firstNegative) {
    add({ key: `short:${forecast.firstNegative}`, kind: 'shortfall', level: 'bad', date: today, data: { date: forecast.firstNegative, short: forecast.shortBy }, go: { page: 'home', id: 'forecast' } });
  }

  // 5. Subscriptions: price went up, a new one appeared, one renews soon (when asked).
  if (on('subs') && subs) {
    for (const s of subs.services.concat(subs.bills)) {
      if (s.increased) add({ key: `subup:${s.key}:${s.increased.to}`, kind: 'subUp', level: 'warn', date: s.increased.date, data: { name: s.name, from: s.increased.from, to: s.increased.to, pct: s.increased.pct }, go: { page: 'subs' } });
      if (s.isNew && s.kind === 'service' && s.status !== 'confirmed') add({ key: `subnew:${s.key}`, kind: 'subNew', level: 'info', date: s.first, data: { name: s.name, amount: s.amount }, go: { page: 'subs' } });
      if (s.remind && s.soon) add({ key: `subsoon:${s.key}:${s.next}`, kind: 'subSoon', level: 'info', date: today, data: { name: s.name, amount: s.amount, date: s.next }, go: { page: 'subs' } });
    }
  }

  // 6. Budgets passing 80% / 100% this month.
  if (on('budget') && budgets.length) {
    // (with shared spaces, a shared budget counts the space's spending and a personal one the person's own)
    const shared = budgets.some((b) => b.space) || txs.some((t) => t.space);
    const spent = new Map();
    for (const t of txs) {
      if (!spend(t) || !t.date.startsWith(mk) || t.date > today) continue;
      const k = shared ? `${t.space || ''}|${t.category}` : t.category;
      spent.set(k, (spent.get(k) || 0) + t.amount);
    }
    for (const b of budgets) {
      const v = spent.get(shared ? `${b.space || ''}|${b.category}` : b.category) || 0;
      const p = b.limit ? (v / b.limit) * 100 : 0;
      if (p >= 100) add({ key: `bud:${b.id}:${mk}:100`, kind: 'budgetOver', level: 'bad', date: today, data: { category: b.category, spent: round2(v), limit: b.limit }, go: { page: 'budget' } });
      else if (p >= 80) add({ key: `bud:${b.id}:${mk}:80`, kind: 'budgetNear', level: 'warn', date: today, data: { category: b.category, spent: round2(v), limit: b.limit, pct: Math.round(p) }, go: { page: 'budget' } });
    }
  }

  // 7. Bills already late.
  if (on('overdue') && ledger?.agenda) {
    for (const i of ledger.agenda) {
      if (!i.overdue || i.type === 'income' || i.type === 'redeem') continue;
      add({ key: `late:${i.key}`, kind: 'overdue', level: 'bad', date: i.date, data: { description: i.kind === 'invoice' ? i.card?.name : i.description, category: i.category, amount: i.amount, date: i.date, invoice: i.kind === 'invoice' }, go: { page: 'agenda' } });
    }
  }

  // The person's own rules.
  for (const r of rules) {
    if (!r || r.on === false || !(Number(r.limit) > 0)) continue;
    if (r.period === 'purchase') {
      for (const t of recent) {
        if (ruleMatches(r, t) && t.amount >= r.limit) add({ key: `rule:${r.id}:${t.id}`, kind: 'rulePurchase', level: 'warn', date: t.date, data: { rule: r, amount: t.amount, description: t.description }, go: { page: 'spend', id: t.id } });
      }
    } else {
      const p = ruleProgress(r, txs, today);
      if (p.over) add({ key: `rule:${r.id}:${mk}`, kind: 'ruleMonth', level: 'warn', date: today, data: { rule: r, spent: p.spent, limit: r.limit }, go: { page: 'spend' } });
    }
  }

  const rank = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || b.date.localeCompare(a.date));
}
