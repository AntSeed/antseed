import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, usePublicClient, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { DIEM_STAKING_PROXY_ABI, DIEM_STAKING_PROXY_ADDRESS, DIEM_TOKEN_ADDRESS } from '../abi';
import { getErrorMessage, usePaymentNetwork } from '../lib/payment-network';
import { formatAnts } from '../lib/format';
import { type DiemEpochRow, type DiemEpochScan } from '../lib/diem-scan';
import { useConfig, useDiemScan, queryKeys } from '../hooks/queries';
import { Tooltip } from '../components/ui/tooltip';

const MAX_EPOCHS_PREVIEW = 16;

function formatEpochRange(snapshot: DiemEpochScan): string {
  if (snapshot.rows.length === 0) return 'No finalized epochs in range';
  const first = snapshot.rows[0]?.epoch;
  const last = snapshot.rows[snapshot.rows.length - 1]?.epoch;
  return first === last ? `Epoch #${first}` : `Epochs #${first}–#${last}`;
}

export function DiemRewardsView() {
  const { data: config = null } = useConfig();
  const { address, isConnected, connector } = useAccount();
  const publicClient = usePublicClient();
  const accountAddress = address ?? null;
  const { expectedChainId, ensureCorrectNetwork } = usePaymentNetwork(config);
  const queryClient = useQueryClient();

  const diemAddress = isConnected ? accountAddress : null;
  const diemQuery = useDiemScan(publicClient, diemAddress, MAX_EPOCHS_PREVIEW);
  const snapshot: DiemEpochScan | null = diemQuery.data ?? null;
  const loading = diemQuery.isFetching;
  const loadError = diemQuery.error ? getErrorMessage(diemQuery.error, 'Unable to load DIEM rewards.') : null;

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

  useEffect(() => {
    if (claimConfirmed) {
      setClaimSuccess(true);
      resetClaim();
      void queryClient.invalidateQueries({ queryKey: queryKeys.diem });
    }
  }, [claimConfirmed, queryClient, resetClaim]);

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
          abi: DIEM_STAKING_PROXY_ABI,
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

  const canAddDiemToWallet = Boolean(connector);
  const handleAddDiemToWallet = async () => {
    if (!connector) return;
    try {
      const provider = await connector.getProvider();
      await (provider as { request: (args: unknown) => Promise<unknown> }).request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC20',
          options: {
            address: DIEM_TOKEN_ADDRESS,
            symbol: 'DIEM',
            decimals: 18,
          },
        },
      });
    } catch {
      // user rejected or wallet doesn't support watchAsset
    }
  };

  if (!isConnected || !accountAddress) {
    return (
      <div className="diem-rewards-view">
        <div className="diem-empty">
          <span className="diem-empty-mark" aria-hidden="true">
            <img src="/diem-logo.png" width="20" height="20" alt="" />
          </span>
          <div className="overview-empty-title">Connect your staking wallet</div>
          <div className="overview-empty-desc">
            Connect the same wallet you used on the DIEM staking portal to view and claim $ANTS.
          </div>
          <div className="diem-rewards-connect"><ConnectButton /></div>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="diem-rewards-view">
        <div className="overview-empty">
          <div className="overview-empty-title">Unable to load DIEM rewards</div>
          <div className="overview-empty-desc">{loadError}</div>
        </div>
      </div>
    );
  }

  const claimBusy = claimSubmitting;
  const hasClaimable = claimableEpochs.length > 0;
  const hasPending = totalPending > 0n;

  const claimDisabledReason: string | null = claimBusy
    ? 'Claim in progress — wait for the current transaction to confirm.'
    : loading && !snapshot
      ? 'Loading rewards…'
      : !hasClaimable
        ? 'Nothing to claim yet. Once new epochs are finalized by the DIEM proxy, you can claim from here.'
        : null;

  const claimLabel = claimBusy
    ? 'Claiming…'
    : hasPending
      ? `Claim ${formatAnts(totalPending)} $ANTS`
      : hasClaimable
        ? 'Clear 0-$ANTS epochs'
        : 'Claim $ANTS';

  return (
    <div className="diem-rewards-view">
      <section className="page-banner page-banner--diem">
        <span className="page-banner-mark page-banner-mark--neutral" aria-hidden="true">
          <img src="/diem-logo.png" width="22" height="22" alt="" />
        </span>
        <div className="page-banner-content">
          <div className="page-banner-eyebrow">$DIEM staking</div>
          <h2 className="page-banner-heading">Earn $ANTS from your $DIEM stake</h2>
          <p className="page-banner-sub">
            Your $DIEM (via the AntSeed staking proxy) earns $ANTS each epoch. Claims are
            non-custodial — tokens mint directly to your wallet.
          </p>
        </div>
        <div className="page-banner-actions">
          <Tooltip text={claimDisabledReason ?? ''}>
            <button
              type="button"
              className="page-banner-action page-banner-action--primary"
              onClick={handleClaim}
              disabled={Boolean(claimDisabledReason)}
            >
              <span className="page-banner-action-icon" aria-hidden="true">
                <img src="/diem-logo.png" width="14" height="14" alt="" />
              </span>
              {claimLabel}
              <HugeiconsIcon icon={ArrowRight01Icon} size={11} strokeWidth={1.8} />
            </button>
          </Tooltip>
          {canAddDiemToWallet && (
            <button type="button" className="page-banner-action" onClick={handleAddDiemToWallet}>
              <span className="page-banner-action-icon" aria-hidden="true">
                <img src="/diem-logo.png" width="14" height="14" alt="" />
              </span>
              Add $DIEM to wallet
              <HugeiconsIcon icon={ArrowRight01Icon} size={11} strokeWidth={1.8} />
            </button>
          )}
        </div>
        <span className="page-banner-deco" aria-hidden="true" />
      </section>

      <section className="overview-section">
        <header className="overview-section-head">
          <div className="overview-section-eyebrow">Your position</div>
          <h2 className="overview-section-title">DIEM proxy rewards</h2>
          <p className="overview-section-sub">
            Live snapshot of your share across the most recent finalized epochs.
          </p>
        </header>

        <div className="stat-grid">
          <div className="stat-card stat-card--accent">
            <div className="stat-card-label">Pending $ANTS</div>
            {snapshot ? (
              <>
                <div className="stat-card-value">{formatAnts(totalPending)} <span className="stat-card-unit">$ANTS</span></div>
                <div className="stat-card-hint">Across scanned finalized epochs</div>
              </>
            ) : (
              <>
                <span className="skel skel-block skel-block--value" />
                <span className="skel skel-line skel-line--hint" />
              </>
            )}
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Claimable epochs</div>
            {snapshot ? (
              <>
                <div className="stat-card-value">{claimableEpochs.length}</div>
                <div className="stat-card-hint">Includes 0-$ANTS epochs to clear cursor</div>
              </>
            ) : (
              <>
                <span className="skel skel-block skel-block--value" />
                <span className="skel skel-line skel-line--hint" />
              </>
            )}
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Finalized epoch</div>
            {snapshot ? (
              <>
                <div className="stat-card-value">#{snapshot.finalizedRewardEpoch}</div>
                <div className="stat-card-hint">Latest reward epoch boundary</div>
              </>
            ) : (
              <>
                <span className="skel skel-block skel-block--value" />
                <span className="skel skel-line skel-line--hint" />
              </>
            )}
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Scanned range</div>
            {snapshot ? (
              <>
                <div className="stat-card-value diem-rewards-range">{formatEpochRange(snapshot)}</div>
                <div className="stat-card-hint">{snapshot.hasMore ? 'More epochs available after claim' : 'Up to date'}</div>
              </>
            ) : (
              <>
                <span className="skel skel-block skel-block--value" />
                <span className="skel skel-line skel-line--hint" />
              </>
            )}
          </div>
        </div>
      </section>

      <section className="overview-section">
        <header className="overview-section-head">
          <div className="overview-section-eyebrow">History</div>
          <h2 className="overview-section-title">DIEM proxy epochs</h2>
          <p className="overview-section-sub">
            Claimable epochs are finalized by the DiemStakingProxy. Current epochs appear after the proxy closes them.
          </p>
        </header>
        <div className="overview-chart-card">
          {!snapshot ? (
            <div className="skel-table" aria-busy="true" aria-label="Loading DIEM epochs">
              {Array.from({ length: 5 }).map((_, i) => (
                <div className="skel-row" key={i}>
                  <span className="skel skel-line skel-line--cell" style={{ width: '14%' }} />
                  <span className="skel skel-line skel-line--cell" style={{ width: '32%' }} />
                  <span className="skel skel-pill" />
                </div>
              ))}
            </div>
          ) : (
            <DiemRewardsTable rows={snapshot.rows} />
          )}
          {(claimError || claimSuccess) && (
            <div className={`status-msg ${claimError ? 'status-error' : 'status-success'}`}>
              {claimError ?? 'DIEM $ANTS claim confirmed.'}
            </div>
          )}
        </div>
      </section>

      <section className="overview-section">
        <header className="overview-section-head">
          <div className="overview-section-eyebrow">Info</div>
          <h2 className="overview-section-title">About $DIEM staking</h2>
          <p className="overview-section-sub">
            How $DIEM stakers earn $ANTS through the AntSeed proxy.
          </p>
        </header>
        <div className="emissions-facts">
          <article className="emissions-fact">
            <span className="emissions-fact-num">01</span>
            <h3 className="emissions-fact-title">Stake stays put</h3>
            <p className="emissions-fact-desc">
              Your $DIEM remains staked through the AntSeed proxy — only $ANTS rewards move when you claim.
            </p>
          </article>
          <article className="emissions-fact">
            <span className="emissions-fact-num">02</span>
            <h3 className="emissions-fact-title">Per-epoch snapshots</h3>
            <p className="emissions-fact-desc">
              The proxy finalizes epochs on its own cadence. Claim once an epoch is finalized — order doesn't matter.
            </p>
          </article>
          <article className="emissions-fact">
            <span className="emissions-fact-num">03</span>
            <h3 className="emissions-fact-title">Non-custodial</h3>
            <p className="emissions-fact-desc">
              Claimed $ANTS mints directly to the wallet you connect here. Nothing held by us in between.
            </p>
          </article>
        </div>
      </section>
    </div>
  );
}

function DiemRewardsTable({ rows }: { rows: DiemEpochRow[] }) {
  if (rows.length === 0) {
    return <div className="overview-empty-desc">No finalized DIEM proxy epochs to show.</div>;
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
