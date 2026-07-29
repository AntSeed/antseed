/** Floating pill behavior settings, persisted per install (localStorage). */

export const VPR_FLOAT_AUTO_OPEN_STORAGE_KEY = 'antseed.desktop.vpr.floatAutoOpen';

/** Whether the pill should pop up on its own when routed traffic starts. */
export function loadFloatAutoOpen(): boolean {
  try {
    return localStorage.getItem(VPR_FLOAT_AUTO_OPEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveFloatAutoOpen(value: boolean): void {
  try {
    localStorage.setItem(VPR_FLOAT_AUTO_OPEN_STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // Ignore storage errors and continue with in-memory state.
  }
}
