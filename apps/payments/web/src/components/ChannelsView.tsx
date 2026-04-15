import { useState, useEffect, useCallback } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseAbi } from 'viem';
import type { PaymentConfig } from '../types';
import { getChannels, getOperatorInfo, type ChannelData } from '../api';
import { CHANNELS_ABI } from '../channels-abi';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';
import { useSetOperator } from '../hooks/useSetOperator';

interface ChannelsViewProps {
  config: PaymentConfig | null;
}

const GRACE_PERIOD = 900; // 15 minutes in seconds

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

type SessionStatus = 'active' | 'closing' | 'withdrawable';

function getSessionStatus(session: ChannelData): SessionStatus {
  if (session.closeRequestedAt === 0) return 'active';
  const now = Math.floor(Date.now() / 1000);
  if (now < session.closeRequestedAt + GRACE_PERIOD) return 'closing';
  return 'withdrawable';
}

function StatusBadge({ status }: { status: SessionStatus }) {
  const styles: Record<SessionStatus, { bg: string; color: string; label: string }> = {
    active: { bg: 'var(--accent-dim)', color: 'var(--accent-text)', label: 'Active' },
    closing: { bg: 'var(--amber-dim)', color: 'var(--amber)', label: 'Closing...' },
    withdrawable: { bg: 'rgba(59, 130, 246, 0.08)', color: '#3b82f6', label: 'Withdrawable' },
  };
  const s = styles[status];
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 12,
      fontSize: 11,
      fontWeight: 600,
      background: s.bg,
      color: s.color,
    }}>
      {s.label}
    </span>
  );
}

