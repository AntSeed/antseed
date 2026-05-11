import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  /** Plain text body. Empty string disables the tooltip when no other content is given. */
  text?: string;
  /** Rich body content. Takes precedence over `text` when both are given. */
  body?: ReactNode;
  /** Optional bold title shown above the body. */
  title?: string;
  /** Trigger element. */
  children: ReactNode;
  /** Width cap in px. Defaults to 240. */
  maxWidth?: number;
  /** Class applied to the trigger wrap. Defaults to `tooltip-wrap`. */
  wrapClassName?: string;
  /** Class applied to the portaled card. Defaults to `tooltip-card`. */
  cardClassName?: string;
  /** Class for the optional title element. */
  titleClassName?: string;
  /** Class for the body wrapper. If omitted, body/text render directly inside the card. */
  bodyClassName?: string;
  /** Make the trigger wrap focusable. Useful when wrapping non-interactive content. */
  tabIndex?: number;
}

/**
 * Portal-based hover tooltip. Variants are opt-in via `cardClassName` /
 * `wrapClassName` so callers can keep their own visual styling while sharing
 * the positioning and lifecycle logic.
 */
export function Tooltip({
  text,
  body,
  title,
  children,
  maxWidth = 240,
  wrapClassName = 'tooltip-wrap',
  cardClassName = 'tooltip-card',
  titleClassName = 'tooltip-card-title',
  bodyClassName,
  tabIndex,
}: TooltipProps) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const hasContent = Boolean(title || body || text);

  const show = () => {
    if (!hasContent) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pad = 12;
    const centered = rect.left + rect.width / 2 - maxWidth / 2;
    const left = Math.min(
      Math.max(pad, centered),
      window.innerWidth - maxWidth - pad,
    );
    setPos({ top: rect.bottom + 8, left, width: maxWidth });
  };
  const hide = () => setPos(null);

  const renderedBody = body ?? text;

  return (
    <>
      <span
        ref={wrapRef}
        className={wrapClassName}
        tabIndex={tabIndex}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {pos &&
        createPortal(
          <div
            className={cardClassName}
            role="tooltip"
            style={{ top: pos.top, left: pos.left, width: pos.width }}
          >
            {title && <div className={titleClassName}>{title}</div>}
            {renderedBody != null && (
              bodyClassName ? <div className={bodyClassName}>{renderedBody}</div> : renderedBody
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
