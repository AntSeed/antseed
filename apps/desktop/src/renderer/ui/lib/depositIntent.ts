// One-shot handoff of the deposit method chosen on another screen (e.g. the
// Profile view's Credit Card / Crypto buttons) to the deposit view, which
// consumes it on mount. Deliberately not part of uiState: it's ephemeral
// navigation intent, not app state.

export type DepositMethod = 'card' | 'crypto';

let pendingMethod: DepositMethod | null = null;

export function setDepositIntent(method: DepositMethod): void {
  pendingMethod = method;
}

export function takeDepositIntent(): DepositMethod | null {
  const method = pendingMethod;
  pendingMethod = null;
  return method;
}
