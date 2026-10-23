import { useEffect, useState } from 'react';

let updateFn = null;
let needRefresh = false;
const subs = new Set();

export async function initSW() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  const { registerSW } = await import('virtual:pwa-register');
  updateFn = registerSW({
    immediate: true,
    onNeedRefresh() { needRefresh = true; subs.forEach((f) => f()); },
    onRegisteredSW(_url, reg) {
      // look for a new version every hour while the app is open
      if (reg) setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    },
  });
}

export function useSWUpdate() {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); subs.add(f); return () => subs.delete(f); }, []);
  return { needRefresh, update: () => updateFn?.(true) };
}
