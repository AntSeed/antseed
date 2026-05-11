import { useCallback } from 'react';
import { parseUnits } from 'viem';
import type { PaymentConfig } from '../types';
import { DEPOSITS_ABI } from '../abi';
import { useWagmiWrite } from './use-wagmi-write';

export interface UseWithdrawResult {
  /** Sends `withdraw(buyer, parseUnits(amount, 6))` from the connected wallet. */
  run: (buyer: string, amount: string) => Promise<void>;
  running: boolean;
  success: boolean;
  error: string | null;
  reset: () => void;
  txHash: string | undefined;
}

/**
 * Submits AntseedDeposits.withdraw() through the connected wallet (wagmi).
 *
 * The deposits contract requires `msg.sender == buyers[buyer].operator` and
 * sends the withdrawn USDC to `msg.sender`. So the connected wallet must be
 * the authorized operator for the buyer — typically that's the wallet the
 * user authorized via setOperator.
 */
export function useWithdraw(config: PaymentConfig | null, onSuccess?: () => void): UseWithdrawResult {
  const { submit, setError, expectedChainId, running, success, error, reset, txHash } =
    useWagmiWrite(config, onSuccess);

  const run = useCallback(async (buyer: string, amount: string) => {
    if (!config?.depositsContractAddress) {
      setError('Payments contract is not configured.');
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(buyer)) {
      setError('Invalid buyer address.');
      return;
    }
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter a valid amount.');
      return;
    }
    let units: bigint;
    try {
      units = parseUnits(amount, 6);
    } catch {
      setError('Invalid amount.');
      return;
    }
    if (units <= 0n) {
      setError('Enter a valid amount.');
      return;
    }

    await submit(() => ({
      address: config.depositsContractAddress as `0x${string}`,
      abi: DEPOSITS_ABI,
      functionName: 'withdraw',
      chainId: expectedChainId,
      args: [buyer as `0x${string}`, units],
    }));
  }, [config, setError, submit, expectedChainId]);

  return { run, running, success, error, reset, txHash };
}
