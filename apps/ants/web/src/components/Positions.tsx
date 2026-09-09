import { Button } from './ui';
import { useMemo, useState, type MouseEvent } from 'react';
import type { ExtendRequest, MaxLockRequest, MergeRequest, MoveRequest, PoolConfigView, PoolView, PositionView, SplitRequest } from '../../../src/api-types';
import { api } from '../api';
import { useEpochInfo } from '../app-context';
import { usePageData } from '../data';
import { epochStartAt, formatAnts, formatBps, formatUtcDate, isPositiveDecimal, parseUnits, shortAddress } from '../format';
import { ActionButton } from './Confirm';
import { EpochCell } from './Epoch';
import { ErrorBox } from './Feedback';
import { Field, Input, Select } from './Field';
import { LockSlider } from './LockSlider';
import { Menu } from './Menu';
import { Panel } from './Panel';
import { Pill } from './Pill';
import { poolLabel } from './Pools';
import { Table, type Column } from './Table';
import { WithdrawAction } from './WithdrawAction';

type RowActionKind = 'split' | 'extend' | 'max-lock' | 'withdraw';
type BulkKind = 'move' | 'merge' | 'withdraw';

/** "Your positions" card: six columns, row-level Withdraw and ⋯ menu, click-to-expand detail, bulk bar once something is selected. */
export function PositionsCard({ pools }: { pools: PoolView[] }) {
  const page = usePageData('positions:current', api.positions);
  const [showClosed, setShowClosed] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [expanded, setExpanded] = useState<number | null>(null);
  const [rowAction, setRowAction] = useState<{ id: number; kind: RowActionKind } | null>(null);
  const [bulk, setBulk] = useState<BulkKind | null>(null);

  const data = page.data;
  const allPositions = useMemo(() => data?.positions ?? [], [data]);
  const closedCount = useMemo(() => allPositions.filter((p) => !isOpenRow(p)).length, [allPositions]);
  const positions = useMemo(() => (showClosed ? allPositions : allPositions.filter(isOpenRow)), [allPositions, showClosed]);
  const selectedRows = useMemo(() => positions.filter((p) => selected.has(p.id)), [positions, selected]);
  const actionRow = rowAction ? (positions.find((p) => p.id === rowAction.id) ?? null) : null;
  const poolById = useMemo(() => new Map(pools.map((p) => [p.agentId, p])), [pools]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectable = positions.filter(isOpen);
  const allSelected = selectable.length > 0 && selectable.every((p) => selected.has(p.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectable.map((p) => p.id)));
  const clearSelection = () => {
    setSelected(new Set());
    setBulk(null);
  };
  const openBulk = (kind: BulkKind, ids: number[]) => {
    setRowAction(null);
    setSelected(new Set(ids));
    setBulk(kind);
  };
  const openRowAction = (id: number, kind: RowActionKind) => {
    setBulk(null);
    setRowAction({ id, kind });
  };

  const stop = (e: MouseEvent) => e.stopPropagation();

  const columns: Array<Column<PositionView>> = [
    {
      key: 'select',
      label: <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all open positions" disabled={selectable.length === 0} />,
      className: 'col-select',
      render: (p) =>
        isOpen(p) ? (
          <span onClick={stop}>
            <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Select position ${p.id}`} />
          </span>
        ) : null,
    },
    { key: 'id', label: 'ID', mono: true, render: (p) => `#${p.id}` },
    {
      key: 'pool',
      label: 'Pool',
      render: (p) => {
        const pool = poolById.get(p.agentId);
        return (
          <span>
            <span className="mono">{p.agentId}</span>
            {pool?.seller ? <span className="muted small mono"> {shortAddress(pool.seller)}</span> : null}
          </span>
        );
      },
    },
    { key: 'amount', label: 'Amount', align: 'right', mono: true, render: (p) => formatAnts(p.amount, 4) },
    {
      key: 'unlocks',
      label: 'Unlocks',
      render: (p) => (!isOpen(p) ? <span className="muted">—</span> : p.maxLocked ? <span className="muted">max lock</span> : <EpochCell epoch={p.stakeEndEpoch} />),
    },
    { key: 'state', label: 'State', render: (p) => <StateBadge state={p.state} /> },
    { key: 'reward', label: 'Pending reward', align: 'right', mono: true, render: (p) => formatAnts(p.pendingReward, 4) },
    {
      key: 'actions',
      label: '',
      align: 'right',
      className: 'col-actions',
      render: (p) =>
        isOpen(p) ? (
          <span className="row-nowrap" onClick={stop}>
            <Button variant="outline" size="sm" onClick={() => openRowAction(p.id, 'withdraw')}>
              Withdraw
            </Button>
            <Menu
              label={`More actions for position ${p.id}`}
              items={[
                { label: 'Move', onSelect: () => openBulk('move', [p.id]) },
                { label: 'Split', onSelect: () => openRowAction(p.id, 'split') },
                { label: 'Merge', onSelect: () => openBulk('merge', [...new Set([...selected, p.id])]) },
                { label: 'Extend', onSelect: () => openRowAction(p.id, 'extend') },
                { label: p.maxLocked ? 'Max lock off' : 'Max lock on', onSelect: () => openRowAction(p.id, 'max-lock') },
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
      {selected.size > 0 ? (
        <div className="bulk-bar">
          <span className="muted small">
            <span className="mono">{selected.size}</span> selected
          </span>
          <Button variant="outline" size="sm" onClick={() => setBulk('move')}>
            Move
          </Button>
          <Button variant="outline" size="sm" disabled={selected.size < 2} onClick={() => setBulk('merge')}>
            Merge
          </Button>
          <Button variant="outline" size="sm" onClick={() => setBulk('withdraw')}>
            Withdraw
          </Button>
          <button className="link-button" onClick={clearSelection} type="button">
            clear
          </button>
        </div>
      ) : null}
      {bulk && data ? <BulkPanel kind={bulk} rows={selectedRows} config={data.config} pools={pools} onClose={() => setBulk(null)} onStarted={clearSelection} /> : null}
      {rowAction && actionRow && data ? <RowActionPanel kind={rowAction.kind} position={actionRow} config={data.config} onClose={() => setRowAction(null)} /> : null}
      <Table
        columns={columns}
        rows={positions}
        rowKey={(p) => p.id}
        loading={page.loading && !data}
        isSelected={(p) => selected.has(p.id)}
        onRowClick={(p) => setExpanded((cur) => (cur === p.id ? null : p.id))}
        renderDetail={(p) => (expanded === p.id ? <PositionDetail position={p} /> : null)}
        empty="No open positions. Stake ANTS into a pool to open one."
      />
    </Panel>
  );
}

function isOpen(p: PositionView): boolean {
  return !p.withdrawn && p.state !== 'withdrawn';
}

/** Rows shown by default: closed sources (split, merge, move) and withdrawn positions are behind the toggle. */
function isOpenRow(p: PositionView): boolean {
  return p.state !== 'closed' && p.state !== 'withdrawn';
}

function StateBadge({ state }: { state: PositionView['state'] }) {
  const tone = state === 'active' ? 'accent' : state === 'pending' ? 'amber' : 'muted';
  return <Pill tone={tone}>{state}</Pill>;
}

/** Expanded line under a row: the numbers that are hidden from the table by default. */
function PositionDetail({ position: p }: { position: PositionView }) {
  const info = useEpochInfo();
  const bps = p.slashBps ?? p.projectedSlashBps;
  const projected = p.slashBps === null;
  const startDate = info ? formatUtcDate(epochStartAt(p.stakeStartEpoch, info.genesis, info.epochDuration)) : null;
  return (
    <div className="row-detail">
      <span>
        Weight <span className="mono">{formatAnts(p.weightAmount, 4)}</span>
      </span>
      <span>
        Start epoch <span className="mono">{p.stakeStartEpoch}</span>
        {startDate ? <span className="dim mono"> {startDate}</span> : null}
      </span>
      {isOpen(p) ? (
        <span>
          Epochs left <span className="mono">{p.epochsRemaining}</span>
        </span>
      ) : null}
      <span>
        Change pending{' '}
        {p.changePending ? (
          <Pill tone="amber" title="Changed this epoch; takes effect next epoch. Withdraw is blocked until then.">
            yes
          </Pill>
        ) : (
          <span className="mono">no</span>
        )}
      </span>
      {isOpen(p) ? (
        <span>
          Early-exit slash <span className={`mono ${bps > 0 ? 'danger' : ''}`}>{formatBps(bps)}</span>
          <span className="dim"> {projected ? 'projected' : 'on-chain'}</span>
          <span className="muted">
            {' '}
            · burn <span className="mono">{formatAnts(p.slashedAmount, 4)}</span> · return <span className="mono">{formatAnts(p.returnedAmount, 4)}</span>
          </span>
        </span>
      ) : null}
      {p.closedAtEpoch > 0 ? (
        <span>
          Closed at epoch <span className="mono">{p.closedAtEpoch}</span>
        </span>
      ) : null}
    </div>
  );
}

interface BulkProps {
  kind: BulkKind;
  rows: PositionView[];
  config: PoolConfigView;
  pools: PoolView[];
  onClose: () => void;
  onStarted: () => void;
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      Close
    </Button>
  );
}

function BulkPanel({ kind, rows, config, pools, onClose, onStarted }: BulkProps) {
  const ids = rows.map((p) => p.id);
  const idList = <span className="mono">{ids.map((id) => `#${id}`).join(', ') || '—'}</span>;
  const total = formatAnts(rows.reduce((sum, p) => sum + BigInt(p.amount), 0n), 4);
  return (
    <Panel tone="accent" className="panel-inset" title={kind === 'move' ? 'Move positions' : kind === 'merge' ? 'Merge positions' : 'Withdraw positions'} actions={<CloseButton onClick={onClose} />}>
      <div className="small mb">
        {rows.length} position(s): {idList} · total <span className="mono">{total} ANTS</span>
      </div>
      {rows.length === 0 ? <div className="muted">Selected positions are no longer in the list.</div> : null}
      {kind === 'move' && rows.length > 0 ? <MoveForm rows={rows} idList={idList} config={config} pools={pools} onStarted={onStarted} /> : null}
      {kind === 'merge' && rows.length > 0 ? <MergeForm rows={rows} idList={idList} onStarted={onStarted} /> : null}
      {kind === 'withdraw' && rows.length > 0 ? (
        <div className="stack">
          {rows.some((p) => p.changePending) ? <div className="error-text">A selected position changed this epoch; the preview will be rejected until the next epoch.</div> : null}
          <WithdrawAction positionIds={ids} onStarted={onStarted} />
        </div>
      ) : null}
    </Panel>
  );
}

function MoveForm({ rows, idList, config, pools, onStarted }: { rows: PositionView[]; idList: JSX.Element; config: PoolConfigView; pools: PoolView[]; onStarted: () => void }) {
  const current = new Set(rows.map((p) => p.agentId));
  const targets = pools.filter((p) => !current.has(p.agentId));
  const [toAgent, setToAgent] = useState(() => String(targets[0]?.agentId ?? ''));
  const target = targets.find((p) => String(p.agentId) === toAgent) ?? null;
  const body: MoveRequest = { positionIds: rows.map((p) => p.id), toAgentId: Number(toAgent) };
  return (
    <div className="form-row">
      <Field label="To pool" hint={`Weight penalty ${formatBps(config.moveWeightPenaltyBps)} applies`} width="lg">
        <Select value={toAgent} onChange={(e) => setToAgent(e.target.value)} disabled={targets.length === 0}>
          {targets.length === 0 ? <option value="">No other pool to move to</option> : null}
          {targets.map((p) => (
            <option key={p.agentId} value={p.agentId}>
              {poolLabel(p)}
            </option>
          ))}
        </Select>
      </Field>
      <ActionButton
        label="Move"
        variant="primary"
        title="Move positions to another pool"
        path="/api/positions/move"
        body={body}
        validate={() => (target ? null : 'Choose a target pool.')}
        onStarted={onStarted}
        summary={[
          ['Positions', idList],
          ['To pool', <span className="mono">{target ? poolLabel(target) : '—'}</span>],
          ['Weight penalty', formatBps(config.moveWeightPenaltyBps)],
          ['Effective', 'next epoch'],
        ]}
      />
    </div>
  );
}

function MergeForm({ rows, idList, onStarted }: { rows: PositionView[]; idList: JSX.Element; onStarted: () => void }) {
  const first = rows[0];
  const problem =
    rows.length < 2
      ? 'Select at least two positions (use the checkboxes).'
      : !first
        ? 'Nothing selected.'
        : rows.some((p) => p.agentId !== first.agentId)
          ? 'All positions must be in the same pool (agent id).'
          : rows.some((p) => p.stakeEndEpoch !== first.stakeEndEpoch)
            ? 'All positions must share the same end epoch.'
            : null;
  const body: MergeRequest = { positionIds: rows.map((p) => p.id) };
  return (
    <div className="stack">
      {problem ? <div className="error-text">{problem}</div> : <div className="hint">Positions are combined into one with the same pool and end epoch.</div>}
      <div>
        <ActionButton
          label="Merge"
          variant="primary"
          title="Merge positions"
          path="/api/positions/merge"
          body={body}
          disabled={problem !== null}
          disabledReason={problem ?? undefined}
          onStarted={onStarted}
          summary={[
            ['Positions', idList],
            ['Pool', <span className="mono">{first?.agentId ?? '—'}</span>],
            ['End epoch', <span className="mono">{first?.stakeEndEpoch ?? '—'}</span>],
          ]}
        />
      </div>
    </div>
  );
}

interface RowActionProps {
  kind: RowActionKind;
  position: PositionView;
  config: PoolConfigView;
  onClose: () => void;
}

function RowActionPanel({ kind, position, config, onClose }: RowActionProps) {
  const [amount, setAmount] = useState('');
  const maxAdd = Math.max(config.maxStakeEpochs - position.epochsRemaining, 0);
  const [epochs, setEpochs] = useState(Math.min(1, maxAdd) || 1);
  const title =
    kind === 'split'
      ? `Split position #${position.id}`
      : kind === 'extend'
        ? `Extend position #${position.id}`
        : kind === 'withdraw'
          ? `Withdraw position #${position.id}`
          : `${position.maxLocked ? 'Disable' : 'Enable'} max lock on #${position.id}`;

  const splitBody: SplitRequest = { positionId: position.id, amount: amount.trim() };
  const extendBody: ExtendRequest = { positionId: position.id, epochs };
  const maxLockBody: MaxLockRequest = { positionId: position.id, enable: !position.maxLocked };

  const validateSplit = (): string | null => {
    if (!isPositiveDecimal(amount)) return 'Amount must be a positive decimal number of ANTS.';
    const units = parseUnits(amount, 18);
    if (units === null || units >= BigInt(position.amount)) return `Amount must be smaller than the position (${formatAnts(position.amount, 4)} ANTS).`;
    return null;
  };
  const validateExtend = (): string | null => {
    if (maxAdd <= 0) return `This position is already at the maximum lock (${config.maxStakeEpochs} epochs).`;
    if (epochs < 1 || epochs > maxAdd) return `At most ${maxAdd} more epoch(s) can be added (max lock ${config.maxStakeEpochs}).`;
    return null;
  };

  return (
    <Panel tone="accent" className="panel-inset" title={title} actions={<CloseButton onClick={onClose} />}>
      <div className="small mb muted">
        Pool <span className="mono">{position.agentId}</span> · amount <span className="mono">{formatAnts(position.amount, 4)} ANTS</span> · ends epoch <span className="mono">{position.stakeEndEpoch}</span> ·{' '}
        <span className="mono">{position.epochsRemaining}</span> left
      </div>
      {kind === 'withdraw' ? (
        <div className="stack">
          {position.changePending ? <div className="error-text">This position changed this epoch; the preview will be rejected until the next epoch.</div> : null}
          <WithdrawAction positionIds={[position.id]} autoOpen onStarted={onClose} onCancel={onClose} />
        </div>
      ) : null}
      {kind === 'split' ? (
        <div className="form-row">
          <Input label="Amount to split off (ANTS)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
          <ActionButton
            label="Split"
            variant="primary"
            title={title}
            path="/api/positions/split"
            body={splitBody}
            validate={validateSplit}
            onStarted={onClose}
            summary={[
              ['Position', <span className="mono">#{position.id}</span>],
              ['Split off', <span className="mono">{amount || '—'} ANTS</span>],
              ['Remaining', <span className="mono">{formatAnts(BigInt(position.amount) - (parseUnits(amount, 18) ?? 0n), 4)} ANTS</span>],
            ]}
          />
        </div>
      ) : null}
      {kind === 'extend' ? (
        <div className="form-row">
          <LockSlider label="Add" value={epochs} min={1} max={Math.max(maxAdd, 1)} onChange={setEpochs} disabled={maxAdd <= 0} />
          <ActionButton
            label="Extend"
            variant="primary"
            title={title}
            path="/api/positions/extend"
            body={extendBody}
            validate={validateExtend}
            onStarted={onClose}
            summary={[
              ['Position', <span className="mono">#{position.id}</span>],
              ['Add', <span className="mono">{epochs} epochs</span>],
              ['New end epoch', <span className="mono">{position.stakeEndEpoch + epochs}</span>],
            ]}
          />
        </div>
      ) : null}
      {kind === 'max-lock' ? (
        <div className="stack">
          <div className="hint">
            {position.maxLocked
              ? 'Max lock keeps the position at the maximum lock length automatically. Disabling it lets the position run down to its end epoch.'
              : `Max lock keeps the position continuously at the maximum lock (${config.maxStakeEpochs} epochs) for the highest weight; you must disable it before it can mature.`}
          </div>
          <div>
            <ActionButton
              label={position.maxLocked ? 'Disable max lock' : 'Enable max lock'}
              variant="primary"
              title={title}
              path="/api/positions/max-lock"
              body={maxLockBody}
              onStarted={onClose}
              summary={[
                ['Position', <span className="mono">#{position.id}</span>],
                ['Max lock', position.maxLocked ? 'on → off' : 'off → on'],
              ]}
            />
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
