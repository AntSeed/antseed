import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CloseGlyph } from './icons';

type ModalVariant = 'telemetry' | 'services';

interface ModalProps {
  variant?: ModalVariant;
  titleId: string;
  eyebrow: string;
  title: ReactNode;
  sub?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  frameClassName?: string;
  closeLabel?: string;
}

export function Modal({
  variant = 'telemetry',
  titleId,
  eyebrow,
  title,
  sub,
  onClose,
  children,
  footer,
  frameClassName,
  closeLabel = 'Close',
}: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  const overlayClass = variant === 'services' ? 'services-modal-overlay' : 'tm-overlay';
  const frameClass =
    variant === 'services'
      ? `services-modal${frameClassName ? ` ${frameClassName}` : ''}`
      : `tm-frame${frameClassName ? ` ${frameClassName}` : ''}`;

  return createPortal(
    <div className={overlayClass} onClick={onClose}>
      <div
        className={frameClass}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        {variant === 'services' ? (
          <header className="services-modal-head">
            <div className="services-modal-head-text">
              <span className="services-modal-eyebrow">{eyebrow}</span>
              <h3 id={titleId} className="services-modal-title">{title}</h3>
              {sub && <span className="services-modal-meta">{sub}</span>}
            </div>
            <button
              type="button"
              className="services-modal-close"
              onClick={onClose}
              aria-label={closeLabel}
            >
              <CloseGlyph />
            </button>
          </header>
        ) : (
          <header className="tm-head">
            <div className="tm-head-id">
              <span className="tm-head-dot" aria-hidden />
              <span className="tm-head-eyebrow">{eyebrow}</span>
            </div>
            <h2 id={titleId} className="tm-head-title">{title}</h2>
            {sub && <p className="tm-head-sub">{sub}</p>}
            <button
              type="button"
              className="tm-close"
              onClick={onClose}
              aria-label={closeLabel}
            >
              <CloseGlyph />
            </button>
          </header>
        )}
        {children}
        {footer}
      </div>
    </div>,
    document.body,
  );
}
