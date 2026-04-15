import { useState, useEffect, useCallback } from 'react';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
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

  const handleClaimSeller = useCallback(async () => {
    if (!config?.emissionsContractAddress || !pending) return;
    const epochs = pending.rows
      .filter((r) => !r.seller.claimed && r.seller.amount !== '0')
      .map((r) => BigInt(r.epoch));
    if (epochs.length === 0) return;
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
  }, [config, pending, ensureCorrectNetwork, expectedChainId, writeSellerClaim]);

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
      .filter((r) => !r.buyer.claimed && r.buyer.amount !== '0')
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
      <div className="card">
        <div className="card-section-title">Emissions</div>
        <div className="overview-empty">
          <div className="overview-empty-desc">Loading…</div>
        </div>
      </div>
    );
  }

  if (loadError || !info) {
    return (
      <div className="card">
        <div className="card-section-title">Emissions</div>
        <div className="overview-empty">
          <div className="overview-empty-title">Emissions not available</div>
          <div className="overview-empty-desc">
            {loadError ?? 'The Emissions contract is not configured for this chain.'}
          </div>
        </div>
      </div>
    );
  }

  // Derive time remaining in current epoch from genesis + epochDuration.
  const now = Math.floor(Date.now() / 1000);
  const epochStart = info.genesis + info.currentEpoch * info.epochDuration;
  const epochEnd = epochStart + info.epochDuration;
  const timeRemaining = epochEnd - now;
  const epochsUntilHalving = info.halvingInterval - (info.currentEpoch % info.halvingInterval);

  return (
    <div className="emissions-view">
      {/* Transfers banner */}
      {transfersEnabled === false && (
        <div className="emissions-banner emissions-banner--warn">
          <strong>ANTS is not yet transferable.</strong>
          Claimed tokens remain in your wallet until governance enables transfers.
        </div>
      )}

      {/* Epoch card */}
      <div className="card emissions-epoch-card">
        <div className="card-section-title">Current Epoch</div>
        <div className="emissions-epoch-grid">
          <div>
            <div className="emissions-epoch-label">Epoch</div>
            <div className="emissions-epoch-value">#{info.currentEpoch}</div>
          </div>
          <div>
            <div className="emissions-epoch-label">Ends in</div>
            <div className="emissions-epoch-value">{formatTimeRemaining(timeRemaining)}</div>
          </div>
          <div>
            <div className="emissions-epoch-label">Epoch budget</div>
            <div className="emissions-epoch-value">{formatAnts(info.epochEmission)} ANTS</div>
          </div>
          <div>
            <div className="emissions-epoch-label">Next halving in</div>
            <div className="emissions-epoch-value">{epochsUntilHalving} epochs</div>
          </div>
        </div>
        {shares && (
          <div className="emissions-shares-hint">
            Split this epoch: {shares.sellerSharePct}% sellers · {shares.buyerSharePct}% buyers ·{' '}
            {shares.reserveSharePct}% reserve · {shares.teamSharePct}% team
          </div>
        )}
      </div>

      {/* Seller claims */}
      <div className="card">
        <div className="card-section-title">Seller Emissions</div>
        <EmissionsRowList
          rows={pending?.rows ?? []}
          side="seller"
        />
        {sellerClaimError && <div className="status-msg status-error">{sellerClaimError}</div>}
        <button
          className="btn-primary emissions-claim-btn"
          onClick={handleClaimSeller}
          disabled={!pending || pending.rows.every((r) => r.seller.claimed || r.seller.amount === '0')}
        >
          Claim seller emissions
        </button>
      </div>

      {/* Buyer claims */}
      <div className="card">
        <div className="card-section-title">Buyer Emissions</div>
        <EmissionsRowList rows={pending?.rows ?? []} side="buyer" />
        {buyerClaimError && <div className="status-msg status-error">{buyerClaimError}</div>}
        <button
          className="btn-primary emissions-claim-btn"
          onClick={handleClaimBuyer}
          disabled={!pending || pending.rows.every((r) => r.buyer.claimed || r.buyer.amount === '0')}
        >
          Claim buyer emissions
        </button>
      </div>

      {/* ANTS info panel */}
      <div className="card">
        <div className="card-section-title">About $ANTS</div>
        <div className="emissions-ants-info">
          <p>
            $ANTS is the native reward token of the AntSeed network. It is minted
            each epoch to active sellers and buyers in proportion to their
            on-chain activity. There is no mining and no ANTS staking — you earn
            simply by using the network.
          </p>
          <p>
            Claims are non-custodial: seller claims mint to the claiming wallet,
            and buyer claims mint to the wallet you've authorized for your
            buyer identity.
          </p>
          {transfersEnabled === false && (
            <p>
              <strong>Transfers are currently restricted.</strong> Claimed ANTS
              stays in your wallet. Transfers will be enabled by governance.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

interface EmissionsRowListProps {
  rows: EmissionsPendingResponse['rows'];
  side: 'seller' | 'buyer';
}

function EmissionsRowList({ rows, side }: EmissionsRowListProps) {
  if (rows.length === 0) {
    return <div className="overview-empty-desc">No recent epochs to show.</div>;
  }
  return (
    <div className="emissions-row-list">
      {rows.slice().reverse().map((row) => {
        const data = row[side];
        const amount = formatAnts(data.amount);
        const labelClass = data.claimed
          ? 'emissions-row-status emissions-row-status--claimed'
          : data.amount === '0'
            ? 'emissions-row-status'
            : 'emissions-row-status emissions-row-status--pending';
        const statusLabel = data.claimed ? 'Claimed' : data.amount === '0' ? '—' : 'Pending';
        return (
          <div key={`${side}-${row.epoch}`} className="emissions-row">
            <span className="emissions-row-epoch">Epoch #{row.epoch}</span>
            <span className="emissions-row-amount">{amount} ANTS</span>
            <span className={labelClass}>{statusLabel}</span>
            {row.isCurrent && (
              <span className="emissions-row-hint">Estimate — finalized after epoch ends</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

