import type { JSX } from 'react';
import type { VprModelCatalogEntry } from '../../../core/state';
import { formatPerMillionPrice } from '../../../core/peer-utils';
import { formatCategoryLabel } from '../chat/discover-filter-util';
import styles from './VprModelRows.module.scss';

export type VprModelRowListProps = {
  entries: VprModelCatalogEntry[];
  selectedProvider?: string;
  selectedServiceId?: string;
  onSelect: (provider: string, serviceId: string) => void;
  emptyLabel: string;
  limit?: number;
};

function formatPeerCount(peerCount: number): string {
  return `${peerCount} ${peerCount === 1 ? 'peer' : 'peers'}`;
}

function formatPriceRange(entry: VprModelCatalogEntry): string {
  const minInput = entry.minInputUsdPerMillion;
  const maxInput = entry.maxInputUsdPerMillion;
  const minOutput = entry.minOutputUsdPerMillion;
  const maxOutput = entry.maxOutputUsdPerMillion;

  if (minInput === null && minOutput === null) return 'Price unknown';

  const input = minInput === null
    ? null
    : maxInput !== null && maxInput !== minInput
      ? `${formatPerMillionPrice(minInput)}-${formatPerMillionPrice(maxInput)} in`
      : `${formatPerMillionPrice(minInput)} in`;
  const output = minOutput === null
    ? null
    : maxOutput !== null && maxOutput !== minOutput
      ? `${formatPerMillionPrice(minOutput)}-${formatPerMillionPrice(maxOutput)} out`
      : `${formatPerMillionPrice(minOutput)} out`;

  return [input, output].filter(Boolean).join(' / ');
}

export function VprModelRowList({
  entries,
  selectedProvider,
  selectedServiceId,
  onSelect,
  emptyLabel,
  limit,
}: VprModelRowListProps): JSX.Element {
  if (entries.length === 0) {
    return (
      <div className={styles.empty} role="status">
        {emptyLabel}
      </div>
    );
  }

  const visibleEntries = typeof limit === 'number' ? entries.slice(0, Math.max(0, limit)) : entries;

  return (
    <div className={styles.list}>
      {visibleEntries.map((entry) => {
        const selected = entry.provider === selectedProvider && entry.serviceId === selectedServiceId;
        const rowClassName = `${styles.row}${selected ? ` ${styles.rowSelected}` : ''}`;

        return (
          <button
            key={`${entry.provider}:${entry.serviceId}`}
            type="button"
            className={rowClassName}
            aria-pressed={selected}
            onClick={() => onSelect(entry.provider, entry.serviceId)}
          >
            <span className={styles.primary}>
              <span className={styles.titleLine}>
                <span className={styles.label}>{entry.label}</span>
                <span className={styles.provider}>{entry.provider}</span>
              </span>
              <span className={styles.metaLine}>
                <span>{formatPeerCount(entry.peerCount)}</span>
                {entry.categories.length > 0 && (
                  <span className={styles.chipList} aria-label="Categories">
                    {entry.categories.map((category) => (
                      <span key={category} className={styles.chip}>
                        {formatCategoryLabel(category)}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </span>
            <span className={styles.priceBlock}>
              <span className={styles.price}>{formatPriceRange(entry)}</span>
              {entry.expectedSavingsPct !== null && (
                <span className={styles.savings}>{entry.expectedSavingsPct}% savings</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
