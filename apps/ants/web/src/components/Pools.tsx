import { Button, IconButton } from './ui';
import { useEffect, useMemo, useState } from 'react';
import type { PoolView, PoolsView } from '../../../src/api-types';
import { cmpBig, formatAnts, formatBps, formatInt, formatUsdc, formatUsdcCompact, formatUtc, shortAddress, toBigInt } from '../format';
import { AddressLink } from './AddressLink';
import { Details } from './Details';
import { EpochCell } from './Epoch';
import { CloseIcon } from './icons';
import { Input } from './Field';
import { Facts } from './Panel';
import { Pill } from './Pill';
import { Table, type Column } from './Table';

/** Display name for a pool: explorer profile name, else the short seller address, else the agent id. */
export function poolName(pool: PoolView): string {
  if (pool.profile?.name) return pool.profile.name;
  if (pool.seller) return shortAddress(pool.seller);
  return `Agent ${pool.agentId}`;
}

/** Select-option label: name plus agent id. */
export function poolLabel(pool: PoolView): string {
  return `${poolName(pool)} · agent ${pool.agentId}`;
}

export const POOL_ROW_CAP = 20;

/** Stakeable pools first; within a group by reward per 1k power (desc) when settled, then power, then this-epoch volume. */
export function sortPools(pools: PoolView[]): PoolView[] {
  return [...pools].sort((a, b) => {
    if (a.stakeable !== b.stakeable) return a.stakeable ? -1 : 1;
    const ra = a.lastEpochRewardPer1kPower;
    const rb = b.lastEpochRewardPer1kPower;
    if (ra !== null && rb !== null) {
      const c = cmpBig(rb, ra);
      if (c !== 0) return c;
    } else if (ra !== null) return -1;
    else if (rb !== null) return 1;
    const byPower = cmpBig(b.weight, a.weight);
    if (byPower !== 0) return byPower;
    return cmpBig(b.volumes[0]?.usdc ?? '0', a.volumes[0]?.usdc ?? '0');
  });
}

function matchesFilter(pool: PoolView, needle: string): boolean {
  if (!needle) return true;
  const q = needle.toLowerCase();
  return String(pool.agentId) === needle || (pool.profile?.name ?? '').toLowerCase().includes(q) || (pool.seller ?? '').toLowerCase().includes(q);
}

function rewardCell(pool: PoolView) {
  const last = pool.lastEpochRewardPer1kPower;
  const proj = pool.projectedRewardPer1kPower;
  return (
    <span className="cell-stack">
      <span>{last !== null ? <>{formatAnts(last, 4)}{pool.lastEpochEmissionSettled ? null : <span className="dim"> est.</span>}</> : <span className="dim">—</span>}</span>
      {proj !== null ? <span className="cell-sub">proj. {formatAnts(proj, 4)}</span> : null}
    </span>
  );
}

function volumeCell(pool: PoolView) {
  const [current, last] = pool.volumes;
  return (
    <span className="cell-stack">
      <span>{current ? formatUsdcCompact(current.usdc) : <span className="dim">—</span>}</span>
      <span className="cell-sub">{last ? `last ${formatUsdcCompact(last.usdc)}` : '—'}</span>
    </span>
  );
}

interface TableProps {
  pools: PoolView[];
  loading: boolean;
  onOpen: (pool: PoolView) => void;
  onStake: (pool: PoolView) => void;
}

