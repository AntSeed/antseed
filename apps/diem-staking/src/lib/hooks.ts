// On-chain read hooks (tanstack-backed via wagmi) and a small grab-bag of
// derived state. Every read is live and polls; there are no hardcoded display
// values. Hooks return `null` when the proxy isn't deployed yet, so the UI
// renders clean "—" placeholders without throwing.

import { useEffect, useMemo, useState } from 'react';
import { useAccount, usePublicClient, useReadContract, useReadContracts } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
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
  /** First Antseed emission epoch this proxy can attribute rewards for. */
  firstRewardEpoch: number | null;
  /** First finalized reward epoch not yet closed in proxy storage. */
  syncedRewardEpoch: number | null;
  /** First reward epoch not finalized yet by deterministic Antseed emissions time. */
  finalizedRewardEpoch: number | null;
  /** Venice DIEM unstake cooldown in seconds (read live from the token). */
  diemCooldownSecs: number | null;
  /** Minimum seconds a batch must stay open before `flush()` is allowed. */
  minUnstakeBatchOpenSecs: number | null;
  /** Unix timestamp at which the currently-open batch can first be
   *  flushed. `0` means the batch is empty (no first queuer yet) — in
   *  that case `flush` is blocked by `NothingToFlush` regardless. */
  flushableAt: number | null;
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
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'firstRewardEpoch' },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'syncedRewardEpoch' },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'finalizedRewardEpoch' },
      { address: DIEM_TOKEN,         abi: DIEM_TOKEN_ABI,         functionName: 'cooldownDuration' },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'minUnstakeBatchOpenSecs' },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'flushableAt' },
    ],
    query: { enabled: deployed, refetchInterval: POLL_MS },
  });

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
      isLoading,
    };
  }
  // `flushableAt()` returns `0` while the batch is empty (no first queuer
  // yet). We preserve the distinction by mapping `0` → `null` so the UI can
  // tell "no clock running" apart from "clock running, starting now".
  const flushableAtRaw = data[9]?.result != null ? Number(data[9].result) : null;
  return {
    totalStaked: data[0]?.result ?? null,
    stakerCount: data[1]?.result != null ? Number(data[1].result) : null,
    totalUsdcDistributedEver: data[2]?.result ?? null,
    maxTotalStake: data[3]?.result ?? null,
    firstRewardEpoch: data[4]?.result != null ? Number(data[4].result) : null,
    syncedRewardEpoch: data[5]?.result != null ? Number(data[5].result) : null,
    finalizedRewardEpoch: data[6]?.result != null ? Number(data[6].result) : null,
    diemCooldownSecs: data[7]?.result != null ? Number(data[7].result) : null,
    minUnstakeBatchOpenSecs: data[8]?.result != null ? Number(data[8].result) : null,
    flushableAt: flushableAtRaw && flushableAtRaw > 0 ? flushableAtRaw : null,
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
  /** Explicit reward epochs to pass to claimAnts. */
  claimableAntsEpochs: number[];
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
  const { pendingAnts, claimableEpochs, isLoading: loadingAnts } = usePendingAnts(address ?? null, userLastClaimedEpoch);

  if (!enabled) {
    return {
      walletDiem: null,
      stakedDiem: null,
      pendingUsdc: null,
      pendingAnts: null,
      claimableAntsEpochs: [],
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
    userLastClaimedEpoch,
    isLoading: loadingSimple || loadingAnts,
  };
}

/** Maximum number of reward epochs to preview-sum in one call.
 *
 *  MUST stay in lockstep with `DiemStakingProxy.MAX_EPOCHS_PER_CAPTURE`
 *  (see packages/contracts/DiemStakingProxy.sol). If the contract raises
 *  or lowers its bound, update this constant too — otherwise `claimAnts`
 *  calls sized from this preview can revert `BacklogTooLarge` on-chain. */
const MAX_EPOCHS_PREVIEW = 16;

/**
 * Sum `pendingAntsForEpoch` over the user's claimable range. Uses the same
 * multicall provider the other hooks do, so the cost is one batched RPC
 * regardless of backlog size (bounded by MAX_EPOCHS_PREVIEW).
 */
function usePendingAnts(
  user: Address | null,
  userLastClaimedEpoch: number | null,
): { pendingAnts: bigint | null; claimableEpochs: number[]; isLoading: boolean } {
  const { firstRewardEpoch, finalizedRewardEpoch } = usePoolStats();

  const epochsToRead = useMemo(() => {
    if (user == null || userLastClaimedEpoch == null || firstRewardEpoch == null || finalizedRewardEpoch == null) return [];
    const from = Math.max(userLastClaimedEpoch, firstRewardEpoch);
    const to = Math.min(finalizedRewardEpoch, from + MAX_EPOCHS_PREVIEW);
    const out: number[] = [];
    for (let e = from; e < to; e++) out.push(e);
    return out;
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

  return { pendingAnts, claimableEpochs, isLoading: loadingPending || loadingClaimed };
}

// ─── Unstake queue: derived state machine ────────────────────────────────

export type UnstakeState =
  | { status: 'none' }
  | { status: 'queued'; batchId: number; amount: bigint; waitingForPriorBatch: boolean }
  | { status: 'cooling'; batchId: number; amount: bigint; unlockAt: number }
  | { status: 'claimable'; batchId: number; amount: bigint };

/**
 * Resolves the user's unstake-queue state by reading:
 *   - `currentUnstakeBatch` (the open-for-queuing batch)
 *   - `oldestUnclaimedUnstakeBatch` (lowest flushed-but-not-yet-claimed)
 *   - user's amount in each batch from `oldestUnclaimedUnstakeBatch..=currentUnstakeBatch`
 *   - `unstakeBatches(id).unlockAt` + `claimed` for the batch the user is in
 *
 * A user can only have queued amount in at most one batch at a time per the
 * contract's semantics (initiateUnstake always adds to `currentUnstakeBatch`, and
 * claimUnstakeBatch removes the mapping entry). We scan up to 4 recent batches to
 * be safe against races between reads.
 */
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

  // batch ids to probe: every in-flight batch [oldestUnclaimedUnstakeBatch, currentUnstakeBatch].
  // Capped at a small window since MAX_PER_UNSTAKE_BATCH bounds the batch size and
  // the user can only hold amount in one batch at a time.
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
    // unstakeBatches(id) returns (uint128 total, uint64 unlockAt, uint32 userCount, bool claimed)
    const [, unlockAtRaw, , claimed] = batchDetail as readonly [bigint, bigint, number, boolean];
    const unlockAt = Number(unlockAtRaw);
    const now = Math.floor(Date.now() / 1000);

    if (unlockAt === 0) {
      // Still queuing: this is the current open batch. Flush is blocked
      // until the prior batch is claimed (currentUnstakeBatch == oldestUnclaimedUnstakeBatch).
      const waitingForPriorBatch = currentUnstakeBatch != null && oldestUnclaimedUnstakeBatch != null && currentUnstakeBatch !== oldestUnclaimedUnstakeBatch;
      return { status: 'queued', batchId: activeBatchId!, amount: activeAmount!, waitingForPriorBatch };
    }
    if (!claimed && now < unlockAt) {
      return { status: 'cooling', batchId: activeBatchId!, amount: activeAmount!, unlockAt };
    }
    if (!claimed && now >= unlockAt) {
      return { status: 'claimable', batchId: activeBatchId!, amount: activeAmount! };
    }
    // claimed but user still shown as having amount → the mapping entry will
    // be cleared on next claim batch. Treat as `none` so the UI clears.
    return { status: 'none' };
  }, [activeBatchId, activeAmount, batchDetail, currentUnstakeBatch, oldestUnclaimedUnstakeBatch]);

  return { state, isLoading: loadingClock || loadingAmts || loadingBatchDetail };
}

