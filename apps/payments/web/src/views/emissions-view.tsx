import { useCallback } from 'react';
import { useAccount } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
import type { PaymentConfig } from '../types';
import { AntMark } from '../components/ui/ant-seed-logo';
import { Tooltip } from '../components/ui/tooltip';
import {
  type EmissionsPendingResponse,
  type EmissionsShares as SharesType,
} from '../api';
import {
  useConfig,
  useEmissionsInfo,
  useEmissionsPending,
  useEmissionsShares,
  useTransfersEnabled,
  queryKeys,
} from '../hooks/queries';
import { useWagmiWrite } from '../hooks/use-wagmi-write';
import { EMISSIONS_CLAIM_ABI } from '../abi';
import { useAuthorizedWallet } from '../context/authorized-wallet-context';
import { estimateEmissionReward, safeBigint, formatAnts } from '../utils/format';

interface EmissionsViewProps {
  config: PaymentConfig | null;
}

function addWei(a: string, b: string): string {
  try { return (BigInt(a) + BigInt(b)).toString(); } catch { return '0'; }
}

function estimateRowReward(
  row: EmissionsPendingResponse['rows'][number],
  epochEmission: string,
  shares: SharesType,
): string {
  const est =
    estimateEmissionReward(epochEmission, shares.sellerSharePct, row.seller.userPoints, row.seller.totalPoints) +
    estimateEmissionReward(epochEmission, shares.buyerSharePct, row.buyer.userPoints, row.buyer.totalPoints);
  return est.toString();
}

function computeEpochShare(
  row: EmissionsPendingResponse['rows'][number] | undefined,
  shares: SharesType,
): number {
  if (!row) return 0;
  const userSP = safeBigint(row.seller.userPoints);
  const totalSP = safeBigint(row.seller.totalPoints);
  const userBP = safeBigint(row.buyer.userPoints);
  const totalBP = safeBigint(row.buyer.totalPoints);
  let pct = 0;
  if (totalSP > 0n) pct += shares.sellerSharePct * Number((userSP * 10000n) / totalSP) / 10000;
  if (totalBP > 0n) pct += shares.buyerSharePct * Number((userBP * 10000n) / totalBP) / 10000;
  return pct;
}

