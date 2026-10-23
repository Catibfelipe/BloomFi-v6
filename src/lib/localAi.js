/**
 * Wally's AI on the person's own device (WebLLM + WebGPU): no key, no server, no cost, nothing leaves the device.
 * The model is downloaded once (about 1 GB, or 2.3 GB for the bigger one) and stays in the browser's cache.
 *
 * localAiSupport()           -> { ok, reason?, f16, recommended }   (WebGPU and enough memory?)
 * modelFor(key, support)     -> the WebLLM model id for 'light' | 'full' on this device
 * isDownloaded(id)           -> true when the files are already on this device
 * prepareModel(id, onProgress) -> downloads (first time) and loads it into memory
 * complete(id, messages)     -> the model's answer (text)
 * removeModel(id)            -> deletes the files from this device
 */
import { callEngine, shutEngine } from './localAiEngine.js';

export const LOCAL_MODELS = {
  // Qwen3: good with Portuguese and with tool calls for its size. q4f16 needs the GPU's "shader-f16"; else q4f32.
  light: { f16: 'Qwen3-1.7B-q4f16_1-MLC', f32: 'Qwen3-1.7B-q4f32_1-MLC', gb: 1.1, memGb: 2 },
  full: { f16: 'Qwen3-4B-q4f16_1-MLC', f32: 'Qwen3-4B-q4f32_1-MLC', gb: 2.3, memGb: 3.5 },
};
export const MODEL_KEYS = Object.keys(LOCAL_MODELS);

let supportP = null;
/** Asked once: can this browser run the local AI? */
export function localAiSupport() {
  supportP ||= (async () => {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav?.gpu) return { ok: false, reason: 'no_webgpu' };
    let adapter = null;
    try { adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch { /* none */ }
    if (!adapter) return { ok: false, reason: 'no_adapter' };
    const f16 = !!adapter.features?.has?.('shader-f16');
    const maxBuf = Number(adapter.limits?.maxBufferSize) || 0;
    const mem = Number(nav.deviceMemory) || 0; // Chrome only (and capped at 8); Safari says nothing
    const mobile = /Android|iPhone|iPad|Mobile/i.test(nav.userAgent || '') || (nav.maxTouchPoints > 1 && /Mac/.test(nav.platform || ''));
    // The bigger model is offered as the default only on computers that clearly have room for it.
    const recommended = !mobile && (mem >= 8 || (!mem && maxBuf >= 2 ** 31)) ? 'full' : 'light';
    return { ok: true, f16, mobile, recommended };
  })();
  return supportP;
}

export function modelFor(key, support) {
  const m = LOCAL_MODELS[key] || LOCAL_MODELS.light;
  return support?.f16 === false ? m.f32 : m.f16;
}

/**
 * Looked up straight in the browser's cache (where WebLLM keeps the files), so opening the app doesn't start the
 * AI's thread just to ask.
 */
export async function isDownloaded(id) {
  try {
    if (typeof caches === 'undefined') return false;
    const cache = await caches.open('webllm/model');
    const keys = await cache.keys();
    return keys.some((r) => r.url.includes(`/mlc-ai/${id}/`) && /params_shard_0\.bin/.test(r.url));
  } catch { return false; }
}

export function prepareModel(id, onProgress) {
  return callEngine('load', { id }, onProgress);
}

export async function complete(id, messages, { maxTokens = 450, temperature = 0.3 } = {}) {
  const r = await callEngine('chat', { id, messages, maxTokens, temperature });
  return r.text;
}

export function stopAnswer() { return callEngine('stop').catch(() => {}); }

export async function removeModel(id) {
  await callEngine('remove', { id });
  shutEngine();
}

/** Frees the memory when the AI is turned off (the files stay). */
export function unloadModel() { shutEngine(); }
