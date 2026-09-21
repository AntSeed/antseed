import { useMemo, useState, type MouseEvent } from 'react';
import type { ExtendRequest, MoveRequest, PoolConfigView, PoolView, PositionView } from '../../../src/api-types';
import { api } from '../api';
import { useEpochInfo } from '../app-context';
import { usePageData } from '../data';
import { epochStartAt, formatAnts, formatBps, formatEpochLength, formatUtcDate, shortAddress } from '../format';
import { ActionButton, ActionDialog } from './Confirm';
import { EpochCell } from './Epoch';
import { ErrorBox } from './Feedback';
import { Field, Select } from './Field';
import { LockSlider } from './LockSlider';
import { Menu } from './Menu';
import { Panel } from './Panel';
import { Pill } from './Pill';
import { Table, type Column } from './Table';
import { WithdrawAction } from './WithdrawAction';

type RowActionKind = 'move' | 'extend' | 'withdraw';

export function PositionsCard({ pools, enabled = true }: { pools: PoolView[]; enabled?: boolean }) {
  const page = usePageData(enabled ? 'positions:current' : null, api.positions);
  const [showClosed, setShowClosed] = useState(false);
  const [rowAction, setRowAction] = useState<{ id: number; kind: RowActionKind } | null>(null);

  const data = page.data;
  const allPositions = useMemo(() => data?.positions ?? [], [data]);
  const closedCount = useMemo(() => allPositions.filter((p) => !isOpenRow(p)).length, [allPositions]);
  const positions = useMemo(() => (showClosed ? allPositions : allPositions.filter(isOpenRow)), [allPositions, showClosed]);
  const actionRow = rowAction ? (positions.find((p) => p.id === rowAction.id) ?? null) : null;
  const poolById = useMemo(() => new Map(pools.map((p) => [p.agentId, p])), [pools]);

  const openRowAction = (id: number, kind: RowActionKind) => {
    setRowAction({ id, kind });
  };

  const stop = (e: MouseEvent) => e.stopPropagation();

  const columns: Array<Column<PositionView>> = [
    {
      key: 'seller',
      label: 'Seller',
      render: (p) => {
        const pool = poolById.get(p.agentId);
        return (
          <span title={pool?.seller ?? undefined}>
            {pool?.profile?.name?.trim() || (pool?.seller ? shortAddress(pool.seller) : 'Unknown seller')}
          </span>
        );
      },
    },
    { key: 'amount', label: 'Amount', align: 'right', mono: true, render: (p) => formatAnts(p.amount, 4) },
    {
      key: 'unlocks',
      label: 'Unlocks',
      title: 'Epoch and date when the lock expires. Funds are not withdrawn automatically.',
      render: (p) => (!isOpen(p) ? <span className="muted">—</span> : p.maxLocked ? <span className="muted" title="This position's lock does not count down automatically. Lock-management controls are currently unavailable in this dashboard.">No scheduled unlock</span> : <EpochCell epoch={p.stakeEndEpoch} />),
    },
    { key: 'state', label: 'Status', title: 'The current stage of this staking position.', render: (p) => <StateBadge state={p.state} /> },
    { key: 'reward', label: 'Pending reward', align: 'right', mono: true, render: (p) => formatAnts(p.pendingReward, 4) },
    {
      key: 'actions',
      label: '',
      align: 'right',
      className: 'col-actions',
      render: (p) =>
        isOpen(p) ? (
          <span className="row-nowrap" onClick={stop}>
            <Menu
              label={`More actions for position ${p.id}`}
              items={[
                { label: 'Move allocation', onSelect: () => openRowAction(p.id, 'move') },
                { label: 'Extend', onSelect: () => openRowAction(p.id, 'extend') },
                { label: 'Withdraw', onSelect: () => openRowAction(p.id, 'withdraw') },
              ]}
            />
          </span>
        ) : null,
    },
  ];

  return (
    <Panel
      title={`Your positions${data ? ` (${positions.length})` : ''}`}
      className="positions-card"
      actions={
        closedCount > 0 ? (
          <button type="button" className="link-button" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? 'hide closed' : `show ${closedCount} closed`}
          </button>
        ) : null
      }
    >
      {page.error && !data ? <ErrorBox error={page.error} onRetry={page.refresh} /> : null}
      {page.error && data ? <div className="status-line">Refresh failed: {page.error}</div> : null}
      {data?.displaySource?.source === 'indexer' ? <p className="hint">Position records from Antscan at block {data.displaySource.indexedBlock}. Rewards and withdrawal checks are read live.</p> : null}
      {data?.displaySource?.error ? <p className="hint">Antscan position data unavailable: {data.displaySource.error}. Showing live wallet positions.</p> : null}
      {data?.historySource === 'local' ? <p className="hint">Includes closed positions from verified local transactions. Older history may be incomplete without an indexer.</p> : null}
      {data?.historySource === 'chain' ? <div className="status-line">Closed-position history is unavailable. Open positions are shown from the chain; rewards on closed positions may be missing.</div> : null}
      {rowAction && actionRow && data ? <RowActionPanel key={`${rowAction.id}:${rowAction.kind}`} kind={rowAction.kind} position={actionRow} config={data.config} pools={pools} onClose={() => setRowAction(null)} /> : null}
      <Table
        columns={columns}
        rows={positions}
        rowKey={(p) => p.id}
        loading={page.loading && !data}
        empty={enabled ? "No open positions. Stake ANTS into a pool to open one." : "Connect a wallet to see your positions."}
      />
    </Panel>
  );
}

