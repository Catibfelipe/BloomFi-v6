import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export default function Modal({ title, onClose, children, wide = false }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('no-scroll'); };
  }, [onClose]);

  return createPortal(
    <div className="modal-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="grabber" />
        <button className="close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        {title && <h2>{title}</h2>}
        {children}
      </div>
    </div>,
    document.body
  );
}

export function Confirm({ title, text, confirmLabel, cancelLabel, danger, onConfirm, onClose }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="confirm-text">{text}</p>
      <div className="btn-row">
        <button className="ghost" onClick={onClose}>{cancelLabel}</button>
        <button className={danger ? 'danger-btn' : 'primary'} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}
