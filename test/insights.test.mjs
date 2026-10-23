// Subscription hunter, day-by-day forecast, Wally's alerts and quick entry. Run: node test/insights.test.mjs
import assert from 'node:assert/strict';
import { findSubscriptions, subKey, subName, serviceOf } from '../src/lib/subscriptions.js';
import { dailyForecast, dailySpending } from '../src/lib/forecast.js';
import { computeAlerts, ruleProgress } from '../src/lib/alerts.js';
import { parseQuick } from '../src/lib/quickparse.js';
import { defaultAccount, agenda } from '../src/lib/ledger.js';

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
let seq = 0;
const T = (o) => ({ id: `t${++seq}`, type: 'expense', status: 'paid', category: 'other', createdAt: seq, ...o });
const today = '2026-10-14';

// ---------------- subscriptions ----------------
assert.equal(serviceOf('NETFLIX.COM')?.name, 'Netflix');
assert.equal(serviceOf('PAYPAL *SPOTIFY')?.name, 'Spotify');
assert.equal(serviceOf('GOOGLE *YouTube Premium')?.name, 'YouTube Premium');
assert.equal(serviceOf('APPLE.COM/BILL')?.name, 'Apple');
assert.equal(serviceOf('Padaria do Zé'), null);
assert.equal(subKey('NETFLIX.COM'), subKey('Netflix'));
assert.equal(subKey('ACADEMIA FORMA 123456 SAO PAULO BR'), subKey('Academia Forma'));
assert.equal(subName('MP*ACADEMIAFORMA'), 'Academiaforma');
ok('service names, processors and keys');

const txs = [
  // Netflix monthly on the card, price went up last month
  T({ description: 'NETFLIX.COM', amount: 39.9, date: '2026-07-10', cardId: 'c1', category: 'entertainment' }),
  T({ description: 'NETFLIX.COM', amount: 39.9, date: '2026-08-10', cardId: 'c1', category: 'entertainment' }),
  T({ description: 'NETFLIX.COM', amount: 44.9, date: '2026-09-10', cardId: 'c1', category: 'entertainment' }),
  T({ description: 'NETFLIX.COM', amount: 44.9, date: '2026-10-10', cardId: 'c1', category: 'entertainment' }),
  // Gym from the account, charged twice this month
  T({ description: 'ACADEMIA FORMA', amount: 99, date: '2026-08-05', category: 'fitness' }),
  T({ description: 'ACADEMIA FORMA', amount: 99, date: '2026-09-05', category: 'fitness' }),
  T({ description: 'ACADEMIA FORMA', amount: 99, date: '2026-10-05', category: 'fitness' }),
  T({ description: 'ACADEMIA FORMA', amount: 99, date: '2026-10-06', category: 'fitness' }),
  // Rent: fixed bill
  T({ description: 'Aluguel', amount: 1400, date: '2026-08-01', category: 'housing' }),
  T({ description: 'Aluguel', amount: 1400, date: '2026-09-01', category: 'housing' }),
  T({ description: 'Aluguel', amount: 1400, date: '2026-10-01', category: 'housing' }),
  // Spotify: one charge only, but a known service -> new subscription
  T({ description: 'PAYPAL *SPOTIFY', amount: 21.9, date: '2026-10-02', cardId: 'c1', category: 'entertainment' }),
  // Two Apple plans billed by the same company stay apart
  T({ description: 'APPLE.COM/BILL', amount: 14.9, date: '2026-08-20', cardId: 'c1' }),
  T({ description: 'APPLE.COM/BILL', amount: 14.9, date: '2026-09-20', cardId: 'c1' }),
  T({ description: 'APPLE.COM/BILL', amount: 49.9, date: '2026-08-21', cardId: 'c1' }),
  T({ description: 'APPLE.COM/BILL', amount: 49.9, date: '2026-09-21', cardId: 'c1' }),
  // An old one that stopped (cancelled)
  T({ description: 'DEEZER', amount: 22.9, date: '2026-05-03', category: 'entertainment' }),
  T({ description: 'DEEZER', amount: 22.9, date: '2026-06-03', category: 'entertainment' }),
  T({ description: 'DEEZER', amount: 22.9, date: '2026-07-03', category: 'entertainment' }),
  // Everyday spending: many charges, varying amounts -> not a subscription
  ...[3, 6, 9, 12, 15, 18, 21, 24, 27].map((d) => T({ description: 'IFOOD *RESTAURANTE', amount: 30 + d, date: `2026-09-${String(d).padStart(2, '0')}`, category: 'food' })),
  ...[2, 9, 16].map((d) => T({ description: 'Supermercado Dia', amount: 180 + d * 7, date: `2026-10-${String(d).padStart(2, '0')}`, category: 'groceries' })),
  // Installments never count
  ...[1, 2, 3].map((n) => T({ description: `Notebook (${n}/10)`, amount: 360, date: `2026-0${6 + n}-15`, cardId: 'c1', installment: { group: 'g', n, of: 10 } })),
  // Yearly plan
  T({ description: 'Amazon Prime anual', amount: 166.8, date: '2025-10-20', cardId: 'c1' }),
  T({ description: 'Amazon Prime anual', amount: 166.8, date: '2026-10-11', cardId: 'c1' }),
];
const subs = findSubscriptions(txs, { today });
const by = (name) => subs.list.find((s) => s.name === name);
const nf = by('Netflix');
assert.ok(nf && nf.cadence === 'monthly' && nf.kind === 'service');
assert.equal(nf.amount, 44.9);
assert.deepEqual([nf.increased.from, nf.increased.to, nf.increased.pct, nf.increased.date], [39.9, 44.9, 13, '2026-09-10'], 'still news a month later');
assert.equal(nf.next, '2026-11-10');
const gym = subs.list.find((s) => s.key.startsWith('academia forma'));
assert.ok(gym && gym.duplicate && gym.duplicate.date === '2026-10-06', 'double charge found');
assert.equal(gym.kind, 'service');
const rent = by('Aluguel');
assert.ok(rent && rent.kind === 'bill');
const sp = by('Spotify');
assert.ok(sp && sp.guess && sp.isNew);
const apple = subs.list.filter((s) => s.name === 'Apple');
assert.equal(apple.length, 2, 'two plans of the same company');
const deezer = by('Deezer');
assert.ok(deezer && deezer.stale, 'stopped');
assert.ok(!subs.services.includes(deezer) && subs.stopped.includes(deezer));
assert.ok(!subs.list.some((s) => /ifood|supermercado|notebook/i.test(s.name)), 'everyday shops and installments are not subscriptions');
const prime = by('Amazon Prime');
assert.ok(prime && prime.cadence === 'yearly' && prime.monthly === 13.9);
// Netflix 44,90 + gym 99 + Spotify 21,90 + Apple 14,90 + Apple 49,90 + Prime 13,90
assert.equal(subs.monthly, Math.round((44.9 + 99 + 21.9 + 14.9 + 49.9 + 13.9) * 100) / 100);
assert.equal(subs.yearly, Math.round(subs.monthly * 12 * 100) / 100);
assert.equal(subs.billsMonthly, 1400);
ok('finds monthly and yearly subscriptions, fixed bills, double charges, new and stopped ones');

