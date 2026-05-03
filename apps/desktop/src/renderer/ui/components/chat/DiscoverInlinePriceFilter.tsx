import { useEffect, useRef, useState } from 'react';
import type { DiscoverFilterState } from '../../hooks/useDiscoverFilters';
import {
  PRICE_PRESETS,
  matchPricePreset,
  type PricePresetId,
} from './discover-filter-util';
import styles from './DiscoverInlinePriceFilter.module.scss';

type Props = { filters: DiscoverFilterState };

function triggerLabel(currentId: PricePresetId | 'custom'): string {
  if (currentId === 'any') return 'Price';
  if (currentId === 'custom') return 'Price: Custom';
  const preset = PRICE_PRESETS.find((p) => p.id === currentId)!;
  return `Price: ${preset.label}`;
}

export function DiscoverInlinePriceFilter({ filters }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const currentId = matchPricePreset(filters.maxInputPrice, filters.maxOutputPrice);
  const isActive = currentId !== 'any';

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selectPreset = (cap: number) => {
    filters.setMaxInputPrice(cap);
    filters.setMaxOutputPrice(cap);
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} className={styles.wrapper}>
      <button
        type="button"
        className={`${styles.trigger}${isActive ? ` ${styles.triggerActive}` : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{triggerLabel(currentId)}</span>
        <svg
          className={`${styles.chevron}${open ? ` ${styles.chevronOpen}` : ''}`}
          width="10" height="6" viewBox="0 0 10 6" fill="none"
          aria-hidden="true"
        >
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className={styles.popover} role="listbox" aria-label="Price preset">
          {PRICE_PRESETS.map((p) => {
            const selected = currentId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={selected}
                className={`${styles.option}${selected ? ` ${styles.optionSelected}` : ''}`}
                onClick={() => selectPreset(p.cap)}
              >
                <span className={`${styles.radio}${selected ? ` ${styles.radioSelected}` : ''}`} aria-hidden="true" />
                <span>{p.label}</span>
              </button>
            );
          })}
          {currentId === 'custom' && (
            <div className={styles.customRow} aria-live="polite">
              Custom: input ≤ ${filters.maxInputPrice.toFixed(2)}/M, output ≤ ${filters.maxOutputPrice.toFixed(2)}/M
            </div>
          )}
        </div>
      )}
    </div>
  );
}
