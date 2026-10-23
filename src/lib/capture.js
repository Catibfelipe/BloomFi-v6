/**
 * Phone captures -> BloomFi transactions.
 *
 * What arrives (already decrypted on the device) is whatever the phone automation sent:
 *   - iPhone "Transaction" (Apple Pay):  { valor|amount, local|merchant, cartao|card }
 *   - iPhone "Notification" (iOS 27+) and Android notifications: { app, titulo|title, subtitulo, texto|text }
 *   - iPhone "Message" (bank SMS): { texto, de }
 * Banks write their alerts in many ways, so the parser looks for the amount, the place, the card's
 * last digits and words that say "approved purchase" vs "received" vs "not a payment at all".
 *
 * Everything here is pure (no I/O) and unit-tested.
 */
import { guessCategory } from './categories.js';

const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const clean = (s, max = 60) => String(s || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** "R$ 1.234,56" | "1234.56" | "R$1,99" | "BRL 12.30" | 23.9 -> 1234.56 (null if none) */
export function parseMoney(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) / 100 : null;
  const s = String(raw || '');
  // Most specific first: 1.234,56 | 1,234.56 | 23,90 | 23.90 / 5
  const m = s.match(/(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?(?![\d.,]*\d)|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?(?![\d.,]*\d)|\d+,\d{1,2}(?!\d)|\d+(?:\.\d{1,2})?(?!\d))/);
  if (!m) return null;
  let n = m[1];
  const lastComma = n.lastIndexOf(','), lastDot = n.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) n = lastComma > lastDot ? n.replace(/\./g, '').replace(',', '.') : n.replace(/,/g, '');
  else if (lastComma >= 0) n = /,\d{1,2}$/.test(n) ? n.replace(',', '.') : n.replace(/,/g, '');
  else if (/^\d{1,3}(\.\d{3})+$/.test(n)) n = n.replace(/\./g, '');
  const v = Math.abs(Number(n));
  return Number.isFinite(v) && v > 0 && v < 1e7 ? Math.round(v * 100) / 100 : null;
}

/** Every currency amount in a text, in order ("R$ 12,34", "R$12,34"). */
function moneyIn(text) {
  const out = [];
  const re = /(?:R\$|BRL|US\$)\s?(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}|\d+(?:\.\d{2})?)/gi;
  let m;
  while ((m = re.exec(text))) out.push(parseMoney(m[1]));
  return out.filter(Boolean);
}
/** The amount the bank names as the value ("no valor de R$ 12,90", "Compra de R$ 12,90"), if it says so. */
function statedAmount(text) {
  const m = String(text).match(/(?:\bvalor(?:\s+de)?|\b(?:compra|pagamento|pix|transfer[eê]ncia|d[eé]bito|saque)(?:\s+\w+){0,2}\s+de)\s*:?\s*(?:R\$|BRL)\s?(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}|\d+(?:\.\d{2})?)/i);
  return m ? parseMoney(m[1]) : null;
}
/**
 * The bank's own words: the text with the shop's name blanked out. The name is chosen by the shop, so words
 * in it ("Reembolso Fácil", "Porto Seguro", "R$ 9.999,99") must never decide the kind of message or the amount.
 */
function withoutName(text, name) {
  const n = String(name || '').trim();
  if (n.length < 2) return String(text);
  const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
  return String(text).replace(re, ' · ');
}

const IGNORE = /(n[aã]o\s+(foi\s+)?(aprovad|autorizad|realizad|conclu)|recusad|negad|bloquead|cancelad[ao]|estornad[ao] parcialmente\b|falhou|insuficiente|tentativa|suspeit|c[oó]digo|senha|token|verifica[cç][aã]o|fatura (fechou|fechada|dispon|est[aá] dispon|vence|venceu)|vencimento|lembrete|limite (dispon|atualizado|aumentado|de cr[eé]dito)|oferta|promo|cashback dispon|empr[eé]stimo|\bseguro\b|investimento rendeu|rendimento|saldo (dispon|atual)|boleto (gerado|dispon)|agendad[oa]|pix agendado|programad[oa]|pr[eé]-aprovad|convite|parab[eé]ns|novidade)/i;
const INCOME = /(voc[eê] recebeu|recebeu (um )?pix|pix recebido|recebid[oa]\b|transfer[eê]ncia recebida|dep[oó]sito|cr[eé]dito em conta|caiu na (sua )?conta|reembols|estorno|devolu[cç][aã]o|sal[aá]rio|cashback (de|recebido|creditado))/i;
const SPEND = /(compra|pagamento|pagou|\bpago\b|d[eé]bito|transfer[eê]ncia (enviada|realizada|efetuada)|pix (enviado|realizado|efetuado)|enviou|voc[eê] (fez|realizou)|saque|apple pay|google pay|aproxima|\bgasto|assinatura|cobran[cç]a)/i;

