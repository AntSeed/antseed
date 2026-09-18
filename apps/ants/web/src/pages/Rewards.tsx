import { Card } from '../components/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ClaimRequest, CompoundRequest, PoolView, RestakeRequest, RewardBucket, RewardsView, StakeUsageRequest } from '../../../src/api-types';
import { request, api } from '../api';
import { BuyerWalletAction } from '../wallet';
import { useConfig, useEpochInfo } from '../app-context';
import { AddressLink } from '../components/AddressLink';
import { ActionButton } from '../components/Confirm';
import { ErrorBox, Skeleton } from '../components/Feedback';
import { Field, Select } from '../components/Field';
import { LockSlider } from '../components/LockSlider';
import { poolLabel, sortPools } from '../components/Pools';
import { usePageData } from '../data';
import { cmpBig, formatAnts, isZero, sumBig, toBigInt } from '../format';

export function RewardsPage() {
  const page = usePageData('rewards', api.rewards, 5 * 60_000);
  const data = page.data;
  return (
    <>
      {page.error && !data ? <ErrorBox error={page.error} onRetry={page.refresh} /> : null}
      {page.error && data ? <div className="status-line">Refresh failed: {page.error}</div> : null}
      {!data && page.loading ? (
        <>
          <div className="muted small mb">Loading rewards from the blockchain and indexer…</div>
          <Skeleton rows={6} />
        </>
      ) : null}
      {data ? <>
        <BuyerRewardsCard data={data} />
        {data.scope !== 'buyer' ? <RewardsBody data={{ ...data,
          total: sumBig([data.staker.total, data.sellerUsage.total, data.legacy.seller, data.locked.claimable]),
          buyerUsage: { ...data.buyerUsage, total: '0', epochs: [], claimable: false },
          legacy: { ...data.legacy, buyer: '0', buyerClaimable: false },
        }} /> : null}
      </> : null}
    </>
  );
}

/** Which buckets have a stake path from this wallet (staker pool, seller usage, operator-claimable buyer usage). */
function split(data: RewardsView) {
  const buyerRestakable = data.buyerUsage.claimable && !isZero(data.buyerUsage.total);
  const restakable = sumBig([data.staker.total, data.sellerUsage.claimable ? data.sellerUsage.total : '0', buyerRestakable ? data.buyerUsage.total : '0']);
  const legacy = sumBig([data.legacy.seller, data.legacy.buyerClaimable ? data.legacy.buyer : '0']);
  const locked = data.locked.policy ? data.locked.claimable : '0';
  const claimOnly = sumBig([legacy, locked]);
  return { restakable, claimOnly, legacy, buyerRestakable };
}

function BuyerRewardsCard({ data }: { data: RewardsView }) {
  const dashboard = useConfig();
  const [authorizationError, setAuthorizationError] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const amount = sumBig([data.buyerUsage.total, data.legacy.buyer]);
  const operator = data.buyerUsage.operator;
  const authorized = !!operator && operator.toLowerCase() === dashboard.address.toLowerCase() && !dashboard.readOnly;
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
    <div className="hero-value">{formatAnts(amount, 4)}<span className="unit">ANTS</span></div>
    {!isZero(data.legacy.buyer) ? <p className="hint">Includes {formatAnts(data.legacy.buyer, 4)} ANTS from legacy buyer rewards. Legacy rewards can be claimed but cannot be restaked.</p> : null}
    {isZero(amount) ? <p className="hero-sub muted">Nothing to claim yet. Rewards accrue at each epoch boundary.</p> : null}
    {!operator ? <p className="hint">Authorize a wallet to claim or restake this buyer’s rewards.</p> : !authorized ? <p className="hint">Connect the authorized wallet <AddressLink value={operator} /> on {dashboard.chainId} to claim or restake.</p> : null}
    <div className="hero-actions">
      {!operator && dashboard.canAuthorize ? <button className="btn" disabled={authorizing} onClick={() => void authorize()}>{authorizing ? 'Opening…' : 'Authorize wallet ↗'}</button> : null}
      {operator && !authorized && dashboard.browserWallet ? <BuyerWalletAction /> : null}
      <ActionButton label="Claim buyer rewards" variant="primary" title="Claim buyer rewards" path="/api/rewards/claim"
        body={{ buckets: [], scope: 'buyer' } satisfies ClaimRequest}
        disabled={!authorized || isZero(amount)} disabledReason={!authorized ? 'Connect the authorized wallet for this buyer account.' : 'Nothing to claim.'}
        summary={[
          ['Buyer account', <AddressLink value={dashboard.buyerAddress ?? dashboard.address} />],
          ['Recipient', operator ? <AddressLink value={operator} /> : 'Authorize a wallet first'],
          ['Amount', `${formatAnts(amount, 4)} ANTS`],
          ['Includes', 'Current and legacy buyer rewards. Each required transaction needs wallet approval.'],
        ]} />
      {authorized && data.buyerUsage.claimable && !isZero(data.buyerUsage.total) ? <RestakeButton kind="buyer" data={data} maxEpochs={config.data?.config.maxStakeEpochs ?? null} /> : null}
    </div>
    {authorizationError ? <p role="alert" className="hint">{authorizationError}</p> : null}
  </Card>;
}

