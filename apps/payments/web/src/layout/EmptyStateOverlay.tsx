import { useEffect, useState } from 'react';
import type { BalanceData, PaymentConfig } from '../types';
import { DepositView } from '../components/DepositView';
import type { OverlayPhase } from '../App';

interface EmptyStateOverlayProps {
  phase: OverlayPhase;
  config: PaymentConfig | null;
  balance: BalanceData | null;
  buyerAddress: string | null;
  onDeposited: () => void;
  onContinue: () => void;
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

function BigCheckIcon() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="32" r="30" fill="var(--accent-dim)" stroke="var(--accent)" strokeWidth="2" />
      <path d="M20 33L28.5 41.5L44.5 23" stroke="var(--accent)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function EmptyStateOverlay({
  phase,
  config,
  balance,
  buyerAddress,
  onDeposited,
  onContinue,
}: EmptyStateOverlayProps) {
  const [copied, setCopied] = useState(false);

  const isVisible = phase !== null;

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
        {phase === 'deposit' ? (
          <>
            <div className="empty-state-header">
              <div className="empty-state-eyebrow">Welcome to AntSeed</div>
              <h2 className="empty-state-title">Fund your AntSeed account</h2>
              <p className="empty-state-subtitle">
                Deposit USDC to start routing requests across the network. Your AntSeed
                signer authorizes spending from the account — it never holds funds itself.
              </p>
            </div>

            <div className="empty-state-step">
              <div className="empty-state-step-label">Step 1 · Deposit USDC</div>
              <DepositView
                config={config}
                balance={balance}
                buyerAddress={buyerAddress}
                onDeposited={onDeposited}
              />
            </div>
          </>
        ) : (
          <div className="empty-state-success">
            <div className="empty-state-success-icon">
              <BigCheckIcon />
            </div>
            <h2 className="empty-state-title">You're all set</h2>
            <p className="empty-state-subtitle">
              Your deposit is in. AntSeed will now route requests across the network —
              you only pay for what you use.
            </p>
            <div className="empty-state-success-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={onContinue}
              >
                Continue
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