const BANK_APPS = [
  ['nubank', /\bnu ?bank|\bnu\b|nubank/i], ['itau', /ita[uú]/i], ['bradesco', /bradesco/i], ['santander', /santander/i],
  ['bb', /banco do brasil|\bbb\b/i], ['caixa', /caixa/i], ['inter', /\binter\b|banco inter/i], ['c6', /\bc6\b/i],
  ['picpay', /picpay/i], ['mercadopago', /mercado ?pago/i], ['neon', /\bneon\b/i], ['next', /\bnext\b/i], ['btg', /btg/i],
  ['sicredi', /sicredi/i], ['sicoob', /sicoob/i], ['original', /banco original/i], ['pagbank', /pagbank|pagseguro/i],
  ['wallet', /google (carteira|wallet|pay)|carteira do google|apple (pay|wallet)|wallet/i],
];
export function bankOf(text) {
  const s = String(text || '');
  for (const [key, re] of BANK_APPS) if (re.test(s)) return key;
  return null;
}

const get = (d, ...keys) => { for (const k of keys) if (d[k] != null && String(d[k]).trim() !== '') return String(d[k]); return ''; };

/** Place of purchase from a bank text ("… em PADARIA REAL para o cartão…"). */
function merchantFrom(text) {
  const t = String(text).replace(/\s+/g, ' ');
  // A dot ends the name only when a space (or the end) follows it: "NETFLIX.COM" stays whole.
  const W = "(?:[^,;:·.]|\\.(?=\\S))";
  const END = "(?:[,;·]|\\.(?:\\s|$)|$)";
  const pats = [
    new RegExp(`\\b(?:em|no|na|at)\\s+(?!\\d{1,2}\\/\\d{1,2})([A-Z0-9*]${W}{1,60}?)(?=\\s+(?:para o cart|no cart|com o cart|com cart|cart[aã]o|final|em \\d|dia \\d|[aà]s \\d|\\d{1,2}\\/\\d{1,2}|foi|aprovad|realizad|no valor|valor|de R\\$)|${END})`, 'gi'),
    new RegExp(`\\bpara\\s+([A-Za-zÀ-ÿ0-9*]${W}{1,60}?)(?=\\s+(?:no valor|valor|de R\\$|com|via|foi|realizad|em \\d)|${END})`, 'gi'),
    new RegExp(`\\bde\\s+([A-Z][A-Za-zÀ-ÿ0-9* ]{2,60}?)(?=\\s+(?:no valor|valor|via|foi|recebid)|${END})`, 'g'),
  ];
  for (const re of pats) {
    for (const m of t.matchAll(re)) {
      const v = clean(m[1].replace(/\s+(?:R\$.*|cart[aã]o.*)$/i, ''), 60);
      if (v && !/^(R\$|\d|sua\b|seu\b|conta\b|cart[aã]o|d[eé]bito|cr[eé]dito|pix\b|voc[eê])/i.test(v) && !/^(o|a|os|as|um|uma)$/i.test(v)) return v;
    }
  }
  return '';
}

/**
 * Normalises one capture. Returns
 *   { kind: 'expense' | 'income' | 'ignore' | 'test', amount, merchant, card: { name, last4 }, bank, method, source, reason }
 */
