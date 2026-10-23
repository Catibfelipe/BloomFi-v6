// Shared spaces on the device: which entries belong to a space, the views (everything / only mine / a space),
// another member's "main" account, and per-space budgets. Run: node test/spaces-client.test.mjs
import assert from 'node:assert/strict';
import { makeTagger, scopeFilter, localizeTx, globalizeTx, txSpace, parseInvite, detachTx, sanitizeRecord, sanitizeSpaceSnap } from '../src/lib/spaces.js';
import { totals } from '../src/lib/ledger.js';
import { budgetStatus, summarize } from '../src/lib/finance.js';
import { computeAlerts } from '../src/lib/alerts.js';

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
const today = '2026-10-15';
const SP = 'sp_casa000000000000000000';
const ANA = 'u_ana0000000000', BIA = 'u_bia0000000000';

// Ana's device
const accounts = [
  { id: 'main', name: 'Conta principal', initialBalance: 2000 },
  { id: 'joint', name: 'Conta conjunta', initialBalance: 3000, space: SP, sharedBy: ANA },
];
const cards = [{ id: 'housecard', name: 'Cartão da casa', limit: 4000, closingDay: 5, dueDay: 12, space: SP }];
const tag = makeTagger({ accounts, cards }, ANA);
const txs = [
  { id: 'a1', type: 'expense', amount: 50, category: 'food', date: '2026-10-10', accountId: 'main', status: 'paid' },
  tag({ id: 'a2', type: 'expense', amount: 120, category: 'groceries', date: '2026-10-11', accountId: 'joint', status: 'paid' }),
  tag({ id: 'a3', type: 'transfer', amount: 500, category: 'transfer', date: '2026-10-12', accountId: 'main', toAccountId: 'joint', status: 'paid' }),
  // Bia's entries, as they arrive through the space
  { id: 'b1', type: 'expense', amount: 45.9, category: 'health', date: '2026-10-12', accountId: 'joint', status: 'paid', space: SP, by: BIA },
  { id: 'b2', type: 'transfer', amount: 300, category: 'transfer', date: '2026-10-13', accountId: 'main', toAccountId: 'joint', status: 'paid', space: SP, by: BIA },
  { id: 'b3', type: 'expense', amount: 80, category: 'groceries', date: '2026-10-13', cardId: 'housecard', status: 'paid', space: SP, by: BIA },
];
assert.equal(txs[0].space, undefined);
assert.deepEqual([txs[1].space, txs[1].by], [SP, ANA]);
assert.deepEqual([txs[2].space, txs[2].by], [SP, ANA], 'money moved into the joint account is shared');
assert.equal(tag(txs[3]), txs[3], 'already marked: untouched');
assert.equal(txSpace({ cardId: 'housecard' }, (id) => (id === 'housecard' ? SP : null)), SP);
ok('entries of a shared account or card join its space, with who added them');

// Bia's transfer says "main" = HER main account
const local = txs.map((t) => localizeTx(t, ANA));
assert.equal(local[4].accountId, `main@${BIA}`);
assert.equal(local[2].accountId, 'main', 'my own transfer keeps my main account');
assert.deepEqual(globalizeTx(local[4]), txs[4], 'saved back exactly as it came');
assert.equal(globalizeTx(local[0]), local[0]);
const t = totals({ accounts, cards, txs: local }, today);
const bal = Object.fromEntries(t.accRows.map((r) => [r.account.id, r.balance]));
assert.equal(bal.main, 2000 - 50 - 500, 'Bia’s transfer does not move my main account');
assert.equal(bal.joint, 3000 - 120 + 500 - 45.9 + 300);
// the space is deleted (or the joint account taken back): Bia's transfer becomes Ana's, from an outside account
const { space: _s, ...b2own } = txs[4];
const det = detachTx(b2own, ANA);
assert.equal(det.accountId, `ext:${BIA}`); assert.equal(det.toAccountId, 'joint');
assert.equal(detachTx(txs[2], ANA), txs[2], 'my own entries stay as they are');
const t2 = totals({ accounts: accounts.map(({ space, ...a }) => a), cards, txs: [txs[0], txs[2], det] }, today);
assert.equal(t2.accRows.find((r) => r.account.id === 'main').balance, 1450, 'still not my main account');
ok('another member’s "main" account is never mistaken for mine (also after the space ends)');

// views
const view = (scope) => {
  const f = scopeFilter(scope, { accounts, cards });
  return f ? { txs: local.filter(f.tx).map((x) => x.id), accounts: accounts.filter(f.record).map((x) => x.id) } : { txs: local.map((x) => x.id), accounts: accounts.map((x) => x.id) };
};
assert.deepEqual(view('all').txs, ['a1', 'a2', 'a3', 'b1', 'b2', 'b3']);
assert.deepEqual(view('me'), { txs: ['a1', 'a3'], accounts: ['main'] }, 'only mine: my entries and my transfer into the space');
assert.deepEqual(view(SP), { txs: ['a2', 'a3', 'b1', 'b2', 'b3'], accounts: ['joint'] });
ok('views: everything / only mine / the space (a transfer shows on both sides)');

