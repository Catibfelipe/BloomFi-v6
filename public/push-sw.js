/* Notifications from the BloomFi server (bill reminders, phone captures, new bank data).
   Shows the notification, tells an open app to refresh, and opens the app when tapped. */
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }
  const show = self.registration.showNotification(d.title || 'BloomFi', {
    body: d.body || 'Você tem novidades no BloomFi.',
    icon: '/pwa-192.png',
    badge: '/favicon-64.png',
    tag: d.tag || 'bloomfi',
    renotify: d.kind === 'capture',
    data: { url: d.url || '/app/#agenda' },
  });
  const tell = self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((list) => list.forEach((c) => c.postMessage({ type: 'push', kind: d.kind || 'reminder' })));
  event.waitUntil(Promise.all([show, tell]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/app/#agenda';
  // Only our own app pages open from a notification.
  const url = typeof raw === 'string' && /^\/app(\/|#|$)/.test(raw) ? raw : '/app/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.includes('/app') && 'focus' in c) { if ('navigate' in c) c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
