/**
 * Wally can add things for the person: an expense, a monthly bill, an investment, a goal, a budget, an alert,
 * an account or a card. Whoever asks for it — the local AI through an "action tool", or the on-device Wally reading a
 * sentence — the result is only a PROPOSAL, shown as a card in the chat. Nothing is saved until the person taps
 * "Confirmar" (or says "sim"); then it runs here, on the device, through the same store actions as the forms,
 * and it can be undone.
 *
 * prepareAction(name, input, ctx) -> { action } | { error, ... }   (input = what the AI sent, or the parser built)
 * describeAction(action, ctx)     -> { title, rows: [[label, value]] } for the card
 * actionSummary(action, ctx)      -> one line (the tool result for the AI, the history, the voice)
 * executeAction(action, A)        -> result (ids, for undo)
 * undoAction(action, result, A, D)
 * parseCommand(text, ctx)         -> { actions, errors } | null   (Wally without AI)
 */
import { resolveCategory } from './aiTools.js';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, guessCategory } from './categories.js';
import { ASSET_KINDS } from './investments.js';
import { addDays, addMonths, daysInMonth, monthKey } from './dates.js';
import { formatDate, round2, uid } from './format.js';
import { parseQuick } from './quickparse.js';
import { DEFAULT_ACCOUNT_ID, ACCOUNT_TYPES, CARD_BRANDS } from './ledger.js';

export const ACTION_TOOL_NAMES = [
  'add_transaction', 'add_recurring', 'add_investment', 'move_investment', 'update_investment_value',
  'add_goal', 'add_to_goal', 'set_budget', 'add_alert', 'add_account', 'add_card',
];
export const isActionTool = (name) => ACTION_TOOL_NAMES.includes(name);

const MAX_AMOUNT = 100_000_000;
const strip = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
export const norm = (s) => strip(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "10.000,00", "10000", 10000, "R$ 1.234,5", "2 mil" -> number (or NaN). */
export function toAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? round2(Math.abs(v)) : NaN;
  let s = strip(v).toLowerCase().replace(/r\$|us\$|\$|reais|real/g, '').trim();
  if (!s) return NaN;
  let mult = 1;
  if (/\bmil\b|k$/.test(s)) { mult = 1000; s = s.replace(/\bmil\b|k$/g, '').trim(); }
  s = s.replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  const n = Number(s) * mult;
  return Number.isFinite(n) ? round2(Math.abs(n)) : NaN;
}
const goodAmount = (n) => Number.isFinite(n) && n > 0 && n <= MAX_AMOUNT;
const clampDay = (d, def) => {
  const n = Math.round(Number(d));
  return Number.isFinite(n) && n >= 1 && n <= 31 ? n : def;
};

/** The item of `list` the words point to: same name, then a name that contains them, then most words in common. */
export function findNamed(list, query, fields = ['name', 'institution']) {
  const q = norm(query);
  if (!q || !list?.length) return null;
  const names = (x) => fields.map((f) => norm(x[f] || '')).filter(Boolean);
  const full = (x) => norm(fields.map((f) => x[f] || '').join(' '));
  return list.find((x) => norm(x[fields[0]] || '') === q)
    || list.find((x) => names(x).some((n) => n.includes(q) || (q.length >= 4 && q.includes(n) && n.length >= 3)))
    || (() => {
      const qw = q.split(' ').filter((w) => w.length >= 3);
      let best = null, score = 0;
      for (const x of list) {
        const words = new Set(full(x).split(' '));
        const s = qw.filter((w) => words.has(w)).length;
        if (s > score) { best = x; score = s; }
      }
      return score ? best : null;
    })();
}

// ---------------- what the person's words map to ----------------
const ASSET_WORDS = [
  ['renda_fixa', /\b(cdb|lci|lca|lc|cri|cra|lig|debenture|debentures|renda fixa|rdb)\b/],
  ['tesouro', /\b(tesouro|selic|ipca|prefixado|ntn)\b/],
  ['poupanca', /\b(poupanca|savings)\b/],
  ['previdencia', /\b(previdencia|pgbl|vgbl)\b/],
  ['fii', /\b(fii|fiis|fundo imobiliario|fundos imobiliarios|imobiliario)\b/],
  ['etf', /\b(etf|etfs|bova11|ivvb11)\b/],
  ['cripto', /\b(cripto|criptomoeda|bitcoin|btc|ethereum|eth|usdt|solana)\b/],
  ['acoes', /\b(acao|acoes|stock|stocks|bolsa)\b/],
  ['fundos', /\b(fundo|fundos|multimercado)\b/],
];
const PRODUCT_LABEL = [
  [/\bcdb\b/, 'CDB'], [/\blci\b/, 'LCI'], [/\blca\b/, 'LCA'], [/\bcri\b/, 'CRI'], [/\bcra\b/, 'CRA'], [/\brdb\b/, 'RDB'], [/\bdebentures?\b/, 'Debênture'],
  [/\btesouro selic\b|\bselic\b/, 'Tesouro Selic'], [/\btesouro ipca\b|\bipca\b/, 'Tesouro IPCA+'], [/\bprefixado\b/, 'Tesouro Prefixado'], [/\btesouro\b/, 'Tesouro Direto'],
  [/\bpoupanca\b/, 'Poupança'], [/\bpgbl\b/, 'PGBL'], [/\bvgbl\b/, 'VGBL'], [/\bprevidencia\b/, 'Previdência'],
  [/\bbitcoin\b|\bbtc\b/, 'Bitcoin'], [/\bethereum\b|\beth\b/, 'Ethereum'], [/\bfii\b/, 'FII'], [/\betf\b/, 'ETF'],
];
const BANKS = [
  ['Banco do Brasil', /\b(banco do brasil|bb)\b/], ['Caixa', /\b(caixa|cef)\b/], ['Itaú', /\bitau\b/], ['Bradesco', /\bbradesco\b/],
  ['Santander', /\bsantander\b/], ['Nubank', /\b(nubank|nu)\b/], ['Inter', /\binter\b/], ['C6 Bank', /\bc6\b/], ['BTG', /\bbtg\b/],
  ['XP', /\bxp\b/], ['Rico', /\brico\b/], ['Clear', /\bclear\b/], ['NuInvest', /\bnuinvest\b/], ['PicPay', /\bpicpay\b/],
  ['Mercado Pago', /\bmercado pago\b/], ['PagBank', /\b(pagbank|pagseguro)\b/], ['Sicredi', /\bsicredi\b/], ['Sicoob', /\bsicoob\b/],
  ['Banco Original', /\boriginal\b/], ['Neon', /\bneon\b/], ['Safra', /\bsafra\b/], ['Banrisul', /\bbanrisul\b/], ['Modal', /\bmodal\b/],
  ['Órama', /\borama\b/], ['Toro', /\btoro\b/], ['Genial', /\bgenial\b/], ['Avenue', /\bavenue\b/], ['Binance', /\bbinance\b/],
  ['Mercado Bitcoin', /\bmercado bitcoin\b/], ['Ágora', /\bagora investimentos\b/], ['Will Bank', /\bwill bank\b/],
];
export function assetKindOf(words) {
  const q = norm(words);
  if (ASSET_KINDS.some((k) => k.key === q)) return q;
  for (const [key, re] of ASSET_WORDS) if (re.test(q)) return key;
  return 'outros';
}
export function bankOf(words) {
  const q = norm(words);
  for (const [name, re] of BANKS) if (re.test(q)) return name;
  return '';
}
/** A bank named as the place the money went: "no Itaú", "pelo Nubank", "na conta do Inter" (not "uma caixa de leite"). */
function bankWhere(q) {
  for (const [name, re] of BANKS) {
    const m = re.exec(q);
    if (m && /\b(?:no|na|pelo|pela|via|com o|com a)\s+(?:(?:banco|conta|cartao)\s+(?:(?:do|da)\s+)?)?$/.test(q.slice(0, m.index))) return name;
  }
  return '';
}
const productOf = (words) => {
  const q = norm(words);
  for (const [re, label] of PRODUCT_LABEL) if (re.test(q)) return label;
  return '';
};
const GOAL_EMOJI = [
  [/viag|ferias|trip|travel/, '✈️'], [/carro|moto|veiculo|car\b/, '🚗'], [/casa|apartamento|ape|imovel|home|house/, '🏠'],
  [/reserva|emergencia|emergency/, '🛟'], [/estudo|faculdade|curso|intercambio|school/, '🎓'], [/casamento|wedding/, '💍'],
  [/celular|iphone|notebook|computador|phone|laptop/, '📱'], [/filho|filha|bebe|baby/, '🍼'], [/aposentadoria|retire/, '🌴'],
];
const goalEmoji = (title) => {
  const q = norm(title);
  for (const [re, e] of GOAL_EMOJI) if (re.test(q)) return e;
  return '🎯';
};

