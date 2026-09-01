/**
 * "Don't show again" flag for the Home power-button disconnect confirmation,
 * persisted per install (localStorage) like the other one-off dialog dismissals.
 */
export const DISCONNECT_CONFIRM_DISMISSED_KEY = 'antseed:disconnectConfirmDismissed';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isDisconnectConfirmDismissed(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(DISCONNECT_CONFIRM_DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function persistDisconnectConfirmDismissed(
  dontShowAgain: boolean,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!dontShowAgain) return;
  try {
    storage?.setItem(DISCONNECT_CONFIRM_DISMISSED_KEY, 'true');
  } catch {
    // Storage unavailable — the dialog simply shows again next time.
  }
}
