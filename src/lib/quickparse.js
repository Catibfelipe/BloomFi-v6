/**
 * Quick entry: one sentence (typed or dictated) becomes a transaction to review before saving.
 *   "45 mercado ontem no Nubank"            -> expense 45,00 · Groceries · yesterday · Nubank
 *   "comprei tênis 600 em 3x no cartão Inter" -> expense 600,00 in 3 installments on the Inter card
 *   "recebi 3.500 de salário"               -> income 3.500,00 · Salary
 * Runs on the device; nothing is sent anywhere.
 */
import { addDays, todayISO, daysInMonth } from './dates.js';
import { guessCategory } from './categories.js';

const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

const CATS = [
  ['groceries', /\b(super ?mercado|mercado|mercadinho|feira|hortifruti|sacolao|acougue|atacadao|assai|carrefour|grocer(y|ies))\b/],
  ['food', /\b(almoco|almocei|janta|jantar|jantei|lanche|lanchei|restaurante|ifood|pizza|hamburguer|burger|comida|delivery|marmita|sushi|churrasco|padaria|salgado|acai|sorvete|lunch|dinner|breakfast|restaurant|takeout)\b/],
  ['coffee', /\b(cafe|cafezinho|cafeteria|starbucks|coffee)\b/],
  ['transport', /\b(uber|99|99pop|taxi|onibus|metro|trem|gasolina|etanol|alcool|combustivel|posto|estacionamento|pedagio|bilhete unico|cabify|gas|fuel|parking|bus|subway)\b/],
  ['housing', /\b(aluguel|condominio|iptu|rent)\b/],
  ['phone', /\b(celular|telefone|recarga|plano de celular|phone bill)\b/],
  ['bills', /\b(luz|energia|agua|internet|conta de gas|boleto|electric(ity)?|water bill|utilities)\b/],
  ['health', /\b(farmacia|remedio|remedios|medico|consulta|dentista|exame|exames|hospital|plano de saude|terapia|psicologo|pharmacy|doctor|medicine)\b/],
  ['fitness', /\b(academia|gym|crossfit|pilates|personal trainer|natacao|yoga)\b/],
  ['entertainment', /\b(cinema|netflix|spotify|show|ingresso|ingressos|jogo|game|streaming|teatro|balada|festa|movie|concert)\b/],
  ['personal', /\b(cabelo|cabeleireiro|salao|barbeiro|barbearia|manicure|unha|perfume|maquiagem|haircut|barber)\b/],
  ['education', /\b(escola|faculdade|curso|livro|livros|material escolar|mensalidade da escola|school|course|book|books)\b/],
  ['travel', /\b(viagem|hotel|pousada|airbnb|passagem aerea|passagem de aviao|voo|trip|flight)\b/],
  ['pets', /\b(pet|racao|veterinario|vet|petshop|cachorro|gato)\b/],
  ['gifts', /\b(presente|presentes|aniversario|gift)\b/],
  ['kids', /\b(fralda|fraldas|creche|brinquedo|brinquedos|filho|filha|criancas|diapers)\b/],
  ['shopping', /\b(roupa|roupas|sapato|sapatos|tenis|camisa|calca|vestido|shopping|loja|amazon|mercado livre|shopee|shein|magalu|eletronico|clothes|shoes|store)\b/],
  ['debt', /\b(fatura|emprestimo|juros|financiamento|loan)\b/],
];
const INCOME_CATS = [
  ['salary', /\b(salario|salary|pagamento do mes|holerite|adiantamento|paycheck)\b/],
  ['freelance', /\b(freela|freelance|bico|servico|job|cliente)\b/],
  ['investments', /\b(rendimento|rendimentos|dividendo|dividendos|juros recebidos|dividend)\b/],
  ['gift_in', /\b(presente|ganhei de|gift)\b/],
];

const INCOME = /\b(recebi|recebido|recebimento|ganhei|entrou|caiu|salario|renda|reembolso|received|receive|got paid|income|salary|refund|earned)\b/;
const INVEST = /\b(investi|apliquei|aplicacao|aporte|aportei|guardei|poupei|invested|invest)\b/;
const REDEEM = /\b(resgatei|resgate|saquei da|redeemed|withdrew)\b/;
const CREDIT = /\b(credito|cartao|credit|card)\b/;
const DEBIT = /\b(debito|pix|dinheiro|especie|debit|cash)\b/;
const FILLER = /\b(gastei|gasto|paguei|pago|paga|comprei|compra|recebi|recebido|ganhei|investi|apliquei|resgatei|foi|foram|no|na|nos|nas|num|numa|em|de|do|da|dos|das|com|pelo|pela|pro|pra|para|o|a|os|as|um|uma|e|reais|real|conto|contos|pila|hoje|cartao|credito|debito|pix|via|i|spent|paid|bought|on|at|for|in|the|a|an|with|from|my|today|card|credit|debit|dollars|bucks|vez|vezes|parcelas|parcela|parcelado|parcelada|x)\b/g;