/** The person's main account: the default one ("Conta principal"), else the first. */
const mainAccount = (ctx) => ctx.accounts.find((a) => a.id === DEFAULT_ACCOUNT_ID) || ctx.accounts[0] || { id: DEFAULT_ACCOUNT_ID, name: ctx.t('acc.defaultName') };
function accountFor(ctx, name, { fallback = true } = {}) {
  if (name) {
    const a = findNamed(ctx.accounts, name);
    if (!a) return { error: 'unknown_account', accounts: ctx.accounts.map((x) => x.name), asked: text(name, 40) };
    return { account: a };
  }
  return fallback ? { account: mainAccount(ctx) } : { account: null };
}
function cardFor(ctx, name) {
  const c = findNamed(ctx.cards, name);
  if (!c) return { error: 'unknown_card', cards: ctx.cards.map((x) => x.name) };
  return { card: c };
}
const categoryKeys = (ctx, type) => (type === 'income'
  ? [...INCOME_CATEGORIES.map((c) => c.key), ...(ctx.categories || []).filter((c) => !c.archived && c.type === 'income').map((c) => c.key)]
  : [...EXPENSE_CATEGORIES.map((c) => c.key), ...(ctx.categories || []).filter((c) => !c.archived && c.type !== 'income').map((c) => c.key)]);
function categoryFor(ctx, type, category, description) {
  if (category) {
    const k = resolveCategory(String(category), ctx);
    if (k && categoryKeys(ctx, type).includes(k)) return k;
  }
  return guessCategory(description || category || '', type);
}
const nextDay = (today, day) => {
  const mk = monthKey(today);
  const d = Math.min(day, daysInMonth(mk));
  const here = `${mk}-${String(d).padStart(2, '0')}`;
  if (here >= today) return here;
  const nk = addMonths(mk, 1);
  return `${nk}-${String(Math.min(day, daysInMonth(nk))).padStart(2, '0')}`;
};
const endOfMonth = (mk) => `${mk}-${String(daysInMonth(mk)).padStart(2, '0')}`;

