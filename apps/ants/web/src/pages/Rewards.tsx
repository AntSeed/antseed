import { Button, Card } from '../components/ui';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ClaimRequest, PoolView, RestakeRequest, RewardBucket, RewardsView, StakeUsageRequest } from '../../../src/api-types';
import { request, api } from '../api';
import { BuyerWalletAction } from '../wallet';
import { useConfig, useEpochInfo } from '../app-context';
import { AddressLink } from '../components/AddressLink';
import { ActionButton } from '../components/Confirm';
import { ErrorBox, Skeleton } from '../components/Feedback';
import { Field, Select } from '../components/Field';
import { LockSlider } from '../components/LockSlider';
import { poolLabel, poolName } from '../components/Pools';
import { usePageData } from '../data';
import { formatAnts, isZero, sumBig, toBigInt } from '../format';
import { BuyerStatus } from '../hosted/AccountMenu';

const RewardRefreshContext = createContext({ updating: false, stale: false });

export function RewardsPage() {
  const config = useConfig();
  const disconnected = config.mode === 'hosted' && config.address === '0x0000000000000000000000000000000000000000';
  const page = usePageData(disconnected ? null : 'rewards', api.rewards, 5 * 60_000);
  const data = page.data;
  if (disconnected) return <Card><h2>Your rewards</h2><p>Connect your wallet to view staking and seller rewards, then select a saved buyer account for buyer rewards.</p><BuyerWalletAction /></Card>;
  const updating = !!data && page.loading && page.reconciling;
  const stale = !!data && (page.reconciling || !!page.error);
  return (
    <>
      {page.error && !data ? <ErrorBox error={page.error} onRetry={page.refresh} /> : null}
      {page.error && data && !page.loading ? <ErrorBox title="Rewards could not be refreshed" error={`Shown amounts may be out of date. Retry refreshing before another action. This does not mean a confirmed transaction failed. ${page.error}`} onRetry={page.refresh} /> : null}
      {!data && page.loading ? (
        <>
          <div className="muted small mb">Loading rewards from the blockchain and indexer…</div>
          <Skeleton rows={6} />
        </>
      ) : null}
      {data ? <RewardRefreshContext.Provider value={{ updating, stale }}>
        {config.mode === 'hosted' && !config.buyerAddress ? <Card><h2>Buyer rewards</h2><p>Add a buyer account using the wallet menu. Your staking and seller rewards do not require a buyer account.</p></Card> : <BuyerRewardsCard data={data} />}
        {data.scope !== 'buyer' ? <RewardsBody onRefresh={page.refresh} data={data} /> : null}
      </RewardRefreshContext.Provider> : null}
    </>
  );
}

function RewardRefreshStatus() {
  const { updating, stale } = useContext(RewardRefreshContext);
  if (!stale || updating) return null;
  return <span className="reward-refresh-state">Out of date</span>;
}

function RewardAmount({ children }: { children: ReactNode }) {
  const { updating } = useContext(RewardRefreshContext);
  if (!updating) return <>{children}</>;
  return <span className="skeleton reward-amount-loading" role="status" aria-label="Refreshing amount" aria-busy="true">
    <span aria-hidden="true">{children}</span>
  </span>;
}

