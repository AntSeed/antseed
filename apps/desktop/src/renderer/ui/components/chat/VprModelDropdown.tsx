import { useState, useRef, useEffect, useMemo } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import type { VprModelCatalogEntry } from '../../../core/state';
import { formatPerMillionPrice } from '../../../core/peer-utils';
import { BrandIcon } from '../brand/BrandIcon';
import styles from './VprModelDropdown.module.scss';

/* The menu shows the most popular models (the catalog is sorted by seller
   count); the full list lives on the Models page via the footer link. */
const TOP_MODEL_COUNT = 8;

type VprModelDropdownProps = {
  catalog: VprModelCatalogEntry[];
  selectedProvider: string;
  selectedServiceId: string;
  /** Trigger label when the selection has no catalog entry (loading, none). */
  fallbackLabel: string;
  disabled: boolean;
  onSelect: (entry: VprModelCatalogEntry) => void;
  onBrowseAll: () => void;
};

function isSelected(entry: VprModelCatalogEntry, provider: string, serviceId: string): boolean {
  return entry.provider === provider && entry.serviceId === serviceId;
}

function priceLabel(entry: VprModelCatalogEntry): string | null {
  if (entry.minInputUsdPerMillion === null) return null;
  if (entry.minInputUsdPerMillion <= 0) return 'Free';
  return `${formatPerMillionPrice(entry.minInputUsdPerMillion)} in`;
}

export function VprModelDropdown({
  catalog,
  selectedProvider,
  selectedServiceId,
  fallbackLabel,
  disabled,
  onSelect,
  onBrowseAll,
}: VprModelDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selectedEntry = useMemo(
    () => catalog.find((entry) => isSelected(entry, selectedProvider, selectedServiceId)) ?? null,
    [catalog, selectedProvider, selectedServiceId],
  );

  // Top models by popularity, with the current selection always present so
  // the active model never disappears from its own switcher.
  const listedEntries = useMemo(() => {
    const top = catalog.slice(0, TOP_MODEL_COUNT);
    if (selectedEntry && !top.includes(selectedEntry)) {
      return [selectedEntry, ...top.slice(0, TOP_MODEL_COUNT - 1)];
    }
    return top;
  }, [catalog, selectedEntry]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const triggerLabel = selectedEntry?.label || fallbackLabel;

  return (
    <div className={styles.modelDropdown} ref={ref}>
      <button
        type="button"
        className={styles.modelDropdownTrigger}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selectedEntry && (
          <BrandIcon name={selectedEntry.provider} hints={[selectedEntry.label]} size={16} />
        )}
        <span className={styles.modelDropdownLabel}>{triggerLabel}</span>
        <HugeiconsIcon icon={ArrowDown01Icon} size={16} strokeWidth={1.5} />
      </button>
      {open && (
        <div className={styles.modelDropdownMenu} role="listbox">
          {listedEntries.map((entry) => {
            const active = isSelected(entry, selectedProvider, selectedServiceId);
            const price = priceLabel(entry);
            return (
              <button
                key={`${entry.provider}${entry.serviceId}`}
                type="button"
                className={`${styles.modelDropdownItem}${active ? ` ${styles.active}` : ''}`}
                role="option"
                aria-selected={active}
                onClick={() => {
                  setOpen(false);
                  if (!active) onSelect(entry);
                }}
              >
                <span className={styles.itemTopRow}>
                  <span className={styles.itemNameGroup}>
                    <BrandIcon name={entry.provider} hints={[entry.label]} size={16} />
                    <span className={styles.itemName}>{entry.label}</span>
                  </span>
                  {price && <span className={styles.itemPricing}>{price}</span>}
                </span>
                <span className={styles.itemMeta}>
                  {entry.peerCount} {entry.peerCount === 1 ? 'seller' : 'sellers'}
                  {entry.expectedSavingsPct !== null && entry.expectedSavingsPct > 0 && (
                    <span className={styles.itemSavings}>save up to {entry.expectedSavingsPct}%</span>
                  )}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            className={styles.modelDropdownFooter}
            onClick={() => {
              setOpen(false);
              onBrowseAll();
            }}
          >
            <span>All models</span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={13} strokeWidth={1.8} />
          </button>
        </div>
      )}
    </div>
  );
}
