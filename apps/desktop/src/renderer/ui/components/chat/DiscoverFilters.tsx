import { memo } from 'react';
import type { DiscoverFilterState } from '../../hooks/useDiscoverFilters';
import type { DiscoverPriceBucket } from './discover-filter-util';
import styles from './DiscoverFilters.module.scss';

type Props = {
  filters: DiscoverFilterState;
};

const PRICE_OPTIONS: Array<{ key: DiscoverPriceBucket; label: string }> = [
  { key: 'any',  label: 'Any' },
  { key: 'free', label: 'Free' },
  { key: 'lt1',  label: 'Less than $1/M' },
  { key: '1to5', label: '$1–$5/M' },
  { key: 'gt5',  label: 'More than $5/M' },
];

export const DiscoverFilters = memo(function DiscoverFilters({ filters }: Props) {
  return (
    <aside className={styles.filters}>
      {/* Search */}
      <div className={styles.field}>
        <div className={styles.label}>Search</div>
        <div className={styles.searchBox}>
          <svg
            className={styles.searchIcon}
            width="14" height="14" viewBox="0 0 16 16" fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M11 11L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <input
            type="text"
            className={styles.searchInput}
            value={filters.search}
            onChange={(e) => filters.setSearch(e.target.value)}
            placeholder="Service, peer, category…"
          />
        </div>
      </div>

      {/* Categories — vertical checkbox list, internal scroll if long */}
      {filters.availableCategories.length > 0 && (
        <div className={`${styles.field} ${styles.fieldCategories}`}>
          <div className={styles.label}>Categories</div>
          <div className={styles.listScroll}>
            {filters.availableCategories.map((c) => {
              const active = filters.categorySet.has(c.toLowerCase());
              return (
                <label key={c} className={styles.listItem}>
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => filters.toggleCategory(c)}
                  />
                  <span>{c}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* Price bucket — vertical radio list */}
      <div className={styles.field}>
        <div className={styles.label}>Price (input)</div>
        <div className={styles.list}>
          {PRICE_OPTIONS.map((o) => (
            <label key={o.key} className={styles.listItem}>
              <input
                type="radio"
                name="discover-price"
                checked={filters.priceBucket === o.key}
                onChange={() => filters.setPriceBucket(o.key)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Toggles */}
      <label className={styles.listItem}>
        <input
          type="checkbox"
          checked={filters.cachedOnly}
          onChange={(e) => filters.setCachedOnly(e.target.checked)}
        />
        <span>Supports prompt caching</span>
      </label>

      <label className={styles.listItem}>
        <input
          type="checkbox"
          checked={filters.chattedOnly}
          onChange={(e) => filters.setChattedOnly(e.target.checked)}
        />
        <span>Only peers I've chatted with</span>
      </label>

      {/* Min stake */}
      <div className={styles.field}>
        <div className={styles.label}>Min stake (USDC)</div>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="1"
          className={styles.numberInput}
          value={filters.minStakeUsdc}
          onChange={(e) => filters.setMinStakeUsdc(e.target.value)}
          placeholder="e.g. 100"
        />
      </div>

      {/* Reset */}
      <button type="button" className={styles.resetBtn} onClick={filters.resetAll}>
        Reset all
      </button>
    </aside>
  );
});