export function EmissionsView({ config }: EmissionsViewProps) {
  const buyerAddress = config?.evmAddress ?? null;
  const { requireAuthorization, operatorSet } = useAuthorizedWallet();
  const { connector } = useAccount();
  const queryClient = useQueryClient();

  const configQuery = useConfig();
  const infoQuery = useEmissionsInfo();
  const pendingQuery = useEmissionsPending(buyerAddress);
  const sharesQuery = useEmissionsShares();
  const transfersQuery = useTransfersEnabled();

  const info = infoQuery.data ?? null;
  const pending = pendingQuery.data ?? null;
  const shares = sharesQuery.data ?? null;
  const transfersEnabled = transfersQuery.data?.enabled ?? null;

  const isFirstLoad =
    configQuery.isLoading ||
    infoQuery.isLoading ||
    sharesQuery.isLoading ||
    (!!buyerAddress && !pending);
  const loadError = (!isFirstLoad && !info && buyerAddress)
    ? 'Emissions not available on this chain'
    : null;

  const invalidateEmissions = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.emissions });
  }, [queryClient]);

  const sellerClaim = useWagmiWrite(config, invalidateEmissions);
  const buyerClaim = useWagmiWrite(config, invalidateEmissions);

  const handleClaimSeller = useCallback(() => {
    if (!config?.emissionsContractAddress || !pending) return;
    const epochs = pending.rows
      .filter((r) => !r.isCurrent && !r.seller.claimed && r.seller.amount !== '0')
      .map((r) => BigInt(r.epoch));
    if (epochs.length === 0) return;
    requireAuthorization(() => sellerClaim.submit(() => ({
      address: config.emissionsContractAddress as `0x${string}`,
      abi: EMISSIONS_CLAIM_ABI,
      functionName: 'claimSellerEmissions',
      chainId: sellerClaim.expectedChainId,
      args: [epochs],
    })));
  }, [config, pending, requireAuthorization, sellerClaim]);

  const handleClaimBuyer = useCallback(() => {
    if (!config?.emissionsContractAddress || !pending || !buyerAddress) return;
    const epochs = pending.rows
      .filter((r) => !r.isCurrent && !r.buyer.claimed && r.buyer.amount !== '0')
      .map((r) => BigInt(r.epoch));
    if (epochs.length === 0) return;
    requireAuthorization(() => buyerClaim.submit(() => ({
      address: config.emissionsContractAddress as `0x${string}`,
      abi: EMISSIONS_CLAIM_ABI,
      functionName: 'claimBuyerEmissions',
      chainId: buyerClaim.expectedChainId,
      args: [buyerAddress as `0x${string}`, epochs],
    })));
  }, [config, pending, buyerAddress, requireAuthorization, buyerClaim]);

  const sellerClaimBusy = sellerClaim.running;
  const buyerClaimBusy = buyerClaim.running;
  const sellerClaimError = sellerClaim.error;
  const buyerClaimError = buyerClaim.error;

  if (isFirstLoad) {
    return <EmissionsSkeleton />;
  }

  if (loadError || !info) {
    return (
      <div className="emissions-view">
        <div className="overview-empty">
          <div className="overview-empty-title">Emissions not available</div>
          <div className="overview-empty-desc">
            {loadError ?? 'The Emissions contract is not configured for this chain.'}
          </div>
        </div>
      </div>
    );
  }

  const rows = pending?.rows ?? [];
  const currentRow = rows.find((r) => r.isCurrent);
  const currentSellerPts = currentRow?.seller.userPoints ?? '0';
  const currentBuyerPts = currentRow?.buyer.userPoints ?? '0';
  const totalSellerPts = currentRow?.seller.totalPoints ?? '0';
  const totalBuyerPts = currentRow?.buyer.totalPoints ?? '0';
  const currentEstimate = currentRow && info && shares
    ? estimateRowReward(currentRow, info.epochEmission, shares)
    : '0';

  const epochSharePct = shares
    ? computeEpochShare(currentRow, shares)
    : 0;

  let totalClaimable = 0n;
  let totalClaimed = 0n;
  for (const r of rows) {
    if (r.isCurrent) continue;
    const ep = r.epochEmission ?? info.epochEmission;
    // Per-side: pendingEmissions returns 0 for claimed sides, so estimate from points
    if (r.seller.claimed && shares) {
      totalClaimed += estimateEmissionReward(ep, shares.sellerSharePct, r.seller.userPoints, r.seller.totalPoints);
    } else {
      totalClaimable += safeBigint(r.seller.amount);
    }
    if (r.buyer.claimed && shares) {
      totalClaimed += estimateEmissionReward(ep, shares.buyerSharePct, r.buyer.userPoints, r.buyer.totalPoints);
    } else {
      totalClaimable += safeBigint(r.buyer.amount);
    }
  }

  const canAddToWallet = Boolean(config?.antsTokenAddress && connector);
  const handleAddToWallet = async () => {
    if (!config?.antsTokenAddress || !connector) return;
    try {
      const provider = await connector.getProvider();
      await (provider as { request: (args: unknown) => Promise<unknown> }).request({
        method: 'wallet_watchAsset',
        params: {
          type: 'ERC20',
          options: {
            address: config.antsTokenAddress,
            symbol: 'ANTS',
            decimals: 18,
          },
        },
      });
    } catch {
      // user rejected or wallet doesn't support watchAsset
    }
  };

  // Per-side claimable totals (past epochs, unclaimed, non-zero)
  let sellerClaimableWei = 0n;
  let buyerClaimableWei = 0n;
  for (const r of rows) {
    if (r.isCurrent) continue;
    if (!r.seller.claimed) sellerClaimableWei += safeBigint(r.seller.amount);
    if (!r.buyer.claimed) buyerClaimableWei += safeBigint(r.buyer.amount);
  }
  const sellerClaimable = sellerClaimableWei > 0n;
  const buyerClaimable = buyerClaimableWei > 0n;
  const anyClaimable = sellerClaimable || buyerClaimable;
  const claimBusy = sellerClaimBusy || buyerClaimBusy;

  // Reason a per-side button is disabled (busy or unauthorized). null = good to go.
  const claimDisabledReason: string | null = claimBusy
    ? 'Claim in progress — wait for the current transaction to confirm.'
    : operatorSet === false
      ? 'Authorize your wallet first to claim $ANTS.'
      : null;

  return (
    <div className="emissions-view">
      <section className="page-banner">
        <span className="page-banner-mark" aria-hidden="true">
          <AntMark size={20} />
        </span>
        <div className="page-banner-content">
          <div className="page-banner-eyebrow">$ANTS</div>
          <h2 className="page-banner-heading">Earn $ANTS by participating</h2>
          <p className="page-banner-sub">
            Sellers and buyers both earn $ANTS each epoch in proportion to their on-chain
            activity. Claims are non-custodial — tokens mint directly to your wallet.
          </p>
        </div>
        <div className="page-banner-actions">
          {sellerClaimable && (
            <Tooltip text={claimDisabledReason ?? ''}>
              <button
                type="button"
                className="page-banner-action page-banner-action--primary"
                onClick={handleClaimSeller}
                disabled={Boolean(claimDisabledReason)}
              >
                <span className="page-banner-action-icon page-banner-action-icon--accent" aria-hidden="true">
                  <AntMark size={14} />
                </span>
                {sellerClaimBusy
                  ? 'Claiming…'
                  : `Claim ${formatAnts(sellerClaimableWei)} seller`}
                <HugeiconsIcon icon={ArrowRight01Icon} size={11} strokeWidth={1.8} />
              </button>
            </Tooltip>
          )}
          {buyerClaimable && (
            <Tooltip text={claimDisabledReason ?? ''}>
              <button
                type="button"
                className="page-banner-action page-banner-action--primary"
                onClick={handleClaimBuyer}
                disabled={Boolean(claimDisabledReason)}
              >
                <span className="page-banner-action-icon page-banner-action-icon--accent" aria-hidden="true">
                  <AntMark size={14} />
                </span>
                {buyerClaimBusy
                  ? 'Claiming…'
                  : `Claim ${formatAnts(buyerClaimableWei)} buyer`}
                <HugeiconsIcon icon={ArrowRight01Icon} size={11} strokeWidth={1.8} />
              </button>
            </Tooltip>
          )}
          {!anyClaimable && (
            <Tooltip text="Nothing to claim yet — keep using the network to earn $ANTS.">
              <button
                type="button"
                className="page-banner-action page-banner-action--primary"
                disabled
              >
                <span className="page-banner-action-icon" aria-hidden="true">
                  <AntMark size={14} />
                </span>
                Claim $ANTS
                <HugeiconsIcon icon={ArrowRight01Icon} size={11} strokeWidth={1.8} />
              </button>
            </Tooltip>
          )}
          {canAddToWallet && (
            <button type="button" className="page-banner-action" onClick={handleAddToWallet}>
              <span className="page-banner-action-icon" aria-hidden="true">
                <AntMark size={14} />
              </span>
              Add $ANTS to wallet
              <HugeiconsIcon icon={ArrowRight01Icon} size={11} strokeWidth={1.8} />
            </button>
          )}
        </div>
        <span className="page-banner-deco" aria-hidden="true" />
      </section>

      <section className="overview-section">
        <header className="overview-section-head">
          <div className="overview-section-eyebrow">Your position</div>
          <h2 className="overview-section-title">This epoch</h2>
          <p className="overview-section-sub">
            Your share of this epoch's rewards. Updates after each on-chain settlement.
          </p>
        </header>

        <div className="stat-grid">
          <div className="stat-card stat-card--accent">
            <div className="stat-card-label">Estimated reward</div>
            <div className="stat-card-value">{formatAnts(currentEstimate)} <span className="stat-card-unit">$ANTS</span></div>
            <div className="stat-card-hint">Not yet final</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Your epoch share</div>
            <div className="stat-card-value">{epochSharePct > 0 ? `${epochSharePct.toFixed(2)}%` : '—'}</div>
            <div className="stat-card-hint">Of total epoch emission</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Claimable</div>
            <div className="stat-card-value">{formatAnts(totalClaimable.toString())} <span className="stat-card-unit">$ANTS</span></div>
            <div className="stat-card-hint">From past epochs</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Already claimed</div>
            <div className="stat-card-value">{formatAnts(totalClaimed.toString())} <span className="stat-card-unit">$ANTS</span></div>
            <div className="stat-card-hint">Across all epochs</div>
          </div>
        </div>
      </section>

      <section className="overview-section">
        <header className="overview-section-head">
          <div className="overview-section-eyebrow">History</div>
          <h2 className="overview-section-title">Your emissions</h2>
          <p className="overview-section-sub">
            Current epoch is an estimate that updates after each on-chain settlement.
          </p>
        </header>
        <div className="overview-chart-card">
          <EmissionsTable rows={pending?.rows ?? []} epochEmission={info.epochEmission} shares={shares} />
          {(sellerClaimError || buyerClaimError) && (
            <div className="status-msg status-error">{sellerClaimError || buyerClaimError}</div>
          )}
        </div>
      </section>

      <section className="overview-section">
        <header className="overview-section-head">
          <div className="overview-section-eyebrow">Info</div>
          <h2 className="overview-section-title">About $ANTS</h2>
          <p className="overview-section-sub">
            The native token of the AntSeed network — earned through real on-chain participation.
          </p>
        </header>
        <div className="emissions-facts">
          <article className="emissions-fact">
            <span className="emissions-fact-num">01</span>
            <h3 className="emissions-fact-title">Non-custodial</h3>
            <p className="emissions-fact-desc">
              Seller claims mint to the claiming wallet. Buyer claims mint to your authorized wallet. Nothing held by us.
            </p>
          </article>
          <article className="emissions-fact">
            <span className="emissions-fact-num">02</span>
            <h3 className="emissions-fact-title">Per-epoch emissions</h3>
            <p className="emissions-fact-desc">
              Sellers and buyers split each epoch's pool by their share of on-chain activity. No fixed allocation.
            </p>
          </article>
          <article className="emissions-fact">
            <span className="emissions-fact-num">03</span>
            <h3 className="emissions-fact-title">No pre-mine</h3>
            <p className="emissions-fact-desc">
              Every $ANTS in circulation was earned through real network work — no founders' allocation, no insider drop.
            </p>
          </article>
        </div>
      </section>

      {transfersEnabled === false && (
        <section className="page-banner page-banner--amber">
          <span className="page-banner-mark" aria-hidden="true">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="11" width="16" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
          </span>
          <div className="page-banner-content">
            <div className="page-banner-eyebrow">Heads up</div>
            <h2 className="page-banner-heading">ANTS is not yet transferable</h2>
            <p className="page-banner-sub">
              Claimed tokens remain in your wallet until governance enables transfers.
            </p>
          </div>
          <span className="page-banner-deco" aria-hidden="true" />
        </section>
      )}
    </div>
  );
}

