import styles from './PaymentApprovalCard.module.scss';

interface PaymentApprovalInfo {
  peerId?: string;
  sellerEvmAddr?: string;
  suggestedAmount?: string;
  firstSignCap?: string;
  tokenRate?: string;
  buyerAvailableUsdc?: string | null;
  isFirstSign?: boolean | null;
  cooldownRemainingSecs?: number | null;
}

interface PaymentApprovalCardProps {
  info: PaymentApprovalInfo;
  onApprove: () => void;
  onReject: () => void;
}

function formatUsdc(baseUnits: string | null | undefined): string {
  if (!baseUnits) return '—';
  const n = Number(baseUnits) / 1_000_000;
  return `$${n.toFixed(2)}`;
}

function formatRate(baseUnitsPerToken: string | undefined): string {
  if (!baseUnitsPerToken) return '—';
  const perToken = Number(baseUnitsPerToken) / 1_000_000;
  const perMillion = perToken * 1_000_000;
  return `$${perMillion.toFixed(2)} / 1M tokens`;
}

function formatCooldown(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || secs <= 0) return 'Ready';
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h remaining`;
  if (hours > 0) return `${hours}h remaining`;
  return `${Math.ceil(secs / 60)}m remaining`;
}

export function PaymentApprovalCard({ info, onApprove, onReject }: PaymentApprovalCardProps) {
  const isFirstSign = info.isFirstSign !== false;
  const peerLabel = info.peerId ? `${info.peerId.slice(0, 12)}...` : 'Unknown peer';

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.icon}>
          {isFirstSign ? '🔐' : '🔄'}
        </span>
        <h4 className={styles.title}>
          {isFirstSign ? 'New session' : 'Continue session'}
        </h4>
      </div>

      <p className={styles.description}>
        <strong>{peerLabel}</strong> requires a payment session to serve requests.
        {isFirstSign
          ? ' This is your first session with this peer.'
          : ' This continues from a prior session.'}
      </p>

      <div className={styles.details}>
        <div className={styles.row}>
          <span className={styles.label}>Pre-deposit</span>
          <span className={styles.value}>{formatUsdc(info.suggestedAmount)}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Rate</span>
          <span className={styles.value}>{formatRate(info.tokenRate)}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Your balance</span>
          <span className={styles.value}>{formatUsdc(info.buyerAvailableUsdc)}</span>
        </div>
        {!isFirstSign && (
          <div className={styles.row}>
            <span className={styles.label}>Cooldown</span>
            <span className={styles.value}>{formatCooldown(info.cooldownRemainingSecs)}</span>
          </div>
        )}
      </div>

      <p className={styles.note}>
        Funds are reserved, not spent. You only pay for tokens used. Unused balance returns after the session ends.
      </p>

      <div className={styles.actions}>
        <button className={styles.rejectBtn} onClick={onReject}>Cancel</button>
        <button className={styles.approveBtn} onClick={onApprove}>Approve</button>
      </div>
    </div>
  );
}
