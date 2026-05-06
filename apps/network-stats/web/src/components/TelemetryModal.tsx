import { useEffect, useState, type ReactNode } from 'react';
import type { IndexerInfo } from '../api';
import {
  formatAbsoluteLocalTime,
  formatBlock,
  formatRelative,
  formatSeconds,
  shortAddress,
} from '../utils';
import { CopyGlyph } from './icons';
import { Modal } from './Modal';

function TelemetryModalRow({
  label,
  children,
  tone,
}: {
  label: string;
  children: ReactNode;
  tone?: 'ok' | 'alert' | 'idle';
}) {
  return (
    <div className={`tm-row${tone ? ` tm-row--${tone}` : ''}`}>
      <span className="tm-row-label">{label}</span>
      <span className="tm-row-leader" aria-hidden />
      <span className="tm-row-value">{children}</span>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(t);
  }, [copied]);

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // ignore clipboard failures
    }
  };

  return (
    <button
      type="button"
      className={`tm-copy${copied ? ' is-copied' : ''}`}
      onClick={onClick}
      aria-label={label}
    >
      <CopyGlyph />
      <span className="tm-copy-label">{copied ? 'copied' : 'copy'}</span>
    </button>
  );
}

export function TelemetryModal({
  updatedAtMs,
  isFetching,
  secondsUntilNext,
  serverPollMs,
  indexer,
  indexerDegraded,
  now,
  onClose,
}: {
  updatedAtMs: number | null;
  isFetching: boolean;
  secondsUntilNext: number | null;
  serverPollMs: number;
  indexer: IndexerInfo | null;
  indexerDegraded: boolean;
  now: number;
  onClose: () => void;
}) {
  const cadenceLabel = `every ${formatSeconds(Math.round(serverPollMs / 1000))}`;
  const nextLabel =
    secondsUntilNext == null
      ? '—'
      : isFetching || secondsUntilNext === 0
        ? 'refreshing…'
        : `in ${formatSeconds(secondsUntilNext)}`;

  const lag =
    indexer && indexer.latestBlock != null && Number.isFinite(indexer.latestBlock)
      ? Math.max(0, indexer.latestBlock - indexer.lastBlock)
      : null;

  const indexerToneClass = !indexer
    ? ''
    : indexerDegraded
      ? 'tm-status--alert'
      : 'tm-status--ok';
  const indexerStatusLabel = !indexer
    ? 'unknown'
    : indexerDegraded
      ? 'RPC issues'
      : indexer.synced
        ? 'synced'
        : 'healthy';

  return (
    <Modal
      titleId="tm-title"
      eyebrow="Station Telemetry"
      title="Network observatory"
      sub={
        <>
          <span>{indexer?.chainId ?? 'unknown chain'}</span>
          <span className="tm-head-sep" aria-hidden>·</span>
          <span className="mono">{indexer ? shortAddress(indexer.contractAddress) : '—'}</span>
        </>
      }
      onClose={onClose}
      closeLabel="Close station telemetry"
      footer={
        <footer className="tm-foot">
          <span className="mono tm-foot-hint">
            {indexer && indexerDegraded
              ? 'Indexer auto-retries each tick. No data lost — checkpoint replays.'
              : 'Press esc to close.'}
          </span>
        </footer>
      }
    >
      <div className="tm-body">
        <section className="tm-section">
          <div className="tm-section-rule"><span>Poll</span></div>
          <TelemetryModalRow
            label="Last refresh"
            tone={updatedAtMs == null ? 'idle' : isFetching ? 'ok' : undefined}
          >
            <span className="tm-value-main">
              {updatedAtMs != null ? formatRelative(updatedAtMs, now) : 'awaiting first poll'}
            </span>
            {updatedAtMs != null && (
              <span className="tm-value-aside mono">{formatAbsoluteLocalTime(updatedAtMs)}</span>
            )}
          </TelemetryModalRow>
          <TelemetryModalRow label="Next refresh">
            <span className="tm-value-main">{nextLabel}</span>
          </TelemetryModalRow>
          <TelemetryModalRow label="Cadence">
            <span className="tm-value-main mono">{cadenceLabel}</span>
          </TelemetryModalRow>
        </section>

        <section className="tm-section">
          <div className="tm-section-rule"><span>Indexer</span></div>

          <TelemetryModalRow
            label="Status"
            tone={indexer ? (indexerDegraded ? 'alert' : 'ok') : 'idle'}
          >
            <span className={`tm-status ${indexerToneClass}`}>
              <span className="tm-status-dot" aria-hidden />
              {indexerStatusLabel}
            </span>
          </TelemetryModalRow>

          {indexer && (
            <>
              <TelemetryModalRow label="Last successful tick">
                <span className="tm-value-main">
                  {indexer.lastSuccessAt != null
                    ? formatRelative(indexer.lastSuccessAt, now)
                    : '—'}
                </span>
                {indexer.lastSuccessAt != null && (
                  <span className="tm-value-aside mono">
                    {formatAbsoluteLocalTime(indexer.lastSuccessAt)}
                  </span>
                )}
              </TelemetryModalRow>

              <TelemetryModalRow label="Last error" tone={indexerDegraded ? 'alert' : undefined}>
                <span className="tm-value-main">
                  {indexer.lastErrorAt != null
                    ? formatRelative(indexer.lastErrorAt, now)
                    : 'none'}
                </span>
                {indexer.lastErrorAt != null && (
                  <span className="tm-value-aside mono">
                    {formatAbsoluteLocalTime(indexer.lastErrorAt)}
                  </span>
                )}
              </TelemetryModalRow>

              <TelemetryModalRow label="Indexed block">
                <span className="tm-value-main mono">{formatBlock(indexer.lastBlock)}</span>
              </TelemetryModalRow>

              {indexer.latestBlock != null && (
                <TelemetryModalRow label="Chain head">
                  <span className="tm-value-main mono">{formatBlock(indexer.latestBlock)}</span>
                </TelemetryModalRow>
              )}

              {lag != null && (
                <TelemetryModalRow label="Lag">
                  <span className="tm-value-main mono">
                    {lag.toLocaleString()} {lag === 1 ? 'block' : 'blocks'}
                  </span>
                </TelemetryModalRow>
              )}

              {indexer.reorgSafetyBlocks != null && (
                <TelemetryModalRow label="Reorg safety">
                  <span className="tm-value-main mono">
                    {indexer.reorgSafetyBlocks} blocks
                  </span>
                </TelemetryModalRow>
              )}

              <TelemetryModalRow label="Contract">
                <span className="tm-value-main mono">{shortAddress(indexer.contractAddress)}</span>
              </TelemetryModalRow>
            </>
          )}

          {indexer && indexerDegraded && indexer.lastErrorMessage && (
            <div className="tm-error">
              <div className="tm-error-head-row">
                <span className="tm-error-head">Latest RPC error</span>
                <CopyButton text={indexer.lastErrorMessage} label="Copy RPC error" />
              </div>
              <pre className="tm-error-body mono">{indexer.lastErrorMessage}</pre>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
