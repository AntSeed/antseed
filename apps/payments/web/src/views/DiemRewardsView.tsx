import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, usePublicClient, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { formatUnits, parseAbi } from 'viem';
import type { PaymentConfig } from '../types';
import { DIEM_STAKING_PROXY_ABI, DIEM_STAKING_PROXY_ADDRESS } from '../diem-proxy-abi';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';

interface DiemRewardsViewProps {
  config: PaymentConfig | null;
}

interface DiemRewardRow {
  epoch: number;
  amount: bigint;
  claimed: boolean;
}

interface DiemRewardSnapshot {
  firstRewardEpoch: number;
  finalizedRewardEpoch: number;
  syncedRewardEpoch: number;
  userLastClaimedEpoch: number;
  rows: DiemRewardRow[];
  hasMore: boolean;
}

const ANTS_DECIMALS = 18;
const MAX_EPOCHS_PREVIEW = 16;
const DIEM_PROXY_ABI = parseAbi(DIEM_STAKING_PROXY_ABI);

function formatAnts(amountWei: bigint): string {
  const n = parseFloat(formatUnits(amountWei, ANTS_DECIMALS));
  if (n === 0) return '0';
  if (n < 0.0001) return '< 0.0001';
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatEpochRange(snapshot: DiemRewardSnapshot): string {
  if (snapshot.rows.length === 0) return 'No finalized epochs in range';
  const first = snapshot.rows[0]?.epoch;
  const last = snapshot.rows[snapshot.rows.length - 1]?.epoch;
  return first === last ? `Epoch #${first}` : `Epochs #${first}–#${last}`;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function asBigint(value: unknown): bigint {
  return typeof value === 'bigint' ? value : 0n;
}

export function DiemRewardsView({ config }: DiemRewardsViewProps) {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const accountAddress = address ?? null;
  const { expectedChainId, ensureCorrectNetwork } = usePaymentNetwork(config);

  const [snapshot, setSnapshot] = useState<DiemRewardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimSuccess, setClaimSuccess] = useState(false);

  const {
    writeContract,
    data: claimTx,
    reset: resetClaim,
    isPending: claimSubmitting,
  } = useWriteContract();
  const { isSuccess: claimConfirmed } = useWaitForTransactionReceipt({
    hash: claimTx,
    chainId: expectedChainId,
  });

  const load = useCallback(async () => {
    if (!isConnected || !accountAddress || !publicClient) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [firstRewardEpochRaw, finalizedRewardEpochRaw, syncedRewardEpochRaw, userLastClaimedEpochRaw] = await publicClient.multicall({
        allowFailure: true,
        contracts: [
          { address: DIEM_STAKING_PROXY_ADDRESS, abi: DIEM_PROXY_ABI, functionName: 'firstRewardEpoch' },
          { address: DIEM_STAKING_PROXY_ADDRESS, abi: DIEM_PROXY_ABI, functionName: 'finalizedRewardEpoch' },
          { address: DIEM_STAKING_PROXY_ADDRESS, abi: DIEM_PROXY_ABI, functionName: 'syncedRewardEpoch' },
          { address: DIEM_STAKING_PROXY_ADDRESS, abi: DIEM_PROXY_ABI, functionName: 'userLastClaimedEpoch', args: [accountAddress] },
        ],
      });

      const firstRewardEpoch = asNumber(firstRewardEpochRaw.result);
      const finalizedRewardEpoch = asNumber(finalizedRewardEpochRaw.result);
      const syncedRewardEpoch = asNumber(syncedRewardEpochRaw.result);
      const userLastClaimedEpoch = asNumber(userLastClaimedEpochRaw.result);
      const from = Math.max(userLastClaimedEpoch, firstRewardEpoch);
      const to = Math.min(finalizedRewardEpoch, from + MAX_EPOCHS_PREVIEW);
      const epochs: number[] = [];
      for (let e = from; e < to; e += 1) epochs.push(e);

      const rows = epochs.length === 0
        ? []
        : await publicClient.multicall({
            allowFailure: true,
            contracts: epochs.flatMap((epoch) => [
              {
                address: DIEM_STAKING_PROXY_ADDRESS,
                abi: DIEM_PROXY_ABI,
                functionName: 'pendingAntsForEpoch',
                args: [accountAddress, epoch] as const,
              },
              {
                address: DIEM_STAKING_PROXY_ADDRESS,
                abi: DIEM_PROXY_ABI,
                functionName: 'userEpochClaimed',
                args: [accountAddress, epoch] as const,
              },
            ]),
          });

      const rewardRows: DiemRewardRow[] = epochs.map((epoch, i) => ({
        epoch,
        amount: asBigint(rows[i * 2]?.result),
        claimed: rows[i * 2 + 1]?.result === true,
      }));

      setSnapshot({
        firstRewardEpoch,
        finalizedRewardEpoch,
        syncedRewardEpoch,
        userLastClaimedEpoch,
        rows: rewardRows,
        hasMore: from + MAX_EPOCHS_PREVIEW < finalizedRewardEpoch,
      });
    } catch (err) {
      setLoadError(getErrorMessage(err, 'Unable to load Venice.ai Proxy rewards.'));
    } finally {
      setLoading(false);
    }
  }, [accountAddress, isConnected, publicClient]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (claimConfirmed) {
      setClaimSuccess(true);
      resetClaim();
      void load();
    }
  }, [claimConfirmed, load, resetClaim]);

  const claimableEpochs = useMemo(() => (
    snapshot?.rows.filter((r) => !r.claimed).map((r) => r.epoch) ?? []
  ), [snapshot]);

  const totalPending = useMemo(() => (
    snapshot?.rows.reduce((sum, row) => sum + row.amount, 0n) ?? 0n
  ), [snapshot]);

  const handleClaim = useCallback(() => {
    if (!snapshot || claimableEpochs.length === 0) return;
    setClaimError(null);
    setClaimSuccess(false);
    void (async () => {
      try {
        await ensureCorrectNetwork();
        writeContract({
          address: DIEM_STAKING_PROXY_ADDRESS,
          abi: DIEM_PROXY_ABI,
          functionName: 'claimAnts',
          chainId: expectedChainId,
          args: [claimableEpochs],
        }, {
          onError: (err) => setClaimError(getErrorMessage(err)),
        });
      } catch (err) {
        setClaimError(getErrorMessage(err));
      }
    })();
  }, [claimableEpochs, ensureCorrectNetwork, expectedChainId, snapshot, writeContract]);

  if (!isConnected || !accountAddress) {
    return (
      <div className="diem-rewards-view">
        <div className="overview-empty">
          <div className="overview-empty-title">Connect your staking wallet</div>
          <div className="overview-empty-desc">
            Connect the same wallet you used with Venice.ai Proxy to view and claim $ANTS.
          </div>
          <div className="diem-rewards-connect"><ConnectButton /></div>
        </div>
      </div>
    );
  }

  if (loading && !snapshot) {
    return (
      <div className="diem-rewards-view">
        <div className="overview-empty"><div className="overview-empty-desc">Loading Venice.ai Proxy rewards…</div></div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="diem-rewards-view">
        <div className="overview-empty">
          <div className="overview-empty-title">Unable to load Venice.ai Proxy rewards</div>
          <div className="overview-empty-desc">{loadError}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="diem-rewards-view">
      <section className="dashboard-section">
        <header className="dashboard-section-head">
          <div className="dashboard-section-eyebrow">Venice.ai Proxy</div>
          <h2 className="dashboard-section-title">Your Venice.ai Proxy $ANTS</h2>
          <p className="dashboard-section-sub">
            Rewards earned through Venice.ai Proxy. Connect the same wallet you used for staking.
          </p>
        </header>

        <div className="stat-grid diem-rewards-stat-grid">
          <div className="stat-card stat-card--accent">
            <div className="stat-card-label">Pending $ANTS</div>
            <div className="stat-card-value">{formatAnts(totalPending)}</div>
            <div className="stat-card-hint">Across scanned finalized epochs</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Claimable epochs</div>
            <div className="stat-card-value">{claimableEpochs.length}</div>
            <div className="stat-card-hint">Includes 0-ANTS epochs to clear cursor</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Finalized epoch</div>
            <div className="stat-card-value">#{snapshot?.finalizedRewardEpoch ?? '—'}</div>
            <div className="stat-card-hint">Last claimable reward epoch boundary</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Scanned range</div>
            <div className="stat-card-value diem-rewards-range">{snapshot ? formatEpochRange(snapshot) : '—'}</div>
            <div className="stat-card-hint">{snapshot?.hasMore ? 'More epochs available after claim' : 'Up to date'}</div>
          </div>
        </div>
      </section>

      <section className="dashboard-section">
        <header className="dashboard-section-head">
          <div className="dashboard-section-eyebrow">History</div>
          <h2 className="dashboard-section-title">Venice.ai Proxy epochs</h2>
          <p className="dashboard-section-sub">
            Claimable epochs are finalized by the Venice.ai Proxy. Current epochs appear after the proxy closes them.
          </p>
        </header>
        <div className="dashboard-chart-card">
          <DiemRewardsTable rows={snapshot?.rows ?? []} />
          {(claimError || claimSuccess) && (
            <div className={`status-msg ${claimError ? 'status-error' : 'status-success'}`}>
              {claimError ?? 'Venice.ai Proxy $ANTS claim confirmed.'}
            </div>
          )}
          <button
            className="btn-primary"
            onClick={handleClaim}
            disabled={claimSubmitting || claimableEpochs.length === 0}
          >
            {claimSubmitting
              ? 'Claiming…'
              : totalPending > 0n
                ? `Claim ${formatAnts(totalPending)} $ANTS`
                : claimableEpochs.length > 0
                  ? 'Clear 0-$ANTS epochs'
                  : 'Nothing to claim'}
          </button>
        </div>
      </section>
    </div>
  );
}

function DiemRewardsTable({ rows }: { rows: DiemRewardRow[] }) {
  if (rows.length === 0) {
    return <div className="overview-empty-desc">No finalized Venice.ai Proxy epochs to show.</div>;
  }
  return (
    <div className="emissions-table-wrap">
      <table className="emissions-table">
        <thead>
          <tr>
            <th>Epoch</th>
            <th>Pending</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice().reverse().map((row) => {
            const claimable = !row.claimed;
            const statusLabel = row.claimed ? 'Claimed' : row.amount > 0n ? 'Claimable' : 'Clearable';
            const statusClass = row.claimed ? 'emissions-status--claimed' : 'emissions-status--pending';
            return (
              <tr key={row.epoch}>
                <td>#{row.epoch}</td>
                <td>{formatAnts(row.amount)} ANTS</td>
                <td><span className={`emissions-status ${claimable ? statusClass : ''}`}>{statusLabel}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
