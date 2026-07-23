import FocusLock from 'react-focus-lock';
import { RemoveScroll } from 'react-remove-scroll';
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useDialogBehavior } from './useDialogBehavior';

export type ModalSize = 'sm' | 'md' | 'lg';

export interface ModalProps {
  bodyClassName?: string;
  children: ReactNode;
  closeLabel?: string;
  className?: string;
  eyebrow?: ReactNode;
  isOpen: boolean;
  onClose: () => void;
  overlayClassName?: string;
  size?: ModalSize;
  subtitle?: ReactNode;
  title: ReactNode;
}

const modalWidths: Record<ModalSize, string> = {
  sm: '24rem',
  md: '28.75rem',
  lg: '35rem',
};

/** Must match the exit animation duration in styles/index.scss. */
const MODAL_EXIT_MS = 160;

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Modal({
  bodyClassName,
  children,
  className,
  closeLabel = 'Close',
  eyebrow,
  isOpen,
  onClose,
  overlayClassName,
  size = 'md',
  subtitle,
  title,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const subtitleId = useId();
  const { closeDialog: closeModal, isTopDialog } = useDialogBehavior(isOpen, panelRef, onClose);

  // Keep the modal mounted briefly after close so the exit animation can play.
  const [isExiting, setIsExiting] = useState(false);
  const wasOpenRef = useRef(isOpen);
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (isOpen) {
      setIsExiting(false);
      return;
    }
    if (!wasOpen) return;
    setIsExiting(true);
    const timer = window.setTimeout(() => setIsExiting(false), MODAL_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  if (!isOpen && !isExiting) return null;

  const overlayClasses = [
    'as-modal-overlay',
    !isOpen && 'as-modal-overlay--closing',
    overlayClassName,
  ].filter(Boolean).join(' ');
  const modalClasses = ['as-modal', `as-modal--${size}`, className].filter(Boolean).join(' ');
  const bodyClasses = ['as-modal__body', bodyClassName].filter(Boolean).join(' ');
  const scrollLockStyle = { '--as-modal-width': modalWidths[size] } as CSSProperties;

  return (
    <div className={overlayClasses} role="presentation" onMouseDown={closeModal}>
      <RemoveScroll
        allowPinchZoom
        className="as-modal__scroll-lock"
        enabled={isTopDialog}
        style={scrollLockStyle}
      >
        <FocusLock
          autoFocus
          className="as-modal__focus-lock"
          disabled={!isTopDialog}
          focusOptions={{ preventScroll: true }}
          returnFocus={false}
        >
          <div
            aria-describedby={subtitle ? subtitleId : undefined}
            aria-hidden={isTopDialog ? undefined : true}
            aria-labelledby={titleId}
            aria-modal={isTopDialog ? 'true' : undefined}
            className={modalClasses}
            ref={panelRef}
            role="dialog"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="as-modal__header">
              <div className="as-modal__titles">
                {eyebrow && <div className="as-modal__eyebrow">{eyebrow}</div>}
                <h2 className="as-modal__title" id={titleId}>{title}</h2>
                {subtitle && <p className="as-modal__subtitle" id={subtitleId}>{subtitle}</p>}
              </div>
              <IconButton label={closeLabel} className="as-modal__close" onClick={closeModal}>
                <CloseIcon />
              </IconButton>
            </header>
            <div className={bodyClasses}>{children}</div>
          </div>
        </FocusLock>
      </RemoveScroll>
    </div>
  );
}

function IconButton({
  children,
  className,
  label,
  onClick,
}: {
  children: ReactNode;
  className: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={className} onClick={onClick} aria-label={label}>
      {children}
    </button>
  );
}
