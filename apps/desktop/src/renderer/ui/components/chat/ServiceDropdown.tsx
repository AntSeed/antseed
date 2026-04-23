import { useState, useRef, useEffect } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import type { ChatServiceOptionEntry } from '../../../core/state';
import { formatPerMillionPrice } from '../../../core/peer-utils';
import { formatCategoryLabel } from './discover-filter-util';
import styles from './ServiceDropdown.module.scss';

type ServiceDropdownProps = {
  options: ChatServiceOptionEntry[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
};

function normalizeServiceName(name: string): string {
  return name.replace(/[-_]+/g, ' ');
}

function withAnonTag(categories: string[]): string[] {
  return categories.some((c) => c.toLowerCase() === 'anon')
    ? categories
    : ['anon', ...categories];
}

export function ServiceDropdown({ options, value, disabled, onChange, onFocus, onBlur }: ServiceDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);
  const label = normalizeServiceName(selected?.label || 'Select service');

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        onBlur?.();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onBlur]);

  return (
    <div className={styles.serviceDropdown} ref={ref}>
      <button
        className={styles.serviceDropdownTrigger}
        disabled={disabled}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) onFocus?.();
        }}
      >
        <span className={styles.serviceDropdownLabel}>{label}</span>
        <HugeiconsIcon icon={ArrowDown01Icon} size={16} strokeWidth={1.5} />
      </button>
      {open && options.length > 0 && (
        <div className={styles.serviceDropdownMenu}>
          {options.map((opt) => {
            const tags = withAnonTag(opt.categories);
            const hasInput = opt.inputUsdPerMillion != null;
            const hasOutput = opt.outputUsdPerMillion != null;
            const isFree =
              hasInput && hasOutput && opt.inputUsdPerMillion === 0 && opt.outputUsdPerMillion === 0;
            return (
              <button
                key={opt.value}
                className={`${styles.serviceDropdownItem}${opt.value === value ? ` ${styles.active}` : ''}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                  onBlur?.();
                }}
              >
                <span className={styles.itemTopRow}>
                  <span className={styles.itemName}>{normalizeServiceName(opt.label)}</span>
                  {(hasInput || hasOutput) && (
                    <span className={styles.itemPricing}>
                      {isFree ? (
                        <span>Free</span>
                      ) : (
                        <>
                          {hasInput && (
                            <span>{formatPerMillionPrice(opt.inputUsdPerMillion!)} in</span>
                          )}
                          {hasInput && hasOutput && <span className={styles.pricingDot} />}
                          {hasOutput && (
                            <span>{formatPerMillionPrice(opt.outputUsdPerMillion!)} out</span>
                          )}
                        </>
                      )}
                    </span>
                  )}
                </span>
                {tags.length > 0 && (
                  <span className={styles.itemTags}>
                    {tags.map((t) => (
                      <span key={t} className={styles.itemTag}>{formatCategoryLabel(t)}</span>
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
