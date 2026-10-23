// Accounting rules. Run: node test/ledger.test.mjs
import assert from 'node:assert/strict';
import {
  accountBalance, invoiceMonthOf, invoiceDates, invoice, cardUsage, buildInstallments, agenda, totals,
  balanceHistory, invoiceForPayment, monthProjection, defaultAccount,
} from '../src/lib/ledger.js';
import { summarize, pendingRecurring } from '../src/lib/finance.js';

let n = 0;
const ok = (name) => { n++; console.log('  ✓', name); };
const T = (o) => ({ id: Math.random().toString(36).slice(2), createdAt: 1, ...o });

const main = defaultAccount();
const nu = { id: 'nu', name: 'Nubank', initialBalance: 1000 };
const card = { id: 'c1', name: 'Nubank Mastercard', limit: 5000, closingDay: 3, dueDay: 10 };
const card2 = { id: 'c2', name: 'Itaú Visa', limit: 3000, closingDay: 25, dueDay: 5 };

// ---- invoices ----
assert.equal(invoiceMonthOf(card, '2026-10-03'), '2026-10');
assert.equal(invoiceMonthOf(card, '2026-10-04'), '2026-11');
assert.deepEqual(invoiceDates(card, '2026-10'), { closing: '2026-10-03', due: '2026-10-10' });
assert.deepEqual(invoiceDates(card2, '2026-10'), { closing: '2026-10-25', due: '2026-11-05' });
assert.deepEqual(invoiceDates({ closingDay: 31, dueDay: 7 }, '2026-02'), { closing: '2026-02-28', due: '2026-03-07' });
ok('invoice month and dates (incl. short months and due in the next month)');

// ---- installments ----
const parts = buildInstallments({ type: 'expense', amount: 1000, date: '2026-01-31', description: 'Notebook', cardId: 'c1', category: 'shopping' }, 3);
assert.equal(parts.length, 3);
assert.deepEqual(parts.map((p) => p.amount), [333.33, 333.33, 333.34]);
assert.deepEqual(parts.map((p) => p.date), ['2026-01-31', '2026-02-28', '2026-03-31']);
assert.equal(parts[1].description, 'Notebook (2/3)');
assert.ok(parts.every((p) => p.installment.group === parts[0].installment.group));
ok('installments split cents exactly and land on valid dates');

// ---- card usage, invoice and payment ----
const txs = [
  T({ type: 'income', amount: 5000, date: '2026-10-01', accountId: 'nu', category: 'salary' }),
  T({ type: 'expense', amount: 200, date: '2026-10-02', cardId: 'c1', category: 'food' }),          // Oct invoice
  T({ type: 'expense', amount: 300, date: '2026-10-05', cardId: 'c1', category: 'shopping' }),      // Nov invoice
  T({ type: 'income', amount: 50, date: '2026-10-02', cardId: 'c1', category: 'other_income' }),     // refund, Oct
  ...buildInstallments({ type: 'expense', amount: 1200, date: '2026-10-05', cardId: 'c1', category: 'shopping', description: 'TV' }, 12),
  T({ type: 'transfer', amount: 150, date: '2026-10-08', accountId: 'nu', toCardId: 'c1', invoice: '2026-10' }), // pays Oct
  T({ type: 'expense', amount: 80, date: '2026-10-06', accountId: 'nu', category: 'groceries' }),
  T({ type: 'transfer', amount: 100, date: '2026-10-06', accountId: 'nu', toAccountId: 'main' }),
  T({ type: 'expense', amount: 40, date: '2026-10-06', category: 'coffee' }), // default account
  T({ type: 'expense', amount: 999, date: '2026-10-20', accountId: 'nu', category: 'bills', status: 'pending' }),
];
const oct = invoice(card, txs, '2026-10', '2026-10-06');
assert.equal(oct.total, 150); assert.equal(oct.paid, 0); assert.equal(oct.status, 'closed');
const octPaid = invoice(card, txs, '2026-10', '2026-10-09');
assert.equal(octPaid.paid, 150); assert.equal(octPaid.remaining, 0); assert.equal(octPaid.status, 'paid');
const nov = invoice(card, txs, '2026-11', '2026-10-09');
assert.equal(nov.total, 400); assert.equal(nov.status, 'open'); // 300 + first TV parcel 100
assert.equal(invoice(card, txs, '2026-10', '2026-10-11').status, 'paid');
assert.equal(invoice(card, [T({ type: 'expense', amount: 10, date: '2026-09-01', cardId: 'c1' })], '2026-09', '2026-09-20').status, 'overdue');
ok('invoice totals include refunds, payments and installments; status open/closed/paid/overdue');

const usage = cardUsage(card, txs);
assert.equal(usage.used, 200 - 50 + 300 + 1200 - 150); // all future parcels hold the limit
assert.equal(usage.available, 5000 - usage.used);
ok('card limit counts every future installment');

assert.equal(accountBalance(nu, txs, '2026-10-31'), 1000 + 5000 - 150 - 80 - 100);
assert.equal(accountBalance(main, txs, '2026-10-31'), 100 - 40);
ok('account balances: income, expenses, transfers between accounts and invoice payments; pending ignored');

// ---- month summary ----
const s = summarize(txs, '2026-10', '2026-10-10');
assert.equal(s.income, 5000 + 50);
assert.equal(s.expense, 200 + 300 + 100 + 80 + 40); // card purchases count when bought; only this month's parcel
assert.equal(s.pendingOut, 999);
ok('month summary ignores transfers and pending, counts card purchases by purchase date');

