/**
 * The local AI's own thread: WebLLM (WebGPU) loads the model and writes the answers here, so the screen never
 * freezes. The page talks to it with small messages (see localAiEngine.js); the model files are downloaded once
 * and kept in the browser's cache on this device.
 */
import { CreateMLCEngine, hasModelInCache, deleteModelAllInfoInCache } from '@mlc-ai/web-llm';

let engine = null;
let engineId = null;
let loading = null;

async function load(id, reply) {
  if (engine && engineId === id) return;
  if (engine) { await engine.unload().catch(() => {}); engine = null; engineId = null; }
  engine = await CreateMLCEngine(id, {
    initProgressCallback: (p) => reply({ progress: { value: Number(p.progress) || 0, text: String(p.text || '') } }),
  });
  engineId = id;
}

const ACTIONS = {
  async has({ id }) { return { has: await hasModelInCache(id) }; },
  async load({ id }, reply) {
    loading = load(id, reply).finally(() => { loading = null; });
    await loading;
    return { ok: true };
  },
  async chat({ id, messages, maxTokens, temperature }, reply) {
    if (loading) await loading;
    if (!engine || engineId !== id) await load(id, reply);
    const r = await engine.chat.completions.create({
      messages, max_tokens: maxTokens, temperature, top_p: 0.9, extra_body: { enable_thinking: false },
    });
    return { text: String(r.choices?.[0]?.message?.content || '') };
  },
  async stop() { await engine?.interruptGenerate?.(); return { ok: true }; },
  async remove({ id }) {
    if (engine && engineId === id) { await engine.unload().catch(() => {}); engine = null; engineId = null; }
    await deleteModelAllInfoInCache(id);
    return { ok: true };
  },
};

self.onmessage = async (e) => {
  const { n, type, ...args } = e.data || {};
  const reply = (data) => self.postMessage({ n, ...data });
  try {
    const fn = ACTIONS[type];
    if (!fn) throw new Error('unknown');
    reply({ done: true, result: await fn(args, reply) });
  } catch (err) {
    const msg = String(err?.message || err || '');
    // Out of GPU memory, a lost device or a missing feature: the page shows a clear message for each.
    const code = /out of memory|OOM|allocate/i.test(msg) ? 'ai_memory'
      : /device (was )?lost|DeviceLost/i.test(msg) ? 'ai_device_lost'
        : /fetch|network|Failed to fetch|NetworkError/i.test(msg) ? 'ai_download'
          : /shader-f16|WebGPU|adapter/i.test(msg) ? 'ai_unsupported' : 'ai_failed';
    if (code === 'ai_device_lost' || code === 'ai_memory') { engine = null; engineId = null; }
    reply({ done: true, error: { code, message: msg.slice(0, 300) } });
  }
};