function isOpen(p: PositionView): boolean {
  return !p.withdrawn && p.closedAtEpoch === 0 && p.state !== 'withdrawn' && p.state !== 'closed';
}

/** Rows shown by default: closed sources (split, merge, move) and withdrawn positions are behind the toggle. */
function isOpenRow(p: PositionView): boolean {
  return p.state !== 'closed' && p.state !== 'withdrawn';
}

function StateBadge({ state }: { state: PositionView['state'] }) {
  const tone = state === 'active' ? 'accent' : state === 'pending' ? 'amber' : 'muted';
  const descriptions: Record<PositionView['state'], string> = {
    pending: 'Waiting for the stake activation epoch.',
    active: 'The staking position is active and its lock has not expired.',
    matured: 'The lock has expired. Withdraw to receive your funds; withdrawal is not automatic.',
    closed: 'This position has been closed, for example by a split, merge, or move.',
    withdrawn: 'Funds have been withdrawn from this position.',
  };
  return <Pill tone={tone} title={descriptions[state]}>{state}</Pill>;
}

function allocationSellerName(agentId: number, pools: PoolView[]): string {
  const pool = pools.find(pool => pool.agentId === agentId);
  return pool?.profile?.name?.trim() || (pool?.seller ? shortAddress(pool.seller) : 'Unknown seller');
}

export function PositionSummary({ position, pools }: { position: PositionView; pools: PoolView[] }) {
  const info = useEpochInfo();
  const remaining = position.epochsRemaining;
  const unlockDate = info ? formatUtcDate(epochStartAt(position.stakeEndEpoch, info.genesis, info.epochDuration)) : null;
  const startDate = info ? formatUtcDate(epochStartAt(position.stakeStartEpoch, info.genesis, info.epochDuration)) : null;
  return (
    <div>
      <div>{allocationSellerName(position.agentId, pools)} · <span className="mono">{formatAnts(position.amount, 4)} ANTS</span></div>
      <div className="muted small">
        {position.maxLocked ? 'No scheduled unlock — the lock does not count down automatically.' : position.state === 'matured' ? 'Lock expired' : !isOpen(position) ? 'Position closed' : <>
          {position.state === 'pending' ? 'Lock duration' : 'Remaining lock'}: {remaining} {remaining === 1 ? 'epoch' : 'epochs'}
          {info ? ` (${position.state === 'pending' ? '' : 'up to '}${formatEpochLength(remaining * info.epochDuration)})` : ''}
          {position.state === 'pending' ? ` · starts ${startDate ? `${startDate} UTC` : `epoch ${position.stakeStartEpoch}`}` : ''}
        </>}
        {!position.maxLocked && isOpen(position) ? ` · ${position.state === 'matured' ? 'unlocked' : 'unlocks'} ${unlockDate ? `${unlockDate} UTC` : `epoch ${position.stakeEndEpoch}`}` : ''}
      </div>
    </div>
  );
}

