import type { CSSProperties, JSX, ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, Search01Icon } from '@hugeicons/core-free-icons';
import styles from './VprKit.module.scss';

/**
 * Shared brand-guideline primitives for the VPR screens (Figma: Toggle -
 * Switch, Badge, Slider - Center-biased, Default model tiles, search).
 */

export { formatCompactTokens } from '../../../core/format';

/** Bare dollar amount for the brand price displays ("$5", "$2.50") — the
 * "/m tok" unit is rendered separately, unlike formatPerMillionPrice. */
export function formatUsdShort(value: number): string {
  if (value <= 0) return 'Free';
  const digits = value < 0.01 ? 3 : Number.isInteger(value) ? 0 : 2;
  return `$${value.toFixed(digits)}`;
}

/** Inner-screen page header: back chevron + screen title, navigating home. */
export function VprBackTitle({ title, onBack }: {
  title: string;
  onBack: () => void;
}): JSX.Element {
  return (
    <button type="button" className={styles.backTitle} onClick={onBack} title="Back">
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={2} />
      <span>{title}</span>
    </button>
  );
}

export function VprToggle({ checked, onChange, ariaLabel, disabled }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`${styles.toggle}${checked ? ` ${styles.toggleOn}` : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.toggleKnob} />
    </button>
  );
}

export type VprBadgeTone = 'green' | 'primary' | 'neutral' | 'type';

const BADGE_TONE_CLASS: Record<VprBadgeTone, string> = {
  green: styles.badgeGreen,
  primary: styles.badgePrimary,
  neutral: styles.badgeNeutral,
  type: styles.badgeType,
};

export function VprBadge({ tone = 'green', children }: {
  tone?: VprBadgeTone;
  children: ReactNode;
}): JSX.Element {
  return <span className={`${styles.badge} ${BADGE_TONE_CLASS[tone]}`}>{children}</span>;
}

export function VprSlider({ min, max, step, value, onChange, ariaLabel }: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (next: number) => void;
  ariaLabel: string;
}): JSX.Element {
  const clamped = Math.min(max, Math.max(min, value));
  const pct = max > min ? ((clamped - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      className={styles.slider}
      min={min}
      max={max}
      step={step}
      value={clamped}
      style={{ '--slider-fill': `${pct}%` } as CSSProperties}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
      aria-label={ariaLabel}
    />
  );
}

export function VprStatRow({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.statRow}>{children}</div>;
}

export function VprStatTile({ label, value, suffix }: {
  label: string;
  value: ReactNode;
  suffix?: string;
}): JSX.Element {
  return (
    <div className={styles.statTile}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>
        {value}
        {suffix ? <span className={styles.statSuffix}>{suffix}</span> : null}
      </span>
    </div>
  );
}

export function VprSearch({ value, onChange, placeholder, ariaLabel }: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  ariaLabel?: string;
}): JSX.Element {
  return (
    <label className={styles.search}>
      <HugeiconsIcon icon={Search01Icon} size={16} strokeWidth={2} className={styles.searchIcon} />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

export function VprCard({ children, className }: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return <div className={`${styles.card}${className ? ` ${className}` : ''}`}>{children}</div>;
}

/** Label + caption + hint on the left, a control (toggle, value) on the right. */
export function VprSettingRow({ title, caption, hint, control }: {
  title: string;
  caption?: string;
  hint?: string;
  control: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.settingRow}>
      <div className={styles.settingText}>
        <div className={styles.settingTitle}>
          <span>{title}</span>
          {caption ? <span className={styles.settingCaption}>{caption}</span> : null}
        </div>
        {hint ? <div className={styles.settingHint}>{hint}</div> : null}
      </div>
      <div className={styles.settingControl}>{control}</div>
    </div>
  );
}
