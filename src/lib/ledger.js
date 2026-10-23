/**
 * Accounts, credit cards, invoices, installments and the bills agenda.
 *
 * Transaction model (all amounts positive):
 *   type: expense | income | invest | redeem | transfer
 *   accountId  — bank/cash account the money moves in (null = default account)
 *   cardId     — credit card used for an expense (the card's invoice pays it later)
 *   toAccountId / toCardId — destination of a transfer (paying an invoice = transfer to a card)
 *   status     — undefined/'paid' or 'pending' (scheduled, not yet paid)
 *   installment — { group, n, of } for card purchases split in parcels
 */
import { addMonths, addDays, sameDayIn, todayISO, monthKey, currentMonth, daysInMonth } from './dates.js';
import { uid, round2 } from './format.js';

export const DEFAULT_ACCOUNT_ID = 'main';
export const ACCOUNT_TYPES = ['checking', 'savings', 'cash', 'wallet', 'other'];
export const CARD_BRANDS = ['mastercard', 'visa', 'elo', 'amex', 'hipercard', 'other'];
export const ACCOUNT_COLORS = ['#10b981', '#8b5cf6', '#f97316', '#ef4444', '#0ea5e9', '#eab308', '#ec4899', '#14b8a6', '#64748b'];

const pad = (n) => String(n).padStart(2, '0');
export const isPaid = (t) => t.status !== 'pending';
/** Which account a transaction moves money in (null for card purchases). */
export const accountOf = (t) => (t.cardId ? null : t.accountId || DEFAULT_ACCOUNT_ID);

export function defaultAccount(name = 'Conta principal') {
  return { id: DEFAULT_ACCOUNT_ID, name, type: 'checking', institution: '', color: '#10b981', initialBalance: 0, isDefault: true, createdAt: Date.now() };
}

/** Effect of one transaction on one account (+ in, − out). */
export function accountDelta(t, accId) {
  if (!isPaid(t)) return 0;
  const from = accountOf(t);
  if (t.type === 'transfer') {
    let d = 0;
    if (from === accId) d -= t.amount;
    if (t.toAccountId === accId) d += t.amount;
    return d;
  }
  if (from !== accId) return 0;
  return t.type === 'income' || t.type === 'redeem' ? t.amount : -t.amount;
}

export function accountBalance(acc, txs, upTo = todayISO()) {
  // Bank-connected accounts: trust the balance the bank reported.
  if (acc.source === 'openfinance' && acc.bankBalance != null) return round2(acc.bankBalance);
  let b = Number(acc.initialBalance) || 0;
  for (const t of txs) if (t.date <= upTo) b += accountDelta(t, acc.id);
  return round2(b);
}

// ---------------- credit cards ----------------
/** Invoices are named by the month they close in. Purchases after the closing day go to the next one. */
export function invoiceMonthOf(card, dateISO) {
  const day = Number(dateISO.slice(8, 10));
  const mk = dateISO.slice(0, 7);
  return day > Number(card.closingDay) ? addMonths(mk, 1) : mk;
}

export function invoiceDates(card, mk) {
  const closing = sameDayIn(`${mk}-${pad(card.closingDay)}`, mk);
  const dueMk = Number(card.dueDay) > Number(card.closingDay) ? mk : addMonths(mk, 1);
  const due = sameDayIn(`${dueMk}-${pad(card.dueDay)}`, dueMk);
  return { closing, due };
}

export function invoice(card, txs, mk, today = todayISO()) {
  const items = [];
  let total = 0, paid = 0;
  for (const t of txs) {
    if (t.cardId === card.id && (t.type === 'expense' || t.type === 'income')) {
      if ((t.invoice || invoiceMonthOf(card, t.date)) !== mk) continue;
      items.push(t);
      total += t.type === 'expense' ? t.amount : -t.amount;
    } else if (t.type === 'transfer' && t.toCardId === card.id && (t.invoice || invoiceForPayment(card, t.date)) === mk && isPaid(t) && t.date <= today) {
      paid += t.amount;
    }
  }
  items.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  const { closing, due } = invoiceDates(card, mk);
  total = round2(total);
  paid = round2(paid);
  const remaining = round2(Math.max(total - paid, 0));
  let status;
  if (today <= closing) status = 'open';
  else if (remaining <= 0.009) status = 'paid';
  else if (today > due) status = 'overdue';
  else status = 'closed';
  return { mk, items, total, paid, remaining, closing, due, status };
}

