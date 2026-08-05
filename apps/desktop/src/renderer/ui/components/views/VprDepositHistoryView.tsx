import { useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowUpRight01Icon } from '@hugeicons/core-free-icons';
import { explorerTxUrl, formatShortId } from '../../../core/format';
import { VprCard, VprPage } from '../vpr/VprKit';
import type { DepositHistoryEntry } from '../../../types/bridge';
import styles from './VprDepositHistoryView.module.scss';

function baseUnitsToUsd(value: string | undefined): string {
  try {
    const units = BigInt(value ?? '0');
    const whole = units / 1_000_000n;
    const cents = (units % 1_000_000n) / 10_000n;
    return `${whole}.${cents.toString().padStart(2, '0')}`;
  } catch {
    return '0.00';
  }
}

function formatDate(tsSeconds: number): string {
  if (!tsSeconds) return '';
  return new Date(tsSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

/**
 * Past on-chain deposits: amount, date and a link to the transaction on the
 * chain explorer. Read-only — deposits are recorded on-chain via the QR/card
 * flow in VprDepositView, this just lists what already happened.
 */
export function VprDepositHistoryView({ onSelectView: _onSelectView }: Props) {
  const [entries, setEntries] = useState<DepositHistoryEntry[] | null>(null);
  const [chainId, setChainId] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.antseedDesktop?.depositsGetHistory?.().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setEntries(result.data ?? []);
        setChainId(result.chainId ?? undefined);
      } else {
        setError(result.error ?? 'Could not load deposit history');
        setEntries([]);
      }
    }).catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
      setEntries([]);
    });
    return () => { cancelled = true; };
  }, []);

  const loading = entries === null;

  return (
    <section className={`view view-vpr-deposit-history view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Deposit history" backFallback="deposit">
      <div className={styles.stack}>

        {error && <div className={styles.errorCard} role="alert">{error}</div>}

        {loading ? (
          <VprCard className={styles.emptyCard}>
            <span className={styles.emptyTitle}>Loading deposits...</span>
          </VprCard>
        ) : entries!.length === 0 ? (
          <VprCard className={styles.emptyCard}>
            <span className={styles.emptyTitle}>No deposits yet</span>
            <span className={styles.emptyHint}>
              USDC you add to your balance shows up here once it lands on-chain.
            </span>
          </VprCard>
        ) : (
          <VprCard className={styles.listCard}>
            {entries!.map((entry) => {
              const txUrl = explorerTxUrl(chainId, entry.txHash);
              return (
                <div key={`${entry.txHash}-${entry.blockNumber}`} className={styles.row}>
                  <div className={styles.rowMain}>
                    <span className={styles.rowAmount}>${baseUnitsToUsd(entry.amountBaseUnits)}</span>
                    <span className={styles.rowMeta}>{formatDate(entry.timestamp)}</span>
                  </div>
                  <div className={styles.rowSide}>
                    {txUrl ? (
                      <button
                        type="button"
                        className={styles.txLink}
                        onClick={() => void window.antseedDesktop?.openExternalUrl?.(txUrl)}
                      >
                        <span>{formatShortId(entry.txHash, 6, 4)}</span>
                        <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
                      </button>
                    ) : (
                      <span className={styles.rowMeta}>{formatShortId(entry.txHash, 6, 4)}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </VprCard>
        )}

        <span className={styles.footnote}>
          Deposits are credited automatically once they confirm on Base — this list is
          read directly from the AntSeed Deposits contract.
        </span>
      </div>
      </VprPage>
    </section>
  );
}
