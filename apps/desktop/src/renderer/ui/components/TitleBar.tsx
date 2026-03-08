import { useState, useEffect } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Sun02Icon } from '@hugeicons/core-free-icons';
import { Moon02Icon } from '@hugeicons/core-free-icons';
import { AntStationLogo } from './AntStationLogo';
import styles from './TitleBar.module.scss';

export function TitleBar() {
  const [isDark, setIsDark] = useState(() =>
    document.body.classList.contains('dark-theme'),
  );

  useEffect(() => {
    if (isDark) {
      document.body.classList.add('dark-theme');
    } else {
      document.body.classList.remove('dark-theme');
    }
  }, [isDark]);

  return (
    <header className={styles.titleBar}>
      <div className={styles.titleBarLeft}>
        <AntStationLogo height={20} className={styles.titleBarLogo} />
      </div>
      <div className={styles.titleBarRight}>
        <button
          className={styles.titleBarThemeToggle}
          onClick={() => setIsDark((d) => !d)}
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          <HugeiconsIcon
            icon={isDark ? Sun02Icon : Moon02Icon}
            size={16}
            strokeWidth={1.5}
          />
        </button>
      </div>
    </header>
  );
}