/** Limit used = everything bought (including future installments) minus what was paid. */
export function cardUsage(card, txs) {
  if (card.source === 'openfinance' && card.bankUsed != null) {
    const limit = Number(card.limit) || 0;
    const used = Number(card.bankUsed) || 0;
    const available = card.bankAvailable != null ? Number(card.bankAvailable) : limit - used;
    return { used: round2(used), available: round2(available), limit, pct: limit ? Math.min((used / limit) * 100, 100) : 0 };
  }
  let used = 0;
  for (const t of txs) {
    if (t.cardId === card.id) used += t.type === 'expense' ? t.amount : t.type === 'income' ? -t.amount : 0;
    else if (t.type === 'transfer' && t.toCardId === card.id && isPaid(t)) used -= t.amount;
  }
  used = round2(Math.max(used, 0));
  const limit = Number(card.limit) || 0;
  return { used, available: round2(limit - used), limit, pct: limit ? Math.min((used / limit) * 100, 100) : 0 };
}

/** The invoice the card is "on" right now, and the one people usually need to pay. */
export function cardSnapshot(card, txs, today = todayISO()) {
  const openMk = invoiceMonthOf(card, today);
  const open = invoice(card, txs, openMk, today);
  const last = invoice(card, txs, addMonths(openMk, -1), today);
  const toPay = last.remaining > 0 ? last : null;
  return { open, last, toPay, usage: cardUsage(card, txs) };
}

/** Invoice a payment made on `dateISO` most likely refers to (the last one that closed). */
export function invoiceForPayment(card, dateISO) {
  const openMk = invoiceMonthOf(card, dateISO);
  const prev = addMonths(openMk, -1);
  return invoiceDates(card, prev).closing < dateISO ? prev : openMk;
}

/** Splits a card purchase into monthly parcels (with `card`, each parcel is tied to the next invoice). */
export function buildInstallments(base, count, card = null) {
  const n = Math.max(1, Math.min(48, Math.floor(count)));
  const totalCents = Math.round(Number(base.amount) * 100);
  const per = Math.floor(totalCents / n);
  const group = uid();
  const mk0 = monthKey(base.date);
  const inv0 = card ? invoiceMonthOf(card, base.date) : null;
  const out = [];
  for (let i = 0; i < n; i++) {
    const cents = i === n - 1 ? totalCents - per * (n - 1) : per;
    out.push({
      ...base,
      id: uid(),
      amount: cents / 100,
      date: sameDayIn(base.date, addMonths(mk0, i)),
      description: n > 1 ? `${base.description || ''} (${i + 1}/${n})`.trim() : base.description,
      installment: n > 1 ? { group, n: i + 1, of: n } : null,
      invoice: inv0 ? addMonths(inv0, i) : base.invoice || null,
      recurring: false,
    });
  }
  return out;
}

// ---------------- net worth & history ----------------
export function totals({ accounts, cards, txs }, today = todayISO()) {
  const accRows = accounts.filter((a) => !a.archived).map((a) => ({ account: a, balance: accountBalance(a, txs, today) }));
  const cardRows = cards.filter((c) => !c.archived).map((c) => ({ card: c, ...cardSnapshot(c, txs, today) }));
  const cash = round2(accRows.reduce((s, r) => s + r.balance, 0));
  const cardDebt = round2(cardRows.reduce((s, r) => s + r.usage.used, 0));
  return { accRows, cardRows, cash, cardDebt };
}