function BuyerRewardsCard({ data }: { data: RewardsView }) {
  const dashboard = useConfig();
  const [authorizationError, setAuthorizationError] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const amount = sumBig([data.buyerUsage.total, data.legacy.buyer]);
  const operator = data.buyerUsage.operator;
  const authorized = !!operator && operator.toLowerCase() === dashboard.address.toLowerCase() && !dashboard.readOnly;
  const stakeUnavailable = isZero(data.buyerUsage.total)
    ? 'No current buyer rewards are available to stake yet.'
    : !authorized
      ? 'Connect the authorized buyer wallet to stake these rewards.'
      : !data.buyerUsage.claimable ? 'These buyer rewards are not currently eligible for direct staking.' : null;
  const config = usePageData(authorized && !isZero(data.buyerUsage.total) ? 'positions:current' : null, api.positions);
  const authorize = async () => {
    setAuthorizing(true); setAuthorizationError(null);
    try { await request('/api/wallet/authorize', { method: 'POST' }); }
    catch (error) { setAuthorizationError(error instanceof Error ? error.message : String(error)); }
    finally { setAuthorizing(false); }
  };
  return <Card className="hero">
    <div className="tile-label">Buyer rewards</div>
    <p className="hint">Earned by buyer account <AddressLink value={dashboard.buyerAddress ?? dashboard.address} />.</p>
    {dashboard.mode === 'hosted' && dashboard.buyerAddress && <>{dashboard.buyerLabel && <p>{dashboard.buyerLabel}</p>}<BuyerStatus address={dashboard.buyerAddress} /></>}
    <div className="hero-value"><RewardAmount>{formatAnts(amount, 4)}</RewardAmount><span className="unit">ANTS</span><RewardRefreshStatus /></div>
    {isZero(amount) ? <p className="hero-sub muted">Nothing to claim yet. Rewards accrue at each epoch boundary.</p> : null}
    {!operator ? <p className="hint">Authorize a wallet to claim or stake this buyer’s rewards.</p> : !authorized ? <p className="hint">Connect the authorized wallet <AddressLink value={operator} /> on {dashboard.chainId} to claim or stake.</p> : null}
    <div className="hero-actions">
      {!operator && dashboard.canAuthorize ? <button className="btn" disabled={authorizing} onClick={() => void authorize()}>{authorizing ? 'Opening…' : 'Authorize wallet ↗'}</button> : null}
      {operator && !authorized && dashboard.browserWallet ? <BuyerWalletAction /> : null}
    </div>
    {authorizationError ? <p role="alert" className="hint">{authorizationError}</p> : null}
    <div className="buckets">
      <BucketRow visible name="Current buyer rewards" amount={data.buyerUsage.total}
        note="Earned from using AI services."
        actions={<>
          <ClaimButton bucket="buyer" scope="buyer" amount={data.buyerUsage.total} title="Claim current buyer rewards"
            disabled={!authorized || !data.buyerUsage.claimable} reason="Connect the authorized wallet and check buyer reward eligibility."
            />
          {stakeUnavailable ? <span className="btn-wrap" title={stakeUnavailable}><Button variant="outline" size="sm" disabled>Stake rewards</Button></span>
            : <RestakeButton kind="buyer" data={data} maxEpochs={config.data?.config.maxStakeEpochs ?? null} />}
        </>} />
      <BucketRow visible={!isZero(data.legacy.buyer)} name="Legacy buyer rewards" amount={data.legacy.buyer}
        note="Earned from using AI services under the previous rewards system."
        actions={<ClaimButton bucket="legacy" scope="buyer" amount={data.legacy.buyer} title="Claim legacy buyer rewards"
          disabled={!authorized || !data.legacy.buyerClaimable} reason="Connect the authorized wallet for this buyer account."
          />} />
    </div>
  </Card>;
}