const raised = findSubscriptions(txs.filter((t) => !(t.description === 'NETFLIX.COM' && t.date === '2026-10-10')), { today: '2026-09-20' });
const nf2 = raised.list.find((s) => s.name === 'Netflix');
assert.deepEqual([nf2.increased.from, nf2.increased.to, nf2.increased.pct], [39.9, 44.9, 13]);
ok('price increase is flagged');

const prefs = { netflix: { status: 'cancelled' }, [gym.key]: { status: 'ignored' } };
const subs2 = findSubscriptions(txs, { today, prefs });
assert.ok(!subs2.services.some((s) => s.name === 'Netflix'));
assert.ok(subs2.ignored.some((s) => s.name === 'Netflix'));
assert.equal(subs2.monthly, Math.round((21.9 + 14.9 + 49.9 + 13.9) * 100) / 100);
ok('the person’s choices (cancelled / not a subscription) leave the totals');

// ---------------- forecast ----------------
const main = { ...defaultAccount(), initialBalance: 1000 };
const card = { id: 'c1', name: 'Nubank', limit: 5000, closingDay: 3, dueDay: 10 };
const ftx = [
  T({ type: 'income', category: 'salary', amount: 3000, date: '2026-10-05', recurring: true, description: 'Salário' }),
  T({ type: 'expense', category: 'housing', amount: 1400, date: '2026-10-01', recurring: true, description: 'Aluguel' }),
  T({ type: 'expense', category: 'bills', amount: 200, date: '2026-10-20', status: 'pending', description: 'Luz' }),
  T({ type: 'expense', category: 'shopping', amount: 900, date: '2026-10-08', cardId: 'c1', description: 'Compra' }),
  T({ type: 'expense', category: 'food', amount: 50, date: '2026-10-12', description: 'Almoço' }),
];
// balance today: 1000 + 3000 - 1400 - 50 = 2550; luz 20/10 (-200), card invoice due 10/11 (-900), rent 01/11 (-1400), salary 05/11 (+3000)
const fc = dailyForecast({ accounts: [main], cards: [card], txs: ftx }, { today, days: 30, withDaily: false });
assert.equal(fc.start, 2550);
assert.equal(fc.points.length, 31);
const at = (d) => fc.points.find((p) => p.date === d).balance;
assert.equal(at('2026-10-20'), 2350);
assert.equal(at('2026-11-01'), 950);
assert.equal(at('2026-11-05'), 3950);
assert.equal(at('2026-11-10'), 3050);
assert.equal(fc.firstNegative, null);
assert.equal(fc.min.balance, 950);
ok('day-by-day forecast: bills, salary, rent and the card invoice on their days');

