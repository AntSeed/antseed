import type { JSX } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon, StarIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import type { VprModelCatalogEntry } from '../../../core/state';
import { formatCategoryLabel } from '../chat/discover-filter-util';
import { favoriteModelKey } from '../../../modules/vpr-favorites';
import { sameCanonicalModel } from '../../../modules/model-identity';
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
  /** `provider:serviceId` keys of user-starred models — matching rows get a
   * star so favorites read apart from the recommended lineup. */
  favoriteKeys?: ReadonlySet<string>;
  /** Drop the card chrome (bg/radius/shadow) — for hosts that provide their
   * own panel, e.g. the Home model dropdown. */
  frameless?: boolean;
  /** Narrow-host layout (the floating pill): the price joins the meta line
   * under the name and the trailing chevron is dropped, so the model name
   * keeps the full row width instead of truncating after a few characters. */
  compact?: boolean;
  /** Rows only pick a model instead of drilling into its page (the Home
   * dropdown, the chat model pickers) — the trailing chevron is dropped so
   * the row doesn't promise a navigation that never happens. */
  selectOnly?: boolean;
  /** Seller names for models pinned to one peer, keyed `provider:serviceId`.
   * A matching row swaps its peer count for the seller, so a non-auto route is
   * visible without opening the model page. */
  pinnedPeerLabels?: ReadonlyMap<string, string>;
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

function ModelRow({ entry, checked, favorite, badge, compact, chevron = true, pinnedPeerLabel, onClick }: {
  entry: VprModelCatalogEntry;
  /** Leading checkmark for the currently selected model (Figma "model list" checked state). */
  checked?: boolean;
  favorite?: boolean;
  badge?: JSX.Element | null;
  compact?: boolean;
  /** Trailing right chevron — only for rows that open the model page. */
  chevron?: boolean;
  /** Seller this model is pinned to; replaces the peer count on the meta line. */
  pinnedPeerLabel?: string | null;
  onClick: () => void;
}): JSX.Element {
  const free = isFreeEntry(entry);
  const price = priceRangeLabel(entry);
  const baseline = entry.baselineInputUsdPerMillion ?? null;

  const priceParts = free ? (
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
  );

  return (
    <button
      type="button"
      className={[
        styles.row,
        checked ? styles.rowChecked : '',
        compact ? styles.rowCompact : '',
      ].filter(Boolean).join(' ')}
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
          {favorite && (
            <HugeiconsIcon icon={StarIcon} size={13} strokeWidth={2} className={styles.favStar} />
          )}
          {badge}
        </span>
        <span className={styles.metaLine}>
          {/* A pinned seller is the whole story of where the model routes —
              the seller's name replaces the peer count, unlabelled: naming a
              peer already says routing isn't on auto. */}
          {pinnedPeerLabel ? (
            <span className={styles.pinnedSeller}>{pinnedPeerLabel}</span>
          ) : (
            `${entry.peerCount} ${entry.peerCount === 1 ? 'peer' : 'peers'}`
          )}
          {/* Compact rows trade the category tags for the price, which no
              longer has a column of its own. */}
          {compact ? (
            <span className={styles.metaPrice}>{priceParts}</span>
          ) : entry.categories.length > 0 && (
            <>
              {' | '}
              {entry.categories.map((category) => formatCategoryLabel(category)).join(', ')}
            </>
          )}
        </span>
      </span>
      {!compact && (
        <>
          <span className={styles.priceBlock}>{priceParts}</span>
          {chevron && (
            <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={styles.chevron} />
          )}
        </>
      )}
    </button>
  );
}

/** The currently selected model as a standalone card pinned above the list
 * (Figma: checked "model list" row with the "• Auto" badge). */
export function VprSelectedModelCard({ entry, auto, pinnedPeerLabel, onClick }: {
  entry: VprModelCatalogEntry;
  /** Whether seller routing for the model is in auto mode. */
  auto: boolean;
  /** Seller the model is pinned to, shown in place of the peer count. */
  pinnedPeerLabel?: string | null;
  onClick: () => void;
}): JSX.Element {
  return (
    <div className={styles.list}>
      <ModelRow
        entry={entry}
        checked
        badge={<VprBadge tone="primary">{auto ? '• Auto' : 'Pinned'}</VprBadge>}
        pinnedPeerLabel={auto ? null : pinnedPeerLabel}
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
  favoriteKeys,
  frameless,
  compact,
  selectOnly,
  pinnedPeerLabels,
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
        const selected = Boolean(selectedServiceId) && (
          (entry.provider === selectedProvider && entry.serviceId === selectedServiceId)
          || sameCanonicalModel(entry.serviceId, selectedServiceId ?? '')
        );
        const free = isFreeEntry(entry);
        // Pins are per model, so any row can name a seller — not just the
        // selected one.
        const pinned = pinnedPeerLabels?.get(key) ?? null;

        return (
          <ModelRow
            key={key}
            entry={entry}
            checked={selected}
            compact={compact}
            chevron={!selectOnly}
            pinnedPeerLabel={pinned}
            favorite={favoriteKeys?.has(favoriteModelKey(entry.provider, entry.serviceId))}
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
