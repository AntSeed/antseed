import { useCallback, useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import type { PaymentConfig } from '../types';
import { DEPOSITS_ABI, ERC20_ABI } from '../abi';
import { getErrorMessage, usePaymentNetwork } from '../lib/payment-network';
import { formatUsd } from '../lib/format';

export type DepositStep = 'idle' | 'approving' | 'checking-allowance' | 'depositing' | 'done';

interface SubmitParams {
  usdcAmount: bigint;
  amountNum: number;
  depositTarget: `0x${string}`;
}

export interface UseDepositResult {
  step: DepositStep;
  error: string | null;
  walletUsdcBalance: number | null;
  walletUsdcKnown: boolean;
  walletUsdcLoading: boolean;
  allowance: bigint | undefined;
  hasAllowance: boolean;
  isCheckingAllowance: boolean;
  allowanceShortfall: boolean;
  approveTxHash: `0x${string}` | undefined;
  depositTxHash: `0x${string}` | undefined;
  submit: (params: SubmitParams) => Promise<void>;
  reset: () => void;
}

/**
 * Owns the two-step USDC deposit chain flow (approve → deposit) plus the
 * allowance/wallet-USDC reads that gate it. The view supplies the parsed
 * `desiredAmount` so `hasAllowance` and `allowanceShortfall` stay in sync
 * with the input field.
 */
export function useDeposit(
  config: PaymentConfig | null,
  desiredAmount: bigint,
  onDeposited?: () => void,
): UseDepositResult {
  const { address, isConnected } = useAccount();
  const { expectedChainId, targetChainName, ensureCorrectNetwork } = usePaymentNetwork(config);

  const [step, setStep] = useState<DepositStep>('idle');
  const [error, setError] = useState<string | null>(null);

  const {
    data: walletUsdcRaw,
    refetch: refetchWalletUsdc,
    isLoading: walletUsdcIsLoading,
    isFetching: walletUsdcIsFetching,
  } = useReadContract({
    address: config?.usdcContractAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    chainId: expectedChainId,
    args: [address as `0x${string}`],
    query: { enabled: isConnected && !!config && !!address },
  });
  const walletUsdcBalance = walletUsdcRaw === undefined ? null : Number.parseFloat(formatUnits(walletUsdcRaw, 6));
  const walletUsdcKnown = walletUsdcBalance !== null && Number.isFinite(walletUsdcBalance);

  const {
    data: allowance,
    refetch: refetchAllowance,
    isLoading: allowanceIsLoading,
    isFetching: allowanceIsFetching,
  } = useReadContract({
    address: config?.usdcContractAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'allowance',
    chainId: expectedChainId,
    args: [address as `0x${string}`, config?.depositsContractAddress as `0x${string}`],
    query: { enabled: isConnected && !!config && !!address },
  });

  const allowanceKnown = allowance !== undefined;
  const isCheckingAllowance = allowanceIsLoading || allowanceIsFetching || step === 'checking-allowance';
  const hasAllowance = allowanceKnown && allowance >= desiredAmount && desiredAmount > 0n;
  const allowanceShortfall = allowanceKnown && desiredAmount > 0n && allowance < desiredAmount;

  const { writeContract: writeApprove, data: approveTxHash, reset: resetApprove } = useWriteContract();
  const { writeContract: writeDeposit, data: depositTxHash, reset: resetDeposit } = useWriteContract();

  const { isSuccess: approveConfirmed } = useWaitForTransactionReceipt({
    hash: approveTxHash,
    chainId: expectedChainId,
    query: { enabled: step === 'approving' && !!approveTxHash },
  });
  const { isSuccess: depositConfirmed } = useWaitForTransactionReceipt({
    hash: depositTxHash,
    chainId: expectedChainId,
    query: { enabled: step === 'depositing' && !!depositTxHash },
  });

  // After approval confirms → refetch allowance. Keep the user on an explicit
  // "checking" state instead of assuming approval immediately changed allowance.
  useEffect(() => {
    if (step !== 'approving' || !approveConfirmed) return;
    setStep('checking-allowance');
    void refetchAllowance();
  }, [step, approveConfirmed, refetchAllowance]);

  // Once allowance is confirmed on-chain, let the user start step 2 manually.
  useEffect(() => {
    if (step !== 'checking-allowance') return;
    if (hasAllowance) setStep('idle');
  }, [step, hasAllowance]);

  useEffect(() => {
    if (step === 'depositing' && depositConfirmed) {
      setStep('done');
      onDeposited?.();
    }
  }, [depositConfirmed, step, onDeposited]);

  const submit = useCallback(async ({ usdcAmount, amountNum, depositTarget }: SubmitParams) => {
    if (!address || !config) return;

    setError(null);
    try {
      await ensureCorrectNetwork();
    } catch (err) {
      setError(getErrorMessage(err, `Please switch your wallet to ${targetChainName}.`));
      return;
    }

    resetApprove();
    resetDeposit();

    const walletResult = await refetchWalletUsdc();
    const latestWalletUsdc = walletResult.data === undefined ? null : Number.parseFloat(formatUnits(walletResult.data, 6));
    if (latestWalletUsdc === null || !Number.isFinite(latestWalletUsdc)) {
      setError('Could not check your wallet USDC balance. Please try again.');
      return;
    }
    if (amountNum > latestWalletUsdc) {
      setError(`Your connected wallet only has ${formatUsd(latestWalletUsdc)} USDC available.`);
      return;
    }

    const allowanceResult = await refetchAllowance();
    const latestAllowance = allowanceResult.data;
    if (latestAllowance === undefined) {
      setError('Could not check your USDC approval. Please try again.');
      return;
    }

    if (latestAllowance >= usdcAmount) {
      setStep('depositing');
      writeDeposit({
        address: config.depositsContractAddress as `0x${string}`,
        abi: DEPOSITS_ABI,
        functionName: 'deposit',
        chainId: expectedChainId,
        args: [depositTarget, usdcAmount],
      }, {
        onError: (err) => {
          setStep('idle');
          setError(getErrorMessage(err));
        },
      });
      return;
    }

    setStep('approving');
    writeApprove({
      address: config.usdcContractAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      chainId: expectedChainId,
      args: [config.depositsContractAddress as `0x${string}`, usdcAmount],
    }, {
      onError: (err) => {
        setStep('idle');
        setError(getErrorMessage(err));
      },
    });
  }, [
    address,
    config,
    ensureCorrectNetwork,
    targetChainName,
    resetApprove,
    resetDeposit,
    refetchWalletUsdc,
    refetchAllowance,
    writeDeposit,
    writeApprove,
    expectedChainId,
  ]);

  const reset = useCallback(() => {
    setStep('idle');
    setError(null);
    resetApprove();
    resetDeposit();
  }, [resetApprove, resetDeposit]);

  return {
    step,
    error,
    walletUsdcBalance,
    walletUsdcKnown,
    walletUsdcLoading: walletUsdcIsLoading || walletUsdcIsFetching,
    allowance,
    hasAllowance,
    isCheckingAllowance,
    allowanceShortfall,
    approveTxHash,
    depositTxHash,
    submit,
    reset,
  };
}
