import { useEffect, type ReactNode } from 'react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';

interface ActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  variant?: 'default' | 'deposit';
  children: ReactNode;
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function ActionModal({ isOpen, onClose, title, subtitle, variant = 'default', children }: ActionModalProps) {
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

  useBodyScrollLock(isOpen);

  if (!isOpen) return null;

  return (
    <div
      className="action-modal-overlay"
      role="dialog"
      aria-label={title}
      onClick={onClose}
    >
      <div className={`action-modal-card action-modal-card--${variant}`} onClick={(e) => e.stopPropagation()}>
        <header className="action-modal-head">
          {variant === 'deposit' ? (
            <div className="action-modal-deposit-hero">
              <div className="action-modal-head-text">
                <div className="action-modal-eyebrow">Deposit wizard</div>
                <h2 className="action-modal-title">{title}</h2>
                {subtitle && <p className="action-modal-subtitle">{subtitle}</p>}
              </div>
            </div>
          ) : (
            <div className="action-modal-head-text">
              <h2 className="action-modal-title">{title}</h2>
              {subtitle && <p className="action-modal-subtitle">{subtitle}</p>}
            </div>
          )}
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
