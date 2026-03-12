import { useState, useRef, useEffect } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import type { ChatServiceOptionEntry } from '../../../core/state';
import antseedMark from '../../../assets/antseed-mark.svg';
import styles from './ServiceDropdown.module.scss';

type ServiceDropdownProps = {
  options: ChatServiceOptionEntry[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
};

export function ServiceDropdown({ options, value, disabled, onChange, onFocus, onBlur }: ServiceDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);
  const label = selected?.label || 'Select service';

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
        <span className={styles.serviceDropdownIcon}>
          <img src={antseedMark} alt="" width={16} height={16} />
        </span>
        <span className={styles.serviceDropdownLabel}>{label}</span>
        <HugeiconsIcon icon={ArrowDown01Icon} size={16} strokeWidth={1.5} />
      </button>
      {open && options.length > 0 && (
        <div className={styles.serviceDropdownMenu}>
          {options.map((opt) => (
            <button
              key={opt.value}
              className={`${styles.serviceDropdownItem}${opt.value === value ? ` ${styles.active}` : ''}`}
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
