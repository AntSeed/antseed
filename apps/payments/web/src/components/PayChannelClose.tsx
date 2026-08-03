import { useCallback, useEffect, useState } from 'react';
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { formatUnits, parseAbi } from 'viem';
import type { PaymentConfig } from '../types';
import { CHANNELS_ABI } from '../channels-abi';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';
import { useAuthorizedWallet } from '../context/AuthorizedWalletContext';
import { ConnectWalletAction } from './ConnectWalletAction';
import { formatUsd, truncateAddress } from '../utils/format';

const GRACE_PERIOD = 900; // seconds — AntseedChannels close grace period

const parsedAbi = parseAbi(CHANNELS_ABI);

// [buyer, seller, deposit, settled, metadataHash, deadline, settledAt, closeRequestedAt, status]
type ChannelTuple = readonly [
  `0x${string}`, `0x${string}`, bigint, bigint, `0x${string}`, bigint, bigint, bigint, number | bigint,
];

type ChannelPhase = 'active' | 'closing' | 'withdrawable' | 'finished' | 'missing';

function derivePhase(tuple: ChannelTuple | undefined): ChannelPhase {
  if (!tuple) return 'missing';
  const status = Number(tuple[8]);
  if (status === 2 || status === 3 || status === 0) return 'finished';
  const closeRequestedAt = Number(tuple[7]);
  if (closeRequestedAt === 0) return 'active';
  const now = Math.floor(Date.now() / 1000);
  return now < closeRequestedAt + GRACE_PERIOD ? 'closing' : 'withdrawable';
}

interface PayChannelCloseProps {
  config: PaymentConfig | null;
  channelId: string | null;
  onDone: (txHash: string | null) => void;
}

/**
 * Close (or withdraw from) a single payment channel — opened from the
 * desktop's in-app activity view. `requestClose` starts the 15-minute grace
 * period; once it elapses `withdraw` returns the unused reserve.
 */
export function PayChannelClose({ config, channelId, onDone }: PayChannelCloseProps) {
  const { address, isConnected } = useAccount();
  const { expectedChainId, targetChainName, ensureCorrectNetwork } = usePaymentNetwork(config);
  const { requireAuthorization } = useAuthorizedWallet();
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const { data: tuple, isLoading } = useReadContract({
    address: (config?.channelsContractAddress ?? '0x') as `0x${string}`,
    abi: parsedAbi,
    functionName: 'channels',
    chainId: expectedChainId,
    args: [(channelId ?? '0x') as `0x${string}`],
    query: { enabled: Boolean(config?.channelsContractAddress && channelId) },
  }) as { data: ChannelTuple | undefined; isLoading: boolean };

  const { writeContract, data: txHash, isPending: submitting } = useWriteContract();
  const { isSuccess: confirmed } = useWaitForTransactionReceipt({ hash: txHash, chainId: expectedChainId });

  useEffect(() => {
    if (confirmed) onDone(txHash ?? null);
  }, [confirmed, txHash, onDone]);

  const phase = derivePhase(tuple);
  const deposit = tuple ? Number(formatUnits(tuple[2], 6)) : 0;
  const settled = tuple ? Number(formatUnits(tuple[3], 6)) : 0;

  const run = useCallback((functionName: 'requestClose' | 'withdraw') => {
    if (!config?.channelsContractAddress || !channelId) return;
    requireAuthorization(async () => {
      setError(null);
      setWorking(true);
      try {
        await ensureCorrectNetwork();
        writeContract({
          address: config.channelsContractAddress as `0x${string}`,
          abi: parsedAbi,
          functionName,
          chainId: expectedChainId,
          args: [channelId as `0x${string}`],
        }, {
          onError: (err) => { setWorking(false); setError(getErrorMessage(err)); },
        });
      } catch (err) {
        setWorking(false);
        setError(getErrorMessage(err, `Please switch your wallet to ${targetChainName}.`));
      }
    });
  }, [config, channelId, requireAuthorization, ensureCorrectNetwork, writeContract, expectedChainId, targetChainName]);

  if (!channelId) {
    return <div className="pc-pay-error" role="alert">Missing channel reference — reopen this page from the app.</div>;
  }

  if (!isConnected) {
    return (
      <div className="pc-pay">
        <ConnectWalletAction className="pc-pay-button" label="Connect wallet to continue" />
        <p className="pc-pay-fineprint">Connect the wallet you authorized for this account.</p>
      </div>
    );
  }

  const busy = working || submitting;
  const buttonLabel = phase === 'withdrawable' ? 'Withdraw unused reserve' : 'Close channel';

  return (
    <div className="pc-pay">
      <div className="pc-pay-wallet">
        <span className="pc-pay-wallet-label">Acting as</span>
        <code className="pc-pay-wallet-addr">{truncateAddress(address ?? '')}</code>
        <span className="pc-pay-wallet-balance">
          {isLoading ? '…' : `$${formatUsd(settled)} of $${formatUsd(deposit)} used`}
        </span>
      </div>

      {phase === 'finished' && (
        <div className="pc-pay-error" role="alert">
          This channel is already settled or closed — nothing left to do.
        </div>
      )}
      {phase === 'missing' && !isLoading && (
        <div className="pc-pay-error" role="alert">Channel not found on-chain.</div>
      )}
      {phase === 'closing' && (
        <div className="pc-pay-error" role="alert">
          Close already requested — the 15-minute grace period is still running. Come back shortly to withdraw.
        </div>
      )}
      {error && <div className="pc-pay-error" role="alert">{error}</div>}

      <button
        type="button"
        className="pc-pay-button"
        onClick={() => run(phase === 'withdrawable' ? 'withdraw' : 'requestClose')}
        disabled={busy || isLoading || phase === 'finished' || phase === 'missing' || phase === 'closing'}
      >
        {busy && <span className="pc-pay-spinner" aria-hidden="true" />}
        {busy ? 'Confirm in your wallet…' : buttonLabel}
      </button>

      <p className="pc-pay-fineprint">
        {phase === 'withdrawable'
          ? 'Withdrawing returns the unused reserve to your credits balance.'
          : 'Closing starts a 15-minute grace period for the seller to settle, then the unused reserve returns to your balance.'}
      </p>
    </div>
  );
}
