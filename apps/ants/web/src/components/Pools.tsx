import { poolApyRange, poolApyEstimates, formatYieldPercent as percent, EXTREME_YIELD_LABEL, EXTREME_YIELD_NOTE, YIELD_DISPLAY_LIMIT } from '../pool-yield';
import { usePageData } from '../data';
import { api } from '../api';
import { Button } from './ui';
import { Modal } from '@antseed/ui';
import { useMemo, useState } from 'react';
import { PoolActivity, SellerModels } from './PoolActivity';
import type { PoolView, PoolsView } from '../../../src/api-types';
import { cmpBig, formatAnts, formatBps, formatInt, formatUsdcCompact, formatUtc } from '../format';
import { AddressLink } from './AddressLink';
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
  const stakeablePools = useMemo(() => pools.filter(pool => pool.stakeable), [pools]);
  const filtered = useMemo(() => sortPoolsByMetric(stakeablePools.filter(pool => matchesFilter(pool, needle)), sortBy, sortDirection, currentEpoch), [stakeablePools, needle, sortBy, sortDirection, currentEpoch]);
  const capped = !showAll && filtered.length > POOL_ROW_CAP;
  const visible = capped ? filtered.slice(0, POOL_ROW_CAP) : filtered;
  const columns: Array<Column<PoolView>> = [
    {
      key: 'seller',
      label: 'Seller',
      render: (p) => {
        const name = p.profile?.name?.trim() || 'Unnamed seller';
        return <button type="button" className="pool-details-trigger" aria-label={`View ${name} overview`} aria-haspopup="dialog" onClick={event => { event.stopPropagation(); onOpen(p); }}>{name}</button>;
      },
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
        {stakeablePools.length > 5 ? (
          <Input label="" mono={false} width="md" placeholder="Filter by name or agent id" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter pools" />
        ) : null}
        <span className="muted small">
          {needle ? `${formatInt(filtered.length)} of ` : ''}{formatInt(stakeablePools.length)} {stakeablePools.length === 1 ? 'seller' : 'sellers'}
        </span>
      </div>
      {stakeablePools.some(pool => pool.displaySource?.error) ? <p className="hint">Some Antscan statistics are unavailable or may lag. Missing historical yield is shown as —; open a provider for details.</p> : null}
      <Table
        columns={columns}
        rows={visible}
        rowKey={(p) => p.agentId}
        loading={loading}
        onRowClick={onOpen}
        empty={needle ? `No seller matches "${needle}" in this view.` : 'No sellers are ready for staking yet.'}
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

export function PoolDrawer({ pool: initialPool, view, onClose }: { pool: PoolView; view: PoolsView; onClose: () => void }) {
  const detail = usePageData(`pool:${initialPool.agentId}`, () => api.pool(initialPool.agentId));
  const pool = detail.data ?? initialPool;
  const historyRefreshFailed = !!detail.error || (!!detail.data && detail.data.volumeStatus !== 'available');
  const history = historyRefreshFailed && initialPool.volumeStatus === 'available' ? initialPool : pool;
  const historyEpoch = history === initialPool ? view.currentEpoch : detail.data?.currentEpoch ?? view.currentEpoch;
  const profile = pool.profile;
  const explorerUrl = view.explorer && pool.seller ? `${view.explorer.replace(/\/$/, '')}/account/${pool.seller}` : null;
  const latest = history.volumes.find(volume => volume.epoch === historyEpoch - 1);

  return (
    <Modal isOpen onClose={onClose} size="lg" overlayClassName="ants-stake-overlay ants-pool-overlay" className="pool-overview" title={poolName(pool)} eyebrow="PROVIDER OVERVIEW" subtitle={<>
      Agent <span className="mono">{pool.agentId}</span> · {pool.seller ? <AddressLink value={pool.seller} copy /> : 'No seller bound'}
      {explorerUrl ? <> · <a href={explorerUrl} target="_blank" rel="noreferrer">View on Antscan ↗</a></> : null}
    </>}>
      <div className="pool-overview-status"><Pill tone={pool.stakeable ? 'accent' : 'muted'}>{pool.hasPool ? 'Staking pool' : 'No pool yet'}</Pill><span>Provider activity &amp; pool analytics</span></div>
      {pool.displaySource?.source === 'indexer' ? <p className="hint">Antscan snapshot indexed through block {pool.displaySource.indexedBlock}.</p> : null}
      {pool.displaySource?.error ? <p className="hint">Antscan: {pool.displaySource.error}{pool.yield?.status === 'unavailable' ? ' Historical yield is unavailable.' : ''}</p> : null}
      {pool.openPositions !== undefined ? <p className="hint">{pool.openPositions} open positions{pool.totalPositions !== undefined ? ` · ${pool.totalPositions} total positions` : ''}{pool.stakers != null ? ` · ${pool.stakers} stakers` : ''}</p> : null}
      <div className="pool-metrics">
        <div><span className="tile-label">Total active stake</span><strong>{formatAnts(pool.activeStake)} <small>ANTS</small></strong></div>
        <div><span className="tile-label">Last epoch volume</span><strong>{latest && history.volumeStatus === 'available' ? formatUsdcCompact(latest.usdc) : '—'} <small>USDC</small></strong></div>
        <div><span className="tile-label">Pool power share</span><strong>{formatBps(pool.powerShareBps)}</strong><span className="small muted">Share of staking power, not volume</span></div>
      </div>
      <section className="pool-apy-section" aria-label="Estimated APY by lock">
        <div className="pool-section-heading"><h3>Estimated APY by lock</h3></div>
        <PoolApyEstimates pool={pool} />
      </section>
      <section className="pool-section">
        <div className="pool-section-heading"><h3>Seller settled volume · completed epochs</h3><span className="small muted">Includes legacy seller activity.</span></div>
        {historyRefreshFailed && history === initialPool && history.volumeStatus === 'available' && <p className="hint">Seller history could not refresh. Showing previously loaded history.</p>}
        {history.volumeStatus !== 'available' && <p className="hint">Settlement volume {history.volumeStatus === 'stale' ? 'is stale' : 'is unavailable'}. Usage points are not revenue.</p>}
        <PoolActivity volumes={history.volumes} networkVolumes={view.networkVolumes} currentEpoch={historyEpoch} />
        {history.statsUpdatedAt && <p className="small muted">History fetched {formatUtc(Math.floor(history.statsUpdatedAt / 1000))}</p>}
      </section>
      <section className="pool-section">
        <div className="pool-section-heading"><h3>Seller profile · lifetime activity</h3><span className="small muted">Antscan indexed totals</span></div>
        {profile?.stale && <p className="hint">Seller activity is stale; the indexer could not refresh.</p>}
        {profile ? <div className="pool-lifetime">
          <div><span className="tile-label">Settled volume</span><strong>{profile.lifetimeVolumeUsdc != null ? `${formatUsdcCompact(profile.lifetimeVolumeUsdc)} USDC` : '—'}</strong></div>
          <div><span className="tile-label">Requests</span><strong>{profile.requestCount != null ? formatInt(profile.requestCount) : '—'}</strong></div>
          <div><span className="tile-label">Unique buyers</span><strong>{profile.uniqueBuyers != null ? formatInt(profile.uniqueBuyers) : '—'}</strong></div>
          <div><span className="tile-label">Models served</span><strong>{profile.modelsServed != null ? formatInt(profile.modelsServed) : '—'}</strong></div>
        </div> : <p className="hint">The explorer has no record for this seller.</p>}
        <Facts items={[
          ['Providers', profile?.providers.length ? profile.providers.join(', ') : '—'],
          ['Last epoch emission', pool.lastEpochEmission != null ? `${formatAnts(pool.lastEpochEmission, 4)} ANTS` : '—'],
          ['Ghost rate', profile?.ghostRate != null && Number.isFinite(profile.ghostRate) && profile.ghostRate >= 0 && profile.ghostRate <= 100 ? `${profile.ghostRate.toFixed(1)}%` : 'Unavailable'],
          ['Last settled', profile?.lastSettledAt != null ? formatUtc(profile.lastSettledAt) : '—'],
        ]} />
        {profile?.fetchedAt && <p className="small muted">Profile fetched {formatUtc(Math.floor(profile.fetchedAt / 1000))}</p>}
      </section>
      <SellerModels address={pool.seller} />
    </Modal>
  );
}

function PoolApyEstimates({ pool }: { pool: PoolView }) {
  return <dl className="pool-apy-estimates">
    {poolApyEstimates(pool.yield).map(period => <div key={period.label} title={period.status === 'unsupported'
      ? `${period.label} is not supported by this pool's whole-epoch lock limits.`
      : period.apy === null ? 'APY is unavailable because reward or epoch data is missing.'
        : `10,000 ANTS reference stake. ${period.epochs} epoch(s), ${period.actualDays} days. Annualized initial earning rate with hypothetical compounding; not the return over this lock. APY above 10,000% is shown as ${EXTREME_YIELD_LABEL}. Source epoch ${pool.yield!.epoch}.${pool.yield?.status === 'estimated' ? ' Rewards are not yet settled.' : ''}`}>
      <dt>{period.label}</dt><dd>{period.status === 'unsupported' ? <span className="pool-apy-unavailable">Unsupported</span> : <>{percent(period.apy)}{period.apy !== null && period.apy <= YIELD_DISPLAY_LIMIT && pool.yield?.status === 'estimated' ? <span className="dim small"> est.</span> : null}</>}</dd>
    </div>)}
  </dl>;
}

function yieldDescription(pool: PoolView): string {
  const info = pool.yield;
  if (!info || info.status === 'unavailable') return 'Last-epoch yield is unavailable.';
  const range = poolApyRange(info);
  const duration = info.endsAt - info.startsAt;
  const lockLabel = (epochs: number | null) => epochs === null ? 'unavailable' : `${epochs} epoch(s), ${epochs * duration / 86400} days`;
  return `10,000 ANTS reference stake. 1 week: ${lockLabel(range.oneWeek.epochs)}; 2 years: ${lockLabel(range.twoYears.epochs)}. Source epoch ${info.epoch}: ${formatUtc(info.startsAt)} – ${formatUtc(info.endsAt)}. Initial earning rates include the reference stake's added power and assume an unchanged pool reward budget. APY assumes the rates repeat and compound every epoch; compounding is not automatic. Power decreases as the lock runs down, activation delays are excluded, and future activity changes returns. Missing data or unsupported locks show —.${info.status === 'estimated' ? ' Rewards are estimated until settled.' : ''}`;
}

function PoolApy({ pool }: { pool: PoolView }) {
  const { oneWeek, twoYears } = poolApyRange(pool.yield);
  const available = oneWeek.apy !== null || twoYears.apy !== null;
  const extreme = (oneWeek.apy ?? 0) > YIELD_DISPLAY_LIMIT || (twoYears.apy ?? 0) > YIELD_DISPLAY_LIMIT;
  const low = percent(oneWeek.apy), high = percent(twoYears.apy);
  return <span className="yield-percent" title={`${yieldDescription(pool)}${extreme ? ` ${EXTREME_YIELD_NOTE}` : ''}`}>
    {extreme ? EXTREME_YIELD_LABEL : available ? `${low} – ${high}` : '—'}
    {available && !extreme && pool.yield?.status === 'estimated' ? <span className="dim small"> est.</span> : null}
  </span>;
}
