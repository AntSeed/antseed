import { useState, useRef, useEffect, useLayoutEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import type { ChatServiceOptionEntry } from '../../../core/state';
import { formatPerMillionPrice } from '../../../core/peer-utils';
import { formatCategoryLabel } from './discover-filter-util';
import { ProviderLogo } from './ProviderLogo';
import styles from './ServiceDropdown.module.scss';

type ServiceDropdownProps = {
  options: ChatServiceOptionEntry[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Anchor edge of the popover relative to the trigger. Defaults to 'start' (left). */
  align?: 'start' | 'end';
  placeholder?: string;
};

function normalizeServiceName(name: string): string {
  return name.replace(/[-_]+/g, ' ');
}

function withAnonTag(categories: string[]): string[] {
  return categories.some((c) => c.toLowerCase() === 'anon')
    ? categories
    : ['anon', ...categories];
}

export function ServiceDropdown({
  options,
  value,
  disabled,
  onChange,
  onFocus,
  onBlur,
  align = 'start',
  placeholder = 'Select service',
}: ServiceDropdownProps) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);
  const label = normalizeServiceName(selected?.label || placeholder);

  useLayoutEffect(() => {
    if (!open) return;

    function updateMenuPosition() {
      const trigger = ref.current?.querySelector('button');
      if (!trigger) return;

      const rect = trigger.getBoundingClientRect();
      const viewportPadding = 12;
      const menuWidth = Math.min(380, Math.max(0, window.innerWidth - viewportPadding * 2));
      const startLeft = align === 'end' ? rect.right - menuWidth : rect.left;
      const left = Math.max(
        viewportPadding,
        Math.min(startLeft, window.innerWidth - viewportPadding - menuWidth),
      );

      setMenuStyle({
        top: rect.bottom + 6,
        left,
        width: menuWidth,
      });
    }

    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [align, open]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        ref.current &&
        !ref.current.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
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
        className={`${styles.serviceDropdownTrigger}${open ? ` ${styles.open}` : ''}`}
        disabled={disabled}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) onFocus?.();
        }}
      >
        {selected && (
          <span className={styles.triggerLogoTile}>
            <ProviderLogo modelName={selected.label} className={styles.triggerLogo} />
          </span>
        )}
        <span className={styles.serviceDropdownLabel}>{label}</span>
        <span className={styles.triggerCaret}>
          <HugeiconsIcon icon={ArrowDown01Icon} size={13} strokeWidth={2} />
        </span>
      </button>
      {open && options.length > 0 && menuStyle && createPortal((
        <div
          ref={menuRef}
          style={menuStyle}
          className={`${styles.serviceDropdownMenu}${align === 'end' ? ` ${styles.serviceDropdownMenuEnd}` : ''}`}
        >
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
                <span className={styles.itemLogoTile}>
                  <ProviderLogo modelName={opt.label} className={styles.itemLogo} />
                </span>
                <span className={styles.itemBody}>
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
                </span>
              </button>
            );
          })}
        </div>
      ), document.body)}
    </div>
  );
}