export function parseCapture(entry) {
  const d = entry?.data || {};
  const at = entry?.at || Date.now();
  if (/^(1|true|sim|yes)$/i.test(get(d, 'teste', 'test'))) return { kind: 'test', at };
  const amountField = get(d, 'valor', 'amount', 'quantia', 'value', 'preco');
  const merchantField = get(d, 'local', 'merchant', 'comerciante', 'estabelecimento', 'loja', 'nome', 'name');
  const cardField = get(d, 'cartao', 'card', 'cartaooupasse', 'pass', 'passe', 'carteira');
  const title = get(d, 'titulo', 'title', 'assunto', 'subject');
  const subtitle = get(d, 'subtitulo', 'subtitle');
  const body = get(d, 'texto', 'text', 'body', 'corpo', 'mensagem', 'message', 'notification', 'notificacao', 'conteudo');
  const app = get(d, 'app', 'aplicativo', 'de', 'from', 'remetente', 'sender');
  const all = [app, title, subtitle, body].filter(Boolean).join(' · ');

  // 1) Apple Pay "Transaction" automation: structured fields (a refund comes as a negative amount).
  if (amountField && !body) {
    const amount = parseMoney(amountField);
    if (!amount) return { kind: 'ignore', reason: 'no_amount', at };
    const negative = /^\s*[-−]/.test(amountField);
    return {
      kind: negative ? 'income' : 'expense', amount, merchant: clean(merchantField) || clean(title), source: 'applepay',
      card: { name: clean(cardField, 40), last4: (cardField.match(/(\d{4})\s*$/) || [])[1] || null },
      bank: bankOf(cardField) || bankOf(app), method: /d[eé]bito/i.test(cardField) ? 'debit' : /cr[eé]dito/i.test(cardField) ? 'credit' : null, at,
    };
  }

  // 2) Notifications / SMS / e-mails: free text.
  if (!strip(all).trim()) return { kind: 'ignore', reason: 'empty', at };
  // Apple Wallet notification (iOS 27): title = card, subtitle = place, body = amount.
  const walletStyle = /^\s*(?:R\$|BRL)?\s?[\d.,]+\s*$/.test(body) && (subtitle || title);
  // A wallet app's own alert (Google Wallet, Apple Wallet) is always a payment made with the phone;
  // Google Wallet puts the shop in the title.
  const walletApp = /carteira|wallet|google pay|apple pay/i.test(strip(app));
  // Find the shop's name first, then read only the bank's words around it.
  let merchant = merchantField || (walletStyle ? subtitle || '' : '') || (walletApp && title && !bankOf(title) ? title : '')
    || merchantFrom(body) || merchantFrom(all);
  if (!merchant && title && !SPEND.test(strip(title)) && !INCOME.test(strip(title)) && !bankOf(title) && !/R\$/.test(title)) merchant = title;
  const bankWords = withoutName(all, merchant);
  const text = strip(bankWords);
  if (IGNORE.test(text)) return { kind: 'ignore', reason: 'not_a_payment', at };
  const amount = (walletStyle ? parseMoney(body) : null) || statedAmount(bankWords) || moneyIn(bankWords)[0] || parseMoney(amountField)
    || (/\d+,\d{2}/.test(body) ? parseMoney(withoutName(body, merchant)) : null);
  if (!amount) return { kind: 'ignore', reason: 'no_amount', at };
  const refund = /estorno|estornad|reembols|devolu[cç][aã]o/i.test(text);
  const income = refund || (INCOME.test(text) && !/compra|pagamento de|pagou|enviou|enviado/i.test(text));
  const spend = SPEND.test(text) || !!amountField || walletApp;
  // Mixed signals (a refund word in a purchase alert, several different amounts): the user confirms it.
  const amounts = [...new Set(moneyIn(bankWords))];
  const doubt = (refund && /compra|pagamento|aprovad/i.test(text)) || amounts.length > 1;
  if (!income && !spend && !walletStyle) return { kind: 'ignore', reason: 'unclear', at };
  const last4 = (bankWords.match(/(?:final|terminad[oa] em|•{2,4}|\*{2,4}|x{2,4})\s?(\d{4})\b/i) || [])[1] || null;
  const method = /pix/i.test(text) ? 'pix' : /debito/i.test(text) ? 'debit' : /credito|cartao/i.test(text) ? 'credit' : null;
  const cardName = walletStyle ? title : cardField || (walletApp ? (body.match(/\b(?:com|com o|no)\s+([^•*\d,]{2,40}?)\s*(?:•|\*|final|\d{4}|$)/i) || [])[1] : '');
  const bank = [app, cardField, cardName, title, body].map(bankOf).find((b) => b && b !== 'wallet') || bankOf(app);
  return {
    kind: income ? 'income' : 'expense', amount, merchant: clean(merchant), source: entry?.platform === 'android' ? 'android' : 'notification',
    card: { name: clean(cardName, 40), last4 }, bank, method, at, ...(doubt ? { doubt: true } : {}),
  };
}

