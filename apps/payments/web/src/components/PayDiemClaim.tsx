import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, usePublicClient, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import type { PaymentConfig } from '../types';
import { DIEM_STAKING_PROXY_ADDRESS } from '../diem-proxy-abi';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';
import { ConnectWalletAction } from './ConnectWalletAction';
import {
  DIEM_PROXY_ABI,
  getDiemClaimableEpochs,
  getDiemPendingTotal,
  loadDiemRewardSnapshot,
  type DiemRewardSnapshot,
} from '../utils/diemRewards';
import { formatAntsAmount, truncateAddress } from '../utils/format';

interface PayDiemClaimProps {
  config: PaymentConfig | null;
  onDone: (txHash: string | null) => void;
}

/**
 * Claim $ANTS earned from DIEM staking — opened from the desktop's in-app
 * rewards view. Reads and claims run against the connected wallet, which must
 * be the wallet used for staking.
 */
export function PayDiemClaim({ config, onDone }: PayDiemClaimProps) {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { expectedChainId, targetChainName, ensureCorrectNetwork } = usePaymentNetwork(config);

  const [snapshot, setSnapshot] = useState<DiemRewardSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const { writeContract, data: txHash, isPending: submitting } = useWriteContract();
  const { isSuccess: confirmed } = useWaitForTransactionReceipt({ hash: txHash, chainId: expectedChainId });

  useEffect(() => {
    if (confirmed) onDone(txHash ?? null);
  }, [confirmed, txHash, onDone]);

  useEffect(() => {
    if (!isConnected || !address || !publicClient) { setSnapshot(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadDiemRewardSnapshot(publicClient, address as `0x${string}`)
      .then((next) => { if (!cancelled) setSnapshot(next); })
      .catch((err) => { if (!cancelled) setError(getErrorMessage(err, 'Unable to load DIEM rewards.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isConnected, address, publicClient]);

  const claimableEpochs = useMemo(() => getDiemClaimableEpochs(snapshot), [snapshot]);
  const totalPending = useMemo(() => getDiemPendingTotal(snapshot), [snapshot]);

  const handleClaim = useCallback(() => {
    if (!snapshot || claimableEpochs.length === 0) return;
    setError(null);
    setWorking(true);
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
          onError: (err) => { setWorking(false); setError(getErrorMessage(err)); },
        });
      } catch (err) {
        setWorking(false);
        setError(getErrorMessage(err, `Please switch your wallet to ${targetChainName}.`));
      }
    })();
  }, [snapshot, claimableEpochs, ensureCorrectNetwork, writeContract, expectedChainId, targetChainName]);

  if (!isConnected) {
    return (
      <div className="pc-pay">
        <ConnectWalletAction className="pc-pay-button" label="Connect your staking wallet" />
        <p className="pc-pay-fineprint">
          Connect the same wallet you used to stake DIEM through the AntSeed proxy.
        </p>
      </div>
    );
  }

  const busy = working || submitting;

  return (
    <div className="pc-pay">
      <div className="pc-pay-wallet">
        <span className="pc-pay-wallet-label">Staking wallet</span>
        <code className="pc-pay-wallet-addr">{truncateAddress(address ?? '')}</code>
        <span className="pc-pay-wallet-balance">
          {loading ? '…' : `${formatAntsAmount(totalPending)} ANTS pending`}
        </span>
      </div>

      {!loading && claimableEpochs.length === 0 && !error && (
        <div className="pc-pay-error" role="alert">
          Nothing to claim yet — rewards become claimable once their epoch is finalized.
        </div>
      )}
      {error && <div className="pc-pay-error" role="alert">{error}</div>}

      <button
        type="button"
        className="pc-pay-button"
        onClick={handleClaim}
        disabled={busy || loading || claimableEpochs.length === 0}
      >
        {busy && <span className="pc-pay-spinner" aria-hidden="true" />}
        {busy ? 'Confirm in your wallet…' : `Claim ${formatAntsAmount(totalPending)} ANTS`}
      </button>

      <p className="pc-pay-fineprint">
        Claims go to the connected staking wallet. The 10% DIEM pool fee flows to the Protocol Reserve.
      </p>
    </div>
  );
}