function RewardsBody({ data }: { data: RewardsView }) {
  const { restakable, claimOnly, legacy: claimableLegacy } = split(data);
  const legacy = sumBig([data.legacy.seller, data.legacy.buyer]);
  const buyerOnly = data.scope === 'buyer';
  const config = usePageData(buyerOnly ? null : 'positions:current', api.positions);
  const maxEpochs = config.data?.config.maxStakeEpochs ?? null;
  const nothing = isZero(data.total);
  const rewardsForOtherWallet = !isZero(data.buyerUsage.total) || !isZero(data.sellerUsage.total);
  const canRestake = !isZero(restakable);

  return (
    <>
      <Card className="hero">
        {data.historySource === 'chain' ? <p className="status-line">Closed-position history is unavailable (no indexer configured, or the indexer is unreachable). These are known rewards; rewards from closed positions may be missing. Refresh to retry.</p> : null}
        {data.historySource === 'local' ? <p className="status-line">Includes positions from verified local transactions. Older closed positions may be missing without an indexer.</p> : null}
        <div className="tile-label">Wallet rewards</div>
        <div className="hero-value">
          {formatAnts(data.total, 4)}
          <span className="unit">ANTS</span>
        </div>
        {!nothing && !isZero(claimOnly) ? (
          <div className="hero-sub">
            Restakable <span className="mono">{formatAnts(restakable, 4)}</span> · claim-only <span className="mono">{formatAnts(claimOnly, 4)}</span>
          </div>
        ) : null}
        {nothing ? (
          <div className="hero-sub muted">{rewardsForOtherWallet ? 'Rewards are available to a different authorized wallet. See the categories below.' : 'Nothing to claim yet. Rewards accrue at each epoch boundary.'}</div>
        ) : (
          <div className="hero-actions">
            {canRestake ? <CompoundButton data={data} maxEpochs={maxEpochs} /> : null}
            <ClaimButton bucket="all" amount={data.total} label="Claim wallet rewards" primary={!canRestake} />
          </div>
        )}
      </Card>

      {nothing && !rewardsForOtherWallet && isZero(data.locked.locked) ? null : (
        <Card className="buckets">
          <BucketRow
            visible={!isZero(data.staker.total)}
            name="Staker pool"
            note={`${data.staker.positions.length} position${data.staker.positions.length === 1 ? '' : 's'}`}
            amount={data.staker.total}
            actions={
              <>
                <RestakeButton kind="staker" data={data} maxEpochs={maxEpochs} />
                <ClaimButton bucket="staker" amount={data.staker.total} />
              </>
            }
          />
          <BucketRow
            visible={!isZero(data.sellerUsage.total)}
            name="Seller usage"
            note={
              <>
                agent <span className="mono">{data.sellerUsage.agentId || '—'}</span>
                {data.sellerUsage.claimable ? null : ' · not claimable from this wallet'}
              </>
            }
            amount={data.sellerUsage.total}
            actions={
              <>
                <RestakeButton kind="seller" data={data} maxEpochs={maxEpochs} />
                <ClaimButton bucket="seller" amount={data.sellerUsage.total} disabled={!data.sellerUsage.claimable} reason="Seller usage rewards are not claimable from this wallet." />
              </>
            }
          />
          <BucketRow
            visible={!isZero(data.legacy.seller) || !isZero(data.legacy.buyer)}
            name="Legacy V2"
            note={
              <>
                Seller rewards · claim only
              </>
            }
            amount={legacy}
            actions={<ClaimButton bucket="legacy" amount={claimableLegacy} />}
          />
          <BucketRow
            visible={!isZero(data.locked.claimable) || !isZero(data.locked.locked)}
            name="Locked pool"
            note={
              <>
                <span className="mono">{formatAnts(data.locked.locked, 4)}</span> locked
                {data.locked.policy ? ' · claim only' : ' · unlock policy (M002) not installed'}
              </>
            }
            amount={data.locked.claimable}
            actions={<ClaimButton bucket="locked" amount={data.locked.claimable} disabled={!data.locked.policy} reason="M002 (unlock policy) is not installed." />}
          />
        </Card>
      )}
    </>
  );
}

