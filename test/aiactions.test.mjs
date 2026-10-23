// Wally adds things: sentences -> cards (parseCommand), Claude's tool calls -> cards (prepareAction), what a card
// shows, "Confirmar" (executeAction) and "Desfazer" (undoAction) over a store double, yes/no answers, the chat
// history Claude sees, the voice helpers, and a whole question through askAi (local model). Run: node test/aiactions.test.mjs
import assert from 'node:assert/strict';
import {
  parseCommand, prepareAction, describeAction, actionSummary, editAction, executeAction, undoAction, yesNo, actionExpired,
  toAmount, ACTION_TOOL_NAMES,
} from '../src/lib/aiActions.js';
import { historyFor } from '../src/lib/aiChat.js';
import { speechText, pickVoice, speechChunks } from '../src/lib/voice.js';
import { defaultAccount } from '../src/lib/ledger.js';
import { makeT } from '../src/i18n.js';
import { makeMoney, round2 } from '../src/lib/format.js';

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
const today = '2026-10-20';
const t = makeT('pt');
const money = makeMoney('pt', 'BRL');
const seed = () => ({
  accounts: [{ ...defaultAccount('Conta principal'), initialBalance: 1000 }, { id: 'nu', name: 'Nubank', type: 'checking', createdAt: 2 }, { id: 'brad', name: 'Bradesco', type: 'checking', createdAt: 3 }],
  cards: [{ id: 'c1', name: 'Cartão Inter', limit: 3000, closingDay: 5, dueDay: 12, createdAt: 4 }],
  assets: [{ id: 'a1', name: 'Tesouro Selic 2029', kind: 'tesouro', institution: 'XP', initialInvested: 1000, valuations: [{ date: '2026-09-01', value: 1500 }], source: 'manual' },
    { id: 'of1', name: 'CDB Banco X (Open Finance)', kind: 'renda_fixa', institution: 'X', source: 'openfinance', valuations: [] }],
  goals: [{ id: 'g1', title: 'Viagem', target: 6000, current: 1500, deadline: '2027-06-30', history: [], emoji: '✈️' },
    { id: 'g2', title: 'Reserva de emergência', target: 20000, current: 4000, deadline: null, history: [], emoji: '🛟' }],
  budgets: [{ id: 'b1', category: 'groceries', limit: 400 }],
  categories: [],
  txs: [{ id: 't1', type: 'expense', amount: 50, category: 'groceries', date: '2026-10-02', accountId: 'main', status: 'paid' }],
  rules: [],
});
const ctxOf = (D) => ({ accounts: D.accounts, cards: D.cards, assets: D.assets, goals: D.goals, budgets: D.budgets, categories: D.categories, t, money, lang: 'pt', today });
const ctx = ctxOf(seed());
const one = (sentence, c = ctx) => {
  const r = parseCommand(sentence, c);
  assert.ok(r, `"${sentence}" should be read as a request`);
  assert.equal(r.errors.length, 0, `"${sentence}": ${JSON.stringify(r.errors)}`);
  assert.equal(r.actions.length, 1);
  const { id, ...a } = r.actions[0];
  assert.match(id, /^act_/);
  return a;
};

// ---- the person's own example, and the money words ----
assert.deepEqual(one('wally adicione um novo investimento de 10000 em cdb bradesco'), {
  kind: 'add_investment', name: 'CDB Bradesco', assetKind: 'renda_fixa', institution: 'Bradesco', amount: 10000, date: today, accountId: 'brad', existing: false,
});
const noBradesco = ctxOf({ ...seed(), accounts: seed().accounts.filter((a) => a.id !== 'brad') });
assert.equal(one('Wally, adicione um investimento de 10 mil reais no CDB do Bradesco', noBradesco).accountId, 'main', 'no Bradesco account: the money leaves the main one');
assert.equal(one('adicione um investimento de 3000 em lci itaú que eu já tinha').existing, true);
assert.equal(one('adicione um investimento de 3000 em lci itaú que eu já tinha').accountId, null);
for (const [said, want] of [['10.000,00', 10000], ['R$ 1.234,5', 1234.5], ['2 mil', 2000], ['1,234.56', 1234.56], ['89,90', 89.9], [-50, 50], ['abc', NaN]]) {
  assert.ok(Object.is(toAmount(said), want), `${said} -> ${toAmount(said)}`);
}
ok('"wally adicione um novo investimento de 10000 em cdb bradesco" -> CDB Bradesco, renda fixa, R$ 10.000 from the Bradesco account (main if none); amounts in Brazilian writing');

