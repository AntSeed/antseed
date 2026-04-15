import { useCallback, useEffect, useState } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseAbi } from 'viem';
import type { PaymentConfig } from '../types';
import { signOperatorAuth } from '../api';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';

const DEPOSITS_OPERATOR_ABI = parseAbi([
  'function setOperator(address buyer, address operator, uint256 nonce, bytes buyerSig) external',
]);

export interface UseSetOperatorResult {
  run: () => Promise<void>;
  running: boolean;
  success: boolean;
  error: string | null;
  reset: () => void;
  txHash: string | undefined;
}

export function useSetOperator(config: PaymentConfig | null, onSuccess?: () => void): UseSetOperatorResult {
  const { address } = useAccount();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { expectedChainId, ensureCorrectNetwork } = usePaymentNetwork(config);

  const { writeContract, data: txHash, reset: resetWrite } = useWriteContract();
  const { isSuccess } = useWaitForTransactionReceipt({ hash: txHash, chainId: expectedChainId });

  useEffect(() => {
    if (isSuccess && running) {
      setRunning(false);
      onSuccess?.();
    }
  }, [isSuccess, running, onSuccess]);

  const run = useCallback(async () => {
    if (!address || !config?.depositsContractAddress) return;
    setError(null);
    setRunning(true);
    resetWrite();

    try {
      await ensureCorrectNetwork();
      const signResult = await signOperatorAuth(address);
      if (!signResult.ok) {
        setRunning(false);
        setError('Failed to sign wallet authorization');
        return;
      }
      writeContract({
        address: config.depositsContractAddress as `0x${string}`,
        abi: DEPOSITS_OPERATOR_ABI,
        functionName: 'setOperator',
        chainId: expectedChainId,
        args: [
          signResult.buyer as `0x${string}`,
          address as `0x${string}`,
          BigInt(signResult.nonce),
          signResult.signature as `0x${string}`,
        ],
      }, {
        onError: (err) => {
          setRunning(false);
          setError(getErrorMessage(err));
        },
      });
    } catch (err) {
      setRunning(false);
      setError(getErrorMessage(err, 'Failed to set wallet'));
    }
  }, [address, config, ensureCorrectNetwork, expectedChainId, writeContract, resetWrite]);

  const reset = useCallback(() => {
    setError(null);
    setRunning(false);
    resetWrite();
  }, [resetWrite]);

  return { run, running, success: isSuccess, error, reset, txHash };
}
