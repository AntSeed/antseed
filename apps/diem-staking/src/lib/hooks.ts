import { useEffect, useMemo, useState } from 'react';
import { useAccount, usePublicClient, useReadContract, useReadContracts } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';

import { ANTSEED_CHANNELS, DIEM_TOKEN, DIEM_STAKING_PROXY, isAddressSet } from './addresses';
import { DIEM_STAKING_PROXY_ABI, DIEM_TOKEN_ABI } from './abi';
import { computeDailyResetClock, computeEpochClock, type DailyResetClock, type EpochClock } from './epoch';

const POLL_MS = 60_000;

export function useProxyDeployed(): boolean {
  return isAddressSet(DIEM_STAKING_PROXY);
}

export function useDiemPrice(): number | null {
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    const ids = ['diem', 'venice-token', 'venice-ai', 'venice'];
    let cancelled = false;
    (async () => {
      for (const id of ids) {
        try {
          const r = await fetch(
            `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
          );
          const data = (await r.json()) as Record<string, { usd?: number }> | null;
          const p = data?.[id]?.usd;
          if (typeof p === 'number' && p > 0) {
            if (!cancelled) setPrice(p);
            return;
          }
        } catch {
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return price;
}

export function useEpochClock(): EpochClock {
  const [clock, setClock] = useState<EpochClock>(() => computeEpochClock(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const id = setInterval(() => {
      setClock(computeEpochClock(Math.floor(Date.now() / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return clock;
}

export function useDailyResetClock(): DailyResetClock {
  const [clock, setClock] = useState<DailyResetClock>(() => computeDailyResetClock(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const id = setInterval(() => {
      setClock(computeDailyResetClock(Math.floor(Date.now() / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return clock;
}

export interface PoolStats {
  totalStaked: bigint | null;
  stakerCount: number | null;
  totalUsdcDistributedEver: bigint | null;
  maxTotalStake: bigint | null;
  firstRewardEpoch: number | null;
  syncedRewardEpoch: number | null;
  finalizedRewardEpoch: number | null;
  diemCooldownSecs: number | null;
  minUnstakeBatchOpenSecs: number | null;
  flushableAt: number | null;
  veniceCapacityUsed24hUsd: number | null;
  veniceCapacityTotalUsd: number | null;
  veniceCapacityLeftUsd: number | null;
  isLoading: boolean;
}

export function usePoolStats(): PoolStats {
  const deployed = useProxyDeployed();
  const { data, isLoading } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'totalStaked' },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'stakerCount' },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'totalUsdcDistributedEver' },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'maxTotalStake' },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'firstRewardEpoch' },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'syncedRewardEpoch' },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'finalizedRewardEpoch' },
      { address: DIEM_TOKEN,         abi: DIEM_TOKEN_ABI,         functionName: 'cooldownDuration' },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'minUnstakeBatchOpenSecs' },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'flushableAt' },
    ],
    query: { enabled: deployed, refetchInterval: POLL_MS },
  });

  const totalStaked = data?.[0]?.result ?? null;
  const maxTotalStake = data?.[3]?.result ?? null;
  // Venice daily capacity is based on live DIEM actually staked in the proxy,
  // not the owner-set staking cap: capacity USD = totalStaked DIEM × $0.50.
  const veniceCapacityTotalUsd = totalStaked != null ? Number(totalStaked) / 1e18 * 0.5 : null;
  const { usedUsd24h, leftUsd } = useVeniceCapacityUsage24h();
  const veniceCapacityLeftUsd = leftUsd ?? veniceCapacityTotalUsd;

  if (!deployed || !data) {
    return {
      totalStaked: null,
      stakerCount: null,
      totalUsdcDistributedEver: null,
      maxTotalStake: null,
      firstRewardEpoch: null,
      syncedRewardEpoch: null,
      finalizedRewardEpoch: null,
      diemCooldownSecs: null,
      minUnstakeBatchOpenSecs: null,
      flushableAt: null,
      veniceCapacityUsed24hUsd: usedUsd24h,
      veniceCapacityTotalUsd: null,
      veniceCapacityLeftUsd: null,
      isLoading,
    };
  }
  const flushableAtRaw = data[9]?.result != null ? Number(data[9].result) : null;
  return {
    totalStaked,
    stakerCount: data[1]?.result != null ? Number(data[1].result) : null,
    totalUsdcDistributedEver: data[2]?.result ?? null,
    maxTotalStake,
    firstRewardEpoch: data[4]?.result != null ? Number(data[4].result) : null,
    syncedRewardEpoch: data[5]?.result != null ? Number(data[5].result) : null,
    finalizedRewardEpoch: data[6]?.result != null ? Number(data[6].result) : null,
    diemCooldownSecs: data[7]?.result != null ? Number(data[7].result) : null,
    minUnstakeBatchOpenSecs: data[8]?.result != null ? Number(data[8].result) : null,
    flushableAt: flushableAtRaw && flushableAtRaw > 0 ? flushableAtRaw : null,
    veniceCapacityUsed24hUsd: usedUsd24h,
    veniceCapacityTotalUsd,
    veniceCapacityLeftUsd,
    isLoading,
  };
}

function useVeniceCapacityUsage24h(): { usedUsd24h: number | null; leftUsd: number | null; isLoading: boolean } {
  const client = usePublicClient();
  const deployed = useProxyDeployed();

  const { data, isLoading } = useQuery({
    queryKey: ['veniceCapacityUsage24h', DIEM_STAKING_PROXY],
    enabled: !!client && deployed,
    staleTime: POLL_MS,
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<{ spentSinceResetUsd: number; leftUsd: number } | null> => {
      if (!client) return null;

      const head = await client.getBlockNumber();
      const headBlock = await client.getBlock({ blockNumber: head });
      const headTimestamp = Number(headBlock.timestamp);
      const resetStart = Math.floor(headTimestamp / 86400) * 86400;

      // Find the first Base block at/after the Venice daily reset (00:00 UTC).
      // Capacity is not a single static number for the day: users can stake
      // during the day, so capacity that arrived after an earlier settlement
      // must not be retroactively consumed by that earlier spend. We replay the
      // reset-day timeline instead:
      //   initial left = current capacity - same-day capacity additions
      //   stake event   => left += amount * 0.5
      //   settlement    => left -= delta
      // clamped at zero after each spend.
      let low = 0n;
      let high = head;
      while (low < high) {
        const mid = (low + high) / 2n;
        const block = await client.getBlock({ blockNumber: mid });
        if (Number(block.timestamp) >= resetStart) high = mid;
        else low = mid + 1n;
      }
      const fromBlock = low;

      const stakeEvent = DIEM_STAKING_PROXY_ABI.find(
        (e) => e.type === 'event' && e.name === 'Staked',
      );
      if (!stakeEvent) return null;

      const [totalStakedNow, stakeLogs, settlementLogs] = await Promise.all([
        client.readContract({
          address: DIEM_STAKING_PROXY,
          abi: DIEM_STAKING_PROXY_ABI,
          functionName: 'totalStaked',
        }),
        client.getLogs({
          address: DIEM_STAKING_PROXY,
          event: stakeEvent,
          fromBlock,
          toBlock: head,
        }),
        client.getLogs({
          address: ANTSEED_CHANNELS,
          event: {
            type: 'event',
            name: 'ChannelSettled',
            inputs: [
              { type: 'bytes32', name: 'channelId', indexed: true },
              { type: 'address', name: 'buyer', indexed: true },
              { type: 'address', name: 'seller', indexed: true },
              { type: 'uint128', name: 'cumulativeAmount', indexed: false },
              { type: 'uint128', name: 'delta', indexed: false },
              { type: 'uint128', name: 'totalSettled', indexed: false },
              { type: 'uint256', name: 'platformFee', indexed: false },
              { type: 'bytes', name: 'metadata', indexed: false },
            ],
          },
          args: { seller: DIEM_STAKING_PROXY },
          fromBlock,
          toBlock: head,
        }),
      ]);

      type TimelineEvent = { blockNumber: bigint; logIndex: number; kind: 'stake' | 'spend'; usd: number };
      const events: TimelineEvent[] = [];
      let sameDayCapacityAddedUsd = 0;
      let spentSinceResetUsd = 0;

      for (const log of stakeLogs) {
        const amount = (log.args as { amount?: bigint }).amount;
        if (typeof amount !== 'bigint') continue;
        const usd = Number(amount) / 1e18 * 0.5;
        sameDayCapacityAddedUsd += usd;
        events.push({ blockNumber: log.blockNumber, logIndex: log.logIndex, kind: 'stake', usd });
      }
      for (const log of settlementLogs) {
        const delta = log.args.delta;
        if (typeof delta !== 'bigint') continue;
        const usd = Number(delta) / 1e6;
        spentSinceResetUsd += usd;
        events.push({ blockNumber: log.blockNumber, logIndex: log.logIndex, kind: 'spend', usd });
      }

      events.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
        return a.logIndex - b.logIndex;
      });

      let leftUsd = Math.max(0, Number(totalStakedNow) / 1e18 * 0.5 - sameDayCapacityAddedUsd);
      for (const event of events) {
        if (event.kind === 'stake') leftUsd += event.usd;
        else leftUsd = Math.max(0, leftUsd - event.usd);
      }

      return { spentSinceResetUsd, leftUsd };
    },
  });

  return { usedUsd24h: data?.spentSinceResetUsd ?? null, leftUsd: data?.leftUsd ?? null, isLoading };
}

export interface UserStats {
  walletDiem: bigint | null;
  stakedDiem: bigint | null;
  pendingUsdc: bigint | null;
  pendingAnts: bigint | null;
  claimableAntsEpochs: number[];
  hasMoreClaimableAntsEpochs: boolean;
  userLastClaimedEpoch: number | null;
  isLoading: boolean;
}

export function useUserStats(): UserStats {
  const { address } = useAccount();
  const deployed = useProxyDeployed();
  const enabled = deployed && !!address;

  const { data: simple, isLoading: loadingSimple } = useReadContracts({
    allowFailure: true,
    contracts: enabled
      ? [
          { address: DIEM_TOKEN,         abi: DIEM_TOKEN_ABI,         functionName: 'balanceOf', args: [address!] },
          { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'staked',    args: [address!] },
          { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'earnedUsdc', args: [address!] },
          { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'userLastClaimedEpoch', args: [address!] },
        ]
      : [],
    query: { enabled, refetchInterval: POLL_MS },
  });

  const userLastClaimedEpoch = simple?.[3]?.result != null ? Number(simple[3].result) : null;
  const { pendingAnts, claimableEpochs, hasMoreClaimableEpochs, isLoading: loadingAnts } = usePendingAnts(
    address ?? null,
    userLastClaimedEpoch,
  );

  if (!enabled) {
    return {
      walletDiem: null,
      stakedDiem: null,
      pendingUsdc: null,
      pendingAnts: null,
      claimableAntsEpochs: [],
      hasMoreClaimableAntsEpochs: false,
      userLastClaimedEpoch: null,
      isLoading: loadingSimple,
    };
  }
  return {
    walletDiem: simple?.[0]?.result ?? null,
    stakedDiem: simple?.[1]?.result ?? null,
    pendingUsdc: simple?.[2]?.result ?? null,
    pendingAnts,
    claimableAntsEpochs: claimableEpochs,
    hasMoreClaimableAntsEpochs: hasMoreClaimableEpochs,
    userLastClaimedEpoch,
    isLoading: loadingSimple || loadingAnts,
  };
}

const MAX_EPOCHS_PREVIEW = 16;

function usePendingAnts(
  user: Address | null,
  userLastClaimedEpoch: number | null,
): { pendingAnts: bigint | null; claimableEpochs: number[]; hasMoreClaimableEpochs: boolean; isLoading: boolean } {
  const { firstRewardEpoch, finalizedRewardEpoch } = usePoolStats();

  const epochsToRead = useMemo(() => {
    if (user == null || userLastClaimedEpoch == null || firstRewardEpoch == null || finalizedRewardEpoch == null) return [];
    const from = Math.max(userLastClaimedEpoch, firstRewardEpoch);
    const to = Math.min(finalizedRewardEpoch, from + MAX_EPOCHS_PREVIEW);
    const out: number[] = [];
    for (let e = from; e < to; e++) out.push(e);
    return out;
  }, [user, userLastClaimedEpoch, firstRewardEpoch, finalizedRewardEpoch]);

  const hasMoreClaimableEpochs = useMemo(() => {
    if (user == null || userLastClaimedEpoch == null || firstRewardEpoch == null || finalizedRewardEpoch == null) return false;
    const from = Math.max(userLastClaimedEpoch, firstRewardEpoch);
    return from + MAX_EPOCHS_PREVIEW < finalizedRewardEpoch;
  }, [user, userLastClaimedEpoch, firstRewardEpoch, finalizedRewardEpoch]);

  const { data: pendingData, isLoading: loadingPending } = useReadContracts({
    allowFailure: true,
    contracts: epochsToRead.map((e) => ({
      address: DIEM_STAKING_PROXY,
      abi: DIEM_STAKING_PROXY_ABI,
      functionName: 'pendingAntsForEpoch' as const,
      args: [user!, e] as const,
    })),
    query: { enabled: epochsToRead.length > 0, refetchInterval: POLL_MS },
  });

  const { data: claimedData, isLoading: loadingClaimed } = useReadContracts({
    allowFailure: true,
    contracts: epochsToRead.map((e) => ({
      address: DIEM_STAKING_PROXY,
      abi: DIEM_STAKING_PROXY_ABI,
      functionName: 'userEpochClaimed' as const,
      args: [user!, e] as const,
    })),
    query: { enabled: epochsToRead.length > 0, refetchInterval: POLL_MS },
  });

  const pendingAnts = useMemo<bigint | null>(() => {
    if (user == null) return null;
    if (epochsToRead.length === 0) return 0n;
    if (!pendingData) return null;
    let sum = 0n;
    for (const r of pendingData) {
      if (typeof r.result === 'bigint') sum += r.result;
    }
    return sum;
  }, [user, epochsToRead.length, pendingData]);

  const claimableEpochs = useMemo<number[]>(() => {
    if (user == null || epochsToRead.length === 0 || !claimedData) return [];
    return epochsToRead.filter((_, i) => claimedData[i]?.result !== true);
  }, [user, epochsToRead, claimedData]);

  return { pendingAnts, claimableEpochs, hasMoreClaimableEpochs, isLoading: loadingPending || loadingClaimed };
}

export type UnstakeState =
  | { status: 'none' }
  | { status: 'queued'; batchId: number; amount: bigint; waitingForPriorBatch: boolean }
  | { status: 'cooling'; batchId: number; amount: bigint; unlockAt: number }
  | { status: 'claimable'; batchId: number; amount: bigint };

export function useUnstakeState(): { state: UnstakeState; isLoading: boolean } {
  const { address } = useAccount();
  const deployed = useProxyDeployed();

  const { data: clockData, isLoading: loadingClock } = useReadContracts({
    allowFailure: true,
    contracts: deployed
      ? [
          { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'currentUnstakeBatch' },
          { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'oldestUnclaimedUnstakeBatch' },
        ]
      : [],
    query: { enabled: deployed, refetchInterval: POLL_MS },
  });

  const currentUnstakeBatch = clockData?.[0]?.result != null ? Number(clockData[0].result) : null;
  const oldestUnclaimedUnstakeBatch = clockData?.[1]?.result != null ? Number(clockData[1].result) : null;

  const batchIds = useMemo(() => {
    if (currentUnstakeBatch == null || oldestUnclaimedUnstakeBatch == null) return [];
    const ids: number[] = [];
    for (
      let batch = oldestUnclaimedUnstakeBatch;
      batch <= currentUnstakeBatch && batch < oldestUnclaimedUnstakeBatch + 4;
      batch++
    ) {
      ids.push(batch);
    }
    return ids;
  }, [currentUnstakeBatch, oldestUnclaimedUnstakeBatch]);

  const { data: amtData, isLoading: loadingAmts } = useReadContracts({
    allowFailure: true,
    contracts:
      deployed && address && batchIds.length > 0
        ? batchIds.map((batch) => ({
            address: DIEM_STAKING_PROXY,
            abi: DIEM_STAKING_PROXY_ABI,
            functionName: 'unstakeBatchUserAmount' as const,
            args: [batch, address] as const,
          }))
        : [],
    query: { enabled: deployed && !!address && batchIds.length > 0, refetchInterval: POLL_MS },
  });

  const activeBatchIdx = useMemo(() => {
    if (!amtData) return -1;
    for (let i = 0; i < amtData.length; i++) {
      const r = amtData[i]?.result;
      if (typeof r === 'bigint' && r > 0n) return i;
    }
    return -1;
  }, [amtData]);

  const activeBatchId = activeBatchIdx >= 0 ? batchIds[activeBatchIdx] : null;
  const activeAmount =
    activeBatchIdx >= 0 ? (amtData?.[activeBatchIdx]?.result as bigint | undefined) ?? null : null;

  const { data: batchDetail, isLoading: loadingBatchDetail } = useReadContract({
    address: DIEM_STAKING_PROXY,
    abi: DIEM_STAKING_PROXY_ABI,
    functionName: 'unstakeBatches',
    args: activeBatchId != null ? [activeBatchId] : undefined,
    query: { enabled: deployed && activeBatchId != null, refetchInterval: POLL_MS },
  });

  const state = useMemo<UnstakeState>(() => {
    if (activeBatchId == null || activeAmount == null || activeAmount === 0n) return { status: 'none' };
    if (!batchDetail) return { status: 'none' };
    const [, unlockAtRaw, , claimed] = batchDetail as readonly [bigint, bigint, number, boolean];
    const unlockAt = Number(unlockAtRaw);
    const now = Math.floor(Date.now() / 1000);

    if (unlockAt === 0) {
      const waitingForPriorBatch = currentUnstakeBatch != null && oldestUnclaimedUnstakeBatch != null && currentUnstakeBatch !== oldestUnclaimedUnstakeBatch;
      return { status: 'queued', batchId: activeBatchId, amount: activeAmount, waitingForPriorBatch };
    }
    if (!claimed && now < unlockAt) {
      return { status: 'cooling', batchId: activeBatchId, amount: activeAmount, unlockAt };
    }
    if (!claimed && now >= unlockAt) {
      return { status: 'claimable', batchId: activeBatchId, amount: activeAmount };
    }
    return { status: 'none' };
  }, [activeBatchId, activeAmount, batchDetail, currentUnstakeBatch, oldestUnclaimedUnstakeBatch]);

  return { state, isLoading: loadingClock || loadingAmts || loadingBatchDetail };
}

export function useLastEpochUsdc(): { lastEpochUsdc: bigint | null; isLoading: boolean } {
  const client = usePublicClient();
  const deployed = useProxyDeployed();
  const { syncedRewardEpoch } = usePoolStats();

  const { data, isLoading } = useQuery({
    queryKey: ['lastEpochUsdc', DIEM_STAKING_PROXY, syncedRewardEpoch],
    enabled: !!client && deployed && syncedRewardEpoch != null && syncedRewardEpoch >= 1,
    staleTime: POLL_MS,
    refetchInterval: POLL_MS * 5,
    queryFn: async (): Promise<bigint | null> => {
      if (!client || syncedRewardEpoch == null || syncedRewardEpoch < 1) return null;

      const closedAbi = DIEM_STAKING_PROXY_ABI.find(
        (e) => e.type === 'event' && e.name === 'RewardEpochClosed',
      );
      if (!closedAbi) return null;

      const head = await client.getBlockNumber();
      const lookback = 500_000n;
      const fromBlock = head > lookback ? head - lookback : 0n;

      const closedLogs = await client.getLogs({
        address: DIEM_STAKING_PROXY,
        event: closedAbi,
        args: { rewardEpochId: syncedRewardEpoch - 1 },
        fromBlock,
        toBlock: head,
      });
      if (closedLogs.length === 0) return null;
      const totalPoints = (closedLogs[closedLogs.length - 1]!.args as { totalPoints?: bigint }).totalPoints;
      return typeof totalPoints === 'bigint' ? totalPoints : null;
    },
  });

  return { lastEpochUsdc: data ?? null, isLoading };
}

export function useDiemAllowance(): { allowance: bigint | null; refetch: () => void } {
  const { address } = useAccount();
  const deployed = useProxyDeployed();
  const enabled = deployed && !!address;
  const { data, refetch } = useReadContract({
    address: DIEM_TOKEN,
    abi: DIEM_TOKEN_ABI,
    functionName: 'allowance',
    args: enabled ? [address!, DIEM_STAKING_PROXY] : undefined,
    query: { enabled, refetchInterval: POLL_MS },
  });
  return { allowance: (data as bigint | undefined) ?? null, refetch: () => { void refetch(); } };
}