// ---- everyday sentences (typed or said) ----
let a = one('gastei 45 no mercado ontem');
assert.deepEqual([a.kind, a.type, a.amount, a.category, a.date, a.accountId, a.status], ['add_transaction', 'expense', 45, 'groceries', '2026-10-19', 'main', 'paid']);
a = one('Wally, adiciona aí um gasto de 89,90 na farmácia no nubank');
assert.deepEqual([a.amount, a.description, a.category, a.accountId], [89.9, 'Farmácia', 'health', 'nu']);
a = one('anota que paguei 120 de internet');
assert.deepEqual([a.description, a.category], ['Internet', 'bills']);
a = one('recebi 5000 de salário');
assert.deepEqual([a.type, a.category, a.amount], ['income', 'salary', 5000]);
a = one('comprei um celular de 2400 em 12x no cartão inter');
assert.deepEqual([a.cardId, a.accountId, a.installments, a.amount, a.status], ['c1', null, 12, 2400, 'paid']);
assert.match(actionSummary({ id: 'x', ...a }, ctx), /12x de R\$\s?200,00/);
a = one('adicione conta de luz de 150 todo dia 10');
assert.deepEqual([a.kind, a.description, a.day, a.date, a.autoPay, a.status, a.category], ['add_recurring', 'Conta de luz', 10, '2026-11-10', false, 'pending', 'bills']);
a = one('recebo 5000 de salário todo mês dia 5');
assert.deepEqual([a.kind, a.type, a.description, a.day, a.autoPay], ['add_recurring', 'income', 'Salário', 5, true]);
a = one('adicione netflix 55,90 todo mês no cartão inter');
assert.deepEqual([a.description, a.cardId, a.category], ['Netflix', 'c1', 'entertainment']);
ok('expenses, incomes, card purchases in installments and monthly bills come out with the right amount, date, category and account');

a = one('crie uma meta de viagem de 8000 até dezembro');
assert.deepEqual([a.kind, a.title, a.target, a.deadline, a.emoji], ['add_goal', 'Viagem', 8000, '2026-12-31', '✈️']);
a = one('Wally, cria uma meta de reserva de emergência de 20 mil', ctxOf({ ...seed(), goals: [] }));
assert.deepEqual([a.title, a.target], ['Reserva de emergência', 20000]);
a = one('crie uma meta para comprar um carro de 50 mil até 2028');
assert.deepEqual([a.title, a.deadline], ['Comprar um carro', '2028-12-31']);
a = one('guarde 200 na meta viagem');
assert.deepEqual([a.kind, a.goalId, a.amount], ['add_to_goal', 'g1', 200]);
a = one('tira 500 da reserva');
assert.deepEqual([a.kind, a.goalId, a.amount], ['add_to_goal', 'g2', -500]);
assert.equal(one('gastei 300 na viagem').kind, 'add_transaction', 'spending on a trip is not taking money from the goal');
a = one('coloque um orçamento de 800 para mercado');
assert.deepEqual([a.kind, a.category, a.limit, a.prevLimit], ['set_budget', 'groceries', 800, 400]);
a = one('me avise quando o mercado passar de 900');
assert.deepEqual([a.kind, a.what, a.category, a.limit, a.period], ['add_alert', 'category', 'groceries', 900, 'month']);
a = one('investi 500 no tesouro selic');
assert.deepEqual([a.kind, a.assetId, a.direction, a.amount], ['move_investment', 'a1', 'invest', 500]);
a = one('o tesouro selic está valendo 1600 agora');
assert.deepEqual([a.kind, a.assetId, a.value], ['update_investment_value', 'a1', 1600]);
a = one('Adicione uma conta no Itaú com saldo de 2000');
assert.deepEqual([a.kind, a.name, a.accType, a.balance], ['add_account', 'Itaú', 'checking', 2000]);
a = one('crie uma conta poupança no nubank');
assert.deepEqual([a.name, a.accType, a.balance], ['Poupança Nubank', 'savings', 0]);
a = one('adicione um cartão nubank com limite de 5000 que fecha dia 3 e vence dia 10');
assert.deepEqual([a.kind, a.name, a.limit, a.closingDay, a.dueDay], ['add_card', 'Cartão Nubank', 5000, 3, 10]);
a = one('cadastra o cartão chamado Roxinho visa com limite de 2 mil');
assert.deepEqual([a.name, a.brand, a.limit], ['Roxinho', 'visa', 2000]);
ok('goals (new, save, take out), budgets, alerts, contributions, an investment’s value today, accounts and cards');

