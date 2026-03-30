import { useState, useEffect, useCallback } from 'react';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseAbi } from 'viem';
import type { PaymentConfig } from '../types';
import { getChannels, getOperatorInfo, type ChannelData } from '../api';
import { CHANNELS_ABI } from '../channels-abi';

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

  const {
    writeContract: writeRequestClose,
    data: closeTxHash,
  } = useWriteContract();

  const { isSuccess: closeConfirmed } = useWaitForTransactionReceipt({
    hash: closeTxHash,
  });

  const {
    writeContract: writeWithdraw,
    data: withdrawTxHash,
  } = useWriteContract();

  const { isSuccess: withdrawConfirmed } = useWaitForTransactionReceipt({
    hash: withdrawTxHash,
  });

  const handleRequestClose = useCallback(() => {
    writeRequestClose({
      address: config.channelsContractAddress as `0x${string}`,
      abi: parsedAbi,
      functionName: 'requestClose',
      args: [session.channelId as `0x${string}`],
    });
  }, [config.channelsContractAddress, session.channelId, writeRequestClose]);

  const handleWithdraw = useCallback(() => {
    writeWithdraw({
      address: config.channelsContractAddress as `0x${string}`,
      abi: parsedAbi,
      functionName: 'withdraw',
      args: [session.channelId as `0x${string}`],
    });
  }, [config.channelsContractAddress, session.channelId, writeWithdraw]);

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
    </div>
  );
}

export function ChannelsView({ config }: ChannelsViewProps) {
  const [channels, setChannels] = useState<ChannelData[]>([]);
  const [loading, setLoading] = useState(true);
  const [operatorSet, setOperatorSet] = useState<boolean | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [channelsResult, operatorResult] = await Promise.all([
        getChannels().catch(() => ({ channels: [] })),
        getOperatorInfo().catch(() => null),
      ]);
      setChannels(channelsResult.channels);
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
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div className="card-section-title" style={{ marginBottom: 0 }}>Active Channels</div>
        <button
          className="btn-outline"
          onClick={fetchData}
          style={{ width: 'auto', padding: '6px 14px', fontSize: 12 }}
        >
          Refresh
        </button>
      </div>

      {operatorSet === false && (
        <div className="status-msg" style={{ marginTop: 0, marginBottom: 16, fontSize: 12, color: 'var(--text-secondary)' }}>
          No operator set. Deposit credits to set up your wallet as the channel operator.
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>
          Loading channels...
        </div>
      ) : channels.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>
          No active channels
        </div>
      ) : (
        config && channels.map((session) => (
          <SessionCard key={session.channelId} session={session} config={config} onRefresh={fetchData} />
        ))
      )}
    </div>
  );
}
