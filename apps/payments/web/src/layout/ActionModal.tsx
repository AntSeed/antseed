import { useEffect, type ReactNode } from 'react';

interface ActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function ActionModal({ isOpen, onClose, title, subtitle, children }: ActionModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="action-modal-overlay"
      role="dialog"
      aria-label={title}
      onClick={onClose}
    >
      <div className="action-modal-card" onClick={(e) => e.stopPropagation()}>
        <header className="action-modal-head">
          <div className="action-modal-head-text">
            <h2 className="action-modal-title">{title}</h2>
            {subtitle && <p className="action-modal-subtitle">{subtitle}</p>}
          </div>
          <button
            type="button"
            className="action-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </header>
        <div className="action-modal-body">{children}</div>
      </div>
    </div>
  );
}
