import type { IndexerInfo } from '../api';
import { formatRelative, formatSeconds, shortAddress } from '../utils';

export function ChainSyncCard({
  indexer,
  indexerDegraded,
  now,
}: {
  indexer: IndexerInfo;
  indexerDegraded: boolean;
  now: number;
}) {
  const head = indexer.latestBlock;
  const hasHead = head != null && Number.isFinite(head) && head > 0;
  const lag = hasHead ? Math.max(0, head - indexer.lastBlock) : null;
  const inSync = indexer.synced === true || (lag != null && lag === 0);
  const stateKind: 'sync' | 'syncing' | 'probing' = !hasHead
    ? 'probing'
    : inSync
      ? 'sync'
      : 'syncing';
  const stateLabel =
    stateKind === 'sync' ? 'in sync' : stateKind === 'syncing' ? 'syncing' : 'probing';
  const fillPct = inSync
    ? 100
    : lag != null
      ? Math.max(6, Math.min(94, 100 - Math.log10(lag + 1) * 18))
      : null;
  const etaSecs = !inSync && lag != null && lag > 0 ? lag * 2 : null;

  return (
    <div className={`card chainsync chainsync--${stateKind}`}>
      <header className="chainsync-rail">
        <div className="chainsync-rail-id">
          <span className="chainsync-rail-chain">
            {indexer.chainId || 'unknown chain'}
          </span>
          <span className="chainsync-rail-divider" aria-hidden />
          <span className="chainsync-rail-contract mono">
            {shortAddress(indexer.contractAddress) || '—'}
          </span>
        </div>
        <span className={`chainsync-state chainsync-state--${stateKind}`}>
          <span className="chainsync-state-pulse" aria-hidden />
          {stateLabel}
        </span>
      </header>

      <div className="chainsync-tape">
        <div className="chainsync-tape-end">
          <span className="chainsync-tape-key">indexed block</span>
          <span className="chainsync-tape-num mono">
            {indexer.lastBlock.toLocaleString()}
          </span>
        </div>

        <div className="chainsync-tape-track" aria-hidden>
          {[25, 50, 75].map((p) => (
            <span
              key={p}
              className="chainsync-tape-tick"
              style={{ left: `${p}%` }}
            />
          ))}
          {fillPct != null && (
            <div
              className="chainsync-tape-fill"
              style={{ width: `${fillPct}%` }}
            />
          )}
          <div className="chainsync-tape-stream" />
          {fillPct != null && (
            <div
              className="chainsync-tape-cursor"
              style={{ left: `${fillPct}%` }}
            >
              <span className="chainsync-tape-cursor-bar" />
              <span className="chainsync-tape-cursor-dot" />
            </div>
          )}
        </div>

        <div className="chainsync-tape-end chainsync-tape-end--rhs">
          <span className="chainsync-tape-key">chain head</span>
          <span
            className={`chainsync-tape-num mono${
              hasHead ? '' : ' chainsync-tape-num--pending'
            }`}
          >
            {hasHead ? head.toLocaleString() : 'probing…'}
          </span>
        </div>
      </div>

      <div className="chainsync-callout">
        {inSync ? (
          <>
            <span className="chainsync-callout-mark chainsync-callout-mark--ok">
              caught up
            </span>
            <span className="chainsync-callout-body">
              indexer sits on the chain head — figures above are current to the latest block.
            </span>
          </>
        ) : hasHead && lag != null ? (
          <>
            <span className="chainsync-callout-mark mono">
              −{lag.toLocaleString()} {lag === 1 ? 'block' : 'blocks'}
            </span>
            <span className="chainsync-callout-body">
              behind chain head
              {etaSecs != null && (
                <>
                  <span className="chainsync-callout-sep" aria-hidden>·</span>
                  ≈ <span className="mono">{formatSeconds(etaSecs)}</span> of history left to read at ~2s/block
                </>
              )}
            </span>
          </>
        ) : (
          <>
            <span className="chainsync-callout-mark chainsync-callout-mark--warn">
              first probe pending
            </span>
            <span className="chainsync-callout-body">
              chain-head height not yet returned by the RPC — indexed cursor advances independently.
            </span>
          </>
        )}
      </div>

      <dl className="chainsync-vitals">
        <div className="chainsync-vital">
          <dt>Last tick</dt>
          <dd className="mono">
            {indexer.lastSuccessAt ? formatRelative(indexer.lastSuccessAt, now) : '—'}
          </dd>
        </div>
        <div
          className={`chainsync-vital${
            indexerDegraded ? ' chainsync-vital--alert' : ''
          }`}
        >
          <dt>Last error</dt>
          <dd className="mono">
            {indexer.lastErrorAt ? formatRelative(indexer.lastErrorAt, now) : 'none'}
          </dd>
        </div>
        <div className="chainsync-vital">
          <dt>Reorg buffer</dt>
          <dd className="mono">
            {indexer.reorgSafetyBlocks != null ? `${indexer.reorgSafetyBlocks} blk` : '—'}
          </dd>
        </div>
      </dl>
    </div>
  );
}