function RewardsBody({ data, onRefresh }: { data: RewardsView; onRefresh: () => void }) {
  const dashboard = useConfig();
  const restakable = data.sellerUsage.claimable ? data.sellerUsage.total : '0';
  const claimableLegacy = data.legacy.seller;
  const sellerTotal = sumBig([data.sellerUsage.total, data.legacy.seller, data.locked.claimable]);
  const otherRewards = sumBig([data.sellerUsage.claimable ? '0' : data.sellerUsage.total, data.legacy.seller, data.locked.claimable]);
  const config = usePageData('positions:current', api.positions);
  const maxEpochs = config.data?.config.maxStakeEpochs ?? null;
  const nothing = isZero(sellerTotal);
  const payout = data.legacy.sellerPayout;
  const payoutKnown = !!payout?.recipient && payout.destination !== 'unknown';
  const payoutLocked = payout?.destination === 'locked';

  return (
    <>
      <Card className="hero" aria-label="Staking rewards">
        {data.historySource === 'chain' ? <p className="status-line status-line--muted">Closed-position history is unavailable (no indexer configured, or the indexer is unreachable). These are known rewards; rewards from closed positions may be missing. Refresh to retry.</p> : null}
        {data.historySource === 'local' ? <p className="status-line status-line--muted">Includes positions from verified local transactions. Older closed positions may be missing without an indexer.</p> : null}
        <div className="tile-label">Staking rewards</div>
        <p className="hint">Earned from staking ANTS in seller pools for <AddressLink value={dashboard.address} />. These are unclaimed rewards, not your wallet balance.</p>
        <div className="hero-value"><RewardAmount>{formatAnts(data.staker.total, 4)}</RewardAmount><span className="unit">ANTS</span><RewardRefreshStatus /></div>
        {isZero(data.staker.total) ? <p className="hero-sub muted">Nothing to claim yet. Rewards accrue at each epoch boundary.</p> : (
          <div className="hero-actions">
            <ClaimButton bucket="staker" amount={data.staker.total} />
            <RestakeButton kind="staker" data={data} maxEpochs={maxEpochs} />
          </div>
        )}
      </Card>

      <Card className="hero" aria-label="Seller rewards">
        <div className="tile-label">Seller rewards</div>
        <p className="hint">Earned from providing AI services for <AddressLink value={dashboard.address} />. These are unclaimed rewards, not your wallet balance.</p>
        <div className="hero-value">
          <RewardAmount>{formatAnts(sellerTotal, 4)}</RewardAmount>
          <span className="unit">ANTS</span>
          <RewardRefreshStatus />
        </div>
        {!nothing ? (
          <div className="hero-sub">
            Available to stake directly <span className="mono"><RewardAmount>{formatAnts(restakable, 4)}</RewardAmount></span> · other rewards <span className="mono"><RewardAmount>{formatAnts(otherRewards, 4)}</RewardAmount></span>
          </div>
        ) : null}
        {nothing ? (
          <div className="hero-sub muted">Nothing to claim yet. Rewards accrue at each epoch boundary.</div>
        ) : null}

      {nothing && isZero(data.locked.locked) ? null : (
        <div className="buckets">
          <BucketRow
            visible={!isZero(data.sellerUsage.total)}
            name="Current seller rewards"
            note="Earned from providing AI services."
            amount={data.sellerUsage.total}
            actions={
              <>
                <ClaimButton bucket="seller" amount={data.sellerUsage.total} disabled={!data.sellerUsage.claimable} reason="Seller usage rewards are not claimable from this wallet." />
                <RestakeButton kind="seller" data={data} maxEpochs={maxEpochs} />
              </>
            }
          />
          <BucketRow
            visible={!isZero(data.legacy.seller)}
            name="Legacy seller rewards"
            note="Earned from providing AI services under the previous rewards system."
            amount={data.legacy.seller}
            actions={<><ClaimButton bucket="legacy" amount={claimableLegacy} title="Claim legacy seller rewards"
              label={!payoutKnown ? 'Claim unavailable' : payoutLocked ? 'Claim not available yet' : 'Claim to wallet'}
              disabled={!payoutKnown || payoutLocked}
              reason={payoutKnown && payoutLocked ? 'Claiming legacy seller rewards into the locked pool is currently unavailable in this dashboard.' : 'Payout destination could not be verified. Refresh rewards before claiming.'}
              expectedLegacySellerRecipient={payout?.recipient ?? undefined}
              />
              {!payoutKnown ? <Button variant="outline" size="sm" onClick={onRefresh}>Refresh rewards</Button> : null}
            </>}
          />
          <BucketRow
            visible={!isZero(data.locked.claimable) || !isZero(data.locked.locked)}
            name="Locked seller rewards"
            note="Past seller rewards held in the locked pool."
            amount={data.locked.claimable}
            amountDetail={`${formatAnts(data.locked.locked, 4)} ANTS locked`}
            actions={<ClaimButton bucket="locked" amount={data.locked.claimable} label="Withdraw available amount" title="Withdraw released seller rewards"
              disabled={!data.locked.policy} reason={!data.locked.policy ? 'M002 (unlock policy) is not installed.' : isZero(data.locked.claimable) ? 'No rewards are currently released for withdrawal.' : undefined}
              />}
          />
        </div>
      )}
      </Card>
    </>
  );
}

