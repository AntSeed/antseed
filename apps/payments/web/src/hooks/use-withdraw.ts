import { useCallback } from 'react';
import type { PaymentConfig } from '../types';
import { DEPOSITS_ABI } from '../abi';
import { validateWithdrawInput } from '../lib/withdraw-validate';
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
    const validated = validateWithdrawInput(buyer, amount);
    if (!validated.ok) {
      setError(validated.error);
      return;
    }

    await submit(() => ({
      address: config.depositsContractAddress as `0x${string}`,
      abi: DEPOSITS_ABI,
      functionName: 'withdraw',
      chainId: expectedChainId,
      args: [buyer as `0x${string}`, validated.units],
    }));
  }, [config, setError, submit, expectedChainId]);

  return { run, running, success, error, reset, txHash };
}
