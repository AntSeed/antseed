import type { ReactNode } from 'react';
import type { EmissionsView, MinterView, NetworkSummary } from '../../../src/api-types';
import { api } from '../api';
import { useApp } from '../app-context';
import { usePageData } from '../data';
import { epochStartAt, formatAnts, formatEpochLength, formatInt, formatShare, formatUsdcCompact, formatUtc, formatUtcDate, toBigInt } from '../format';
import { AddressLink } from './AddressLink';
import { Details } from './Details';
import { ErrorBox, Skeleton } from './Feedback';
import { Facts, Panel } from './Panel';
import { Table, type Column } from './Table';

/** Where this epoch's emission goes: the gate's bucket ceilings and what the reward contracts actually allocate. */
export function EmissionsSection() {
  const { overview } = useApp();
  const page = usePageData('emissions', api.emissions, 5 * 60_000);
  const data = page.data;
  return (
    <>
      {page.error && !data ? <ErrorBox error={page.error} onRetry={page.refresh} /> : null}
      {page.error && data ? <div className="status-line">Refresh failed: {page.error}</div> : null}
      {!data && page.loading ? <Skeleton rows={5} /> : null}
      {data ? <EmissionsBody data={data} network={overview?.network ?? null} /> : null}
    </>
  );
}

interface BudgetRow {
  key: string;
  bucket: ReactNode;
  /** Fixed share of the epoch emission the gate reserves for this bucket. */
  shareBps: number | null;
  ceiling: bigint | null;
  /** What the bucket's contract allocates this epoch; null when it cannot be read. */
  allocated: bigint | null;
  rule: ReactNode;
  sub?: boolean;
}

const percentOf = (part: bigint, whole: bigint | null): string => (whole && whole > 0n ? `${(Number((part * 10_000n) / whole) / 100).toFixed(2)}%` : '—');

/**
 * Rows of the budget table. The gate fixes each bucket's ceiling; the seller-pools
 * and usage contracts then allocate a dynamic share of the emission inside that
 * ceiling, and whatever they do not allocate is settled to burn or reserve.
 */
export function budgetRows(data: EmissionsView, network: NetworkSummary | null): BudgetRow[] {
  const emission = toBigInt(network?.epochEmission ?? null) ?? bucketTotal(data.minters);
  const denominator = data.shareDenominator;
  const rows: BudgetRow[] = [];
  const minter = (name: string) => data.minters.find((m) => m.name === name) ?? null;
  const ceilingOf = (m: MinterView | null) => (m ? toBigInt(m.epochBudget) : null);

  const stakers = minter('seller-pools');
  const stakerBudget = toBigInt(network?.stakerBudget ?? null);
  const stake = toBigInt(network?.totalActiveStake ?? null);
  const stakerConfig = data.dynamicStaker;
  const initial = toBigInt(data.initialEmission) ?? 0n;
  const stakeTarget = stakerConfig && emission && initial > 0n ? (BigInt(stakerConfig.stakeShareTarget) * emission) / initial : null;
  rows.push({
    key: 'stakers',
    bucket: <>Seller pools <span className="muted">· stakers</span></>,
    shareBps: stakers?.shareBps ?? null,
    ceiling: ceilingOf(stakers),
    allocated: stakerBudget,
    rule: stakerConfig ? (
      <>
        {formatShare(stakerConfig.minShareBps, denominator)} – {formatShare(stakerConfig.maxShareBps, denominator)} of the emission, rising with active stake:
        {' '}<span className="mono">{stake !== null ? formatAnts(stake, 0) : '—'}</span> of a <span className="mono">{stakeTarget !== null ? formatAnts(stakeTarget, 0) : '—'}</span> ANTS target
      </>
    ) : 'Dynamic staker share not configured.',
  });

  const usage = minter('usage');
  const buyerBudget = toBigInt(network?.usageBuyerBudget ?? null);
  const sellerBudget = toBigInt(network?.usageSellerBudget ?? null);
  const usageConfig = data.dynamicUsage;
  const volume = toBigInt(data.epochVolumeUsdc);
  rows.push({
    key: 'usage',
    bucket: <>Usage <span className="muted">· buyers + sellers</span></>,
    shareBps: usage?.shareBps ?? null,
    ceiling: ceilingOf(usage),
    allocated: buyerBudget !== null && sellerBudget !== null ? buyerBudget + sellerBudget : null,
    rule: usageConfig ? (
      <>
        Each side {formatShare(usageConfig.buyerMinShareBps, denominator)} – {formatShare(usageConfig.buyerMaxShareBps, denominator)} of the emission, rising with settled volume:
        {' '}<span className="mono">{volume !== null ? formatUsdcCompact(volume) : '—'}</span> of a <span className="mono">{formatUsdcCompact(usageConfig.volumeShareTarget)}</span> USDC target this epoch
      </>
    ) : 'Dynamic usage shares not configured.',
  });
  rows.push({ key: 'buyers', bucket: 'Buyers', shareBps: null, ceiling: null, allocated: buyerBudget, rule: 'Split by weighted buyer points', sub: true });
  rows.push({ key: 'sellers', bucket: 'Sellers', shareBps: null, ceiling: null, allocated: sellerBudget, rule: 'Split by weighted seller points', sub: true });

  for (const name of ['team', 'reserve', 'verification']) {
    const m = minter(name);
    if (!m) continue;
    rows.push({ key: name, bucket: name[0]!.toUpperCase() + name.slice(1), shareBps: m.shareBps, ceiling: ceilingOf(m), allocated: ceilingOf(m), rule: 'Fixed share, minted by its controller' });
  }

  const dynamic = rows.filter((row) => row.key === 'stakers' || row.key === 'usage');
  if (dynamic.every((row) => row.ceiling !== null && row.allocated !== null)) {
    const unallocated = dynamic.reduce((sum, row) => sum + (row.ceiling! - row.allocated!), 0n);
    rows.push({ key: 'unallocated', bucket: 'Unallocated', shareBps: null, ceiling: null, allocated: unallocated, rule: 'Ceiling minus allocation of the dynamic buckets; burned or sent to the reserve when the epoch is settled' });
  }
  return rows;
}

