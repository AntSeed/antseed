import { useState, useEffect, useCallback } from 'react';
import { useWriteContract, useWaitForTransactionReceipt, useAccount } from 'wagmi';
import { parseAbi, formatUnits } from 'viem';
import type { PaymentConfig } from '../types';
import {
  getEmissionsInfo,
  getEmissionsPending,
  getEmissionsShares,
  getTransfersEnabled,
  type EmissionsEpochInfo,
  type EmissionsPendingResponse,
  type EmissionsShares as SharesType,
} from '../api';
import { EMISSIONS_CLAIM_ABI } from '../emissions-abi';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';
import { useAuthorizedWallet } from '../context/AuthorizedWalletContext';

interface EmissionsViewProps {
  config: PaymentConfig | null;
}

const ANTS_DECIMALS = 18;

function safeBigint(s: string): bigint {
  try { return BigInt(s); } catch { return 0n; }
}

function addWei(a: string, b: string): string {
  try { return (BigInt(a) + BigInt(b)).toString(); } catch { return '0'; }
}

function formatAnts(amountWei: string): string {
  try {
    const n = parseFloat(formatUnits(BigInt(amountWei), ANTS_DECIMALS));
    if (n === 0) return '0';
    if (n < 0.0001) return '< 0.0001';
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  } catch {
    return '0';
  }
}

