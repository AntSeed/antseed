import { formatUsd } from './format';

export interface DepositDecisionInput {
  /** USD amount the user typed (already parsed to a number by the form). */
  amountNum: number;
  /** Same amount as 6-decimal USDC units. */
  usdcAmount: bigint;
  /**
   * Latest wallet USDC balance after refetch. `null` means the read failed
   * or has not arrived; callers should error in that case.
   */
  walletUsdcBalance: number | null;
  /**
   * Latest ERC-20 allowance after refetch. `undefined` means the read
   * failed or has not arrived; callers should error in that case.
   */
  allowance: bigint | undefined;
}

export type DepositDecision =
  | { kind: 'deposit' }
  | { kind: 'approve' }
  | { kind: 'error'; message: string };

/**
 * Given the freshly-refetched wallet balance and allowance, decide whether
 * the next step is the deposit tx, the approve tx, or an error surfaced
 * inline to the user. Pure — no wagmi or react bindings.
 */
export function decideDepositStep(input: DepositDecisionInput): DepositDecision {
  const { amountNum, usdcAmount, walletUsdcBalance, allowance } = input;

  if (walletUsdcBalance === null || !Number.isFinite(walletUsdcBalance)) {
    return { kind: 'error', message: 'Could not check your wallet USDC balance. Please try again.' };
  }
  if (amountNum > walletUsdcBalance) {
    return {
      kind: 'error',
      message: `Your connected wallet only has ${formatUsd(walletUsdcBalance)} USDC available.`,
    };
  }
  if (allowance === undefined) {
    return { kind: 'error', message: 'Could not check your USDC approval. Please try again.' };
  }

  return allowance >= usdcAmount ? { kind: 'deposit' } : { kind: 'approve' };
}