// ---- the same in English (the app speaks English too) ----
const ctxEn = { ...ctx, t: makeT('en'), money: makeMoney('en', 'USD'), lang: 'en' };
a = one('add an investment of 10,000 in a Bradesco CDB', ctxEn);
assert.deepEqual([a.kind, a.amount, a.name, a.accountId], ['add_investment', 10000, 'CDB Bradesco', 'brad']);
a = one('I spent 45 at the grocery store', ctxEn);
assert.deepEqual([a.kind, a.amount, a.category], ['add_transaction', 45, 'groceries']);
a = one('received 300 from freelance', ctxEn);
assert.deepEqual([a.type, a.description], ['income', 'Freelance']);
a = one('create a travel goal of 8,000 by December', ctxEn);
assert.deepEqual([a.kind, a.title, a.target, a.deadline], ['add_goal', 'Travel', 8000, '2026-12-31']);
a = one('I get paid 5,000 every month on the 5th', ctxEn);
assert.deepEqual([a.kind, a.type, a.day, a.category, a.description], ['add_recurring', 'income', 5, 'salary', 'Salary']);
a = one('let me know when groceries go over 500', ctxEn);
assert.deepEqual([a.kind, a.category, a.limit], ['add_alert', 'groceries', 500]);
a = one('add a card called Amex Platinum with a limit of 10,000 that closes on day 5 and is due on day 20', ctxEn);
assert.deepEqual([a.kind, a.name, a.limit, a.closingDay, a.dueDay], ['add_card', 'Amex Platinum', 10000, 5, 20]);
assert.equal(one('adicione um cartão nubank com limite de 5.000 que fecha dia 3 e vence dia 10').limit, 5000, '"5.000" is five thousand');
ok('English sentences too: investments, expenses, incomes, goals, monthly income, alerts, cards (10,000 = ten thousand)');

// ---- what is not a request, and what Wally asks back ----
for (const s of ['quanto gastei no mercado?', 'oi wally tudo bem', 'como estão minhas finanças', 'paguei a fatura do cartão', 'transferi 500 para o nubank', 'me explica o que é CDB']) {
  assert.equal(parseCommand(s, ctx), null, s);
}
let r = parseCommand('resgatei 1000 do cdb', ctx);
assert.deepEqual(r.errors[0], { error: 'unknown_investment', investments: ['Tesouro Selic 2029'] }, 'Open Finance investments are not offered');
r = parseCommand('adicione um gasto de 50 pelo pix no itaú', ctx);
assert.equal(r.errors[0].error, 'unknown_account');
assert.equal(r.errors[0].asked, 'Itaú');
assert.equal(t('act2.ask.unknown_account', { l: r.errors[0].accounts.join(', '), a: r.errors[0].asked }), 'Não achei a conta “Itaú”. As suas são: Conta principal, Nubank, Bradesco. Se ela é nova, diga: “crie uma conta chamada Itaú”.');
assert.equal(one('comprei uma caixa de leite de 8').accountId, 'main', '"caixa" here is not the bank');
r = parseCommand('crie uma meta de viagem', ctx);
assert.equal(r.errors[0].error, 'missing_amount');
ok('questions, card bills and transfers are answered, not turned into cards; an unknown investment or bank is asked about');