// ---------------- proposals ----------------
const PREPARE = {
  add_transaction(input, ctx) {
    const type = input.type === 'income' ? 'income' : 'expense';
    const amount = toAmount(input.amount);
    if (!goodAmount(amount)) return { error: 'missing_amount' };
    const description = cap(text(input.description, 80));
    const date = isDay(input.date) ? input.date : ctx.today;
    let accountId = null, cardId = null;
    if (input.card && type === 'expense') {
      const r = cardFor(ctx, input.card);
      if (r.error) return r;
      cardId = r.card.id;
    } else {
      const r = accountFor(ctx, input.account);
      if (r.error) return r;
      accountId = r.account.id;
    }
    const installments = cardId ? Math.min(Math.max(Math.round(Number(input.installments) || 1), 1), 48) : 1;
    const status = cardId ? 'paid' : input.paid === false || (date > ctx.today && input.paid !== true) ? 'pending' : 'paid';
    return { action: { kind: 'add_transaction', type, amount, description, category: categoryFor(ctx, type, input.category, description), date, accountId, cardId, installments, status } };
  },

  add_recurring(input, ctx) {
    const type = input.type === 'income' ? 'income' : 'expense';
    const amount = toAmount(input.amount);
    if (!goodAmount(amount)) return { error: 'missing_amount' };
    const description = cap(text(input.description, 80));
    if (!description) return { error: 'missing_description' };
    const day = clampDay(input.day_of_month, Number((isDay(input.first_date) ? input.first_date : ctx.today).slice(8, 10)));
    const date = isDay(input.first_date) ? input.first_date : nextDay(ctx.today, day);
    let accountId = null, cardId = null;
    if (input.card && type === 'expense') {
      const r = cardFor(ctx, input.card);
      if (r.error) return r;
      cardId = r.card.id;
    } else {
      const r = accountFor(ctx, input.account);
      if (r.error) return r;
      accountId = r.account.id;
    }
    // A bill waits to be marked paid each month (so it shows in "a pagar"); a card charge or an income goes by itself.
    const autoPay = input.confirm_each === true ? false : input.confirm_each === false ? true : !!cardId || type === 'income';
    return {
      action: {
        kind: 'add_recurring', type, amount, description, category: categoryFor(ctx, type, input.category, description), date, day, accountId, cardId, autoPay,
        status: cardId ? 'paid' : date > ctx.today || !autoPay ? 'pending' : 'paid',
      },
    };
  },

  add_investment(input, ctx) {
    const words = [input.type, input.name, input.institution].filter(Boolean).join(' ');
    const institution = text(input.institution, 40) || bankOf(words);
    const assetKind = assetKindOf(input.type || words);
    const product = productOf(words);
    const name = text(input.name, 50) || [product || ctx.t(`kind.${assetKind}`), institution].filter(Boolean).join(' ');
    if (!name) return { error: 'missing_name' };
    const amount = toAmount(input.amount);
    if (!goodAmount(amount)) return { error: 'missing_amount' };
    // Already in the portfolio: this is a new contribution to it.
    const same = ctx.assets.find((a) => a.source !== 'openfinance' && norm(a.name) === norm(name));
    if (same && input.already_invested !== true) return PREPARE.move_investment({ investment: same.name, direction: 'invest', amount, date: input.date, account: input.from_account }, ctx);
    const existing = input.already_invested === true;
    let accountId = null;
    if (!existing) {
      const r = accountFor(ctx, input.from_account);
      if (r.error) return r;
      accountId = r.account.id;
      // "CDB Bradesco" with a Bradesco account: the money most likely leaves that account
      const same = !input.from_account && institution ? findNamed(ctx.accounts, institution) : null;
      if (same) accountId = same.id;
    }
    return { action: { kind: 'add_investment', name: cap(name), assetKind, institution, amount, date: isDay(input.date) ? input.date : ctx.today, accountId, existing } };
  },

  move_investment(input, ctx) {
    const mine = ctx.assets.filter((a) => a.source !== 'openfinance');
    const asset = findNamed(mine, input.investment);
    if (!asset) return { error: 'unknown_investment', investments: mine.map((a) => a.name) };
    const amount = toAmount(input.amount);
    if (!goodAmount(amount)) return { error: 'missing_amount' };
    const r = accountFor(ctx, input.account);
    if (r.error) return r;
    return { action: { kind: 'move_investment', assetId: asset.id, assetName: asset.name, direction: input.direction === 'redeem' ? 'redeem' : 'invest', amount, date: isDay(input.date) ? input.date : ctx.today, accountId: r.account.id } };
  },

  update_investment_value(input, ctx) {
    const mine = ctx.assets.filter((a) => a.source !== 'openfinance');
    const asset = findNamed(mine, input.investment);
    if (!asset) return { error: 'unknown_investment', investments: mine.map((a) => a.name) };
    const value = toAmount(input.current_value);
    if (!Number.isFinite(value) || value > MAX_AMOUNT) return { error: 'missing_amount' };
    return { action: { kind: 'update_investment_value', assetId: asset.id, assetName: asset.name, value } };
  },

  add_goal(input, ctx) {
    const title = cap(text(input.title, 40));
    if (!title) return { error: 'missing_title' };
    const target = toAmount(input.target);
    if (!goodAmount(target)) return { error: 'missing_amount' };
    const saved = Number.isFinite(toAmount(input.saved_so_far)) ? Math.min(toAmount(input.saved_so_far), target) : 0;
    const deadline = isDay(input.deadline) ? input.deadline : isMonth(input.deadline) ? endOfMonth(input.deadline) : null;
    return { action: { kind: 'add_goal', title, target, saved, deadline: deadline && deadline > ctx.today ? deadline : null, emoji: text(input.emoji, 4) || goalEmoji(title) } };
  },

  add_to_goal(input, ctx) {
    const goal = findNamed(ctx.goals, input.goal, ['title']);
    if (!goal) return { error: 'unknown_goal', goals: ctx.goals.map((g) => g.title) };
    const n = toAmount(input.amount);
    if (!goodAmount(n)) return { error: 'missing_amount' };
    const amount = input.withdraw === true || Number(input.amount) < 0 ? -Math.min(n, goal.current || 0) : n;
    if (!amount) return { error: 'goal_empty' };
    return { action: { kind: 'add_to_goal', goalId: goal.id, goalTitle: goal.title, amount } };
  },

  set_budget(input, ctx) {
    const category = resolveCategory(String(input.category || ''), ctx);
    if (!category || !categoryKeys(ctx, 'expense').includes(category)) {
      return { error: 'unknown_category', categories: categoryKeys(ctx, 'expense').map((k) => ctx.t(`cat.${k}`)) };
    }
    const limit = toAmount(input.monthly_limit);
    if (!goodAmount(limit)) return { error: 'missing_amount' };
    const prev = ctx.budgets.find((b) => b.category === category && !b.space);
    return { action: { kind: 'set_budget', category, limit, prevLimit: prev ? Number(prev.limit) : null } };
  },

  add_alert(input, ctx) {
    const limit = toAmount(input.limit);
    if (!goodAmount(limit)) return { error: 'missing_amount' };
    const period = input.period === 'purchase' ? 'purchase' : 'month';
    let category = null;
    let merchant = '';
    if (input.category) {
      category = resolveCategory(String(input.category), ctx);
      if (!category || !categoryKeys(ctx, 'expense').includes(category)) return { error: 'unknown_category', categories: categoryKeys(ctx, 'expense').map((k) => ctx.t(`cat.${k}`)) };
    } else if (input.merchant) merchant = text(input.merchant, 40);
    const what = category ? 'category' : merchant ? 'merchant' : 'any';
    return { action: { kind: 'add_alert', what, category, merchant, limit, period } };
  },

  add_account(input, ctx) {
    const name = cap(text(input.name, 40)) || bankOf(input.institution || '');
    if (!name) return { error: 'missing_name' };
    if (findNamed(ctx.accounts, name, ['name']) && norm(findNamed(ctx.accounts, name, ['name']).name) === norm(name)) return { error: 'account_exists', accounts: ctx.accounts.map((a) => a.name) };
    const accType = ACCOUNT_TYPES.includes(input.account_type) ? input.account_type : 'checking';
    const balance = Number.isFinite(Number(input.balance)) || typeof input.balance === 'string' ? toAmount(input.balance) * (Number(input.balance) < 0 ? -1 : 1) : 0;
    return { action: { kind: 'add_account', name, accType, institution: text(input.institution, 40) || bankOf(name), balance: Number.isFinite(balance) ? balance : 0 } };
  },

  add_card(input, ctx) {
    const name = cap(text(input.name, 40));
    if (!name) return { error: 'missing_name' };
    const limit = toAmount(input.limit);
    const brand = CARD_BRANDS.includes(norm(input.brand)) ? norm(input.brand) : 'other';
    return {
      action: {
        kind: 'add_card', name, brand, limit: Number.isFinite(limit) ? limit : 0,
        closingDay: clampDay(input.closing_day, 1), dueDay: clampDay(input.due_day, 10), institution: text(input.institution, 40) || bankOf(name),
      },
    };
  },
};

/** A tool call (the AI) or a parsed sentence -> a proposal for a card, or an error the AI can act on. */
export function prepareAction(name, input, ctx) {
  const fn = PREPARE[name];
  if (!fn) return { error: 'unknown_action' };
  try {
    const r = fn(input && typeof input === 'object' ? input : {}, ctx);
    if (r.action) r.action.id = `act_${uid()}`;
    return r;
  } catch {
    return { error: 'action_failed' };
  }
}

// ---------------- the card ----------------
const where = (a, ctx) => (a.cardId ? ctx.cards.find((c) => c.id === a.cardId)?.name : ctx.accounts.find((x) => x.id === a.accountId)?.name) || ctx.t('acc.defaultName');
const day = (iso, ctx) => formatDate(iso, ctx.lang, { day: 'numeric', month: 'long' });

