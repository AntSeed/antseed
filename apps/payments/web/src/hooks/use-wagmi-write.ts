import { useCallback, useEffect, useRef, useState } from 'react';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import type { PaymentConfig } from '../types';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';

type WriteParams = Parameters<ReturnType<typeof useWriteContract>['writeContract']>[0];

export interface UseWagmiWriteResult {
  /**
   * Build-and-send a contract write. The `build` callback may await
   * (e.g. for an off-chain signature) before returning the wagmi
   * writeContract params. Throwing from `build` aborts cleanly and the
   * thrown message becomes `error`.
   */
  submit: (build: () => WriteParams | Promise<WriteParams>) => Promise<void>;
  running: boolean;
  success: boolean;
  error: string | null;
  setError: (msg: string | null) => void;
  reset: () => void;
  txHash: `0x${string}` | undefined;
  expectedChainId: number | undefined;
}

/**
 * Shared state machine for AntSeed wagmi writes. Consolidates:
 *   - running / error state
 *   - useWriteContract + useWaitForTransactionReceipt plumbing
 *   - "fire onSuccess exactly once per confirmed tx" via a txHash ref
 *     (without it, `isSuccess` stays sticky on the prior hash and can fire
 *     onSuccess for the wrong tx when the hook is re-used)
 *   - chain-switching guard via usePaymentNetwork
 */
export function useWagmiWrite(
  config: PaymentConfig | null,
  onSuccess?: () => void,
): UseWagmiWriteResult {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { expectedChainId, ensureCorrectNetwork } = usePaymentNetwork(config);
  const { writeContract, data: txHash, reset: resetWrite } = useWriteContract();
  const { isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
    chainId: expectedChainId,
  });

  // The txHash we've already fired onSuccess for. Prevents the sticky
  // `isSuccess` from re-firing on a subsequent render or, worse, firing
  // for the previous tx after a fresh submit() before `isSuccess` flips back.
  const firedRef = useRef<`0x${string}` | undefined>(undefined);

  useEffect(() => {
    if (!isSuccess || !txHash) return;
    if (firedRef.current === txHash) return;
    firedRef.current = txHash;
    setRunning(false);
    onSuccess?.();
  }, [isSuccess, txHash, onSuccess]);

  const submit = useCallback(async (build: () => WriteParams | Promise<WriteParams>) => {
    setError(null);
    setRunning(true);
    resetWrite();
    firedRef.current = undefined;
    try {
      await ensureCorrectNetwork();
      const params = await build();
      writeContract(params, {
        onError: (err) => {
          setRunning(false);
          setError(getErrorMessage(err));
        },
      });
    } catch (err) {
      setRunning(false);
      setError(getErrorMessage(err));
    }
  }, [ensureCorrectNetwork, resetWrite, writeContract]);

  const reset = useCallback(() => {
    setError(null);
    setRunning(false);
    resetWrite();
    firedRef.current = undefined;
  }, [resetWrite]);

  return {
    submit,
    running,
    success: isSuccess,
    error,
    setError,
    reset,
    txHash,
    expectedChainId,
  };
}