function MoveForm({ position, config, pools, onStarted }: { position: PositionView; config: PoolConfigView; pools: PoolView[]; onStarted: () => void }) {
  const info = useEpochInfo();
  const targets = pools.filter((pool) => pool.stakeable && pool.agentId !== position.agentId);
  const [toAgent, setToAgent] = useState(() => String(targets[0]?.agentId ?? ''));
  const target = targets.find((p) => String(p.agentId) === toAgent) ?? null;
  const body: MoveRequest = { positionIds: [position.id], toAgentId: Number(toAgent) };
  const problem = position.maxLocked ? 'Disable maximum lock first, then wait for it to take effect.' : position.changePending ? 'A position change is pending. Wait until it takes effect.' : position.state === 'matured' || !isOpen(position) ? 'Only open positions with a remaining lock can move.' : null;
  const effective = Math.max((info?.current ?? 0) + 1, position.stakeStartEpoch);
  return (
    <div className="form-row">
      <p className="hint">Move your allocation directly to another seller. Principal stays staked and the lock end date is preserved. Accrued rewards remain claimable on the source position.</p>
      <p className="hint">Effective {info ? `${formatUtcDate(epochStartAt(effective, info.genesis, info.epochDuration))} UTC (epoch ${effective})` : `epoch ${effective}`}. One transaction; your wallet will ask you to approve it.</p>
      {problem && <p className="error-text">{problem}</p>}
      <Field label="To seller" hint={config.moveWeightPenaltyBps === 0 ? 'No move penalty is currently configured. Moving does not burn your ANTS.' : `Moving reduces future staking power by ${formatBps(config.moveWeightPenaltyBps)}. Your ANTS principal is not burned.`} width="lg">
        <Select value={toAgent} onChange={(e) => setToAgent(e.target.value)} disabled={targets.length === 0}>
          {targets.length === 0 ? <option value="">No other seller to move to</option> : null}
          {targets.map((p) => (
            <option key={p.agentId} value={p.agentId}>
              {allocationSellerName(p.agentId, pools)}
            </option>
          ))}
        </Select>
      </Field>
      <ActionButton
        label="Move allocation"
        disabled={problem !== null}
        disabledReason={problem ?? undefined}
        variant="primary"
        path="/api/positions/move"
        body={body}
        validate={() => !target ? 'Choose a target seller.' : null}
        onStarted={onStarted}
      />
    </div>
  );
}

interface RowActionProps {
  kind: RowActionKind;
  position: PositionView;
  config: PoolConfigView;
  pools?: PoolView[];
  onClose: () => void;
}

export function RowActionPanel({ kind, position, config, pools = [], onClose }: RowActionProps) {
  const info = useEpochInfo();
  const effectiveEpoch = info ? info.current + 1 : null;
  const extensionStart = effectiveEpoch === null ? null : Math.max(position.stakeEndEpoch, effectiveEpoch);
  const maxAdd = extensionStart === null || effectiveEpoch === null ? 0 : Math.max(config.maxStakeEpochs - (extensionStart - effectiveEpoch), 0);
  const [epochs, setEpochs] = useState(Math.min(1, maxAdd) || 1);
  const title = kind === 'move' ? 'Move allocation' : kind === 'extend' ? 'Extend position' : 'Withdraw positions';

  const extendBody: ExtendRequest = { positionId: position.id, epochs };
  const validateExtend = (): string | null => {
    if (maxAdd <= 0) return `This position is already at the maximum lock (${config.maxStakeEpochs} epochs).`;
    if (epochs < 1 || epochs > maxAdd) return `At most ${maxAdd} more epoch(s) can be added (max lock ${config.maxStakeEpochs}).`;
    return null;
  };

  return (
    <ActionDialog title={title} onClose={onClose}>
      {kind !== 'extend' ? <div className="small mb">
        <PositionSummary position={position} pools={pools} />
      </div> : null}
      {kind === 'withdraw' ? (
        <div className="stack">
          {position.changePending ? <div className="error-text">This position changed this epoch; the preview will be rejected until the next epoch.</div> : null}
          <WithdrawAction positionId={position.id} autoOpen onStarted={onClose} onCancel={onClose} />
        </div>
      ) : null}
      {kind === 'move' ? <MoveForm position={position} config={config} pools={pools} onStarted={onClose} /> : null}
      {kind === 'extend' ? (
        <div className="stack">
          <dl className="facts">
            <dt>Amount</dt>
            <dd>{formatAnts(position.amount, 4)} ANTS</dd>
            <dt>Current unlock time</dt>
            <dd>{position.maxLocked ? 'No scheduled unlock' : <EpochCell epoch={position.stakeEndEpoch} dateOnly />}</dd>
          </dl>
          <LockSlider label="Add" value={epochs} min={1} max={Math.max(maxAdd, 1)} startEpoch={extensionStart} onChange={setEpochs} disabled={maxAdd <= 0} showUnlockDate={false} />
          <dl className="facts" aria-live="polite">
            <dt>New unlock date</dt>
            <dd><EpochCell epoch={extensionStart !== null && maxAdd > 0 && !position.maxLocked ? extensionStart + epochs : null} dateOnly /></dd>
          </dl>
          <ActionButton
            label="Extend"
            variant="primary"
            path="/api/positions/extend"
            body={extendBody}
            validate={validateExtend}
            onStarted={onClose}
          />
        </div>
      ) : null}
    </ActionDialog>
  );
}
