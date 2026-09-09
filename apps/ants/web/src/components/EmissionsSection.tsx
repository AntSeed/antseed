import type { ReactNode } from 'react';
import type { EmissionsView, MinterView } from '../../../src/api-types';
import { api } from '../api';
import { usePageData } from '../data';
import { formatAnts, formatEpochLength, formatInt, formatShare, formatUsdc, formatUtc, toBigInt } from '../format';
import { AddressLink } from './AddressLink';
import { Details } from './Details';
import { ErrorBox, Skeleton } from './Feedback';
import { Facts, Panel } from './Panel';
import { Pill } from './Pill';
import { Table, type Column } from './Table';

/** Emission schedule, minter shares and dynamic bounds. Ids, denominator and legacy split are behind details. */
export function EmissionsSection() {
  const page = usePageData('emissions', api.emissions, 5 * 60_000);
  const data = page.data;
  return (
    <>
      {page.error && !data ? <ErrorBox error={page.error} onRetry={page.refresh} /> : null}
      {page.error && data ? <div className="status-line">Refresh failed: {page.error}</div> : null}
      {!data && page.loading ? <Skeleton rows={5} /> : null}
      {data ? <EmissionsBody data={data} /> : null}
    </>
  );
}

function EmissionsBody({ data }: { data: EmissionsView }) {
  const rate = toBigInt(data.currentRate);
  const perEpoch = rate !== null ? (rate * BigInt(data.epochDuration)).toString() : null;
  const denominator = data.shareDenominator;

  const minterColumns: Array<Column<MinterView>> = [
    { key: 'name', label: 'Bucket', render: (m) => m.name },
    { key: 'share', label: 'Share', align: 'right', mono: true, title: 'share of epoch emission', render: (m) => formatShare(m.shareBps, denominator) },
    { key: 'budget', label: 'This-epoch budget', align: 'right', mono: true, render: (m) => formatAnts(m.epochBudget) },
    { key: 'editable', label: 'Editable', render: (m) => (m.editable ? <Pill tone="accent">yes</Pill> : <Pill tone="muted">fixed</Pill>) },
  ];

  return (
    <>
      <Panel title="Emissions">
        <Facts
          items={[
            ['Current rate', `${formatAnts(data.currentRate, 6)} ANTS / s${perEpoch ? ` (≈ ${formatAnts(perEpoch)} ANTS / epoch)` : ''}`],
            ['Initial emission', `${formatAnts(data.initialEmission)} ANTS / epoch`],
            ['Halving interval', `${formatInt(data.halvingInterval)} epochs`],
            ['Cumulative through epoch ' + data.currentEpoch, `${formatAnts(data.cumulativeThroughCurrent, 0)} ANTS`],
          ]}
        />
        <div className="section-label mt">Minters</div>
        <Table columns={minterColumns} rows={data.minters} rowKey={(m) => m.id} empty="No minters registered on the emissions gate." />
        <Details summary="Details">
          <Facts
            items={[
              ['Genesis', formatUtc(data.genesis)],
              ['Epoch length', `${formatEpochLength(data.epochDuration)} (${formatInt(data.epochDuration)} s)`],
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
          <div className="hint mt">Shares are fractions of the epoch emission (denominator {formatInt(denominator)}). Editable buckets can be re-weighted by their controller.</div>
        </Details>
      </Panel>

      <Panel title="Dynamic shares">
        <div className="row" style={{ gap: 32, alignItems: 'flex-start' }}>
          {data.dynamicStaker ? (
            <Facts
              items={[
                ['Staker share (min – max)', `${formatShare(data.dynamicStaker.minShareBps, denominator)} – ${formatShare(data.dynamicStaker.maxShareBps, denominator)}`],
                ['Stake share target', `${formatAnts(data.dynamicStaker.stakeShareTarget)} ANTS`],
              ]}
            />
          ) : (
            <span className="muted">Dynamic staker share not configured.</span>
          )}
          {data.dynamicUsage ? (
            <Facts
              items={[
                ['Buyer share (min – max)', `${formatShare(data.dynamicUsage.buyerMinShareBps, denominator)} – ${formatShare(data.dynamicUsage.buyerMaxShareBps, denominator)}`],
                ['Seller share (min – max)', `${formatShare(data.dynamicUsage.sellerMinShareBps, denominator)} – ${formatShare(data.dynamicUsage.sellerMaxShareBps, denominator)}`],
                ['Volume share target', `${formatUsdc(data.dynamicUsage.volumeShareTarget)} USDC / epoch`],
              ]}
            />
          ) : (
            <span className="muted">Dynamic usage shares not configured.</span>
          )}
        </div>
      </Panel>
    </>
  );
}
