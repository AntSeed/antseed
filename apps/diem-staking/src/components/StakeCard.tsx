// The core interactive surface: tabbed Stake / Unstake / Claim card, wired
// to the live on-chain reads + write hooks. Every displayed number is live.

import { useEffect, useMemo, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import { parseEther } from 'viem';

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
  useClaimAnts,
} from '../lib/actions';
import {
  fmtDiem,
  fmtDuration,
  fmtNum,
  fmtPct,
  fmtUSD,
  toAntsNumber,
  toDiemNumber,
  toUsdcNumber,
} from '../lib/format';
import { EPOCHS_PER_YEAR } from '../lib/epoch';

type Tab = 'stake' | 'unstake' | 'claim';

export interface StakeCardProps {
  diemPrice: number | null;
  lastEpochUsdc: bigint | null;
  apr: number;
}

export function StakeCard({ diemPrice, lastEpochUsdc, apr }: StakeCardProps) {
  const [tab, setTab] = useState<Tab>('stake');
  const [amt, setAmt] = useState('10');
  const { isConnected } = useAccount();
  const { epoch, remainingSecs } = useEpochClock();

  const pool = usePoolStats();
  const user = useUserStats();

  // Auto-reset default amount when switching tabs so the quick-set buttons
  // feel fresh each time.
  const onChangeTab = (next: Tab) => {
    setTab(next);
    if (next === 'stake') setAmt('10');
    if (next === 'unstake') setAmt(user.stakedDiem ? fmtDiem(toDiemNumber(user.stakedDiem)) : '0');
  };

  // Projection math — all derived from the live lastEpochUsdc and pool TVL.
  // If either is null the numbers drop to "—" via fmtUSD.
  const diemValue = parseFloat(amt) || 0;
  const poolDiem = toDiemNumber(pool.totalStaked);
  const usdcPerDiemPerEpoch = poolDiem > 0 && lastEpochUsdc ? toUsdcNumber(lastEpochUsdc) / poolDiem : null;
  const usdcPerEpoch = usdcPerDiemPerEpoch != null ? diemValue * usdcPerDiemPerEpoch : null;
  const usdcPerYear = usdcPerEpoch != null ? usdcPerEpoch * EPOCHS_PER_YEAR : null;
  const usdcPerMonth = usdcPerYear != null ? usdcPerYear / 12 : null;
  const amtUsd = diemPrice != null ? diemValue * diemPrice : null;

  const quickSet = (v: string) => {
    if (v === 'max') {
      if (tab === 'stake' && user.walletDiem != null) setAmt(String(toDiemNumber(user.walletDiem)));
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
            setAmt={setAmt}
            setQuick={quickSet}
            isConnected={isConnected}
            amtUsd={amtUsd}
            walletDiem={user.walletDiem}
            poolTotalStaked={pool.totalStaked}
            maxTotalStake={pool.maxTotalStake}
            usdcPerEpoch={usdcPerEpoch}
            usdcPerMonth={usdcPerMonth}
            usdcPerYear={usdcPerYear}
            apr={apr}
          />
        )}

        {tab === 'unstake' && (
          <UnstakePanel
            amt={amt}
            setAmt={setAmt}
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
        apr={apr}
        pool={pool}
        lastEpochUsdc={lastEpochUsdc}
      />

      <FlowDiagram />
    </div>
  );
}

// ─── Stake panel ─────────────────────────────────────────────────────────

interface StakePanelProps {
  amt: string;
  setAmt: (v: string) => void;
  setQuick: (v: string) => void;
  isConnected: boolean;
  amtUsd: number | null;
  walletDiem: bigint | null;
  poolTotalStaked: bigint | null;
  maxTotalStake: bigint | null;
  usdcPerEpoch: number | null;
  usdcPerMonth: number | null;
  usdcPerYear: number | null;
  apr: number;
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

  const disabled =
    !props.isConnected ||
    amtInvalid ||
    parsedAmt === 0n ||
    insufficientBalance ||
    capExceeded ||
    stake.isPending ||
    approve.isPending;

  return (
    <>
      <InputField
        label="You stake"
        balanceLabel="Wallet"
        balanceValue={props.isConnected ? `${fmtDiem(toDiemNumber(props.walletDiem))} $DIEM` : 'Connect'}
        amt={props.amt}
        setAmt={props.setAmt}
        amtUsd={props.amtUsd}
      />
      <QuickSet
        options={[
          { label: '1', value: '1' },
          { label: '10', value: '10' },
          { label: '100', value: '100' },
          { label: '1,000', value: '1000' },
          { label: 'Max', value: 'max' },
        ]}
        onSet={props.setQuick}
      />

      <div className="yield-box">
        <div className="yield-row hero-row">
          <span className="lbl">Projected USDC<span className="sub">extrapolated from last 7 days</span></span>
          <span className="val">{props.usdcPerEpoch != null ? `${fmtUSD(props.usdcPerEpoch)} / week` : '—'}</span>
        </div>
        <div className="yield-row">
          <span className="lbl">Per month</span>
          <span className="val">{props.usdcPerMonth != null ? fmtUSD(props.usdcPerMonth) : '—'} <span className="unit">USDC</span></span>
        </div>
        <div className="yield-row">
          <span className="lbl">Per year</span>
          <span className="val">{props.usdcPerYear != null ? fmtUSD(props.usdcPerYear) : '—'} <span className="unit">USDC</span></span>
        </div>
        <div className="yield-row">
          <span className="lbl">USDC APR<span className="sub">rolling 7d · annualized</span></span>
          <span className="val" style={{ color: 'var(--brand-dark)' }}>{fmtPct(props.apr)}</span>
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
    </>
  );
}

// ─── Unstake panel + queue state machine ─────────────────────────────────

interface UnstakePanelProps {
  amt: string;
  setAmt: (v: string) => void;
  setQuick: (v: string) => void;
  isConnected: boolean;
  stakedDiem: bigint | null;
  amtUsd: number | null;
  diemCooldownSecs: number | null;
  /** Minimum batch-open window (seconds). Owner-settable; 0 = disabled. */
  minUnstakeBatchOpenSecs: number | null;
  /** Unix timestamp at which the currently-open batch can first be flushed. */
  flushableAt: number | null;
}

function UnstakePanel(props: UnstakePanelProps) {
  const initiate = useInitiateUnstake();
  // Single source of truth for the unstake state machine — read here, passed
  // down into UnstakeStateView so we don't set up two identical wagmi
  // subscriptions on the same keys.
  const { state } = useUnstakeState();

  const stakedNum = toDiemNumber(props.stakedDiem);
  let parsedAmt: bigint = 0n;
  try {
    parsedAmt = props.amt ? parseEther(props.amt) : 0n;
  } catch {
    /* invalid */
  }
  const amountTooLarge = props.stakedDiem != null && parsedAmt > props.stakedDiem;
  const disabled = !props.isConnected || parsedAmt === 0n || amountTooLarge || initiate.isPending;

  return (
    <>
      {/* Always-visible educational note — this is the UX best-practice bit
          that the author's original "1-day cooldown" copy couldn't convey. */}
      <div className="claim-note">
        <strong>Three-step unstake.</strong> Unstakes are batched on-chain.
        You'll see <code>queued</code> → <code>cooling down</code> → <code>claimable</code>.
        Each state advances with a tx that <em>any</em> user in your batch can trigger,
        so you'll often find yours has moved when you check back. After the first
        queuer opens a batch, it stays open for at least the minimum batch window
        (currently {props.minUnstakeBatchOpenSecs != null ? fmtDuration(props.minUnstakeBatchOpenSecs) : '—'})
        so other stakers get a predictable chance to join before it leaves. Total wait ≈
        batch window + Venice's cooldown ({props.diemCooldownSecs != null ? fmtDuration(props.diemCooldownSecs) : '—'}).
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
              className="stake-cta ghost"
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
    </>
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

  // Keep countdown ticking for both `cooling` (Venice cooldown) and `queued`
  // (batch-open window before flush is allowed). The queued tick is cheap:
  // it only runs while the user actually has an active unstake.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (state.status !== 'cooling' && state.status !== 'queued') return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [state.status]);

  if (state.status === 'none') return null;

  const amountDiem = fmtDiem(toDiemNumber(state.amount));

  if (state.status === 'queued') {
    // Three sub-states, in priority order:
    //   1. Waiting for prior batch to be claimed (protocol serialization).
    //   2. Waiting for the minimum batch-open window to elapse.
    //   3. Ready to flush.
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

  // claimable
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

// ─── Claim panel ─────────────────────────────────────────────────────────

interface ClaimPanelProps {
  isConnected: boolean;
  pendingUsdc: bigint | null;
  pendingAnts: bigint | null;
  claimableAntsEpochs: number[];
}

function ClaimPanel(props: ClaimPanelProps) {
  const claimUsdc = useClaimUsdc();
  const claimAnts = useClaimAnts();
  const { href: antstationHref, platform: antstationPlatform } = useAntstationDownload();

  const pendingUsdcNum = toUsdcNumber(props.pendingUsdc);
  const pendingAntsNum = toAntsNumber(props.pendingAnts);

  const claimableEpochs = props.claimableAntsEpochs.length;

  return (
    <>
      <div className="claim-grid">
        <div className="claim-stat">
          <span className="lbl">Claimable USDC</span>
          <span className="big">${pendingUsdcNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          <span className="sub">accrues in real time · claim anytime</span>
        </div>
        <div className="claim-stat">
          <span className="lbl">Pending $ANTS</span>
          <span className="big">{fmtNum(pendingAntsNum)}</span>
          <span className="sub">
            {claimableEpochs > 0 ? `across ${claimableEpochs} epoch${claimableEpochs === 1 ? '' : 's'}` : 'no unclaimed epochs'}
          </span>
        </div>
      </div>

      <div className="claim-note">
        Claim both on-chain here. <strong>Spend your $ANTS inside AntStation</strong> — the AntSeed desktop app lets you use them on any model on the network. Same wallet, auto-synced.
      </div>

      {props.isConnected ? (
        <>
          <button
            className="stake-cta brand-fill"
            disabled={props.pendingUsdc == null || props.pendingUsdc === 0n || claimUsdc.isPending}
            onClick={() => claimUsdc.run()}
            style={{ marginBottom: 10 }}
          >
            {claimUsdc.isPending
              ? 'Claiming USDC…'
              : `Claim ${fmtUSD(pendingUsdcNum)} USDC →`}
          </button>
          <button
            className="stake-cta"
            disabled={claimableEpochs === 0 || claimAnts.isPending}
            onClick={() => claimAnts.run(props.claimableAntsEpochs)}
            style={{ marginBottom: 10 }}
          >
            {claimAnts.isPending
              ? 'Claiming $ANTS…'
              : pendingAntsNum > 0
                ? `Claim ${fmtNum(pendingAntsNum)} $ANTS →`
                : 'Claim $ANTS →'}
          </button>
          <a
            href={antstationHref}
            target="_blank"
            rel="noopener noreferrer"
            className="stake-cta ghost"
            style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}
          >
            {antstationPlatform === 'mac'
              ? 'Download AntStation for Mac →'
              : antstationPlatform === 'win'
                ? 'Download AntStation for Windows →'
                : 'Download AntStation to spend $ANTS →'}
          </a>
          {(claimUsdc.error || claimAnts.error) && (
            <div className="claim-note" style={{ color: '#c62828' }}>
              {(claimUsdc.error ?? claimAnts.error)?.message}
            </div>
          )}
        </>
      ) : (
        <ConnectCta label="Connect wallet to view claims →" />
      )}
    </>
  );
}

// ─── Small shared subcomponents ──────────────────────────────────────────

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

function QuickSet({ options, onSet }: { options: Array<{ label: string; value: string }>; onSet: (v: string) => void }) {
  return (
    <div className="quick-set">
      {options.map((o) => (
        <button key={o.value} onClick={() => onSet(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

// ─── Metrics row ─────────────────────────────────────────────────────────

function Metrics(props: {
  apr: number;
  pool: ReturnType<typeof usePoolStats>;
  lastEpochUsdc: bigint | null;
}) {
  return (
    <div className="metrics">
      <div className="metric">
        <div className="lbl">Total staked</div>
        <div className="val">{props.pool.totalStaked != null ? fmtNum(toDiemNumber(props.pool.totalStaked)) : '—'}</div>
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
        <div className="lbl">USDC APR</div>
        <div className="val" style={{ color: 'var(--brand-dark)' }}>{fmtPct(props.apr)}</div>
        <div className="delta">
          {props.lastEpochUsdc != null ? `Rolling 7d · annualized` : 'Warming up'}
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
