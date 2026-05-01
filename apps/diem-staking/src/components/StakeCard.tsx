import { useEffect, useMemo, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import { formatEther, parseEther } from 'viem';

import { DiemLogo } from './icons';
import { FlowDiagram } from './FlowDiagram';
import { useAntstationDownload } from '../lib/antstation';

import {
  useDiemAllowance,
  usePoolStats,
  useUserStats,
  useEpochClock,
  useUnstakeState,
  type UnstakeState,
} from '../lib/hooks';
import {
  useApproveDiem,
  useStake,
  useInitiateUnstake,
  useFlush,
  useClaimUnstakeBatch,
  useClaimUsdc,
} from '../lib/actions';
import {
  fmtDiem,
  fmtDiemPrecise,
  fmtDuration,
  fmtNum,
  fmtPct,
  fmtUSD,
  toAntsNumber,
  toDiemNumber,
  toUsdcNumber,
} from '../lib/format';
import { DAYS_PER_YEAR } from '../lib/epoch';

type Tab = 'stake' | 'unstake' | 'claim';

const DEFAULT_STAKE_AMOUNT = parseEther('10');

function formatDiemInput(value: bigint): string {
  const formatted = formatEther(value);
  return formatted.includes('.') ? formatted.replace(/0+$/, '').replace(/\.$/, '') : formatted;
}

export interface StakeCardProps {
  diemPrice: number | null;
  poolAgeDays: number | null;
  apy: number;
}

export function StakeCard({ diemPrice, poolAgeDays, apy }: StakeCardProps) {
  const [tab, setTab] = useState<Tab>('stake');
  const [amt, setAmt] = useState('10');
  const [amtEdited, setAmtEdited] = useState(false);
  const { isConnected } = useAccount();
  const { epoch, remainingSecs } = useEpochClock();

  const pool = usePoolStats();
  const user = useUserStats();

  const stakeMaxAmount = useMemo(() => {
    if (!isConnected || user.walletDiem == null) return null;

    let maxStakeable = user.walletDiem;
    if (pool.maxTotalStake != null && pool.maxTotalStake !== 0n) {
      const poolTotal = pool.totalStaked ?? 0n;
      const capRemaining = pool.maxTotalStake > poolTotal ? pool.maxTotalStake - poolTotal : 0n;
      maxStakeable = maxStakeable < capRemaining ? maxStakeable : capRemaining;
    }
    return maxStakeable;
  }, [isConnected, pool.maxTotalStake, pool.totalStaked, user.walletDiem]);

  const stakeDefaultAmt = useMemo(() => {
    if (!isConnected) return formatDiemInput(DEFAULT_STAKE_AMOUNT);
    if (stakeMaxAmount == null) return '0';

    const defaultAmount = stakeMaxAmount < DEFAULT_STAKE_AMOUNT ? stakeMaxAmount : DEFAULT_STAKE_AMOUNT;
    return formatDiemInput(defaultAmount);
  }, [isConnected, stakeMaxAmount]);

  const setAmtFromUser = (next: string) => {
    setAmtEdited(true);
    setAmt(next);
  };

  useEffect(() => {
    if (tab !== 'stake' || amtEdited) return;
    setAmt(stakeDefaultAmt);
  }, [amtEdited, stakeDefaultAmt, tab]);

  const onChangeTab = (next: Tab) => {
    setTab(next);
    setAmtEdited(false);
    if (next === 'stake') setAmt(stakeDefaultAmt);
    if (next === 'unstake') setAmt(user.stakedDiem ? fmtDiem(toDiemNumber(user.stakedDiem)) : '0');
  };

  const diemValue = parseFloat(amt) || 0;
  const poolDiem = toDiemNumber(pool.totalStaked);
  const usdcPerDiemPerDay =
    poolDiem > 0 && poolAgeDays != null && poolAgeDays > 0 && pool.totalUsdcDistributedEver != null
      ? toUsdcNumber(pool.totalUsdcDistributedEver) / poolAgeDays / poolDiem
      : null;
  const usdcPerWeek = usdcPerDiemPerDay != null ? diemValue * usdcPerDiemPerDay * 7 : null;
  const usdcPerYear = usdcPerDiemPerDay != null ? diemValue * usdcPerDiemPerDay * DAYS_PER_YEAR : null;
  const usdcPerMonth = usdcPerYear != null ? usdcPerYear / 12 : null;
  const amtUsd = diemPrice != null ? diemValue * diemPrice : null;

  const quickSet = (v: string) => {
    setAmtEdited(true);
    if (v === 'max') {
      if (tab === 'stake' && stakeMaxAmount != null) setAmt(formatDiemInput(stakeMaxAmount));
      else if (tab === 'unstake' && user.stakedDiem != null) setAmt(String(toDiemNumber(user.stakedDiem)));
    } else {
      setAmt(v);
    }
  };

  const countdown = fmtDuration(remainingSecs);

  return (
    <div className="stake-wrap">
      <div className="stake-card">
        <div className="stake-head">
          <h2>Stake &amp; earn</h2>
          <div className="pool">
            Pool TVL · <strong>{pool.totalStaked != null ? fmtNum(poolDiem) : '—'} $DIEM</strong>
          </div>
        </div>

        <div className="epoch-ribbon">
          <div className="er-dot" />
          <div className="er-text">
            <span className="er-lbl">Next $ANTS distribution · USDC streams live</span>
            <span className="er-val">{countdown}</span>
          </div>
          <div className="er-epoch">Epoch <strong>#{epoch}</strong></div>
        </div>

        <div className="stake-tabs">
          <button className={tab === 'stake' ? 'on' : ''} onClick={() => onChangeTab('stake')}>Stake</button>
          <button className={tab === 'unstake' ? 'on' : ''} onClick={() => onChangeTab('unstake')}>Unstake</button>
          <button className={tab === 'claim' ? 'on' : ''} onClick={() => onChangeTab('claim')}>Claim</button>
        </div>

        {tab === 'stake' && (
          <StakePanel
            amt={amt}
            setAmt={setAmtFromUser}
            setQuick={quickSet}
            isConnected={isConnected}
            amtUsd={amtUsd}
            walletDiem={user.walletDiem}
            poolTotalStaked={pool.totalStaked}
            maxTotalStake={pool.maxTotalStake}
            maxStakeable={stakeMaxAmount}
            usdcPerWeek={usdcPerWeek}
            usdcPerMonth={usdcPerMonth}
            usdcPerYear={usdcPerYear}
            apy={apy}
          />
        )}

        {tab === 'unstake' && (
          <UnstakePanel
            amt={amt}
            setAmt={setAmtFromUser}
            setQuick={quickSet}
            isConnected={isConnected}
            stakedDiem={user.stakedDiem}
            amtUsd={amtUsd}
            diemCooldownSecs={pool.diemCooldownSecs}
            minUnstakeBatchOpenSecs={pool.minUnstakeBatchOpenSecs}
            flushableAt={pool.flushableAt}
          />
        )}

        {tab === 'claim' && (
          <ClaimPanel
            isConnected={isConnected}
            pendingUsdc={user.pendingUsdc}
            pendingAnts={user.pendingAnts}
            claimableAntsEpochs={user.claimableAntsEpochs}
            hasMoreClaimableAntsEpochs={user.hasMoreClaimableAntsEpochs}
          />
        )}

        <div className="stake-foot">
          <span>
            Venice cooldown · {pool.diemCooldownSecs != null ? fmtDuration(pool.diemCooldownSecs) : '—'}
          </span>
          <span>Network · Base mainnet</span>
        </div>
      </div>

      <Metrics
        apy={apy}
        pool={pool}
        poolAgeDays={poolAgeDays}
      />

      <FlowDiagram />
    </div>
  );
}


interface StakePanelProps {
  amt: string;
  setAmt: (v: string) => void;
  setQuick: (v: string) => void;
  isConnected: boolean;
  amtUsd: number | null;
  walletDiem: bigint | null;
  poolTotalStaked: bigint | null;
  maxTotalStake: bigint | null;
  maxStakeable: bigint | null;
  usdcPerWeek: number | null;
  usdcPerMonth: number | null;
  usdcPerYear: number | null;
  apy: number;
}

function StakePanel(props: StakePanelProps) {
  const { allowance, refetch: refetchAllowance } = useDiemAllowance();
  const approve = useApproveDiem();
  const stake = useStake();

  let parsedAmt: bigint = 0n;
  let amtInvalid = false;
  try {
    parsedAmt = props.amt ? parseEther(props.amt) : 0n;
  } catch {
    amtInvalid = true;
  }

  const capRemaining = useMemo(() => {
    if (props.maxTotalStake == null) return null;
    if (props.maxTotalStake === 0n) return null; // unlimited
    const pool = props.poolTotalStaked ?? 0n;
    return props.maxTotalStake > pool ? props.maxTotalStake - pool : 0n;
  }, [props.maxTotalStake, props.poolTotalStaked]);

  const capExceeded = capRemaining != null && parsedAmt > capRemaining;
  const insufficientBalance = props.walletDiem != null && parsedAmt > props.walletDiem;
  const needsApproval = allowance != null && parsedAmt > 0n && allowance < parsedAmt;

  const quickOptions = useMemo(() => {
    const fixed = [
      { label: '1', value: '1', amount: parseEther('1') },
      { label: '10', value: '10', amount: parseEther('10') },
      { label: '100', value: '100', amount: parseEther('100') },
      { label: '1,000', value: '1000', amount: parseEther('1000') },
    ];
    const shouldDisable = (amount: bigint) => {
      if (!props.isConnected) return false;
      if (props.maxStakeable == null) return true;
      return amount > props.maxStakeable;
    };

    return [
      ...fixed.map(({ label, value, amount }) => ({ label, value, disabled: shouldDisable(amount) })),
      { label: 'Max', value: 'max', disabled: props.isConnected && (props.maxStakeable == null || props.maxStakeable === 0n) },
    ];
  }, [props.isConnected, props.maxStakeable]);

  const disabled =
    !props.isConnected ||
    amtInvalid ||
    parsedAmt === 0n ||
    insufficientBalance ||
    capExceeded ||
    stake.isPending ||
    approve.isPending;

  return (
    <div className="panel-v2 stake-panel-v2">
      <InputField
        label="You stake"
        balanceLabel="Wallet"
        balanceValue={props.isConnected ? `${fmtDiem(toDiemNumber(props.walletDiem))} $DIEM` : 'Connect'}
        amt={props.amt}
        setAmt={props.setAmt}
        amtUsd={props.amtUsd}
      />
      <QuickSet options={quickOptions} onSet={props.setQuick} />

      <div className="stake-reward-summary">
        <div className="reward-summary-head">
          <span>Projected rewards</span>
          <strong>All-time daily avg</strong>
        </div>
        <div className="reward-summary-grid">
          <div className="reward-summary-card primary">
            <span>USDC / week</span>
            <strong>{props.usdcPerWeek != null ? fmtUSD(props.usdcPerWeek) : '—'}</strong>
          </div>
          <div className="reward-summary-card">
            <span>Month</span>
            <strong>{props.usdcPerMonth != null ? fmtUSD(props.usdcPerMonth) : '—'}</strong>
          </div>
          <div className="reward-summary-card">
            <span>Year</span>
            <strong>{props.usdcPerYear != null ? fmtUSD(props.usdcPerYear) : '—'}</strong>
          </div>
          <div className="reward-summary-card accent">
            <span>USDC APY</span>
            <strong>{fmtPct(props.apy)}</strong>
          </div>
        </div>
      </div>

      {capExceeded && (
        <div className="claim-note">
          <strong>Over pool cap.</strong> Only {fmtDiem(toDiemNumber(capRemaining))} $DIEM of headroom remaining before the owner-set cap.
        </div>
      )}

      {props.isConnected ? (
        needsApproval ? (
          <button
            className="stake-cta"
            disabled={approve.isPending}
            onClick={async () => {
              await approve.run();
              refetchAllowance();
            }}
          >
            {approve.isPending ? 'Approving…' : `Approve $DIEM →`}
          </button>
        ) : (
          <button
            className="stake-cta"
            disabled={disabled}
            onClick={async () => {
              await stake.run(props.amt);
              props.setAmt('0');
            }}
          >
            {stake.isPending ? 'Staking…' : `Stake ${props.amt || '0'} $DIEM →`}
          </button>
        )
      ) : (
        <ConnectCta label="Connect wallet to stake →" />
      )}

      {(stake.error || approve.error) && (
        <div className="claim-note" style={{ color: '#c62828' }}>
          {(stake.error ?? approve.error)?.message ?? 'Transaction failed'}
        </div>
      )}
    </div>
  );
}


interface UnstakePanelProps {
  amt: string;
  setAmt: (v: string) => void;
  setQuick: (v: string) => void;
  isConnected: boolean;
  stakedDiem: bigint | null;
  amtUsd: number | null;
  diemCooldownSecs: number | null;
  minUnstakeBatchOpenSecs: number | null;
  flushableAt: number | null;
}

function UnstakePanel(props: UnstakePanelProps) {
  const initiate = useInitiateUnstake();
  const { state } = useUnstakeState();

  const stakedNum = toDiemNumber(props.stakedDiem);
  let parsedAmt: bigint = 0n;
  try {
    parsedAmt = props.amt ? parseEther(props.amt) : 0n;
  } catch {
  }
  const amountTooLarge = props.stakedDiem != null && parsedAmt > props.stakedDiem;
  const disabled = !props.isConnected || parsedAmt === 0n || amountTooLarge || initiate.isPending;

  return (
    <div className="panel-v2 unstake-panel-v2">
      <div className="unstake-flow-card">
        <div className="unstake-flow-copy">
          <span className="panel-kicker">Withdraw $DIEM</span>
          <h3>Unstake through a shared batch.</h3>
          <p>
            Unstakes move through three on-chain states. Anyone in the batch can advance
            it, so the cost is shared instead of every staker paying alone.
          </p>
          <div className="unstake-timing">
            <span>Batch window · <strong>{props.minUnstakeBatchOpenSecs != null ? fmtDuration(props.minUnstakeBatchOpenSecs) : '—'}</strong></span>
            <span>Venice cooldown · <strong>{props.diemCooldownSecs != null ? fmtDuration(props.diemCooldownSecs) : '—'}</strong></span>
          </div>
        </div>
        <ol className="unstake-steps" aria-label="Unstake flow">
          <li><span>01</span><strong>Queued</strong><em>Join the open batch</em></li>
          <li><span>02</span><strong>Cooling</strong><em>Sent to Venice</em></li>
          <li><span>03</span><strong>Claimable</strong><em>Withdraw to wallet</em></li>
        </ol>
      </div>

      {/* Input only makes sense while the user has no active unstake in flight. */}
      {state.status === 'none' && (
        <>
          <InputField
            label="You unstake"
            balanceLabel="Staked"
            balanceValue={props.isConnected ? `${fmtDiem(stakedNum)} $DIEM` : 'Connect'}
            amt={props.amt}
            setAmt={props.setAmt}
            amtUsd={props.amtUsd}
          />
          <QuickSet
            options={[
              { label: '25%', value: String(stakedNum * 0.25) },
              { label: '50%', value: String(stakedNum * 0.5) },
              { label: '75%', value: String(stakedNum * 0.75) },
              { label: 'Max', value: 'max' },
            ]}
            onSet={props.setQuick}
          />
          {props.isConnected ? (
            <button
              className="stake-cta ghost unstake-cta"
              disabled={disabled}
              onClick={async () => {
                await initiate.run(props.amt);
                props.setAmt('0');
              }}
            >
              {initiate.isPending ? 'Queuing…' : 'Request unstake →'}
            </button>
          ) : (
            <ConnectCta label="Connect wallet to unstake →" />
          )}
          {initiate.error && (
            <div className="claim-note" style={{ color: '#c62828' }}>
              {initiate.error.message}
            </div>
          )}
        </>
      )}

      {/* Active state machine */}
      {state.status !== 'none' && (
        <UnstakeStateView state={state} flushableAt={props.flushableAt} />
      )}
    </div>
  );
}

function UnstakeStateView({
  state,
  flushableAt,
}: {
  state: UnstakeState;
  flushableAt: number | null;
}) {
  const flush = useFlush();
  const claim = useClaimUnstakeBatch();

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (state.status !== 'cooling' && state.status !== 'queued') return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  if (state.status === 'none') return null;

  const amountDiem = fmtDiem(toDiemNumber(state.amount));

  if (state.status === 'queued') {
    const waitingForWindow = flushableAt != null && now < flushableAt;
    const windowRemaining = waitingForWindow ? flushableAt! - now : 0;
    const canFlush = !state.waitingForPriorBatch && !waitingForWindow;

    let message: string;
    if (state.waitingForPriorBatch) {
      message =
        'Waiting for the previous batch to finish claiming before your batch can start the cooldown. Anyone in that batch can click their Claim button to advance it.';
    } else if (waitingForWindow) {
      message =
        'Batch is still in its open window so other stakers can join before it leaves for Venice. The counter below is the earliest time anyone can flush it — including you.';
    } else {
      message =
        'Your batch is ready to be sent to Venice. Click below to start the cooldown. Anyone in your batch can do this — pay once for the whole group.';
    }

    return (
      <div className="yield-box" style={{ marginTop: 8 }}>
        <div className="yield-row hero-row">
          <span className="lbl">Queued<span className="sub">batch #{state.batchId}</span></span>
          <span className="val">{amountDiem} <span className="unit">$DIEM</span></span>
        </div>
        <div className="yield-row">
          <span className="lbl">Accrual</span>
          <span className="val">Stopped</span>
        </div>
        {waitingForWindow && (
          <div className="yield-row">
            <span className="lbl">Flushable in</span>
            <span className="val">{fmtDuration(windowRemaining)}</span>
          </div>
        )}
        <p style={{ margin: '12px 0 14px', fontSize: 13, color: 'var(--muted)' }}>
          {message}
        </p>
        <button
          className="stake-cta"
          disabled={!canFlush || flush.isPending}
          onClick={() => flush.run()}
        >
          {flush.isPending
            ? 'Starting cooldown…'
            : waitingForWindow
              ? `Flushable in ${fmtDuration(windowRemaining)}`
              : 'Start cooldown →'}
        </button>
        {flush.error && (
          <div className="claim-note" style={{ color: '#c62828' }}>{flush.error.message}</div>
        )}
      </div>
    );
  }

  if (state.status === 'cooling') {
    const remaining = Math.max(0, state.unlockAt - now);
    return (
      <div className="yield-box" style={{ marginTop: 8 }}>
        <div className="yield-row hero-row">
          <span className="lbl">Cooling down<span className="sub">batch #{state.batchId}</span></span>
          <span className="val">{amountDiem} <span className="unit">$DIEM</span></span>
        </div>
        <div className="yield-row">
          <span className="lbl">Ready in</span>
          <span className="val">{fmtDuration(remaining)}</span>
        </div>
        <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--muted)' }}>
          Venice's native unstake cooldown is counting down. Nothing to do — refresh when the timer hits zero.
        </p>
      </div>
    );
  }

  return (
    <div className="yield-box" style={{ marginTop: 8 }}>
      <div className="yield-row hero-row">
        <span className="lbl">Ready to withdraw<span className="sub">batch #{state.batchId}</span></span>
        <span className="val">{amountDiem} <span className="unit">$DIEM</span></span>
      </div>
      <p style={{ margin: '12px 0 14px', fontSize: 13, color: 'var(--muted)' }}>
        Your DIEM is ready. Clicking below finalises the unstake for your whole batch in one tx — this is cheaper than everyone paying individually.
      </p>
      <button
        className="stake-cta brand-fill"
        disabled={claim.isPending}
        onClick={() => claim.run(state.batchId)}
      >
        {claim.isPending ? 'Finalising…' : `Withdraw ${amountDiem} $DIEM →`}
      </button>
      {claim.error && (
        <div className="claim-note" style={{ color: '#c62828' }}>{claim.error.message}</div>
      )}
    </div>
  );
}


