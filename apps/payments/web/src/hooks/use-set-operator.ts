import { useCallback } from 'react';
import { useAccount } from 'wagmi';
import type { PaymentConfig } from '../types';
import { signOperatorAuth } from '../lib/api';
import { DEPOSITS_ABI } from '../abi';
import { useWagmiWrite } from './use-wagmi-write';

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
  const { submit, expectedChainId, running, success, error, reset, txHash } =
    useWagmiWrite(config, onSuccess);

  const run = useCallback(async () => {
    if (!address || !config?.depositsContractAddress) return;

    await submit(async () => {
      const signResult = await signOperatorAuth(address);
      if (!signResult.ok) throw new Error('Failed to sign wallet authorization');
      return {
        address: config.depositsContractAddress as `0x${string}`,
        abi: DEPOSITS_ABI,
        functionName: 'setOperator',
        chainId: expectedChainId,
        args: [
          signResult.buyer as `0x${string}`,
          address as `0x${string}`,
          BigInt(signResult.nonce),
          signResult.signature as `0x${string}`,
        ],
      };
    });
  }, [address, config?.depositsContractAddress, submit, expectedChainId]);

  return { run, running, success, error, reset, txHash };
}

export interface UseTransferOperatorResult {
  run: (buyerAddress: string, newOperator: string) => Promise<void>;
  running: boolean;
  success: boolean;
  error: string | null;
  reset: () => void;
}

export function useTransferOperator(config: PaymentConfig | null, onSuccess?: () => void): UseTransferOperatorResult {
  const { submit, setError, expectedChainId, running, success, error, reset } =
    useWagmiWrite(config, onSuccess);

  const run = useCallback(async (buyerAddress: string, newOperator: string) => {
    if (!config?.depositsContractAddress) return;
    if (!/^0x[0-9a-fA-F]{40}$/.test(newOperator)) {
      setError('Invalid wallet address');
      return;
    }

    await submit(() => ({
      address: config.depositsContractAddress as `0x${string}`,
      abi: DEPOSITS_ABI,
      functionName: 'transferOperator',
      chainId: expectedChainId,
      args: [buyerAddress as `0x${string}`, newOperator as `0x${string}`],
    }));
  }, [config?.depositsContractAddress, setError, submit, expectedChainId]);

  return { run, running, success, error, reset };
}
