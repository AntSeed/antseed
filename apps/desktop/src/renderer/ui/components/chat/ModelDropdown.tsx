import { useState, useRef, useEffect } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import type { ChatModelOptionEntry } from '../../../core/state';
import styles from './ModelDropdown.module.scss';

type ModelDropdownProps = {
  options: ChatModelOptionEntry[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
};

export function ModelDropdown({ options, value, disabled, onChange, onFocus, onBlur }: ModelDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);
  const label = selected?.label || 'Select model';

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
    <div className={styles.modelDropdown} ref={ref}>
      <button
        className={styles.modelDropdownTrigger}
        disabled={disabled}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) onFocus?.();
        }}
      >
        <span className={styles.modelDropdownIcon}>
          <img src="./assets/antseed-mark.svg" alt="" width={16} height={16} />
        </span>
        <span className={styles.modelDropdownLabel}>{label}</span>
        <HugeiconsIcon icon={ArrowDown01Icon} size={16} strokeWidth={1.5} />
      </button>
      {open && options.length > 0 && (
        <div className={styles.modelDropdownMenu}>
          {options.map((opt) => (
            <button
              key={opt.value}
              className={`${styles.modelDropdownItem}${opt.value === value ? ` ${styles.active}` : ''}`}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
                onBlur?.();
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
