/**
 * One-shot Apps onboarding: after the user's first chat, a dot appears on the
 * Apps nav item; opening Apps then plays a "connect your tools" intro screen.
 * Seen-state persists per install (localStorage) like the other one-off
 * dialog dismissals.
 */
export const APPS_ONBOARDING_SEEN_KEY = 'antseed:appsOnboardingSeen';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isAppsOnboardingSeen(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(APPS_ONBOARDING_SEEN_KEY) === 'true';
  } catch {
    return false;
  }
}

export function persistAppsOnboardingSeen(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(APPS_ONBOARDING_SEEN_KEY, 'true');
  } catch {
    // Storage unavailable — the intro simply shows again next time.
  }
}

/** Nav-rail dot condition: the user hasn't opened the Apps screen yet. */
export function shouldNotifyAppsOnboarding(storage: StorageLike | null = defaultStorage()): boolean {
  return !isAppsOnboardingSeen(storage);
}