// budgets: a shared budget counts the space, a personal one counts mine
const budgets = [{ id: 'bp', category: 'groceries', limit: 300 }, { id: 'bs', category: 'groceries', limit: 150, space: SP }];
const sum = summarize(local, '2026-10', today);
const st = Object.fromEntries(budgetStatus(budgets, sum, local).map((b) => [b.id, b.spent]));
assert.deepEqual(st, { bp: 0, bs: 200 });
const st0 = budgetStatus([{ id: 'x', category: 'groceries', limit: 300 }], summarize(txs.slice(0, 1), '2026-10', today), txs.slice(0, 1));
assert.equal(st0[0].spent, 0, 'without spaces nothing changes');
const al = computeAlerts({ txs: local, cards, budgets, today });
assert.ok(al.some((a) => a.kind === 'budgetOver' && a.data.spent === 200), JSON.stringify(al.map((a) => a.kind)));
assert.ok(!al.some((a) => a.key.startsWith('bud:bp:')), 'my own grocery budget is not touched by the space spending');
ok('a shared budget counts the space’s spending; a personal one counts only mine (alerts too)');

assert.deepEqual(parseInvite('https://bloomfi.app/app/#join=sp_abcdefghijklmnopqrstuv.abcdefghijklmnop.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'), { spaceId: 'sp_abcdefghijklmnopqrstuv', inviteId: 'abcdefghijklmnop', secret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq' });
assert.equal(parseInvite('https://bloomfi.app/app/#join=sp_abcdefghijklmnopqrstuv.abcdefghijklmnop.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqXX'), null, 'a damaged secret is not an invite');
ok('invite links are recognized (and damaged ones are not)');

// shared data written by someone else: checked record by record
{
  const legit = [
    ['transactions', { id: 'tx_9', type: 'expense', amount: 59.9, date: '2026-10-05', category: 'groceries', description: 'Feira', accountId: 'joint', status: 'paid', installment: '2/3', recurring: false, recurringOf: null, by: 'u_bia', space: SP, createdAt: 1760000000000, invoice: '2026-10' }],
    ['accounts', { id: 'joint', name: 'Conta conjunta', type: 'checking', color: '#10b981', institution: 'Nubank', initialBalance: 3000, space: SP, createdAt: 1 }],
    ['cards', { id: 'card1', name: 'Cartão da casa', brand: 'visa', color: '#8b5cf6', limit: 5000, closingDay: 3, dueDay: 10, space: SP }],
    ['goals', { id: 'g1', title: 'Viagem', emoji: '✈️', target: 5000, current: 250, deadline: '2027-01-31', history: [{ date: '2026-10-01', amount: 250, h: 'h1' }], space: SP }],
    ['budgets', { id: 'b1', category: 'groceries', limit: 800, space: SP, sharedBy: 'u_ana' }],
    ['categories', { id: 'c1', key: 'c_pets', name: 'Pets', type: 'expense', icon: 'paw', color: '#f59e0b', space: SP }],
  ];
  for (const [store, rec] of legit) assert.deepEqual(sanitizeRecord(store, JSON.parse(JSON.stringify(rec))), rec, `${store} unchanged`);
  const hostile = JSON.parse('{"id":"t1","type":"expense","amount":"12.5","date":"2026-10-01","category":{},"color":"url(https://evil.example/pixel.png)","__proto__":{"admin":true},"constructor":{"prototype":{"x":1}},"deep":[[[[1]]]]}');
  const fixed = sanitizeRecord('transactions', hostile);
  assert.equal(fixed.amount, 12.5); assert.equal(fixed.category, 'other'); assert.equal(fixed.color, '#94a3b8');
  assert.ok(!Object.prototype.hasOwnProperty.call(fixed, '__proto__') && !Object.keys(fixed).includes('constructor') && ({}).admin === undefined);
  for (const [store, rec] of [['transactions', { id: 'x', type: 'drop_tables', amount: 1, date: '2026-10-01' }], ['transactions', { id: 'x', type: 'expense', amount: 1, date: 20261001 }],
    ['transactions', { id: 'x', type: 'expense', amount: 'abc', date: '2026-10-01' }], ['categories', { id: 'k', key: '../x', name: 'x' }], ['accounts', { name: 'no id' }], ['cards', 'nope']]) {
    const out = sanitizeRecord(store, rec);
    assert.ok(out === null || (store === 'transactions' && out.amount === 0), `${store} ${JSON.stringify(rec)} → ${JSON.stringify(out)}`);
  }
  assert.deepEqual(sanitizeRecord('cards', { id: 'c', name: { a: 1 }, limit: 'abc', closingDay: 99, color: 'red; background:url(x)' }), { id: 'c', name: '', limit: 0, closingDay: 1, color: '#8b5cf6', dueDay: 10 });
  const snap = sanitizeSpaceSnap({ stores: { transactions: [{ id: 't', type: 'expense', amount: 1, date: '2026-10-02' }, { id: 'bad', type: 'expense', amount: 1, date: 'ontem' }], secrets: [{ id: 1 }] }, tombstones: { 'transactions:t9': 1, 'settings:x': 2 } }, SP);
  assert.deepEqual(snap.stores.transactions.map((x) => x.id), ['t']); assert.equal(snap.stores.secrets, undefined); assert.deepEqual(Object.keys(snap.tombstones), ['transactions:t9']);
  ok('shared records from others: normal ones pass unchanged; broken or hostile ones are fixed or dropped');
}

console.log(`\n${passed} checks passed`);
