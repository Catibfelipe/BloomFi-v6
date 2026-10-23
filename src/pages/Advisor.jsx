import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Send, Eraser, ShieldCheck, Sparkles, Mic, Volume2, VolumeX, Square, Check, X, Undo2, Receipt, Repeat, TrendingUp, Target,
  PieChart, BellRing, Wallet, CreditCard, Clock,
} from 'lucide-react';
import { useStore } from '../store.jsx';
import Wally from '../components/Wally.jsx';
import { analyze, wallyMood, withForecast } from '../lib/finance.js';
import { wallyReply, advisorPrompts } from '../lib/advisor.js';
import { currentMonth } from '../lib/dates.js';
import { monthProjection } from '../lib/ledger.js';
import { AlertsPanel } from '../components/Alerts.jsx';
import { AiBar, aiErrorNote } from '../components/AiWally.jsx';
import {
  parseCommand, describeAction, actionSummary, yesNo, editAction, actionExpired, isActionTool,
} from '../lib/aiActions.js';
import { canListen, canSpeak, listen, speak, stopSpeaking, unlockSpeech } from '../lib/voice.js';
import { haptic } from '../lib/haptics.js';

const ICONS = {
  add_transaction: Receipt, add_recurring: Repeat, add_investment: TrendingUp, move_investment: TrendingUp, update_investment_value: TrendingUp,
  add_goal: Target, add_to_goal: Target, set_budget: PieChart, add_alert: BellRing, add_account: Wallet, add_card: CreditCard,
};

