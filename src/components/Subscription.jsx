import React, { useState } from 'react';
import {
  Crown, Check, KeyRound, Download, RefreshCw, ExternalLink, Clock, LogOut, Sparkles, ShieldCheck, Landmark, ArrowUpDown,
} from 'lucide-react';
import { useStore } from '../store.jsx';
import Wally from './Wally.jsx';
import Modal, { Confirm } from './Modal.jsx';
import { priceLabel, planList, planOf } from '../lib/billing.js';
import { SupportLine } from './Support.jsx';
import { download } from '../lib/pwa.js';
import { todayISO } from '../lib/dates.js';
import { formatDate } from '../lib/format.js';

const errText = (t, e) => (t(`bill.err.${e?.code}`) !== `bill.err.${e?.code}` ? t(`bill.err.${e?.code}`) : t('bill.err.generic'));

/** "Plus", "Premium"… (the plans are named by how many banks they connect). */
export const planName = (t, id) => (t(`plan.${id}`) !== `plan.${id}` ? t(`plan.${id}`) : String(id || ''));
export const banksText = (t, n) => (n > 0 ? t('plan.upToBanks', { n }) : t('plan.noBanks'));
/** The plan the person pays for in Stripe now (not a gift or free access), if any. */
export const paidPlan = (e) => (e.status === 'active' && ['active', 'trialing', 'past_due'].includes(e.kind) ? e.plan || 'essencial' : null);
const PERKS = ['bill.perk2', 'bill.perk3', 'bill.perk4', 'bill.perk5'];

/**
 * Stripe Checkout for the signed-in account (its e-mail goes along). Three plans, by how many banks connect.
 * During the free trial the first charge is when it ends; banks come with that first charge, or today if the
 * person chooses to pay now.
 */
export function SubscribeModal({ onClose, plan: wanted }) {
  const { t, startCheckout, entitlement, serverCfg, lang, session, vaultInfo } = useStore();
  const plans = planList(serverCfg);
  const current = paidPlan(entitlement);
  const [plan, setPlan] = useState(() => (planOf(serverCfg, wanted) ? wanted : (plans.find((p) => p.banks > 0 && p.id !== current) || plans[0])?.id));
  const [now, setNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sel = planOf(serverCfg, plan) || plans[0];
  const inTrial = entitlement.status === 'trial';
  const same = current === sel?.id;
  const go = async () => {
    setBusy(true); setError('');
    try { await startCheckout(sel.id, { startNow: inTrial && sel.banks > 0 && now }); } catch (er) { setError(errText(t, er)); setBusy(false); }
  };
  return (
    <Modal title={t(current ? 'plan.changeTitle' : 'bill.subscribeTitle')} onClose={onClose}>
      <div className="form">
        <div className="plan-pick rows" role="radiogroup" aria-label={t('plan.pick')}>
          {plans.map((p) => (
            <button key={p.id} type="button" role="radio" className={plan === p.id ? 'on' : ''} aria-checked={plan === p.id} onClick={() => setPlan(p.id)}>
              <span className="pp-main">
                <b>{planName(t, p.id)}{current === p.id && <em className="pill-on">{t('plan.current')}</em>}</b>
                <small>{banksText(t, p.banks)}</small>
              </span>
              <span className="pp-price">{priceLabel(serverCfg, lang, p.id)}<small>/{t('bill.month')}</small></span>
            </button>
          ))}
        </div>
        <ul className="perks">
          <li><Check size={16} /> {sel?.banks > 0 ? t('plan.perkBanks', { n: sel.banks }) : t('plan.perkNoBanks')}</li>
          {PERKS.map((p) => <li key={p}><Check size={16} /> {t(p)}</li>)}
        </ul>
        {inTrial && <p className="hint center">{t('bill.keepTrial', { n: entitlement.daysLeft })}</p>}
        {inTrial && sel?.banks > 0 && (
          <label className="check-line">
            <input type="checkbox" checked={now} onChange={(ev) => setNow(ev.target.checked)} />
            <span>{t('plan.startNow')}<br /><small className="muted">{t('plan.startNowHint')}</small></span>
          </label>
        )}
        {current && !same && <p className="hint center">{t(entitlement.kind === 'trialing' ? 'plan.switchNoteTrial' : 'plan.switchNote')}</p>}
        <p className="hint center">{t('bill.accountMail', { e: session.user?.email || vaultInfo.email || '' })}</p>
        {error && <p className="form-error">{error}</p>}
        <button className="primary full" disabled={busy || same} onClick={go}>
          {busy ? <><span className="spinner" /> {t('bill.opening')}</> : same ? t('plan.current') : <><Crown size={18} /> {t(current ? 'plan.changeTo' : 'plan.subscribeTo', { p: planName(t, sel?.id) })}</>}
        </button>
        <p className="hint center"><ShieldCheck size={14} /> {t('bill.stripeNote')}</p>
      </div>
    </Modal>
  );
}

export function AccessCodeModal({ onClose }) {
  const { t, redeemAccessCode, toast } = useStore();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await redeemAccessCode(code); toast(t('bill.codeOk')); onClose(); } catch (er) { setError(er.code === 'invalid_code' ? t('bill.codeBad') : errText(t, er)); }
    setBusy(false);
  };
  return (
    <Modal title={t('bill.accessCode')} onClose={onClose}>
      <form className="form" onSubmit={go}>
        <p className="hint">{t('bill.accessHint')}</p>
        <textarea id="bf-access-code" className="textbox short" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="eyJ…" />
        {error && <p className="form-error">{error}</p>}
        <button className="primary full" disabled={busy || code.trim().length < 20}><KeyRound size={17} /> {t('bill.activate')}</button>
      </form>
    </Modal>
  );
}

