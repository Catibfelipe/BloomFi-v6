// Wally with AI on the device: the tool list the local model reads, reading its tool calls (also the sloppy
// ones small models write), the conversation fitting its short memory, repeated calls, the forced final answer,
// and that the server no longer has (or mentions) a cloud AI. Run: node test/ai.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateLicenseKeys, randomId } from '../server/crypto.js';
import { makeDevice } from './helpers.mjs';

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
const today = new Date().toISOString().slice(0, 10);

const { READ_TOOLS, ACTION_TOOLS, LOCAL_TOOL_NAMES, systemPrompt } = await import('../src/lib/aiSpec.js');
const { AI_TOOL_NAMES } = await import('../src/lib/aiTools.js');
const { ACTION_TOOL_NAMES } = await import('../src/lib/aiActions.js');
const { parseToolCalls, cleanAnswer, askAi } = await import('../src/lib/aiChat.js');
const { LOCAL_MODELS, modelFor, localAiSupport } = await import('../src/lib/localAi.js');

// ---- the tool list ----
assert.deepEqual(READ_TOOLS.map(([n]) => n).sort(), [...AI_TOOL_NAMES].sort());
assert.deepEqual(ACTION_TOOLS.map(([n]) => n).sort(), [...ACTION_TOOL_NAMES].sort(), 'the model is offered exactly the actions the app can prepare');
const sys = systemPrompt({ lang: 'pt', today, currency: 'BRL' });
for (const n of LOCAL_TOOL_NAMES) assert.ok(sys.includes(`- ${n}(`), n);
assert.match(sys, /Brazilian Portuguese/);
assert.match(systemPrompt({ lang: 'en', today, currency: 'USD' }), /Always answer in English/);
// about 1 200 tokens: the model's memory is 4 096, and the conversation and the answer need the rest
assert.ok(sys.length < 5000, `instructions too long for the small model: ${sys.length}`);
ok('the local model sees every tool the app has (reading and actions), in instructions short enough for its memory');

// ---- the models ----
assert.equal(modelFor('light', { f16: true }), LOCAL_MODELS.light.f16);
assert.equal(modelFor('full', { f16: false }), LOCAL_MODELS.full.f32, 'GPUs without shader-f16 get the f32 build');
assert.equal(modelFor('nonsense', {}), LOCAL_MODELS.light.f16);
assert.deepEqual(await localAiSupport(), { ok: false, reason: 'no_webgpu' }, 'without WebGPU the AI is simply not offered');
ok('two model sizes (Light / Full), the right build for the GPU, and no AI where there is no WebGPU');

// ---- reading tool calls ----
let c = parseToolCalls('Vou ver.\n<tool_call>{"name": "get_overview", "arguments": {}}</tool_call>');
assert.deepEqual(c, [{ name: 'get_overview', input: {} }]);
c = parseToolCalls('<tool_call>\n```json\n{"name":"search_transactions","arguments":{"text":"ifood {pedido}"}}\n```\n</tool_call>\n<tool_call>{"name":"get_alerts","arguments":"{}"}');
assert.deepEqual(c, [{ name: 'search_transactions', input: { text: 'ifood {pedido}' } }, { name: 'get_alerts', input: {} }], 'code fences, braces inside strings, a missing closing tag and arguments as a string');
assert.deepEqual(parseToolCalls('<tool_call>{"name": broken</tool_call> e nada mais'), []);
assert.deepEqual(parseToolCalls('Você gastou R$ 300 com mercado.'), []);
assert.deepEqual(parseToolCalls('<tool_call>{"name":"x","arguments":[1]}</tool_call>'), [{ name: 'x', input: {} }]);
assert.equal(cleanAnswer('<think>hmm</think>**Você** gastou R$ 10.\n\n\n\n<tool_call>{"name":"a"}</tool_call>'), 'Você gastou R$ 10.');
ok('tool calls are read even when a small model writes them sloppily; the answer comes out clean (no thinking, no tags, no bold)');

// ---- the whole loop ----
globalThis.fetch = async () => { throw new Error('no network: the AI runs on the device'); };
const ctx = { txs: [], accounts: [], cards: [], assets: [], goals: [], budgets: [], categories: [], rules: [], ledger: { today, accounts: [], cards: [] }, subs: { items: [] }, forecast: null, alerts: [], today, t: (k) => k, lang: 'pt', money: (v) => `R$ ${v}` };

