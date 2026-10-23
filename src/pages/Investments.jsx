import React, { useMemo, useState } from 'react';
import {
  Plus, TrendingUp, ArrowUpRight, ArrowDownLeft, RefreshCw, Pencil, Trash2, Landmark, Info,
} from 'lucide-react';
import { useStore } from '../store.jsx';
import { PageHead, Empty } from '../components/Common.jsx';
import { Donut } from '../components/Charts.jsx';
import Modal, { Confirm } from '../components/Modal.jsx';
import { ASSET_KINDS, getKind, portfolio, monthlyContributions } from '../lib/investments.js';
import { parseAmount, formatMonth, formatDate } from '../lib/format.js';

function KindIcon({ kind, size = 18 }) {
  const k = getKind(kind);
  const Icon = k.icon;
  return <div className="cat-icon" style={{ '--c': k.color }}><Icon size={size} /></div>;
}

const pctText = (p) => `${p >= 0 ? '+' : ''}${p.toFixed(1).replace('.', ',')}%`;

export default function Investments({ go }) {
  const { assets, txs, t, money, lang, openTx, deleteAsset, toast, connections } = useStore();
  const [edit, setEdit] = useState(null);
  const [valueOf, setValueOf] = useState(null);
  const [del, setDel] = useState(null);
  const pf = useMemo(() => portfolio(assets, txs), [assets, txs]);
  const months = useMemo(() => monthlyContributions(txs, 6), [txs]);
  const maxMonth = Math.max(...months.map((m) => Math.max(m.net, 0)), 1);
  const thisMonth = months[months.length - 1];

  const donutData = pf.byKind.map((k) => ({ key: k.key, amount: k.amount }));
  const kindColors = Object.fromEntries(ASSET_KINDS.map((k) => [k.key, k.color]));

  return (
    <div className="page">
      <PageHead title={t('inv.title')} sub={t('inv.sub')} />
      <div className="btn-row wrap">
        <button className="primary" onClick={() => openTx({ type: 'invest' })}><ArrowUpRight size={18} /> {t('inv.contribute')}</button>
        <button className="secondary" onClick={() => setEdit({})}><Plus size={16} /> {t('inv.add')}</button>
      </div>

      {!assets.length ? (
        <>
          <Empty icon={TrendingUp} text={t('inv.empty')} action={t('inv.add')} onAction={() => setEdit({})} />
          <section className="trust"><Info size={18} /> {t('inv.howDebit')}</section>
        </>
      ) : (
        <>
          <section className="portfolio-card">
            <span>{t('inv.total')}</span>
            <h2>{money(pf.value)}</h2>
            <p className={pf.profit >= 0 ? '' : 'neg'}>
              {pf.profit >= 0 ? '▲' : '▼'} {money(Math.abs(pf.profit))} ({pctText(pf.pct)}) {t('inv.sinceStart')}
            </p>
            <div className="metrics">
              <div>{t('inv.invested')}<b>{money(pf.invested)}</b></div>
              <div>{t('inv.thisMonth')}<b>{money(thisMonth.invested)}</b></div>
              <div>{t('inv.assets')}<b>{assets.length}</b></div>
            </div>
          </section>

          <div className="two-col">
            <section className="panel">
              <div className="panel-head"><h2>{t('inv.allocation')}</h2></div>
              <div className="cat-summary">
                <Donut data={donutData} colorOf={(k) => kindColors[k]} center={money(pf.value, { compact: pf.value >= 10000 })} sub={t('inv.total')} />
                <ul className="legend">
                  {pf.byKind.map((k) => (
                    <li key={k.key}><KindIcon kind={k.key} size={14} /><span>{t(`kind.${k.key}`)}</span><b>{Math.round(k.pct)}%</b></li>
                  ))}
                </ul>
              </div>
            </section>
            <section className="panel">
              <div className="panel-head"><h2>{t('inv.monthly')}</h2></div>
              <div className="contrib-bars">
                {months.map((m) => (
                  <div key={m.mk} className="contrib-col" title={money(m.net)}>
                    <div className="bar-track"><i style={{ height: `${Math.max((Math.max(m.net, 0) / maxMonth) * 100, m.net > 0 ? 6 : 2)}%` }} /></div>
                    <b>{m.net > 0 ? money(m.net, { compact: true }) : '—'}</b>
                    <span>{formatMonth(m.mk, lang, true).replace(/ de \d+|\s\d{4}|\.$/g, '').replace('.', '')}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <h3 className="section-title">{t('inv.myAssets')}</h3>
          <div className="card-grid">
            {pf.rows.map(({ asset, value, invested, profit, pct }) => {
              const of = asset.source === 'openfinance';
              const conn = of ? connections.find((c) => c.id === asset.connectionId) : null;
              return (
                <section className="asset" key={asset.id}>
                  <div className="budget-top">
                    <KindIcon kind={asset.kind} />
                    <div className="asset-name">
                      <b>{asset.name}</b>
                      <span>{t(`kind.${asset.kind}`)}{asset.institution ? ` · ${asset.institution}` : ''}{of ? ` · ${t('inv.viaOF')}` : ''}</span>
                    </div>
                    {!of && (
                      <div className="row-actions">
                        <button onClick={() => setEdit(asset)} aria-label={t('common.edit')}><Pencil size={15} /></button>
                        <button onClick={() => setDel(asset)} aria-label={t('common.delete')}><Trash2 size={15} /></button>
                      </div>
                    )}
                  </div>
                  <div className="asset-values">
                    <div><span>{t('inv.current')}</span><b>{money(value)}</b></div>
                    <div><span>{t('inv.invested')}</span><b>{money(invested)}</b></div>
                    <div><span>{t('inv.return')}</span><b className={profit >= 0 ? 'positive' : 'neg-red'}>{pctText(pct)}</b></div>
                  </div>
                  {of ? (
                    <p className="hint">{t('inv.ofUpdated', { d: asset.valueUpdatedAt ? formatDate(String(asset.valueUpdatedAt).slice(0, 10), lang) : '—', b: conn?.name || asset.institution })}</p>
                  ) : (
                    <div className="asset-actions">
                      <button onClick={() => openTx({ type: 'invest', assetId: asset.id })}><ArrowUpRight size={14} /> {t('inv.apply')}</button>
                      <button onClick={() => openTx({ type: 'redeem', assetId: asset.id })}><ArrowDownLeft size={14} /> {t('inv.redeem')}</button>
                      <button onClick={() => setValueOf(asset)}><RefreshCw size={14} /> {t('inv.updateValue')}</button>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          <section className="trust"><Info size={18} /> {t('inv.howDebit')}</section>
          {!connections.length && (
            <section className="connect" onClick={() => go('import')} role="button" tabIndex={0}>
              <Landmark size={30} /><div><b>{t('inv.ofTitle')}</b><p>{t('inv.ofText')}</p></div>
            </section>
          )}
        </>
      )}

      {edit && <AssetForm asset={edit} onClose={() => setEdit(null)} />}
      {valueOf && <ValueForm asset={valueOf} onClose={() => setValueOf(null)} />}
      {del && (
        <Confirm title={t('inv.deleteTitle')} text={t('inv.deleteText', { n: del.name })} danger confirmLabel={t('common.delete')} cancelLabel={t('common.cancel')}
          onClose={() => setDel(null)} onConfirm={async () => { await deleteAsset(del); toast(t('inv.deleted')); }} />
      )}
    </div>
  );
}

function AssetForm({ asset, onClose }) {
  const { t, lang, saveAsset, toast } = useStore();
  const editing = !!asset.id;
  const [name, setName] = useState(asset.name || '');
  const [kind, setKind] = useState(asset.kind || 'renda_fixa');
  const [institution, setInstitution] = useState(asset.institution || '');
  const [initial, setInitial] = useState(asset.initialInvested ? String(asset.initialInvested) : '');
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError(t('inv.errName'));
    const init = initial ? parseAmount(initial, lang) : 0;
    if (Number.isNaN(init) || init < 0) return setError(t('tx.errAmount'));
    await saveAsset({ ...asset, name, kind, institution, initialInvested: init });
    toast(editing ? t('inv.updated') : t('inv.created'));
    onClose();
  };

  return (
    <Modal title={editing ? t('inv.edit') : t('inv.add')} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>{t('inv.name')}<input autoFocus value={name} maxLength={50} placeholder={t('inv.namePh')} onChange={(e) => { setName(e.target.value); setError(''); }} /></label>
        <label>{t('inv.kind')}</label>
        <div className="cat-grid">
          {ASSET_KINDS.map((k) => {
            const Icon = k.icon;
            return (
              <button type="button" key={k.key} className={kind === k.key ? 'on' : ''} style={{ '--c': k.color }} onClick={() => setKind(k.key)}>
                <Icon size={18} /><span>{t(`kind.${k.key}`)}</span>
              </button>
            );
          })}
        </div>
        <label>{t('inv.institution')}<input value={institution} maxLength={40} placeholder={t('inv.institutionPh')} onChange={(e) => setInstitution(e.target.value)} /></label>
        <label>{t('inv.initial')}<input inputMode="decimal" placeholder="0,00" value={initial} onChange={(e) => setInitial(e.target.value)} /></label>
        <p className="hint">{t('inv.initialHint')}</p>
        {error && <p className="form-error">{error}</p>}
        <button className="primary full" type="submit">{t('common.save')}</button>
      </form>
    </Modal>
  );
}

function ValueForm({ asset, onClose }) {
  const { t, lang, addValuation, toast, txs, money } = useStore();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const current = portfolio([asset], txs).value;
  const submit = async (e) => {
    e.preventDefault();
    const v = parseAmount(value, lang);
    if (Number.isNaN(v) || v < 0) return setError(t('tx.errAmount'));
    await addValuation(asset, v);
    toast(t('inv.valueSaved'));
    onClose();
  };
  return (
    <Modal title={t('inv.updateValue')} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="hint">{t('inv.valueHint', { n: asset.name, v: money(current) })}</p>
        <label>{t('inv.valueNow')}<input autoFocus className="amount" inputMode="decimal" placeholder="0,00" value={value} onChange={(e) => { setValue(e.target.value); setError(''); }} /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary full" type="submit">{t('common.save')}</button>
      </form>
    </Modal>
  );
}
