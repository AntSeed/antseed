import { useMemo } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, usePublicClient } from 'wagmi';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon, Plant01Icon } from '@hugeicons/core-free-icons';
import {
  type EmissionsPendingResponse,
  type EmissionsShares,
} from '../lib/api';
import {
  useConfig,
  useEmissionsInfo,
  useEmissionsPending,
  useEmissionsShares,
  useDiemScan,
} from '../hooks/queries';
import { useAppShell } from '../context/app-shell-context';
import { getErrorMessage } from '../lib/payment-network';
import {
  estimateEmissionReward,
  formatAnts,
  formatDurationHuman,
  safeBigint,
} from '../lib/format';
import { AntMark } from '../components/ui/ant-seed-logo';
import './earn-view.scss';

const DIEM_EPOCH_SCAN_LIMIT = 16;

interface DiemSummary {
  pending: bigint;
  claimableEpochs: number;
  finalizedEpoch: number;
}

function formatEpochEnd(unixSeconds: number): string {
  if (!unixSeconds) return '';
  try {
    return new Date(unixSeconds * 1000).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return '';
  }
}

function sumNetworkClaimable(rows: EmissionsPendingResponse['rows']): bigint {
  let total = 0n;
  for (const r of rows) {
    if (r.isCurrent) continue;
    if (!r.seller.claimed) total += safeBigint(r.seller.amount);
    if (!r.buyer.claimed) total += safeBigint(r.buyer.amount);
  }
  return total;
}

function countNetworkClaimableEpochs(rows: EmissionsPendingResponse['rows']): number {
  const ids = new Set<number>();
  for (const r of rows) {
    if (r.isCurrent) continue;
    const sellerHas = !r.seller.claimed && r.seller.amount !== '0';
    const buyerHas = !r.buyer.claimed && r.buyer.amount !== '0';
    if (sellerHas || buyerHas) ids.add(r.epoch);
  }
  return ids.size;
}

function estimateCurrentReward(
  row: EmissionsPendingResponse['rows'][number] | undefined,
  epochEmission: string,
  shares: EmissionsShares | null,
): bigint {
  if (!row || !shares) return 0n;
  return (
    estimateEmissionReward(epochEmission, shares.sellerSharePct, row.seller.userPoints, row.seller.totalPoints) +
    estimateEmissionReward(epochEmission, shares.buyerSharePct, row.buyer.userPoints, row.buyer.totalPoints)
  );
}

