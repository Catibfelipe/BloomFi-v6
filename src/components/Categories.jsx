import React, { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import Modal, { Confirm } from './Modal.jsx';
import { useStore } from '../store.jsx';
import { CUSTOM_ICONS, CUSTOM_COLORS, getCategory } from '../lib/categories.js';
import { CatIcon } from './Common.jsx';

/** Create or edit one of the user's own categories. */
export function CategoryForm({ cat, type = 'expense', onClose, onSaved }) {
  const { t, saveCategory, toast } = useStore();
  const [name, setName] = useState(cat?.name || '');
  const [kind, setKind] = useState(cat?.type || type);
  const [icon, setIcon] = useState(cat?.icon || 'tag');
  const [color, setColor] = useState(cat?.color || CUSTOM_COLORS[0]);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError(t('cats.errName'));
    const saved = await saveCategory({ ...cat, name, type: kind, icon, color });
    toast(cat ? t('cats.saved') : t('cats.created'));
    onSaved?.(saved);
    onClose();
  };
  const Preview = CUSTOM_ICONS[icon];
  return (
    <Modal title={cat ? t('cats.edit') : t('cats.new')} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {!cat && (
          <div className="segmented">
            <button type="button" className={kind === 'expense' ? 'active exp' : ''} onClick={() => setKind('expense')}>{t('tx.expense')}</button>
            <button type="button" className={kind === 'income' ? 'active inc' : ''} onClick={() => setKind('income')}>{t('tx.income')}</button>
          </div>
        )}
        <label>{t('cats.name')}
          <div className="cat-name-row">
            <span className="cat-icon" style={{ '--c': color }}><Preview size={20} /></span>
            <input autoFocus value={name} maxLength={30} placeholder={t('cats.namePh')} onChange={(e) => { setName(e.target.value); setError(''); }} />
          </div>
        </label>
        <span className="field-title">{t('cats.icon')}</span>
        <div className="icon-grid" role="radiogroup" aria-label={t('cats.icon')}>
          {Object.entries(CUSTOM_ICONS).map(([k, Icon]) => (
            <button type="button" key={k} role="radio" aria-checked={icon === k} aria-label={k} className={icon === k ? 'on' : ''} style={{ '--c': color }} onClick={() => setIcon(k)}>
              <Icon size={18} />
            </button>
          ))}
        </div>
        <span className="field-title">{t('acc.color')}</span>
        <div className="color-row" role="radiogroup" aria-label={t('acc.color')}>
          {CUSTOM_COLORS.map((c) => (
            <button type="button" key={c} role="radio" aria-checked={color === c} aria-label={c} className={color === c ? 'on' : ''} style={{ '--c': c }} onClick={() => setColor(c)} />
          ))}
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary full" type="submit">{cat ? t('common.save') : t('cats.create')}</button>
      </form>
    </Modal>
  );
}

/** Settings → Categories: the user's own categories, by type. */
export function CategoryManager({ onClose }) {
  const { t, categories, txs, deleteCategory, toast } = useStore();
  const [kind, setKind] = useState('expense');
  const [edit, setEdit] = useState(null);
  const [del, setDel] = useState(null);
  const list = categories.filter((c) => c.type === kind && !c.archived).sort((a, b) => a.name.localeCompare(b.name));
  if (edit) return <CategoryForm cat={edit.id ? edit : null} type={kind} onClose={() => setEdit(null)} />;
  return (
    <Modal title={t('cats.title')} onClose={onClose}>
      <div className="segmented">
        <button type="button" className={kind === 'expense' ? 'active exp' : ''} onClick={() => setKind('expense')}>{t('tx.expense')}</button>
        <button type="button" className={kind === 'income' ? 'active inc' : ''} onClick={() => setKind('income')}>{t('tx.income')}</button>
      </div>
      <p className="hint">{t('cats.hint')}</p>
      {list.length ? (
        <ul className="cat-list">
          {list.map((c) => (
            <li key={c.id}>
              <CatIcon category={c.key} size={18} />
              <span><b>{c.name}</b><small>{t('cats.uses', { n: txs.filter((x) => x.category === c.key).length })}</small></span>
              <button className="icon-btn sm" onClick={() => setEdit(c)} aria-label={t('common.edit')}><Pencil size={15} /></button>
              <button className="icon-btn sm" onClick={() => setDel(c)} aria-label={t('common.delete')}><Trash2 size={15} /></button>
            </li>
          ))}
        </ul>
      ) : <p className="muted center">{t('cats.none')}</p>}
      <button className="primary full" onClick={() => setEdit({})}><Plus size={17} /> {t('cats.new')}</button>
      {del && (
        <Confirm title={t('cats.deleteTitle', { c: del.name })} text={t('cats.deleteText', { c: t(`cat.${getCategory(del.type === 'income' ? 'other_income' : 'other').key}`) })}
          confirmLabel={t('common.delete')} cancelLabel={t('common.cancel')} danger onClose={() => setDel(null)}
          onConfirm={async () => { const n = await deleteCategory(del); toast(t('cats.deleted', { n })); }} />
      )}
    </Modal>
  );
}
