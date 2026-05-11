import { type PublicClient } from 'viem';
import { DIEM_STAKING_PROXY_ABI, DIEM_STAKING_PROXY_ADDRESS } from '../abi';
import { asBigint, asNumber } from './format';

export interface DiemEpochRow {
  epoch: number;
  amount: bigint;
  claimed: boolean;
}

export interface DiemEpochScan {
  firstRewardEpoch: number;
  finalizedRewardEpoch: number;
  syncedRewardEpoch: number;
  userLastClaimedEpoch: number;
  rows: DiemEpochRow[];
  hasMore: boolean;
}

/**
 * Read the DIEM staking proxy cursor and walk up to `scanLimit` finalized
 * epochs forward from the user's last-claimed boundary, returning per-epoch
 * pending amount + claimed status.
 */
export async function scanDiemEpochs(
  publicClient: PublicClient,
  address: `0x${string}`,
  scanLimit: number,
): Promise<DiemEpochScan> {
  const [firstRaw, finalizedRaw, syncedRaw, lastClaimedRaw] = await publicClient.multicall({
    allowFailure: true,
    contracts: [
      { address: DIEM_STAKING_PROXY_ADDRESS, abi: DIEM_STAKING_PROXY_ABI, functionName: 'firstRewardEpoch' },
      { address: DIEM_STAKING_PROXY_ADDRESS, abi: DIEM_STAKING_PROXY_ABI, functionName: 'finalizedRewardEpoch' },
      { address: DIEM_STAKING_PROXY_ADDRESS, abi: DIEM_STAKING_PROXY_ABI, functionName: 'syncedRewardEpoch' },
      { address: DIEM_STAKING_PROXY_ADDRESS, abi: DIEM_STAKING_PROXY_ABI, functionName: 'userLastClaimedEpoch', args: [address] },
    ],
  });

  // The cursor reads define the scan window. Coercing failures to 0 silently
  // produces an empty result that looks identical to "no rewards", so the UI
  // never sees the RPC error. Surface it instead.
  const cursorFailure =
    firstRaw.status === 'failure' ||
    finalizedRaw.status === 'failure' ||
    syncedRaw.status === 'failure' ||
    lastClaimedRaw.status === 'failure';
  if (cursorFailure) {
    const firstError =
      (firstRaw.status === 'failure' && firstRaw.error) ||
      (finalizedRaw.status === 'failure' && finalizedRaw.error) ||
      (syncedRaw.status === 'failure' && syncedRaw.error) ||
      (lastClaimedRaw.status === 'failure' && lastClaimedRaw.error);
    throw new Error(
      `DIEM staking proxy unavailable: ${firstError instanceof Error ? firstError.message : 'cursor read failed'}`,
    );
  }

  const firstRewardEpoch = asNumber(firstRaw.result);
  const finalizedRewardEpoch = asNumber(finalizedRaw.result);
  const syncedRewardEpoch = asNumber(syncedRaw.result);
  const userLastClaimedEpoch = asNumber(lastClaimedRaw.result);

  const from = Math.max(userLastClaimedEpoch, firstRewardEpoch);
  const to = Math.min(finalizedRewardEpoch, from + scanLimit);
  const epochs: number[] = [];
  for (let e = from; e < to; e += 1) epochs.push(e);

  let rows: DiemEpochRow[] = [];
  if (epochs.length > 0) {
    const results = await publicClient.multicall({
      allowFailure: true,
      contracts: epochs.flatMap((epoch) => [
        { address: DIEM_STAKING_PROXY_ADDRESS, abi: DIEM_STAKING_PROXY_ABI, functionName: 'pendingAntsForEpoch', args: [address, epoch] as const },
        { address: DIEM_STAKING_PROXY_ADDRESS, abi: DIEM_STAKING_PROXY_ABI, functionName: 'userEpochClaimed',    args: [address, epoch] as const },
      ]),
    });
    rows = epochs.map((epoch, i) => ({
      epoch,
      amount: asBigint(results[i * 2]?.result),
      claimed: results[i * 2 + 1]?.result === true,
    }));
  }

  return {
    firstRewardEpoch,
    finalizedRewardEpoch,
    syncedRewardEpoch,
    userLastClaimedEpoch,
    rows,
    hasMore: from + scanLimit < finalizedRewardEpoch,
  };
}
