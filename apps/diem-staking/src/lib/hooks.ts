// On-chain read hooks (tanstack-backed via wagmi) and a small grab-bag of
// derived state. Every read is live and polls; there are no hardcoded display
// values. Hooks return `null` when the proxy isn't deployed yet, so the UI
// renders clean "—" placeholders without throwing.

import { useEffect, useMemo, useState } from 'react';
import { useAccount, useReadContract, useReadContracts } from 'wagmi';
import type { Address } from 'viem';

import { DIEM_TOKEN, DIEM_STAKING_PROXY, isAddressSet } from './addresses';
import { DIEM_STAKING_PROXY_ABI, DIEM_TOKEN_ABI } from './abi';
import { computeEpochClock, type EpochClock } from './epoch';

const POLL_MS = 12_000; // a bit above Base's 2s block time × a few blocks

export function useProxyDeployed(): boolean {
  return isAddressSet(DIEM_STAKING_PROXY);
}

// ─── Off-chain: DIEM market price (CoinGecko) ────────────────────────────

/**
 * Best-effort DIEM/USD price from CoinGecko. Tries a small list of plausible
 * coin ids (DIEM listings vary by aggregator). Returns `null` on all misses,
 * which the UI renders as "—" and disables APR.
 */
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
          /* try next id */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return price;
}

// ─── Epoch countdown (wall-clock; no on-chain read) ──────────────────────

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

// ─── Pool-wide on-chain stats ────────────────────────────────────────────

export interface PoolStats {
  /** Total DIEM staked across all users (base units). */
  totalStaked: bigint | null;
  /** Distinct addresses with staked > 0. */
  stakerCount: number | null;
  /** Lifetime USDC distributed to stakers (base units, USDC has 6 decimals). */
  totalUsdcDistributedEver: bigint | null;
  /** Owner-set cap on totalStaked (0 = unlimited). */
  maxTotalStake: bigint | null;
  /** Completed reward-epoch count (from the proxy). Open epoch is currentRewardEpoch. */
  currentRewardEpoch: number | null;
  /** Venice DIEM unstake cooldown in seconds (read live from the token). */
  diemCooldownSecs: number | null;
  /** True while any of the reads above are in-flight. */
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
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'currentRewardEpoch' },
      { address: DIEM_TOKEN,         abi: DIEM_TOKEN_ABI,         functionName: 'cooldownDuration' },
    ],
    query: { enabled: deployed, refetchInterval: POLL_MS },
  });

  if (!deployed || !data) {
    return {
      totalStaked: null,
      stakerCount: null,
      totalUsdcDistributedEver: null,
      maxTotalStake: null,
      currentRewardEpoch: null,
      diemCooldownSecs: null,
      isLoading,
    };
  }
  return {
    totalStaked: data[0]?.result ?? null,
    stakerCount: data[1]?.result != null ? Number(data[1].result) : null,
    totalUsdcDistributedEver: data[2]?.result ?? null,
    maxTotalStake: data[3]?.result ?? null,
    currentRewardEpoch: data[4]?.result != null ? Number(data[4].result) : null,
    diemCooldownSecs: data[5]?.result != null ? Number(data[5].result) : null,
    isLoading,
  };
}

// ─── Per-user state: balances, stake, claims, unstake queue ──────────────

export interface UserStats {
  /** Wallet DIEM balance (base units, 18 dec). */
  walletDiem: bigint | null;
  /** DIEM actively staked in the proxy. */
  stakedDiem: bigint | null;
  /** Pending USDC claimable via claimUsdc (base units, 6 dec). */
  pendingUsdc: bigint | null;
  /** Total ANTS claimable across user's backlog of completed reward epochs. */
  pendingAnts: bigint | null;
  /** Next reward-epoch index the user hasn't claimed yet. */
  userLastClaimedEpoch: number | null;
  /** True while any of the reads above are in-flight. */
  isLoading: boolean;
}