const tight = dailyForecast({ accounts: [{ ...main, initialBalance: -1500 }], cards: [card], txs: ftx }, { today, days: 30, withDaily: false });
assert.equal(tight.firstNegative, '2026-10-20');
assert.equal(tight.shortBy, Math.round(-tight.min.balance * 100) / 100);
ok('tells the day the money runs out and by how much');

const daily = [];
for (let i = 1; i <= 60; i++) daily.push(T({ type: 'expense', category: 'food', amount: i === 30 ? 5000 : 20, date: new Date(Date.UTC(2026, 9, 14 - i)).toISOString().slice(0, 10) }));
const ds = dailySpending(daily, { today });
assert.ok(ds.perDay > 19 && ds.perDay < 22, `one unusual purchase barely moves it (${ds.perDay})`);
assert.equal(dailySpending(daily.slice(0, 5), { today }).perDay, 0, 'too little history: no guess');
const withD = dailyForecast({ accounts: [main], cards: [card], txs: daily.concat(ftx) }, { today, days: 10 });
assert.ok(withD.daily > 0 && withD.points[10].balance < withD.points[0].balance);
ok('usual day-to-day spending (average, outliers trimmed)');

// ---------------- alerts ----------------
const atx = [
  ...[1, 3, 5, 8, 12, 20, 25, 30, 40].map((d) => T({ category: 'shopping', amount: 80 + d, date: new Date(Date.UTC(2026, 9, 14 - d - 8)).toISOString().slice(0, 10), description: 'Loja' })),
  T({ id: 'big', category: 'shopping', amount: 950, date: '2026-10-13', description: 'Loja de eletrônicos' }),
  T({ id: 'd1', category: 'food', amount: 59.9, date: '2026-10-12', description: 'Pizzaria Bella', cardId: 'c1' }),
  T({ id: 'd2', category: 'food', amount: 59.9, date: '2026-10-13', description: 'PIZZARIA BELLA', cardId: 'c1' }),
  T({ category: 'food', amount: 120, date: '2026-10-10', description: 'iFood delivery' }),
  T({ category: 'food', amount: 210, date: '2026-10-11', description: 'iFood delivery' }),
];
const cardFull = { id: 'c1', name: 'Nubank', limit: 1000, closingDay: 3, dueDay: 10 };
const budgets = [{ id: 'b1', category: 'food', limit: 400 }];
const rules = [
  { id: 'r1', kind: 'alert', what: 'merchant', text: 'ifood', period: 'month', limit: 300 },
  { id: 'r2', kind: 'alert', what: 'any', period: 'purchase', limit: 500 },
  { id: 'r3', kind: 'alert', what: 'category', category: 'travel', period: 'month', limit: 100 },
];
const ag = agenda({ txs: atx.concat([T({ category: 'bills', amount: 99, date: '2026-10-09', status: 'pending', description: 'Internet' })]), cards: [] }, today);
const alerts = computeAlerts({
  txs: atx, cards: [cardFull], budgets, rules, today,
  ledger: { agenda: ag }, subs, forecast: { firstNegative: '2026-10-28', shortBy: 320 },
});
const kinds = (k) => alerts.filter((a) => a.kind === k);
assert.equal(kinds('unusual').length, 1);
assert.equal(kinds('unusual')[0].data.txId, 'big');
assert.equal(kinds('duplicate').length, 1);
assert.deepEqual(kinds('duplicate')[0].data.ids, ['d1', 'd2']);
assert.equal(kinds('subDuplicate').length, 1, 'gym charged twice');
assert.equal(kinds('cardLimit').length, 0, 'card under 80%');
assert.equal(kinds('shortfall').length, 1);
assert.equal(kinds('subNew').length, 1, 'Spotify is new');
assert.equal(kinds('budgetOver').length, 1, 'food: 449,80 of 400');
assert.equal(kinds('overdue').length, 1);
assert.equal(kinds('ruleMonth').length, 1, 'iFood passed 300 this month');
assert.equal(kinds('rulePurchase').length, 1, 'one purchase above 500');
assert.equal(alerts[0].level, 'bad', 'most important first');
assert.deepEqual(ruleProgress(rules[0], atx, today), { spent: 330, pct: 110.00000000000001, over: true });
ok('alerts: unusual purchase, double charge, shortfall, subscriptions, budget, late bill and the person’s own rules');