const WEEKDAYS = [
  [/\bdomingo\b|\bsunday\b/, 0], [/\bsegunda(-feira)?\b|\bmonday\b/, 1], [/\bterca(-feira)?\b|\btuesday\b/, 2], [/\bquarta(-feira)?\b|\bwednesday\b/, 3],
  [/\bquinta(-feira)?\b|\bthursday\b/, 4], [/\bsexta(-feira)?\b|\bfriday\b/, 5], [/\bsabado\b|\bsaturday\b/, 6],
];
const GENERIC = new Set(['conta', 'corrente', 'principal', 'cartao', 'card', 'account', 'checking', 'savings', 'poupanca', 'carteira', 'wallet', 'banco', 'bank', 'gold', 'black', 'platinum', 'visa', 'master', 'mastercard', 'elo', 'digital', 'credito', 'debito', 'pessoal']);

const pad = (n) => String(n).padStart(2, '0');

/** Reads one sentence. Returns null when no amount was found. */
export function parseQuick(input, { lang = 'pt', accounts = [], cards = [], categories = [], today = todayISO() } = {}) {
  const src = String(input || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!src) return null;
  const low = strip(src).toLowerCase();
  const cut = []; // [start, end) spans that are not part of the description
  const take = (m, offset = 0) => { if (m) cut.push([m.index + offset, m.index + offset + m[0].length]); return m; };

  // Installments: "em 3x", "3x", "3 vezes", "em 3 parcelas", "parcelado em 3"
  let installments = 1;
  const inst = take(/\b(?:em\s+)?(\d{1,2})\s*(?:x\b|vezes\b|parcelas\b)|\bparcelad[oa]\s+em\s+(\d{1,2})\b|\bin\s+(\d{1,2})\s+installments\b/.exec(low));
  if (inst) installments = Math.min(Math.max(Number(inst[1] || inst[2] || inst[3]) || 1, 1), 48);

  // Date
  let date = today;
  let dateWord = null;
  const dmy = take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(low));
  if (dmy) {
    const d = Number(dmy[1]), m = Number(dmy[2]);
    let y = dmy[3] ? Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]) : Number(today.slice(0, 4));
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      let iso = `${y}-${pad(m)}-${pad(Math.min(d, daysInMonth(`${y}-${pad(m)}`)))}`;
      if (!dmy[3] && iso > addDays(today, 60)) { y -= 1; iso = `${y}-${pad(m)}-${pad(Math.min(d, daysInMonth(`${y}-${pad(m)}`)))}`; }
      date = iso; dateWord = dmy[0];
    }
  } else {
    const dayN = take(/\bdia\s+(\d{1,2})\b/.exec(low));
    if (dayN) {
      const mk = today.slice(0, 7);
      date = `${mk}-${pad(Math.min(Math.max(Number(dayN[1]), 1), daysInMonth(mk)))}`;
      dateWord = dayN[0];
    } else if (take(/\banteontem\b/.exec(low))) { date = addDays(today, -2); dateWord = 'anteontem'; }
    else if (take(/\bontem\b|\byesterday\b/.exec(low))) { date = addDays(today, -1); dateWord = 'ontem'; }
    else if (take(/\bhoje\b|\btoday\b/.exec(low))) { dateWord = 'hoje'; }
    else {
      for (const [re, wd] of WEEKDAYS) {
        const m = re.exec(low);
        if (!m) continue;
        take(m);
        const now = new Date(`${today}T12:00:00`).getDay();
        date = addDays(today, -((now - wd + 7) % 7));
        dateWord = m[0];
        break;
      }
    }
  }

  // Amount: "R$ 1.234,56", "45,90", "45 reais e 90 centavos", "2 mil", "1.5k"
  let amount = null;
  const blocked = (i) => cut.some(([a, b]) => i >= a && i < b);
  const cents = /(\d+)\s*(?:reais|real)\s*e\s*(\d{1,2})\s*centavos?/.exec(low);
  if (cents && !blocked(cents.index)) { amount = Number(cents[1]) + Number(cents[2]) / 100; take(cents); }
  if (amount == null) {
    // Every number is a candidate; one that looks like money ("R$", cents, "reais", "mil") wins over a bare one
    // (so "99 taxi 23,50" is 23,50, not 99).
    const re = /(r\$|us\$|\$)?\s*(\d{1,3}(?:[.\s]\d{3})+(?:,\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(mil\b|k\b)?(\s*(?:reais|real|conto|contos|pila|dolares|dollars|bucks)\b)?/g;
    const found = [];
    let m;
    while ((m = re.exec(low))) {
      const at = m.index + m[0].indexOf(m[2]);
      if (blocked(at)) continue;
      const raw = m[2].replace(/\s/g, '.');
      let v;
      if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(raw)) v = Number(raw.replace(/\./g, '').replace(',', '.'));
      else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(raw)) v = Number(raw.replace(/,/g, '')); // "10,000" / "1,234.56" (English)
      else if (/^\d+,\d{1,2}$/.test(raw)) v = Number(raw.replace(',', '.'));
      else v = Number(raw);
      if (m[3]) v *= 1000;
      if (!(v > 0)) continue;
      found.push({ m, v, money: !!(m[1] || m[3] || m[4] || /[.,]\d{1,2}$/.test(m[2])) });
    }
    const pick = found.find((f) => f.money) || found.find((f) => !(f.v === 99 && found.length > 1)) || found[0];
    if (pick) { amount = Math.round(pick.v * 100) / 100; take(pick.m); }
  }
  if (amount == null) return null;

  // Kind of movement
  let type = 'expense';
  if (REDEEM.test(low)) type = 'redeem';
  else if (INVEST.test(low)) type = 'invest';
  else if (INCOME.test(low)) type = 'income';

  // Where the money moved
  const method = CREDIT.test(low) || installments > 1 ? 'credit' : DEBIT.test(low) ? 'debit' : null;
  const words = (s) => strip(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC.has(w));
  const hit = (item) => {
    for (const w of [...words(item.name), ...words(item.institution)]) {
      const m = new RegExp(`\\b${w}\\b`).exec(low);
      if (m) return m;
    }
    return null;
  };
  // The whole name leaves the description ("no Amex Gold" -> nothing left of it), not just the word that matched.
  const takeName = (item, m) => {
    const full = strip(item.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const fm = full ? new RegExp(`\\b${full.replace(/ /g, '\\s+')}\\b`).exec(low) : null;
    take(fm || m);
  };
  const accHits = accounts.filter((a) => !a.archived).map((a) => ({ a, m: hit(a) })).filter((x) => x.m);
  const cardHits = cards.filter((c) => !c.archived).map((c) => ({ c, m: hit(c) })).filter((x) => x.m);
  let accountId = null, cardId = null, guessed = false;
  const canCard = type === 'expense' || type === 'income';
  const liveCards = cards.filter((c) => !c.archived);
  if (canCard && cardHits.length && (method === 'credit' || (!accHits.length && method !== 'debit') || (type === 'expense' && method !== 'debit'))) {
    cardId = cardHits[0].c.id; takeName(cardHits[0].c, cardHits[0].m);
  } else if (accHits.length) {
    accountId = accHits[0].a.id; takeName(accHits[0].a, accHits[0].m);
  } else if (canCard && type === 'expense' && method === 'credit' && liveCards.length) {
    cardId = liveCards[0].id; // "no cartão" without saying which: the first card, shown in the preview to confirm
    guessed = liveCards.length > 1;
  }
  if (cardId && type === 'income' && !/\b(estorno|reembolso|refund)\b/.test(low)) { cardId = null; }

  // What is left once amount, date and card are gone: it names the category and becomes the description.
  cut.sort((a, b) => a[0] - b[0]);
  let rest = '';
  let i = 0;
  for (const [a, b] of cut) { if (a > i) rest += `${src.slice(i, a)} `; i = Math.max(i, b); }
  rest += src.slice(i);
  const restLow = strip(rest).toLowerCase();

  // Category
  let category = null;
  const own = categories.filter((c) => !c.archived && (type === 'income' ? c.type === 'income' : c.type === 'expense'));
  for (const c of own) {
    const n = strip(c.name).toLowerCase().trim();
    if (n.length >= 3 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(restLow)) { category = c.key; break; }
  }
  if (!category && type === 'expense') for (const [key, re] of CATS) if (re.test(restLow)) { category = key; break; }
  if (!category && type === 'income') for (const [key, re] of INCOME_CATS) if (re.test(restLow)) { category = key; break; }
  if (type === 'invest') category = 'invest';
  if (type === 'redeem') category = 'redeem';
  const kept = rest.split(/\s+/).filter((w) => {
    const n = strip(w).toLowerCase().replace(/[^a-z0-9]/g, '');
    return n && !n.match(FILLER) && !/^r\$?$/.test(n) && !/^\d+x?$/.test(n);
  }).map((w) => w.replace(/^[,.;:!?-]+|[,.;:!?-]+$/g, '')).filter(Boolean);
  let description = kept.join(' ').trim().slice(0, 80);
  if (description) description = description.charAt(0).toUpperCase() + description.slice(1);
  if (!category && type === 'expense') category = guessCategory(description || src, 'expense');
  if (!category && type === 'income') category = guessCategory(description || src, 'income');

  return {
    type, amount, category: category || (type === 'income' ? 'other_income' : 'other'), description, date, dateWord,
    accountId, cardId, guessed, installments: cardId && type === 'expense' ? installments : 1, method,
  };
}
