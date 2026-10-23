const pad = (n) => String(n).padStart(2, '0');

export const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayISO = () => toISO(new Date());
export const parseISO = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d || 1);
};
export const monthKey = (iso) => iso.slice(0, 7);
export const currentMonth = () => todayISO().slice(0, 7);

export function addMonths(mk, delta) {
  const [y, m] = mk.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function daysInMonth(mk) {
  const [y, m] = mk.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

export function addDays(iso, delta) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + delta);
  return toISO(d);
}

export function daysBetween(fromISO, toISOstr) {
  const a = parseISO(fromISO), b = parseISO(toISOstr);
  return Math.round((b - a) / 86400000);
}

/** Same day-of-month in another month, clamped (e.g. 31 -> 30 in April). */
export function sameDayIn(iso, mk) {
  const day = Number(iso.slice(8, 10));
  return `${mk}-${pad(Math.min(day, daysInMonth(mk)))}`;
}

export function monthsBetween(fromMk, toMk) {
  const [y1, m1] = fromMk.split('-').map(Number);
  const [y2, m2] = toMk.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}
