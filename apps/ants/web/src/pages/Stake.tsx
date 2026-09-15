import { Alert, Button } from '../components/ui';
import { useMemo, useState } from 'react';
import type { OverviewView, PoolView } from '../../../src/api-types';
import { api } from '../api';
import { ErrorBox, Skeleton } from '../components/Feedback';
import { Panel } from '../components/Panel';
import { PoolDrawer, PoolsTable, sortPools } from '../components/Pools';
import { PositionsCard } from '../components/Positions';
import { StakeForm } from '../components/StakeForm';
import { StatTile, Tiles } from '../components/StatTile';
import { usePageData } from '../data';
import { epochStartAt, formatAnts, formatBps, formatDuration, formatInt, formatUtc } from '../format';
import { useNow } from '../hooks';
import { href } from '../router';

export function StakePage() {
  // Fetch order matters: the server runs views one at a time, so the cheap ones go first.
  const overview = usePageData('overview', api.overview);
  const positions = usePageData('positions:current', api.positions);
  const rewards = usePageData('rewards', api.rewards, 5 * 60_000);
  const pools = usePageData('pools', api.pools, 5 * 60_000);
  const now = useNow(1000);
  const data = overview.data;

  /** undefined = form closed; null = open with no preselected pool; number = preselected pool. */
  const [stakeTarget, setStakeTarget] = useState<number | null | undefined>(undefined);
  const [openPoolId, setOpenPoolId] = useState<number | null>(null);
  const sortedPools = useMemo(() => sortPools(pools.data?.pools ?? []), [pools.data]);
  const openPool = openPoolId !== null ? (sortedPools.find((p) => p.agentId === openPoolId) ?? null) : null;
  const stakeInto = (pool: PoolView) => {
    setOpenPoolId(null);
    setStakeTarget(pool.agentId);
  };

  return (
    <>
      {overview.error && !data ? <ErrorBox error={overview.error} onRetry={overview.refresh} /> : null}
      {overview.error && data ? <div className="status-line">Refresh failed: {overview.error}</div> : null}
      {!data && overview.loading ? <Skeleton rows={4} /> : null}
      {data ? <PhaseBanner data={data} now={now} /> : null}
      {data && data.notices.length > 0 ? (
        <Alert tone="info">
          <ul className="notices-list">
            {data.notices.map((notice, i) => (
              <li key={i}>{notice}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <Tiles>
        <StatTile
          label="ANTS balance"
          value={data ? formatAnts(data.wallet.ants, 4) : '…'}
          unit="ANTS"
          loading={!data}
          sub={data ? (data.wallet.transfersEnabled ? 'transfers enabled' : data.wallet.whitelisted ? 'transfers off · whitelisted' : 'transfers off') : undefined}
        />
        <StatTile
          label="Your active stake"
          value={data ? formatAnts(data.wallet.totalActiveStake) : '…'}
          unit="ANTS"
          loading={!data}
          sub={data ? `${formatInt(data.wallet.positionCount)} position${data.wallet.positionCount === 1 ? '' : 's'}` : undefined}
        />
        <StatTile
          label="Your power"
          value={pools.data ? formatAnts(pools.data.yourTotalPower) : pools.error ? '—' : '…'}
          loading={pools.loading && !pools.data}
          sub={pools.data ? `${formatBps(pools.data.yourNetworkShareBps)} of all pools` : pools.error ? <span className="danger">{pools.error}</span> : 'scanning pools…'}
        />
        <StatTile
          label="Claimable rewards"
          value={rewards.data ? formatAnts(rewards.data.total) : rewards.error ? '—' : '…'}
          unit="ANTS"
          loading={rewards.loading && !rewards.data}
          sub={
            rewards.error ? (
              <span className="danger">
                {rewards.error}{' '}
                <button className="link-button" onClick={rewards.refresh} type="button">
                  retry
                </button>
              </span>
            ) : rewards.data ? (
              <a href={href('rewards')}>Restake or claim →</a>
            ) : (
              'loading from chain…'
            )
          }
        />
      </Tiles>

      <Panel
        title="Pools"
        className="pools-card"
        actions={
          <Button variant="primary" size="sm" onClick={() => setStakeTarget((cur) => (cur === undefined ? null : undefined))} disabled={!pools.data}>
            {stakeTarget === undefined ? 'Stake ANTS' : 'Close'}
          </Button>
        }
      >
        {pools.error && !pools.data ? <ErrorBox error={pools.error} onRetry={pools.refresh} /> : null}
        {pools.error && pools.data ? <div className="status-line">Refresh failed: {pools.error}</div> : null}
        {stakeTarget !== undefined && pools.data ? (
          <Panel tone="accent" className="panel-inset" title="Stake ANTS">
            {positions.error && !positions.data ? <ErrorBox error={positions.error} onRetry={positions.refresh} /> : null}
            <StakeForm
              key={stakeTarget ?? 'any'}
              config={positions.data?.config ?? null}
              pools={sortedPools.filter((p) => p.stakeable)}
              balance={data?.wallet.ants}
              defaultAgentId={stakeTarget}
              onStarted={() => setStakeTarget(undefined)}
              onClose={() => setStakeTarget(undefined)}
            />
          </Panel>
        ) : null}
        {!pools.data && pools.loading ? <div className="muted small mb">Loading pool statistics from the explorer…</div> : null}
        {pools.data?.source === 'chain' ? (
          <div className="status-line">
            Pool statistics are unavailable{pools.data.sourceError ? ` (${pools.data.sourceError})` : ' (no explorer configured)'}; only pools you stake in are listed, read live from the chain.
          </div>
        ) : null}
        <PoolsTable pools={sortedPools} loading={pools.loading && !pools.data} onOpen={(p) => setOpenPoolId(p.agentId)} onStake={stakeInto} />
        <div className="hint">Sorted by reward per 1k power (last epoch), then by power. Click a row for the seller profile and volume history.</div>
      </Panel>

      <PositionsCard pools={sortedPools} />
      {openPool && pools.data ? <PoolDrawer pool={openPool} view={pools.data} onClose={() => setOpenPoolId(null)} onStake={stakeInto} /> : null}
    </>
  );
}

function PhaseBanner({ data, now }: { data: OverviewView; now: number }) {
  const { phase, epoch } = data;
  if (phase === 'legacy') {
    return (
      <Alert tone="info" title="Legacy protocol">
        The recognized-usage stack (M001) is not deployed on this chain. Pool staking, usage rewards and emissions views are unavailable.
      </Alert>
    );
  }
  if (phase === 'deployed' && epoch.effective !== null) {
    const activatesAt = epochStartAt(epoch.effective, epoch.genesis, epoch.epochDuration);
    const secondsLeft = Math.max(0, Math.floor(activatesAt - now / 1000));
    return (
      <Alert tone="warning" title="Deployed, not active yet">
        Recognized usage activates at epoch <span className="mono">{epoch.effective}</span> ({formatUtc(activatesAt)}) — in <span className="mono">{formatDuration(secondsLeft)}</span>.
        Positions staked now become active from the effective epoch.
      </Alert>
    );
  }
  return (
    <Alert tone="success" title="Active">
      Recognized usage has been live since epoch <span className="mono">{epoch.effective ?? '—'}</span>. Rewards accrue per epoch and can be claimed after each boundary.
    </Alert>
  );
}
