/**
 * Wally with AI — one question, start to finish, ON THE DEVICE:
 *   question -> the local model (localAi.js) asks for tools -> the tools run here over the decrypted data ->
 *   results go back to the model -> answer.
 * Nothing leaves the device: the model, the data and the tools are all here.
 */
import { runAiTool } from './aiTools.js';
import { isActionTool, prepareAction, actionSummary } from './aiActions.js';
import { systemPrompt, LOCAL_TOOL_NAMES } from './aiSpec.js';
import { complete } from './localAi.js';

const MAX_ROUNDS = 3; // times the model may ask for tools before it must answer
const MAX_CALLS = 8; // tool calls in one round
const MAX_ACTIONS = 8; // cards one question can prepare
const MAX_RESULT = 1800; // characters of one tool result (the model's memory is short)
const MAX_TALK = 6500; // characters of conversation besides the instructions (about 2 000 tokens)

const CARD_STATE = {
  pending: 'card shown, waiting for the person to confirm', running: 'being saved', done: 'confirmed and saved',
  canceled: 'canceled by the person', undone: 'saved, then undone by the person', failed: 'could not be saved',
};
/**
 * The last lines of the chat, so a follow-up like "e no mês passado?" or "na verdade foi 12 mil" makes sense.
 * Cards Wally prepared go along as one line each, with what the person did with them.
 */