// ---------------- where it goes (account or card) ----------------
const norm = (s) => strip(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
export const merchantKey = (s) => norm(s).replace(/\b(ltda|me|sa|eireli|comercio|com|br)\b/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
const digits4 = (s) => (String(s || '').match(/(\d{4})\D*$/) || [])[1] || null;

/** Keys a mapping rule can use, most specific first. */
export function ruleKeys(p) {
  const keys = [];
  if (p.card?.last4) keys.push(`last4:${p.card.last4}`);
  if (p.card?.name) keys.push(`card:${norm(p.card.name)}`);
  if (p.bank) keys.push(`bank:${p.bank}:${p.method || 'any'}`, `bank:${p.bank}:any`);
  return keys;
}

/**
 * Picks the destination: learned rules first, then card/account last digits, then the bank's
 * name, then a single obvious card. Returns { accountId | cardId, sure }.
 */
export function resolveDestination(p, { accounts = [], cards = [], rules = {} }) {
  const live = (list) => list.filter((x) => !x.archived);
  const accs = live(accounts), crds = live(cards);
  const ok = (dest) => (dest?.startsWith('card:') ? crds.some((c) => `card:${c.id}` === dest) : accs.some((a) => `acc:${a.id}` === dest));
  const as = (dest, sure) => (dest.startsWith('card:') ? { cardId: dest.slice(5), sure } : { accountId: dest.slice(4), sure });
  for (const k of ruleKeys(p)) if (rules[k] && ok(rules[k])) return as(rules[k], true);
  if (p.card?.last4) {
    const c = crds.find((x) => x.last4 === p.card.last4 || digits4(x.number) === p.card.last4);
    if (c && p.method !== 'debit') return { cardId: c.id, sure: true };
    const a = accs.find((x) => x.last4 === p.card.last4 || digits4(x.cardNumber) === p.card.last4);
    if (a) return { accountId: a.id, sure: true };
    if (c) return { cardId: c.id, sure: true };
  }
  const name = norm(p.card?.name || '');
  if (name) {
    const c = crds.find((x) => norm(x.name) && (name.includes(norm(x.name)) || norm(x.name).includes(name)));
    if (c) return { cardId: c.id, sure: false };
  }
  if (p.bank && p.bank !== 'wallet') {
    const byBank = (x) => bankOf(`${x.name} ${x.institution || ''}`) === p.bank;
    const c = crds.find(byBank), a = accs.find(byBank);
    if ((p.method === 'debit' || p.method === 'pix') && a) return { accountId: a.id, sure: false };
    if (p.method === 'credit' && c) return { cardId: c.id, sure: false };
    if (c && !a) return { cardId: c.id, sure: false };
    if (a && !c) return { accountId: a.id, sure: false };
    if (c) return { cardId: c.id, sure: false };
  }
  if (p.kind === 'expense' && p.source === 'applepay' && crds.length === 1 && p.method !== 'debit') return { cardId: crds[0].id, sure: false };
  const main = accs.find((a) => a.id === 'main') || accs[0];
  return { accountId: main?.id || 'main', sure: false };
}

// ---------------- duplicates ----------------
const DAY = 86400000;
const dayOf = (iso) => new Date(`${iso}T12:00:00`).getTime();

/** 0..1: how alike two merchant names are (shared words / prefix). */
export function similarity(a, b) {
  const x = merchantKey(a), y = merchantKey(b);
  if (!x || !y) return 0;
  if (x === y || x.includes(y) || y.includes(x)) return 1;
  const wa = new Set(x.split(' ').filter((w) => w.length > 2)), wb = new Set(y.split(' ').filter((w) => w.length > 2));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w) || [...wb].some((v) => v.startsWith(w) || w.startsWith(v))) common++;
  return common / Math.min(wa.size, wb.size);
}

/**
 * Is this capture already in the books? (the same purchase seen by Apple Pay and the bank's alert,
 * a capture that arrived twice, or something the user typed in by hand).
 */
export function findDuplicate(cap, txs) {
  const t0 = cap.at;
  for (const t of txs) {
    if (t.type !== cap.type || Math.abs(t.amount - cap.amount) > 0.009) continue;
    if (Math.abs(dayOf(t.date) - dayOf(cap.date)) > 2 * DAY) continue;
    const sameDest = (cap.cardId && t.cardId === cap.cardId) || (cap.accountId && t.accountId === cap.accountId && !t.cardId);
    if (t.source === 'capture') {
      // Two alerts for the same tap usually arrive within minutes of each other.
      if (Math.abs((t.capture?.at || 0) - t0) < 15 * 60000 && (sameDest || similarity(t.description, cap.description) >= 0.5 || !cap.description || !t.description)) return t;
      continue;
    }
    if (similarity(t.description, cap.description) >= 0.5 || (sameDest && Math.abs(dayOf(t.date) - dayOf(cap.date)) <= DAY)) return t;
  }
  return null;
}

/**
 * Bank (Open Finance) rows that are the same purchase as a phone capture already saved:
 * the capture keeps its id (and the user's category), and gains the bank's id, so it is never
 * counted twice. Returns { links: [{ captureId, row }], rest: rows still to import }.
 */