/**
 * Bundles the cheap per-user reads into one multicall. ANTS is then summed
 * in a second hook since its loop size depends on the user's backlog.
 */
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
  const { pendingAnts, isLoading: loadingAnts } = usePendingAnts(address ?? null, userLastClaimedEpoch);

  if (!enabled) {
    return {
      walletDiem: null,
      stakedDiem: null,
      pendingUsdc: null,
      pendingAnts: null,
      userLastClaimedEpoch: null,
      isLoading: loadingSimple,
    };
  }
  return {
    walletDiem: simple?.[0]?.result ?? null,
    stakedDiem: simple?.[1]?.result ?? null,
    pendingUsdc: simple?.[2]?.result ?? null,
    pendingAnts,
    userLastClaimedEpoch,
    isLoading: loadingSimple || loadingAnts,
  };
}

/** Maximum number of epochs to preview-sum in one call. Matches the
 *  proxy's `MAX_EPOCHS_PER_CAPTURE` so claimAnts will succeed without
 *  requiring a prior catchUpPoints. */
const MAX_EPOCHS_PREVIEW = 16;

/**
 * Sum `pendingAntsForEpoch` over the user's claimable range. Uses the same
 * multicall provider the other hooks do, so the cost is one batched RPC
 * regardless of backlog size (bounded by MAX_EPOCHS_PREVIEW).
 */
function usePendingAnts(
  user: Address | null,
  userLastClaimedEpoch: number | null,
): { pendingAnts: bigint | null; isLoading: boolean } {
  const { currentRewardEpoch } = usePoolStats();

  const epochsToRead = useMemo(() => {
    if (user == null || userLastClaimedEpoch == null || currentRewardEpoch == null) return [];
    const to = Math.min(currentRewardEpoch, userLastClaimedEpoch + MAX_EPOCHS_PREVIEW);
    const out: number[] = [];
    for (let e = userLastClaimedEpoch; e < to; e++) out.push(e);
    return out;
  }, [user, userLastClaimedEpoch, currentRewardEpoch]);

  const { data, isLoading } = useReadContracts({
    allowFailure: true,
    contracts: epochsToRead.map((e) => ({
      address: DIEM_STAKING_PROXY,
      abi: DIEM_STAKING_PROXY_ABI,
      functionName: 'pendingAntsForEpoch' as const,
      args: [user!, e] as const,
    })),
    query: { enabled: epochsToRead.length > 0, refetchInterval: POLL_MS },
  });

  const pendingAnts = useMemo<bigint | null>(() => {
    if (user == null) return null;
    if (epochsToRead.length === 0) return 0n;
    if (!data) return null;
    let sum = 0n;
    for (const r of data) {
      if (typeof r.result === 'bigint') sum += r.result;
    }
    return sum;
  }, [user, epochsToRead.length, data]);

  return { pendingAnts, isLoading };
}

// ─── Unstake queue: derived state machine ────────────────────────────────

export type UnstakeState =
  | { status: 'none' }
  | { status: 'queued'; epochId: number; amount: bigint; waitingForPriorEpoch: boolean }
  | { status: 'cooling'; epochId: number; amount: bigint; unlockAt: number }
  | { status: 'claimable'; epochId: number; amount: bigint };

/**
 * Resolves the user's unstake-queue state by reading:
 *   - `currentEpoch` (the open-for-queuing epoch)
 *   - `oldestUnclaimed` (lowest flushed-but-not-yet-claimed)
 *   - user's amount in each epoch from `oldestUnclaimed..=currentEpoch`
 *   - `epochs(id).unlockAt` + `claimed` for the epoch the user is in
 *
 * A user can only have queued amount in at most one epoch at a time per the
 * contract's semantics (initiateUnstake always adds to `currentEpoch`, and
 * claimEpoch removes the mapping entry). We scan up to 4 recent epochs to
 * be safe against races between reads.
 */
