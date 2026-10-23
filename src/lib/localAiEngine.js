/**
 * Talks to the local AI's thread (localAi.worker.js). Kept apart so the link version, which has no AI, can swap
 * this file for a stub and leave the model's code out of its single page.
 */
let worker = null;
let seq = 0;
const waiting = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./localAi.worker.js', import.meta.url), { type: 'module', name: 'bloomfi-ai' });
  worker.onmessage = (e) => {
    const { n, done, result, error, progress } = e.data || {};
    const w = waiting.get(n);
    if (!w) return;
    if (progress) { w.onProgress?.(progress); return; }
    if (!done) return;
    waiting.delete(n);
    if (error) w.reject(Object.assign(new Error(error.code), { code: error.code, detail: error.message }));
    else w.resolve(result);
  };
  worker.onerror = () => {
    for (const w of waiting.values()) w.reject(Object.assign(new Error('ai_failed'), { code: 'ai_failed' }));
    waiting.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function callEngine(type, args = {}, onProgress) {
  const w = getWorker();
  const n = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(n, { resolve, reject, onProgress });
    w.postMessage({ n, type, ...args });
  });
}

/** Frees the GPU memory (the model files stay in the cache). */
export function shutEngine() {
  worker?.terminate();
  worker = null;
  for (const w of waiting.values()) w.reject(Object.assign(new Error('ai_stopped'), { code: 'ai_stopped' }));
  waiting.clear();
}
