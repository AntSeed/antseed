import { poolApyRange, formatYieldPercent as percent, EXTREME_YIELD_NOTE, YIELD_DISPLAY_LIMIT } from '../pool-yield';
import { usePageData } from '../data';
import { api } from '../api';
import { Button, IconButton } from './ui';
import { useEffect, useMemo, useState } from 'react';
import type { PoolView, PoolsView } from '../../../src/api-types';
import { cmpBig, formatAnts, formatBps, formatInt, formatUsdc, formatUsdcCompact, formatUtc, shortAddress, toBigInt } from '../format';
import { AddressLink } from './AddressLink';
import { EpochCell } from './Epoch';
import { CloseIcon } from './icons';
import { Input } from './Field';
import { Facts } from './Panel';
import { Pill } from './Pill';
import { Table, type Column } from './Table';

/** Seller name when indexed; otherwise an explicit pool identifier, never a wallet address as its name. */
export function poolName(pool: PoolView): string {
  return pool.profile?.name?.trim() || `Seller pool #${pool.agentId}`;
}

/** Select-option label: name plus agent id. */
export function poolLabel(pool: PoolView): string {
  return pool.profile?.name?.trim() ? `${poolName(pool)} · agent ${pool.agentId}` : poolName(pool);
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

type PoolSortMetric = 'apy' | 'volume';
type SortDirection = 'ascending' | 'descending';

/** Sort the displayed metric, keeping unavailable values last in either direction. */
export function sortPoolsByMetric(pools: PoolView[], metric: PoolSortMetric, direction: SortDirection, currentEpoch: number): PoolView[] {
  const value = (pool: PoolView): number | bigint | null => metric === 'apy'
    ? poolApyRange(pool.yield).oneWeek.apy
    : pool.volumeStatus === 'available' && pool.volumes.some(volume => volume.epoch === currentEpoch - 1)
      ? BigInt(pool.volumes.find(volume => volume.epoch === currentEpoch - 1)!.usdc) : null;
  return [...pools].sort((a, b) => {
    const av = value(a), bv = value(b);
    if (av === null) return bv === null ? 0 : 1;
    if (bv === null) return -1;
    const order = av < bv ? -1 : av > bv ? 1 : 0;
    return direction === 'ascending' ? order : -order;
  });
}

function matchesFilter(pool: PoolView, needle: string): boolean {
  if (!needle) return true;
  const q = needle.toLowerCase();
  return String(pool.agentId) === needle || (pool.profile?.name ?? '').toLowerCase().includes(q) || (pool.seller ?? '').toLowerCase().includes(q);
}

interface TableProps {
  pools: PoolView[];
  currentEpoch: number;
  loading: boolean;
  onOpen: (pool: PoolView) => void;
  onStake: (pool: PoolView) => void;
}

export function PoolsTable({ pools, currentEpoch, loading, onOpen, onStake }: TableProps) {
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [stakeableOnly, setStakeableOnly] = useState(true);
  const [sortBy, setSortBy] = useState<PoolSortMetric>('apy');
  const [sortDirection, setSortDirection] = useState<SortDirection>('descending');
  const sortHeader = (metric: PoolSortMetric, label: string) => (
    <button type="button" className="table-sort" aria-label={`Sort by ${label}, ${sortBy === metric && sortDirection === 'descending' ? 'ascending' : 'descending'}`} onClick={() => {
      setSortDirection(sortBy === metric && sortDirection === 'descending' ? 'ascending' : 'descending');
      setSortBy(metric);
      setShowAll(false);
    }}>{label} <span aria-hidden="true">{sortBy === metric ? sortDirection === 'descending' ? '↓' : '↑' : '↕'}</span></button>
  );
  const needle = filter.trim();
  const filtered = useMemo(() => sortPoolsByMetric(pools.filter((p) => (!stakeableOnly || p.stakeable) && matchesFilter(p, needle)), sortBy, sortDirection, currentEpoch), [pools, needle, stakeableOnly, sortBy, sortDirection, currentEpoch]);
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
      key: 'apy', label: sortHeader('apy', 'APY'),
      sortDirection: sortBy === 'apy' ? sortDirection : 'none',
      align: 'right', mono: true,
      render: (pool: PoolView) => <PoolApy pool={pool} />,
    },
    { key: 'stake', label: 'Total active stake (ANTS)', align: 'right', mono: true, render: p => formatAnts(p.activeStake) },
    { key: 'volume', label: sortHeader('volume', 'Last epoch (USDC)'), sortDirection: sortBy === 'volume' ? sortDirection : 'none', align: 'right', mono: true, render: p => { const volume = p.volumes.find(volume => volume.epoch === currentEpoch - 1); return volume && p.volumeStatus === 'available' ? formatUsdcCompact(volume.usdc) : '—'; } },
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
      <div className="pools-toolbar">
        {pools.length > 5 ? (
          <Input label="" mono={false} width="md" placeholder="Filter by name or agent id" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter pools" />
        ) : null}
        <label className="check"><input type="checkbox" checked={stakeableOnly} onChange={(event) => setStakeableOnly(event.target.checked)} /> Only show pools ready for staking</label>
        {pools.length > 5 ? (
          <span className="muted small">
            {formatInt(filtered.length)} of {formatInt(pools.length)} sellers · {formatInt(pools.filter((p) => p.stakeable).length)} stakeable
          </span>
        ) : null}
      </div>
      <Table
        columns={columns}
        rows={visible}
        rowKey={(p) => p.agentId}
        loading={loading}
        onRowClick={onOpen}
        rowClass={(p) => (!p.stakeable ? 'row-muted' : undefined)}
        empty={needle ? `No seller matches "${needle}" in this view.` : stakeableOnly ? 'No stakeable pools. Turn off the filter to see sellers awaiting binding.' : 'No pools have been staked yet.'}
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

/** Right-hand drawer: seller settlement history (including legacy activity), pool facts and profile. */
export function PoolDrawer({ pool: initialPool, view, onClose, onStake }: { pool: PoolView; view: PoolsView; onClose: () => void; onStake: (pool: PoolView) => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const detail = usePageData(`pool:${initialPool.agentId}`, () => api.pool(initialPool.agentId));
  const pool = detail.data ?? initialPool;
  const historyRefreshFailed = !!detail.error || (!!detail.data && detail.data.volumeStatus !== 'available');
  const history = historyRefreshFailed && initialPool.volumeStatus === 'available' ? initialPool : pool;
  const historyEpoch = history === initialPool ? view.currentEpoch : detail.data?.currentEpoch ?? view.currentEpoch;
  const completedVolumes = history.volumes.filter(volume => volume.epoch < historyEpoch).sort((first, second) => second.epoch - first.epoch);
  const maxVolume = completedVolumes.reduce((max, v) => BigInt(v.usdc) > max ? BigInt(v.usdc) : max, 0n);
  const profile = pool.profile;
  const explorerUrl = view.explorer && pool.seller ? `${view.explorer.replace(/\/$/, '')}/account/${pool.seller}` : null;
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
                ['APY', <PoolApy pool={pool} />],
                ['Total active stake', `${formatAnts(pool.activeStake, 4)} ANTS`],
                ['Last epoch emission', pool.lastEpochEmission !== null ? `${formatAnts(pool.lastEpochEmission, 4)} ANTS` : '—'],
              ]}
            />
          </section>

          <section className="drawer-section">
            <h3 className="drawer-section-title">Seller settled volume · completed epochs</h3>
            <p className="hint">Includes legacy seller activity.</p>
            {historyRefreshFailed && history === initialPool && history.volumeStatus === 'available' && <p className="hint">Seller history could not refresh. Showing previously loaded history.</p>}
            {history.statsUpdatedAt && <p className="small muted">Fetched {formatUtc(Math.floor(history.statsUpdatedAt / 1000))}</p>}
            {history.volumeStatus !== 'available' && <p className="hint">Settlement volume {history.volumeStatus === 'stale' ? 'is stale' : 'is unavailable'}. Usage points are not revenue.</p>}
            <div className="volume-bars" role="img" aria-label="Seller settled USDC volume by completed epoch">
              {completedVolumes.slice().reverse().map(v => <div className="volume-bar-row" key={v.epoch}><span>Epoch {v.epoch}</span><div className="volume-bar-track"><div style={{ width: `${maxVolume > 0n ? Number(BigInt(v.usdc) * 10000n / maxVolume) / 100 : 0}%` }} /></div><span>{formatUsdc(v.usdc)} USDC</span></div>)}
            </div>
            <div className="table-wrap" style={{ marginBottom: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Epoch</th>
                    <th className="num">Seller</th>
                    <th className="num">Network</th>
                    <th className="num">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {completedVolumes.length === 0 ? (
                    <tr>
                      <td className="empty" colSpan={4}>
                        Settlement volume unavailable for completed epochs.
                      </td>
                    </tr>
                  ) : null}
                  {completedVolumes.map((v, i) => {
                    const net = networkByEpoch.get(v.epoch) ?? null;
                    const share = net && toBigInt(net) ? Number((BigInt(v.usdc) * 10_000n) / BigInt(net)) : null;
                    return (
                      <tr key={v.epoch}>
                        <td>
                          <EpochCell epoch={v.epoch} />

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
            <h3 className="drawer-section-title">Seller profile · lifetime activity</h3>
            {profile?.stale && <p className="hint">Seller activity is stale; the indexer could not refresh.</p>}
            {profile?.fetchedAt && <p className="small muted">Fetched {formatUtc(Math.floor(profile.fetchedAt / 1000))}</p>}
            {profile ? (
              <Facts
                items={[
                  ['Name', profile.name ?? <span className="muted">—</span>],
                  ['Providers', profile.providers.length > 0 ? profile.providers.join(', ') : <span className="muted">—</span>],
                  ['Models served', profile.modelsServed !== null ? formatInt(profile.modelsServed) : '—'],
                  ['Unique buyers', profile.uniqueBuyers !== null ? formatInt(profile.uniqueBuyers) : '—'],
                  ['Requests', profile.requestCount !== null ? formatInt(profile.requestCount) : '—'],
                  ['Lifetime volume', profile.lifetimeVolumeUsdc !== null ? `${formatUsdc(profile.lifetimeVolumeUsdc)} USDC` : '—'],
                  ['Ghost rate', profile.ghostRate !== null && Number.isFinite(profile.ghostRate) && profile.ghostRate >= 0 && profile.ghostRate <= 100 ? `${profile.ghostRate.toFixed(1)}%` : 'Unavailable'],
                  ['Last settled', profile.lastSettledAt !== null ? formatUtc(profile.lastSettledAt) : '—'],
                ]}
              />
            ) : (
              <span className="muted small">The explorer has no record for this seller.</span>
            )}
          </section>

        </div>
      </aside>
    </>
  );
}


function yieldDescription(pool: PoolView): string {
  const info = pool.yield;
  if (!info || info.status === 'unavailable') return 'Last-epoch yield is unavailable.';
  const range = poolApyRange(info);
  const duration = info.endsAt - info.startsAt;
  const lockLabel = (epochs: number | null) => epochs === null ? 'unavailable' : `${epochs} epoch(s), ${epochs * duration / 86400} days`;
  return `1,000 ANTS reference stake. 1 week: ${lockLabel(range.oneWeek.epochs)}; 2 years: ${lockLabel(range.twoYears.epochs)}. Source epoch ${info.epoch}: ${formatUtc(info.startsAt)} – ${formatUtc(info.endsAt)}. Initial earning rates include the reference stake's added power and assume an unchanged pool reward budget. APY assumes the rates repeat and compound every epoch; compounding is not automatic. Power decreases as the lock runs down, activation delays are excluded, and future activity changes returns. Missing data or unsupported locks show —.${info.status === 'estimated' ? ' Rewards are estimated until settled.' : ''}`;
}

function PoolApy({ pool }: { pool: PoolView }) {
  const { oneWeek, twoYears } = poolApyRange(pool.yield);
  const available = oneWeek.apy !== null || twoYears.apy !== null;
  const extreme = (oneWeek.apy ?? 0) > YIELD_DISPLAY_LIMIT || (twoYears.apy ?? 0) > YIELD_DISPLAY_LIMIT;
  const low = percent(oneWeek.apy), high = percent(twoYears.apy);
  return <span className="yield-percent" title={`${yieldDescription(pool)}${extreme ? ` ${EXTREME_YIELD_NOTE}` : ''}`}>
    {extreme ? 'N/A' : available ? `${low} – ${high}` : '—'}
    {available && !extreme && pool.yield?.status === 'estimated' ? <span className="dim small"> est.</span> : null}
  </span>;
}
