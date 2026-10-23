import React from 'react';
import { Share, SquarePlus, Smartphone, Globe, Download, Monitor } from 'lucide-react';
import { useStore } from '../store.jsx';
import Modal from './Modal.jsx';

/** How to install the app on this kind of device (iPhone: Safari share sheet; Android/PC: browser menu). */
export function InstallHelp({ platform, onClose }) {
  const { t } = useStore();
  const steps = platform === 'ios'
    ? [[Share, t('inst.ios1')], [SquarePlus, t('inst.ios2')], [Smartphone, t('inst.ios3')]]
    : platform === 'android'
      ? [[Globe, t('inst.and1')], [Download, t('inst.and2')], [Smartphone, t('inst.and3')]]
      : [[Monitor, t('inst.pc1')], [Download, t('inst.pc2')], [Smartphone, t('inst.pc3')]];
  return (
    <Modal title={t('inst.title')} onClose={onClose}>
      <ol className="install-steps">
        {steps.map(([Icon, text], i) => <li key={i}><div className="cat-icon" style={{ '--c': '#0bf28b' }}><Icon size={18} /></div><span>{text}</span></li>)}
      </ol>
      <button className="primary full" onClick={onClose}>{t('common.ok')}</button>
    </Modal>
  );
}

