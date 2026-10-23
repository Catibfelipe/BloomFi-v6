import React, { useState } from 'react';
import { ArrowRight, ChevronLeft } from 'lucide-react';
import { useStore } from '../store.jsx';
import Wally from './Wally.jsx';
import { CURRENCIES, parseAmount } from '../lib/format.js';
import { priceLabel } from '../lib/billing.js';

/** First steps after creating the account: how to call you, currency, and the money you have today. */
export default function Onboarding() {
  const { settings, finishOnboarding, serverCfg, vaultInfo, entitlement, t } = useStore();
  const lang = settings.lang;
  const [step, setStep] = useState(0);
  const [name, setName] = useState(settings.name || vaultInfo.name || '');
  const [currency, setCurrency] = useState(settings.currency);
  const [income, setIncome] = useState('');
  const [balance, setBalance] = useState('');
  const [payday, setPayday] = useState(5);
  const [busy, setBusy] = useState(false);

  const finish = async () => {
    setBusy(true);
    const inc = parseAmount(income, lang);
    const bal = balance.trim() ? parseAmount(balance, lang) : null;
    await finishOnboarding({ name, lang, currency, income: Number.isNaN(inc) ? 0 : inc, incomeDay: payday, balance: Number.isNaN(bal) ? null : bal });
  };

  return (
    <div className="onboarding">
      <div className="onb-card">
        {step > 0 && <button className="onb-back" onClick={() => setStep(step - 1)} aria-label={t('common.back')}><ChevronLeft size={20} /></button>}
        <div className="onb-dots">{[0, 1].map((i) => <i key={i} className={i === step ? 'on' : ''} />)}</div>

        {step === 0 && (
          <form className="form" onSubmit={(e) => { e.preventDefault(); setStep(1); }}>
            <Wally mood="celebrate" size={72} />
            <h1>{t('onb.readyTitle')}</h1>
            <p className="sub">{t('onb.readySub')}</p>
            <label>{t('onb.nameQ')}<input autoFocus={!name} value={name} maxLength={30} autoComplete="given-name" onChange={(e) => setName(e.target.value)} placeholder={t('onb.namePh')} /></label>
            <label>{t('set.currency')}
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <button className="primary full" type="submit">{t('common.fwd')} <ArrowRight size={18} /></button>
          </form>
        )}

        {step === 1 && (
          <div className="form">
            <Wally mood="thinking" size={64} />
            <h1>{t('onb.moneyQ')}</h1>
            <p className="sub">{t('onb.moneyHint')}</p>
            <label>{t('onb.balance')}<input className="amount" inputMode="decimal" placeholder="0,00" value={balance} onChange={(e) => setBalance(e.target.value)} /></label>
            <div className="form-2">
              <label>{t('onb.income')}<input inputMode="decimal" placeholder="0,00" value={income} onChange={(e) => setIncome(e.target.value)} /></label>
              <label>{t('onb.payday')}
                <select value={payday} onChange={(e) => setPayday(Number(e.target.value))}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{t('card.dayN', { n: d })}</option>)}
                </select>
              </label>
            </div>
            <button className="primary full" disabled={busy} onClick={finish}>{t('onb.go')} <ArrowRight size={18} /></button>
            {serverCfg?.billing?.enabled && entitlement.status === 'trial' && <p className="trial-note">{t('onb.trialNote', { n: entitlement.daysLeft, p: priceLabel(serverCfg, lang) })}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
