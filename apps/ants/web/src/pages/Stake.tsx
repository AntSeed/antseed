import { Alert, Button } from '../components/ui';
import { Modal } from '@antseed/ui';
import { useMemo, useRef, useState } from 'react';
import type { OverviewView, PoolView } from '../../../src/api-types';
import { api } from '../api';
import { useConfig } from '../app-context';
import { ErrorBox, Skeleton } from '../components/Feedback';
import { Panel } from '../components/Panel';
import { PoolDrawer, PoolsTable, sortPools } from '../components/Pools';
import { PositionsCard } from '../components/Positions';
import { StakeForm } from '../components/StakeForm';
import { StatTile, Tiles } from '../components/StatTile';
import { usePageData } from '../data';
import { epochStartAt, formatAnts, formatBps, formatDuration, formatInt, formatUtc, shortAddress } from '../format';
import { useNow } from '../hooks';
import { href } from '../router';

export function StakePage() {
  const config = useConfig();
  const walletReady = !config.browserWallet || !config.readOnly;
  // Buyer rewards are readable before connection; wallet positions are not.
  const overview = usePageData('overview', api.overview);
  const positions = usePageData(walletReady ? 'positions:current' : null, api.positions);
  const rewards = usePageData('rewards', api.rewards, 5 * 60_000);
  const pools = usePageData('pools', api.pools, 5 * 60_000);
  const counts = usePageData(pools.data?.source === 'indexer' ? 'pool-stakers' : null, api.poolStakers, 5 * 60_000);
  const data = overview.data;
  const buyerOperator = rewards.data?.buyerUsage.operator;
  const wrongBuyerWallet = walletReady && !!buyerOperator && buyerOperator.toLowerCase() !== config.address.toLowerCase()
    && BigInt(rewards.data?.buyerUsage.total ?? '0') > 0n;
  const notices = data?.notices.filter(notice => !notice.startsWith('ANTS transfers are not enabled')) ?? [];

  /** undefined = form closed; null = open with no preselected pool; number = preselected pool. */
  const [stakeTarget, setStakeTarget] = useState<number | null | undefined>(undefined);
  const [stakeBusy, setStakeBusy] = useState(false);
  const stakeTrigger = useRef<HTMLElement | null>(null);
  const [openPoolId, setOpenPoolId] = useState<number | null>(null);
  const sortedPools = useMemo(() => sortPools((pools.data?.pools ?? []).map(pool => ({ ...pool, stakers: counts.data?.[pool.agentId] ?? pool.stakers }))), [pools.data, counts.data]);
  const openPool = openPoolId !== null ? (sortedPools.find((p) => p.agentId === openPoolId) ?? null) : null;
  const stakeInto = (pool: PoolView) => {
    stakeTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpenPoolId(null);
    setStakeTarget(pool.agentId);
  };
  const closeStake = () => {
    setStakeTarget(undefined);
    requestAnimationFrame(() => {
      const trigger = stakeTrigger.current;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      else document.querySelector<HTMLButtonElement>('[data-stake-trigger]')?.focus({ preventScroll: true });
    });
  };

  return (
    <>
      {config.browserWallet && wrongBuyerWallet ? (
        <Alert tone="info" title="Connect your authorized wallet">
          To stake buyer rewards, use the wallet button above to switch to <span className="mono" title={buyerOperator!}>{shortAddress(buyerOperator!)}</span>, the authorized wallet for your buyer account.
        </Alert>
      ) : null}
      {overview.error && !data ? <ErrorBox error={overview.error} onRetry={overview.refresh} /> : null}
      {overview.error && data ? <div className="status-line">Refresh failed: {overview.error}</div> : null}
      {!data && overview.loading ? <Skeleton rows={4} /> : null}
      {data && data.phase !== 'active' ? <PhaseBanner data={data} /> : null}
      {notices.length > 0 ? (
        <Alert tone="info">
          <ul className="notices-list">
            {notices.map((notice, i) => (
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
          label="Your total staked"
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
          label={walletReady ? "Claimable rewards" : "Buyer rewards"}
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
              <a href={href('rewards')}>{walletReady ? 'Restake or claim →' : 'View buyer rewards →'}</a>
            ) : (
              'loading from chain…'
            )
          }
        />
      </Tiles>

      <PositionsCard pools={sortedPools} enabled={walletReady} />

      <Panel
        title="Pools"
        className="pools-card"
        actions={
          <Button data-stake-trigger variant="primary" size="sm" onClick={(event) => { stakeTrigger.current = event.currentTarget; setStakeTarget(null); }} disabled={!pools.data}>
            Stake ANTS
          </Button>
        }
      >
        {pools.error && !pools.data ? <ErrorBox error={pools.error} onRetry={pools.refresh} /> : null}
        {pools.error && pools.data ? <div className="status-line">Refresh failed: {pools.error}</div> : null}
        {!pools.data && pools.loading ? <div className="muted small mb">Loading pool statistics from the explorer…</div> : null}
        {pools.data?.source === 'chain' ? (
          <div className="status-line">
            Pool statistics are unavailable{pools.data.sourceError ? ` (${pools.data.sourceError})` : ' (no explorer configured)'}; only pools you stake in are listed, read live from the chain.
          </div>
        ) : null}
        <PoolsTable pools={sortedPools} loading={pools.loading && !pools.data} onOpen={(p) => setOpenPoolId(p.agentId)} onStake={stakeInto} />
        <div className="hint">Compare projected initial yields for the same amount and lock. APY assumes compounding; actual returns vary. Click a seller for activity and volume history.</div>
      </Panel>

      {stakeTarget !== undefined && pools.data ? (
        <Modal
          isOpen
          title="Stake ANTS"
          size="lg"
          overlayClassName="ants-stake-overlay"
          onClose={() => { if (!stakeBusy) closeStake(); }}
        >
          {positions.error && !positions.data ? <ErrorBox error={positions.error} onRetry={positions.refresh} /> : null}
          <StakeForm
            key={`${config.address}:${config.evmChainId}:${stakeTarget ?? 'any'}`}
            config={positions.data?.config ?? null}
            pools={sortedPools.filter((p) => p.stakeable)}
            balance={data?.wallet.ants}
            rewards={rewards.data}
            rewardsError={rewards.error}
            defaultAgentId={stakeTarget}
            onStarted={closeStake}
            onClose={closeStake}
            onBusyChange={setStakeBusy}
          />
        </Modal>
      ) : null}

      {openPool && pools.data ? <PoolDrawer pool={openPool} view={pools.data} onClose={() => setOpenPoolId(null)} onStake={stakeInto} /> : null}
    </>
  );
}

function PhaseBanner({ data }: { data: OverviewView }) {
  const now = useNow(1000);
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
  return null;
}
