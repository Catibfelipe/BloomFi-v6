/**
 * Subscription hunter: finds what the person pays again and again (streaming, gym, cloud storage, phone plan…)
 * in their own transactions. Runs on the device only: nothing here is sent anywhere.
 *
 * A charge counts when it repeats about every month (or every year) with a similar amount, or when it comes
 * from a well-known subscription service. Results carry flags for what deserves attention: the price went
 * up, the same charge came twice, it is new, or it seems to have stopped (cancelled?).
 */
import { addDays, addMonths, daysBetween, monthKey, sameDayIn, todayISO } from './dates.js';
import { round2 } from './format.js';

const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => strip(s).toLowerCase().replace(/[^a-z0-9+ ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Well-known services: [pattern, name, kind]. kind 'service' = subscription, 'bill' = fixed bill. */
const KNOWN = [
  [/netflix/, 'Netflix', 'service'],
  [/spotify/, 'Spotify', 'service'],
  [/disney/, 'Disney+', 'service'],
  [/\bhbo\b|hbo ?max|\bmax ?com\b|wbd ?max/, 'Max', 'service'],
  [/prime ?video|amazon ?prime|amzn ?prime|primevideo/, 'Amazon Prime', 'service'],
  [/youtube ?(premium|music)?|google \*? ?youtube/, 'YouTube Premium', 'service'],
  [/google ?one|google ?storage|google \*? ?google ?one/, 'Google One', 'service'],
  [/apple ?com ?bill|itunes|icloud|apple ?music|apple ?tv|apple ?one/, 'Apple', 'service'],
  [/globoplay/, 'Globoplay', 'service'],
  [/paramount/, 'Paramount+', 'service'],
  [/deezer/, 'Deezer', 'service'],
  [/crunchyroll/, 'Crunchyroll', 'service'],
  [/twitch/, 'Twitch', 'service'],
  [/game ?pass|xbox/, 'Xbox', 'service'],
  [/playstation|\bpsn\b|ps plus/, 'PlayStation Plus', 'service'],
  [/nintendo/, 'Nintendo', 'service'],
  [/smart ?fit/, 'Smart Fit', 'service'],
  [/bodytech/, 'Bodytech', 'service'],
  [/wellhub|gympass/, 'Wellhub', 'service'],
  [/totalpass/, 'TotalPass', 'service'],
  [/chatgpt|openai/, 'ChatGPT', 'service'],
  [/claude ?ai|anthropic/, 'Claude', 'service'],
  [/microsoft|office ?365|m365/, 'Microsoft 365', 'service'],
  [/adobe/, 'Adobe', 'service'],
  [/canva/, 'Canva', 'service'],
  [/dropbox/, 'Dropbox', 'service'],
  [/notion/, 'Notion', 'service'],
  [/duolingo/, 'Duolingo', 'service'],
  [/tinder/, 'Tinder', 'service'],
  [/bumble/, 'Bumble', 'service'],
  [/kindle ?unlimited/, 'Kindle Unlimited', 'service'],
  [/audible/, 'Audible', 'service'],
  [/uber ?one/, 'Uber One', 'service'],
  [/ifood ?clube|clube ?ifood/, 'Clube iFood', 'service'],
  [/rappi ?prime/, 'Rappi Prime', 'service'],
  [/meli ?\+|melimais|meli ?plus|mercado ?livre ?(nivel|plus)/, 'Meli+', 'service'],
  [/linkedin/, 'LinkedIn', 'service'],
  [/strava/, 'Strava', 'service'],
  [/headspace/, 'Headspace', 'service'],
  [/sem ?parar/, 'Sem Parar', 'service'],
  [/conectcar/, 'ConectCar', 'service'],
  [/veloe/, 'Veloe', 'service'],
  [/\bclaro\b/, 'Claro', 'bill'],
  [/\bvivo\b/, 'Vivo', 'bill'],
  [/\btim\b/, 'TIM', 'bill'],
];

// Words that say nothing about who charged.
const NOISE = /\b(compra|compras|pagamento|pagto|pgto|pag|pix|debito|debit|credito|credit|cartao|card|parcela|assinatura|mensalidade|mensal|online|internet|br|brasil|sao paulo|sp|rj|mg|bra|ltda|me|sa|eireli|com|www|http|https)\b/g;
// Payment processors that put their own name in front of the shop's.
const PROCESSOR = /^(pag ?seguro|pagseguro|pag|pg|mp|mercado ?pago|mercadopago|picpay|ifd|ebn|ebanx|paypal|pp|dl|dlocal|sq|stripe|google|amz|amzn|eb|ec|cielo|stone|sumup|ton|getnet|rede|payu|adyen)\s*\*\s*/i;

/** The service behind a description, or null. */
export function serviceOf(description) {
  const s = norm(String(description || '').replace(PROCESSOR, ''));
  const full = norm(description);
  for (const [re, name, kind] of KNOWN) if (re.test(s) || re.test(full)) return { name, kind };
  return null;
}

/** Stable key for the merchant behind a description (same shop, same key). */
export function subKey(description) {
  const known = serviceOf(description);
  if (known) return norm(known.name);
  return norm(String(description || '').replace(PROCESSOR, '').replace(/\(\s*\d+\s*\/\s*\d+\s*\)/g, ''))
    .replace(/\b\d+\b/g, ' ').replace(NOISE, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** Name to show: the service's, or the description cleaned up. */
export function subName(description) {
  const known = serviceOf(description);
  if (known) return known.name;
  const s = String(description || '').replace(PROCESSOR, '').replace(/\(\s*\d+\s*\/\s*\d+\s*\)/g, '').replace(/\*/g, ' ')
    .replace(/\b\d{3,}\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '—';
  const lower = s.toLowerCase();
  return lower.replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase()).slice(0, 40);
}

const SERVICE_CATS = new Set(['entertainment', 'fitness', 'education', 'phone', 'shopping', 'other', 'personal', 'coffee', 'food', 'travel', 'pets', 'kids', 'gifts']);

/** Groups charges of one merchant by price (two different plans billed by the same company stay apart). */
function byPrice(charges) {
  const clusters = [];
  for (const c of [...charges].sort((a, b) => a.date.localeCompare(b.date))) {
    let best = null;
    for (const cl of clusters) {
      const ref = cl.items[cl.items.length - 1].amount;
      if (Math.abs(c.amount - ref) / Math.max(ref, 0.01) <= 0.25 && (!best || Math.abs(c.amount - ref) < Math.abs(c.amount - best.items[best.items.length - 1].amount))) best = cl;
    }
    if (best) best.items.push(c); else clusters.push({ items: [c] });
  }
  return clusters;
}

/** Charges a few days apart with the same amount are one billing (or a double charge): keeps the first of each. */
function collapse(items) {
  const out = [];
  const doubles = [];
  for (const c of items) {
    const prev = out[out.length - 1];
    if (prev && daysBetween(prev.date, c.date) <= 5 && Math.abs(prev.amount - c.amount) <= Math.max(0.01, prev.amount * 0.02)) { doubles.push([prev, c]); continue; }
    out.push(c);
  }
  return { out, doubles };
}

const nextAfter = (date, cadence) => (cadence === 'yearly' ? sameDayIn(date, addMonths(monthKey(date), 12)) : sameDayIn(date, addMonths(monthKey(date), 1)));

/**
 * Everything that looks like a subscription or fixed bill.
 * `prefs` maps key -> { status: 'ignored' | 'cancelled' | 'confirmed', remind } (the person's own choices).
 */
export function findSubscriptions(txs, { today = todayISO(), prefs = {} } = {}) {
  const from = addDays(today, -400);
  const groups = new Map();
  // "New" only means something when there is older history to compare with (not right after connecting a bank).
  let historyStart = today;
  for (const t of txs) if (t.date && t.date < historyStart && t.source !== 'sample') historyStart = t.date;
  for (const t of txs) {
    if (t.type !== 'expense' || t.status === 'pending' || t.installment || t.date > today || t.date < from) continue;
    if (!(t.amount > 0) || !t.description || t.source === 'sample') continue;
    const key = subKey(t.description);
    if (!key || key.length < 2) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: t.id, date: t.date, amount: Number(t.amount), category: t.category, description: t.description, cardId: t.cardId || null, accountId: t.cardId ? null : t.accountId || null });
  }

  const list = [];
  for (const [mkey, charges] of groups) {
    const known = serviceOf(charges[0].description);
    const clusters = byPrice(charges);
    clusters.forEach((cl, i) => {
      const items = cl.items;
      const { out, doubles } = collapse(items);
      let cadence = null;
      let guess = false;
      if (out.length >= 2) {
        const gaps = out.slice(1).map((c, j) => daysBetween(out[j].date, c.date));
        const monthly = gaps.filter((g) => g >= 24 && g <= 38).length;
        const skipped = gaps.filter((g) => g >= 52 && g <= 72).length; // a month without a charge is fine
        const yearly = gaps.filter((g) => g >= 330 && g <= 400).length;
        const spanMonths = Math.max(daysBetween(out[0].date, out[out.length - 1].date) / 30.4, 1);
        if (monthly >= 1 && monthly + skipped === gaps.length && out.length / (spanMonths + 1) <= 1.6) cadence = 'monthly';
        else if (yearly === gaps.length) cadence = 'yearly';
        else if (known && monthly >= Math.max(1, Math.ceil(gaps.length * 0.6))) cadence = 'monthly';
      } else if (known && out.length === 1 && daysBetween(out[0].date, today) <= 45) {
        cadence = 'monthly';
        guess = true;
      }
      if (!cadence) return;
      const amounts = out.map((c) => c.amount);
      if (Math.max(...amounts) / Math.max(Math.min(...amounts), 0.01) > 1.6 && !known) return; // too irregular to be a plan
      const first = out[0];
      const last = out[out.length - 1];
      // The latest price change (it stays news for 60 days, even after the next charge at the new price).
      let rise = null;
      for (let j = out.length - 1; j >= 1; j--) {
        const p = out[j - 1], c = out[j];
        if (c.amount > p.amount * 1.02 && c.amount - p.amount >= 0.5) { rise = { p, c }; break; }
        if (c.amount < p.amount * 0.98) break; // got cheaper later: old news
      }
      const category = mostCommon(items.map((c) => c.category));
      const kind = known?.kind || (SERVICE_CATS.has(category) ? 'service' : 'bill');
      const key = clusters.length > 1 ? `${mkey}~${Math.round(first.amount)}` : mkey;
      const next = nextAfter(last.date, cadence);
      const monthlyAmount = cadence === 'yearly' ? last.amount / 12 : last.amount;
      const recentDouble = doubles.filter(([, b]) => daysBetween(b.date, today) <= 60).pop();
      const pref = prefs[key] || {};
      list.push({
        key, name: known?.name || subName(last.description), kind, category, cadence, guess,
        amount: round2(last.amount), monthly: round2(monthlyAmount), yearly: round2(monthlyAmount * 12),
        count: items.length, first: first.date, last: last.date, next,
        charges: items.map((c) => ({ id: c.id, date: c.date, amount: c.amount })),
        cardId: last.cardId, accountId: last.accountId,
        increased: rise && daysBetween(rise.c.date, today) <= 60
          ? { from: round2(rise.p.amount), to: round2(rise.c.amount), pct: Math.round(((rise.c.amount - rise.p.amount) / rise.p.amount) * 100), date: rise.c.date } : null,
        duplicate: recentDouble ? { date: recentDouble[1].date, amount: round2(recentDouble[1].amount), ids: [recentDouble[0].id, recentDouble[1].id] } : null,
        isNew: daysBetween(first.date, today) <= 40 && daysBetween(historyStart, first.date) >= 45,
        stale: daysBetween(next, today) > (cadence === 'yearly' ? 30 : 10),
        soon: next >= today && daysBetween(today, next) <= 3,
        status: pref.status || 'active',
        remind: !!pref.remind,
      });
    });
  }

  const counts = (s) => s.status !== 'ignored' && s.status !== 'cancelled' && !s.stale;
  list.sort((a, b) => (b.monthly - a.monthly) || a.name.localeCompare(b.name));
  const services = list.filter((s) => s.kind === 'service' && counts(s));
  const bills = list.filter((s) => s.kind === 'bill' && counts(s));
  const monthly = round2(services.reduce((x, s) => x + s.monthly, 0));
  return {
    list,
    services, bills,
    stopped: list.filter((s) => s.stale && s.status !== 'ignored' && s.status !== 'cancelled'),
    ignored: list.filter((s) => s.status === 'ignored' || s.status === 'cancelled'),
    monthly, yearly: round2(monthly * 12),
    billsMonthly: round2(bills.reduce((x, s) => x + s.monthly, 0)),
    attention: services.concat(bills).filter((s) => s.increased || s.duplicate || (s.isNew && s.status !== 'confirmed')),
  };
}

function mostCommon(values) {
  const m = new Map();
  for (const v of values) if (v) m.set(v, (m.get(v) || 0) + 1);
  let best = 'other', n = 0;
  for (const [v, c] of m) if (c > n) { best = v; n = c; }
  return best;
}
