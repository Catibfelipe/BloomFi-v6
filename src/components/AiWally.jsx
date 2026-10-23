import React, { useState } from 'react';
import { Sparkles, Lock, Smartphone, Download, WifiOff, X, ChevronRight, Info, Trash2 } from 'lucide-react';
import { useStore } from '../store.jsx';
import Modal from './Modal.jsx';
import { LOCAL_MODELS } from '../lib/localAi.js';

/** What the person sees when the AI didn't answer (the simple, on-device answer follows it). */
export function aiErrorNote(t, e) {
  if (e?.code === 'ai_memory' || e?.code === 'ai_device_lost') return t('aiw.memory');
  if (e?.code === 'ai_download') return t('aiw.downloadFailed');
  return t('aiw.error');
}

const gb = (n, lang) => n.toLocaleString(lang === 'en' ? 'en-US' : 'pt-BR', { maximumFractionDigits: 1 });

/** Turning the AI on = downloading it to this device: what it is, how big, and how to take it off. */
export function AiConsentModal({ onClose }) {
  const { t, lang, aiOn, aiLocal, settings, aiDownload, aiTurnOff, toast } = useStore();
  const support = aiLocal.support || {};
  const [key, setKey] = useState(settings.localAi?.model || support.recommended || 'light');
  const [busy, setBusy] = useState(false);
  const downloading = aiLocal.status === 'downloading';
  const start = async () => {
    setBusy(true);
    try {
      await aiDownload(key);
      toast(t('aiw.onToast'));
      onClose();
    } catch (e) {
      toast(aiErrorNote(t, e), 'err');
    } finally { setBusy(false); }
  };
  const off = async (remove) => {
    setBusy(true);
    try {
      await aiTurnOff({ remove });
      toast(t(remove ? 'aiw.removedToast' : 'aiw.offToast'));
      onClose();
    } finally { setBusy(false); }
  };
  const pct = Math.round((aiLocal.progress || 0) * 100);
  return (
    <Modal title={t('aiw.title')} onClose={onClose}>
      <p className="ai-consent-intro"><Sparkles size={16} /> {t('aiw.intro')}</p>
      <ul className="ai-how">
        <li><Smartphone size={16} /><span>{t('aiw.how1')}</span></li>
        <li><Lock size={16} /><span>{t('aiw.how2')}</span></li>
        <li><WifiOff size={16} /><span>{t('aiw.how3')}</span></li>
        <li><Download size={16} /><span>{t('aiw.how4')}</span></li>
      </ul>
      {!aiOn && !downloading && (
        <div className="ai-models" role="radiogroup" aria-label={t('aiw.pick')}>
          {['light', 'full'].map((k) => (
            <label key={k} className={`ai-model ${key === k ? 'on' : ''}`}>
              <input type="radio" name="ai-model" checked={key === k} onChange={() => setKey(k)} />
              <span>
                <b>{t(`aiw.model.${k}`)}{support.recommended === k ? ` · ${t('aiw.recommended')}` : ''}</b>
                <small>{t(`aiw.model.${k}.text`, { gb: gb(LOCAL_MODELS[k].gb, lang) })}</small>
              </span>
            </label>
          ))}
        </div>
      )}
      {downloading && (
        <div className="ai-progress" aria-live="polite">
          <div className="ai-bar"><i style={{ width: `${pct}%` }} /></div>
          <p className="hint">{t('aiw.downloading', { pct })}</p>
        </div>
      )}
      <p className="hint">{t('aiw.limit')}</p>
      <div className="btn-col">
        {aiOn ? (
          <>
            <button className="secondary" disabled={busy} onClick={() => off(false)}>{t('aiw.off')}</button>
            <button className="danger-btn" disabled={busy} onClick={() => off(true)}><Trash2 size={15} /> {t('aiw.remove')}</button>
          </>
        ) : (
          <button className="primary" disabled={busy || downloading} onClick={start}>
            <Download size={16} /> {downloading ? t('aiw.downloadingShort', { pct }) : t('aiw.on', { gb: gb(LOCAL_MODELS[key].gb, lang) })}
          </button>
        )}
        <button className="ghost" onClick={onClose}>{aiOn || downloading ? t('common.close') : t('aiw.notNow')}</button>
      </div>
    </Modal>
  );
}

/** On Wally's screen: the invitation (AI off) or the "AI on this device" line. */
export function AiBar({ compact = false }) {
  const { t, aiAvailable, aiOn, aiLocal, settings, updateSettings } = useStore();
  const [open, setOpen] = useState(false);
  if (!aiAvailable) return null;
  if (!aiOn) {
    if (aiLocal.status === 'downloading') {
      return (
        <div className="ai-promo-line">
          <button className="ai-promo-open" onClick={() => setOpen(true)}><Download size={15} /> <span>{t('aiw.downloadingShort', { pct: Math.round((aiLocal.progress || 0) * 100) })}</span></button>
          {open && <AiConsentModal onClose={() => setOpen(false)} />}
        </div>
      );
    }
    if (settings.dismissed?.aiPromo) return null;
    if (compact) {
      return (
        <div className="ai-promo-line">
          <button className="ai-promo-open" onClick={() => setOpen(true)}><Sparkles size={15} /> <span>{t('aiw.promoLine')}</span> <ChevronRight size={15} /></button>
          {open && <AiConsentModal onClose={() => setOpen(false)} />}
        </div>
      );
    }
    return (
      <section className="ai-promo">
        <Sparkles size={20} className="spark" />
        <div>
          <b>{t('aiw.promoTitle')}</b>
          <p>{t('aiw.promoText')}</p>
          <button className="secondary small" onClick={() => setOpen(true)}>{t('aiw.promoBtn')} <ChevronRight size={15} /></button>
        </div>
        <button className="icon-btn ai-promo-x" aria-label={t('common.close')} onClick={() => updateSettings({ dismissed: { ...(settings.dismissed || {}), aiPromo: true } })}><X size={16} /></button>
        {open && <AiConsentModal onClose={() => setOpen(false)} />}
      </section>
    );
  }
  return (
    <div className="ai-on-bar">
      <span className="ai-pill"><Sparkles size={13} /> {t('aiw.statusOn')}</span>
      <span className="muted ai-left">{t(`aiw.model.${settings.localAi?.model === 'full' ? 'full' : 'light'}`)}</span>
      <button className="icon-btn small" onClick={() => setOpen(true)} aria-label={t('aiw.howBtn')} title={t('aiw.howBtn')}><Info size={16} /></button>
      {open && <AiConsentModal onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Settings: the same switch, for people who look for it there. */
export function AiSettingsPanel() {
  const { t, aiAvailable, aiOn, aiLocal, settings } = useStore();
  const [open, setOpen] = useState(false);
  if (!aiAvailable) {
    if (!aiLocal.support || aiLocal.support.reason === 'artifact') return null;
    return (
      <section className="panel">
        <h3><Sparkles size={17} /> {t('aiw.promoTitle')}</h3>
        <p className="muted">{t('aiw.unsupported')}</p>
      </section>
    );
  }
  return (
    <section className="panel">
      <h3><Sparkles size={17} /> {t('aiw.promoTitle')}</h3>
      <p className="muted">{t('aiw.setText')}</p>
      <button className="secondary full" onClick={() => setOpen(true)}>
        <Sparkles size={16} /> {aiOn ? t('aiw.setOn', { model: t(`aiw.model.${settings.localAi?.model === 'full' ? 'full' : 'light'}`) }) : t('aiw.setOff')} <ChevronRight size={16} />
      </button>
      {open && <AiConsentModal onClose={() => setOpen(false)} />}
    </section>
  );
}
