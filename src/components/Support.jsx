import React from 'react';
import { Mail, MessageCircle, CircleHelp } from 'lucide-react';
import { useStore } from '../store.jsx';

/** Links to talk to the BloomFi team (set SUPPORT_EMAIL / SUPPORT_WHATSAPP on the server). */
export function supportLinks(cfg, t) {
  const s = cfg?.support || {};
  const out = [];
  if (s.whatsapp) out.push({ key: 'wa', icon: MessageCircle, label: t('sup.whatsapp'), href: `https://wa.me/${s.whatsapp}?text=${encodeURIComponent(t('sup.waText'))}` });
  if (s.email) out.push({ key: 'mail', icon: Mail, label: t('sup.email'), href: `mailto:${s.email}?subject=${encodeURIComponent(t('sup.mailSubject'))}` });
  return out;
}

export function SupportPanel() {
  const { t, serverCfg, isArtifact } = useStore();
  const links = supportLinks(serverCfg, t);
  return (
    <section className="panel support-panel">
      <h3><CircleHelp size={17} /> {t('sup.title')}</h3>
      <p className="muted">{links.length ? t('sup.text') : t('sup.textNoContact')}</p>
      <div className="btn-row wrap">
        {links.map((l) => {
          const Icon = l.icon;
          return <a key={l.key} className="secondary" href={l.href} target="_blank" rel="noopener"><Icon size={16} /> {l.label}</a>;
        })}
        {!isArtifact && <a className="ghost" href="/#perguntas" target="_blank" rel="noopener"><CircleHelp size={16} /> {t('sup.faq')}</a>}
      </div>
    </section>
  );
}

export function SupportLine() {
  const { t, serverCfg } = useStore();
  const links = supportLinks(serverCfg, t);
  if (!links.length) return null;
  return (
    <p className="support-line">{t('sup.need')} {links.map((l, i) => (
      <React.Fragment key={l.key}>{i > 0 && ' · '}<a href={l.href} target="_blank" rel="noopener">{l.label}</a></React.Fragment>
    ))}</p>
  );
}
