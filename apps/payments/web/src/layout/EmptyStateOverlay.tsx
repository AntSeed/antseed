import { useEffect, useState } from 'react';
import type { BalanceData, PaymentConfig } from '../types';
import { DepositView } from '../components/DepositView';

interface EmptyStateOverlayProps {
  isVisible: boolean;
  config: PaymentConfig | null;
  balance: BalanceData | null;
  buyerAddress: string | null;
  onDeposited: () => void;
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 10.5V3.5C3 2.67 3.67 2 4.5 2H10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 8.5L6.5 11.5L12.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function EmptyStateOverlay({
  isVisible,
  config,
  balance,
  buyerAddress,
  onDeposited,
}: EmptyStateOverlayProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isVisible) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isVisible]);

  if (!isVisible) return null;

  async function handleCopy() {
    if (!buyerAddress) return;
    try {
      await navigator.clipboard.writeText(buyerAddress);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard blocked — ignore
    }
  }

  return (
    <div className="empty-state-overlay" role="dialog" aria-label="Get started">
      <div className="empty-state-card">
        <div className="empty-state-header">
          <div className="empty-state-eyebrow">Welcome to AntSeed</div>
          <h2 className="empty-state-title">Fund your AntSeed account</h2>
          <p className="empty-state-subtitle">
            Deposit USDC to start routing requests across the network. Your AntSeed
            signer authorizes spending from the account — it never holds funds itself.
          </p>
        </div>

        <div className="empty-state-signer">
          <div className="empty-state-signer-label">
            <span className="empty-state-signer-dot" />
            Your AntSeed signer
          </div>
          <button
            type="button"
            className={`empty-state-signer-value${copied ? ' empty-state-signer-value--copied' : ''}`}
            onClick={handleCopy}
            disabled={!buyerAddress}
            title={buyerAddress ?? 'Loading…'}
          >
            <span className="empty-state-signer-addr">{buyerAddress ?? 'Loading…'}</span>
            <span className="empty-state-signer-icon">
              {copied ? <CheckIcon /> : <CopyIcon />}
            </span>
          </button>
          <p className="empty-state-signer-hint">
            Your signer authorizes every spend — it never holds USDC itself.
          </p>
        </div>

        <DepositView
          config={config}
          balance={balance}
          buyerAddress={buyerAddress}
          onDeposited={onDeposited}
        />
      </div>
    </div>
  );
}