export function EarnView() {
  const { selectTab: onSelectTab } = useAppShell();
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();

  const { data: config = null } = useConfig();
  const buyerAddress = config?.evmAddress ?? null;
  const diemAddress = isConnected && address ? address : null;

  const { data: info = null } = useEmissionsInfo();
  const { data: pending = null } = useEmissionsPending(buyerAddress);
  const { data: shares = null } = useEmissionsShares();
  const diemQuery = useDiemScan(publicClient, diemAddress, DIEM_EPOCH_SCAN_LIMIT);

  const diem = useMemo<DiemSummary | null>(() => {
    const scan = diemQuery.data;
    if (!scan) return null;
    let pendingDiem = 0n;
    let claimableEpochs = 0;
    for (const row of scan.rows) {
      if (!row.claimed) {
        claimableEpochs += 1;
        pendingDiem += row.amount;
      }
    }
    return { pending: pendingDiem, claimableEpochs, finalizedEpoch: scan.finalizedRewardEpoch };
  }, [diemQuery.data]);

  const loadError = diemQuery.error
    ? getErrorMessage(diemQuery.error, 'Unable to load DIEM rewards.')
    : null;

  const pendingReady = !!pending;
  const networkLoading = !pending && !!buyerAddress;

  const currentRow = useMemo(() => pending?.rows.find((r) => r.isCurrent), [pending]);
  const networkClaimable = useMemo(
    () => (pending ? sumNetworkClaimable(pending.rows) : 0n),
    [pending],
  );
  const networkClaimableEpochs = useMemo(
    () => (pending ? countNetworkClaimableEpochs(pending.rows) : 0),
    [pending],
  );
  const currentEstimate = useMemo(
    () => estimateCurrentReward(currentRow, info?.epochEmission ?? '0', shares),
    [currentRow, info, shares],
  );

  const now = Math.floor(Date.now() / 1000);
  const epochStart = info ? info.genesis + info.currentEpoch * info.epochDuration : 0;
  const epochEnd = info ? epochStart + info.epochDuration : 0;
  const timeRemaining = info ? epochEnd - now : 0;
  const epochsUntilHalving = info ? info.halvingInterval - (info.currentEpoch % info.halvingInterval) : 0;

  return (
    <div className="earn-view">
      <section className="page-banner">
        <span className="page-banner-mark" aria-hidden="true">
          <HugeiconsIcon icon={Plant01Icon} size={20} strokeWidth={1.6} />
        </span>
        <div className="page-banner-content">
          <div className="page-banner-eyebrow">Earn</div>
          <h2 className="page-banner-heading">Stack $ANTS as the network grows</h2>
          <p className="page-banner-sub">
            Active sellers, buyers, and $DIEM stakers all earn $ANTS each epoch — no pre-mine,
            just on-chain participation.
          </p>
        </div>
        <div className="page-banner-actions">
          <button
            type="button"
            className="page-banner-action"
            onClick={() => onSelectTab('emissions')}
          >
            <span className="page-banner-action-icon" aria-hidden="true">
              <AntMark size={14} />
            </span>
            My $ANTS
            <HugeiconsIcon icon={ArrowRight01Icon} size={11} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="page-banner-action"
            onClick={() => onSelectTab('diem-rewards')}
          >
            <span className="page-banner-action-icon" aria-hidden="true">
              <img src="/diem-logo.png" width="14" height="14" alt="" />
            </span>
            My $DIEM
            <HugeiconsIcon icon={ArrowRight01Icon} size={11} strokeWidth={1.8} />
          </button>
        </div>
        <span className="page-banner-deco" aria-hidden="true" />
      </section>

      <section className="overview-section">
        <header className="overview-section-head">
          <div className="overview-section-eyebrow">Current epoch</div>
          <h2 className="overview-section-title">
            {info ? `Epoch #${info.currentEpoch}` : <span className="skel skel-line skel-line--title" />}
          </h2>
          <p className="overview-section-sub">
            {shares
              ? `Split: ${shares.sellerSharePct}% sellers · ${shares.buyerSharePct}% buyers · ${shares.reserveSharePct}% reserve · ${shares.teamSharePct}% team.`
              : 'Live emission window across the AntSeed network.'}
          </p>
        </header>

        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-card-label">Ends in</div>
            {info ? (
              <>
                <div className="stat-card-value">{formatDurationHuman(timeRemaining)}</div>
                <div className="stat-card-hint">{formatEpochEnd(epochEnd)}</div>
              </>
            ) : (
              <>
                <span className="skel skel-block skel-block--value" />
                <span className="skel skel-line skel-line--hint" />
              </>
            )}
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Epoch pool</div>
            {info ? (
              <>
                <div className="stat-card-value">{formatAnts(info.epochEmission)}</div>
                <div className="stat-card-hint">$ANTS this epoch</div>
              </>
            ) : (
              <>
                <span className="skel skel-block skel-block--value" />
                <span className="skel skel-line skel-line--hint" />
              </>
            )}
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Your estimate</div>
            {info && shares ? (
              <>
                <div className="stat-card-value">{formatAnts(currentEstimate)}</div>
                <div className="stat-card-hint">Updates each settlement</div>
              </>
            ) : (
              <>
                <span className="skel skel-block skel-block--value" />
                <span className="skel skel-line skel-line--hint" />
              </>
            )}
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Next halving</div>
            {info ? (
              <>
                <div className="stat-card-value">{epochsUntilHalving}</div>
                <div className="stat-card-hint">Epochs remaining</div>
              </>
            ) : (
              <>
                <span className="skel skel-block skel-block--value" />
                <span className="skel skel-line skel-line--hint" />
              </>
            )}
          </div>
        </div>
      </section>

      {buyerAddress && (!pendingReady || pending.rows.length > 0) && (
        <section className="overview-section">
          <header className="overview-section-head">
            <div className="overview-section-eyebrow">Activity</div>
            <h2 className="overview-section-title">Recent epochs</h2>
          </header>
          {pendingReady ? (
            <EarnHistory
              rows={pending.rows}
              epochEmission={info?.epochEmission ?? '0'}
              shares={shares}
              onOpen={() => onSelectTab('emissions')}
            />
          ) : (
            <div className="earn-history" aria-busy="true" aria-label="Loading recent epochs">
              {Array.from({ length: 5 }).map((_, i) => (
                <div className="earn-history-row" key={i}>
                  <span className="skel skel-line skel-line--cell" style={{ width: '40%' }} />
                  <span className="skel skel-line skel-line--cell" style={{ width: '50%' }} />
                  <span className="skel skel-pill" />
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="overview-section">
        <header className="overview-section-head">
          <div className="overview-section-eyebrow">Programs</div>
          <h2 className="overview-section-title">Two ways to earn</h2>
          <p className="overview-section-sub">
            Pick up where you left off — claim, or jump into each program for the full picture.
          </p>
        </header>
        <div className="earn-programs">
          <ProgramCard
            tone="ants"
            title="Network emissions"
            subtitle="Earn $ANTS each epoch from network activity."
            icon={<AntMark size={20} />}
            pending={networkClaimable}
            metaLabel="Claimable epochs"
            metaValue={networkClaimableEpochs > 0 ? String(networkClaimableEpochs) : '0'}
            ctaLabel={networkClaimable > 0n ? 'Claim' : 'View'}
            ctaActive={networkClaimable > 0n}
            onCta={() => onSelectTab('emissions')}
            loading={networkLoading}
          />
          <ProgramCard
            tone="diem"
            title="DIEM staking"
            subtitle="Rewards from $DIEM staked through the AntSeed proxy."
            icon={<img src="/diem-logo.png" width="22" height="22" alt="" aria-hidden="true" />}
            pending={diem?.pending ?? null}
            metaLabel={isConnected ? 'Claimable epochs' : 'Wallet'}
            metaValue={
              !isConnected
                ? 'Not connected'
                : diem
                  ? String(diem.claimableEpochs)
                  : '—'
            }
            ctaLabel={
              !isConnected
                ? null
                : (diem?.pending ?? 0n) > 0n
                  ? 'Claim'
                  : 'View'
            }
            ctaActive={isConnected && (diem?.pending ?? 0n) > 0n}
            onCta={() => onSelectTab('diem-rewards')}
            connectFallback={!isConnected ? <ConnectButton /> : null}
            loading={isConnected && !diem && diemQuery.isLoading}
          />
        </div>
      </section>

      {loadError && <div className="earn-error">{loadError}</div>}
    </div>
  );
}

interface ProgramCardProps {
  tone: 'ants' | 'diem';
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  pending: bigint | null;
  metaLabel: string;
  metaValue: string;
  ctaLabel: string | null;
  ctaActive: boolean;
  onCta: () => void;
  connectFallback?: React.ReactNode;
  loading?: boolean;
}

function ProgramCard({
  tone,
  title,
  subtitle,
  icon,
  pending,
  metaLabel,
  metaValue,
  ctaLabel,
  ctaActive,
  onCta,
  connectFallback,
  loading = false,
}: ProgramCardProps) {
  return (
    <article className={`earn-program earn-program--${tone}`}>
      <header className="earn-program-head">
        <span className="earn-program-icon">{icon}</span>
        <h3 className="earn-program-title">{title}</h3>
      </header>

      <p className="earn-program-sub">{subtitle}</p>

      {loading ? (
        <span className="skel skel-block skel-block--value" />
      ) : (
        <div className="earn-program-amount">
          <span className="earn-program-amount-value">
            {pending === null ? '—' : formatAnts(pending)}
          </span>
          <span className="earn-program-amount-unit">$ANTS pending</span>
        </div>
      )}

      <div className="earn-program-foot">
        <div className="earn-program-meta">
          <span className="earn-program-meta-label">{metaLabel}</span>
          {loading ? (
            <span className="skel skel-line skel-line--hint" />
          ) : (
            <span className="earn-program-meta-value">{metaValue}</span>
          )}
        </div>
        {loading ? (
          <span className="skel skel-pill" style={{ width: 80, height: 34, borderRadius: 999 }} />
        ) : connectFallback ?? (
          ctaLabel && (
            <button
              type="button"
              className={`earn-program-cta${ctaActive ? ' earn-program-cta--active' : ''}`}
              onClick={onCta}
            >
              {ctaLabel}
              <HugeiconsIcon icon={ArrowRight01Icon} size={12} strokeWidth={1.8} />
            </button>
          )
        )}
      </div>
    </article>
  );
}

interface EarnHistoryProps {
  rows: EmissionsPendingResponse['rows'];
  epochEmission: string;
  shares: EmissionsShares | null;
  onOpen: () => void;
}

function EarnHistory({ rows, epochEmission, shares, onOpen }: EarnHistoryProps) {
  const recent = rows.slice().reverse().slice(0, 5);
  return (
    <div className="earn-history">
      {recent.map((row) => {
        const amount = row.isCurrent
          ? estimateCurrentReward(row, epochEmission, shares)
          : safeBigint(row.seller.amount) + safeBigint(row.buyer.amount);
        const sellerDone = row.seller.claimed || row.seller.userPoints === '0';
        const buyerDone = row.buyer.claimed || row.buyer.userPoints === '0';
        const fullyClaimed = !row.isCurrent && sellerDone && buyerDone && (row.seller.claimed || row.buyer.claimed);
        const statusLabel = fullyClaimed
          ? 'Claimed'
          : row.isCurrent
            ? 'Estimate'
            : amount === 0n
              ? '—'
              : 'Claimable';
        return (
          <button key={row.epoch} type="button" className="earn-history-row" onClick={onOpen}>
            <span className="earn-history-epoch">#{row.epoch}</span>
            <span className="earn-history-amount">{formatAnts(amount)} $ANTS</span>
            <span className="earn-history-status">{statusLabel}</span>
          </button>
        );
      })}
    </div>
  );
}

