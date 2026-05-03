import { useEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import type { DiscoverFilterState } from '../../hooks/useDiscoverFilters';
import { formatCategoryLabel } from './discover-filter-util';
import { getCategoryIcon } from './discover-category-icons';
import styles from './DiscoverInlineCategoryFilter.module.scss';

type Props = { filters: DiscoverFilterState };

/**
 * Curated top categories that surface first whenever they're available in the
 * peer-announced set. Order matters — these render left-to-right before any
 * remaining categories. Picks cover general (chat) + dev (coding) + hard
 * problems (reasoning) + multimodal (vision) + AntSeed's privacy story (anon).
 */
const TOP_CATEGORIES = ['chat', 'coding', 'reasoning', 'vision', 'anon'] as const;
const TOP_LIMIT = 5;

function reorderCategories(available: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const c of available) byKey.set(c.toLowerCase(), c);
  const head: string[] = [];
  const used = new Set<string>();
  for (const key of TOP_CATEGORIES) {
    const original = byKey.get(key);
    if (original) {
      head.push(original);
      used.add(original);
    }
  }
  const tail = available.filter((c) => !used.has(c));
  return [...head, ...tail];
}

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
  const [userExpanded, setUserExpanded] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const isActive = filters.categorySet.size > 0;
  const isEmpty = filters.availableCategories.length === 0;

  const ordered = useMemo(
    () => reorderCategories(filters.availableCategories),
    [filters.availableCategories],
  );

  // Auto-expand if the user has selected anything that lives outside the
  // initial top slice — otherwise selections would be invisible behind the
  // collapse.
  const hasHiddenSelection = useMemo(() => {
    if (ordered.length <= TOP_LIMIT) return false;
    return ordered.slice(TOP_LIMIT).some((c) => filters.categorySet.has(c.toLowerCase()));
  }, [ordered, filters.categorySet]);

  const expanded = userExpanded || hasHiddenSelection;
  const canExpand = ordered.length > TOP_LIMIT;
  const visible = expanded || !canExpand ? ordered : ordered.slice(0, TOP_LIMIT);
  const hiddenCount = ordered.length - TOP_LIMIT;

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
            {visible.map((c) => {
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
                  <HugeiconsIcon
                    icon={getCategoryIcon(c)}
                    size={12}
                    strokeWidth={1.5}
                    className={styles.chipIcon}
                  />
                  {formatCategoryLabel(c)}
                </button>
              );
            })}
            {canExpand && (
              <button
                type="button"
                className={styles.showMore}
                onClick={() => setUserExpanded((v) => !v)}
                aria-expanded={expanded}
              >
                <span>{expanded ? 'Show less' : `+${hiddenCount} more`}</span>
                <svg
                  className={`${styles.showMoreChevron}${expanded ? ` ${styles.showMoreChevronOpen}` : ''}`}
                  width="9" height="6" viewBox="0 0 10 6" fill="none"
                  aria-hidden="true"
                >
                  <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
