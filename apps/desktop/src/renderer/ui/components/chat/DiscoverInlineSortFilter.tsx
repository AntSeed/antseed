import { useEffect, useRef, useState } from 'react';
import type { DiscoverFilterState } from '../../hooks/useDiscoverFilters';
import { SORT_OPTIONS, type DiscoverSortKey } from './discover-filter-util';
import styles from './DiscoverInlineSortFilter.module.scss';

type Props = { filters: DiscoverFilterState };

export function DiscoverInlineSortFilter({ filters }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const current =
    SORT_OPTIONS.find((o) => o.key === filters.sortKey) ?? SORT_OPTIONS[0];

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

  const select = (key: DiscoverSortKey) => {
    filters.setSortKey(key);
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} className={styles.wrapper}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Sort: ${current.label}`}
      >
        <span>{current.label}</span>
        <svg
          className={`${styles.chevron}${open ? ` ${styles.chevronOpen}` : ''}`}
          width="10" height="6" viewBox="0 0 10 6" fill="none"
          aria-hidden="true"
        >
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className={styles.popover} role="listbox" aria-label="Sort">
          {SORT_OPTIONS.map((opt) => {
            const active = opt.key === filters.sortKey;
            return (
              <button
                key={opt.key}
                type="button"
                role="option"
                aria-selected={active}
                className={`${styles.option}${active ? ` ${styles.optionActive}` : ''}`}
                onClick={() => select(opt.key)}
              >
                <span className={styles.checkSlot} aria-hidden="true">
                  {active && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M2 6.5L4.75 9L10 3.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className={styles.optionLabel}>{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
