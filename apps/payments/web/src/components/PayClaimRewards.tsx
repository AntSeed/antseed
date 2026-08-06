import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { parseAbi } from 'viem';
import type { PaymentConfig } from '../types';
import { getEmissionsPending, type EmissionsPendingResponse } from '../api';
import { EMISSIONS_CLAIM_ABI } from '../emissions-abi';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';
import { useAuthorizedWallet } from '../context/AuthorizedWalletContext';
import { ConnectWalletAction } from './ConnectWalletAction';
import { formatAntsAmount, truncateAddress } from '../utils/format';

interface PayClaimRewardsProps {
  config: PaymentConfig | null;
  onDone: (txHash: string | null) => void;
}

function sumAmounts(values: string[]): bigint {
  let total = 0n;
  for (const value of values) {
    try { total += BigInt(value); } catch { /* skip */ }
  }
  return total;
}

/**
 * Claim pending $ANTS emissions (buyer and/or seller share) — opened from
 * the desktop's in-app rewards view. Claiming settles on-chain, so it needs
 * the authorized wallet's signature.
 */
export function PayClaimRewards({ config, onDone }: PayClaimRewardsProps) {
  const { address, isConnected } = useAccount();
  const { expectedChainId, targetChainName, ensureCorrectNetwork } = usePaymentNetwork(config);
  const { requireAuthorization } = useAuthorizedWallet();
  const buyerAddress = config?.evmAddress ?? null;

  const [pending, setPending] = useState<EmissionsPendingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<'seller' | 'buyer' | null>(null);

  useEffect(() => {
    if (!buyerAddress) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    getEmissionsPending(buyerAddress)
      .then((res) => { if (!cancelled) setPending(res); })
      .catch(() => { if (!cancelled) setError('Emissions are not available on this chain.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [buyerAddress]);

  const claimable = useMemo(() => {
    const rows = pending?.rows ?? [];
    const sellerRows = rows.filter((r) => !r.isCurrent && !r.seller.claimed && r.seller.amount !== '0');
    const buyerRows = rows.filter((r) => !r.isCurrent && !r.buyer.claimed && r.buyer.amount !== '0');
    return {
      sellerEpochs: sellerRows.map((r) => BigInt(r.epoch)),
      sellerTotal: sumAmounts(sellerRows.map((r) => r.seller.amount)),
      buyerEpochs: buyerRows.map((r) => BigInt(r.epoch)),
      buyerTotal: sumAmounts(buyerRows.map((r) => r.buyer.amount)),
    };
  }, [pending]);

  const { writeContract, data: txHash, isPending: submitting } = useWriteContract();
  const { isSuccess: confirmed } = useWaitForTransactionReceipt({ hash: txHash, chainId: expectedChainId });

  useEffect(() => {
    if (confirmed) onDone(txHash ?? null);
  }, [confirmed, txHash, onDone]);

  const claim = useCallback((side: 'seller' | 'buyer') => {
    if (!config?.emissionsContractAddress || !buyerAddress) return;
    const epochs = side === 'seller' ? claimable.sellerEpochs : claimable.buyerEpochs;
    if (epochs.length === 0) return;
    requireAuthorization(async () => {
      setError(null);
      setWorking(side);
      try {
        await ensureCorrectNetwork();
        writeContract({
          address: config.emissionsContractAddress as `0x${string}`,
          abi: parseAbi(EMISSIONS_CLAIM_ABI),
          functionName: side === 'seller' ? 'claimSellerEmissions' : 'claimBuyerEmissions',
          chainId: expectedChainId,
          args: side === 'seller' ? [epochs] : [buyerAddress as `0x${string}`, epochs],
        }, {
          onError: (err) => { setWorking(null); setError(getErrorMessage(err)); },
        });
      } catch (err) {
        setWorking(null);
        setError(getErrorMessage(err, `Please switch your wallet to ${targetChainName}.`));
      }
    });
  }, [config, buyerAddress, claimable, requireAuthorization, ensureCorrectNetwork, writeContract, expectedChainId, targetChainName]);

  if (!isConnected) {
    return (
      <div className="pc-pay">
        <ConnectWalletAction className="pc-pay-button" label="Connect wallet to claim" />
        <p className="pc-pay-fineprint">Connect the wallet you authorized for this account.</p>
      </div>
    );
  }

  const nothingToClaim = !loading && claimable.sellerEpochs.length === 0 && claimable.buyerEpochs.length === 0;

  return (
    <div className="pc-pay">
      <div className="pc-pay-wallet">
        <span className="pc-pay-wallet-label">Claiming as</span>
        <code className="pc-pay-wallet-addr">{truncateAddress(address ?? '')}</code>
        <span className="pc-pay-wallet-balance">
          {loading ? '…' : `${formatAntsAmount(claimable.sellerTotal + claimable.buyerTotal)} ANTS claimable`}
        </span>
      </div>

      {nothingToClaim && (
        <div className="pc-pay-error" role="alert">
          Nothing to claim yet — rewards from the current epoch become claimable when the epoch ends.
        </div>
      )}
      {error && <div className="pc-pay-error" role="alert">{error}</div>}

      {claimable.buyerEpochs.length > 0 && (
        <button
          type="button"
          className="pc-pay-button"
          onClick={() => claim('buyer')}
          disabled={working !== null || submitting}
        >
          {working === 'buyer' && <span className="pc-pay-spinner" aria-hidden="true" />}
          {working === 'buyer' ? 'Confirm in your wallet…' : `Claim ${formatAntsAmount(claimable.buyerTotal)} ANTS (usage)`}
        </button>
      )}
      {claimable.sellerEpochs.length > 0 && (
        <button
          type="button"
          className="pc-pay-button"
          onClick={() => claim('seller')}
          disabled={working !== null || submitting}
        >
          {working === 'seller' && <span className="pc-pay-spinner" aria-hidden="true" />}
          {working === 'seller' ? 'Confirm in your wallet…' : `Claim ${formatAntsAmount(claimable.sellerTotal)} ANTS (selling)`}
        </button>
      )}

      <p className="pc-pay-fineprint">
        $ANTS are claimed to your AntSeed account address. One transaction per claim.
      </p>
    </div>
  );
}
