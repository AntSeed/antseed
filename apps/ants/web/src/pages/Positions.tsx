import { useMemo } from 'react';
import { api } from '../api';
import { useConfig } from '../app-context';
import { ErrorBox } from '../components/Feedback';
import { sortPools } from '../components/Pools';
import { PositionsCard } from '../components/Positions';
import { StatTile, Tiles } from '../components/StatTile';
import { usePageData } from '../data';
import { formatAnts, formatBps, formatInt, toBigInt } from '../format';
import { href } from '../router';
import { isHostedDisconnected } from '../runtime';
import { BuyerWalletAction } from '../wallet';
import { Panel } from '../components/Panel';

/** Your wallet: stake, power and rewards at a glance, then every position with its actions. */
export function PositionsPage() {
  const config = useConfig();
  const disconnected = isHostedDisconnected(config);
  const walletReady = !config.browserWallet || !config.readOnly;
  const overview = usePageData(disconnected ? null : 'overview', api.overview);
  const rewards = usePageData(disconnected ? null : 'rewards', api.rewards, 5 * 60_000);
  const pools = usePageData(disconnected ? null : 'pools', api.pools, 5 * 60_000);
  const sortedPools = useMemo(() => sortPools(pools.data?.pools ?? []), [pools.data]);
  const data = overview.data;
  const canTransfer = data?.wallet.canTransfer ?? false;
  const pending = toBigInt(pools.data?.yourPendingStake ?? null) ?? 0n;

  if (disconnected) return <Panel title="My positions"><p>Connect your wallet to view and manage your staking positions. Adding a buyer account is optional.</p><BuyerWalletAction /></Panel>;

  return (
    <>
      <h1 className="page-title">My positions</h1>
      {overview.error && !data ? <ErrorBox error={overview.error} onRetry={overview.refresh} /> : null}
      <Tiles>
        <StatTile
          label="Your total staked"
          value={data ? formatAnts(data.wallet.totalActiveStake) : '…'}
          unit="ANTS"
          loading={!data}
          sub={data ? <>
            {formatInt(data.wallet.positionCount)} position{data.wallet.positionCount === 1 ? '' : 's'}
            {pending > 0n ? <> · <span className="pending-amount">{formatAnts(pending)} ANTS pending activation</span></> : null}
          </> : undefined}
        />
        <StatTile
          label="Your power"
          value={pools.data ? formatAnts(pools.data.yourTotalPower) : pools.error ? '—' : '…'}
          loading={pools.loading && !pools.data}
          sub={pools.data ? `${formatBps(pools.data.yourNetworkShareBps)} of all pools` : pools.error ? <span className="danger">{pools.error}</span> : 'scanning pools…'}
        />
        <StatTile
          label={walletReady ? 'Claimable rewards' : 'Buyer rewards'}
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
              <a href={href('rewards')}>{walletReady ? 'Stake rewards or claim →' : 'View buyer rewards →'}</a>
            ) : (
              'loading from chain…'
            )
          }
        />
        <StatTile
          label="Wallet balance"
          value={data ? formatAnts(data.wallet.ants, 4) : '…'}
          unit="ANTS"
          loading={!data}
          sub={data ? (canTransfer ? 'transfers enabled · stakeable' : 'transfers not enabled · stake from rewards') : undefined}
        />
      </Tiles>
      <PositionsCard pools={sortedPools} enabled={walletReady} />
    </>
  );
}
