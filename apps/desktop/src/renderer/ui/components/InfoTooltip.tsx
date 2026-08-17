import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './InfoTooltip.module.scss';

/**
 * Shared hover/focus popover used wherever we need a richer description than
 * a native `title` attribute can carry \u2014 currently:
 *
 *   - the reputation score badge on Discover cards
 *   - the known-proxy identification badge on Discover cards
 *   - the known-proxy icon in the Discover peer-filter list
 *   - the known-proxy icon in the chat sidebar per-peer header
 *
 * Behaviour mirrors the original ad-hoc reputation tooltip:
 *
 *   - `position: fixed` so the panel can escape any clipped ancestor
 *     (`overflow: hidden` on card grids, scroll containers, etc.).
 *   - Viewport clamped on both axes with an 8px gap + 12px margin.
 *   - Flips above/below the trigger based on which side has more room.
 *   - `align` decides which edge of the panel anchors to which edge of the
 *     trigger \u2014 `'left'` for affordances near the left of a row,
 *     `'right'` for ones near the right (e.g. the score badge on a card
 *     footer).
 *   - Reposition listeners only attach while open, so we don't pay for
 *     resize/scroll handling on every tooltip in the tree.
 *
 * The trigger is passed as a single React element child. We clone it to
 * inject a ref + the hover/focus handlers; if the child already has its own
 * handlers we wrap them so both fire (so e.g. `onClick={(e) => e.stopPropagation()}`
 * on the trigger keeps working).
 */

const VIEWPORT_MARGIN_PX = 12;
const TRIGGER_GAP_PX = 8;
const FALLBACK_WIDTH_PX = 260;

export type InfoTooltipAlign = 'left' | 'right';

type TriggerProps = {
  ref?: React.Ref<HTMLElement>;
  onMouseEnter?: (e: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (e: MouseEvent<HTMLElement>) => void;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onBlur?: (e: FocusEvent<HTMLElement>) => void;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  'aria-describedby'?: string;
  'aria-controls'?: string;
  'aria-expanded'?: boolean;
};

export type InfoTooltipProps = {
  /** Tooltip body. Pass `<strong>Title</strong><span>Description</span>` to
   *  match the existing visual hierarchy (bold heading, muted body). */
  content: ReactNode;
  /** Which edge of the panel anchors to which edge of the trigger. */
  align?: InfoTooltipAlign;
  /** Wider panel for structured content such as a balance breakdown. */
  wide?: boolean;
  /** Narrow panel for short labels or compact lists. */
  narrow?: boolean;
  /** Keep the panel usable on hover and allow click-to-pin behavior. */
  interactive?: boolean;
  /**
   * The trigger element. Must be a single React element that accepts a
   * `ref` to an HTMLElement (DOM elements all do; custom components need
   * to forwardRef).
   */
  children: ReactElement;
};

export function InfoTooltip({ content, align = 'right', wide = false, narrow = false, interactive = false, children }: InfoTooltipProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const pinnedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ left: 0, top: 0 });
  const tooltipId = useId();

  const reposition = useCallback(() => {
    if (typeof window === 'undefined') return;
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;

    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const tooltipWidth = tooltipRect.width || FALLBACK_WIDTH_PX;
    const tooltipHeight = tooltipRect.height || 0;

    const maxLeft = Math.max(VIEWPORT_MARGIN_PX, window.innerWidth - tooltipWidth - VIEWPORT_MARGIN_PX);
    const desiredLeft = align === 'right'
      ? triggerRect.right - tooltipWidth   // right edge of panel == right edge of trigger
      : triggerRect.left;                  // left edge of panel  == left edge of trigger
    const left = Math.min(Math.max(VIEWPORT_MARGIN_PX, desiredLeft), maxLeft);

    const spaceAbove = triggerRect.top - VIEWPORT_MARGIN_PX - TRIGGER_GAP_PX;
    const spaceBelow = window.innerHeight - triggerRect.bottom - VIEWPORT_MARGIN_PX - TRIGGER_GAP_PX;
    const placeAbove = spaceAbove >= tooltipHeight || spaceAbove >= spaceBelow;
    const top = placeAbove
      ? Math.max(VIEWPORT_MARGIN_PX, triggerRect.top - tooltipHeight - TRIGGER_GAP_PX)
      : Math.max(
          VIEWPORT_MARGIN_PX,
          Math.min(window.innerHeight - tooltipHeight - VIEWPORT_MARGIN_PX, triggerRect.bottom + TRIGGER_GAP_PX),
        );

    setStyle({ left, top });
  }, [align]);

  const show = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setOpen(true);
    requestAnimationFrame(reposition);
  }, [reposition]);

  const hide = useCallback(() => {
    pinnedRef.current = false;
    setOpen(false);
  }, []);

  const scheduleHide = useCallback(() => {
    if (!interactive || pinnedRef.current) return;
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 120);
  }, [interactive]);

  // Reposition on resize/scroll only while the tooltip is open. Scroll
  // capture-phase so we catch scrolls in any ancestor, not just window.
  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open || !interactive) return undefined;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !tooltipRef.current?.contains(target)) hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [hide, interactive, open]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  if (!isValidElement(children)) {
    // Defensive: render the children as-is rather than crashing if the
    // caller passes something we can't clone (e.g. a fragment or string).
    return <>{children}</>;
  }

  // Clone the trigger to attach our ref + handlers. Existing handlers on
  // the child run too, so callers can still e.g. `onClick={stopPropagation}`.
  const child = children as ReactElement<TriggerProps>;
  const childProps = child.props as TriggerProps;
  const triggerNode = cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      // Forward to any existing ref on the child. React's typing for
      // `child.ref` is a private field, so we feature-detect with `as any`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = (child as unknown as { ref?: React.Ref<HTMLElement> }).ref;
      if (typeof existing === 'function') existing(node);
      else if (existing && typeof existing === 'object') {
        (existing as React.MutableRefObject<HTMLElement | null>).current = node;
      }
    },
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      childProps.onMouseEnter?.(e);
      show();
    },
    onMouseLeave: (e: MouseEvent<HTMLElement>) => {
      childProps.onMouseLeave?.(e);
      if (interactive) scheduleHide();
      else hide();
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      childProps.onFocus?.(e);
      show();
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      childProps.onBlur?.(e);
      if (interactive) scheduleHide();
      else hide();
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      childProps.onClick?.(e);
      if (!interactive) return;
      if (pinnedRef.current) {
        hide();
        return;
      }
      pinnedRef.current = true;
      show();
    },
    'aria-describedby': tooltipId,
    ...(interactive ? { 'aria-controls': tooltipId, 'aria-expanded': open } : {}),
  });

  return (
    <>
      {triggerNode}
      {typeof document !== 'undefined' && createPortal(
        <div
          ref={tooltipRef}
          id={tooltipId}
          role={interactive ? 'dialog' : 'tooltip'}
          className={[
            styles.tooltip,
            wide ? styles.tooltipWide : '',
            narrow ? styles.tooltipNarrow : '',
            interactive ? styles.tooltipInteractive : '',
            open ? styles.tooltipOpen : '',
          ].filter(Boolean).join(' ')}
          style={style}
          onMouseEnter={interactive ? show : undefined}
          onMouseLeave={interactive ? scheduleHide : undefined}
          onPointerDown={interactive ? (event: PointerEvent<HTMLDivElement>) => event.stopPropagation() : undefined}
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