export function useUnstakeState(): { state: UnstakeState; isLoading: boolean } {
  const { address } = useAccount();
  const deployed = useProxyDeployed();

  const { data: clockData, isLoading: loadingClock } = useReadContracts({
    allowFailure: true,
    contracts: deployed
      ? [
          { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'currentEpoch' },
          { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'oldestUnclaimed' },
        ]
      : [],
    query: { enabled: deployed, refetchInterval: POLL_MS },
  });

  const currentEpoch = clockData?.[0]?.result != null ? Number(clockData[0].result) : null;
  const oldestUnclaimed = clockData?.[1]?.result != null ? Number(clockData[1].result) : null;

  // Epoch ids to probe: every in-flight epoch [oldestUnclaimed, currentEpoch].
  // Capped at a small window since MAX_PER_EPOCH bounds the cohort size and
  // the user can only hold amount in one epoch at a time.
  const epochIds = useMemo(() => {
    if (currentEpoch == null || oldestUnclaimed == null) return [];
    const ids: number[] = [];
    for (let e = oldestUnclaimed; e <= currentEpoch && e < oldestUnclaimed + 4; e++) ids.push(e);
    return ids;
  }, [currentEpoch, oldestUnclaimed]);

  const { data: amtData, isLoading: loadingAmts } = useReadContracts({
    allowFailure: true,
    contracts:
      deployed && address && epochIds.length > 0
        ? epochIds.map((e) => ({
            address: DIEM_STAKING_PROXY,
            abi: DIEM_STAKING_PROXY_ABI,
            functionName: 'epochUserAmount' as const,
            args: [e, address] as const,
          }))
        : [],
    query: { enabled: deployed && !!address && epochIds.length > 0, refetchInterval: POLL_MS },
  });

  const activeEpochIdx = useMemo(() => {
    if (!amtData) return -1;
    for (let i = 0; i < amtData.length; i++) {
      const r = amtData[i]?.result;
      if (typeof r === 'bigint' && r > 0n) return i;
    }
    return -1;
  }, [amtData]);

  const activeEpochId = activeEpochIdx >= 0 ? epochIds[activeEpochIdx] : null;
  const activeAmount =
    activeEpochIdx >= 0 ? (amtData?.[activeEpochIdx]?.result as bigint | undefined) ?? null : null;

  const { data: epochDetail, isLoading: loadingDetail } = useReadContract({
    address: DIEM_STAKING_PROXY,
    abi: DIEM_STAKING_PROXY_ABI,
    functionName: 'epochs',
    args: activeEpochId != null ? [activeEpochId] : undefined,
    query: { enabled: deployed && activeEpochId != null, refetchInterval: POLL_MS },
  });

  const state = useMemo<UnstakeState>(() => {
    if (activeEpochId == null || activeAmount == null || activeAmount === 0n) return { status: 'none' };
    if (!epochDetail) return { status: 'none' };
    // epochs(id) returns (uint128 total, uint64 unlockAt, uint32 userCount, bool claimed)
    const [, unlockAtRaw, , claimed] = epochDetail as readonly [bigint, bigint, number, boolean];
    const unlockAt = Number(unlockAtRaw);
    const now = Math.floor(Date.now() / 1000);

    if (unlockAt === 0) {
      // Still queuing: this is the current open epoch. Flush is blocked
      // until the prior epoch is claimed (currentEpoch == oldestUnclaimed).
      const waitingForPriorEpoch = currentEpoch != null && oldestUnclaimed != null && currentEpoch !== oldestUnclaimed;
      return { status: 'queued', epochId: activeEpochId!, amount: activeAmount!, waitingForPriorEpoch };
    }
    if (!claimed && now < unlockAt) {
      return { status: 'cooling', epochId: activeEpochId!, amount: activeAmount!, unlockAt };
    }
    if (!claimed && now >= unlockAt) {
      return { status: 'claimable', epochId: activeEpochId!, amount: activeAmount! };
    }
    // claimed but user still shown as having amount → the mapping entry will
    // be cleared on next claim batch. Treat as `none` so the UI clears.
    return { status: 'none' };
  }, [activeEpochId, activeAmount, epochDetail, currentEpoch, oldestUnclaimed]);

  return { state, isLoading: loadingClock || loadingAmts || loadingDetail };
}

