import React, { useState } from 'react';
import { BellRing, Send, EyeOff } from 'lucide-react';
import { useStore } from '../store.jsx';
import { pushSupported, isIOS, isStandalone } from '../lib/push.js';

const HOURS = [7, 8, 9, 10, 12, 14, 18, 20];

export function RemindersPanel() {
  const { t, settings, serverCfg, remindersOn, remindersOff, remindersSet, remindersTest, toast, isArtifact } = useStore();
  const [busy, setBusy] = useState(false);
  if (isArtifact) return null;
  const rem = settings.reminders || {};
  const supported = pushSupported();
  const iosNeedsInstall = isIOS() && !isStandalone();
  const toggle = async () => {
    setBusy(true);
    try {
      if (rem.enabled) { await remindersOff(); toast(t('rem.off')); }
      else { const r = await remindersOn(); toast(r.push ? t('rem.on') : t('rem.onLocal')); }
    } catch (e) {
      toast(e.code === 'denied' ? t('rem.denied') : t('rem.fail'), 'err');
    }
    setBusy(false);
  };
  return (
    <section className="panel">
      <h3><BellRing size={17} /> {t('rem.title')}</h3>
      <p className="muted">{t('rem.text')}</p>
      {!supported ? <p className="hint">{t('rem.unsupported')}</p> : (
        <>
          {iosNeedsInstall && <p className="hint info-note">{t('rem.iosInstall')}</p>}
          <button className={`toggle ${rem.enabled ? 'on' : ''}`} onClick={toggle} disabled={busy} aria-pressed={!!rem.enabled}>
            <span><BellRing size={16} /> {t('rem.toggle')}<small>{serverCfg?.push?.enabled ? t('rem.toggleHint') : t('rem.toggleHintLocal')}</small></span><i />
          </button>
          {rem.enabled && (
            <>
              <label className="field">{t('rem.hour')}
                <select value={rem.hour ?? 9} onChange={(e) => remindersSet({ hour: Number(e.target.value) })}>
                  {HOURS.map((h) => <option key={h} value={h}>{t('rem.hourN', { h })}</option>)}
                </select>
              </label>
              <button className={`toggle ${rem.detail ? 'on' : ''}`} onClick={() => remindersSet({ detail: !rem.detail })} aria-pressed={!!rem.detail}>
                <span><EyeOff size={16} /> {t('rem.detail')}<small>{t('rem.detailHint')}</small></span><i />
              </button>
              <button className="ghost small" onClick={async () => { try { await remindersTest(); toast(t('rem.testSent')); } catch { toast(t('rem.fail'), 'err'); } }}><Send size={15} /> {t('rem.test')}</button>
            </>
          )}
        </>
      )}
    </section>
  );
}