// ---- Claude's tool calls ----
const prep = (name, input, c = ctx) => prepareAction(name, input, c);
assert.deepEqual(prep('add_transaction', { amount: 30, account: 'Itaú' }), { error: 'unknown_account', accounts: ['Conta principal', 'Nubank', 'Bradesco'], asked: 'Itaú' });
assert.deepEqual(prep('add_transaction', { amount: 'muito' }), { error: 'missing_amount' });
assert.deepEqual(prep('add_transaction', { amount: 200_000_000 }), { error: 'missing_amount' });
assert.deepEqual(prep('nope', {}), { error: 'unknown_action' });
a = prep('add_transaction', { type: 'expense', amount: '1.234,56', description: 'dentista', category: 'saúde', card: 'inter', installments: 3 }).action;
assert.deepEqual([a.amount, a.description, a.category, a.cardId, a.accountId, a.installments, a.status], [1234.56, 'Dentista', 'health', 'c1', null, 3, 'paid']);
a = prep('add_transaction', { type: 'expense', amount: 99, description: 'IPVA', date: '2026-11-03' }).action;
assert.equal(a.status, 'pending', 'a bill in the future waits to be paid');
a = prep('add_investment', { type: 'Tesouro Selic', name: 'Tesouro Selic 2029', amount: 300 }).action;
assert.deepEqual([a.kind, a.assetId, a.direction], ['move_investment', 'a1', 'invest'], 'the same investment again is a contribution');
a = prep('add_goal', { title: 'casamento', target: '30 mil', deadline: '2027-03', emoji: '💍' }).action;
assert.deepEqual([a.title, a.target, a.deadline], ['Casamento', 30000, '2027-03-31']);
assert.equal(prep('add_goal', { title: 'x', target: 10, deadline: '2020-01-01' }).action.deadline, null, 'a deadline in the past is dropped');
a = prep('add_to_goal', { goal: 'viagem', amount: 5000, withdraw: true }).action;
assert.equal(a.amount, -1500, 'cannot take out more than the goal has');
assert.equal(prep('set_budget', { category: 'astronomia', monthly_limit: 10 }).error, 'unknown_category');
assert.equal(prep('add_account', { name: 'nubank' }).error, 'account_exists');
a = prep('add_card', { name: 'Black', brand: 'Visa', limit: 10000, closing_day: 40, due_day: 7 }).action;
assert.deepEqual([a.brand, a.closingDay, a.dueDay], ['visa', 1, 7]);
assert.equal(new Set(ACTION_TOOL_NAMES.map((n) => prep(n, {}).error || 'ok')).has(undefined), false);
ok('the AI’s tool calls: amounts, dates, cards, installments, contributions, goals and limits checked; errors the AI can act on');

// ---- the card ----
a = prep('add_investment', { type: 'CDB', institution: 'Bradesco', amount: 10000 }).action;
const d = describeAction(a, ctx);
assert.equal(d.title, 'Novo investimento');
assert.deepEqual(d.rows.find((x) => x[2] === 'account').slice(0, 2), ['Sai da conta', 'Bradesco']);
const moved = editAction(a, { accountId: 'nu' }, ctx);
assert.equal(moved.accountId, 'nu');
assert.equal(editAction(a, { accountId: 'not-mine' }, ctx).accountId, 'brad', 'only one of the person’s accounts');
const had = editAction(a, { existing: true }, ctx);
assert.deepEqual([had.existing, had.accountId], [true, null]);
assert.match(actionSummary(had, ctx), /Já aplicado R\$\s?10\.000,00/);
assert.equal(editAction(had, { existing: false }, ctx).accountId, 'brad');
assert.equal(actionExpired({ at: Date.now() - 8 * 86400000 }), true);
assert.equal(actionExpired({ at: Date.now() - 86400000 }), false);
ok('the card: rows with the account to pick, "já estava aplicado", one-line summary; old cards expire');

