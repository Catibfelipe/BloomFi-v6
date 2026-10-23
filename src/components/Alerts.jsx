import React, { useMemo, useState } from 'react';
import {
  BellRing, TriangleAlert, Info, X, Plus, Trash2, Settings2, ChevronRight, ChevronDown, Zap, CheckCheck,
} from 'lucide-react';
import { useStore } from '../store.jsx';
import Modal from './Modal.jsx';
import { Progress } from './Charts.jsx';
import { alertText, ruleLabel } from '../lib/alertText.js';
import { ruleProgress, BUILTIN } from '../lib/alerts.js';
import { categoriesFor } from '../lib/categories.js';
import { parseAmount } from '../lib/format.js';

const ICON = { bad: TriangleAlert, warn: BellRing, info: Info };

/** Opens what an alert is about. */
export function useAlertGo(go) {
  return (a) => {
    if (a.go?.page === 'home' && a.go.id === 'forecast') { go('home'); setTimeout(() => document.getElementById('forecast')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 250); return; }
    if (a.go?.page) go(a.go.page);
  };
}

/** Wally's alerts, most important first. */
export function AlertList({ go, limit = 0 }) {
  const { alerts, dismissAlerts, t, money, lang } = useStore();
  const open = useAlertGo(go);
  const list = limit ? alerts.slice(0, limit) : alerts;
  if (!alerts.length) return <p className="alerts-empty"><CheckCheck size={16} /> {t('alert.none')}</p>;
  return (
    <div className="alerts">
      {list.map((a) => {
        const Icon = ICON[a.level] || Info;
        const x = alertText(t, money, a, lang);
        return (
          <div key={a.key} className={`alert-row ${a.level}`}>
            <span className="alert-ic"><Icon size={17} /></span>
            <button className="alert-main" onClick={() => open(a)}>
              <b>{x.title}</b>
              <span>{x.text}</span>
            </button>
            <button className="alert-x" onClick={() => dismissAlerts([a.key])} aria-label={t('common.dismiss')} title={t('common.dismiss')}><X size={15} /></button>
          </div>
        );
      })}
      {!limit && alerts.length > 1 && <button className="link-btn alerts-all" onClick={() => dismissAlerts(alerts.map((a) => a.key))}>{t('alert.dismissAll')}</button>}
    </div>
  );
}

/** What Wally watches: the built-in watchers, the person's own rules and the instant alert from the phone. */
export function AlertSettings({ onClose }) {
  const {
    t, money, lang, alertCfg, alertRules, setAlertCfg, saveAlertRule, deleteAlertRule, txs, serverMode, session, setPushPrefs, toast, settings,
  } = useStore();
  const [edit, setEdit] = useState(null);
  const [big, setBig] = useState(session.user?.prefs?.bigPurchase ? String(session.user.prefs.bigPurchase) : '');
  const progress = useMemo(() => Object.fromEntries(alertRules.map((r) => [r.id, ruleProgress(r, txs)])), [alertRules, txs]);
  const saveBig = async () => {
    const v = big.trim() ? parseAmount(big, lang) : 0;
    if (Number.isNaN(v) || v < 0) return toast(t('tx.errAmount'), 'err');
    try { await setPushPrefs({ bigPurchase: Math.round(v * 100) / 100, currency: settings.currency }); toast(v ? t('alert.bigSaved', { v: money(v) }) : t('alert.bigOff')); } catch { toast(t('of.err.generic'), 'err'); }
  };
  return (
    <Modal title={t('alert.settings')} onClose={onClose}>
      <p className="muted">{t('alert.settingsText')}</p>
      <h3 className="sub-title">{t('alert.builtin')}</h3>
      {BUILTIN.map((k) => (
        <button key={k} type="button" className={`toggle ${!alertCfg.off?.[k] ? 'on' : ''}`} aria-pressed={!alertCfg.off?.[k]}
          onClick={() => setAlertCfg({ off: { [k]: !alertCfg.off?.[k] } })}>
          <span>{t(`alert.b.${k}`)}<small>{t(`alert.b.${k}.d`)}</small></span><i />
        </button>
      ))}
      {!alertCfg.off?.cardLimit && (
        <label className="inline-label">{t('alert.cardPct')}
          <select value={alertCfg.cardPct || 80} onChange={(e) => setAlertCfg({ cardPct: Number(e.target.value) })}>
            {[70, 80, 90, 95].map((p) => <option key={p} value={p}>{p}%</option>)}
          </select>
        </label>
      )}

      <h3 className="sub-title">{t('alert.mine')}</h3>
      {alertRules.length === 0 && <p className="muted">{t('alert.mineNone')}</p>}
      {alertRules.map((r) => {
        const p = progress[r.id];
        return (
          <div className="rule-row" key={r.id}>
            <button className="rule-main" onClick={() => setEdit(r)}>
              <b>{t(r.period === 'purchase' ? 'alert.rule.purchase' : 'alert.rule.month', { w: ruleLabel(t, r), v: money(r.limit) })}</b>
              {r.period !== 'purchase' && <><Progress pct={p?.pct || 0} tone={p?.over ? 'bad' : (p?.pct || 0) >= 80 ? 'warn' : ''} /><small>{t('alert.rule.progress', { v: money(p?.spent || 0), l: money(r.limit) })}</small></>}
            </button>
            <button className={`mini-switch ${r.on !== false ? 'on' : ''}`} aria-pressed={r.on !== false} aria-label={t('alert.rule.onoff')} onClick={() => saveAlertRule({ ...r, on: r.on === false })}><i /></button>
          </div>
        );
      })}
      <button className="secondary full" onClick={() => setEdit({})}><Plus size={16} /> {t('alert.newRule')}</button>

      {serverMode && (
        <>
          <h3 className="sub-title"><Zap size={15} /> {t('alert.instant')}</h3>
          <p className="hint">{t('alert.instantText')}</p>
          <div className="inline-input">
            <input inputMode="decimal" placeholder={t('alert.instantPh')} value={big} onChange={(e) => setBig(e.target.value)} />
            <button type="button" className="secondary" onClick={saveBig}>{t('common.save')}</button>
          </div>
          {!settings.reminders?.enabled && <p className="hint">{t('alert.needsPush')}</p>}
        </>
      )}
      {edit && <RuleForm rule={edit} onClose={() => setEdit(null)} onDelete={edit.id ? async () => { await deleteAlertRule(edit.id); setEdit(null); } : null} onSave={async (r) => { await saveAlertRule(r); setEdit(null); }} />}
    </Modal>
  );
}