export function describeAction(a, ctx) {
  const { t, money } = ctx;
  switch (a.kind) {
    case 'add_transaction': {
      const parcel = a.installments > 1 ? ` · ${t('act2.installments', { n: a.installments, v: money(round2(a.amount / a.installments)) })}` : '';
      return {
        title: t(a.type === 'income' ? (a.status === 'pending' ? 'act2.t.incomeLater' : 'act2.t.income') : a.status === 'pending' ? 'act2.t.bill' : 'act2.t.expense'),
        rows: [
          [t('act2.amount'), `${money(a.amount)}${parcel}`],
          ...(a.description ? [[t('act2.description'), a.description]] : []),
          [t('act2.category'), t(`cat.${a.category}`)],
          [t('act2.date'), day(a.date, ctx)],
          [t(a.cardId ? 'act2.card' : 'act2.account'), where(a, ctx), a.cardId ? 'card' : 'account'],
        ],
      };
    }
    case 'add_recurring':
      return {
        title: t(a.type === 'income' ? 'act2.t.recurringIn' : 'act2.t.recurring'),
        rows: [
          [t('act2.description'), a.description], [t('act2.amount'), money(a.amount)],
          [t('act2.every'), t('act2.everyDay', { d: a.day })], [t('act2.first'), day(a.date, ctx)],
          [t('act2.category'), t(`cat.${a.category}`)], [t(a.cardId ? 'act2.card' : 'act2.account'), where(a, ctx), a.cardId ? 'card' : 'account'],
        ],
      };
    case 'add_investment':
      return {
        title: t('act2.t.investment'),
        rows: [
          [t('act2.name'), a.name], [t('act2.kind'), t(`kind.${a.assetKind}`)],
          ...(a.institution ? [[t('act2.institution'), a.institution]] : []),
          [t(a.existing ? 'act2.alreadyHad' : 'act2.invested'), money(a.amount)],
          a.existing ? [t('act2.balance'), t('act2.noDebit')] : [t('act2.from'), where(a, ctx), 'account'],
          ...(a.existing ? [] : [[t('act2.date'), day(a.date, ctx)]]),
        ],
      };
    case 'move_investment':
      return {
        title: t(a.direction === 'redeem' ? 'act2.t.redeem' : 'act2.t.contribute', { n: a.assetName }),
        rows: [[t('act2.amount'), money(a.amount)], [t(a.direction === 'redeem' ? 'act2.to' : 'act2.from'), where(a, ctx), 'account'], [t('act2.date'), day(a.date, ctx)]],
      };
    case 'update_investment_value':
      return { title: t('act2.t.value', { n: a.assetName }), rows: [[t('act2.valueNow'), money(a.value)]] };
    case 'add_goal':
      return {
        title: t('act2.t.goal'),
        rows: [
          [t('act2.goal'), `${a.emoji} ${a.title}`], [t('act2.target'), money(a.target)],
          ...(a.deadline ? [[t('act2.deadline'), formatDate(a.deadline, ctx.lang, { day: 'numeric', month: 'long', year: 'numeric' })]] : []),
          ...(a.saved ? [[t('act2.saved'), money(a.saved)]] : []),
        ],
      };
    case 'add_to_goal':
      return { title: t(a.amount > 0 ? 'act2.t.toGoal' : 'act2.t.fromGoal', { n: a.goalTitle }), rows: [[t('act2.amount'), money(Math.abs(a.amount))]] };
    case 'set_budget':
      return {
        title: t('act2.t.budget', { c: t(`cat.${a.category}`) }),
        rows: [[t('act2.perMonth'), money(a.limit)], ...(a.prevLimit != null ? [[t('act2.before'), money(a.prevLimit)]] : [])],
      };
    case 'add_alert':
      return {
        title: t('act2.t.alert'),
        rows: [[t('act2.when'), t(a.period === 'purchase' ? 'act2.alertBuy' : 'act2.alertMonth', {
          w: a.what === 'category' ? t(`cat.${a.category}`) : a.what === 'merchant' ? a.merchant : t('act2.anything'), v: money(a.limit),
        })]],
      };
    case 'add_account':
      return { title: t('act2.t.account'), rows: [[t('act2.name'), a.name], [t('act2.type'), t(`acc.type.${a.accType}`)], [t('act2.balanceToday'), money(a.balance)]] };
    case 'add_card':
      return {
        title: t('act2.t.card'),
        rows: [[t('act2.name'), a.name], ...(a.limit ? [[t('act2.limit'), money(a.limit)]] : []), [t('act2.closes'), t('act2.everyDay', { d: a.closingDay })], [t('act2.due'), t('act2.everyDay', { d: a.dueDay })]],
      };
    default:
      return { title: '—', rows: [] };
  }
}

/** One line: what was prepared (sent back to the AI, kept in the chat history, read aloud). */
export function actionSummary(a, ctx) {
  const d = describeAction(a, ctx);
  return `${d.title}: ${d.rows.map(([k, v]) => `${k} ${v}`).join(' · ')}`;
}

/** What the person can still change on the card before confirming: the account, and "already had it" for investments. */
export function editAction(a, patch, ctx) {
  const next = { ...a };
  if (patch.accountId !== undefined && 'accountId' in a && !a.cardId && ctx.accounts.some((x) => x.id === patch.accountId)) next.accountId = patch.accountId;
  if (patch.existing !== undefined && a.kind === 'add_investment') {
    next.existing = !!patch.existing;
    if (next.existing) { next.prevAccountId = a.accountId || a.prevAccountId || null; next.accountId = null; } else next.accountId = a.accountId || a.prevAccountId || mainAccount(ctx).id;
  }
  return next;
}

// ---------------- doing it (after the person confirmed) ----------------
export async function executeAction(a, A) {
  switch (a.kind) {
    case 'add_transaction': {
      const row = await A.saveTx({
        type: a.type, amount: a.amount, category: a.category, description: a.description, date: a.date,
        accountId: a.accountId, cardId: a.cardId, installments: a.installments, status: a.status, source: 'wally',
      });
      return { txIds: [row.id], group: row.installment?.group || null };
    }
    case 'add_recurring': {
      const row = await A.saveTx({
        type: a.type, amount: a.amount, category: a.category, description: a.description, date: a.date, accountId: a.accountId, cardId: a.cardId,
        status: a.status, recurring: true, autoPay: a.autoPay, source: 'wally',
      });
      return { txIds: [row.id] };
    }
    case 'add_investment': {
      const asset = await A.saveAsset({ name: a.name, kind: a.assetKind, institution: a.institution, initialInvested: a.existing ? a.amount : 0 });
      if (a.existing) return { assetId: asset.id, txIds: [] };
      try {
        const row = await A.saveTx({ type: 'invest', amount: a.amount, category: 'invest', description: a.name, date: a.date, accountId: a.accountId, assetId: asset.id, source: 'wally' });
        return { assetId: asset.id, txIds: [row.id] };
      } catch (e) {
        await A.deleteAsset(asset).catch(() => {}); // all or nothing: "Confirmar" can be tried again
        throw e;
      }
    }
    case 'move_investment': {
      const row = await A.saveTx({
        type: a.direction, amount: a.amount, category: a.direction === 'redeem' ? 'redeem' : 'invest', description: a.assetName, date: a.date,
        accountId: a.accountId, assetId: a.assetId, source: 'wally',
      });
      return { txIds: [row.id] };
    }
    case 'update_investment_value': {
      const asset = A.data().assets.find((x) => x.id === a.assetId);
      if (!asset) throw Object.assign(new Error('gone'), { code: 'gone' });
      await A.addValuation(asset, a.value);
      return { prevValuations: asset.valuations || [] };
    }
    case 'add_goal': {
      const g = await A.saveGoal({ title: a.title, target: a.target, current: a.saved, deadline: a.deadline, emoji: a.emoji });
      return { goalId: g.id };
    }
    case 'add_to_goal': {
      const goal = A.data().goals.find((x) => x.id === a.goalId);
      if (!goal) throw Object.assign(new Error('gone'), { code: 'gone' });
      const txId = uid();
      await A.addFunds(goal, a.amount, { record: true, txId });
      return { prevGoal: goal, txIds: [txId] };
    }
    case 'set_budget': {
      const prev = A.data().budgets.find((b) => b.category === a.category && !b.space) || null;
      const id = prev?.id || uid();
      await A.saveBudget({ id, category: a.category, limit: a.limit, space: null });
      return { budgetId: id, prev };
    }
    case 'add_alert': {
      const rule = await A.saveAlertRule({ what: a.what, category: a.category, text: a.merchant, limit: a.limit, period: a.period });
      return { ruleId: rule.id };
    }
    case 'add_account': {
      const acc = await A.saveAccountItem({ name: a.name, type: a.accType, institution: a.institution, initialBalance: a.balance });
      return { accountId: acc.id };
    }
    case 'add_card': {
      const card = await A.saveCard({ name: a.name, brand: a.brand, limit: a.limit, closingDay: a.closingDay, dueDay: a.dueDay, institution: a.institution });
      return { cardId: card.id };
    }
    default:
      throw Object.assign(new Error('unknown_action'), { code: 'unknown_action' });
  }
}