// ---- payment invoice inference ----
assert.equal(invoiceForPayment(card, '2026-10-08'), '2026-10');
assert.equal(invoiceForPayment(card, '2026-10-02'), '2026-09');
assert.equal(invoiceForPayment(card2, '2026-11-03'), '2026-10');
ok('payments are matched to the last closed invoice');

// ---- totals / history ----
const tt = totals({ accounts: [main, nu], cards: [card], txs }, '2026-10-31');
assert.equal(tt.cash, 1000 + 5000 - 150 - 80 - 100 + 60);
assert.equal(tt.cardDebt, usage.used);
const hist = balanceHistory({ accounts: [main, nu], txs }, 10, '2026-10-06');
assert.equal(hist.length, 10);
assert.equal(hist[hist.length - 1].value, accountBalance(main, txs, '2026-10-06') + accountBalance(nu, txs, '2026-10-06'));
assert.equal(hist[0].value, 1000); // before salary
ok('net cash, card debt and 30-day balance history');

// ---- recurring + agenda ----
const tpl = T({ type: 'expense', amount: 120, date: '2026-08-15', accountId: 'nu', category: 'bills', description: 'Internet', recurring: true, autoPay: false });
const gen = pendingRecurring([tpl], '2026-10-20');
assert.equal(gen.length, 2);
assert.ok(gen.every((g) => g.status === 'pending' && g.accountId === 'nu'));
ok('recurring with manual confirmation is generated as pending, keeps its account');

const ag = agenda({ txs: [tpl, ...gen, ...txs], cards: [card] }, '2026-10-20', 45);
const kinds = ag.map((i) => i.kind);
assert.ok(kinds.includes('pending') && kinds.includes('recurring') && kinds.includes('invoice'));
assert.ok(ag.find((i) => i.kind === 'pending' && i.date === '2026-09-15').overdue);
assert.ok(ag.some((i) => i.kind === 'recurring' && i.date === '2026-11-15'));
assert.ok(!ag.some((i) => i.kind === 'recurring' && i.date === '2026-10-15')); // already generated
const inv = ag.find((i) => i.kind === 'invoice');
assert.equal(inv.date, '2026-11-10'); assert.equal(inv.amount, 400);
for (let k = 1; k < ag.length; k++) assert.ok(ag[k - 1].date <= ag[k].date);
ok('agenda: overdue pending, future recurring (no duplicates) and invoices, in date order');

// Paying next month's occurrence early must not make this month look generated (or regenerate next month).
const early = T({ type: 'expense', amount: 120, date: '2026-10-28', accountId: 'nu', recurringOf: tpl.id, forMonth: '2026-11', status: 'paid' });
const gen2 = pendingRecurring([tpl, early], '2026-11-20');
assert.deepEqual(gen2.map((g) => g.date), ['2026-09-15', '2026-10-15']);
assert.ok(!agenda({ txs: [tpl, early, ...gen2], cards: [] }, '2026-11-01', 45).some((i) => i.kind === 'recurring' && i.mk === '2026-11'));
ok('a recurring bill paid ahead counts for the month it belongs to');

// Card that closes on day 30: parcels dated in short months still hit one invoice each.
const late = { id: 'c3', name: 'Late', limit: 5000, closingDay: 30, dueDay: 7 };
const lp = buildInstallments({ type: 'expense', amount: 900, date: '2026-01-31', cardId: 'c3', category: 'shopping', description: 'Sofá' }, 3, late);
assert.deepEqual(['2026-02', '2026-03', '2026-04'].map((mk) => invoice(late, lp, mk, '2026-01-31').total), [300, 300, 300]);
ok('installments with a late closing day land one per invoice (short months)');

// A recurring card payment without an explicit invoice pays the last closed one.
const payNoInv = T({ type: 'transfer', amount: 150, date: '2026-10-08', accountId: 'nu', toCardId: 'c1' });
assert.equal(invoice(card, [...txs.filter((x) => x.type !== 'transfer'), payNoInv], '2026-10', '2026-10-09').paid, 150);
ok('card payment with no invoice month falls back to the last closed invoice');

// Old templates keep generating (window counted back from today), and a template paid early keeps its day.
const old = T({ type: 'expense', amount: 50, date: '2023-01-10', recurring: true, category: 'bills' });
const g3 = pendingRecurring([old], '2026-10-20');
assert.equal(g3[g3.length - 1].date, '2026-10-10');
const moved = T({ type: 'expense', amount: 1400, date: '2026-10-30', anchorDate: '2026-11-02', recurring: true, category: 'housing' });
assert.ok(!agenda({ txs: [moved], cards: [] }, '2026-10-30', 45).some((i) => i.date === '2026-11-30'));
assert.equal(pendingRecurring([moved], '2026-12-05')[0].date, '2026-12-02');
ok('recurring window follows today; paying the first one early keeps its day');

const proj = monthProjection({ accounts: [main, nu], txs: [tpl, ...gen, ...txs], cards: [card] }, '2026-10-20');
assert.ok(proj.toPay >= 999 + 120);
assert.equal(proj.projected, proj.cash - proj.toPay + proj.toReceive);
ok('end-of-month projection');

console.log(`\n${n} checks passed`);