const usedCard = computeAlerts({ txs: [T({ amount: 850, date: '2026-10-13', cardId: 'c1', description: 'TV' })], cards: [cardFull], today });
assert.equal(usedCard.filter((a) => a.kind === 'cardLimit').length, 1);
const seen = new Set(alerts.map((a) => a.key));
assert.equal(computeAlerts({ txs: atx, cards: [cardFull], budgets, rules, today, ledger: { agenda: ag }, subs, forecast: { firstNegative: '2026-10-28', shortBy: 320 }, seen }).length, 0);
const quiet = computeAlerts({ txs: atx, cards: [cardFull], budgets, rules: [], today, subs, cfg: { off: { unusual: true, duplicate: true, subs: true, budget: true } } });
assert.ok(!quiet.some((a) => ['unusual', 'duplicate', 'subDuplicate', 'subNew', 'budgetOver'].includes(a.kind)));
ok('card limit, dismissed alerts stay hidden, alerts can be switched off');

// ---------------- quick entry ----------------
const accounts = [defaultAccount('Conta principal'), { id: 'nuacc', name: 'Nubank', institution: 'Nubank', type: 'checking' }];
const cards = [{ id: 'nucard', name: 'Nubank', institution: 'Nubank' }, { id: 'inter', name: 'Cartão Inter', institution: 'Banco Inter' }];
const Q = (s) => parseQuick(s, { accounts, cards, today, categories: [{ key: 'c_pets2', name: 'Bichos', type: 'expense' }] });
let q = Q('45 mercado ontem no Nubank');
assert.deepEqual([q.type, q.amount, q.category, q.date, q.cardId, q.description], ['expense', 45, 'groceries', '2026-10-13', 'nucard', 'Mercado']);
q = Q('45 mercado no pix do nubank');
assert.deepEqual([q.accountId, q.cardId], ['nuacc', null]);
q = Q('comprei tênis 600 em 3x no cartão Inter');
assert.deepEqual([q.amount, q.installments, q.cardId, q.category, q.description], [600, 3, 'inter', 'shopping', 'Tênis']);
q = Q('recebi 3.500 de salário');
assert.deepEqual([q.type, q.amount, q.category, q.description], ['income', 3500, 'salary', 'Salário']);
q = Q('uber 23,50 anteontem');
assert.deepEqual([q.amount, q.category, q.date, q.description], [23.5, 'transport', '2026-10-12', 'Uber']);
q = Q('paguei 120 de luz dia 10');
assert.deepEqual([q.amount, q.category, q.date, q.description], [120, 'bills', '2026-10-10', 'Luz']);
q = Q('investi 500 no tesouro');
assert.deepEqual([q.type, q.amount, q.category, q.description], ['invest', 500, 'invest', 'Tesouro']);
q = Q('almoço 32 reais e 50 centavos');
assert.deepEqual([q.amount, q.category, q.description], [32.5, 'food', 'Almoço']);
q = Q('99 taxi 18,40');
assert.deepEqual([q.amount, q.category], [18.4, 'transport']);
q = Q('ração dos bichos 89,90 12/10');
assert.deepEqual([q.amount, q.category, q.date], [89.9, 'c_pets2', '2026-10-12']);
q = Q('R$ 1.234,56 geladeira em 10x no cartão');
assert.deepEqual([q.amount, q.installments, q.description], [1234.56, 10, 'Geladeira']);
q = parseQuick('spent 20 on coffee yesterday', { lang: 'en', today });
assert.deepEqual([q.amount, q.category, q.date, q.description], [20, 'coffee', '2026-10-13', 'Coffee']);
assert.equal(Q('mercado ontem'), null, 'no amount: nothing to add');
q = Q('academia 99,00 05/08');
assert.deepEqual([q.amount, q.category, q.date], [99, 'fitness', '2026-08-05'], 'the amount "99" is not the 99 taxi');
ok('quick entry understands amount, kind, category, date, account or card and installments');

console.log(`\n${passed} checks passed`);
