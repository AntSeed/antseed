import { memo } from 'react';
import type { DiscoverFilterState } from '../../hooks/useDiscoverFilters';
import { getTagOutlineTint } from '../../../core/peer-utils';
import {
  MAX_INPUT_PRICE_SLIDER_USD, INPUT_PRICE_SLIDER_STEP,
  MAX_OUTPUT_PRICE_SLIDER_USD, OUTPUT_PRICE_SLIDER_STEP,
  MAX_CHANNELS_SLIDER, CHANNELS_SLIDER_STEP,
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
  return `${value}+ channels`;
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
      {/* Peers */}
      {filters.availablePeers.length > 0 && (
        <div className={`${styles.field} ${styles.fieldPeers}`}>
          <div className={styles.label}>Peers</div>
          <div className={styles.peerList}>
            {filters.availablePeers.map((p) => {
              const active = filters.peerSet.has(p.peerId);
              return (
                <button
                  key={p.peerId}
                  type="button"
                  className={`${styles.peerRow} ${active ? styles.peerRowActive : ''}`}
                  onClick={() => filters.togglePeer(p.peerId)}
                  aria-pressed={active}
                  title={p.peerId}
                >
                  <span className={styles.peerAvatar} style={{ background: p.gradient }}>
                    {p.letter}
                  </span>
                  <span className={styles.peerLabel}>{p.label}</span>
                  {active && (
                    <svg
                      className={styles.peerCheck}
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M3.5 8.5L6.5 11.5L12.5 5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

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
                  style={active ? undefined : getTagOutlineTint(c)}
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

      {/* On-chain channel count: simple proxy for whether a peer has a track record. */}
      <div className={styles.field}>
        <div className={styles.sliderHeader}>
          <span className={styles.label}>On-chain channels</span>
          <span className={styles.sliderValue}>{formatChannelsLabel(filters.minOnChainChannels)}</span>
        </div>
        <div className={styles.sliderWrapper}>
          <input
            type="range"
            className={styles.slider}
            min={0}
            max={MAX_CHANNELS_SLIDER}
            step={CHANNELS_SLIDER_STEP}
            value={filters.minOnChainChannels}
            onChange={(e) => filters.setMinOnChainChannels(Number(e.target.value))}
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
