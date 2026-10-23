import React, { useMemo, useState } from 'react';
import { Plus, PieChart, Sparkles, Trash2, Pencil } from 'lucide-react';
import { useStore } from '../store.jsx';
import { ShareField, useDefaultSpace, SpaceTag } from '../components/Spaces.jsx';
import { MonthSwitcher, Empty, PageHead, CatIcon } from '../components/Common.jsx';
import { Progress } from '../components/Charts.jsx';
import Modal, { Confirm } from '../components/Modal.jsx';
import { budgetStatus, summarize } from '../lib/finance.js';
import { addMonths } from '../lib/dates.js';
import { categoriesFor } from '../lib/categories.js';
import { parseAmount, formatMonth } from '../lib/format.js';

export default function Budgets() {
  const { txs, budgets, month, t, money, lang, saveBudget, deleteBudget, toast } = useStore();
  const [edit, setEdit] = useState(null);
  const [del, setDel] = useState(null);
  const sum = useMemo(() => summarize(txs, month), [txs, month]);
  const bs = useMemo(() => budgetStatus(budgets, sum, txs), [budgets, sum, txs]);
  const totalLimit = bs.reduce((a, b) => a + b.limit, 0);
  const totalSpent = bs.reduce((a, b) => a + b.spent, 0);

  const suggest = async () => {
    const prev = summarize(txs, addMonths(month, -1));
    const base = prev.byCategory.length ? prev : sum;
    const picks = base.byCategory.filter((c) => !budgets.some((b) => b.category === c.key) && c.key !== 'housing').slice(0, 5);
    if (!picks.length) return toast(t('budget.noSuggest'), 'info');
    for (const c of picks) await saveBudget({ category: c.key, limit: Math.max(Math.round((c.amount * 0.9) / 10) * 10, 10) });
    toast(t('budget.suggested', { n: picks.length }));
  };

  return (
    <div className="page">
      <PageHead title={t('budget.title')} sub={t('budget.sub')}><MonthSwitcher /></PageHead>
      <div className="btn-row wrap">
        <button className="primary" onClick={() => setEdit({})}><Plus size={18} /> {t('budget.set')}</button>
        <button className="secondary" onClick={suggest}><Sparkles size={16} /> {t('budget.suggest')}</button>
      </div>

      {bs.length ? (
        <>
          <section className="budget-total">
            <div>
              <span>{t('budget.total', { m: formatMonth(month, lang) })}</span>
              <b>{money(totalSpent)} <small>/ {money(totalLimit)}</small></b>
            </div>
            <Progress pct={totalLimit ? (totalSpent / totalLimit) * 100 : 0} tone={totalSpent > totalLimit ? 'bad' : ''} />
            <p>{totalSpent <= totalLimit ? t('budget.leftTotal', { v: money(totalLimit - totalSpent) }) : t('budget.overTotal', { v: money(totalSpent - totalLimit) })}</p>
          </section>
          <div className="card-grid">
            {bs.map((b) => {
              const tone = b.pct > 100 ? 'bad' : b.pct >= 80 ? 'warn' : '';
              return (
                <section className={`budget ${tone}`} key={b.id}>
                  <div className="budget-top">
                    <CatIcon category={b.category} />
                    <b>{t(`cat.${b.category}`)} <SpaceTag id={b.space} /></b>
                    <div className="row-actions">
                      <button onClick={() => setEdit(b)} aria-label={t('common.edit')}><Pencil size={15} /></button>
                      <button onClick={() => setDel(b)} aria-label={t('common.delete')}><Trash2 size={15} /></button>
                    </div>
                  </div>
                  <p>{money(b.spent)} {t('common.of')} {money(b.limit)}</p>
                  <Progress pct={b.pct} tone={tone} />
                  <div className="goal-bottom">
                    <span>{Math.round(b.pct)}%</span>
                    <span>{b.left >= 0 ? t('budget.left', { v: money(b.left) }) : t('budget.over', { v: money(-b.left) })}</span>
                  </div>
                </section>
              );
            })}
          </div>
        </>
      ) : (
        <Empty icon={PieChart} text={t('budget.empty')} action={t('budget.first')} onAction={() => setEdit({})} />
      )}

      {edit && <BudgetForm budget={edit} onClose={() => setEdit(null)} />}
      {del && (
        <Confirm title={t('budget.deleteTitle')} text={t('budget.deleteText', { c: t(`cat.${del.category}`) })}
          confirmLabel={t('common.delete')} cancelLabel={t('common.cancel')} danger onClose={() => setDel(null)}
          onConfirm={() => { deleteBudget(del.id); toast(t('budget.deleted')); }} />
      )}
    </div>
  );
}

function BudgetForm({ budget, onClose }) {
  const { t, lang, saveBudget, toast, all, myId } = useStore();
  const defSpace = useDefaultSpace();
  const [space, setSpace] = useState(budget.id ? budget.space || null : defSpace);
  const [category, setCategory] = useState(budget.category || '');
  const [limit, setLimit] = useState(budget.limit ? String(budget.limit) : '');
  const [error, setError] = useState('');
  const canMove = !budget.space || !budget.sharedBy || budget.sharedBy === myId;
  // One budget per category on each side (the person's own, and each space).
  const used = new Set(all.budgets.filter((b) => b.id !== budget.id && (b.space || null) === (space || null)).map((b) => b.category));

  const submit = async (e) => {
    e.preventDefault();
    const v = parseAmount(limit, lang);
    if (!category) return setError(t('tx.errCategory'));
    if (!v || v <= 0) return setError(t('tx.errAmount'));
    await saveBudget({ id: budget.id, category, limit: v, space });
    toast(t('budget.saved'));
    onClose();
  };

  return (
    <Modal title={budget.id ? t('budget.edit') : t('budget.set')} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>{t('tx.category')}</label>
        <div className="cat-grid">
          {categoriesFor('expense').map((c) => {
            const Icon = c.icon;
            return (
              <button type="button" key={c.key} disabled={used.has(c.key)} className={category === c.key ? 'on' : ''} style={{ '--c': c.color }}
                onClick={() => { setCategory(c.key); setError(''); }}>
                <Icon size={18} /><span>{t(`cat.${c.key}`)}</span>
              </button>
            );
          })}
        </div>
        <label>{t('budget.limit')}
          <input className="amount" inputMode="decimal" placeholder="0,00" value={limit} onChange={(e) => { setLimit(e.target.value); setError(''); }} />
        </label>
        <p className="hint">{t('budget.hint')}</p>
        <ShareField value={space} onChange={setSpace} disabled={!canMove} />
        {error && <p className="form-error">{error}</p>}
        <button className="primary full" type="submit">{t('common.save')}</button>
      </form>
    </Modal>
  );
}
