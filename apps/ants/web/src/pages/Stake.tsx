import { Alert, Button } from '../components/ui';
import { Modal } from '@antseed/ui';
import { useMemo, useRef, useState } from 'react';
import type { OverviewView, PoolView, PoolsView } from '../../../src/api-types';
import { api } from '../api';
import { useConfig } from '../app-context';
import { ErrorBox, Skeleton } from '../components/Feedback';
import { Panel } from '../components/Panel';
import { PoolDrawer, PoolsTable, sortPools } from '../components/Pools';
import { StakeForm } from '../components/StakeForm';
import { usePageData } from '../data';
import { epochStartAt, formatAnts, formatDuration, formatInt, formatUsdcCompact, formatUtc, shortAddress } from '../format';
import { useNow } from '../hooks';

export function StakePage() {
  const config = useConfig();
  const walletReady = !config.browserWallet || !config.readOnly;
  // Buyer rewards are readable before connection; wallet positions are not.
  const overview = usePageData('overview', api.overview);
  const positions = usePageData(walletReady ? 'positions:current' : null, api.positions);
  const rewards = usePageData('rewards', api.rewards, 5 * 60_000);
  const pools = usePageData('pools', api.pools, 5 * 60_000);
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
  const poolTrigger = useRef<HTMLElement | null>(null);
  const closePool = () => {
    setOpenPoolId(null);
    requestAnimationFrame(() => {
      if (poolTrigger.current?.isConnected) poolTrigger.current.focus({ preventScroll: true });
    });
  };
  const sortedPools = useMemo(() => sortPools(pools.data?.pools ?? []), [pools.data]);
  const openPool = openPoolId !== null ? (sortedPools.find((p) => p.agentId === openPoolId) ?? null) : null;
  const openSeller = (pool: PoolView) => {
    poolTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpenPoolId(pool.agentId);
  };
  const closeStake = () => {
    setStakeTarget(undefined);
    requestAnimationFrame(() => {
      const trigger = stakeTrigger.current;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      else document.querySelector<HTMLButtonElement>('[data-stake-trigger]')?.focus({ preventScroll: true });
    });
  };
  const stakePanel = {
    config: positions.data?.config ?? null,
    balance: data?.wallet.ants,
    rewards: rewards.data,
    rewardsError: rewards.error,
    walletReady,
    onStarted: closePool,
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

      {pools.data ? <NetworkTicker view={pools.data} /> : null}

      <Panel
        title="Sellers"
        className="pools-card"
        actions={
          <Button data-stake-trigger variant="primary" size="sm" onClick={(event) => { stakeTrigger.current = event.currentTarget; setStakeTarget(null); }} disabled={!pools.data}>
            Stake rewards
          </Button>
        }
      >
        {pools.error && !pools.data ? <ErrorBox error={pools.error} onRetry={pools.refresh} /> : null}
        {pools.error && pools.data ? <div className="status-line">Refresh failed: {pools.error}</div> : null}
        {pools.data?.source === 'chain' ? (
          <div className="status-line">
            Pool statistics are unavailable{pools.data.sourceError ? ` (${pools.data.sourceError})` : ' (no explorer configured)'}; only pools you stake in are listed, read live from the chain.
          </div>
        ) : null}
        <PoolsTable pools={sortedPools} currentEpoch={pools.data?.currentEpoch ?? 0} loading={pools.loading && !pools.data} onOpen={openSeller} onStake={openSeller} />
      </Panel>

      {stakeTarget !== undefined && pools.data ? (
        <Modal
          isOpen
          title="Stake rewards"
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

      {openPool && pools.data ? <PoolDrawer pool={openPool} view={pools.data} onClose={closePool} stake={stakePanel} /> : null}
    </>
  );
}

/** One hairline strip of network-wide figures so a staker can size a pool against the whole. */
export function NetworkTicker({ view }: { view: PoolsView }) {
  const lastVolume = view.networkVolumes.find((row) => row.epoch === view.currentEpoch - 1);
  const stakeable = view.pools.filter((pool) => pool.stakeable).length;
  return (
    <div className="ticker" role="list" aria-label="Network">
      <div className="ticker-item" role="listitem"><span className="ticker-label">Total staked</span><span className="ticker-value">{formatAnts(view.totalActiveStake)}<small>ANTS</small></span></div>
      <div className="ticker-item" role="listitem"><span className="ticker-label">Total power</span><span className="ticker-value">{formatAnts(view.totalPowerWeight)}</span></div>
      <div className="ticker-item" role="listitem"><span className="ticker-label">Staker budget · epoch</span><span className="ticker-value">{formatAnts(view.stakerBudget)}<small>ANTS</small></span></div>
      <div className="ticker-item" role="listitem"><span className="ticker-label">Network volume · last epoch</span><span className="ticker-value">{lastVolume ? formatUsdcCompact(lastVolume.usdc) : '—'}<small>USDC</small></span></div>
      <div className="ticker-item" role="listitem"><span className="ticker-label">Sellers</span><span className="ticker-value">{formatInt(stakeable)}<small>stakeable</small></span></div>
      <div className="ticker-item" role="listitem"><span className="ticker-label">Epoch</span><span className="ticker-value">{view.currentEpoch}<small>{view.source === 'indexer' ? 'indexed' : 'chain'}</small></span></div>
    </div>
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