// ---- confirm and undo, over a store double that behaves like the app's ----
function storeDouble(D) {
  let n = 0;
  const id = (p) => `${p}${++n}`;
  const A = {
    data: () => D,
    async saveTx(i) {
      const base = {
        id: i.id || id('tx'), type: i.type, amount: round2(Math.abs(i.amount)), category: i.category, description: i.description || '', date: i.date,
        accountId: i.cardId ? null : i.accountId || 'main', cardId: i.cardId || null, status: !i.cardId && i.status === 'pending' ? 'pending' : 'paid',
        recurring: !!i.recurring, autoPay: i.autoPay !== false, assetId: i.assetId || null, source: i.source,
      };
      let rows = [base];
      if (i.cardId && i.installments > 1) {
        const group = id('g');
        rows = Array.from({ length: i.installments }, (_, k) => ({ ...base, id: k ? id('tx') : base.id, amount: round2(i.amount / i.installments), installment: { group, n: k + 1, of: i.installments } }));
      }
      D.txs = D.txs.concat(rows);
      return rows[0];
    },
    async deleteTx(tx, { group = false } = {}) {
      const gone = new Set((group && tx.installment?.group ? D.txs.filter((x) => x.installment?.group === tx.installment.group) : [tx]).map((x) => x.id));
      D.txs = D.txs.filter((x) => !gone.has(x.id));
    },
    async saveAsset(x) {
      const prev = D.assets.find((y) => y.id === x.id);
      const item = { ...prev, ...x, id: x.id || id('as'), valuations: x.valuations || prev?.valuations || [], source: x.source || prev?.source || 'manual', initialInvested: Number(x.initialInvested ?? prev?.initialInvested ?? 0) };
      D.assets = D.assets.filter((y) => y.id !== item.id).concat(item);
      return item;
    },
    async addValuation(asset, value) { D.assets = D.assets.map((y) => (y.id === asset.id ? { ...y, valuations: [...(y.valuations || []), { date: today, value }] } : y)); },
    async deleteAsset(asset) { D.assets = D.assets.filter((y) => y.id !== asset.id); D.txs = D.txs.map((x) => (x.assetId === asset.id ? { ...x, assetId: null } : x)); },
    async saveGoal(g) {
      const prev = D.goals.find((y) => y.id === g.id);
      const item = { id: g.id || id('goal'), title: g.title, emoji: g.emoji || '🎯', target: Number(g.target), current: Number(g.current || 0), deadline: g.deadline || null, history: g.history || prev?.history || [] };
      D.goals = D.goals.filter((y) => y.id !== item.id).concat(item);
      return item;
    },
    async addFunds(goal, amount, { record = true, txId } = {}) {
      D.goals = D.goals.map((y) => (y.id === goal.id ? { ...goal, current: Math.max(0, round2(goal.current + amount)), history: [...(goal.history || []), { amount }] } : y));
      if (record) D.txs = D.txs.concat({ id: txId || id('tx'), type: amount > 0 ? 'invest' : 'redeem', amount: Math.abs(amount), category: amount > 0 ? 'goal_save' : 'redeem', goalId: goal.id, accountId: 'main', date: today });
    },
    async deleteGoal(gid) { D.goals = D.goals.filter((y) => y.id !== gid); },
    async saveBudget(b) { D.budgets = D.budgets.filter((y) => y.id !== b.id).concat({ id: b.id, category: b.category, limit: Number(b.limit) }); },
    async deleteBudget(bid) { D.budgets = D.budgets.filter((y) => y.id !== bid); },
    async saveAlertRule(rule) { const item = { ...rule, id: rule.id || `alert:${id('r')}`, kind: 'alert' }; D.rules = D.rules.concat(item); return item; },
    async deleteAlertRule(rid) { D.rules = D.rules.filter((y) => y.id !== rid); },
    async saveAccountItem(x) { const item = { ...x, id: x.id || id('acc') }; D.accounts = D.accounts.concat(item); return item; },
    async deleteAccountItem(acc) { D.accounts = D.accounts.filter((y) => y.id !== acc.id); return 'deleted'; },
    async saveCard(c) { const item = { ...c, id: c.id || id('card') }; D.cards = D.cards.concat(item); return item; },
    async deleteCard(card) { D.cards = D.cards.filter((y) => y.id !== card.id); return 'deleted'; },
  };
  return A;
}
const sentences = [
  'wally adicione um novo investimento de 10000 em cdb bradesco', 'adicione um investimento de 3000 em lci itaú que eu já tinha', 'investi 500 no tesouro selic',
  'o tesouro selic está valendo 1600 agora', 'gastei 45 no mercado ontem', 'comprei um celular de 2400 em 12x no cartão inter', 'adicione conta de luz de 150 todo dia 10',
  'crie uma meta de viagem de 8000 até dezembro', 'guarde 200 na meta viagem', 'tira 500 da reserva', 'coloque um orçamento de 800 para mercado', 'coloque um orçamento de 300 para lazer',
  'me avise quando o mercado passar de 900', 'Adicione uma conta no Itaú com saldo de 2000', 'adicione um cartão nubank com limite de 5000 que fecha dia 3 e vence dia 10',
];
// the same records, whatever their order in each list (the app sorts them for display)
const stable = (v) => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v);
const canon = (D) => JSON.stringify(stable(Object.fromEntries(Object.entries(D).map(([k, v]) => [k, [...v].sort((x, y) => String(x.id).localeCompare(String(y.id)))]))));
for (const s of sentences) {
  const D = seed();
  const A = storeDouble(D);
  const before = canon(D);
  const act = parseCommand(s, ctxOf(D)).actions[0];
  const res = await executeAction(act, A);
  assert.notEqual(canon(D), before, `${s}: something was saved`);
  await undoAction(act, res, A);
  assert.equal(canon(D), before, `${s}: "Desfazer" leaves everything as it was`);
}
{
  const D = seed();
  const A = storeDouble(D);
  const act = parseCommand('wally adicione um novo investimento de 10000 em cdb bradesco', ctxOf(D)).actions[0];
  const res = await executeAction(act, A);
  const asset = D.assets.find((x) => x.id === res.assetId);
  const tx = D.txs.find((x) => x.id === res.txIds[0]);
  assert.deepEqual([asset.name, asset.kind, asset.institution, asset.initialInvested], ['CDB Bradesco', 'renda_fixa', 'Bradesco', 0]);
  assert.deepEqual([tx.type, tx.amount, tx.accountId, tx.assetId, tx.source], ['invest', 10000, 'brad', asset.id, 'wally']);
  // A monthly bill undone weeks later also takes back the months it posted.
  const bill = parseCommand('adicione conta de luz de 150 todo dia 10', ctxOf(D)).actions[0];
  const br = await executeAction(bill, A);
  D.txs.push({ id: `rec_${br.txIds[0]}_2026-12`, recurringOf: br.txIds[0], type: 'expense', amount: 150, date: '2026-12-10' });
  await undoAction(bill, br, A);
  assert.equal(D.txs.filter((x) => x.recurringOf === br.txIds[0] || x.id === br.txIds[0]).length, 0);
}
{
  // all or nothing: a failure halfway leaves nothing behind
  const D = seed();
  const A = storeDouble(D);
  const before = canon(D);
  A.saveTx = async () => { throw new Error('disk full'); };
  const act = parseCommand('wally adicione um novo investimento de 10000 em cdb bradesco', ctxOf(D)).actions[0];
  await assert.rejects(executeAction(act, A), /disk full/);
  assert.equal(canon(D), before);
}
ok(`all ${sentences.length} kinds of card: "Confirmar" saves through the app's own actions, "Desfazer" puts everything back exactly; a failure halfway leaves nothing`);