function estimateRowReward(
  row: EmissionsPendingResponse['rows'][number],
  epochEmission: string,
  shares: SharesType,
): string {
  const emission = safeBigint(epochEmission);
  const userSP = safeBigint(row.seller.userPoints);
  const totalSP = safeBigint(row.seller.totalPoints);
  const userBP = safeBigint(row.buyer.userPoints);
  const totalBP = safeBigint(row.buyer.totalPoints);

  let est = 0n;
  if (totalSP > 0n) {
    est += emission * BigInt(Math.round(shares.sellerSharePct * 100)) * userSP / (10000n * totalSP);
  }
  if (totalBP > 0n) {
    est += emission * BigInt(Math.round(shares.buyerSharePct * 100)) * userBP / (10000n * totalBP);
  }
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

function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return 'ending now';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function EmissionsView({ config }: EmissionsViewProps) {
  const [info, setInfo] = useState<EmissionsEpochInfo | null>(null);
  const [pending, setPending] = useState<EmissionsPendingResponse | null>(null);
  const [shares, setShares] = useState<SharesType | null>(null);
  const [transfersEnabled, setTransfersEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const buyerAddress = config?.evmAddress ?? null;
  const { expectedChainId, ensureCorrectNetwork } = usePaymentNetwork(config);
  const { requireAuthorization } = useAuthorizedWallet();
  const { connector } = useAccount();

  const load = useCallback(async () => {
    if (!buyerAddress) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [infoRes, pendingRes, sharesRes, teRes] = await Promise.all([
        getEmissionsInfo().catch(() => null),
        getEmissionsPending(buyerAddress).catch(() => null),
        getEmissionsShares().catch(() => null),
        getTransfersEnabled().catch(() => ({ enabled: false, configured: false })),
      ]);
      setInfo(infoRes);
      setPending(pendingRes);
      setShares(sharesRes);
      setTransfersEnabled(teRes.enabled);
      if (!infoRes) setLoadError('Emissions not available on this chain');
    } finally {
      setLoading(false);
    }
  }, [buyerAddress]);

  useEffect(() => { void load(); }, [load]);

  // Seller claim — wagmi write
  const {
    writeContract: writeSellerClaim,
    data: sellerClaimTx,
    reset: resetSellerClaim,
  } = useWriteContract();
  const { isSuccess: sellerClaimConfirmed } = useWaitForTransactionReceipt({
    hash: sellerClaimTx,
    chainId: expectedChainId,
  });
  const [sellerClaimError, setSellerClaimError] = useState<string | null>(null);

  const handleClaimSeller = useCallback(() => {
    if (!config?.emissionsContractAddress || !pending) return;
    const epochs = pending.rows
      .filter((r) => !r.isCurrent && !r.seller.claimed && r.seller.amount !== '0')
      .map((r) => BigInt(r.epoch));
    if (epochs.length === 0) return;
    requireAuthorization(async () => {
      setSellerClaimError(null);
      try {
        await ensureCorrectNetwork();
        writeSellerClaim({
          address: config.emissionsContractAddress as `0x${string}`,
          abi: parseAbi(EMISSIONS_CLAIM_ABI),
          functionName: 'claimSellerEmissions',
          chainId: expectedChainId,
          args: [epochs],
        }, {
          onError: (err) => setSellerClaimError(getErrorMessage(err)),
        });
      } catch (err) {
        setSellerClaimError(getErrorMessage(err));
      }
    });
  }, [config, pending, ensureCorrectNetwork, expectedChainId, writeSellerClaim, requireAuthorization]);

  useEffect(() => {
    if (sellerClaimConfirmed) {
      resetSellerClaim();
      void load();
    }
  }, [sellerClaimConfirmed, resetSellerClaim, load]);

  // Buyer claim — wagmi write
  const {
    writeContract: writeBuyerClaim,
    data: buyerClaimTx,
    reset: resetBuyerClaim,
  } = useWriteContract();
  const { isSuccess: buyerClaimConfirmed } = useWaitForTransactionReceipt({
    hash: buyerClaimTx,
    chainId: expectedChainId,
  });
  const [buyerClaimError, setBuyerClaimError] = useState<string | null>(null);

  const handleClaimBuyer = useCallback(() => {
    if (!config?.emissionsContractAddress || !pending || !buyerAddress) return;
    const epochs = pending.rows
      .filter((r) => !r.isCurrent && !r.buyer.claimed && r.buyer.amount !== '0')
      .map((r) => BigInt(r.epoch));
    if (epochs.length === 0) return;
    requireAuthorization(async () => {
      setBuyerClaimError(null);
      try {
        await ensureCorrectNetwork();
        writeBuyerClaim({
          address: config.emissionsContractAddress as `0x${string}`,
          abi: parseAbi(EMISSIONS_CLAIM_ABI),
          functionName: 'claimBuyerEmissions',
          chainId: expectedChainId,
          args: [buyerAddress as `0x${string}`, epochs],
        }, {
          onError: (err) => setBuyerClaimError(getErrorMessage(err)),
        });
      } catch (err) {
        setBuyerClaimError(getErrorMessage(err));
      }
    });
  }, [config, pending, buyerAddress, ensureCorrectNetwork, expectedChainId, writeBuyerClaim, requireAuthorization]);

  useEffect(() => {
    if (buyerClaimConfirmed) {
      resetBuyerClaim();
      void load();
    }
  }, [buyerClaimConfirmed, resetBuyerClaim, load]);

  if (loading && !info) {
    return (
      <div className="emissions-view">
        <div className="overview-empty">
          <div className="overview-empty-desc">Loading…</div>
        </div>
      </div>
    );
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

  const now = Math.floor(Date.now() / 1000);
  const epochStart = info.genesis + info.currentEpoch * info.epochDuration;
  const epochEnd = epochStart + info.epochDuration;
  const timeRemaining = epochEnd - now;
  const epochsUntilHalving = info.halvingInterval - (info.currentEpoch % info.halvingInterval);

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
    const sellerAmt = safeBigint(r.seller.amount);
    const buyerAmt = safeBigint(r.buyer.amount);
    if (r.seller.claimed) totalClaimed += sellerAmt;
    else totalClaimable += sellerAmt;
    if (r.buyer.claimed) totalClaimed += buyerAmt;
    else totalClaimable += buyerAmt;
  }

  return (
    <div className="emissions-view">
      <section className="dashboard-section">
        <header className="dashboard-section-head">
          <div className="dashboard-section-eyebrow">Current epoch</div>
          <h2 className="dashboard-section-title">Epoch #{info.currentEpoch}</h2>
          {shares && (
            <p className="dashboard-section-sub">
              Split: {shares.sellerSharePct}% sellers · {shares.buyerSharePct}% buyers ·{' '}
              {shares.reserveSharePct}% reserve · {shares.teamSharePct}% team
            </p>
          )}
        </header>

        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-card-label">Ends in</div>
            <div className="stat-card-value">{formatTimeRemaining(timeRemaining)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Epoch pool</div>
            <div className="stat-card-value">{formatAnts(info.epochEmission)}</div>
            <div className="stat-card-hint">ANTS this epoch</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Epoch duration</div>
            <div className="stat-card-value">{Math.round(info.epochDuration / 86400)}d</div>
            <div className="stat-card-hint">{(info.epochDuration / 3600).toFixed(0)} hours</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Next halving</div>
            <div className="stat-card-value">{epochsUntilHalving}</div>
            <div className="stat-card-hint">Epochs remaining</div>
          </div>
        </div>
      </section>

      <section className="dashboard-section">
        <header className="dashboard-section-head">
          <div className="dashboard-section-eyebrow">Your position</div>
          <h2 className="dashboard-section-title">This epoch</h2>
          <p className="dashboard-section-sub">
            Your share of this epoch's rewards. Updates after each on-chain settlement.
          </p>
        </header>

        <div className="stat-grid">
          <div className="stat-card stat-card--accent">
            <div className="stat-card-label">Estimated reward</div>
            <div className="stat-card-value">{formatAnts(currentEstimate)}</div>
            <div className="stat-card-hint">ANTS (not yet final)</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Your epoch share</div>
            <div className="stat-card-value">{epochSharePct > 0 ? `${epochSharePct.toFixed(2)}%` : '—'}</div>
            <div className="stat-card-hint">Of total epoch emission</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Claimable</div>
            <div className="stat-card-value">{formatAnts(totalClaimable.toString())}</div>
            <div className="stat-card-hint">From past epochs</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Already claimed</div>
            <div className="stat-card-value">{formatAnts(totalClaimed.toString())}</div>
            <div className="stat-card-hint">ANTS total</div>
          </div>
        </div>
      </section>

      <section className="dashboard-section">
        <header className="dashboard-section-head">
          <div className="dashboard-section-eyebrow">History</div>
          <h2 className="dashboard-section-title">Your emissions</h2>
          <p className="dashboard-section-sub">
            Current epoch is an estimate that updates after each on-chain settlement.
          </p>
        </header>
        <div className="dashboard-chart-card">
          <EmissionsTable rows={pending?.rows ?? []} epochEmission={info.epochEmission} shares={shares} />
          {(sellerClaimError || buyerClaimError) && (
            <div className="status-msg status-error">{sellerClaimError || buyerClaimError}</div>
          )}
          <div className="emissions-claim-actions">
            <button
              className="btn-primary"
              onClick={handleClaimSeller}
              disabled={!pending || pending.rows.every((r) => r.isCurrent || r.seller.claimed || r.seller.amount === '0')}
            >
              Claim seller
            </button>
            <button
              className="btn-primary"
              onClick={handleClaimBuyer}
              disabled={!pending || pending.rows.every((r) => r.isCurrent || r.buyer.claimed || r.buyer.amount === '0')}
            >
              Claim buyer
            </button>
          </div>
        </div>
      </section>

      <section className="dashboard-section">
        <header className="dashboard-section-head">
          <div className="dashboard-section-eyebrow">Info</div>
          <h2 className="dashboard-section-title">About $ANTS</h2>
        </header>
        <div className="dashboard-chart-card">
          <div className="emissions-ants-info">
            <p>
              $ANTS is the native token of the AntSeed network. It is minted
              each epoch to active sellers and buyers in proportion to their
              on-chain activity. There is no pre-mining — you earn
              simply by using the network.
            </p>
            <p>
              Claims are non-custodial: seller claims mint to the claiming wallet,
              and buyer claims mint to the wallet you've authorized for your
              buyer identity.
            </p>
          </div>
          {config?.antsTokenAddress && connector && (
            <button
              className="btn-outline"
              onClick={async () => {
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
              }}
            >
              Add ANTS to wallet
            </button>
          )}
        </div>
      </section>

      {transfersEnabled === false && (
        <div className="emissions-banner emissions-banner--warn">
          <strong>ANTS is not yet transferable.</strong>
          Claimed tokens remain in your wallet until governance enables transfers.
        </div>
      )}
    </div>
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
            const total = row.isCurrent && epochEmission && shares
              ? estimateRowReward(row, epochEmission, shares)
              : addWei(row.seller.amount, row.buyer.amount);
            const share = shares ? computeEpochShare(row, shares) : 0;
            const allClaimed = row.seller.claimed && row.buyer.claimed;
            const nothingToClaim = total === '0';
            const statusLabel = allClaimed
              ? 'Claimed'
              : row.isCurrent
                ? 'Estimate'
                : nothingToClaim
                  ? '—'
                  : 'Claimable';
            const statusClass = allClaimed
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

