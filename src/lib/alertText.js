/** Words for Wally's alerts (lib/alerts.js produces the data; this turns it into a title and a sentence). */
import { formatDate } from './format.js';

export function ruleLabel(t, rule) {
  if (rule.what === 'category') return t(`cat.${rule.category}`);
  if (rule.what === 'merchant') return `“${rule.text}”`;
  return t('alert.anyPurchase');
}

export function alertText(t, money, a, lang) {
  const d = a.data || {};
  const day = (iso) => (iso ? formatDate(iso, lang, { day: 'numeric', month: 'long' }) : '');
  switch (a.kind) {
    case 'unusual': return { title: t('alert.unusual.t'), text: t('alert.unusual.x', { v: money(d.amount), c: t(`cat.${d.category}`), d: d.description || '', u: money(d.usual) }) };
    case 'duplicate': return { title: t('alert.duplicate.t'), text: t('alert.duplicate.x', { d: d.description || '', v: money(d.amount) }) };
    case 'subDuplicate': return { title: t('alert.subDuplicate.t'), text: t('alert.subDuplicate.x', { n: d.name, v: money(d.amount) }) };
    case 'cardLimit': return { title: t('alert.cardLimit.t'), text: t('alert.cardLimit.x', { c: d.card, p: d.pct, v: money(d.available) }) };
    case 'shortfall': return { title: t('alert.shortfall.t'), text: t('alert.shortfall.x', { d: day(d.date), v: money(d.short) }) };
    case 'subUp': return { title: t('alert.subUp.t'), text: t('alert.subUp.x', { n: d.name, a: money(d.from), b: money(d.to), p: d.pct }) };
    case 'subNew': return { title: t('alert.subNew.t'), text: t('alert.subNew.x', { n: d.name, v: money(d.amount) }) };
    case 'subSoon': return { title: t('alert.subSoon.t'), text: t('alert.subSoon.x', { n: d.name, v: money(d.amount), d: day(d.date) }) };
    case 'budgetOver': return { title: t('alert.budgetOver.t'), text: t('alert.budgetOver.x', { c: t(`cat.${d.category}`), v: money(d.spent), l: money(d.limit) }) };
    case 'budgetNear': return { title: t('alert.budgetNear.t'), text: t('alert.budgetNear.x', { c: t(`cat.${d.category}`), p: d.pct, v: money(d.spent), l: money(d.limit) }) };
    case 'overdue': return { title: t('alert.overdue.t'), text: t(d.invoice ? 'alert.overdue.inv' : 'alert.overdue.x', { d: d.description || t(`cat.${d.category}`), v: money(d.amount), w: day(d.date) }) };
    case 'ruleMonth': return { title: t('alert.ruleMonth.t', { w: ruleLabel(t, d.rule) }), text: t('alert.ruleMonth.x', { w: ruleLabel(t, d.rule), l: money(d.limit), v: money(d.spent) }) };
    case 'rulePurchase': return { title: t('alert.rulePurchase.t', { l: money(d.rule.limit) }), text: t('alert.rulePurchase.x', { d: d.description || ruleLabel(t, d.rule), v: money(d.amount) }) };
    default: return { title: t('alert.generic'), text: '' };
  }
}
