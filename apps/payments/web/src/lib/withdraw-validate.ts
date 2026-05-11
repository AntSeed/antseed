import { parseUnits } from 'viem';

export type WithdrawValidation =
  | { ok: true; units: bigint }
  | { ok: false; error: string };

/**
 * Validates the inputs the user types into the withdraw form. Returns the
 * USDC amount as a 6-decimal bigint on success, or an error message that
 * matches what the form surfaces inline.
 *
 * The hook still owns the contract-address / network checks — those depend
 * on runtime config rather than user input.
 */
export function validateWithdrawInput(buyer: string, amount: string): WithdrawValidation {
  if (!/^0x[0-9a-fA-F]{40}$/.test(buyer)) {
    return { ok: false, error: 'Invalid buyer address.' };
  }

  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false, error: 'Enter a valid amount.' };
  }

  let units: bigint;
  try {
    units = parseUnits(amount, 6);
  } catch {
    return { ok: false, error: 'Invalid amount.' };
  }
  if (units <= 0n) {
    return { ok: false, error: 'Enter a valid amount.' };
  }

  return { ok: true, units };
}