export function linkBankRows(rows, txs) {
  const open = txs.filter((t) => t.source === 'capture' && !t.importId);
  const used = new Set();
  const links = [];
  const rest = [];
  for (const row of rows) {
    const cand = open.filter((t) => !used.has(t.id) && t.type === row.type && Math.abs(t.amount - row.amount) <= 0.009
      && dayOf(row.date) - dayOf(t.date) >= -1 * DAY && dayOf(row.date) - dayOf(t.date) <= 4 * DAY);
    let best = null, bestScore = 0;
    for (const t of cand) {
      const sameDest = (row.cardId && t.cardId === row.cardId) || (row.accountId && t.accountId === row.accountId);
      const score = similarity(t.description, row.description) + (sameDest ? 0.6 : 0) + (t.capture?.review ? 0.1 : 0);
      if (score > bestScore) { best = t; bestScore = score; }
    }
    if (best && bestScore >= 0.5) { used.add(best.id); links.push({ captureId: best.id, row }); } else rest.push(row);
  }
  return { links, rest };
}

/** Learned category for a place the user already categorised, else the keyword guess. */
export function categoryFor(p, rules = {}) {
  const k = merchantKey(p.merchant);
  if (k && rules[`cat:${k}`]) return { category: rules[`cat:${k}`], sure: true };
  const type = p.kind === 'income' ? 'income' : 'expense';
  const g = guessCategory(p.merchant || '', type);
  return { category: g, sure: g !== 'other' && g !== 'other_income' };
}

// ---------------- inbox entries -> transactions ----------------
function hashId(text) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
/** Same capture -> same id on every device (two devices opening the inbox never duplicate it). */
export const captureTxId = (entryId) => `cap_${hashId(String(entryId))}`;
const localISO = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Rules saved by the user (and learned) -> lookup map used by resolveDestination/categoryFor. */
export function rulesMap(list = []) {
  const out = {};
  for (const r of list) {
    if (r.kind === 'map' && r.key && r.dest) out[r.key] = r.dest;
    if (r.kind === 'cat' && r.key && r.category) out[`cat:${r.key}`] = r.category;
  }
  return out;
}

/**
 * Turns opened inbox entries into transactions. `deleted` = ids of transactions the user deleted
 * (a capture delivered again never brings one back).
 * Returns { added: [tx], log: [{ id, at, status, … }], tests } — status: added | duplicate | ignored | test | unreadable.
 */
export function capturesToTxs(entries, { txs = [], accounts = [], cards = [], rules = {}, now = Date.now(), deleted = new Set() }) {
  const known = [...txs];
  const added = [];
  const log = [];
  let tests = 0;
  const preview = (e) => {
    const d = e.data || {};
    return clean([d.local || d.merchant || d.titulo || d.title || d.app || '', d.valor || d.amount || ''].filter(Boolean).join(' · ') || d.texto || d.text || '', 90);
  };
  for (const e of [...entries].sort((a, b) => (a.at || 0) - (b.at || 0))) {
    const base = { id: e.id, at: e.at || now, src: e.platform || null };
    if (e.bad) { log.push({ ...base, status: 'unreadable' }); continue; }
    const p = parseCapture(e);
    if (p.kind === 'test') { tests++; log.push({ ...base, status: 'test' }); continue; }
    if (p.kind === 'ignore') { log.push({ ...base, status: 'ignored', reason: p.reason, preview: preview(e) }); continue; }
    const id = captureTxId(e.id);
    if (known.some((t) => t.id === id) || deleted.has(id)) { log.push({ ...base, status: 'duplicate', txId: id }); continue; }
    const dest = resolveDestination(p, { accounts, cards, rules });
    const cat = categoryFor(p, rules);
    const tx = {
      id, type: p.kind, amount: p.amount, category: cat.category,
      description: p.merchant || '', date: localISO(p.at || now),
      accountId: dest.cardId ? null : dest.accountId, cardId: dest.cardId || null,
      status: 'paid', source: 'capture', recurring: false, recurringOf: null,
      capture: { at: p.at || now, src: p.source, bank: p.bank || null, last4: p.card?.last4 || null, cardName: p.card?.name || null, method: p.method || null, review: !dest.sure || !cat.sure || !p.merchant || !!p.doubt },
      createdAt: now, loggedOn: localISO(now),
    };
    const dup = findDuplicate({ ...tx, at: tx.capture.at }, known);
    if (dup) { log.push({ ...base, status: 'duplicate', txId: dup.id }); continue; }
    known.push(tx);
    added.push(tx);
    log.push({ ...base, status: 'added', txId: id, amount: tx.amount, description: tx.description, type: tx.type });
  }
  return { added, log, tests };
}
