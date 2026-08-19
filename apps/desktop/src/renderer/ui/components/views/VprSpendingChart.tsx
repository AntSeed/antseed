import { useMemo, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import type { DesktopBuyerSpendHistory } from '../../../types/bridge';
import { InfoTooltip } from '../InfoTooltip';
import { formatCompactTokens, VprCard } from '../vpr/VprKit';
import {
  buildSpendingChartModel,
  formatSpendUsd,
  spendingBarHeight,
  type SpendingRangeDays,
} from './vpr-spending-history';
import styles from './VprSpendingChart.module.scss';

const RANGE_OPTIONS: SpendingRangeDays[] = [7, 30, 90];

type Props = {
  history: DesktopBuyerSpendHistory | null;
  loading: boolean;
};

function unavailableMessage(history: DesktopBuyerSpendHistory | null, loading: boolean): string | null {
  if (loading && history === null) return 'Loading spending history…';
  if (history === null) return 'Spending history is temporarily unavailable.';
  if (history.available) return null;
  return 'Start the buyer proxy to view local spending history.';
}

export function VprSpendingChart({ history, loading }: Props): JSX.Element {
  const [range, setRange] = useState<SpendingRangeDays>(7);
  const model = useMemo(
    () => buildSpendingChartModel(history?.available ? history.days : [], range),
    [history, range],
  );
  const maximumUsdc = useMemo(
    () => model.buckets.reduce((maximum, bucket) => {
      try {
        return BigInt(bucket.spentUsdc) > BigInt(maximum) ? bucket.spentUsdc : maximum;
      } catch {
        return maximum;
      }
    }, '0'),
    [model.buckets],
  );
  const message = unavailableMessage(history, loading);

  return (
    <VprCard className={styles.card}>
      <div className={styles.header}>
        <h2 className={styles.title}>Spending</h2>
        <div className={styles.ranges} aria-label="Spending range">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              className={`${styles.rangeButton}${range === option ? ` ${styles.rangeButtonActive}` : ''}`}
              aria-pressed={range === option}
              onClick={() => setRange(option)}
            >
              {option}D
            </button>
          ))}
        </div>
      </div>

      {message ? (
        <div className={styles.unavailable} role="status">{message}</div>
      ) : (
        <>
          <div className={styles.plot} style={{ '--bucket-count': model.buckets.length } as CSSProperties}>
            {model.buckets.map((bucket) => {
              const height = spendingBarHeight(bucket.spentUsdc, maximumUsdc);
              const amount = formatSpendUsd(bucket.spentUsdc, true);
              const tokens = formatCompactTokens(bucket.inputTokens, bucket.outputTokens);
              return (
                <InfoTooltip
                  key={bucket.key}
                  align="left"
                  content={<><strong>{bucket.tooltipLabel}</strong><span>{amount} spent</span><span>{tokens} tokens</span></>}
                >
                  <button
                    type="button"
                    className={styles.barTarget}
                    aria-label={`${bucket.tooltipLabel}: ${amount} spent`}
                  >
                    <span className={styles.bar} style={{ height: `${height}%` }} />
                  </button>
                </InfoTooltip>
              );
            })}
          </div>
          <div className={styles.axis} style={{ '--bucket-count': model.buckets.length } as CSSProperties} aria-hidden="true">
            {model.buckets.map((bucket) => <span key={bucket.key}>{bucket.axisLabel}</span>)}
          </div>
          <div className={styles.summary}>
            <span>
              {formatCompactTokens(model.totalInputTokens, model.totalOutputTokens)} tokens ·{' '}
              {formatSpendUsd(model.totalSpentUsdc)} spent over {range} days
            </span>
          </div>
        </>
      )}
    </VprCard>
  );
}