// ─── Last-epoch USDC: in-browser getLogs aggregation ─────────────────────

/**
 * Sum the `UsdcDistributed(amount)` events emitted during the most recently
 * completed reward epoch. The "last epoch" boundary comes from the indexed
 * `RewardEpochClosed(rewardEpochId, ...)` events: the range is the block of
 * RewardEpochClosed(N-2) (exclusive, defaults to contract creation if none)
 * through RewardEpochClosed(N-1) (inclusive), where N = currentRewardEpoch.
 *
 * Provider RPCs cap `eth_getLogs` range differently (10k blocks on public
 * nodes is typical). A fully-indexed deployment should replace this with a
 * dedicated indexer, but while demand is light the in-browser getLogs call
 * is sufficient and keeps the app self-contained.
 */
import { usePublicClient } from 'wagmi';
import { useQuery } from '@tanstack/react-query';

export function useLastEpochUsdc(): { lastEpochUsdc: bigint | null; isLoading: boolean } {
  const client = usePublicClient();
  const deployed = useProxyDeployed();
  const { currentRewardEpoch } = usePoolStats();

  const { data, isLoading } = useQuery({
    queryKey: ['lastEpochUsdc', DIEM_STAKING_PROXY, currentRewardEpoch],
    enabled: !!client && deployed && currentRewardEpoch != null && currentRewardEpoch >= 1,
    staleTime: POLL_MS,
    refetchInterval: POLL_MS * 5,
    queryFn: async (): Promise<bigint | null> => {
      if (!client || currentRewardEpoch == null || currentRewardEpoch < 1) return null;

      const closedAbi = DIEM_STAKING_PROXY_ABI.find(
        (e) => e.type === 'event' && e.name === 'RewardEpochClosed',
      );
      const distAbi = DIEM_STAKING_PROXY_ABI.find(
        (e) => e.type === 'event' && e.name === 'UsdcDistributed',
      );
      if (!closedAbi || !distAbi) return null;

      // Find the RewardEpochClosed(epochId = currentRewardEpoch - 1) block to
      // bound the window. Search over the last 500k blocks (≈ 11 days on Base
      // at 2s). If a deployment is older than that or under heavy traffic,
      // the caller should migrate to an indexer.
      const head = await client.getBlockNumber();
      const lookback = 500_000n;
      const fromBlock = head > lookback ? head - lookback : 0n;

      const closedLogs = await client.getLogs({
        address: DIEM_STAKING_PROXY,
        event: closedAbi,
        args: { rewardEpochId: currentRewardEpoch - 1 },
        fromBlock,
        toBlock: head,
      });
      if (closedLogs.length === 0) return null;
      const closedAt = closedLogs[closedLogs.length - 1]!.blockNumber;
      if (closedAt == null) return null;

      // Prior closure (may be absent if currentRewardEpoch === 1).
      let priorAt: bigint = fromBlock;
      if (currentRewardEpoch >= 2) {
        const priorLogs = await client.getLogs({
          address: DIEM_STAKING_PROXY,
          event: closedAbi,
          args: { rewardEpochId: currentRewardEpoch - 2 },
          fromBlock,
          toBlock: closedAt,
        });
        if (priorLogs.length > 0 && priorLogs[priorLogs.length - 1]!.blockNumber != null) {
          priorAt = priorLogs[priorLogs.length - 1]!.blockNumber! + 1n;
        }
      }

      const distLogs = await client.getLogs({
        address: DIEM_STAKING_PROXY,
        event: distAbi,
        fromBlock: priorAt,
        toBlock: closedAt,
      });

      let sum = 0n;
      for (const l of distLogs) {
        const amt = (l.args as { amount?: bigint }).amount;
        if (typeof amt === 'bigint') sum += amt;
      }
      return sum;
    },
  });

  return { lastEpochUsdc: data ?? null, isLoading };
}

// ─── DIEM allowance (stake requires ERC-20 approve) ──────────────────────

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
