import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const explanation = 'Withdrawing before your lock ends permanently burns part of your staked ANTS (your principal). The percentage depends on the lock time remaining when the withdrawal takes effect, within the configured minimum and maximum. Once the lock has ended, this penalty is zero. The withdrawal preview shows exactly how much is burned and how much you receive. Rewards are claimed separately.';

/** Shared help for early-exit amounts and percentages. Portal avoids clipping in tables and modals. */
export function EarlyExitHelp() {
  const id = useId();
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const keepOpen = () => { clearTimeout(hideTimer.current); };
  const hideSoon = () => { hideTimer.current = setTimeout(() => setPlacement(null), 150); };
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  const trigger = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const show = () => {
    keepOpen();
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const above = rect.bottom + 240 > window.innerHeight;
    setPlacement({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)), top: above ? rect.top - 8 : rect.bottom + 8, above });
  };
  useEffect(() => {
    if (!placement) return;
    const dismiss = () => setPlacement(null);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); dismiss(); }
    };
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    document.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('keydown', key, true);
    };
  }, [placement]);
  return <span className="early-exit-help">
    <button ref={trigger} type="button" className="early-exit-help__trigger" aria-label="About the early-exit penalty" aria-describedby={placement ? id : undefined}
      onMouseEnter={show} onMouseLeave={hideSoon} onFocus={show} onBlur={() => setPlacement(null)} onClick={show}>?</button>
    {placement && createPortal(<span id={id} role="tooltip" className="early-exit-help__tooltip" onMouseEnter={keepOpen} onMouseLeave={hideSoon}
      style={{ left: placement.left, top: placement.top, transform: placement.above ? 'translateY(-100%)' : undefined }}>
      {explanation}
    </span>, document.body)}
  </span>;
}