function BucketRow({ visible, name, note, amount, amountDetail, actions }: { visible: boolean; name: string; note?: ReactNode; amount: string; amountDetail?: string; actions: ReactNode }) {
  if (!visible) return null;
  return (
    <div className="bucket">
      <div className="bucket-main">
        <div className="bucket-name">{name}</div>
        {note ? <div className="bucket-note">{note}</div> : null}
      </div>
      <div className={`bucket-amount mono${amountDetail ? ' bucket-amount--detailed' : ''}`}>
        <span><RewardAmount>{formatAnts(amount, 4)}</RewardAmount> <span className="unit">ANTS</span></span>
        {amountDetail ? <span className="bucket-amount-detail"><RewardAmount>{amountDetail}</RewardAmount></span> : null}
      </div>
      <div className="bucket-actions">{actions}</div>
    </div>
  );
}

function ClaimButton({ bucket, amount, label, title, disabled, reason, scope = 'wallet', expectedLegacySellerRecipient }: { bucket: RewardBucket; amount: string; label?: string; title?: string; disabled?: boolean; reason?: string; scope?: 'buyer' | 'wallet'; expectedLegacySellerRecipient?: string }) {
  const { stale } = useContext(RewardRefreshContext);
  const body: ClaimRequest = { buckets: [bucket], scope, ...(expectedLegacySellerRecipient ? { expectedLegacySellerRecipient } : {}) };
  const empty = isZero(amount);
  return (
    <ActionButton
      label={label ?? 'Claim to wallet'}
      size="sm"
      title={title ?? (bucket === 'staker' ? 'Claim staking rewards' : 'Claim current seller rewards')}
      path="/api/rewards/claim"
      body={body}
      disabled={stale || disabled || empty}
      disabledReason={stale ? 'Wait for rewards to refresh before another action.' : reason ?? (empty ? 'Nothing to claim.' : undefined)}
    />
  );
}

/** Slider shared by every restake confirm; defaults to the maximum lock once the pool config is known. */
function useLock(maxEpochs: number | null) {
  const info = useEpochInfo();
  const positions = usePageData('positions:current', api.positions);
  const [epochs, setEpochs] = useState(maxEpochs ?? 1);
  useEffect(() => {
    if (maxEpochs !== null) setEpochs(maxEpochs);
  }, [maxEpochs]);
  return { epochs, setEpochs, positions, slider: <LockSlider value={epochs} min={positions.data?.config.minStakeEpochs ?? 1} max={maxEpochs ?? 1} startEpoch={info && positions.data ? info.current + positions.data.config.stakeActivationDelay : null} onChange={setEpochs} disabled={maxEpochs === null} /> };
}


function RestakeDestinations({ data, pools }: { data: RewardsView; pools: PoolView[] }) {
  const amounts = new Map<number, bigint>();
  for (const position of data.staker.positions) {
    const amount = toBigInt(position.amount) ?? 0n;
    if (amount > 0n) amounts.set(position.agentId, (amounts.get(position.agentId) ?? 0n) + amount);
  }
  if (amounts.size === 0) return <>Destination unavailable</>;
  return <div>{[...amounts].map(([agentId, amount]) => {
    const pool = pools.find(pool => pool.agentId === agentId);
    return <div key={agentId}>{pool ? poolName(pool) : `Seller pool #${agentId}`} · {formatAnts(amount.toString(), 4)} ANTS</div>;
  })}</div>;
}