interface ClaimPanelProps {
  isConnected: boolean;
  pendingUsdc: bigint | null;
  pendingAnts: bigint | null;
  claimableAntsEpochs: number[];
  hasMoreClaimableAntsEpochs: boolean;
}

function ClaimPanel(props: ClaimPanelProps) {
  const claimUsdc = useClaimUsdc();
  const { href: antstationHref, platform: antstationPlatform } = useAntstationDownload();

  const pendingUsdcNum = toUsdcNumber(props.pendingUsdc);
  const pendingAntsNum = toAntsNumber(props.pendingAnts);

  const claimableEpochs = props.claimableAntsEpochs.length;

  return (
    <div className="claim-panel-v2">
      <div className="claim-intro">
        <span className="claim-intro-kicker">Rewards destination</span>
        <h3>Claim USDC here. Claim $ANTS in AntStation.</h3>
        <p>
          Your wallet has two reward streams. USDC is paid by the staking contract on this
          page; $ANTS are claimed from the AntSeed desktop app’s Payments portal.
        </p>
      </div>

      <div className="claim-destination-card usdc-destination">
        <div className="claim-destination-top">
          <span className="destination-tag">This page</span>
          <span className="destination-type">USDC stream</span>
        </div>
        <div className="destination-main">
          <div>
            <span className="destination-label">Claimable USDC</span>
            <strong>{pendingUsdcNum.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</strong>
            <span className="destination-sub">Accrues in real time · claim anytime</span>
          </div>
          <div className="mini-route" aria-hidden="true">
            <span>staking</span>
            <i />
            <span>wallet</span>
          </div>
        </div>
        {props.isConnected ? (
          <button
            className="stake-cta brand-fill"
            disabled={props.pendingUsdc == null || props.pendingUsdc === 0n || claimUsdc.isPending}
            onClick={() => claimUsdc.run()}
          >
            {claimUsdc.isPending
              ? 'Claiming USDC…'
              : `Claim ${fmtUSD(pendingUsdcNum)} USDC →`}
          </button>
        ) : null}
      </div>

      <div className="claim-destination-card ants-destination">
        <div className="claim-destination-copy">
          <div className="claim-destination-top">
            <span className="destination-tag green">AntStation app</span>
            <span className="destination-type">$ANTS emissions</span>
          </div>
          <div className="destination-main ants-main">
            <div>
              <span className="destination-label">Pending $ANTS</span>
              <strong>{fmtNum(pendingAntsNum)}</strong>
              <span className="destination-sub">
                {claimableEpochs > 0 ? `${claimableEpochs} unprocessed epoch${claimableEpochs === 1 ? '' : 's'}` : 'No unprocessed epochs'}
              </span>
            </div>
          </div>
          <ol className="antstation-flow">
            <li><span>01</span> Install AntStation</li>
            <li><span>02</span> Open Payments</li>
            <li><span>03</span> Connect this wallet</li>
            <li><span>04</span> Claim $ANTS</li>
          </ol>
          {props.isConnected ? (
            <a
              href={antstationHref}
              target="_blank"
              rel="noopener noreferrer"
              className="stake-cta ghost ants-download-cta"
            >
              {antstationPlatform === 'mac'
                ? 'Install AntStation for Mac →'
                : antstationPlatform === 'win'
                  ? 'Install AntStation for Windows →'
                  : 'Install AntStation to claim $ANTS →'}
            </a>
          ) : null}
        </div>
        <div className="antstation-window" aria-hidden="true">
          <div className="window-bar"><span /><span /><span /></div>
          <div className="window-title">AntStation · Payments</div>
          <div className="window-row"><span>wallet</span><strong>same as staking</strong></div>
          <div className="window-row"><span>$ANTS</span><strong>ready</strong></div>
          <div className="window-claim">claim emissions →</div>
        </div>
      </div>

      {props.hasMoreClaimableAntsEpochs && (
        <div className="claim-note ants-claim-note">
          More $ANTS epochs may be available in AntStation after this batch.
        </div>
      )}

      {claimableEpochs > 0 && props.pendingAnts === 0n && (
        <div className="claim-note ants-claim-note">
          Some claimable epochs may have no $ANTS payout, but AntStation can still clear
          them so later epochs appear.
        </div>
      )}

      {claimUsdc.error && (
        <div className="claim-note" style={{ color: '#c62828' }}>
          {claimUsdc.error.message}
        </div>
      )}

      {!props.isConnected && <ConnectCta label="Connect wallet to view claims →" />}
    </div>
  );
}


function ConnectCta({ label }: { label: string }) {
  return (
    <ConnectButton.Custom>
      {({ openConnectModal }) => (
        <button className="stake-cta" onClick={openConnectModal}>
          {label}
        </button>
      )}
    </ConnectButton.Custom>
  );
}

function InputField(props: {
  label: string;
  balanceLabel: string;
  balanceValue: string;
  amt: string;
  setAmt: (v: string) => void;
  amtUsd: number | null;
  disabled?: boolean;
}) {
  return (
    <div className="field">
      <div className="field-label">
        <span>{props.label}</span>
        <span className="bal">{props.balanceLabel}: <strong>{props.balanceValue}</strong></span>
      </div>
      <div className="field-row">
        <input
          type="number"
          inputMode="decimal"
          placeholder="0.0"
          min="0"
          step="0.1"
          value={props.amt}
          onChange={(e) => props.setAmt(e.target.value)}
          disabled={props.disabled}
        />
        <span className="token-pill">
          <span className="icon-slot"><DiemLogo size={24} /></span>
          $DIEM
        </span>
      </div>
      <div className="field-usd">
        ≈ ${props.amtUsd != null ? props.amtUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'} USD
      </div>
    </div>
  );
}

function QuickSet({
  options,
  onSet,
}: {
  options: Array<{ label: string; value: string; disabled?: boolean }>;
  onSet: (v: string) => void;
}) {
  return (
    <div className="quick-set">
      {options.map((o) => (
        <button key={o.value} disabled={o.disabled} onClick={() => onSet(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}


function Metrics(props: {
  apy: number;
  pool: ReturnType<typeof usePoolStats>;
  poolAgeDays: number | null;
}) {
  return (
    <div className="metrics">
      <div className="metric">
        <div className="lbl">Total staked</div>
        <div className="val">{props.pool.totalStaked != null ? fmtDiemPrecise(toDiemNumber(props.pool.totalStaked)) : '—'}</div>
        <div className="delta">$DIEM</div>
      </div>
      <div className="metric">
        <div className="lbl">USDC distributed</div>
        <div className="val">
          {props.pool.totalUsdcDistributedEver != null
            ? fmtUSD(toUsdcNumber(props.pool.totalUsdcDistributedEver))
            : '—'}
        </div>
        <div className="delta">all time</div>
      </div>
      <div className="metric">
        <div className="lbl">USDC APY</div>
        <div className="val" style={{ color: 'var(--brand-dark)' }}>{fmtPct(props.apy)}</div>
        <div className="delta">
          {props.poolAgeDays != null ? `All-time avg · ${fmtNum(props.poolAgeDays, 1)}d` : 'Warming up'}
        </div>
      </div>
      <div className="metric">
        <div className="lbl">Active stakers</div>
        <div className="val">{props.pool.stakerCount != null ? fmtNum(props.pool.stakerCount) : '—'}</div>
        <div className="delta">live</div>
      </div>
    </div>
  );
}
