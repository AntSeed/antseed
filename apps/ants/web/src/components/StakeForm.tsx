import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PoolConfigView, PoolView, StakeRequest } from '../../../src/api-types';
import { describeError, formatAnts, formatBps, isPositiveDecimal, parseUnits } from '../format';
import { Confirm, useActionBlock } from './Confirm';
import { Button } from './ui';
import { useJobs } from '../jobs';
import { Field, Input, Select } from './Field';
import { LockSlider } from './LockSlider';
import { EpochCell } from './Epoch';
import { poolLabel } from './Pools';
import { useApp } from '../app-context';

interface Props {
  config: PoolConfigView | null;
  pools: PoolView[];
  /** Wallet ANTS balance in base units; fills the amount on "Max". */
  balance?: string;
  /** Pool preselected by the row's Stake button. */
  defaultAgentId?: number | null;
  onStarted?: () => void;
  onClose?: () => void;
  onBusyChange?: (busy: boolean) => void;
}

/** Stake ANTS into a seller pool: pool select, amount with Max, lock slider. Amount is sent as a human decimal string; the server converts it. */
export function StakeForm({ config, pools, balance, defaultAgentId, onStarted, onClose, onBusyChange }: Props) {
  const { overview } = useApp();
  const block = useActionBlock();
  const jobs = useJobs();
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const reviewRef = useRef<HTMLDivElement>(null);
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (reviewing) reviewRef.current?.focus();
  }, [reviewing]);
  const [agentId, setAgentId] = useState(() => String(defaultAgentId ?? pools[0]?.agentId ?? ''));
  const [amount, setAmount] = useState('');
  const maxEpochs = config?.maxStakeEpochs ?? 1;
  const minEpochs = Math.max(1, config?.minStakeEpochs ?? 1);
  const [epochs, setEpochs] = useState(minEpochs);

  useEffect(() => {
    if (config) setEpochs((current) => Math.max(config.minStakeEpochs, Math.min(current, config.maxStakeEpochs)));
  }, [config?.minStakeEpochs, config?.maxStakeEpochs]);
  useEffect(() => {
    if (defaultAgentId) setAgentId(String(defaultAgentId));
  }, [defaultAgentId]);
  useEffect(() => {
    if (!agentId && pools[0]) setAgentId(String(pools[0].agentId));
  }, [agentId, pools]);

  const pool = pools.find((p) => String(p.agentId) === agentId) ?? null;

  const fillMax = () => {
    if (balance === undefined) return;
    setAmount(formatAnts(balance, 18).replace(/,/g, ''));
  };

  const validate = (): string | null => {
    if (!pool) return 'Choose a pool.';
    if (!isPositiveDecimal(amount)) return 'Amount must be a positive decimal number of ANTS.';
    const units = parseUnits(amount, 18);
    if (units === null) return 'Amount must have no more than 18 decimal places.';
    if (balance !== undefined && units !== null) {
      let available = 0n;
      try {
        available = BigInt(balance);
      } catch {
        available = 0n;
      }
      if (units > available) return `Amount exceeds wallet balance (${formatAnts(balance, 4)} ANTS).`;
    }
    if (!config) return 'Pool configuration is still loading.';
    if (epochs < minEpochs || epochs > maxEpochs) return `Lock must be between ${minEpochs} and ${maxEpochs} epochs.`;
    return null;
  };

  const body: StakeRequest = { agentId: Number(agentId), amount: amount.trim(), epochs };
  const activationEpoch = config && overview ? overview.epoch.current + config.stakeActivationDelay : null;
  const noPools = pools.length === 0;
  const readinessError = !overview ? 'Wallet information is unavailable. Refresh before staking.'
    : !overview.wallet.canTransfer ? 'ANTS transfers are restricted for this wallet. New stakes are unavailable.'
    : BigInt(overview.wallet.eth) === 0n ? 'This wallet needs ETH on the selected network to pay transaction fees.'
    : null;
  const blocked = block.blocked || noPools || !!readinessError;
  const blockedReason = readinessError ?? block.reason ?? (noPools ? 'No stakeable pools yet.' : null);

  const review = (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    const problem = validate();
    setError(problem);
    if (!problem) setReviewing(true);
  };

  const submit = async () => {
    if (submitting.current || blocked) return;
    const problem = validate();
    if (problem) { setError(problem); return; }
    submitting.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      await jobs.start('/api/positions/stake', body);
      onStarted?.();
    } catch (err) {
      setError(describeError(err));
    } finally {
      submitting.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  if (reviewing) return (
    <div ref={reviewRef} tabIndex={-1} className="stake-review">
      <Confirm
        embedded
        title="Review stake"
        confirmLabel="Confirm stake"
        cancelLabel="Back"
        busy={busy}
        disabled={blocked}
        error={error ?? blockedReason}
        onConfirm={() => { void submit(); }}
        onCancel={() => {
          setReviewing(false);
          setError(null);
          requestAnimationFrame(() => reviewButtonRef.current?.focus());
        }}
        summary={[
          ['Pool', <span className="mono">{pool ? poolLabel(pool) : '—'}</span>],
          ['Amount', <span className="mono">{amount} ANTS</span>],
          ['Lock', <span className="mono">{epochs} {epochs === 1 ? 'epoch' : 'epochs'}</span>],
          ['Activates', <EpochCell epoch={activationEpoch} dateOnly />],
          ['Unlocks', <EpochCell epoch={activationEpoch === null ? null : activationEpoch + epochs} dateOnly />],
          ['Early exit slash', config ? `${formatBps(config.minEarlyExitSlashBps)} – ${formatBps(config.maxSlashBps)}` : '—'],
        ]}
      >
        <p className="hint mt">Approves ANTS for the pool contract if needed, then stakes. Dates assume confirmation in the current epoch; a later confirmation shifts activation and unlock accordingly.</p>
      </Confirm>
    </div>
  );

  return (
    <form className="stake-form" onSubmit={review}>
      {blockedReason ? <div className="status-line" role="status">{blockedReason}</div> : null}
      <div className="form-row">
        <Field label="Pool" width="lg">
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={noPools}>
            {noPools ? <option value="">No stakeable pools</option> : null}
            {pools.map((p) => (
              <option key={p.agentId} value={p.agentId}>
                {poolLabel(p)}
              </option>
            ))}
          </Select>
        </Field>
        <Input
          label="Amount (ANTS)"
          hint={
            balance !== undefined ? (
              <>
                Balance <span className="mono">{formatAnts(balance, 4)}</span> ·{' '}
                <button type="button" className="link-button" onClick={fillMax}>
                  Max
                </button>
              </>
            ) : undefined
          }
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.0"
          disabled={noPools}
        />
        <LockSlider value={epochs} min={minEpochs} max={maxEpochs} startEpoch={activationEpoch} onChange={setEpochs} disabled={!config || noPools} />
      </div>
      {config ? <p className="hint">Longer locks increase staking power. Withdrawing early burns {formatBps(config.minEarlyExitSlashBps)}–{formatBps(config.maxSlashBps)} of principal; review the withdrawal estimate before proceeding.</p> : null}
      {error ? <div className="error-text" role="alert">{error}</div> : null}
      <div className="stake-form-actions">
        <button ref={reviewButtonRef} type="submit" className="btn btn--primary btn--md" disabled={blocked}>Review stake</button>
        {onClose ? (
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        ) : null}
      </div>
    </form>
  );
}
