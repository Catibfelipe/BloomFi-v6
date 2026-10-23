import React, { useState } from 'react';
import { Plus, Target, Trash2, Pencil, PiggyBank, CalendarDays } from 'lucide-react';
import { useStore } from '../store.jsx';
import { ShareField, useDefaultSpace, SpaceTag } from '../components/Spaces.jsx';
import { Empty, PageHead } from '../components/Common.jsx';
import { Progress } from '../components/Charts.jsx';
import Modal, { Confirm } from '../components/Modal.jsx';
import { goalInfo } from '../lib/finance.js';
import { parseAmount, formatDate } from '../lib/format.js';
import { addMonths, currentMonth, sameDayIn, todayISO } from '../lib/dates.js';

const EMOJIS = ['🎯', '🛟', '🏝️', '💳', '🏠', '🚗', '🎓', '💍', '👶', '📱', '💻', '✈️', '🐶', '🎸', '🏥', '💰'];

export default function Goals() {
  const { goals, t, money, lang, deleteGoal, toast } = useStore();
  const [edit, setEdit] = useState(null);
  const [fund, setFund] = useState(null);
  const [del, setDel] = useState(null);
  const saved = goals.reduce((a, g) => a + g.current, 0);
  const total = goals.reduce((a, g) => a + g.target, 0);
  const sorted = [...goals].sort((a, b) => goalInfo(a).done - goalInfo(b).done || (a.deadline || '9').localeCompare(b.deadline || '9'));

  return (
    <div className="page">
      <PageHead title={t('goals.title')} sub={goals.length ? t('goals.sub', { s: money(saved), t: money(total) }) : t('goals.subEmpty')} />
      <button className="primary add-wide" onClick={() => setEdit({})}><Plus size={18} /> {t('goals.new')}</button>

      {goals.length ? (
        <div className="card-grid">
          {sorted.map((g) => {
            const gi = goalInfo(g);
            return (
              <section className={`goal ${gi.done ? 'done' : ''}`} key={g.id}>
                <div className="goal-top">
                  <b><span className="emoji">{g.emoji}</span>{g.title} <SpaceTag id={g.space} /></b>
                  <div className="row-actions">
                    <button onClick={() => setEdit(g)} aria-label={t('common.edit')}><Pencil size={15} /></button>
                    <button onClick={() => setDel(g)} aria-label={t('common.delete')}><Trash2 size={15} /></button>
                  </div>
                </div>
                <p>{money(g.current)} {t('common.of')} {money(g.target)}</p>
                <Progress pct={gi.pct} />
                <div className="goal-meta">
                  {gi.done ? <span className="positive">🎉 {t('goals.done')}</span>
                    : gi.daysLeft === null ? <span>{t('goals.noDeadline')}</span>
                    : gi.overdue ? <span className="neg-red">{t('goals.overdue')}</span>
                    : <span><CalendarDays size={12} /> {t('goals.daysLeft', { n: gi.daysLeft })} · {formatDate(g.deadline, lang, { month: 'short', year: 'numeric' })}</span>}
                  {!gi.done && gi.daysLeft > 0 && <span className="per-month">{t('goals.perMonth', { v: money(gi.perMonth) })}</span>}
                </div>
                <div className="goal-bottom">
                  <span>{Math.round(gi.pct)}%</span>
                  <button onClick={() => setFund(g)}><PiggyBank size={14} /> {t('goals.addFunds')}</button>
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <Empty icon={Target} text={t('goals.empty')} action={t('goals.first')} onAction={() => setEdit({})} />
      )}

      {edit && <GoalForm goal={edit} onClose={() => setEdit(null)} />}
      {fund && <FundsForm goal={fund} onClose={() => setFund(null)} />}
      {del && (
        <Confirm title={t('goals.deleteTitle')} text={t('goals.deleteText', { g: del.title })} danger
          confirmLabel={t('common.delete')} cancelLabel={t('common.cancel')} onClose={() => setDel(null)}
          onConfirm={() => { deleteGoal(del.id); toast(t('goals.deleted')); }} />
      )}
    </div>
  );
}

function GoalForm({ goal, onClose }) {
  const { t, lang, saveGoal, toast, myId } = useStore();
  const defSpace = useDefaultSpace();
  const [space, setSpace] = useState(goal.id ? goal.space || null : defSpace);
  // Only whoever shared it (or anyone, for their own goal) can take a shared goal back.
  const canMove = !goal.space || !goal.sharedBy || goal.sharedBy === myId;
  const [title, setTitle] = useState(goal.title || '');
  const [emoji, setEmoji] = useState(goal.emoji || '🎯');
  const [target, setTarget] = useState(goal.target ? String(goal.target) : '');
  const [current, setCurrent] = useState(goal.current ? String(goal.current) : '');
  const [deadline, setDeadline] = useState(goal.deadline ?? sameDayIn(todayISO(), addMonths(currentMonth(), 12)));
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    const tv = parseAmount(target, lang);
    const cv = current ? parseAmount(current, lang) : 0;
    if (!title.trim()) return setError(t('goals.errTitle'));
    if (!tv || tv <= 0) return setError(t('tx.errAmount'));
    if (Number.isNaN(cv) || cv < 0) return setError(t('tx.errAmount'));
    await saveGoal({ ...goal, title, emoji, target: tv, current: cv, deadline: deadline || null, space });
    toast(goal.id ? t('goals.updated') : t('goals.created'));
    onClose();
  };

  return (
    <Modal title={goal.id ? t('goals.edit') : t('goals.new')} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="emoji-row">
          {EMOJIS.map((e) => <button type="button" key={e} className={emoji === e ? 'on' : ''} onClick={() => setEmoji(e)}>{e}</button>)}
        </div>
        <label>{t('goals.name')}<input value={title} maxLength={40} placeholder={t('goals.namePh')} onChange={(e) => { setTitle(e.target.value); setError(''); }} /></label>
        <div className="form-2">
          <label>{t('goals.target')}<input className="amount" inputMode="decimal" placeholder="0,00" value={target} onChange={(e) => { setTarget(e.target.value); setError(''); }} /></label>
          <label>{t('goals.current')}<input inputMode="decimal" placeholder="0,00" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
        </div>
        <label>{t('goals.deadline')}<input type="date" value={deadline || ''} onChange={(e) => setDeadline(e.target.value)} /></label>
        <ShareField value={space} onChange={setSpace} disabled={!canMove} />
        {error && <p className="form-error">{error}</p>}
        <button className="primary full" type="submit">{t('common.save')}</button>
      </form>
    </Modal>
  );
}

function FundsForm({ goal, onClose }) {
  const { t, lang, money, addFunds, toast } = useStore();
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('add');
  const [record, setRecord] = useState(true);
  const [error, setError] = useState('');
  const gi = goalInfo(goal);

  const submit = async (e) => {
    e.preventDefault();
    const v = parseAmount(amount, lang);
    if (!v || v <= 0) return setError(t('tx.errAmount'));
    const updated = await addFunds(goal, mode === 'add' ? v : -Math.min(v, goal.current), { record });
    toast(goalInfo(updated).done && !gi.done ? `🎉 ${t('goals.reached')}` : t('goals.fundsSaved'));
    onClose();
  };

  return (
    <Modal title={`${goal.emoji} ${goal.title}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="segmented">
          <button type="button" className={mode === 'add' ? 'active inc' : ''} onClick={() => setMode('add')}>{t('goals.deposit')}</button>
          <button type="button" className={mode === 'remove' ? 'active exp' : ''} onClick={() => setMode('remove')}>{t('goals.withdraw')}</button>
        </div>
        <p className="hint">{t('goals.fundsInfo', { c: money(goal.current), r: money(gi.remaining) })}</p>
        <label>{t('tx.amount')}<input autoFocus className="amount" inputMode="decimal" placeholder="0,00" value={amount} onChange={(e) => { setAmount(e.target.value); setError(''); }} /></label>
        {mode === 'add' && gi.remaining > 0 && (
          <div className="chips quick-amounts">
            {[gi.perMonth, gi.remaining].filter((v, i, arr) => v > 0 && arr.indexOf(v) === i).map((v) => (
              <button type="button" key={v} onClick={() => setAmount(String(Math.round(v * 100) / 100).replace('.', lang === 'pt' ? ',' : '.'))}>{money(v)}</button>
            ))}
          </div>
        )}
        <button type="button" className={`toggle ${record ? 'on' : ''}`} onClick={() => setRecord(!record)} aria-pressed={record}>
          <span>{mode === 'add' ? t('goals.recordOut') : t('goals.recordIn')}<small>{mode === 'add' ? t('goals.recordOutHint') : t('goals.recordInHint')}</small></span><i />
        </button>
        {error && <p className="form-error">{error}</p>}
        <button className="primary full" type="submit">{t('common.confirm')}</button>
      </form>
    </Modal>
  );
}