/** Full screen shown when the trial or subscription has ended. Backup always works. */
export function Paywall() {
  const { t, entitlement, serverCfg, lang, exportBackup, updateSettings, toast, refreshLicense, logout, session, vaultInfo } = useStore();
  const [modal, setModal] = useState(null);
  const [checking, setChecking] = useState(false);
  const backup = async () => {
    const data = await exportBackup();
    download(`bloomfi-backup-${todayISO()}.json`, JSON.stringify(data, null, 2));
    await updateSettings({ lastBackup: todayISO() });
    toast(t('set.backupDone'));
  };
  const recheck = async () => {
    setChecking(true);
    const r = await refreshLicense({ force: true });
    setChecking(false);
    if (!r?.license) toast(t('bill.stillExpired'), 'info');
  };
  const perks = ['plan.perkAny', 'bill.perk2', 'bill.perk3', 'bill.perk4', 'bill.perk5'];
  return (
    <div className="paywall">
      <div className="paywall-card">
        <Wally mood="sleep" size={72} />
        <h1>{entitlement.hadLicense ? t('bill.expiredTitle') : t('bill.trialOverTitle')}</h1>
        <p className="sub">{t('bill.expiredSub')}</p>
        <ul className="perks">{perks.map((p) => <li key={p}><Check size={16} /> {t(p)}</li>)}</ul>
        <p className="price-from">{t('bill.from')}</p>
        <p className="price-big">{priceLabel(serverCfg, lang)}<small>/{t('bill.month')}</small></p>
        <button className="primary full" onClick={() => setModal('subscribe')}><Crown size={18} /> {entitlement.hadLicense ? t('bill.renew') : t('bill.subscribe')}</button>
        <div className="paywall-links">
          <button className="secondary" onClick={() => setModal('code')}><KeyRound size={16} /> {t('bill.accessCode')}</button>
          <button className="secondary" onClick={recheck} disabled={checking}><RefreshCw size={16} className={checking ? 'spin' : ''} /> {t('bill.recheck')}</button>
        </div>
        <div className="paywall-data">
          <p>{t('bill.dataSafe')}</p>
          <button className="ghost" onClick={backup}><Download size={16} /> {t('set.backup')}</button>
        </div>
        <p className="hint center">{t('bill.signedAs', { e: session.user?.email || vaultInfo.email || '' })}</p>
        <button className="link-btn" onClick={() => setModal('logout')}><LogOut size={13} /> {t('acct.logout')}</button>
        <SupportLine />
        <p className="legal-links"><a href="/termos.html" target="_blank" rel="noopener">{t('legal.terms')}</a> · <a href="/privacidade.html" target="_blank" rel="noopener">{t('legal.privacy')}</a></p>
      </div>
      {modal === 'subscribe' && <SubscribeModal onClose={() => setModal(null)} />}
      {modal === 'code' && <AccessCodeModal onClose={() => setModal(null)} />}
      {modal === 'logout' && (
        <Confirm title={t('acct.logoutTitle')} text={t('acct.logoutText')} confirmLabel={t('acct.logout')} cancelLabel={t('common.cancel')}
          onClose={() => setModal(null)} onConfirm={() => logout({ force: true })} />
      )}
    </div>
  );
}

export function TrialBanner() {
  const { t, entitlement, serverCfg, lang } = useStore();
  const [open, setOpen] = useState(false);
  if (entitlement.status !== 'trial') return null;
  return (
    <>
      <button className={`trial-banner ${entitlement.daysLeft <= 2 ? 'urgent' : ''}`} onClick={() => setOpen(true)}>
        <Clock size={16} />
        <span>{t('bill.trialLeft', { n: entitlement.daysLeft })}</span>
        <b>{t('bill.subscribeFor', { p: priceLabel(serverCfg, lang) })}</b>
      </button>
      {open && <SubscribeModal onClose={() => setOpen(false)} />}
    </>
  );
}

