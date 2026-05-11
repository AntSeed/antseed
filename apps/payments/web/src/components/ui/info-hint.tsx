import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface InfoHintProps {
  label?: string;
  children: ReactNode;
  variant?: 'default' | 'warn';
}

export function InfoHint({ label, children, variant = 'default' }: InfoHintProps) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const center = rect.left + rect.width / 2;
    const tooltipW = 340;
    const pad = 16;
    const left = Math.min(
      Math.max(pad, center - tooltipW / 2),
      window.innerWidth - tooltipW - pad,
    );
    setPos({ top: rect.bottom + 8, left });
  };
  const hide = () => setPos(null);

  return (
    <>
      <div
        ref={triggerRef}
        className={`info-hint${variant === 'warn' ? ' info-hint--warn' : ''}${label ? '' : ' info-hint--icon-only'}`}
        tabIndex={0}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {label && <span>{label}</span>}
        <span className="info-hint-icon" aria-hidden="true">?</span>
      </div>
      {pos &&
        createPortal(
          <div
            className="info-hint-tooltip"
            role="tooltip"
            style={{ top: pos.top, left: pos.left }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