function RuleForm({ rule, onClose, onSave, onDelete }) {
  const { t, lang } = useStore();
  const [what, setWhat] = useState(rule.what || 'category');
  const [category, setCategory] = useState(rule.category || 'food');
  const [text, setText] = useState(rule.text || '');
  const [period, setPeriod] = useState(rule.period || 'month');
  const [limit, setLimit] = useState(rule.limit ? String(rule.limit).replace('.', lang === 'pt' ? ',' : '.') : '');
  const [error, setError] = useState('');
  const submit = (e) => {
    e.preventDefault();
    const v = parseAmount(limit, lang);
    if (!v || Number.isNaN(v) || v <= 0) return setError(t('tx.errAmount'));
    if (what === 'merchant' && text.trim().length < 2) return setError(t('alert.errText'));
    onSave({ ...rule, what, category, text: text.trim(), period, limit: v });
  };
  return (
    <Modal title={rule.id ? t('alert.editRule') : t('alert.newRule')} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <span className="field-title">{t('alert.when')}</span>
        <div className="chips">
          {['category', 'merchant', 'any'].map((w) => <button type="button" key={w} className={what === w ? 'on' : ''} onClick={() => setWhat(w)}>{t(`alert.what.${w}`)}</button>)}
        </div>
        {what === 'category' && (
          <label>{t('tx.category')}
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {categoriesFor('expense').map((c) => <option key={c.key} value={c.key}>{t(`cat.${c.key}`)}</option>)}
            </select>
          </label>
        )}
        {what === 'merchant' && <label>{t('alert.textLabel')}<input value={text} maxLength={40} placeholder={t('alert.textPh')} onChange={(e) => setText(e.target.value)} /></label>}
        <span className="field-title">{t('alert.period')}</span>
        <div className="chips">
          {['month', 'purchase'].map((p) => <button type="button" key={p} className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>{t(`alert.period.${p}`)}</button>)}
        </div>
        <label>{t(period === 'purchase' ? 'alert.limitPurchase' : 'alert.limitMonth')}
          <input className="amount" inputMode="decimal" placeholder="0,00" value={limit} onChange={(e) => { setLimit(e.target.value); setError(''); }} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="btn-row">
          {onDelete && <button type="button" className="icon-danger" onClick={onDelete} aria-label={t('common.delete')}><Trash2 size={18} /></button>}
          <button className="primary">{t('common.save')}</button>
        </div>
      </form>
    </Modal>
  );
}

/** The alerts block on Wally's page. */
export function AlertsPanel({ go, compact = false }) {
  const { alerts, t } = useStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(false);
  // In a conversation with Wally: one line, so the chat keeps the room (tap to see them).
  if (compact && !open) {
    const top = alerts[0];
    return (
      <button className={`alerts-line ${top ? top.level || '' : 'calm'}`} onClick={() => setOpen(true)} aria-expanded="false">
        <BellRing size={15} />
        <span>{t('alert.title')}{alerts.length > 0 ? '' : ` · ${t('alert.calm')}`}</span>
        {alerts.length > 0 && <em className="count inline">{alerts.length}</em>}
        <ChevronDown size={15} />
      </button>
    );
  }
  return (
    <section className="panel alerts-panel">
      <div className="panel-head">
        <h2><BellRing size={16} /> {t('alert.title')}{alerts.length > 0 && <em className="count inline">{alerts.length}</em>}</h2>
        <button onClick={() => setSettingsOpen(true)}><Settings2 size={14} /> {t('alert.configure')}</button>
      </div>
      <AlertList go={go} limit={all ? 0 : 3} />
      {!all && alerts.length > 3 && <button className="link-btn alerts-all" onClick={() => setAll(true)}>{t('alert.more', { n: alerts.length - 3 })}</button>}
      {settingsOpen && <AlertSettings onClose={() => setSettingsOpen(false)} />}
    </section>
  );
}

/** One line on the dashboard: the most important alert. */
export function TopAlert({ go }) {
  const { alerts, t, money, lang } = useStore();
  const open = useAlertGo(go);
  if (!alerts.length) return null;
  const a = alerts[0];
  const x = alertText(t, money, a, lang);
  const Icon = ICON[a.level] || Info;
  return (
    <button className={`top-alert ${a.level}`} onClick={() => open(a)}>
      <Icon size={18} />
      <span><b>{x.title}</b><small>{x.text}</small></span>
      {alerts.length > 1 ? <em>+{alerts.length - 1}</em> : <ChevronRight size={16} />}
    </button>
  );
}