function EmissionsSkeleton() {
  return (
    <div className="emissions-view emissions-skeleton" aria-busy="true" aria-label="Loading emissions">
      <div className="page-banner">
        <span className="skel skel-pill" style={{ width: 40, height: 40, borderRadius: 999 }} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="skel skel-line skel-line--eyebrow" />
          <span className="skel skel-line skel-line--title" />
          <span className="skel skel-line skel-line--sub" />
        </div>
      </div>
      <SkeletonSection />
      <SkeletonSection accentFirst />
      <section className="overview-section">
        <header className="overview-section-head">
          <span className="skel skel-line skel-line--eyebrow" />
          <span className="skel skel-line skel-line--title" />
          <span className="skel skel-line skel-line--sub" />
        </header>
        <div className="overview-chart-card">
          <div className="skel-table">
            {Array.from({ length: 5 }).map((_, i) => (
              <div className="skel-row" key={i}>
                <span className="skel skel-line skel-line--cell" style={{ width: '12%' }} />
                <span className="skel skel-line skel-line--cell" style={{ width: '28%' }} />
                <span className="skel skel-line skel-line--cell" style={{ width: '20%' }} />
                <span className="skel skel-pill" />
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function SkeletonSection({ accentFirst = false }: { accentFirst?: boolean }) {
  return (
    <section className="overview-section">
      <header className="overview-section-head">
        <span className="skel skel-line skel-line--eyebrow" />
        <span className="skel skel-line skel-line--title" />
        <span className="skel skel-line skel-line--sub" />
      </header>
      <div className="stat-grid">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className={`stat-card${accentFirst && i === 0 ? ' stat-card--accent' : ''}`} key={i}>
            <span className="skel skel-line skel-line--label" />
            <span className="skel skel-block skel-block--value" />
            <span className="skel skel-line skel-line--hint" />
          </div>
        ))}
      </div>
    </section>
  );
}

function EmissionsTable({ rows, epochEmission, shares }: {
  rows: EmissionsPendingResponse['rows'];
  epochEmission?: string;
  shares?: SharesType | null;
}) {
  if (rows.length === 0) {
    return <div className="overview-empty-desc">No recent epochs to show.</div>;
  }
  return (
    <div className="emissions-table-wrap">
      <table className="emissions-table">
        <thead>
          <tr>
            <th>Epoch</th>
            <th>Reward</th>
            <th>Your share</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice().reverse().map((row) => {
            const ep = row.epochEmission ?? epochEmission ?? '0';
            const total = (row.isCurrent || row.seller.claimed || row.buyer.claimed) && shares
              ? estimateRowReward(row, ep, shares)
              : addWei(row.seller.amount, row.buyer.amount);
            const share = shares ? computeEpochShare(row, shares) : 0;
            // "Fully resolved" = each side is either claimed or has no points
            const sellerDone = row.seller.claimed || row.seller.userPoints === '0';
            const buyerDone = row.buyer.claimed || row.buyer.userPoints === '0';
            const fullyClaimed = !row.isCurrent && sellerDone && buyerDone && (row.seller.claimed || row.buyer.claimed);
            const nothingToClaim = total === '0';
            const statusLabel = fullyClaimed
              ? 'Claimed'
              : row.isCurrent
                ? 'Estimate'
                : nothingToClaim
                  ? '—'
                  : 'Claimable';
            const statusClass = fullyClaimed
              ? 'emissions-status--claimed'
              : row.isCurrent
                ? 'emissions-status--estimate'
                : nothingToClaim
                  ? ''
                  : 'emissions-status--pending';
            return (
              <tr key={row.epoch} className={row.isCurrent ? 'emissions-table-current' : ''}>
                <td>#{row.epoch}</td>
                <td>{formatAnts(total)} ANTS</td>
                <td>{share > 0 ? `${share.toFixed(2)}%` : '—'}</td>
                <td><span className={`emissions-status ${statusClass}`}>{statusLabel}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