/** One thing Wally prepared: what will be saved, and the buttons. Nothing is saved before "Confirmar". */
function ActionCard({ msg, ctx, busy, onConfirm, onCancel, onUndo, onEdit }) {
  const { t } = ctx;
  const a = msg.action;
  const d = describeAction(a, ctx);
  const Icon = ICONS[a.kind] || Sparkles;
  const waiting = msg.state === 'pending' || msg.state === 'failed';
  const expired = waiting && actionExpired(msg);
  const open = waiting && !expired && !busy;
  const canPickAccount = open && 'accountId' in a && !a.cardId && a.accountId && ctx.accounts.length > 1;
  return (
    <div className={`act-card ${busy ? 'running' : msg.state}${expired ? ' expired' : ''}`} role="group" aria-label={d.title} aria-busy={busy || undefined}>
      <div className="act-head"><Icon size={16} /><b>{d.title}</b></div>
      <dl className="act-rows">
        {d.rows.map(([k, v, key]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{key === 'account' && canPickAccount ? (
              <select value={a.accountId} aria-label={k} onChange={(e) => onEdit(msg, { accountId: e.target.value })}>
                {ctx.accounts.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            ) : v}</dd>
          </div>
        ))}
      </dl>
      {open && a.kind === 'add_investment' && (
        <label className="check-line act-check">
          <input type="checkbox" checked={!!a.existing} onChange={(e) => onEdit(msg, { existing: e.target.checked })} />
          <span>{t('act2.existingToggle')}</span>
        </label>
      )}
      {open && (
        <div className="act-btns">
          <button className="primary small" onClick={() => onConfirm(msg)}><Check size={15} /> {t('act2.confirm')}</button>
          <button className="ghost small" onClick={() => onCancel(msg)}><X size={15} /> {t('act2.cancel')}</button>
        </div>
      )}
      {busy && <p className="act-status"><span className="spinner" /> {t(msg.state === 'done' ? 'act2.undoing' : 'act2.saving')}</p>}
      {msg.state === 'done' && !busy && (
        <div className="act-btns">
          <span className="act-status ok">{t('act2.done')}</span>
          <button className="link-btn" onClick={() => onUndo(msg)}><Undo2 size={14} /> {t('act2.undo')}</button>
        </div>
      )}
      {msg.state === 'canceled' && <p className="act-status">{t('act2.canceled')}</p>}
      {msg.state === 'undone' && <p className="act-status">{t('act2.undone')}</p>}
      {msg.state === 'failed' && !busy && <p className="act-status err">{t('act2.failed')}</p>}
      {expired && <p className="act-status"><Clock size={13} /> {t('act2.expired')}</p>}
    </div>
  );
}

export default function Advisor({ go }) {
  const store = useStore();
  const {
    txs, budgets, goals, assets, chat, addChat, clearChat, t, lang, money, settings, ledger, accounts, cards, forecast,
    aiOn, askAi, actionCtx, confirmAction, cancelAction, undoChatAction, updateChat, updateSettings, toast, isArtifact,
  } = store;
  // the link version runs inside another site's frame, which gets no microphone
  const micOk = canListen() && !isArtifact;
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const [step, setStep] = useState(null); // which data the AI is looking at ('loading' = the model is waking up)
  const [listening, setListening] = useState(false);
  const [speakingId, setSpeakingId] = useState(null);
  const [busyIds, setBusyIds] = useState(() => new Set());
  const mark = (id, on) => setBusyIds((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const endRef = useRef();
  const rec = useRef(null);
  const busy = useRef(false);
  const voiceOn = !!settings.voiceReplies && canSpeak();
  const a = useMemo(() => withForecast(analyze({ txs, budgets, goals }, currentMonth()), forecast, ledger.today), [txs, budgets, goals, forecast, ledger.today]);
  const mood = typing ? 'thinking' : wallyMood(a, a.sum.count > 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ctx = useMemo(() => actionCtx(), [accounts, cards, assets, goals, budgets, lang, money]);

  const tip = `${t('act2.tip')}${micOk ? ` ${t('act2.tipMic')}` : ''}`;
  const intro = { id: 'intro', from: 'bot', text: `${t('ai.intro', { name: settings.name ? `, ${settings.name}` : '' })}\n\n${tip}` };
  const messages = [intro, ...chat];

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [chat.length, typing, step]);
  useEffect(() => () => { rec.current?.stop(); stopSpeaking(); }, []);

  const localReply = (v) => {
    const projection = monthProjection({ accounts, txs, cards }, ledger.today);
    return wallyReply(v, { a, goals, money, lang, name: settings.name, t, assets, txs, ledger, projection });
  };
  const say = (id, value) => {
    if (!value) return;
    setSpeakingId(id);
    speak(value, { lang, onEnd: () => setSpeakingId((cur) => (cur === id ? null : cur)) });
  };
  const toggleSay = (m) => {
    if (speakingId === m.id) { stopSpeaking(); setSpeakingId(null); return; }
    unlockSpeech();
    say(m.id, m.text);
  };

  /** Cards still waiting for an answer, from Wally's latest reply. */
  const waitingCards = () => {
    const list = store.chat;
    const out = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.from === 'user') break;
      if (m.action && (m.state === 'pending' || m.state === 'failed') && !actionExpired(m)) out.unshift(m);
    }
    return out;
  };
  const errorText = (e) => {
    const key = `act2.ask.${e.error}`;
    const none = (e.error === 'unknown_investment' && !e.investments?.length) || (e.error === 'unknown_goal' && !e.goals?.length);
    if (none) return t(`${key}None`);
    const l = (e.accounts || e.cards || e.investments || e.goals || e.categories || []).slice(0, 8).join(', ');
    return t(key) !== key ? t(key, { l, a: e.asked }) : t('act2.ask.generic');
  };
  const cardRows = (actions) => actions.map((x) => ({ from: 'bot', action: x, state: 'pending', summary: actionSummary(x, ctx) }));

  const confirm = async (m, { quiet = false } = {}) => {
    mark(m.id, true);
    try {
      const row = await confirmAction(m);
      if (!row) return false; // already being saved, or not waiting any more
      haptic();
      if (!quiet) toast(t('act2.toastDone'));
      return true;
    } catch {
      if (!quiet) toast(t('act2.failed'), 'err');
      return false;
    } finally {
      mark(m.id, false);
    }
  };
  const cancel = (m) => cancelAction(m);
  const undo = async (m) => {
    mark(m.id, true);
    try { if (await undoChatAction(m)) toast(t('act2.toastUndone')); } catch { toast(t('act2.failed'), 'err'); } finally { mark(m.id, false); }
  };
  const edit = async (m, patch) => {
    const next = editAction(m.action, patch, ctx);
    await updateChat(m.id, { action: next, summary: actionSummary(next, ctx) });
  };
  const confirmAll = async (group) => {
    let n = 0;
    for (const m of group) if (await confirm(m, { quiet: true })) n++;
    toast(t('act2.toastDoneN', { n }));
  };

  const send = async (value = text, { spoken = false } = {}) => {
    const v = value.trim().slice(0, 800);
    if (!v || typing || busy.current) return;
    busy.current = true;
    const talk = spoken || voiceOn;
    if (talk) unlockSpeech();
    setText('');
    try {
      // "sim" / "não" to the cards Wally just prepared
      const waiting = waitingCards();
      const yn = waiting.length ? yesNo(v) : null;
      if (yn) {
        await addChat([{ from: 'user', text: v }]);
        let n = 0;
        for (const m of waiting) {
          if (yn === 'yes') { if (await confirm(m, { quiet: true })) n++; } else await cancel(m);
        }
        const reply = yn === 'yes' ? t('act2.saidYes', { n }) : t('act2.saidNo');
        const [row] = await addChat([{ from: 'bot', text: reply }]);
        if (talk) say(row.id, reply);
        return;
      }
      await addChat([{ from: 'user', text: v }]);
      setTyping(true);
      // A clear request to add something ("almoço 32 ontem", "investimento de 10000 em cdb bradesco") becomes cards
      // right away, AI or not: it's instant and exact. Everything else goes to the AI when it's on.
      const cmd = parseCommand(v, ctx);
      let note = null;
      if (aiOn && !cmd?.actions.length) {
        try {
          const r = await askAi(v, { onStep: (names) => setStep(names[names.length - 1]), onLoading: (on) => setStep(on ? 'loading' : null) });
          const acts = r.actions || [];
          const lead = r.text || (acts.length ? t(acts.length > 1 ? 'act2.introMany' : 'act2.introOne') : '');
          const rows = [...(lead ? [{ from: 'bot', text: lead, ai: !!r.text }] : []), ...cardRows(acts)];
          const added = await addChat(rows);
          if (talk) say(added[0].id, [lead, ...acts.map((x) => actionSummary(x, ctx)), acts.length ? t('act2.yesHint') : ''].filter(Boolean).join('. '));
          return;
        } catch (e) {
          note = aiErrorNote(t, e);
        } finally {
          setStep(null);
        }
      }
      // Wally's own answer, on this device and without AI.
      let rows;
      let spokenText;
      if (cmd?.actions.length) {
        const lead = t(cmd.actions.length > 1 ? 'act2.introMany' : 'act2.introOne');
        rows = [{ from: 'bot', text: lead }, ...cardRows(cmd.actions)];
        spokenText = [lead, ...cmd.actions.map((x) => actionSummary(x, ctx)), t('act2.yesHint')].join('. ');
      } else if (cmd?.errors.length) {
        rows = [{ from: 'bot', text: errorText(cmd.errors[0]) }];
        spokenText = rows[0].text;
      } else {
        const reply = localReply(v);
        rows = [{ from: 'bot', text: reply }];
        spokenText = reply;
      }
      if (note) rows.unshift({ from: 'bot', text: note, note: true });
      if (!note) await new Promise((r) => setTimeout(r, 350 + Math.min((rows[0].text || '').length, 500)));
      const added = await addChat(rows);
      if (talk) say(added[note ? 1 : 0].id, spokenText);
    } finally {
      setTyping(false);
      busy.current = false;
    }
  };

  const mic = () => {
    if (listening) { rec.current?.stop(); return; }
    stopSpeaking();
    setSpeakingId(null);
    unlockSpeech();
    haptic();
    let last = '';
    setListening(true);
    rec.current = listen({
      lang,
      onText: (said, final) => { last = said; setText(said); if (final) { rec.current = null; send(said, { spoken: true }); } },
      onEnd: () => { setListening(false); rec.current = null; },
      onError: (code) => {
        if (code === 'no-speech' && !last) toast(t('voice.noSpeech'), 'info');
        else if (code === 'denied') toast(t('voice.denied'), 'info');
        else if (code === 'unavailable' || code === 'unsupported') toast(t('voice.unavailable'), 'info');
        else if (code !== 'aborted') toast(t('voice.error'), 'info');
      },
    });
  };
  const toggleVoice = () => {
    const on = !voiceOn;
    if (on) unlockSpeech(); else { stopSpeaking(); setSpeakingId(null); }
    updateSettings({ voiceReplies: on });
    toast(t(on ? 'voice.onToast' : 'voice.offToast'));
  };

  // Cards of one reply side by side: "Confirmar todos" after the last one when two or more still wait.
  const groups = new Map();
  let gid = 0;
  for (const m of messages) {
    if (!m.action) { gid++; continue; }
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid).push(m);
    m._g = gid;
  }

  return (
    <div className="page ai-screen">
      <div className={`ai-intro${chat.length ? ' talking' : ''}`}>
        <Wally mood={mood} size={chat.length ? 40 : 52} />
        <div>
          <h1>{t('ai.title')}</h1>
          <p>{t('ai.sub')}</p>
        </div>
        {canSpeak() && (
          <button className={`icon-btn voice-toggle ${voiceOn ? 'on' : ''}`} onClick={toggleVoice} aria-pressed={voiceOn} title={t('voice.replies')} aria-label={t('voice.replies')}>
            {voiceOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
        )}
        {chat.length > 0 && <button className="icon-btn" onClick={() => { stopSpeaking(); clearChat(); }} title={t('ai.clear')} aria-label={t('ai.clear')}><Eraser size={18} /></button>}
      </div>
      <AiBar compact={chat.length > 0} />
      <AlertsPanel go={go} compact={chat.length > 0} />
      <section className="chat">
        {messages.map((m) => {
          if (m.action) {
            const group = groups.get(m._g) || [];
            const open = group.filter((x) => (x.state === 'pending' || x.state === 'failed') && !actionExpired(x) && !busyIds.has(x.id));
            const last = group[group.length - 1] === m;
            return (
              <React.Fragment key={m.id}>
                <ActionCard msg={m} ctx={ctx} busy={busyIds.has(m.id)} onConfirm={confirm} onCancel={cancel} onUndo={undo} onEdit={edit} />
                {last && open.length > 1 && <button className="secondary small act-all" onClick={() => confirmAll(open)}><Check size={15} /> {t('act2.confirmAll', { n: open.length })}</button>}
              </React.Fragment>
            );
          }
          return (
            <div key={m.id} className={`msg ${m.from}${m.ai ? ' ai' : ''}${m.note ? ' note' : ''}`}>
              {m.ai && <span className="ai-tag"><Sparkles size={11} /> {t('aiw.badge')}</span>}
              {m.text}
              {m.from === 'bot' && !m.note && canSpeak() && (
                <button className={`msg-say ${speakingId === m.id ? 'on' : ''}`} onClick={() => toggleSay(m)} aria-label={speakingId === m.id ? t('voice.stop') : t('voice.listen')} title={speakingId === m.id ? t('voice.stop') : t('voice.listen')}>
                  {speakingId === m.id ? <Square size={12} /> : <Volume2 size={13} />}
                </button>
              )}
            </div>
          );
        })}
        {typing && (step
          ? <div className="msg bot typing-step"><Sparkles size={13} /> {step === 'loading' ? t('aiw.waking') : isActionTool(step) ? t('aiw.preparing') : t('aiw.looking', { w: t(`aiw.step.${step}`) })}</div>
          : <div className="msg bot typing"><i /><i /><i /></div>)}
        {!typing && chat.length === 0 && (
          <div className="prompt-grid">
            {advisorPrompts(lang).map((p) => <button key={p} onClick={() => send(p)}>{p}</button>)}
          </div>
        )}
        <div ref={endRef} />
      </section>
      <p className="privacy"><ShieldCheck size={13} /> {aiOn ? t('aiw.privacyOn') : t('ai.privacy')}</p>
      <form className={`chat-input ${listening ? 'listening' : ''}`} onSubmit={(e) => { e.preventDefault(); send(); }}>
        {micOk && (
          <button type="button" className={`chat-mic ${listening ? 'on' : ''}`} onClick={mic} aria-label={listening ? t('voice.stopListening') : t('voice.talk')} title={listening ? t('voice.stopListening') : t('voice.talk')}>
            <Mic size={18} />
          </button>
        )}
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={listening ? t('voice.listening') : t('ai.placeholder2')} enterKeyHint="send" maxLength={800} aria-label={t('ai.placeholder2')} />
        <button type="submit" aria-label={t('ai.send')}><Send size={18} /></button>
      </form>
    </div>
  );
}
