/**
 * Shared light/dark theme state: a `dark-theme` class on <body> (styled in
 * global.scss) persisted under one localStorage key. Every window applies it
 * on boot — the main app, the setup title bar, and the floating pill — and a
 * `storage` listener keeps already-open windows in sync when the mode is
 * changed from any of them.
 */

export type ThemeMode = 'light' | 'dark';

const THEME_STORAGE_KEY = 'antseed:theme';

export function getStoredThemeMode(): ThemeMode | null {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === 'dark' || saved === 'light' ? saved : null;
  } catch {
    return null;
  }
}

/** The mode currently painted, regardless of what is persisted. */
export function activeThemeMode(): ThemeMode {
  return document.body.classList.contains('dark-theme') ? 'dark' : 'light';
}

export function applyThemeMode(mode: ThemeMode): void {
  document.body.classList.toggle('dark-theme', mode === 'dark');
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // storage unavailable — theme still applies for this session
  }
}

/** Paint the persisted mode and follow changes made from other windows. */
export function initThemeMode(): void {
  const stored = getStoredThemeMode();
  if (stored) {
    document.body.classList.toggle('dark-theme', stored === 'dark');
  }
  window.addEventListener('storage', (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    if (event.newValue === 'dark' || event.newValue === 'light') {
      document.body.classList.toggle('dark-theme', event.newValue === 'dark');
    }
  });
}
