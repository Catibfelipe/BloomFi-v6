import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Smartphone, Copy, Share2, Check, ChevronRight, ChevronDown, RefreshCw, Trash2, Send, Apple, Bot, Bell, MessageSquare, CreditCard,
  ShieldCheck, Sparkles, X, Link2, Inbox, Wand2, ExternalLink, CircleCheck, CircleAlert, Info,
} from 'lucide-react';
import { useStore } from '../store.jsx';
import Modal, { Confirm } from './Modal.jsx';
import { CatIcon } from './Common.jsx';
import { categoriesFor } from '../lib/categories.js';
import { authError } from './Auth.jsx';
import { ago } from './Security.jsx';
import { haptic } from '../lib/haptics.js';
import { platform as detectPlatform } from '../lib/pwa.js';

const MACRODROID = 'https://play.google.com/store/apps/details?id=com.arlosoft.macrodroid';

/** Turns **bold** and `code` in a translated text into elements (no HTML injection). */
export function Rich({ text }) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => (p.startsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p));
}

const short = (url) => (url && url.length > 46 ? `${url.slice(0, 30)}…${url.slice(-10)}` : url);

function LinkBox({ url, compact = false }) {
  const { t, toast } = useStore();
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); haptic('success'); toast(t('cap.copied')); } catch { toast(t('set.copyManual'), 'info'); }
  };
  const share = async () => { try { await navigator.share({ title: 'BloomFi', text: url }); } catch { /* closed */ } };
  return (
    <div className={`link-box ${compact ? 'compact' : ''}`}>
      <code className="mono" title={url}>{short(url)}</code>
      <div className="link-actions">
        <button type="button" className="primary slim" onClick={copy}><Copy size={15} /> {t('cap.copyLink')}</button>
        {typeof navigator.share === 'function' && <button type="button" className="secondary slim" onClick={share} aria-label={t('rk.share')}><Share2 size={15} /></button>}
      </div>
    </div>
  );
}

function Steps({ items }) {
  return <ol className="guide-steps">{items.map((k, i) => <li key={i}><span className="n">{i + 1}</span><p><Rich text={k} /></p></li>)}</ol>;
}

