import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { parseAbi } from 'viem';
import type { PaymentConfig } from '../types';
import { getEmissionsPending, type EmissionsPendingResponse } from '../api';
import {
  EMISSIONS_CLAIM_ABI,
  USAGE_ACCOUNTING_CLAIM_ABI,
  USAGE_REWARDS_CLAIM_ABI,
} from '../emissions-abi';
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
 * the desktop's in-app rewards view. Legacy epochs settle through Emissions
 * V2; recognized-usage epochs settle through UsageAccounting/UsageRewards.
 */
export function PayClaimRewards({ config, onDone }: PayClaimRewardsProps) {
  const { address, isConnected } = useAccount();
  const { expectedChainId, targetChainName, ensureCorrectNetwork } = usePaymentNetwork(config);
  const publicClient = usePublicClient({ chainId: expectedChainId });
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
    getEmissionsPending(buyerAddress, 104)
      .then((res) => { if (!cancelled) setPending(res); })
      .catch(() => { if (!cancelled) setError('Emissions are not available on this chain.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [buyerAddress]);

  const claimable = useMemo(() => {
    const rows = pending?.rows ?? [];
    const sellerRows = rows.filter((row) => !row.isCurrent && !row.seller.claimed && row.seller.amount !== '0');
    const buyerRows = rows.filter((row) => !row.isCurrent && !row.buyer.claimed && row.buyer.amount !== '0');
    const splitEpochs = (sideRows: typeof rows) => ({
      legacy: sideRows.filter((row) => row.protocol === 'legacy').map((row) => BigInt(row.epoch)),
      recognized: sideRows.filter((row) => row.protocol === 'recognized').map((row) => BigInt(row.epoch)),
    });
    return {
      sellerEpochs: splitEpochs(sellerRows),
      sellerTotal: sumAmounts(sellerRows.map((row) => row.seller.amount)),
      buyerEpochs: splitEpochs(buyerRows),
      buyerTotal: sumAmounts(buyerRows.map((row) => row.buyer.amount)),
    };
  }, [pending]);

  const { writeContractAsync } = useWriteContract();

  const claim = useCallback((side: 'seller' | 'buyer') => {
    if (!config || !buyerAddress) return;
    const epochs = side === 'seller' ? claimable.sellerEpochs : claimable.buyerEpochs;
    if (epochs.legacy.length === 0 && epochs.recognized.length === 0) return;
    requireAuthorization(async () => {
      setError(null);
      setWorking(side);
      try {
        await ensureCorrectNetwork();
        if (!publicClient) throw new Error('Wallet RPC client is not ready.');
        let lastHash: `0x${string}` | null = null;
        const confirm = async (hash: `0x${string}`) => {
          lastHash = hash;
          await publicClient.waitForTransactionReceipt({ hash });
        };

        if (epochs.legacy.length > 0) {
          if (!config.legacyEmissionsContractAddress) throw new Error('Legacy emissions contract is not configured.');
          const hash = side === 'seller'
            ? await writeContractAsync({
              address: config.legacyEmissionsContractAddress as `0x${string}`,
              abi: parseAbi(EMISSIONS_CLAIM_ABI),
              functionName: 'claimSellerEmissions',
              chainId: expectedChainId,
              args: [epochs.legacy],
            })
            : await writeContractAsync({
              address: config.legacyEmissionsContractAddress as `0x${string}`,
              abi: parseAbi(EMISSIONS_CLAIM_ABI),
              functionName: 'claimBuyerEmissions',
              chainId: expectedChainId,
              args: [buyerAddress as `0x${string}`, epochs.legacy],
            });
          await confirm(hash);
        }

        if (side === 'seller' && epochs.recognized.length > 0) {
          if (!config.usageAccountingAddress) throw new Error('Usage accounting contract is not configured.');
          await confirm(await writeContractAsync({
            address: config.usageAccountingAddress as `0x${string}`,
            abi: parseAbi(USAGE_ACCOUNTING_CLAIM_ABI),
            functionName: 'claimSellerEmissions',
            chainId: expectedChainId,
            args: [epochs.recognized],
          }));
        }

        if (side === 'buyer' && epochs.recognized.length > 0) {
          if (!config.usageRewardsAddress) throw new Error('Usage rewards contract is not configured.');
          for (const epoch of epochs.recognized) {
            await confirm(await writeContractAsync({
              address: config.usageRewardsAddress as `0x${string}`,
              abi: parseAbi(USAGE_REWARDS_CLAIM_ABI),
              functionName: 'claimBuyerReward',
              chainId: expectedChainId,
              args: [buyerAddress as `0x${string}`, epoch],
            }));
          }
        }

        onDone(lastHash);
      } catch (err) {
        setError(getErrorMessage(err, `Please switch your wallet to ${targetChainName}.`));
      } finally {
        setWorking(null);
      }
    });
  }, [config, buyerAddress, claimable, requireAuthorization, ensureCorrectNetwork, publicClient, writeContractAsync, expectedChainId, targetChainName, onDone]);

  if (!isConnected) {
    return (
      <div className="pc-pay">
        <ConnectWalletAction className="pc-pay-button" label="Connect wallet to claim" />
        <p className="pc-pay-fineprint">Connect the wallet you authorized for this account.</p>
      </div>
    );
  }

  const nothingToClaim = !loading
    && claimable.sellerEpochs.legacy.length === 0
    && claimable.sellerEpochs.recognized.length === 0
    && claimable.buyerEpochs.legacy.length === 0
    && claimable.buyerEpochs.recognized.length === 0;

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

      {(claimable.buyerEpochs.legacy.length > 0 || claimable.buyerEpochs.recognized.length > 0) && (
        <button
          type="button"
          className="pc-pay-button"
          onClick={() => claim('buyer')}
          disabled={working !== null}
        >
          {working === 'buyer' && <span className="pc-pay-spinner" aria-hidden="true" />}
          {working === 'buyer' ? 'Confirm each transaction in your wallet…' : `Claim ${formatAntsAmount(claimable.buyerTotal)} ANTS (usage)`}
        </button>
      )}
      {(claimable.sellerEpochs.legacy.length > 0 || claimable.sellerEpochs.recognized.length > 0) && (
        <button
          type="button"
          className="pc-pay-button"
          onClick={() => claim('seller')}
          disabled={working !== null}
        >
          {working === 'seller' && <span className="pc-pay-spinner" aria-hidden="true" />}
          {working === 'seller' ? 'Confirm each transaction in your wallet…' : `Claim ${formatAntsAmount(claimable.sellerTotal)} ANTS (selling)`}
        </button>
      )}

      <p className="pc-pay-fineprint">
        Legacy and current-protocol rewards are claimed to your AntSeed account address. Multiple epochs may require multiple wallet confirmations.
      </p>
    </div>
  );
}