// ---- yes / no, typed or said ----
for (const s of ['sim', 'Sim!', 'pode', 'pode confirmar', 'ok', 'isso mesmo', 'manda ver', 'beleza wally', 'yes']) assert.equal(yesNo(s), 'yes', s);
for (const s of ['não', 'nao', 'cancela', 'deixa', 'esquece', 'não precisa']) assert.equal(yesNo(s), 'no', s);
for (const s of ['sim, mas muda pra 200', 'sim no nubank', 'gastei 50 no mercado', 'qual é meu saldo', 'sim sim sim sim sim sim sim']) {
  assert.equal(yesNo(s) === 'yes' && /\d|mas|nubank/.test(s), false, s);
}
assert.equal(yesNo('sim, mas muda pra 200'), null, 'a correction is not a yes');
ok('"sim" / "pode" / "ok" confirm, "não" / "cancela" cancel; a correction ("sim, mas…") is not a yes');

// ---- what Claude sees of the cards in the chat history ----
const chat = [
  { from: 'user', text: 'adicione um investimento de 10000 em cdb bradesco' },
  { from: 'bot', text: 'Preparei:', ai: true },
  { from: 'bot', action: a, state: 'done', summary: 'Novo investimento: Nome CDB Bradesco · Valor aplicado R$ 10.000,00' },
  { from: 'user', text: 'na verdade foram 12 mil' },
  { from: 'bot', text: 'Ok' },
];
const h = historyFor(chat);
assert.equal(h.length, 4);
assert.match(h[1].content, /Preparei:\n\n\[confirmed and saved\] Novo investimento: Nome CDB Bradesco/);
assert.ok(!JSON.stringify(h).includes('"brad"') && !JSON.stringify(h).includes('act_'), 'no internal ids in the history');
ok('chat history: each card goes to the AI as one line with what the person did with it (no ids)');

