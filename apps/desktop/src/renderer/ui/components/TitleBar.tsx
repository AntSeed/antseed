import { useState, useEffect } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Sun02Icon } from '@hugeicons/core-free-icons';
import { Moon02Icon } from '@hugeicons/core-free-icons';

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
    <header className="title-bar">
      <div className="title-bar-left">
        <img
          className="title-bar-logo"
          src="./assets/antseed-logo.svg"
          alt="AntSeed"
        />
      </div>
      <div className="title-bar-right">
        <button
          className="title-bar-theme-toggle"
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
