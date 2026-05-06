import { useState } from 'react';
import type { HistoryRange, StatsNetworkResponse } from '../api';
import {
  formatAbsoluteLocalTime,
  formatLargeNumber,
  formatRelative,
  formatSeconds,
  formatUsd,
  SectionHead,
  StatCard,
} from '../utils';
import { ChainSyncCard } from './ChainSyncCard';
import { HistoryChart } from './HistoryChart';
import { Histogram } from './Histogram';
import { TokensChart } from './TokensChart';

export function NetworkOverview({
  data,
  now,
  updatedAtMs,
  hasUpdate,
  indexerDegraded,
}: {
  data: StatsNetworkResponse;
  now: number;
  updatedAtMs: number | null;
  hasUpdate: boolean;
  indexerDegraded: boolean;
}) {
  // Shared range so the two charts stay in sync; react-query dedupes the
  // ['history', range] key, so a single fetch covers both.
  const [historyRange, setHistoryRange] = useState<HistoryRange>('7d');

  return (
    <>
      <section className="dashboard-section">
        <SectionHead
          title="Network"
          sub="Live peer count and lifetime totals from the chain."
        />
        <div className="stat-grid">
          <StatCard
            label="Active peers"
            value={data.network.peerCount}
            hint="Nodes currently announced in the DHT."
            accent
          />
          <StatCard
            label="Sellers on-chain"
            value={data.totals ? formatLargeNumber(data.totals.sellerCount) : '—'}
            hint="Registered identities ever observed."
          />
          <StatCard
            label="Lifetime settlements"
            value={data.totals ? formatLargeNumber(data.totals.settlementCount) : '—'}
            hint="Payment-channel close events recorded on-chain."
          />
          <StatCard
            label="Last refresh"
            value={hasUpdate ? formatRelative(updatedAtMs, now) : '—'}
            hint={hasUpdate ? formatAbsoluteLocalTime(updatedAtMs) : 'No poll yet'}
          />
        </div>
      </section>

      <section className="dashboard-section">
        <SectionHead
          title="Activity Peers"
          sub="Active peers (live network gauge) alongside requests served per bucket."
        />
        <HistoryChart
          range={historyRange}
          onRangeChange={setHistoryRange}
          backfill={data.backfill ?? null}
          now={now}
        />
      </section>

      <section className="dashboard-section">
        <SectionHead
          title="Tokens served"
          sub="Total tokens (input + output) flowing through the network per bucket."
        />
        <TokensChart
          range={historyRange}
          onRangeChange={setHistoryRange}
          backfill={data.backfill ?? null}
          now={now}
        />
      </section>

      {data.totals && (
        <section className="dashboard-section">
          <SectionHead
            title="Lifetime totals"
            sub="Cumulative on-chain counts across all peers since genesis."
          />
          <div className="stat-grid stat-grid--3">
            <StatCard
              label="Requests served"
              value={formatLargeNumber(data.totals.totalRequests)}
              hint="Cumulative on-chain count."
            />
            <StatCard
              label="Input tokens"
              value={formatLargeNumber(data.totals.totalInputTokens)}
              hint="Sent into models, all peers."
            />
            <StatCard
              label="Output tokens"
              value={formatLargeNumber(data.totals.totalOutputTokens)}
              hint="Generated back to buyers."
            />
          </div>
        </section>
      )}

      {data.indexer && (
        <section className="dashboard-section">
          <SectionHead
            title="Chain reader"
            sub="The indexer that turns on-chain events into the numbers above. How far behind the chain head it is right now."
          />
          <ChainSyncCard
            indexer={data.indexer}
            indexerDegraded={indexerDegraded}
            now={now}
          />
        </section>
      )}

      {data.network && (
        <>
          <section className="dashboard-section">
            <SectionHead
              title="Stake"
              sub="USDC each peer has locked into the protocol — more stake means more to lose for misbehaviour."
            />
            {data.network.stake ? (
              <div className="stat-grid">
                <StatCard
                  label="Locked total"
                  value={formatUsd(data.network.stake.totalUsdc)}
                  hint="Sum across every peer that reports stake."
                  accent
                />
                <StatCard
                  label="Median peer"
                  value={formatUsd(data.network.stake.medianUsdc)}
                  hint="Half the peers stake more, half less."
                />
                <StatCard
                  label="Top 5%"
                  value={formatUsd(data.network.stake.p95Usdc)}
                  hint="Only 1 in 20 peers stake more than this."
                />
                <StatCard
                  label="Peers staked"
                  value={String(data.network.stake.peersWithStake)}
                  hint="How many peers have any stake on-chain."
                />
              </div>
            ) : (
              <div className="card empty-cell">No peers report stake yet.</div>
            )}
          </section>

          <section className="dashboard-section">
            <SectionHead
              title="Peer freshness"
              sub="Peers re-announce themselves to the DHT on a schedule. These four numbers describe how recently we heard from each one."
            />
            {data.network.freshness ? (
              <div className="stat-grid">
                <StatCard
                  label="Most recent"
                  value={formatSeconds(data.network.freshness.newestAgeSeconds)}
                  hint="The freshest peer announced this long ago."
                  accent
                />
                <StatCard
                  label="Half within"
                  value={formatSeconds(data.network.freshness.medianAgeSeconds)}
                  hint="50% of peers checked in within this window."
                />
                <StatCard
                  label="95% within"
                  value={formatSeconds(data.network.freshness.p95AgeSeconds)}
                  hint="Only 1 in 20 peers is staler than this."
                />
                <StatCard
                  label="Stalest"
                  value={formatSeconds(data.network.freshness.oldestAgeSeconds)}
                  hint="The oldest record we still hold for any peer."
                />
              </div>
            ) : (
              <div className="card empty-cell">No usable timestamps yet.</div>
            )}
          </section>

          <section className="dashboard-section">
            <SectionHead
              title="Service distribution"
              sub="The shape of the network right now — which AI services peers offer, grouped both finely and by family."
            />
            <div className="histogram-grid">
              <Histogram
                title="Services"
                caption="Each AI service advertised by at least one peer (e.g. chat, embed)."
                data={data.network.serviceCounts}
              />
              <Histogram
                title="Categories"
                caption="Higher-level service families peers participate in (coding, TEE, …)."
                data={data.network.serviceCategoryCounts}
              />
            </div>
          </section>
        </>
      )}
    </>
  );
}