// ---- voice ----
assert.equal(speechText('Feito ✅ **R$ 10,00** • no Nubank\n\n[veja](https://x.y) Ok 🦉 (https://a.b) [nota]'), 'Feito R$ 10,00, no Nubank. veja Ok');
const voices = [
  { name: 'Joana', lang: 'pt-PT', localService: true }, { name: 'Samantha', lang: 'en-US', localService: true },
  { name: 'Google português do Brasil', lang: 'pt-BR' }, { name: 'Luciana', lang: 'pt-BR', localService: true }, { name: 'Luciana (Aprimorada)', lang: 'pt-BR', localService: true },
];
assert.equal(pickVoice('pt', voices).name, 'Luciana (Aprimorada)');
assert.equal(pickVoice('pt', voices.slice(0, 2)).name, 'Joana', 'Portugal’s Portuguese when there is no Brazilian voice');
assert.equal(pickVoice('en', voices).name, 'Samantha');
assert.equal(pickVoice('pt', []), null);
const longAnswer = `Este mês você gastou R$ 3.200,00. ${'Mercado subiu bastante, transporte caiu um pouco, lazer ficou igual, '.repeat(6)}e o resto ficou parecido. Quer dicas?`;
const parts = speechChunks(longAnswer);
assert.ok(parts.length >= 3 && parts.every((x) => x.length <= 220), JSON.stringify(parts.map((x) => x.length)));
assert.equal(parts.join(' '), longAnswer.replace(/\s+/g, ' ').trim(), 'nothing is lost between the pieces');
ok('voice: answers are read without emoji, symbols or links, in sentence-sized pieces; the nicest Brazilian voice is picked');

// ---- a whole question through askAi: the local model asks for an action, the device prepares a card ----
globalThis.fetch = async () => { throw new Error('no network: the AI runs on the device'); };
const calls = [];
const engine = async (messages) => {
  calls.push(messages);
  const last = messages[messages.length - 1].content;
  return last.includes('<tool_response>')
    ? 'Preparei: é só confirmar no cartão.'
    : '<tool_call>{"name": "add_investment", "arguments": {"type": "CDB", "institution": "Bradesco", "amount": 10000}}</tool_call>\n<tool_call>{"name": "add_transaction", "arguments": {"amount": 30, "account": "Itaú"}}</tool_call>';
};
const { askAi } = await import('../src/lib/aiChat.js');
const ans = await askAi('wally adicione um novo investimento de 10000 em cdb bradesco e 30 de uber no itaú', { ctx: { ...ctx, txs: [] }, actionCtx: ctx, lang: 'pt', currency: 'BRL', today, engine });
assert.equal(ans.text, 'Preparei: é só confirmar no cartão.');
assert.equal(ans.actions.length, 1);
assert.deepEqual([ans.actions[0].kind, ans.actions[0].name, ans.actions[0].amount], ['add_investment', 'CDB Bradesco', 10000]);
const results = calls[1][calls[1].length - 1].content.match(/<tool_response>[\s\S]*?<\/tool_response>/g);
assert.equal(results.length, 2);
const r0 = JSON.parse(results[0].replace(/^<tool_response>add_investment: |<\/tool_response>$/g, ''));
assert.equal(r0.status, 'waiting_for_confirmation');
assert.match(r0.card, /CDB Bradesco/);
const r1 = JSON.parse(results[1].replace(/^<tool_response>add_transaction: |<\/tool_response>$/g, ''));
assert.equal(r1.error, 'unknown_account');
assert.ok(!/"brad"|act_|"accountId"/.test(JSON.stringify(calls)), 'no internal ids reach the model');
ok('askAi: the local model’s action becomes a card on the device (nothing saved), it learns it waits for confirmation; a bad one comes back as an error to fix');

console.log(`\n${passed} checks passed`);
process.exit(0); // (the app's database module keeps a channel to other tabs open)