// ─── Last-epoch USDC: in-browser getLogs aggregation ─────────────────────

/**
 * Sum the `UsdcDistributed(amount)` events emitted during the most recently
 * completed reward epoch. The "last epoch" boundary comes from the indexed
 * `RewardEpochClosed(rewardEpochId, ...)` events: the range is the block of
 * RewardEpochClosed(N-2) (exclusive, defaults to contract creation if none)
 * through RewardEpochClosed(N-1) (inclusive), where N = syncedRewardEpoch.
 *
 * Provider RPCs cap `eth_getLogs` range differently (10k blocks on public
 * nodes is typical). A fully-indexed deployment should replace this with a
 * dedicated indexer, but while demand is light the in-browser getLogs call
 * is sufficient and keeps the app self-contained.
 */
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
      const distAbi = DIEM_STAKING_PROXY_ABI.find(
        (e) => e.type === 'event' && e.name === 'UsdcDistributed',
      );
      if (!closedAbi || !distAbi) return null;

      // Find the RewardEpochClosed(rewardEpochId = syncedRewardEpoch - 1) block to
      // bound the window. Search over the last 500k blocks (≈ 11 days on Base
      // at 2s). If a deployment is older than that or under heavy traffic,
      // the caller should migrate to an indexer.
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
      const closedAt = closedLogs[closedLogs.length - 1]!.blockNumber;
      if (closedAt == null) return null;

      // Prior closure (may be absent if syncedRewardEpoch === 1).
      let priorAt: bigint = fromBlock;
      if (syncedRewardEpoch >= 2) {
        const priorLogs = await client.getLogs({
          address: DIEM_STAKING_PROXY,
          event: closedAbi,
          args: { rewardEpochId: syncedRewardEpoch - 2 },
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