/** Per-bucket restake using the existing endpoints. */
function RestakeButton({ kind, data, maxEpochs }: { kind: 'staker' | 'seller' | 'buyer'; data: RewardsView; maxEpochs: number | null }) {
  const { stale } = useContext(RewardRefreshContext);
  const { epochs, slider, positions } = useLock(maxEpochs);
  const pools = usePageData('pools', api.pools, 5 * 60_000);
  const [stakeAgent, setStakeAgent] = useState(() => (data.sellerUsage.agentId ? String(data.sellerUsage.agentId) : ''));
  const poolList: PoolView[] = pools.data?.pools ?? [];
  useEffect(() => {
    if (!stakeAgent && poolList[0]) setStakeAgent(String(poolList[0].agentId));
  }, [stakeAgent, poolList]);

  const amount = kind === 'staker' ? data.staker.total : kind === 'seller' ? data.sellerUsage.total : data.buyerUsage.total;
  const claimable = kind === 'staker' ? true : kind === 'seller' ? data.sellerUsage.claimable : data.buyerUsage.claimable;
  const path = kind === 'staker' ? '/api/rewards/restake' : '/api/rewards/stake-usage';
  const body: RestakeRequest | StakeUsageRequest =
    kind === 'staker' ? { epochs } : { side: kind, epochs, ...(kind === 'buyer' && stakeAgent ? { stakeAgentId: Number(stakeAgent) } : {}) };
  const sellerPool = poolList.find(pool => pool.agentId === data.sellerUsage.agentId);
  const target = kind === 'staker'
    ? <RestakeDestinations data={data} pools={poolList} />
    : sellerPool ? poolName(sellerPool) : data.sellerUsage.agentId ? `Seller pool #${data.sellerUsage.agentId}` : 'Destination unavailable';

  if (maxEpochs === null && claimable && !isZero(amount)) {
    if (positions.error && !positions.loading) {
      return <span className="btn-wrap" title={`Staking configuration could not be loaded: ${positions.error}`}>
        <Button variant="outline" size="sm" onClick={positions.refresh}>Retry loading</Button>
      </span>;
    }
    return <Button variant="outline" size="sm" disabled aria-busy="true" aria-label="Loading staking configuration">Loading…</Button>;
  }

  return (
    <ActionButton
      label="Stake rewards"
      size="sm"
      title={kind === 'staker' ? 'Stake position rewards' : `Stake current ${kind} rewards`}
      path={path}
      body={body}
      disabled={stale || isZero(amount) || !claimable || maxEpochs === null}
      disabledReason={stale ? 'Wait for rewards to refresh before another action.' : !claimable ? `${kind} usage rewards are not claimable from this wallet.` : 'No rewards are available to stake.'}
      validate={() => (maxEpochs === null ? 'Pool configuration is still loading.' : kind === 'buyer' && !stakeAgent ? 'Choose a pool to stake into.' : null)}
      summary={kind === 'buyer' ? [
        ['Amount', <span className="mono">{formatAnts(amount, 4)} ANTS</span>],
      ] : [
        ['Amount', <span className="mono">{formatAnts(amount, 4)} ANTS</span>],
        ['Into', target],
        ['Lock', <span className="mono">{epochs} epochs</span>],
      ]}
    >
      <div className="stack mt">
        {slider}
        {kind === 'buyer' ? (
          <Field label="Pool" width="lg" hint={pools.loading && !pools.data ? 'loading pools…' : undefined}>
            <Select value={stakeAgent} onChange={(e) => setStakeAgent(e.target.value)}>
              {poolList.map((p) => (
                <option key={p.agentId} value={p.agentId}>
                  {poolLabel(p)}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
    </ActionButton>
  );
}
