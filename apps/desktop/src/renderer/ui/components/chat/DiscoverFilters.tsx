import { memo, useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { HugeiconsIcon } from '@hugeicons/react';
import { FilterResetIcon } from '@hugeicons/core-free-icons';
import type { DiscoverFilterState } from '../../hooks/useDiscoverFilters';
import { getCategoryIcon } from './discover-category-icons';
import {
  MAX_INPUT_PRICE_SLIDER_USD, INPUT_PRICE_SLIDER_STEP,
  MAX_OUTPUT_PRICE_SLIDER_USD, OUTPUT_PRICE_SLIDER_STEP,
  MAX_CHANNELS_SLIDER, CHANNELS_SLIDER_STEP,
  formatCategoryLabel,
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
  return `${value}+`;
}

const TIME_WINDOW_OPTIONS: ReadonlyArray<{ value: TimeWindow; label: string }> = [
  { value: 'any', label: 'Any time' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
];

const POPOVER_EST_HEIGHT = 148;

function TimeWindowSelect({
  value,
  onChange,
}: {
  value: TimeWindow;
  onChange: (v: TimeWindow) => void;
}) {
  const [open, setOpen] = useState(false);
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const current = TIME_WINDOW_OPTIONS.find((o) => o.value === value) ?? TIME_WINDOW_OPTIONS[0];

  const handleToggle = () => {
    if (!open && triggerRef.current) {
      setTriggerRect(triggerRef.current.getBoundingClientRect());
    }
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const popoverStyle: React.CSSProperties = triggerRect
    ? (() => {
        const spaceBelow = window.innerHeight - triggerRect.bottom;
        const base = { left: triggerRect.left, width: triggerRect.width };
        return spaceBelow >= POPOVER_EST_HEIGHT + 8
          ? { ...base, top: triggerRect.bottom + 4 }
          : { ...base, bottom: window.innerHeight - triggerRect.top + 4 };
      })()
    : {};

  return (
    <div className={styles.twWrapper}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.twTrigger}
        onClick={handleToggle}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{current.label}</span>
        <svg
          className={`${styles.twChevron}${open ? ` ${styles.twChevronOpen}` : ''}`}
          width="10" height="6" viewBox="0 0 10 6" fill="none"
          aria-hidden="true"
        >
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && triggerRect && createPortal(
        <div className={styles.twPopover} style={popoverStyle} role="listbox">
          {TIME_WINDOW_OPTIONS.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={active}
                className={`${styles.twOption}${active ? ` ${styles.twOptionActive}` : ''}`}
                onClick={() => { onChange(opt.value); setOpen(false); }}
              >
                <span className={styles.twCheckSlot} aria-hidden="true">
                  {active && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M2 6.5L4.75 9L10 3.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

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
                  onClick={() => filters.toggleCategory(c)}
                >
                  <HugeiconsIcon
                    icon={getCategoryIcon(c)}
                    size={12}
                    strokeWidth={1.5}
                    className={styles.tagIcon}
                  />
                  {formatCategoryLabel(c)}
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

      {/* On-chain channel count */}
      <div className={styles.field}>
        <div className={styles.sliderHeader}>
          <span className={styles.label}>channels</span>
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
        <TimeWindowSelect
          value={filters.lastSeenWindow}
          onChange={filters.setLastSeenWindow}
        />
      </div>

      {/* Last settled window */}
      <div className={styles.field}>
        <div className={styles.label}>Last settled</div>
        <TimeWindowSelect
          value={filters.lastSettledWindow}
          onChange={filters.setLastSettledWindow}
        />
      </div>

      <button
        type="button"
        className={styles.checkRow}
        onClick={() => filters.setChattedOnly(!filters.chattedOnly)}
        aria-pressed={filters.chattedOnly}
      >
        <span className={`${styles.checkBox} ${filters.chattedOnly ? styles.checkBoxActive : ''}`}>
          {filters.chattedOnly && (
            <svg width="9" height="7" viewBox="0 0 9 7" fill="none" aria-hidden="true">
              <path d="M1 3.5L3.5 6L8 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <span>Previously used</span>
      </button>

      <button type="button" className={styles.resetBtn} onClick={filters.resetAll}>
        <HugeiconsIcon icon={FilterResetIcon} size={12} strokeWidth={1.5} />
        Reset all
      </button>
    </aside>
  );
});