/** Total balance across accounts for each of the last `days` days (oldest first). */
export function balanceHistory({ accounts, txs }, days = 30, today = todayISO()) {
  const manual = accounts.filter((a) => !a.archived);
  const ids = new Set(manual.map((a) => a.id));
  let current = manual.reduce((s, a) => s + accountBalance(a, txs, today), 0);
  const flowByDay = {};
  for (const t of txs) {
    if (t.date > today || t.date < addDays(today, -days)) continue;
    let d = 0;
    for (const id of ids) d += accountDelta(t, id);
    if (d) flowByDay[t.date] = (flowByDay[t.date] || 0) + d;
  }
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(today, -i);
    out.unshift({ date, value: round2(current) });
    current -= flowByDay[date] || 0;
  }
  return out;
}

// ---------------- agenda (bills to pay / money to receive) ----------------
/**
 * Everything due from 60 days ago (overdue) to `horizon` days ahead:
 *  - pending transactions,
 *  - future occurrences of recurring templates,
 *  - credit card invoices with something left to pay.
 */
export function agenda({ txs, cards }, today = todayISO(), horizon = 45) {
  const end = addDays(today, horizon);
  const items = [];
  for (const t of txs) {
    if (t.status === 'pending' && t.date <= end && (t.type !== 'transfer' || (t.recurringOf && !t.toCardId))) {
      items.push({ key: `p:${t.id}`, kind: 'pending', date: t.date, type: t.type, amount: t.amount, description: t.description, category: t.category, tx: t });
    }
  }
  const generated = {};
  for (const t of txs) if (t.recurringOf) (generated[t.recurringOf] ||= new Set()).add(t.forMonth || monthKey(t.date));
  for (const tpl of txs) {
    // Card subscriptions and recurring card payments show up as the invoice instead.
    if (!tpl.recurring || tpl.recurringOf || tpl.cardId || tpl.toCardId) continue;
    const anchor = tpl.anchorDate || tpl.date;
    const skip = new Set(tpl.skipMonths || []);
    const have = generated[tpl.id] || new Set();
    for (let mk = monthKey(today); mk <= monthKey(end); mk = addMonths(mk, 1)) {
      const date = sameDayIn(anchor, mk);
      if (date <= today || date > end || date <= anchor) continue;
      if (have.has(mk) || skip.has(mk)) continue;
      items.push({
        key: `r:${tpl.id}:${mk}`, kind: 'recurring', date, type: tpl.type, amount: tpl.amount, description: tpl.description,
        category: tpl.category, template: tpl, mk,
      });
    }
  }
  for (const card of cards || []) {
    if (card.archived) continue;
    const openMk = invoiceMonthOf(card, today);
    for (const mk of [addMonths(openMk, -2), addMonths(openMk, -1), openMk]) {
      const inv = invoice(card, txs, mk, today);
      if (inv.remaining <= 0 || inv.due > end) continue;
      items.push({
        key: `i:${card.id}:${mk}`, kind: 'invoice', date: inv.due, type: 'expense', amount: inv.remaining,
        description: card.name, category: 'debt', card, invoice: inv,
      });
    }
  }
  return items
    .map((i) => ({ ...i, overdue: i.date < today, today: i.date === today }))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.type === 'income') - (b.type === 'income'));
}

/** Cash expected at the end of the month: today's balances + what is still due this month. */
export function monthProjection({ accounts, txs, cards }, today = todayISO()) {
  const mk = currentMonth();
  const endOfMonth = `${mk}-${pad(daysInMonth(mk))}`;
  const cash = accounts.filter((a) => !a.archived).reduce((s, a) => s + accountBalance(a, txs, today), 0);
  let toPay = 0, toReceive = 0;
  for (const i of agenda({ txs, cards }, today, 45)) {
    if (i.date > endOfMonth) continue;
    if (i.type === 'income' || i.type === 'redeem') toReceive += i.amount;
    else toPay += i.amount;
  }
  return { cash: round2(cash), toPay: round2(toPay), toReceive: round2(toReceive), projected: round2(cash - toPay + toReceive), endOfMonth };
}
