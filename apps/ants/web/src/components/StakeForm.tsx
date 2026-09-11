import { useEffect, useState } from 'react';
import type { PoolConfigView, PoolView, StakeRequest } from '../../../src/api-types';
import { formatAnts, formatBps, isPositiveDecimal, parseUnits } from '../format';
import { ActionButton } from './Confirm';
import { Field, Input, Select } from './Field';
import { LockSlider } from './LockSlider';
import { poolLabel, poolStatus } from './Pools';

interface Props {
  config: PoolConfigView | null;
  pools: PoolView[];
  /** Wallet ANTS balance in base units; fills the amount on "Max". */
  balance?: string;
  /** Pool preselected by the row's Stake button. */
  defaultAgentId?: number | null;
  onStarted?: () => void;
  onClose?: () => void;
}

/** Stake ANTS into a seller pool: pool select, amount with Max, lock slider. Amount is sent as a human decimal string; the server converts it. */
export function StakeForm({ config, pools, balance, defaultAgentId, onStarted, onClose }: Props) {
  const [agentId, setAgentId] = useState(() => String(defaultAgentId ?? pools[0]?.agentId ?? ''));
  const [amount, setAmount] = useState('');
  const maxEpochs = config?.maxStakeEpochs ?? 1;
  const minEpochs = Math.max(1, config?.minStakeEpochs ?? 1);
  const [epochs, setEpochs] = useState(maxEpochs);

  // Default the lock to the maximum once the config arrives, and follow a new preselected pool.
  useEffect(() => {
    if (config) setEpochs(config.maxStakeEpochs);
  }, [config]);
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
  const noPools = pools.length === 0;

  return (
    <div className="stake-form">
      {noPools ? <div className="status-line status-line--muted">No stakeable pools yet — sellers must bind in the seller registry first.</div> : null}
      <div className="form-row">
        <Field label="Pool" width="lg">
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={noPools}>
            {noPools ? <option value="">No stakeable pools</option> : null}
            {pools.map((p) => (
              <option key={p.agentId} value={p.agentId}>
                {`${poolLabel(p)} · ${poolStatus(p).label}`}
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
        <LockSlider value={epochs} min={minEpochs} max={maxEpochs} onChange={setEpochs} disabled={!config || noPools} />
      </div>
      {pool && pool.stakeable && !pool.hasPool ? (
        <div className="status-line status-line--muted">
          This pool has no power this epoch — your stake is accepted now and takes effect at the next epoch.
        </div>
      ) : null}
      <div className="row mt">
        <ActionButton
          label="Stake"
          variant="primary"
          title="Stake ANTS"
          path="/api/positions/stake"
          body={body}
          validate={validate}
          disabled={noPools}
          disabledReason="No stakeable pools yet."
          onStarted={onStarted}
          summary={[
            ['Pool', <span className="mono">{pool ? poolLabel(pool) : '—'}</span>],
            ['Amount', <span className="mono">{amount || '—'} ANTS</span>],
            ['Lock', <span className="mono">{epochs} epochs</span>],
            ['Activates', config ? `after ${config.stakeActivationDelay} epoch(s)` : '—'],
            ['Early exit slash', config ? `${formatBps(config.minEarlyExitSlashBps)} – ${formatBps(config.maxSlashBps)}` : '—'],
          ]}
        >
          <p className="hint mt">Approves ANTS for the pool contract if needed, then stakes. The position becomes active from the next epoch.</p>
        </ActionButton>
        {onClose ? (
          <button type="button" className="link-button" onClick={onClose}>
            cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