/** "Desfazer": takes back exactly what executeAction created or changed. */
export async function undoAction(a, r, A) {
  const D = A.data();
  const dropTxs = async () => {
    for (const id of r?.txIds || []) {
      const tx = D.txs.find((x) => x.id === id);
      if (tx) await A.deleteTx(tx, { group: !!tx.installment?.group, skip: false });
    }
    if (r?.group) {
      const left = A.data().txs.filter((x) => x.installment?.group === r.group);
      if (left.length) await A.deleteTx(left[0], { group: true, skip: false });
    }
  };
  switch (a.kind) {
    case 'add_transaction': case 'move_investment':
      await dropTxs(); break;
    case 'add_recurring': {
      // the bill itself, and the months it already posted (undone weeks later)
      await dropTxs();
      const ids = new Set(r?.txIds || []);
      for (const x of A.data().txs.filter((tx) => ids.has(tx.recurringOf))) await A.deleteTx(x, { skip: false });
      break;
    }
    case 'add_investment': {
      // the investment first (it unlinks its movements), then the movement it created
      const asset = A.data().assets.find((x) => x.id === r.assetId);
      if (asset) await A.deleteAsset(asset);
      await dropTxs();
      break;
    }
    case 'update_investment_value': {
      const asset = D.assets.find((x) => x.id === a.assetId);
      if (asset) await A.saveAsset({ ...asset, valuations: r.prevValuations || [] });
      break;
    }
    case 'add_goal': await A.deleteGoal(r.goalId); break;
    case 'add_to_goal': {
      await dropTxs();
      if (r.prevGoal) await A.saveGoal({ ...r.prevGoal });
      break;
    }
    case 'set_budget':
      if (r.prev) await A.saveBudget({ ...r.prev }); else await A.deleteBudget(r.budgetId);
      break;
    case 'add_alert': await A.deleteAlertRule(r.ruleId); break;
    case 'add_account': {
      const acc = D.accounts.find((x) => x.id === r.accountId);
      if (acc) await A.deleteAccountItem(acc);
      break;
    }
    case 'add_card': {
      const card = D.cards.find((x) => x.id === r.cardId);
      if (card) await A.deleteCard(card);
      break;
    }
    default: break;
  }
}

// ---------------- Wally without AI: sentences that ask to add something ----------------
// Asking ("adicione…", "registre…", "crie…") or telling about money that moved ("gastei…", "recebi…", "investi…").
const VERB = /^(?:(?:ei|oi|ola|o|hey|hi|ok)\s+)?(?:wally\s+)?(?:(?:por favor|please)\s+)?(?:me\s+)?(?:adicion|acrescent|add\b|log\b|record|regist|creat|put\b|save\b|set\b|track|remind|invest\b|withdraw|take\b|registr|lanc|anot|cadastr|colo(?:c|qu)|bot[ae]|pon(?:ha|he)|cri[ae]|salv|inclu|mar(?:c|qu)|agend|avis|guard[ae]|deposit[ae]|separ[ae]|invist[ae]|apli(?:c|qu)[ae]|aport[ae]|resgat[ae]|tir[ae])\w*/;
const MONTHLY = /\b(todo mes|todos os meses|mensal|mensalmente|todo dia \d{1,2}|por mes|every month|each month|monthly|per month|a month(?! ago))\b/;
const MONEY_VERB = /\b(gastei|paguei|comprei|recebi|ganhei|investi|apliquei|aportei|resgatei|guardei|spent|paid|bought|received|earned|invested|withdrew)\b/;
// The command at the start, in the person's own spelling: removed before reading amounts and descriptions.
const PREFIX = /^\s*(?:(?:ei|oi|olá|ola|ô|ó|hey|hi|ok)[\s,!]+)?(?:wally[\s,!.:]*)?(?:(?:por favor|please)[\s,]*)?(?:(?:add|log|record|register|create|put|save|track)\s+(?:(?:an?|the|my)\s+)?(?:new\s+)?(?:(?:expense|purchase|income|entry|transaction|payment)\s+(?:of\s+|for\s+)?)?|(?:me\s+)?(?:adicion|acrescent|add|registr|lan[cç]|anot|cadastr|colo(?:c|qu)|bot|pon|cri|salv|inclu|mar(?:c|qu)|agend)[a-zà-ú]*[\s,]+(?:(?:a[ií]|aqui|pra mim|para mim|rapidinho|por favor|que)[\s,]+)*(?:(?:um|uma|o|a)\s+)?(?:(?:novo|nova)\s+)?(?:(?:gasto|despesa|lan[cç]amento|entrada|receita|compra|registro|valor)\s+(?:de\s+)?)?)?/i;
const stripPrefix = (s) => String(s || '').replace(PREFIX, '').trim();
/** What a bill or income is called, from the sentence: "adicione minha conta de luz de 150 todo dia 10" -> "Conta de luz". */
const ACCENT = { a: '[aáàâã]', e: '[eéê]', i: '[ií]', o: '[oóôõ]', u: '[uúü]', c: '[cç]' };
const looseRe = (name) => strip(name).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean)
  .map((w) => w.replace(/[a-z]/g, (ch) => ACCENT[ch] || ch)).join('\\s+');