export function SubscriptionPanel() {
  const { t, entitlement, serverCfg, lang, openPortal, refreshLicense, toast, licensePayload, startPlanNow } = useStore();
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!serverCfg?.billing?.enabled) return null;
  const e = entitlement;
  const portal = async () => { setBusy(true); try { await openPortal(); } catch (er) { toast(errText(t, er), 'err'); setBusy(false); } };
  const recheck = async () => { setBusy(true); const r = await refreshLicense({ force: true }); setBusy(false); toast(r?.license ? t('bill.updated') : t('bill.checkFailed'), r?.license ? 'ok' : 'info'); };
  const payNow = async () => { setBusy(true); try { await startPlanNow(); toast(t('plan.paidNow')); } catch (er) { toast(errText(t, er), 'err'); } setBusy(false); };
  const day = (ms) => formatDate(new Date(ms).toISOString().slice(0, 10), lang);
  const paid = paidPlan(e);
  const plan = e.status === 'active' ? planOf(serverCfg, e.plan || 'essencial') : null;
  const banks = e.status !== 'active' ? 0 : paid ? plan?.banks ?? 0 : e.banks ?? plan?.banks ?? 0;
  return (
    <section className="panel sub-panel">
      <h3><Crown size={17} /> {t('bill.title')}</h3>
      {e.status === 'active' && (
        <>
          <p className="sub-status ok"><Sparkles size={15} /> {e.kind === 'free' || e.kind === 'gift' ? t('bill.giftActive') : e.kind === 'trialing' ? t('bill.activeTrial') : e.kind === 'past_due' ? t('bill.pastDue') : t('bill.active')}</p>
          {plan && <p className="plan-line"><b>{t('plan.line', { p: planName(t, plan.id) })}</b> · {banksText(t, banks)}</p>}
          <p className="muted">{e.renews ? t('bill.renewsOn', { d: day(e.periodEnd) }) : t('bill.endsOn', { d: day(e.periodEnd) })}</p>
          {e.kind === 'trialing' && banks > 0 && (
            <div className="sub-note"><Clock size={15} /><span>{t('plan.firstPayment', { d: day(e.periodEnd) })}</span></div>
          )}
          {e.kind === 'past_due' && banks > 0 && <div className="sub-note"><Clock size={15} /><span>{t('plan.pastDueBanks')}</span></div>}
          <div className="btn-row wrap">
            {e.kind === 'trialing' && banks > 0 && <button className="primary" onClick={payNow} disabled={busy}><Landmark size={16} /> {t('plan.payNow')}</button>}
            {(paid || e.kind === 'gift') && <button className="secondary" onClick={() => setModal('subscribe')} disabled={busy}><ArrowUpDown size={16} /> {t(paid ? 'plan.change' : 'plan.seePlans')}</button>}
            {paid && <button className="secondary" onClick={portal} disabled={busy}><ExternalLink size={16} /> {t('bill.manage')}</button>}
            <button className="ghost" onClick={recheck} disabled={busy}><RefreshCw size={15} /> {t('bill.recheck')}</button>
          </div>
        </>
      )}
      {e.status === 'trial' && (
        <>
          <p className="sub-status">{t('bill.trialLeft', { n: e.daysLeft })}</p>
          <p className="muted">{t('bill.trialText', { p: priceLabel(serverCfg, lang) })}</p>
          <button className="primary" onClick={() => setModal('subscribe')}><Crown size={17} /> {t('bill.subscribe')}</button>
          <div className="btn-row wrap">
            <button className="ghost" onClick={() => setModal('code')}><KeyRound size={15} /> {t('bill.accessCode')}</button>
            <button className="ghost" onClick={recheck} disabled={busy}><RefreshCw size={15} /> {t('bill.recheck')}</button>
          </div>
        </>
      )}
      {e.status === 'checking' && !licensePayload && <p className="muted"><span className="spinner" /> {t('bill.checking')}</p>}
      <p className="legal-links left"><a href="/termos.html" target="_blank" rel="noopener">{t('legal.terms')}</a> · <a href="/privacidade.html" target="_blank" rel="noopener">{t('legal.privacy')}</a></p>
      {modal === 'subscribe' && <SubscribeModal onClose={() => setModal(null)} />}
      {modal === 'code' && <AccessCodeModal onClose={() => setModal(null)} />}
    </section>
  );
}