export function historyFor(chat, max = 8) {
  const msgs = (chat || []).filter((m) => (m.from === 'user' || m.from === 'bot') && !m.note && ((typeof m.text === 'string' && m.text.trim()) || m.action))
    .slice(-max).map((m) => (m.action
      ? { role: 'assistant', content: `[${CARD_STATE[m.state] || CARD_STATE.pending}] ${String(m.summary || m.action.kind).slice(0, 400)}` }
      : { role: m.from === 'user' ? 'user' : 'assistant', content: m.text.slice(0, 3000) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  const out = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content = `${prev.content}\n\n${m.content}`.slice(-3500);
    else out.push({ ...m });
  }
  while (out.length && out[out.length - 1].role !== 'assistant') out.pop();
  return out;
}

/** Makes a tool result fit: long lists are cut (the counts and totals stay). */
export function fitResult(obj, max = MAX_RESULT) {
  let text = JSON.stringify(obj);
  if (text.length <= max) return text;
  const copy = JSON.parse(text);
  const lists = ['transactions', 'items', 'assets', 'subscriptions', 'fixed_bills', 'alerts', 'spending_by_category', 'months', 'accounts', 'cards', 'goals', 'budgets'];
  for (let round = 0; round < 10 && text.length > max; round++) {
    for (const k of lists) if (Array.isArray(copy[k]) && copy[k].length > 2) { copy[k] = copy[k].slice(0, Math.ceil(copy[k].length / 2)); copy.cut = true; }
    text = JSON.stringify(copy);
  }
  return text.length <= max ? text : JSON.stringify({ error: 'result_too_long' });
}

/**
 * The model's tool calls: <tool_call>{"name": …, "arguments": {…}}</tool_call> (Qwen's own format). Small models
 * sometimes forget the closing tag or wrap the JSON in a code block; both are accepted. Unknown names are kept
 * so the model can be told they don't exist.
 */
export function parseToolCalls(text) {
  const calls = [];
  const src = String(text || '');
  const re = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;
  let m;
  while ((m = re.exec(src)) && calls.length < MAX_CALLS) {
    const raw = m[1].replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const json = firstJson(raw);
    if (!json) continue;
    const name = String(json.name || json.tool || '').trim();
    let args = json.arguments ?? json.parameters ?? json.input ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    if (name) calls.push({ name, input: args && typeof args === 'object' && !Array.isArray(args) ? args : {} });
  }
  return calls;
}
function firstJson(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

/** What the person reads: no tool calls, no "thinking", no markdown leftovers. */
export function cleanAnswer(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, '')
    .replace(/<\/?tool_response>/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Keeps the conversation inside the model's memory: oldest lines go first, then long tool results are cut. */
function fit(messages) {
  const size = () => messages.reduce((n, m) => n + m.content.length, 0);
  // history (everything before the question) goes first, oldest first, in user/assistant pairs
  while (size() > MAX_TALK && messages.length > 2 && messages[0].keep !== true) messages.splice(0, 2);
  for (const m of messages) {
    if (size() <= MAX_TALK) break;
    if (m.results && m.content.length > 400) m.content = m.content.replace(/<tool_response>[\s\S]*?<\/tool_response>/g, (r) => (r.length > 300 ? '<tool_response>{"omitted":"older result"}</tool_response>' : r));
  }
  return messages;
}

/**
 * Asks the local AI. ctx = what the tools read (see aiTools.js); actionCtx = what the action tools need (aiActions.js).
 * onStep(names) tells the screen which data is being looked at. `engine` (tests) replaces the local model.
 * Returns { text, tools, actions } — actions = cards to show (nothing is saved here).
 */
export async function askAi(question, { history = [], ctx, actionCtx, lang = 'pt', currency = 'BRL', today, modelId, engine, onStep } = {}) {
  const ask = engine || ((messages, opts) => complete(modelId, messages, opts));
  const system = { role: 'system', content: systemPrompt({ lang, today, currency }) };
  const talk = [...history.slice(-4).map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: String(question).slice(0, 800), keep: true }];
  const used = [];
  const actions = [];
  const seen = new Set(); // the same call asked twice (small models repeat themselves) runs once
  let reply = '';
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS;
    const messages = [system, ...fit(talk).map(({ role, content }) => ({ role, content }))];
    if (last) messages.push({ role: 'user', content: 'Now answer the person with what you already have. Do not call any tool.' });
    reply = await ask(messages, { maxTokens: 450 });
    const parsed = last ? [] : parseToolCalls(reply);
    const calls = parsed.filter((c) => {
      const sig = `${c.name}:${JSON.stringify(c.input)}`;
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
    // Asking again for what it already has: straight to the answer.
    if (!calls.length && parsed.length) { round = MAX_ROUNDS - 1; continue; }
    if (!calls.length) break;
    used.push(...calls.map((c) => c.name));
    const known = calls.map((c) => c.name).filter((n) => LOCAL_TOOL_NAMES.includes(n));
    if (known.length) onStep?.(known);
    const results = calls.map((c) => {
      let out;
      if (!LOCAL_TOOL_NAMES.includes(c.name)) out = { error: 'unknown_tool', valid: LOCAL_TOOL_NAMES };
      else if (isActionTool(c.name)) {
        // An action: prepared as a card for the person to confirm; the model only learns what was prepared.
        const r = !actionCtx ? { error: 'actions_unavailable' } : actions.length >= MAX_ACTIONS ? { error: 'too_many_actions' } : prepareAction(c.name, c.input, actionCtx);
        if (r.action) { actions.push(r.action); out = { status: 'waiting_for_confirmation', card: actionSummary(r.action, actionCtx) }; } else out = r;
      } else out = runAiTool(c.name, c.input, ctx);
      return `<tool_response>${c.name}: ${fitResult(out)}</tool_response>`;
    });
    talk.push({ role: 'assistant', content: calls.map((c) => `<tool_call>${JSON.stringify({ name: c.name, arguments: c.input })}</tool_call>`).join('\n') });
    talk.push({ role: 'user', content: results.join('\n'), results: true, keep: true });
    // Only actions and nothing to read: the cards speak for themselves, one more round would only cost time.
    if (calls.every((c) => isActionTool(c.name)) && actions.length && round > 0) break;
  }
  const text = cleanAnswer(reply);
  if (!text && !actions.length) throw Object.assign(new Error('ai_no_answer'), { code: 'ai_no_answer' });
  return { text, tools: [...new Set(used)], actions };
}
