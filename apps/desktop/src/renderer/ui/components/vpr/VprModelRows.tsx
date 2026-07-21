import type { JSX } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import type { VprModelCatalogEntry } from '../../../core/state';
import { formatCategoryLabel } from '../chat/discover-filter-util';
import { BrandIcon } from '../brand/BrandIcon';
import { formatUsdShort, VprBadge } from './VprKit';
import styles from './VprModelRows.module.scss';

export type VprModelRowListProps = {
  entries: VprModelCatalogEntry[];
  selectedProvider?: string;
  selectedServiceId?: string;
  onSelect: (provider: string, serviceId: string) => void;
  emptyLabel: string;
  limit?: number;
  /** Drop the card chrome (bg/radius/shadow) — for hosts that provide their
   * own panel, e.g. the Home model dropdown. */
  frameless?: boolean;
};

function entryMinTotalPrice(entry: VprModelCatalogEntry): number | null {
  if (entry.minInputUsdPerMillion === null || entry.minOutputUsdPerMillion === null) return null;
  return entry.minInputUsdPerMillion + entry.minOutputUsdPerMillion;
}

function isFreeEntry(entry: VprModelCatalogEntry): boolean {
  const { minInputUsdPerMillion: input, minOutputUsdPerMillion: output } = entry;
  return input !== null && output !== null && input <= 0 && output <= 0;
}

function priceRangeLabel(entry: VprModelCatalogEntry): string | null {
  const min = entry.minInputUsdPerMillion;
  const max = entry.maxInputUsdPerMillion;
  if (min === null) return null;
  if (max !== null && max !== min) {
    return `${formatUsdShort(min)}-${formatUsdShort(max)}`;
  }
  return formatUsdShort(min);
}

function ModelRow({ entry, checked, badge, onClick }: {
  entry: VprModelCatalogEntry;
  /** Leading checkmark for the currently selected model (Figma "model list" checked state). */
  checked?: boolean;
  badge?: JSX.Element | null;
  onClick: () => void;
}): JSX.Element {
  const free = isFreeEntry(entry);
  const price = priceRangeLabel(entry);
  const baseline = entry.baselineInputUsdPerMillion ?? null;

  return (
    <button
      type="button"
      className={`${styles.row}${checked ? ` ${styles.rowChecked}` : ''}`}
      aria-pressed={checked}
      onClick={onClick}
    >
      {checked && (
        <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={2} className={styles.check} />
      )}
      <span className={styles.rowMain}>
        <span className={styles.titleLine}>
          <BrandIcon name={entry.provider} hints={[entry.label]} size={16} className={styles.logo} />
          <span className={styles.label}>{entry.label}</span>
          {badge}
        </span>
        <span className={styles.metaLine}>
          {entry.peerCount} {entry.peerCount === 1 ? 'peer' : 'peers'}
          {entry.categories.length > 0 && (
            <>
              {' | '}
              {entry.categories.map((category) => formatCategoryLabel(category)).join(', ')}
            </>
          )}
        </span>
      </span>
      <span className={styles.priceBlock}>
        {free ? (
          <span className={styles.perTok}>Free</span>
        ) : price !== null ? (
          <>
            <span className={styles.priceLine}>
              {baseline !== null && <s className={styles.baseline}>{formatUsdShort(baseline)}</s>}
              <span className={styles.price}>{price}</span>
            </span>
            <span className={styles.perTok}>/m tok</span>
          </>
        ) : (
          <span className={styles.perTok}>Price unknown</span>
        )}
      </span>
      <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={styles.chevron} />
    </button>
  );
}

/** The currently selected model as a standalone card pinned above the list
 * (Figma: checked "model list" row with the "• Auto" badge). */
export function VprSelectedModelCard({ entry, auto, onClick }: {
  entry: VprModelCatalogEntry;
  /** Whether seller routing for the model is in auto mode. */
  auto: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <div className={styles.list}>
      <ModelRow
        entry={entry}
        checked
        badge={<VprBadge tone="primary">{auto ? '• Auto' : 'Pinned'}</VprBadge>}
        onClick={onClick}
      />
    </div>
  );
}

export function VprModelRowList({
  entries,
  selectedProvider,
  selectedServiceId,
  onSelect,
  emptyLabel,
  limit,
  frameless,
}: VprModelRowListProps): JSX.Element {
  if (entries.length === 0) {
    return (
      <div className={styles.empty} role="status">
        {emptyLabel}
      </div>
    );
  }

  const visibleEntries = typeof limit === 'number' ? entries.slice(0, Math.max(0, limit)) : entries;

  // The single cheapest priced entry in the visible list gets the badge.
  let cheapestKey: string | null = null;
  if (visibleEntries.length > 1) {
    let cheapestPrice = Infinity;
    for (const entry of visibleEntries) {
      const price = entryMinTotalPrice(entry);
      if (price !== null && price < cheapestPrice) {
        cheapestPrice = price;
        cheapestKey = `${entry.provider}:${entry.serviceId}`;
      }
    }
  }

  return (
    <div className={frameless ? styles.listBare : styles.list}>
      {visibleEntries.map((entry) => {
        const key = `${entry.provider}:${entry.serviceId}`;
        const selected = entry.provider === selectedProvider && entry.serviceId === selectedServiceId;
        const free = isFreeEntry(entry);

        return (
          <ModelRow
            key={key}
            entry={entry}
            checked={selected}
            badge={free ? (
              <VprBadge tone="green">Free</VprBadge>
            ) : key === cheapestKey ? (
              <VprBadge tone="green">Cheapest</VprBadge>
            ) : null}
            onClick={() => onSelect(entry.provider, entry.serviceId)}
          />
        );
      })}
    </div>
  );
}