function formatTimeRemaining(closeRequestedAt: number): string {
  const now = Math.floor(Date.now() / 1000);
  const remaining = (closeRequestedAt + GRACE_PERIOD) - now;
  if (remaining <= 0) return '0:00';
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const parsedAbi = parseAbi(CHANNELS_ABI);

function SessionCard({ session, config, onRefresh }: { session: ChannelData; config: PaymentConfig; onRefresh: () => void }) {
  const status = getSessionStatus(session);
  const { expectedChainId, ensureCorrectNetwork } = usePaymentNetwork(config);
  const [error, setError] = useState<string | null>(null);

  const {
    writeContract: writeRequestClose,
    data: closeTxHash,
  } = useWriteContract();

  const { isSuccess: closeConfirmed } = useWaitForTransactionReceipt({
    hash: closeTxHash,
    chainId: expectedChainId,
  });

  const {
    writeContract: writeWithdraw,
    data: withdrawTxHash,
  } = useWriteContract();

  const { isSuccess: withdrawConfirmed } = useWaitForTransactionReceipt({
    hash: withdrawTxHash,
    chainId: expectedChainId,
  });

  const handleRequestClose = useCallback(async () => {
    setError(null);
    try {
      await ensureCorrectNetwork();
      writeRequestClose({
        address: config.channelsContractAddress as `0x${string}`,
        abi: parsedAbi,
        functionName: 'requestClose',
        chainId: expectedChainId,
        args: [session.channelId as `0x${string}`],
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [config.channelsContractAddress, ensureCorrectNetwork, expectedChainId, session.channelId, writeRequestClose]);

  const handleWithdraw = useCallback(async () => {
    setError(null);
    try {
      await ensureCorrectNetwork();
      writeWithdraw({
        address: config.channelsContractAddress as `0x${string}`,
        abi: parsedAbi,
        functionName: 'withdraw',
        chainId: expectedChainId,
        args: [session.channelId as `0x${string}`],
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [config.channelsContractAddress, ensureCorrectNetwork, expectedChainId, session.channelId, writeWithdraw]);

  return (
    <div style={{
      background: 'var(--card-bg)',
      border: '1px solid var(--card-border)',
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500 }}>
          Seller: {truncateAddress(session.seller)}
        </span>
        <StatusBadge status={status} />
      </div>
      <div style={{ display: 'flex', gap: 24, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Reserved</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>${session.deposit}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Used</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>${session.settled}</div>
        </div>
      </div>
      {status === 'active' && !closeConfirmed && (
        <button className="btn-outline" onClick={handleRequestClose} style={{ fontSize: 12, padding: '8px 0' }}>
          Request Close
        </button>
      )}
      {status === 'closing' && (
        <button className="btn-outline" disabled style={{ fontSize: 12, padding: '8px 0' }}>
          Waiting... {formatTimeRemaining(session.closeRequestedAt)}
        </button>
      )}
      {status === 'withdrawable' && !withdrawConfirmed && (
        <button className="btn-primary" onClick={handleWithdraw} style={{ fontSize: 12, padding: '8px 0' }}>
          Withdraw
        </button>
      )}
      {closeConfirmed && (
        <div className="status-msg status-success" style={{ fontSize: 11 }}>Close requested. Tx: {closeTxHash?.slice(0, 18)}... <button className="btn-link" onClick={onRefresh} style={{ fontSize: 11 }}>Refresh</button></div>
      )}
      {withdrawConfirmed && (
        <div className="status-msg status-success" style={{ fontSize: 11 }}>Withdrawn. Tx: {withdrawTxHash?.slice(0, 18)}... <button className="btn-link" onClick={onRefresh} style={{ fontSize: 11 }}>Refresh</button></div>
      )}
      {error && (
        <div className="status-msg status-error" style={{ fontSize: 11 }}>{error}</div>
      )}
    </div>
  );
}

function HistoryCard({ session }: { session: ChannelData }) {
  const label = session.status === 2 ? 'Settled' : session.status === 3 ? 'Timed out' : 'Closed';
  return (
    <div style={{
      background: 'var(--card-bg)',
      border: '1px solid var(--card-border)',
      borderRadius: 12,
      padding: 12,
      marginBottom: 8,
      opacity: 0.75,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500 }}>
          Seller: {truncateAddress(session.seller)}
        </span>
        <span style={{
          display: 'inline-block',
          padding: '2px 8px',
          borderRadius: 12,
          fontSize: 11,
          fontWeight: 600,
          background: 'rgba(148, 163, 184, 0.12)',
          color: 'var(--text-muted)',
        }}>
          {label}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 24 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Reserved</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>${session.deposit}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Used</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>${session.settled}</div>
        </div>
      </div>
    </div>
  );
}

export function ChannelsView({ config }: ChannelsViewProps) {
  const [channels, setChannels] = useState<ChannelData[]>([]);
  const [history, setHistory] = useState<ChannelData[]>([]);
  const [loading, setLoading] = useState(true);
  const [operatorSet, setOperatorSet] = useState<boolean | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [channelsResult, operatorResult] = await Promise.all([
        getChannels().catch(() => ({ channels: [], history: [] })),
        getOperatorInfo().catch(() => null),
      ]);
      setChannels(channelsResult.channels);
      setHistory(channelsResult.history ?? []);
      if (operatorResult) {
        setOperatorSet(operatorResult.operator !== '0x0000000000000000000000000000000000000000');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return (
    <div className="channels-view">
      {operatorSet === false && (
        <SetOperatorBanner config={config} onSet={fetchData} />
      )}

      <div className="card">
        <div className="channels-view-header">
          <div className="card-section-title" style={{ marginBottom: 0 }}>Active Channels</div>
          <button
            className="btn-outline"
            onClick={fetchData}
            style={{ width: 'auto', padding: '6px 14px', fontSize: 12 }}
          >
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="channels-view-empty">Loading channels…</div>
        ) : channels.length === 0 ? (
          <div className="channels-view-empty">No active channels</div>
        ) : (
          config && channels.map((session) => (
            <SessionCard key={session.channelId} session={session} config={config} onRefresh={fetchData} />
          ))
        )}
      </div>

      {history.length > 0 && (
        <div className="card">
          <div className="card-section-title">History</div>
          {history.map((session) => (
            <HistoryCard key={session.channelId} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Set Operator Banner ── */

function SetOperatorBanner({ config, onSet }: { config: PaymentConfig | null; onSet: () => void }) {
  const { address } = useAccount();
  const { run, running, error } = useSetOperator(config, onSet);

  return (
    <div className="status-msg" style={{ marginTop: 0, marginBottom: 16, fontSize: 12 }}>
      <div style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
        No wallet set. This is the wallet used to claim ANTS rewards and manage channels. Set your connected wallet to continue.
      </div>
      <button
        className="btn-outline"
        style={{ fontSize: 12, padding: '4px 12px' }}
        onClick={run}
        disabled={running || !address}
      >
        {running ? 'Setting wallet...' : 'Set Your Wallet'}
      </button>
      {error && <div style={{ color: 'var(--error)', marginTop: 6 }}>{error}</div>}
    </div>
  );
}
