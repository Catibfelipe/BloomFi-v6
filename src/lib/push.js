/**
 * Bill reminders.
 * - With the server configured (VAPID keys): real push notifications, even with the app closed.
 *   The device sends only the times and short texts; names and amounts only if the user allows.
 * - Always: when the app opens, a notification for bills due today or late (once a day).
 */
import { api, IS_ARTIFACT } from './billing.js';
import { addDays, todayISO } from './dates.js';

export const pushSupported = () => !IS_ARTIFACT && typeof window !== 'undefined'
  && 'serviceWorker' in navigator && 'Notification' in window;
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

const keyBytes = (b64) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function swRegistration(timeout = 4000) {
  return Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('no_sw'), { code: 'no_sw' })), timeout))]);
}

const sameKey = (sub, publicKey) => {
  const k = sub?.options?.applicationServerKey;
  if (!k) return true; // browsers that don't tell: assume it's ours
  const a = new Uint8Array(k), b = keyBytes(publicKey);
  return a.length === b.length && a.every((x, i) => x === b[i]);
};

/**
 * The browser's push subscription for our server key: renewed if the key changed, and created
 * if missing (only with `create`, i.e. when the user just allowed it or already had allowed it).
 */
async function subscribe(publicKey, timeout, create = true) {
  const reg = await swRegistration(timeout);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, publicKey)) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub && !create) {
    const state = await reg.pushManager.permissionState?.({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }).catch(() => null);
    if ((state || Notification.permission) !== 'granted') return null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  return sub.toJSON();
}

/** Asks permission and, when the server supports it, subscribes to push. Returns the subscription JSON or null. */
export async function enableReminders(publicKey) {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw Object.assign(new Error('denied'), { code: 'denied' });
  if (!publicKey || !('PushManager' in window)) return null;
  return subscribe(publicKey);
}

/** The current subscription, without asking anything (null when not allowed or not possible). */
export async function currentSubscription(publicKey) {
  if (!publicKey || !pushSupported() || !('PushManager' in window)) return null;
  try { return await subscribe(publicKey, 3000, false); } catch { return null; }
}

/** Stops reminders: the server forgets the subscription. keepLocal leaves the browser subscription alone. */
export async function disableReminders(sub, { keepLocal = false } = {}) {
  if (!keepLocal) {
    try {
      const reg = await swRegistration(1500);
      const cur = await reg.pushManager?.getSubscription();
      if (cur) await cur.unsubscribe();
    } catch { /* no service worker */ }
  }
  if (sub?.endpoint) await api('push/remove', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
}

const actionable = (i) => i.type !== 'income' && i.type !== 'redeem' && !(i.kind === 'recurring' && i.template?.autoPay !== false) && !i.tx?.autoConfirm;
const at = (iso, hour) => Math.floor(new Date(`${iso}T${String(hour).padStart(2, '0')}:00:00`).getTime() / 1000);

/** Reminder schedule for the next weeks: the day before and the day a bill is due, plus late ones. */
export function buildReminders(agenda, { hour = 9, detail = false, t, money, label }, today = todayISO()) {
  const byDate = new Map();
  for (const i of agenda.filter(actionable)) {
    const key = i.overdue ? 'late' : i.date;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(i);
  }
  const describe = (list) => (detail
    ? list.map((i) => `${label(i)} · ${money(i.amount)}`).join('; ')
    : t('rem.count', { n: list.length })).slice(0, 160);
  const out = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const late = byDate.get('late');
  if (late) {
    const when = at(today, hour) > nowSec ? at(today, hour) : at(addDays(today, 1), hour);
    out.push({ at: when, title: t('rem.lateTitle', { n: late.length }), body: describe(late), tag: 'late' });
  }
  for (const [date, list] of byDate) {
    if (date === 'late') continue;
    const before = addDays(date, -1);
    if (before >= today) out.push({ at: at(before, hour), title: t('rem.tomorrowTitle', { n: list.length }), body: describe(list), tag: `due:${date}` });
    out.push({ at: at(date, hour), title: t('rem.todayTitle', { n: list.length }), body: describe(list), tag: `due:${date}` });
  }
  return out.filter((r) => r.at > nowSec).sort((a, b) => a.at - b.at).slice(0, 60);
}

export const sendSchedule = (subscription, items) => api('push', { method: 'POST', body: { subscription, items } });
export const sendTest = (endpoint, lang) => api('push/test', { method: 'POST', body: { endpoint, lang } });

/** When the app opens: one notification a day about bills due today or late (works without the server). */
export async function localReminder({ agenda, t, money, label, detail }, lastDay) {
  if (!pushSupported() || Notification.permission !== 'granted') return null;
  const today = todayISO();
  if (lastDay === today) return null;
  const due = agenda.filter((i) => actionable(i) && (i.overdue || i.today));
  if (!due.length) return null;
  const title = due.some((i) => i.overdue) ? t('rem.lateTitle', { n: due.length }) : t('rem.todayTitle', { n: due.length });
  const body = detail ? due.map((i) => `${label(i)} · ${money(i.amount)}`).join('; ').slice(0, 160) : t('rem.count', { n: due.length });
  try {
    const reg = await swRegistration(2000);
    await reg.showNotification(title, { body, icon: '/pwa-192.png', badge: '/favicon-64.png', tag: 'bloomfi-today', data: { url: '/app/#agenda' } });
  } catch {
    try { new Notification(title, { body, icon: '/pwa-192.png' }); } catch { return null; }
  }
  return today;
}
