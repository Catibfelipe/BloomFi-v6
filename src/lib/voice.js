/**
 * Talking to Wally: the browser's own speech recognition (what you say becomes text) and speech synthesis
 * (Wally's answer read aloud). Both run in the browser/phone; nothing extra is sent to our server.
 * Where a phone or browser has no recognition, the keyboard's microphone (dictation) still works in the text box.
 */
const W = typeof window !== 'undefined' ? window : {};
const Rec = W.SpeechRecognition || W.webkitSpeechRecognition || null;

export const canListen = () => !!(W.SpeechRecognition || W.webkitSpeechRecognition);
export const canSpeak = () => !!W.speechSynthesis && typeof W.SpeechSynthesisUtterance !== 'undefined';

/**
 * Listens once. onText(text, final) gets what was understood so far; onEnd() when it stops; onError(code) with
 * 'denied' (no permission), 'unavailable' (no recognition here), 'no-speech' or 'error'. Returns { stop } (stop = finish now
 * and keep what was said).
 */
export function listen({ lang = 'pt', onText, onEnd, onError } = {}) {
  const R = W.SpeechRecognition || W.webkitSpeechRecognition || Rec;
  if (!R) { onError?.('unsupported'); onEnd?.(); return { stop() {} }; }
  let r;
  try {
    r = new R();
  } catch {
    onError?.('unsupported'); onEnd?.();
    return { stop() {} };
  }
  r.lang = lang === 'pt' ? 'pt-BR' : 'en-US';
  r.interimResults = true;
  r.continuous = false;
  r.maxAlternatives = 1;
  let ended = false;
  const end = () => { if (!ended) { ended = true; onEnd?.(); } };
  r.onresult = (e) => {
    let text = '', final = false;
    for (const res of e.results) { text += res[0].transcript; if (res.isFinal) final = true; }
    onText?.(text.replace(/\s+/g, ' ').trim(), final);
  };
  r.onerror = (e) => {
    // not-allowed: the person said no to the microphone; service-not-allowed: this browser/app mode has no recognition
    // (an iPhone home-screen app, for example) - the keyboard's dictation still works there.
    const code = e.error === 'not-allowed' ? 'denied' : e.error === 'service-not-allowed' ? 'unavailable' : e.error === 'no-speech' ? 'no-speech' : e.error === 'aborted' ? 'aborted' : 'error';
    if (code !== 'aborted') onError?.(code);
  };
  r.onend = end;
  try { r.start(); } catch { onError?.('error'); end(); }
  return { stop() { try { r.stop(); } catch { end(); } } };
}

// ---------------- reading answers aloud ----------------
let voices = [];
const loadVoices = () => { try { voices = W.speechSynthesis?.getVoices?.() || []; } catch { voices = []; } };
if (canSpeak()) {
  loadVoices();
  try { W.speechSynthesis.addEventListener?.('voiceschanged', loadVoices); } catch { /* old browsers */ }
}
/** The nicest voice of the language: natural/premium/enhanced ones first, then the system's default. */
export function pickVoice(lang = 'pt', list = voices) {
  const want = lang === 'pt' ? /^pt[-_]BR/i : /^en[-_](US|GB)/i;
  const fallback = lang === 'pt' ? /^pt/i : /^en/i;
  const cands = list.filter((v) => want.test(v.lang)).concat(list.filter((v) => !want.test(v.lang) && fallback.test(v.lang)));
  const score = (v) => (/(natural|neural|premium|enhanced|aprimorad|online)/i.test(v.name) ? 4 : 0) + (/google|microsoft|siri|luciana|francisca|thalita|felipe|daniel/i.test(v.name) ? 2 : 0)
    + (want.test(v.lang) ? 3 : 0) + (v.localService ? 1 : 0) - (/compact|eloquence|novelty|bad|bells|zarvox|whisper/i.test(v.name) ? 5 : 0);
  return cands.sort((a, b) => score(b) - score(a))[0] || null;
}

/** Text as it should sound: no bullets, emoji or symbols that would be read out. */
export function speechText(text) {
  return String(text || '')
    .replace(/[•▪◦·]/g, ', ')
    .replace(/\p{Extended_Pictographic}|‍|️/gu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/https?:\/\/[^\s)]+/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[*_#`>|]/g, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.(\s*\.)+/g, '.')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/([:;,])\./g, '$1')
    .replace(/([,.])[,.]+/g, '$1')
    .trim()
    .slice(0, 1800);
}

/**
 * Short pieces, sentence by sentence: some browsers (Chrome on a computer) stop a long utterance after ~15 s.
 * The pieces are queued together, so they sound like one answer.
 */
export function speechChunks(text, max = 220) {
  const out = [];
  let cur = '';
  const push = (s) => { if (s.trim()) out.push(s.trim()); };
  for (const sentence of String(text || '').split(/(?<=[.!?…])\s+/)) {
    const pieces = sentence.length <= max ? [sentence] : sentence.split(/(?<=[,;:])\s+/).flatMap((p) => {
      if (p.length <= max) return [p];
      const words = p.split(' ');
      const acc = [];
      let line = '';
      for (const w of words) { if ((`${line} ${w}`).trim().length > max) { acc.push(line); line = w; } else line = `${line} ${w}`.trim(); }
      return [...acc, line];
    });
    for (const p of pieces) {
      if (!cur) cur = p;
      else if (`${cur} ${p}`.length <= max) cur = `${cur} ${p}`;
      else { push(cur); cur = p; }
    }
  }
  push(cur);
  return out;
}

let current = null;
/** Reads one text aloud (stopping anything that was being read). onEnd() when it finishes or is stopped. */
export function speak(text, { lang = 'pt', onEnd } = {}) {
  if (!canSpeak()) { onEnd?.(); return false; }
  const parts = speechChunks(speechText(text));
  if (!parts.length) { onEnd?.(); return false; }
  stopSpeaking();
  if (!voices.length) loadVoices();
  const v = pickVoice(lang);
  const token = {};
  let done = false;
  const finish = () => { if (!done) { done = true; if (current === token) current = null; onEnd?.(); } };
  token.finish = finish;
  current = token;
  try {
    parts.forEach((p, i) => {
      const u = new W.SpeechSynthesisUtterance(p);
      u.lang = lang === 'pt' ? 'pt-BR' : 'en-US';
      if (v) u.voice = v;
      u.rate = 1.03;
      u.pitch = 1;
      if (i === parts.length - 1) u.onend = finish;
      u.onerror = finish;
      W.speechSynthesis.speak(u);
    });
  } catch { finish(); return false; }
  return true;
}
export function stopSpeaking() {
  if (!canSpeak()) return;
  const was = current;
  current = null;
  try { W.speechSynthesis.cancel(); } catch { /* nothing to stop */ }
  if (was) { try { was.finish(); } catch { /* already ended */ } }
}
export const isSpeaking = () => !!current;

/**
 * Phones only let a page speak after a tap: called on the tap that sends a question (or turns voice on), so the
 * answer that arrives a few seconds later can be read aloud.
 */
export function unlockSpeech() {
  if (!canSpeak()) return;
  try {
    const u = new W.SpeechSynthesisUtterance(' ');
    u.volume = 0;
    W.speechSynthesis.speak(u);
  } catch { /* nothing to unlock */ }
}
