import { memo } from 'react';
import type { DiscoverFilterState } from '../../hooks/useDiscoverFilters';
import {
  MAX_INPUT_PRICE_SLIDER_USD, INPUT_PRICE_SLIDER_STEP,
  MAX_OUTPUT_PRICE_SLIDER_USD, OUTPUT_PRICE_SLIDER_STEP,
  MAX_CHANNELS_SLIDER, CHANNELS_SLIDER_STEP,
  MAX_REQUESTS_SLIDER, REQUESTS_SLIDER_STEP,
  MAX_TOKENS_SLIDER, TOKENS_SLIDER_STEP,
  type TimeWindow,
} from './discover-filter-util';
import styles from './DiscoverFilters.module.scss';

type Props = {
  filters: DiscoverFilterState;
};

function formatPriceLabel(value: number, max: number): string {
  if (value >= max) return 'Any';
  if (value === 0) return 'Free only';
  return `Up to $${value.toFixed(2)}/M`;
}

function formatChannelsLabel(value: number): string {
  if (value <= 0) return 'Any';
  if (value >= MAX_CHANNELS_SLIDER) return `${MAX_CHANNELS_SLIDER}+`;
  return `${value}+`;
}

function formatRequestsLabel(value: number): string {
  if (value <= 0) return 'Any';
  if (value >= MAX_REQUESTS_SLIDER) return `${MAX_REQUESTS_SLIDER}+`;
  return `${value}+`;
}

function formatTokensLabel(value: number): string {
  if (value <= 0) return 'Any';
  const suffix = value >= MAX_TOKENS_SLIDER ? '+' : '+';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M${suffix}`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K${suffix}`;
  return `${value}${suffix}`;
}

const TIME_WINDOW_OPTIONS: ReadonlyArray<{ value: TimeWindow; label: string }> = [
  { value: 'any', label: 'Any time' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
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

      {/* Categories */}
      {filters.availableCategories.length > 0 && (
        <div className={`${styles.field} ${styles.fieldCategories}`}>
          <div className={styles.label}>Categories</div>
          <div className={styles.tagList}>
            {filters.availableCategories.map((c) => {
              const active = filters.categorySet.has(c.toLowerCase());
              return (
                <button
                  key={c}
                  type="button"
                  className={`${styles.tag} ${active ? styles.tagActive : ''}`}
                  onClick={() => filters.toggleCategory(c)}
                >
                  {c}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Input price per million slider */}
      <div className={styles.field}>
        <div className={styles.sliderHeader}>
          <span className={styles.label}>Input price / M</span>
          <span className={styles.sliderValue}>
            {formatPriceLabel(filters.maxInputPrice, MAX_INPUT_PRICE_SLIDER_USD)}
          </span>
        </div>
        <div className={styles.sliderWrapper}>
          <input
            type="range"
            className={styles.slider}
            min={0}
            max={MAX_INPUT_PRICE_SLIDER_USD}
            step={INPUT_PRICE_SLIDER_STEP}
            value={filters.maxInputPrice}
            onChange={(e) => filters.setMaxInputPrice(Number(e.target.value))}
          />
        </div>
      </div>

      {/* Output price per million slider */}
      <div className={styles.field}>
        <div className={styles.sliderHeader}>
          <span className={styles.label}>Output price / M</span>
          <span className={styles.sliderValue}>
            {formatPriceLabel(filters.maxOutputPrice, MAX_OUTPUT_PRICE_SLIDER_USD)}
          </span>
        </div>
        <div className={styles.sliderWrapper}>
          <input
            type="range"
            className={styles.slider}
            min={0}
            max={MAX_OUTPUT_PRICE_SLIDER_USD}
            step={OUTPUT_PRICE_SLIDER_STEP}
            value={filters.maxOutputPrice}
            onChange={(e) => filters.setMaxOutputPrice(Number(e.target.value))}
          />
        </div>
      </div>

      {/* Service-level toggle */}
      <label className={styles.listItem}>
        <input
          type="checkbox"
          checked={filters.cachedOnly}
          onChange={(e) => filters.setCachedOnly(e.target.checked)}
        />
        <span>Supports prompt caching</span>
      </label>

      {/* ── Peer subsection ─────────────────────────────────────────── */}
      <div className={styles.sectionHeader} />

      {/* Min channels served slider */}
      <div className={styles.field}>
        <div className={styles.sliderHeader}>
          <span className={styles.label}>Channels served</span>
          <span className={styles.sliderValue}>{formatChannelsLabel(filters.minChannels)}</span>
        </div>
        <div className={styles.sliderWrapper}>
          <input
            type="range"
            className={styles.slider}
            min={0}
            max={MAX_CHANNELS_SLIDER}
            step={CHANNELS_SLIDER_STEP}
            value={filters.minChannels}
            onChange={(e) => filters.setMinChannels(Number(e.target.value))}
          />
        </div>
      </div>

      {/* Min requests served slider */}
      <div className={styles.field}>
        <div className={styles.sliderHeader}>
          <span className={styles.label}>Requests served</span>
          <span className={styles.sliderValue}>{formatRequestsLabel(filters.minRequests)}</span>
        </div>
        <div className={styles.sliderWrapper}>
          <input
            type="range"
            className={styles.slider}
            min={0}
            max={MAX_REQUESTS_SLIDER}
            step={REQUESTS_SLIDER_STEP}
            value={filters.minRequests}
            onChange={(e) => filters.setMinRequests(Number(e.target.value))}
          />
        </div>
      </div>

      {/* Min tokens served slider */}
      <div className={styles.field}>
        <div className={styles.sliderHeader}>
          <span className={styles.label}>Tokens served</span>
          <span className={styles.sliderValue}>{formatTokensLabel(filters.minTokens)}</span>
        </div>
        <div className={styles.sliderWrapper}>
          <input
            type="range"
            className={styles.slider}
            min={0}
            max={MAX_TOKENS_SLIDER}
            step={TOKENS_SLIDER_STEP}
            value={filters.minTokens}
            onChange={(e) => filters.setMinTokens(Number(e.target.value))}
          />
        </div>
      </div>

      {/* Last seen window */}
      <div className={styles.field}>
        <div className={styles.label}>Last seen</div>
        <select
          className={styles.select}
          value={filters.lastSeenWindow}
          onChange={(e) => filters.setLastSeenWindow(e.target.value as TimeWindow)}
        >
          {TIME_WINDOW_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Last settled window */}
      <div className={styles.field}>
        <div className={styles.label}>Last settled</div>
        <select
          className={styles.select}
          value={filters.lastSettledWindow}
          onChange={(e) => filters.setLastSettledWindow(e.target.value as TimeWindow)}
        >
          {TIME_WINDOW_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <label className={styles.listItem}>
        <input
          type="checkbox"
          checked={filters.chattedOnly}
          onChange={(e) => filters.setChattedOnly(e.target.checked)}
        />
        <span>Previously used</span>
      </label>

      {/* Reset */}
      <button type="button" className={styles.resetBtn} onClick={filters.resetAll}>
        Reset all
      </button>
    </aside>
  );
});
