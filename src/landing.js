// Site page script (no inline scripts: our Content Security Policy blocks them).
// Someone who installed BloomFi as an app and lands here goes straight to the app.
const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
if (standalone) window.location.replace('/app/');

const y = document.querySelector('[data-year]');
if (y) y.textContent = String(new Date().getFullYear());

// Returning users: the buttons say "Abrir o app" instead of "Começar".
(async () => {
  try {
    const dbs = await indexedDB.databases?.();
    if (dbs?.some((d) => d.name === 'bloomfi')) {
      document.querySelectorAll('[data-open-app]').forEach((a) => { if (!a.classList.contains('btn-small')) a.textContent = 'Abrir o app'; });
    }
  } catch { /* not supported: keep the default text */ }
})();

// Support contact (set SUPPORT_EMAIL / SUPPORT_WHATSAPP on the server).
(async () => {
  try {
    const r = await fetch('/api/config', { headers: { Accept: 'application/json' } });
    if (!r.ok) return;
    const s = (await r.json()).support || {};
    const links = [];
    if (s.whatsapp) links.push(['WhatsApp', `https://wa.me/${s.whatsapp}?text=${encodeURIComponent('Olá! Tenho uma dúvida sobre o BloomFi.')}`]);
    if (s.email) links.push(['E-mail', `mailto:${s.email}?subject=${encodeURIComponent('BloomFi')}`]);
    if (!links.length) return;
    const make = ([label, href]) => { const a = document.createElement('a'); a.href = href; a.textContent = label; a.target = '_blank'; a.rel = 'noopener'; return a; };
    const box = document.querySelector('[data-support-links]');
    links.forEach((l, i) => { if (i) box.append(' · '); box.append(make(l)); });
    document.querySelector('[data-support]').hidden = false;
    const foot = document.querySelector('[data-support-foot]');
    links.forEach((l) => foot.append(make(l)));
  } catch { /* offline or no server: no contact links */ }
})();
