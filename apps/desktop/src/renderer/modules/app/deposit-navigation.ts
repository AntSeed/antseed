const QUICK_DEPOSIT_KEY = 'antseed.desktop.deposit.quick';

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function resolveStorage(storage?: SessionStorageLike): SessionStorageLike | null {
  if (storage) return storage;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function requestQuickDeposit(storage?: SessionStorageLike): void {
  try {
    resolveStorage(storage)?.setItem(QUICK_DEPOSIT_KEY, '1');
  } catch {
    // Navigation still falls back to the standard deposit chooser.
  }
}

export function consumeQuickDepositRequest(storage?: SessionStorageLike): boolean {
  try {
    const resolved = resolveStorage(storage);
    if (!resolved) return false;
    const requested = resolved.getItem(QUICK_DEPOSIT_KEY) === '1';
    resolved.removeItem(QUICK_DEPOSIT_KEY);
    return requested;
  } catch {
    return false;
  }
}
