import { useEffect, useRef, useState } from 'react';
import type { DiscoverFilterState } from '../../hooks/useDiscoverFilters';
import { formatCategoryLabel } from './discover-filter-util';
import styles from './DiscoverInlineCategoryFilter.module.scss';

type Props = { filters: DiscoverFilterState };

function triggerLabel(filters: DiscoverFilterState): string {
  const size = filters.categorySet.size;
  if (size === 0) return 'Categories';
  if (size === 1) {
    const only = filters.categorySet.values().next().value as string;
    return `Categories: ${formatCategoryLabel(only)}`;
  }
  return `Categories (${size})`;
}

export function DiscoverInlineCategoryFilter({ filters }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const isActive = filters.categorySet.size > 0;
  const isEmpty = filters.availableCategories.length === 0;

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

  // Close popover automatically if data drains and there's nothing to pick.
  useEffect(() => {
    if (isEmpty && open) setOpen(false);
  }, [isEmpty, open]);

  return (
    <div ref={wrapperRef} className={styles.wrapper}>
      <button
        type="button"
        className={`${styles.trigger}${isActive ? ` ${styles.triggerActive}` : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={isEmpty}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{triggerLabel(filters)}</span>
        <svg
          className={`${styles.chevron}${open ? ` ${styles.chevronOpen}` : ''}`}
          width="10" height="6" viewBox="0 0 10 6" fill="none"
          aria-hidden="true"
        >
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className={styles.popover} role="listbox" aria-label="Categories" aria-multiselectable="true">
          <div className={styles.popoverHeader}>
            {isActive && (
              <button
                type="button"
                className={styles.clearBtn}
                onClick={() => filters.clearCategories()}
              >
                Clear
              </button>
            )}
          </div>
          <div className={styles.chipList}>
            {filters.availableCategories.map((c) => {
              const active = filters.categorySet.has(c.toLowerCase());
              return (
                <button
                  key={c}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`${styles.chip}${active ? ` ${styles.chipActive}` : ''}`}
                  onClick={() => filters.toggleCategory(c)}
                >
                  {formatCategoryLabel(c)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
