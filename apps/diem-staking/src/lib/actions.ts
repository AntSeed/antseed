// Write-action hooks — wrap wagmi's useWriteContract for each on-chain call.
// Each hook returns a `run(args)` function the UI invokes on button click,
// plus `isPending` for spinner state and `error` for inline display.

import { useCallback } from 'react';
import { useWriteContract } from 'wagmi';
import { parseEther, maxUint256 } from 'viem';

import { DIEM_TOKEN, DIEM_STAKING_PROXY } from './addresses';
import { DIEM_STAKING_PROXY_ABI, DIEM_TOKEN_ABI } from './abi';

export function useApproveDiem() {
  const { writeContractAsync, isPending, error, reset } = useWriteContract();
  const run = useCallback(async () => {
    return writeContractAsync({
      address: DIEM_TOKEN,
      abi: DIEM_TOKEN_ABI,
      functionName: 'approve',
      args: [DIEM_STAKING_PROXY, maxUint256],
    });
  }, [writeContractAsync]);
  return { run, isPending, error, reset };
}

export function useStake() {
  const { writeContractAsync, isPending, error, reset } = useWriteContract();
  const run = useCallback(
    async (amountDiem: string) => {
      const amt = parseEther(amountDiem);
      return writeContractAsync({
        address: DIEM_STAKING_PROXY,
        abi: DIEM_STAKING_PROXY_ABI,
        functionName: 'stake',
        args: [amt],
      });
    },
    [writeContractAsync],
  );
  return { run, isPending, error, reset };
}

export function useInitiateUnstake() {
  const { writeContractAsync, isPending, error, reset } = useWriteContract();
  const run = useCallback(
    async (amountDiem: string) => {
      const amt = parseEther(amountDiem);
      return writeContractAsync({
        address: DIEM_STAKING_PROXY,
        abi: DIEM_STAKING_PROXY_ABI,
        functionName: 'initiateUnstake',
        args: [amt],
      });
    },
    [writeContractAsync],
  );
  return { run, isPending, error, reset };
}

export function useFlush() {
  const { writeContractAsync, isPending, error, reset } = useWriteContract();
  const run = useCallback(async () => {
    return writeContractAsync({
      address: DIEM_STAKING_PROXY,
      abi: DIEM_STAKING_PROXY_ABI,
      functionName: 'flush',
    });
  }, [writeContractAsync]);
  return { run, isPending, error, reset };
}

export function useClaimEpoch() {
  const { writeContractAsync, isPending, error, reset } = useWriteContract();
  const run = useCallback(
    async (epochId: number) => {
      return writeContractAsync({
        address: DIEM_STAKING_PROXY,
        abi: DIEM_STAKING_PROXY_ABI,
        functionName: 'claimEpoch',
        args: [epochId],
      });
    },
    [writeContractAsync],
  );
  return { run, isPending, error, reset };
}

export function useClaimUsdc() {
  const { writeContractAsync, isPending, error, reset } = useWriteContract();
  const run = useCallback(async () => {
    return writeContractAsync({
      address: DIEM_STAKING_PROXY,
      abi: DIEM_STAKING_PROXY_ABI,
      functionName: 'claimUsdc',
    });
  }, [writeContractAsync]);
  return { run, isPending, error, reset };
}

/**
 * Claim ANTS for up to `numEpochs` completed reward epochs. The proxy's
 * `updateRewards` modifier caps the per-tx backlog at `MAX_EPOCHS_PER_CAPTURE`
 * (16), matching `MAX_EPOCHS_PREVIEW` on the read side — so the UI never
 * triggers a BacklogTooLarge revert on the first claim.
 */
export function useClaimAnts() {
  const { writeContractAsync, isPending, error, reset } = useWriteContract();
  const run = useCallback(
    async (numEpochs: number) => {
      return writeContractAsync({
        address: DIEM_STAKING_PROXY,
        abi: DIEM_STAKING_PROXY_ABI,
        functionName: 'claimAnts',
        args: [numEpochs],
      });
    },
    [writeContractAsync],
  );
  return { run, isPending, error, reset };
}