// an unknown tool comes back as an error with the valid names; the model may then answer
let seen = [];
let r = await askAi('oi', {
  ctx, today, engine: async (m) => { seen.push(m); return seen.length === 1 ? '<tool_call>{"name":"pay_bill","arguments":{}}</tool_call>' : 'Oi! Em que posso ajudar?'; },
});
assert.equal(r.text, 'Oi! Em que posso ajudar?');
assert.match(seen[1][seen[1].length - 1].content, /unknown_tool/);
ok('a tool that does not exist is answered with an error and the list of valid ones');

// the same call again and again: it runs once, then the model is told to answer
seen = [];
r = await askAi('quanto tenho?', {
  ctx, today, engine: async (m) => { seen.push(m); return /Do not call any tool/.test(m[m.length - 1].content) ? 'Você tem R$ 0.' : '<tool_call>{"name":"get_overview","arguments":{}}</tool_call>'; },
});
assert.equal(r.text, 'Você tem R$ 0.');
assert.equal(seen.length, 3, 'asked, repeated itself, then answered');
assert.equal(seen.flat().filter((m) => m.content.includes('<tool_response>get_overview')).length >= 1, true);
ok('a repeated tool call runs once, and the model is told to answer with what it has');

// a model that never stops asking still ends with an answer after a few rounds
seen = [];
let k = 0;
r = await askAi('me conta tudo', {
  ctx, today, engine: async (m) => { seen.push(m); k++; return /Do not call any tool/.test(m[m.length - 1].content) ? 'Pronto.' : `<tool_call>{"name":"get_monthly_trend","arguments":{"months":${k + 1}}}</tool_call>`; },
});
assert.equal(r.text, 'Pronto.');
assert.equal(seen.length, 4);
ok('a model that keeps asking for tools is stopped after 3 rounds and answers');

// a long chat and big results stay inside the model's memory
const history = Array.from({ length: 4 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(2500) }));
const bigCtx = { ...ctx, txs: Array.from({ length: 400 }, (_, i) => ({ id: `t${i}`, type: 'expense', amount: 10 + i, date: today, desc: `Compra número ${i} no mercado do bairro`, category: 'groceries' })) };
seen = [];
r = await askAi('quanto gastei?', {
  ctx: bigCtx, history, today, engine: async (m) => { seen.push(m); return seen.length === 1 ? '<tool_call>{"name":"search_transactions","arguments":{"limit":60}}</tool_call>' : 'Muito.'; },
});
for (const m of seen) {
  const talk = m.slice(1).reduce((n, x) => n + x.content.length, 0);
  assert.ok(talk <= 6700, `conversation too long for the model: ${talk}`);
  assert.equal(m[m.length - 1].role, 'user');
}
assert.ok(seen[1].some((x) => x.content.includes('quanto gastei?')), 'the question itself is never cut');
ok('long chats and big results are trimmed to fit the model’s memory (the question always stays)');

// an empty answer is an error (the app then answers the simple way)
await assert.rejects(askAi('oi', { ctx, today, engine: async () => '   ' }), (e) => e.code === 'ai_no_answer');
ok('no answer from the model = the simple on-device answer');

// ---- the server: no cloud AI anymore ----
const blobs = fs.mkdtempSync(path.join(os.tmpdir(), 'bloomfi-ai-'));
const { priv } = await generateLicenseKeys();
Object.assign(process.env, { BLOBS_DIR: blobs, APP_SECRET: randomId(48), LICENSE_PRIVATE_JWK: JSON.stringify(priv), QUIET_LOGS: '1', ANTHROPIC_API_KEY: 'sk-ant-should-be-ignored' });
const { handle, ROUTE_KEYS } = await import('../server/handler.js');
assert.ok(!ROUTE_KEYS.some((k) => / ai\//.test(k)), 'no AI routes on the server');
const dev = makeDevice(handle)('iphone');
const cfg = await dev.call('GET', 'config');
assert.equal(cfg.status, 200);
assert.equal(cfg.data.ai, undefined);
assert.ok(!JSON.stringify(cfg.data).includes('sk-ant'));
assert.ok(!fs.existsSync(new URL('../server/ai.js', import.meta.url)), 'the cloud AI code is gone');
ok('the server has no AI routes and ignores any Anthropic key');

console.log(`\n${passed} checks passed`);
process.exit(0);