function BucketRow({ visible, name, note, amount, actions }: { visible: boolean; name: string; note?: ReactNode; amount: string; actions: ReactNode }) {
  if (!visible) return null;
  return (
    <div className="bucket">
      <div className="bucket-main">
        <div className="bucket-name">{name}</div>
        {note ? <div className="bucket-note">{note}</div> : null}
      </div>
      <div className="bucket-amount mono">
        {formatAnts(amount, 4)} <span className="unit">ANTS</span>
      </div>
      <div className="bucket-actions">{actions}</div>
    </div>
  );
}

function ClaimButton({ bucket, amount, label, disabled, reason, primary }: { bucket: RewardBucket | 'all'; amount: string; label?: string; disabled?: boolean; reason?: string; primary?: boolean }) {
  const body: ClaimRequest = { buckets: bucket === 'all' ? [] : [bucket], scope: 'wallet' };
  const empty = isZero(amount);
  return (
    <ActionButton
      label={label ?? 'Claim'}
      size={bucket === 'all' ? undefined : 'sm'}
      variant={primary ? 'primary' : 'default'}
      title={bucket === 'all' ? 'Claim wallet rewards' : `Claim ${bucket} rewards`}
      path="/api/rewards/claim"
      body={body}
      disabled={disabled || empty}
      disabledReason={reason ?? (empty ? 'Nothing to claim.' : undefined)}
      summary={[
        ['Buckets', bucket === 'all' ? 'Connected-wallet rewards; excludes buyer rewards' : bucket],
        ['Amount', <span className="mono">{formatAnts(amount, 4)} ANTS</span>],
      ]}
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
  return { epochs, setEpochs, slider: <LockSlider value={epochs} min={positions.data?.config.minStakeEpochs ?? 1} max={maxEpochs ?? 1} startEpoch={info && positions.data ? info.current + positions.data.config.stakeActivationDelay : null} onChange={setEpochs} disabled={maxEpochs === null} /> };
}

/** Default compound target: the stakeable pool where you already hold the most power, else your seller's pool. */
function defaultTarget(pools: PoolView[], sellerAgentId: number): string {
  const stakeable = pools.filter((p) => p.stakeable);
  const best = stakeable.reduce<PoolView | null>((acc, p) => (toBigInt(p.yourPower) && (!acc || cmpBig(p.yourPower, acc.yourPower) > 0) ? p : acc), null);
  if (best) return String(best.agentId);
  if (sellerAgentId && stakeable.some((p) => p.agentId === sellerAgentId)) return String(sellerAgentId);
  return '';
}

/** Hero "Restake": one job that restakes everything with a stake path (`/api/rewards/compound`) and moves it to the chosen pool. */
function CompoundButton({ data, maxEpochs }: { data: RewardsView; maxEpochs: number | null }) {
  const { epochs, slider } = useLock(maxEpochs);
  const pools = usePageData('pools', api.pools, 5 * 60_000);
  const poolList = useMemo(() => sortPools((pools.data?.pools ?? []).filter((p) => p.stakeable)), [pools.data]);
  const [target, setTarget] = useState('');
  useEffect(() => {
    if (!target && poolList.length > 0) setTarget(defaultTarget(poolList, data.sellerUsage.agentId));
  }, [target, poolList, data.sellerUsage.agentId]);
  const targetPool = poolList.find((p) => String(p.agentId) === target) ?? null;
  const body: CompoundRequest = { epochs, includeBuyer: false, ...(target ? { targetAgentId: Number(target) } : {}) };
  const { restakable, buyerRestakable } = split(data);

  const parts: string[] = [];
  if (!isZero(data.staker.total)) parts.push(`staker ${formatAnts(data.staker.total, 4)}`);
  if (data.sellerUsage.claimable && !isZero(data.sellerUsage.total)) parts.push(`seller usage ${formatAnts(data.sellerUsage.total, 4)}`);
  if (buyerRestakable) parts.push(`buyer usage ${formatAnts(data.buyerUsage.total, 4)}`);

  return (
    <ActionButton
      label="Restake"
      variant="primary"
      title="Restake rewards"
      path="/api/rewards/compound"
      body={body}
      validate={() => (maxEpochs === null ? 'Pool configuration is still loading.' : null)}
      confirmDisabled={pools.data !== null && (poolList.length === 0 || !target)}
      summary={[
        ['Amount', <span className="mono">{formatAnts(restakable, 4)} ANTS</span>],
        ['Buckets', parts.join(' · ') || '—'],
        ['Pool', <span className="mono">{targetPool ? poolLabel(targetPool) : pools.data ? '—' : 'loading…'}</span>],
        ['Lock', <span className="mono">{epochs} epochs</span>],
      ]}
    >
      <div className="stack mt">
        {pools.data && poolList.length === 0 ? <div className="status-line status-line--muted">No stakeable pools yet — sellers must bind in the seller registry first.</div> : null}
        <Field label="Pool" width="lg" hint={pools.loading && !pools.data ? 'scanning pools on chain…' : pools.error && !pools.data ? <span className="danger">{pools.error}</span> : undefined}>
          <Select value={target} onChange={(e) => setTarget(e.target.value)} disabled={poolList.length === 0}>
            {poolList.length === 0 ? <option value="">{pools.data ? 'No stakeable pools' : 'Loading pools…'}</option> : null}
            {poolList.map((p) => (
              <option key={p.agentId} value={p.agentId}>
                {poolLabel(p)}
              </option>
            ))}
          </Select>
        </Field>
        {slider}
        <p className="hint">Restaked in place with the bonus, then moved to the chosen pool (effective next epoch). Legacy and locked-pool rewards can only be claimed.</p>
      </div>
    </ActionButton>
  );
}

/** Per-bucket restake using the existing endpoints. */
function RestakeButton({ kind, data, maxEpochs }: { kind: 'staker' | 'seller' | 'buyer'; data: RewardsView; maxEpochs: number | null }) {
  const { epochs, slider } = useLock(maxEpochs);
  const pools = usePageData(kind === 'buyer' ? 'pools' : null, api.pools, 5 * 60_000);
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
  const target = kind === 'staker' ? 'same pools' : kind === 'seller' ? `agent ${data.sellerUsage.agentId || '—'} (own pool)` : stakeAgent ? `agent ${stakeAgent}` : '—';

  return (
    <ActionButton
      label="Restake"
      size="sm"
      title={kind === 'staker' ? 'Restake staker rewards' : `Stake ${kind} usage rewards`}
      path={path}
      body={body}
      disabled={isZero(amount) || !claimable}
      disabledReason={!claimable ? `${kind} usage rewards are not claimable from this wallet.` : 'Nothing to restake.'}
      validate={() => (maxEpochs === null ? 'Pool configuration is still loading.' : kind === 'buyer' && !stakeAgent ? 'Choose a pool to stake into.' : null)}
      summary={[
        ['Amount', <span className="mono">{formatAnts(amount, 4)} ANTS</span>],
        ['Into', <span className="mono">{target}</span>],
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