function bucketTotal(minters: MinterView[]): bigint | null {
  if (minters.length === 0) return null;
  return minters.reduce((sum, m) => sum + (toBigInt(m.epochBudget) ?? 0n), 0n);
}

function EmissionsBody({ data, network }: { data: EmissionsView; network: NetworkSummary | null }) {
  const emission = toBigInt(network?.epochEmission ?? null) ?? bucketTotal(data.minters);
  const rows = budgetRows(data, network);
  const nextHalvingEpoch = (Math.floor(data.currentEpoch / data.halvingInterval) + 1) * data.halvingInterval;
  const columns: Array<Column<BudgetRow>> = [
    { key: 'bucket', label: 'Bucket', render: (r) => <span className={r.sub ? 'muted' : undefined} style={r.sub ? { paddingLeft: 18 } : undefined}>{r.bucket}</span> },
    { key: 'share', label: 'Gate share', align: 'right', mono: true, title: 'Fixed fraction of the epoch emission reserved for this bucket.', render: (r) => (r.shareBps === null ? '' : formatShare(r.shareBps, data.shareDenominator)) },
    { key: 'ceiling', label: 'Ceiling · ANTS', align: 'right', mono: true, render: (r) => (r.ceiling === null ? '' : formatAnts(r.ceiling, 0)) },
    { key: 'allocated', label: 'Allocated now · ANTS', align: 'right', mono: true, title: 'What the bucket’s contract allocates this epoch from its live figures.', render: (r) => (r.allocated === null ? <span className="dim">—</span> : <span className="cell-stack">{formatAnts(r.allocated, 0)}<span className="cell-sub">{r.key === 'unallocated' || r.sub ? percentOf(r.allocated, emission) : percentOf(r.allocated, emission) + ' of emission'}</span></span>) },
    { key: 'rule', label: 'How it is set', render: (r) => <span className="small muted">{r.rule}</span> },
  ];

  return (
    <Panel title="Emissions">
      <Facts
        items={[
          [`Epoch ${data.currentEpoch} emission`, `${emission !== null ? formatAnts(emission, 0) : '—'} ANTS (${formatAnts(data.currentRate, 6)} ANTS / s)`],
          ['Halving', `every ${formatInt(data.halvingInterval)} epochs · next at epoch ${nextHalvingEpoch} (${formatUtcDate(epochStartAt(nextHalvingEpoch, data.genesis, data.epochDuration))})`],
          [`Minted through epoch ${data.currentEpoch}`, `${formatAnts(data.cumulativeThroughCurrent, 0)} ANTS`],
        ]}
      />
      <div className="section-label mt">Where this epoch's emission goes</div>
      <Table columns={columns} rows={rows} rowKey={(r) => r.key} empty="No minters registered on the emissions gate." />
      <p className="hint">Dynamic shares follow min + (max − min) × x ÷ (x + target), where x is the live figure named in the last column. No activity earns nothing, and an allocation never exceeds its bucket's ceiling.</p>
      <Details summary="Details">
        <Facts
          items={[
            ['Genesis', formatUtc(data.genesis)],
            ['Epoch length', `${formatEpochLength(data.epochDuration)} (${formatInt(data.epochDuration)} s)`],
            ['Initial emission', `${formatAnts(data.initialEmission, 0)} ANTS / epoch`],
            ['Share denominator', formatInt(data.shareDenominator)],
            ['Emissions reserve', data.emissionsReserve ? <AddressLink value={data.emissionsReserve} short={false} /> : '—'],
            ['Legacy escrow', data.legacyEscrow ? <AddressLink value={data.legacyEscrow} short={false} /> : '—'],
            ...data.minters.map<[string, ReactNode]>((m) => [
              `Minter ${m.name}`,
              <span>
                id <span className="mono">{m.id}</span> · controller <AddressLink value={m.controller} />
              </span>,
            ]),
          ]}
        />
        {data.legacy ? (
          <>
            <div className="section-label mt">Legacy V2 emissions</div>
            <Facts
              items={[
                ['Contract', <AddressLink value={data.legacy.contract} short={false} />],
                ['Split', `seller ${data.legacy.sellerPct}% · buyer ${data.legacy.buyerPct}% · reserve ${data.legacy.reservePct}% · team ${data.legacy.teamPct}%`],
                ['Legacy epoch', formatInt(data.legacy.currentEpoch)],
              ]}
            />
          </>
        ) : null}
      </Details>
    </Panel>
  );
}