function Fold({ icon: Icon, title, children, open: open0 = false }) {
  const [open, setOpen] = useState(open0);
  return (
    <div className={`fold ${open ? 'open' : ''}`}>
      <button type="button" className="fold-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {Icon && <Icon size={16} />}<span>{title}</span>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}

// ---------------- setup wizard ----------------
export function CaptureWizard({ onClose, startPlatform }) {
  const s = useStore();
  const { t, settings, serverCfg, createCaptureLink, sendCaptureTest, pullCaptures, captureState, toast } = s;
  const detected = detectPlatform();
  const [step, setStep] = useState(startPlatform ? 'link' : 'phone');
  const [plat, setPlat] = useState(startPlatform || (detected === 'android' ? 'android' : 'ios'));
  const [iosVer, setIosVer] = useState('old');
  const [link, setLink] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const opened = useRef(Date.now());
  const shortcut = serverCfg?.wallet?.iosShortcutUrl || null;
  const first = (settings.name || '').split(' ')[0];

  const create = async () => {
    setBusy(true); setError('');
    try {
      const label = plat === 'ios' ? t('cap.labelIos', { n: first || '' }).trim() : t('cap.labelAndroid', { n: first || '' }).trim();
      setLink(await createCaptureLink(label, plat));
      haptic('success');
    } catch (e) { setError(e.code === 'too_many_links' ? t('cap.err.tooMany') : authError(t, e)); }
    setBusy(false);
  };

  // While on the test step: look for news every 5 seconds (2 minutes at most).
  useEffect(() => {
    if (step !== 'test') return undefined;
    let n = 0;
    const id = setInterval(() => { if (++n > 24) clearInterval(id); pullCaptures({ manual: 'silent' }).catch(() => {}); }, 5000);
    return () => clearInterval(id);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const fresh = (captureState.log || []).filter((x) => (x.at || 0) >= opened.current - 5000);
  const got = fresh.find((x) => x.status === 'added' || x.status === 'duplicate') || fresh.find((x) => x.status === 'test') || fresh.find((x) => x.status === 'ignored');

  const iosOld = shortcut
    ? [t('cap.ios.sc1'), t('cap.ios.sc2old'), t('cap.ios.sc3')]
    : [t('cap.ios.m1'), t('cap.ios.m2'), t('cap.ios.m3'), t('cap.ios.m4'), t('cap.ios.m5'), t('cap.ios.m6'), t('cap.ios.m7'), t('cap.ios.m8'), t('cap.ios.m9')];
  const iosNew = shortcut
    ? [t('cap.ios.sc1'), t('cap.ios.sc2new'), t('cap.ios.sc3')]
    : [t('cap.ios.n1'), t('cap.ios.n2'), t('cap.ios.m5'), t('cap.ios.m6'), t('cap.ios.m7'), t('cap.ios.m8'), t('cap.ios.n3')];
  const android = [t('cap.and.1'), t('cap.and.2'), t('cap.and.3'), t('cap.and.4'), t('cap.and.5'), t('cap.and.6')];

  return (
    <Modal title={t('cap.wizTitle')} onClose={busy ? () => {} : onClose} wide>
      <div className="wiz-dots">{['phone', 'link', 'guide', 'test'].map((k) => <i key={k} className={k === step ? 'on' : ''} />)}</div>

      {step === 'phone' && (
        <div className="form">
          <p className="sub center">{t('cap.phoneQ')}</p>
          <div className="choice-cards">
            <button className={plat === 'ios' ? 'on' : ''} onClick={() => setPlat('ios')} aria-pressed={plat === 'ios'}>
              <Apple size={26} /><b>iPhone</b><small>{t('cap.iosWhat')}</small>
            </button>
            <button className={plat === 'android' ? 'on' : ''} onClick={() => setPlat('android')} aria-pressed={plat === 'android'}>
              <Bot size={26} /><b>Android</b><small>{t('cap.andWhat')}</small>
            </button>
          </div>
          <button className="primary full" onClick={() => setStep('link')}>{t('common.fwd')} <ChevronRight size={18} /></button>
        </div>
      )}

      {step === 'link' && (
        <div className="form">
          <div className="wiz-ico"><Link2 size={26} /></div>
          <h3 className="center">{t('cap.linkTitle')}</h3>
          <p className="sub center">{t('cap.linkText')}</p>
          <ul className="plain-list">
            <li><ShieldCheck size={16} /> {t('cap.linkSafe1')}</li>
            <li><Trash2 size={16} /> {t('cap.linkSafe2')}</li>
          </ul>
          {!link ? (
            <button className="primary full" disabled={busy} onClick={create}>{busy ? <><span className="spinner" /> {t('cap.creating')}</> : <><Wand2 size={17} /> {t('cap.createLink')}</>}</button>
          ) : (
            <>
              <LinkBox url={link.url} />
              <p className="hint"><Info size={14} /> {t('cap.linkPrivate')}</p>
              <button className="primary full" onClick={() => setStep('guide')}>{t('cap.toGuide')} <ChevronRight size={18} /></button>
            </>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button type="button" className="link-btn" onClick={() => setStep('phone')}>{t('common.back')}</button>
        </div>
      )}

      {step === 'guide' && (
        <div className="form guide">
          {link && <LinkBox url={link.url} compact />}
          {plat === 'ios' ? (
            <>
              <div className="segmented two" role="tablist">
                <button role="tab" className={iosVer === 'old' ? 'active' : ''} aria-selected={iosVer === 'old'} onClick={() => setIosVer('old')}>iOS 17 – 26</button>
                <button role="tab" className={iosVer === 'new' ? 'active' : ''} aria-selected={iosVer === 'new'} onClick={() => setIosVer('new')}>iOS 27</button>
              </div>
              <p className="hint"><Info size={14} /> {t('cap.ios.which')}</p>
              {shortcut && <a className="primary full" href={shortcut} target="_blank" rel="noopener noreferrer"><Sparkles size={17} /> {t('cap.ios.install')}</a>}
              <Steps items={iosVer === 'new' ? iosNew : iosOld} />
              {shortcut && (
                <Fold icon={Wand2} title={t('cap.ios.manualTitle')}>
                  <Steps items={iosVer === 'new' ? [t('cap.ios.n1'), t('cap.ios.n2'), t('cap.ios.m5'), t('cap.ios.m6'), t('cap.ios.m7'), t('cap.ios.m8'), t('cap.ios.n3')] : [t('cap.ios.m1'), t('cap.ios.m2'), t('cap.ios.m3'), t('cap.ios.m4'), t('cap.ios.m5'), t('cap.ios.m6'), t('cap.ios.m7'), t('cap.ios.m8'), t('cap.ios.m9')]} />
                </Fold>
              )}
              <p className="hint"><CreditCard size={14} /> {t('cap.ios.limit')}</p>
              <Fold icon={MessageSquare} title={t('cap.ios.smsTitle')}><Steps items={[t('cap.ios.sms1'), t('cap.ios.sms2'), t('cap.ios.sms3')]} /></Fold>
              <Fold icon={Bell} title={t('cap.ios.notifTitle')}><Steps items={[t('cap.ios.not1'), t('cap.ios.not2'), t('cap.ios.not3')]} /></Fold>
            </>
          ) : (
            <>
              <a className="secondary full" href={MACRODROID} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} /> {t('cap.and.store')}</a>
              <Steps items={android} />
              <p className="hint"><CreditCard size={14} /> {t('cap.and.virtual')}</p>
              <Fold icon={MessageSquare} title={t('cap.and.smsTitle')}><p className="muted"><Rich text={t('cap.and.sms')} /></p></Fold>
              <Fold icon={Info} title={t('cap.and.tipsTitle')}>
                <ul className="plain-list"><li><Rich text={t('cap.and.tip1')} /></li><li><Rich text={t('cap.and.tip2')} /></li><li><Rich text={t('cap.and.tip3')} /></li></ul>
              </Fold>
            </>
          )}
          <button className="primary full" onClick={() => setStep('test')}>{t('cap.toTest')} <ChevronRight size={18} /></button>
        </div>
      )}

      {step === 'test' && (
        <div className="form">
          <div className={`test-state ${got ? 'ok' : ''}`}>
            {got ? <CircleCheck size={40} /> : <span className="pulse"><Inbox size={30} /></span>}
            <b>{got ? (got.status === 'test' ? t('cap.test.okTest') : got.status === 'ignored' ? t('cap.test.okPing') : t('cap.test.okBuy')) : t('cap.test.waiting')}</b>
            <span>{got ? (got.description ? `${got.description}` : t('cap.test.okText')) : t('cap.test.waitingText')}</span>
          </div>
          {link && !got && (
            <button className="secondary full" disabled={busy} onClick={async () => {
              setBusy(true); setError('');
              try { await sendCaptureTest(link.url); } catch (e) { setError(e.code === 'link_revoked' ? t('cap.err.revoked') : authError(t, e)); }
              setBusy(false);
            }}><Send size={16} /> {t('cap.test.send')}</button>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <p className="hint"><Info size={14} /> {t('cap.test.hint')}</p>
          <button className="primary full" onClick={() => { if (got) toast(t('cap.ready')); onClose(); }}>{got ? t('common.done') : t('cap.test.later')}</button>
        </div>
      )}
    </Modal>
  );
}

// ---------------- review ----------------
const SRC_ICON = { applepay: Apple, android: Bot, notification: Bell };

export function CaptureReviewModal({ onClose }) {
  const { t, toReview, reviewCapture, deleteTxUndo, money, lang, activeAccounts, activeCards, toast } = useStore();
  const [picks, setPicks] = useState({});
  const list = toReview;
  useEffect(() => { if (!list.length) onClose(); }, [list.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const destOf = (tx) => picks[tx.id]?.dest || (tx.cardId ? `card:${tx.cardId}` : `acc:${tx.accountId || 'main'}`);
  const catOf = (tx) => picks[tx.id]?.category || tx.category;
  const set = (id, patch) => setPicks((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  const confirm = async (tx) => { await reviewCapture(tx, { dest: destOf(tx), category: catOf(tx), remember: true }); haptic(); };
  const fmtTime = (ms) => new Intl.DateTimeFormat(lang === 'pt' ? 'pt-BR' : 'en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  return (
    <Modal title={t('cap.review.title')} onClose={onClose} wide>
      <p className="sub">{t('cap.review.text')}</p>
      <div className="review-list">
        {list.map((tx) => {
          const Icon = SRC_ICON[tx.capture?.src] || Smartphone;
          const card = [tx.capture?.cardName, tx.capture?.last4 ? `•${tx.capture.last4}` : ''].filter(Boolean).join(' ');
          return (
            <div className="review-item" key={tx.id}>
              <div className="review-top">
                <CatIcon category={catOf(tx)} />
                <div className="review-main">
                  <b>{tx.description || t('cap.noPlace')}</b>
                  <span><Icon size={12} /> {fmtTime(tx.capture?.at || tx.createdAt)}{card ? ` · ${card}` : ''}</span>
                </div>
                <strong className={tx.type === 'income' ? 'positive' : ''}>{tx.type === 'income' ? '+' : '−'}{money(tx.amount)}</strong>
              </div>
              <div className="review-selects">
                <select aria-label={t('cap.review.where')} value={destOf(tx)} onChange={(e) => set(tx.id, { dest: e.target.value })}>
                  <optgroup label={t('wal.accounts')}>{activeAccounts.map((a) => <option key={a.id} value={`acc:${a.id}`}>{a.name}</option>)}</optgroup>
                  {activeCards.length > 0 && <optgroup label={t('wal.cards')}>{activeCards.map((c) => <option key={c.id} value={`card:${c.id}`}>{c.name}</option>)}</optgroup>}
                </select>
                <select aria-label={t('tx.category')} value={catOf(tx)} onChange={(e) => set(tx.id, { category: e.target.value })}>
                  {categoriesFor(tx.type === 'income' ? 'income' : 'expense').map((c) => <option key={c.key} value={c.key}>{t(`cat.${c.key}`)}</option>)}
                </select>
              </div>
              <div className="review-actions">
                <button className="icon-danger small" onClick={() => deleteTxUndo(tx)} aria-label={t('common.delete')}><Trash2 size={16} /></button>
                <button className="primary slim" onClick={() => confirm(tx)}><Check size={16} /> {t('cap.review.ok')}</button>
              </div>
            </div>
          );
        })}
      </div>
      {list.length > 1 && (
        <button className="secondary full" onClick={async () => { for (const tx of list) await reviewCapture(tx, { dest: destOf(tx), category: catOf(tx), remember: false }); toast(t('cap.review.allDone')); }}>
          <Check size={16} /> {t('cap.review.all', { n: list.length })}
        </button>
      )}
      <p className="hint"><Sparkles size={14} /> {t('cap.review.learn')}</p>
    </Modal>
  );
}

/** Home: "3 phone payments to review". */
export function ReviewBanner() {
  const { t, toReview } = useStore();
  const [open, setOpen] = useState(false);
  if (!toReview.length) return null;
  return (
    <>
      <button className="review-banner" onClick={() => setOpen(true)}>
        <Smartphone size={20} />
        <span><b>{t('cap.banner', { n: toReview.length })}</b><small>{t('cap.bannerSub')}</small></span>
        <ChevronRight size={18} />
      </button>
      {open && <CaptureReviewModal onClose={() => setOpen(false)} />}
    </>
  );
}

// ---------------- panel (Conexões page) ----------------
export function CapturePanel({ autoOpen = false }) {
  const s = useStore();
  const { t, serverMode, isArtifact, captureLinks, revokeCaptureLink, sendCaptureTest, captureState, pullCaptures, rules, deleteRule, toReview, session, setPushPrefs, serverCfg, settings, toast, activeAccounts, activeCards } = s;
  const [links, setLinks] = useState(null);
  const [wizard, setWizard] = useState(autoOpen);
  const [review, setReview] = useState(false);
  const [del, setDel] = useState(null);
  const [busy, setBusy] = useState(null);
  const localLinks = useMemo(() => new Map(rules.filter((r) => r.kind === 'link').map((r) => [r.linkId, r])), [rules]);
  const learned = rules.filter((r) => r.kind === 'map' || r.kind === 'cat');
  const load = () => captureLinks().then(setLinks).catch(() => setLinks([]));
  useEffect(() => { if (serverMode) load(); }, [serverMode, wizard]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!serverMode) {
    return (
      <section className="panel cap-panel">
        <div className="panel-head"><h2><Smartphone size={18} /> {t('cap.title')}</h2></div>
        <p className="muted">{t(isArtifact ? 'cap.needsOnline' : 'cap.needsAccount')}</p>
      </section>
    );
  }
  const prefs = session.user?.prefs || {};
  const alertsOn = prefs.captureAlerts !== false;
  const destName = (dest) => {
    if (!dest) return '—';
    const id = dest.slice(dest.indexOf(':') + 1);
    return dest.startsWith('card:') ? activeCards.find((c) => c.id === id)?.name || '—' : activeAccounts.find((a) => a.id === id)?.name || '—';
  };
  const ruleLabel = (r) => {
    if (r.kind === 'cat') return { a: r.key, b: t(`cat.${r.category}`) };
    const [kind, ...rest] = r.key.split(':');
    const a = kind === 'last4' ? `•••• ${rest[0]}` : kind === 'card' ? rest.join(':') : `${rest[0]}${rest[1] && rest[1] !== 'any' ? ` (${t(`cap.method.${rest[1]}`)})` : ''}`;
    return { a, b: destName(r.dest) };
  };
  const recent = (captureState.log || []).slice(0, 8);

  return (
    <section className="panel cap-panel">
      <div className="panel-head">
        <h2><Smartphone size={18} /> {t('cap.title')}</h2>
        {links?.length > 0 && <button onClick={() => pullCaptures({}).then((r) => toast(r?.added ? t('cap.addedToast', { n: r.added }) : t('cap.nothingNew'))).catch((e) => toast(authError(t, e), 'err'))} disabled={captureState.busy}><RefreshCw size={14} className={captureState.busy ? 'spin' : ''} /> {t('cap.check')}</button>}
      </div>
      <p className="muted">{t('cap.text')}</p>

      {links && !links.length && (
        <div className="cap-hero">
          <div className="cap-logos"><span><Apple size={18} /> Apple Pay</span><span><Bot size={18} /> Google Pay</span><span><CreditCard size={18} /> {t('cap.virtual')}</span></div>
          <button className="primary" onClick={() => setWizard(true)}><Smartphone size={18} /> {t('cap.connect')}</button>
        </div>
      )}
      {links === null && <p className="hint center"><span className="spinner" /></p>}

      {links?.map((l) => {
        const mine = localLinks.get(l.id);
        return (
          <div className="conn" key={l.id}>
            <div className="conn-logo" style={{ '--c': l.platform === 'android' ? '#3ddc84' : '#e5e7eb' }}>{l.platform === 'android' ? <Bot size={18} /> : <Apple size={18} />}</div>
            <div className="conn-main">
              <b>{l.label}</b>
              <span>{l.lastAt ? t('cap.lastAt', { w: ago(t, l.lastAt * 1000), n: l.count }) : t('cap.never')}</span>
            </div>
            {mine && <button className="icon-btn" disabled={busy === l.id} onClick={async () => { setBusy(l.id); try { await sendCaptureTest(mine.url); } catch (e) { toast(e.code === 'link_revoked' ? t('cap.err.revoked') : authError(t, e), 'err'); } setBusy(null); load(); }} aria-label={t('cap.test.send')} title={t('cap.test.send')}><Send size={16} /></button>}
            {mine && <button className="icon-btn" onClick={async () => { try { await navigator.clipboard.writeText(mine.url); toast(t('cap.copied')); } catch { toast(t('set.copyManual'), 'info'); } }} aria-label={t('cap.copyLink')} title={t('cap.copyLink')}><Copy size={16} /></button>}
            <button className="icon-btn" onClick={() => setDel(l)} aria-label={t('cap.remove')} title={t('cap.remove')}><Trash2 size={16} /></button>
          </div>
        );
      })}
      {links?.length > 0 && <button className="secondary" onClick={() => setWizard(true)}><Smartphone size={16} /> {t('cap.addPhone')}</button>}

      {toReview.length > 0 && (
        <button className="review-banner inline" onClick={() => setReview(true)}>
          <Inbox size={18} /><span><b>{t('cap.banner', { n: toReview.length })}</b></span><ChevronRight size={18} />
        </button>
      )}

      {links?.length > 0 && serverCfg?.push?.enabled && (
        <>
          <button className={`toggle ${alertsOn ? 'on' : ''}`} aria-pressed={alertsOn} onClick={async () => { try { await setPushPrefs({ captureAlerts: !alertsOn }); await s.checkSession(); } catch (e) { toast(authError(t, e), 'err'); } }}>
            <span><Bell size={16} /> {t('cap.alerts')}<small>{settings.reminders?.enabled ? t('cap.alertsHint') : t('cap.alertsNeedPush')}</small></span><i />
          </button>
          {alertsOn && (
            <button className={`toggle sub ${prefs.pushDetail ? 'on' : ''}`} aria-pressed={!!prefs.pushDetail} onClick={async () => { try { await setPushPrefs({ pushDetail: !prefs.pushDetail }); await s.checkSession(); } catch (e) { toast(authError(t, e), 'err'); } }}>
              <span>{t('cap.detail')}<small>{t('cap.detailHint')}</small></span><i />
            </button>
          )}
        </>
      )}

      {recent.length > 0 && (
        <Fold icon={Inbox} title={t('cap.recent')}>
          <ul className="cap-log">
            {recent.map((x) => (
              <li key={`${x.id}-${x.status}`} className={x.status}>
                {x.status === 'added' ? <CircleCheck size={15} /> : x.status === 'test' ? <Check size={15} /> : <CircleAlert size={15} />}
                <span><b>{x.status === 'added' ? `${x.description || t('cap.noPlace')}` : t(`cap.st.${x.status}`)}</b><small>{ago(t, x.at)}{x.reason ? ` · ${t(`cap.why.${x.reason}`)}` : ''}{x.preview ? ` · ${x.preview}` : ''}</small></span>
              </li>
            ))}
          </ul>
        </Fold>
      )}

      {learned.length > 0 && (
        <Fold icon={Sparkles} title={t('cap.rules', { n: learned.length })}>
          <ul className="rule-list">
            {learned.map((r) => {
              const l = ruleLabel(r);
              return <li key={r.id}><span><b>{l.a}</b> → {l.b}</span><button className="icon-btn" onClick={() => deleteRule(r.id)} aria-label={t('common.delete')}><X size={14} /></button></li>;
            })}
          </ul>
        </Fold>
      )}

      <ul className="of-facts">
        <li><ShieldCheck size={15} /> {t('cap.fact1')}</li>
        <li><Check size={15} /> {t('cap.fact2')}</li>
      </ul>

      {wizard && <CaptureWizard onClose={() => { setWizard(false); load(); }} />}
      {review && <CaptureReviewModal onClose={() => setReview(false)} />}
      {del && (
        <Confirm title={t('cap.removeTitle', { l: del.label })} text={t('cap.removeText')} danger confirmLabel={t('cap.remove')} cancelLabel={t('common.cancel')}
          onClose={() => setDel(null)} onConfirm={async () => { try { await revokeCaptureLink(del.id); toast(t('cap.removed')); load(); } catch (e) { toast(authError(t, e), 'err'); } }} />
      )}
    </section>
  );
}