/** Removes "no Nubank", "no cartão Inter", "pelo pix"… (where the money goes is shown on its own row). */
function dropWhere(s, names) {
  for (const n of names.filter(Boolean)) {
    const re = looseRe(n);
    if (re) s = s.replace(new RegExp(`(?:\\b(?:no|na|nos|nas|do|da|pelo|pela|com|em|via|usando|on|in|at|with|from|using|to)\\s+)?(?:(?:meu|minha|o|a|the|my)\\s+)?(?:cart[aã]o\\s+(?:de\\s+cr[eé]dito\\s+)?(?:d[oa]\\s+)?)?(?:conta\\s+(?:d[oa]\\s+)?)?${re}(?![a-zà-ú0-9])`, 'gi'), ' ');
  }
  return s.replace(/\b(?:no|na|pelo|pela|via|com)\s+(?:o\s+)?(?:cart[aã]o(?:\s+de\s+cr[eé]dito)?|cr[eé]dito|d[eé]bito|pix|boleto|dinheiro)(?![a-zà-ú0-9])/gi, ' ');
}
function phrase(src, where = []) {
  let s = ` ${stripPrefix(src)} `;
  s = s.replace(/\b(?:tod[oa]s?(?:\s+(?:o|os|a|as))?\s+(?:m[eê]s(?:es)?|dias?(?:\s+\d{1,2})?))\b/gi, ' ').replace(/\b(?:por m[eê]s|mensal(?:mente)?|every month|each month|per month|a month|monthly|(?:n?o\s+)?dia\s+\d{1,2}|on\s+(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?|(?:on\s+)?day\s+\d{1,2})\b/gi, ' ');
  s = s.replace(/(?:\b(?:no valor de|de|por|com|valor)\s+)?(?:r\$|us\$|\$)?\s*\d[\d.,]*\s*(?:mil\b|k\b|reais\b|real\b|contos?\b)?/gi, ' ');
  s = s.replace(/\b(?:hoje|ontem|anteontem)\b/gi, ' ');
  s = dropWhere(s, where);
  s = s.replace(/^\s*(?:(?:o|a|os|as|um|uma|meu|minha|meus|minhas|novo|nova|mais|recebo|ganho|pago|tenho|gasto|de|do|da|a[ií]|que|pra mim|an?|the|my|new|i|get paid|earn|make|pay|receive|for|of)\s+)+/i, '');
  s = s.replace(/(?:\s+(?:de|do|da|no|na|em|com|para|pra|pro|e|on|in|at|for|of|to|and|from|the|my))+\s*$/i, '');
  return cap(s.replace(/\s+/g, ' ').trim()).slice(0, 80);
}
const YES = /^(sim|s|pode|confirm\w*|ok|okay|isso|manda|beleza|certo|claro|bora|positivo|fechado|perfeito|uhum|aham|show|yes|yep|yeah|sure|do it|go ahead)\b/;
const NO = /^(nao|n|cancel\w*|deixa|esquece|para|pare|no|nope|never ?mind)\b/;
// A plain answer only: "sim, pode salvar", "confirma todos", "deixa pra lá". Anything else ("sim, mas no Nubank") is a new message.
const YES_WORDS = new Set('sim s pode confirma confirmar confirmo confirme ok okay isso mesmo manda ver beleza certo claro bora positivo fechado perfeito uhum aham show top otimo bom ta salva salvar salve adiciona adicionar adicione registra registrar lanca lancar valeu obrigado obrigada wally por favor e tudo todos todas os as ambos dois tres esse essa esses essas ele eles yes yep yeah sure do it go ahead please all'.split(' '));
const NO_WORDS = new Set('nao n cancela cancelar cancele deixa pra la esquece precisa para pare quero nada nenhum tudo todos esse essa esses essas isso obrigado obrigada valeu wally por favor no nope never mind thanks'.split(' '));
/** "sim" / "não" to cards waiting for an answer (typed or said). */
export function yesNo(textIn) {
  const q = norm(textIn);
  const words = q.split(' ').filter(Boolean);
  if (!words.length || words.length > 6 || /\d/.test(q)) return null;
  if (YES.test(q) && words.every((w) => YES_WORDS.has(w))) return 'yes';
  if (NO.test(q) && words.every((w) => NO_WORDS.has(w))) return 'no';
  return null;
}

/**
 * Reads a sentence like "adicione um investimento de 10000 em CDB Bradesco" or "gastei 45 no mercado ontem".
 * Returns { actions, errors } (errors = what could not be prepared, e.g. an unknown investment), or null when
 * the sentence is not asking to add anything (then Wally just answers).
 */
export function parseCommand(input, ctx) {
  const src = String(input || '').trim();
  const q = norm(src);
  if (!q || /\?\s*$/.test(src)) return null;
  const telling = /\b(recebo|ganho|pago|i get paid|i earn|i make|i pay|i receive)\b/.test(q) && MONTHLY.test(q);
  const valuing = /\b(?:esta|ta)\s+valendo\b|\bvalendo agora\b|\bvale agora\b|^(?:wally\s+)?atualiz|\b(?:is|now)\s+worth\b|^(?:wally\s+)?updat/.test(q);
  if (!VERB.test(q) && !MONEY_VERB.test(q) && !telling && !valuing && !/^(?:wally\s+)?(?:tirei|resgatei|guardei|separei|abri|let me know|notify me|warn me|tell me when|alert me)\b/.test(q)) return null;
  const body = stripPrefix(src);
  const p = parseQuick(body, { lang: ctx.lang, accounts: ctx.accounts, cards: ctx.cards, categories: ctx.categories, today: ctx.today });
  const out = (r) => (r.action ? { actions: [r.action], errors: [] } : { actions: [], errors: [r] });
  const accName = (id) => (id ? ctx.accounts.find((a) => a.id === id)?.name : undefined);
  const cardName = (id) => (id ? ctx.cards.find((c) => c.id === id)?.name : undefined);

  const called = src.match(/\b(?:chamad[oa]|called|named)\s+(.+?)(?=\s+(?:com|que|de limite|limite|fecha|vence|e saldo|saldo|visa|master\w*|elo|amex|hipercard|bandeira|with|that|limit|closes|closing|due|and|balance)\b|[,.;!]|$)/i)?.[1]?.trim();
  // numbers read from the words as written ("10.000", "10,000"): the normalized text splits them
  const dayOf = (re) => { const m = q.match(re); return m ? Number(m[1]) : undefined; };

  // a new card: "adicione um cartão Nubank com limite de 5000 que fecha dia 3 e vence dia 10"
  if (/\b(?:adicion|acrescent|cri|cadastr|colo(?:c|qu)|inclu|registr|add|creat|regist|save)\w*\s+(?:(?:ai|aqui|um|o|meu|novo|a|an|my|new)\s+){0,3}(?:cartao|card)\b/.test(q) && !MONEY_VERB.test(q) && !/\b(fatura|gasto|compra|despesa|expense|purchase|bill)\b/.test(q)) {
    const bank = bankOf(q);
    const lim = strip(src).toLowerCase().match(/\blimit[e]?\s+(?:de\s+|of\s+)?(?:r\$\s*|\$\s*)?(\d[\d.,]*(?:\s*mil\b|k\b)?)/);
    const brand = q.match(/\b(visa|mastercard|master|elo|amex|american express|hipercard)\b/)?.[1];
    return out(prepareAction('add_card', {
      name: called || (bank ? `${ctx.t('act2.cardWord')} ${bank}` : ''), institution: bank, limit: lim ? lim[1] : undefined,
      closing_day: dayOf(/\b(?:fecha\w*|closes?|closing)\s+(?:(?:no|todo|sempre no|sempre|on the|on)\s+)?(?:dia\s+|day\s+)?(\d{1,2})\b/),
      due_day: dayOf(/\b(?:vence\w*|vencimento|due|is due)\s+(?:(?:no|todo|sempre no|sempre|e|on the|on)\s+)?(?:dia\s+|day\s+)?(\d{1,2})\b/),
      brand: brand === 'master' ? 'mastercard' : brand === 'american express' ? 'amex' : brand,
    }, ctx));
  }
  // a new account: "crie uma conta no Itaú com saldo de 2000", "adicione minha poupança do Nubank"
  const accountish = /\b(?:adicion|acrescent|cri|cadastr|colo(?:c|qu)|inclu|registr|abr|add|creat|regist|open)\w*\s+(?:(?:ai|aqui|uma|a|minha|nova|an|my|new)\s+){0,3}(?:conta|carteira|poupanca|account|wallet|savings)\b/.test(q)
    && !/\bconta\s+(?:de|do|da)\s+(?:luz|agua|gas|telefone|celular|internet|condominio|aluguel|energia|tv|streaming|cartao)\b/.test(q)
    && !MONEY_VERB.test(q) && !MONTHLY.test(q) && (!p || /\b(saldo|balance)\b/.test(q));
  if (accountish) {
    const bank = bankOf(q);
    const savings = /\b(poupanca|savings)\b/.test(q);
    const accType = savings ? 'savings' : /\b(carteira|wallet)\b/.test(q) ? 'wallet' : /\b(dinheiro|em especie|cash)\b/.test(q) ? 'cash' : 'checking';
    const name = called || (bank ? (savings ? `${ctx.t('acc.type.savings')} ${bank}` : bank) : '');
    const neg = /\b(negativo|devendo|no vermelho|negative|overdrawn)\b/.test(q);
    return out(prepareAction('add_account', { name, institution: bank, account_type: accType, balance: p && /\b(saldo|balance)\b/.test(q) ? (neg ? -p.amount : p.amount) : 0 }, ctx));
  }
  // what an investment is worth now: "o tesouro selic está valendo 1600", "atualiza o CDB Bradesco para 10.250"
  if (/\b(?:esta|ta)\s+valendo\b|\bvalendo agora\b|\bvale agora\b|\batualiz\w*\b.*\b(valor|saldo|para|pra)\b|\bsaldo atual\b|\brendeu e (?:esta|ta)\b|\b(?:is|now)\s+worth\b|\bupdat\w*\b.*\b(value|balance|to)\b/.test(q) && p) {
    const mine = ctx.assets.filter((a) => a.source !== 'openfinance');
    const exact = mine.find((a) => { const w = norm(a.name).split(' ').filter((x) => x.length >= 3 && !/^\d+$/.test(x)); return w.length && w.every((x) => q.includes(x)); });
    const hint = [productOf(q), bankOf(q)].filter(Boolean).join(' ');
    const asset = exact || findNamed(mine, hint || q.replace(/\d+[.,\d]*/g, ' '));
    if (!asset) return out({ error: 'unknown_investment', investments: mine.map((a) => a.name) });
    return out(prepareAction('update_investment_value', { investment: asset.name, current_value: p.amount }, ctx));
  }

  // budgets: "coloque um orçamento de 800 para mercado", "limite de 300 em lazer"
  if (/\b(orcamento|limite de gasto|teto de gasto|limite mensal|budget|spending limit)\b/.test(q) || (/\blimite\b/.test(q) && !/\bcartao\b/.test(q))) {
    if (!p) return out({ error: 'missing_amount' });
    const words = q.replace(/\b(orcamento|limite|de|gasto|gastos|para|pra|com|em|no|na|nos|nas|mensal|por|mes|teto|um|uma|o|a|reais|r|adicione|adiciona|adicionar|crie|cria|criar|coloque|coloca|defina|define|wally|meu|minha|novo|nova|budget|spending|limit|of|for|on|an|the|per|month|monthly|set|create|add|my|new|please|hey)\b/g, ' ').replace(/\d+[.,\d]*/g, ' ').replace(/\s+/g, ' ').trim();
    return out(prepareAction('set_budget', { category: words || ctx.t(`cat.${p.category}`), monthly_limit: p.amount }, ctx));
  }
  // alerts: "me avise quando o mercado passar de 800"
  if (/\b(me avis\w*|avis\w* quando|alert\w*|let me know|notify me|warn me|tell me)\b/.test(q) && /\b(passar|chegar|ultrapassar|maior|acima|mais de|goes over|go over|over|above|exceeds?|passes|reaches)\b/.test(q)) {
    if (!p) return out({ error: 'missing_amount' });
    const cat = p.category && !['other', 'other_income'].includes(p.category) ? p.category : null;
    return out(prepareAction('add_alert', { category: cat ? ctx.t(`cat.${cat}`) : undefined, merchant: cat ? undefined : p.description || undefined, limit: p.amount, period: /\b(uma compra|cada compra|numa compra|compra acima|a purchase|any purchase|single purchase)\b/.test(q) ? 'purchase' : 'month' }, ctx));
  }
  // goals: "crie uma meta de viagem de 8000 até dezembro", "guarde 200 na meta viagem", "tira 500 da reserva"
  const saving = !/\b(gastei|paguei|comprei|spent|paid|bought)\b/.test(q) && /\b(guard|separ|deposit|poup|coloc|coloqu|adicion|acrescent|bot|poe|ponha|tir|sac|retir|resgat|save|put|add|move|take|withdr)\w*/.test(q);
  const goalByName = saving ? ctx.goals.find((g) => {
    const w = norm(g.title).split(' ').find((x) => x.length >= 4);
    return w && new RegExp(`\\b(?:na|no|da|do|pra|pro|para|em|to|in|into|for|from|out of)\\s+(?:a\\s+|o\\s+|the\\s+|my\\s+)?(?:meta\\s+(?:de\\s+|da\\s+|do\\s+)?)?(?:minha\\s+|meu\\s+)?${w}\\b`).test(q);
  }) : null;
  if (/\b(meta|goal)\b/.test(q) || goalByName) {
    if (!p) return out({ error: 'missing_amount' });
    const low = src.toLowerCase();
    const stop = /^(?:de|da|do|para|pra|uma|um|nova|novo)$/;
    let named = low.match(/\bmeta\s+(?:de\s+|da\s+|do\s+|para\s+|pra\s+)?([a-zà-ú][a-zà-ú ]{1,40}?)(?=\s+(?:de\s+|com\s+|no valor de\s+|valor\s+)?(?:r\$\s*)?\d|\s+at[eé]\b|\s+(?:no|na|em)\s+(?:r\$\s*)?\d|[,.;!]|\s*$)/)?.[1]?.trim();
    if (!named || stop.test(named)) named = low.match(/\b(?:an?|my|new)\s+([a-z][a-z ]{1,30}?)\s+goal\b/)?.[1]?.trim()
      || low.match(/\bgoal\s+(?:for|to|of|called)\s+(?:an?\s+|my\s+|the\s+)?([a-z][a-z ]{1,40}?)(?=\s+(?:of|with|by)\s|\s*\$?\d|[,.;!]|\s*$)/)?.[1]?.trim()
      || low.match(/\b(?:para|pra)\s+(?:a\s+|o\s+|minha\s+|meu\s+)?([a-zà-ú][a-zà-ú ]{2,40}?)(?=\s+at[eé]\b|[,.;!]|\s*$)/)?.[1]?.trim();
    const creating = /\b(nova|novo|crie|cria|criar|comecar|comece|quero juntar|quero guardar|new|create|start|set up)\b/.test(q)
      || /\b(?:adicion|acrescent|cadastr|registr|colo(?:c|qu)|inclu|anot|bot|pon)\w*\s+(?:(?:ai|aqui)\s+)?(?:uma|a)\s+(?:nova\s+)?meta\b/.test(q);
    const moving = saving;
    const goal = goalByName || findNamed(ctx.goals, named || '', ['title']) || (!creating && moving && ctx.goals.length === 1 ? ctx.goals[0] : null);
    if (goal && !creating) return out(prepareAction('add_to_goal', { goal: goal.title, amount: p.amount, withdraw: /\b(tir|sac|retir|resgat|take|withdr)\w*/.test(q) }, ctx));
    if (!creating && moving && named) return out({ error: 'unknown_goal', goals: ctx.goals.map((g) => g.title) });
    const months = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    const monthsEn = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    let deadline;
    const mm = q.match(/\b(?:ate|by)\s+(?:o\s+fim\s+de\s+|the\s+end\s+of\s+)?([a-z]+)(?:\s+(?:de\s+)?(\d{4}))?/);
    const mIdx = mm ? Math.max(months.indexOf(mm[1]), monthsEn.indexOf(mm[1])) : -1;
    if (mm && mIdx >= 0) {
      const m = mIdx + 1;
      let y = Number(mm[2]) || Number(ctx.today.slice(0, 4));
      if (!mm[2] && `${y}-${String(m).padStart(2, '0')}` < ctx.today.slice(0, 7)) y += 1;
      deadline = `${y}-${String(m).padStart(2, '0')}`;
    } else if (/\b(\d{4})\b/.test(q) && Number(q.match(/\b(20\d{2})\b/)?.[1]) >= Number(ctx.today.slice(0, 4))) {
      deadline = `${q.match(/\b(20\d{2})\b/)[1]}-12`;
    }
    const title = named?.replace(/^(?:(?:uma|um|minha|meu|a|o|nova|novo)\s+)+/, '').replace(/\s+/g, ' ').trim();
    return out(prepareAction('add_goal', { title: title || phrase(src) || ctx.t('act2.goal'), target: p.amount, deadline }, ctx));
  }
  // investments: "adicione um investimento de 10000 em CDB Bradesco", "investi 500 no tesouro selic", "resgatei 1000 do CDB"
  const investy = /\b(investimento|investi|aplicacao|aplicar|apliquei|aporte|aportei|resgatei|resgate|resgatar|investment|invest|invested|redeem|redeemed|withdrew)\b/.test(q) || ASSET_WORDS.some(([, re]) => re.test(q));
  if (investy && !/\b(gastei|paguei|comprei|spent|paid|bought)\b/.test(q)) {
    if (!p) return out({ error: 'missing_amount' });
    const redeem = /\b(resgat\w*|saquei|tirei|withdr\w*|redeem\w*)\b/.test(q);
    const mine = ctx.assets.filter((a) => a.source !== 'openfinance');
    const hint = [productOf(q), bankOf(q)].filter(Boolean).join(' ');
    const exact = mine.find((a) => { const w = norm(a.name).split(' ').filter((x) => x.length >= 3); return w.length && w.every((x) => q.includes(x)); });
    const contribution = /\b(investi|apliquei|aportei|aporte|coloquei|mais|invested|put|added|more)\b/.test(q) && !/\b(novo|nova|new)\b/.test(q);
    const known = exact || (redeem || contribution ? findNamed(mine, hint || q.replace(/\d+[.,\d]*/g, ' ')) : null);
    if (known || redeem) {
      if (!known) return out({ error: 'unknown_investment', investments: mine.map((a) => a.name) });
      return out(prepareAction('move_investment', { investment: known.name, direction: redeem ? 'redeem' : 'invest', amount: p.amount, date: p.date, account: accName(p.accountId) }, ctx));
    }
    const already = /\b(ja tenho|ja tinha|que eu tenho|que tenho|tenho aplicado|ja aplicado|ja estava|antes do app|already had|already have|i already|i had)\b/.test(q);
    return out(prepareAction('add_investment', { type: q, institution: bankOf(q), amount: p.amount, date: p.date, from_account: accName(p.accountId), already_invested: already }, ctx));
  }
  if (!p || /\b(fatura|transferi|transferencia|tirei)\b/.test(q)) return null; // card bills and transfers: the forms do it right
  // "no Itaú" / "pelo Nubank": where the money went. A bank the person has no account for is asked about, not guessed.
  const bw = !p.cardId && (!p.accountId || p.accountId === DEFAULT_ACCOUNT_ID) ? bankWhere(q) : '';
  const account = bw || accName(p.accountId);
  const clean = (d) => cap(dropWhere(` ${d || ''} `, [bw, cardName(p.cardId), accName(p.accountId)]).replace(/^\s*(?:received|got|earned|spent|paid|bought|recebi|ganhei|gastei|paguei|comprei)\s+/i, ' ').replace(/\s+/g, ' ').trim()) || undefined;
  // monthly bills and incomes: "conta de luz de 150 todo dia 10", "recebo 5000 de salário todo mês"
  if (MONTHLY.test(q)) {
    const dm = q.match(/\bdia\s+(\d{1,2})\b|\bon\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b|\bday\s+(\d{1,2})\b/);
    const dayN = Number(dm?.[1] || dm?.[2] || dm?.[3]) || undefined;
    const income = p.type === 'income' || /\b(recebo|ganho|salario|renda|get paid|earn|salary|income|paycheck)\b/.test(q);
    const cat = income && ['other', 'other_income'].includes(p.category) && /\b(salario|get paid|paycheck|salary)\b/.test(q) ? 'salary' : income && p.category === 'other' ? 'other_income' : p.category;
    return out(prepareAction('add_recurring', {
      type: income ? 'income' : 'expense', amount: p.amount, description: phrase(src, [accName(p.accountId), cardName(p.cardId), bw]) || ctx.t(`cat.${cat}`),
      category: ctx.t(`cat.${cat}`), day_of_month: dayN, account, card: cardName(p.cardId),
    }, ctx));
  }
  if (p.type === 'invest' || p.type === 'redeem') return null;
  return out(prepareAction('add_transaction', {
    type: p.type === 'income' ? 'income' : 'expense', amount: p.amount, description: clean(p.description), category: ctx.t(`cat.${p.category}`), date: p.date,
    account, card: cardName(p.cardId), installments: p.installments,
  }, ctx));
}

/** Days before today an action may still be confirmed (an old card left in the chat is not a surprise later). */
export const ACTION_TTL_DAYS = 7;
export const actionExpired = (msg, now = Date.now()) => (msg.at || 0) < now - ACTION_TTL_DAYS * 86400000;
export { addDays };
