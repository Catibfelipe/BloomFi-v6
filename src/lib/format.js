import { parseISO } from './dates.js';

export const LOCALES = { pt: 'pt-BR', en: 'en-US' };
export const CURRENCIES = ['BRL', 'USD', 'EUR', 'GBP', 'ARS', 'CAD'];

const cache = new Map();
function fmt(locale, currency, compact) {
  const k = `${locale}|${currency}|${compact}`;
  if (!cache.has(k)) {
    cache.set(k, new Intl.NumberFormat(locale, {
      style: 'currency', currency,
      ...(compact ? { notation: 'compact', maximumFractionDigits: 1 } : {}),
    }));
  }
  return cache.get(k);
}

export function makeMoney(lang, currency) {
  const locale = LOCALES[lang] || 'pt-BR';
  const f = (n, opts = {}) => {
    const v = fmt(locale, currency, opts.compact).format(Math.abs(n) < 0.005 ? 0 : n);
    return opts.sign && n > 0 ? `+${v}` : v;
  };
  return f;
}

/** Accepts "1.234,56", "1,234.56", "1234,5", "R$ 50" ... */
export function parseAmount(input, lang = 'pt') {
  if (typeof input === 'number') return input;
  let s = String(input || '').trim().replace(/[^\d.,-]/g, '');
  if (!s) return NaN;
  const neg = s.startsWith('-');
  s = s.replace(/-/g, '');
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    const dec = lastComma > lastDot ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma > -1) {
    const parts = s.split(',');
    s = parts.length > 2 || (parts[1]?.length === 3 && lang === 'en') ? parts.join('') : parts.join('.');
  } else if (lastDot > -1) {
    const parts = s.split('.');
    if (parts.length > 2 || (parts[1]?.length === 3 && lang === 'pt')) s = parts.join('');
  }
  const n = parseFloat(s);
  return neg ? -n : n;
}

export function formatDate(iso, lang, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  return new Intl.DateTimeFormat(LOCALES[lang], opts).format(parseISO(iso));
}

export function formatMonth(mk, lang, short = false) {
  const s = new Intl.DateTimeFormat(LOCALES[lang], { month: short ? 'short' : 'long', year: 'numeric' }).format(parseISO(`${mk}-01`));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Month name for use inside a sentence: "outubro", "outubro de 2025" (year only when not the current one). */
export function monthInText(mk, lang) {
  const sameYear = mk.slice(0, 4) === String(new Date().getFullYear());
  const s = new Intl.DateTimeFormat(LOCALES[lang], sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' }).format(parseISO(`${mk}-01`));
  return lang === 'en' ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export const round2 = (n) => Math.round(n * 100) / 100;
export const pct = (n) => `${Math.round(n)}%`;

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