export function PoolsTable({ pools, loading, onOpen, onStake }: TableProps) {
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const needle = filter.trim();
  const filtered = useMemo(() => pools.filter((p) => matchesFilter(p, needle)), [pools, needle]);
  const capped = !showAll && filtered.length > POOL_ROW_CAP;
  const visible = capped ? filtered.slice(0, POOL_ROW_CAP) : filtered;
  const columns: Array<Column<PoolView>> = [
    {
      key: 'pool',
      label: 'Pool',
      render: (p) => (
        <span className="cell-stack">
          <span>
            {poolName(p)}
            {!p.stakeable ? <span className="dim small"> · not stakeable yet</span> : null}
          </span>
          <span className="cell-sub mono">
            agent {p.agentId}
            {p.profile?.name && p.seller ? ` · ${shortAddress(p.seller)}` : ''}
          </span>
        </span>
      ),
    },
    {
      key: 'power',
      label: 'Power',
      align: 'right',
      mono: true,
      title: 'Pool power this epoch and its share of all pools',
      render: (p) => (
        <span className="cell-stack">
          <span>{formatAnts(p.weight)}</span>
          <span className="cell-sub">{formatBps(p.powerShareBps)} of network</span>
        </span>
      ),
    },
    { key: 'volume', label: 'Volume', align: 'right', mono: true, title: 'Settled USDC this epoch / last epoch', render: volumeCell },
    { key: 'reward', label: 'Reward / 1k power', align: 'right', mono: true, title: 'Staker ANTS per 1,000 power last epoch; projected for this epoch below', render: rewardCell },
    {
      key: 'yours',
      label: 'Your power',
      align: 'right',
      mono: true,
      render: (p) =>
        toBigInt(p.yourPower) ? (
          <span className="cell-stack">
            <span>{formatAnts(p.yourPower)}</span>
            <span className="cell-sub">{formatBps(p.yourPoolShareBps)} of pool</span>
          </span>
        ) : (
          <span className="dim">—</span>
        ),
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      className: 'col-actions',
      render: (p) =>
        p.stakeable ? (
          <span onClick={(e) => e.stopPropagation()}>
            <Button variant="outline" size="sm" onClick={() => onStake(p)}>
              Stake
            </Button>
          </span>
        ) : null,
    },
  ];
  return (
    <>
      {pools.length > 5 ? (
        <div className="pools-toolbar">
          <Input label="" mono={false} width="md" placeholder="Filter by name or agent id" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter pools" />
          <span className="muted small">
            {formatInt(filtered.length)} of {formatInt(pools.length)} sellers · {formatInt(pools.filter((p) => p.stakeable).length)} stakeable
          </span>
        </div>
      ) : null}
      <Table
        columns={columns}
        rows={visible}
        rowKey={(p) => p.agentId}
        loading={loading}
        onRowClick={onOpen}
        rowClass={(p) => (!p.stakeable ? 'row-muted' : undefined)}
        empty={needle ? `No seller matches "${needle}".` : 'No pools have been staked yet.'}
      />
      {filtered.length > POOL_ROW_CAP ? (
        <div className="pools-more">
          <span className="muted small">
            Showing {formatInt(visible.length)} of {formatInt(filtered.length)}
          </span>
          <button type="button" className="link-button" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : 'Show all'}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** Right-hand drawer: explorer profile, 3-epoch volume against the network, pool facts, your positions. */
export function PoolDrawer({ pool, view, onClose, onStake }: { pool: PoolView; view: PoolsView; onClose: () => void; onStake: (pool: PoolView) => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const profile = pool.profile;
  const explorerUrl = view.explorer && pool.seller ? `${view.explorer.replace(/\/$/, '')}/sellers/${pool.seller}` : null;
  const networkByEpoch = new Map(view.networkVolumes.map((v) => [v.epoch, v.usdc]));

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Pool ${poolName(pool)}`}>
        <header className="drawer-header">
          <div className="drawer-titles">
            <h2 className="drawer-title">{poolName(pool)}</h2>
            <div className="muted small">
              agent <span className="mono">{pool.agentId}</span>
              {pool.seller ? (
                <>
                  {' · '}
                  <AddressLink value={pool.seller} copy />
                </>
              ) : (
                ' · no seller bound'
              )}
              {explorerUrl ? (
                <>
                  {' · '}
                  <a href={explorerUrl} target="_blank" rel="noreferrer">
                    explorer
                  </a>
                </>
              ) : null}
            </div>
          </div>
          <IconButton label="Close" className="drawer-close" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </header>
        <div className="drawer-body">
          <div className="row">
            {pool.stakeable ? <Pill tone="accent">stakeable</Pill> : <Pill tone="muted">not stakeable</Pill>}
            {pool.hasPool ? null : <Pill tone="muted">no pool yet</Pill>}
            {pool.stakeable ? (
              <Button variant="primary" size="sm" onClick={() => onStake(pool)}>
                Stake into this pool
              </Button>
            ) : null}
          </div>

          <section className="drawer-section">
            <h3 className="drawer-section-title">Pool</h3>
            <Facts
              items={[
                ['Power', `${formatAnts(pool.weight)} · ${formatBps(pool.powerShareBps)} of network`],
                ['Active stake', `${formatAnts(pool.activeStake, 4)} ANTS`],
                ['Security share', formatBps(pool.securityShareBps)],
                ['Reward / 1k power (last)', pool.lastEpochRewardPer1kPower !== null ? `${formatAnts(pool.lastEpochRewardPer1kPower, 4)} ANTS${pool.lastEpochEmissionSettled ? '' : ' (estimated until settled)'}` : '—'],
                ['Reward / 1k power (proj.)', pool.projectedRewardPer1kPower !== null ? `${formatAnts(pool.projectedRewardPer1kPower, 4)} ANTS` : '—'],
                ['Usage points (this / last)', `${formatInt(pool.usagePoints)} / ${formatInt(pool.lastEpochUsagePoints)}`],
                ['Last epoch emission', pool.lastEpochEmission !== null ? `${formatAnts(pool.lastEpochEmission, 4)} ANTS` : '—'],
              ]}
            />
          </section>

          <section className="drawer-section">
            <h3 className="drawer-section-title">Volume</h3>
            <div className="table-wrap" style={{ marginBottom: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Epoch</th>
                    <th className="num">Pool</th>
                    <th className="num">Network</th>
                    <th className="num">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {pool.volumes.length === 0 ? (
                    <tr>
                      <td className="empty" colSpan={4}>
                        No settled volume yet.
                      </td>
                    </tr>
                  ) : null}
                  {pool.volumes.map((v, i) => {
                    const net = networkByEpoch.get(v.epoch) ?? null;
                    const share = net && toBigInt(net) ? Number((BigInt(v.usdc) * 10_000n) / BigInt(net)) : null;
                    return (
                      <tr key={v.epoch}>
                        <td>
                          <EpochCell epoch={v.epoch} />
                          {i === 0 ? <span className="dim small"> current</span> : null}
                        </td>
                        <td className="num">{formatUsdc(v.usdc)}</td>
                        <td className="num">{net !== null ? formatUsdc(net) : '—'}</td>
                        <td className="num">{share !== null ? formatBps(share) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="drawer-section">
            <h3 className="drawer-section-title">Seller profile</h3>
            {profile ? (
              <Facts
                items={[
                  ['Name', profile.name ?? <span className="muted">—</span>],
                  ['Providers', profile.providers.length > 0 ? profile.providers.join(', ') : <span className="muted">—</span>],
                  ['Models served', profile.modelsServed !== null ? formatInt(profile.modelsServed) : '—'],
                  ['Unique buyers', profile.uniqueBuyers !== null ? formatInt(profile.uniqueBuyers) : '—'],
                  ['Requests', profile.requestCount !== null ? formatInt(profile.requestCount) : '—'],
                  ['Lifetime volume', profile.lifetimeVolumeUsdc !== null ? `${formatUsdc(profile.lifetimeVolumeUsdc)} USDC` : '—'],
                  ['Ghost rate', profile.ghostRate !== null ? `${(profile.ghostRate * 100).toFixed(1)}%` : '—'],
                  ['Last settled', profile.lastSettledAt !== null ? formatUtc(profile.lastSettledAt) : '—'],
                ]}
              />
            ) : (
              <span className="muted small">The explorer has no record for this seller.</span>
            )}
          </section>

          <section className="drawer-section">
            <h3 className="drawer-section-title">Your positions</h3>
            {pool.yourPositionIds.length > 0 ? (
              <Facts
                items={[
                  ['Positions', <span className="mono">{pool.yourPositionIds.map((id) => `#${id}`).join(', ')}</span>],
                  ['Your stake', `${formatAnts(pool.yourStake, 4)} ANTS`],
                  ['Your power', `${formatAnts(pool.yourPower, 4)} · ${formatBps(pool.yourPoolShareBps)} of pool`],
                ]}
              />
            ) : (
              <span className="muted small">You have no positions in this pool.</span>
            )}
          </section>

          <Details summary="Weighted points">
            <Facts items={[['Weighted usage points', formatInt(pool.weightedUsagePoints)]]} />
          </Details>
        </div>
      </aside>
    </>
  );
}
