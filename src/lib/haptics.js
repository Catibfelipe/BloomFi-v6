/** A short vibration on Android (iPhones ignore it). Respects "reduce motion". */
export function haptic(kind = 'light') {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    if (navigator.vibrate) navigator.vibrate(kind === 'heavy' ? 22 : kind === 'success' ? [10, 40, 12] : kind === 'error' ? [30, 50, 30] : 8);
  } catch { /* not available */ }
}
