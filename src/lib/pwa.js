import { useEffect, useState } from 'react';

let deferred = null;
const subs = new Set();
const emit = () => subs.forEach((f) => f());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; emit(); });
  window.addEventListener('appinstalled', () => { deferred = null; emit(); });
}

export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

export const platform = () => {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
};

export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); subs.add(f); return () => subs.delete(f); }, []);
  return {
    canPrompt: !!deferred,
    installed: isStandalone(),
    platform: platform(),
    async prompt() {
      if (!deferred) return false;
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      deferred = null; emit();
      return outcome === 'accepted';
    },
  };
}

// The hosted link version (claude.ai) can't download by itself: the viewer confirms each save through claude.ai.
const IN_LINK = import.meta.env.VITE_ARTIFACT === '1';
let saver = null;
/** claude.ai's file saver, or null where there is none (asked once; resolves when the viewer's app answers). */
export function linkSaver() {
  if (!IN_LINK) return Promise.resolve(null);
  saver ||= (typeof window !== 'undefined' && window.claude?.use ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null));
  return saver;
}

/**
 * Offers a file the app made: 'saved', 'declined' (the person said no, or a save prompt is already open)
 * or 'unavailable' (no way to save a file here: the caller shows the text to copy instead).
 */
export async function download(filename, content, type = 'application/json') {
  const blob = new Blob([content], { type });
  if (IN_LINK) {
    const s = await linkSaver();
    if (!s) return 'unavailable';
    try {
      await s.save({ filename, data: blob });
      return 'saved';
    } catch (e) {
      return e?.code === 'declined' || e?.code === 'rate_limited' ? 'declined' : 'unavailable';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 'saved';
}
