import { useState, useEffect } from 'react';
import styles from './AlphaHint.module.scss';

export function AlphaHint() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(`.${styles.alphaHintWrapper}`)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={styles.alphaHintWrapper}>
      <button
        type="button"
        className={`${styles.alphaHint} ${open ? styles.alphaHintActive : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        aria-label="About this alpha build"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className={styles.alphaHintLabel}>Alpha</span>
      </button>
      {open && (
        <div className={styles.alphaPopover} role="dialog" aria-label="About this alpha build">
          <div className={styles.alphaPopoverHeader}>
            <span className={styles.alphaPopoverDot} aria-hidden="true" />
            <span className={styles.alphaPopoverEyebrow}>Alpha build</span>
          </div>
          <p className={styles.alphaPopoverLede}>
            AntSeed is under active development. Expect things to move fast and occasionally break.
          </p>
          <ul className={styles.alphaPopoverList}>
            <li className={styles.alphaPopoverItem}>
              <span className={styles.alphaPopoverItemMark} aria-hidden="true" />
              <span className={styles.alphaPopoverItemText}>Features and APIs may change without notice</span>
            </li>
            <li className={styles.alphaPopoverItem}>
              <span className={styles.alphaPopoverItemMark} aria-hidden="true" />
              <span className={styles.alphaPopoverItemText}>Bugs and rough edges are expected</span>
            </li>
            <li className={styles.alphaPopoverItem}>
              <span className={styles.alphaPopoverItemMark} aria-hidden="true" />
              <span className={styles.alphaPopoverItemText}>The peer network is still bootstrapping</span>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
