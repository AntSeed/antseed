import { EarlyExitHelp } from './EarlyExitHelp';
import { useEffect, useRef, useState } from 'react';
import type { PoolConfigView, PoolView, RewardsView } from '../../../src/api-types';
import { describeError, formatAnts, formatBps, isPositiveDecimal, parseUnits } from '../format';
import { useActionBlock } from './Confirm';
import { Button } from './ui';
import { useJobs } from '../jobs';
import { Field, Input, Select } from './Field';
import { LockSlider } from './LockSlider';
import { poolLabel } from './Pools';
import { useApp } from '../app-context';
import { stakeSources, stakeSourceRequest } from '../stake-sources';

interface Props {
  config: PoolConfigView | null;
  pools: PoolView[];
  /** Wallet ANTS balance in base units; fills the amount on "Max". */
  balance?: string;
  rewards?: RewardsView | null;
  rewardsError?: string | null;
  /** Pool preselected by the row's Stake button. */
  defaultAgentId?: number | null;
  onStarted?: () => void;
  onClose?: () => void;
  onBusyChange?: (busy: boolean) => void;
}

/** Stake wallet ANTS or route eligible unclaimed rewards directly into a position. */
export function StakeForm({ config, pools, balance, rewards = null, rewardsError, defaultAgentId, onStarted, onClose, onBusyChange }: Props) {
  const { overview, config: dashboardConfig } = useApp();
  const block = useActionBlock();
  const jobs = useJobs();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [agentId, setAgentId] = useState(() => String(defaultAgentId ?? pools[0]?.agentId ?? ''));
  const [walletAmount, setAmount] = useState('');
  const [sourceId, setSourceId] = useState<string | null>(null);
  const sources = stakeSources(rewardsError ? null : rewards, balance ?? '0', overview?.wallet.canTransfer ?? false);
  const chosenSource = sources.find(s => s.id === sourceId);
  const source = chosenSource ?? sources.find(s => s.available && s.kind !== 'wallet') ?? sources[0]!;
  const sourceMissing = sourceId !== null && !chosenSource;
  const isWallet = source.kind === 'wallet';
  const amount = isWallet ? walletAmount : formatAnts(source.amount, 18).replace(/,/g, '');
  const selectedAgentId = source.agentId ?? Number(agentId);
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

  const pool = pools.find((p) => p.agentId === selectedAgentId) ?? null;

  const fillMax = () => {
    if (balance === undefined) return;
    setAmount(formatAnts(balance, 18).replace(/,/g, ''));
  };

  const validate = (): string | null => {
    if (!selectedAgentId || (source.agentId === undefined && !pool)) return 'Choose a pool.';
    if (!isPositiveDecimal(amount)) return 'Amount must be a positive decimal number of ANTS.';
    const units = parseUnits(amount, 18);
    if (units === null) return 'Amount must have no more than 18 decimal places.';
    if (isWallet && balance !== undefined && units !== null) {
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

  const activationEpoch = config && overview ? overview.epoch.current + config.stakeActivationDelay : null;
  const noPools = source.agentId === undefined && pools.length === 0;
  const readinessError = dashboardConfig.browserWallet && dashboardConfig.readOnly
    ? 'Connect wallet to stake.'
    : !overview ? 'Wallet information is unavailable. Refresh before staking.'
    : sourceMissing ? 'The selected rewards are no longer available. Choose a source again.'
    : isWallet && !overview.wallet.canTransfer ? 'Wallet ANTS cannot be staked while transfers are restricted. Choose eligible unclaimed rewards instead.'
    : !source.available ? 'Close this form and use the wallet button above to switch to the authorized wallet for these rewards.'
    : BigInt(overview.wallet.eth) === 0n ? 'This wallet needs ETH on the selected network to pay transaction fees.'
    : null;
  const blocked = block.blocked || noPools || !!readinessError;
  const blockedReason = readinessError ?? block.reason ?? (noPools ? 'No stakeable pools yet.' : null);

  const submit = async () => {
    if (submitting.current || blocked) return;
    const problem = validate();
    if (problem) { setError(problem); return; }
    submitting.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const request = stakeSourceRequest(source, selectedAgentId, amount.trim(), epochs);
      await jobs.start(request.path, request.body);
      onStarted?.();
    } catch (err) {
      setError(describeError(err));
    } finally {
      submitting.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  return (
    <form className="stake-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {blockedReason ? <div className="status-line" role="status">{blockedReason}</div> : null}
      <Field label="Stake from" width="lg">
        <Select value={source.id} disabled={busy} onChange={e => { setSourceId(e.target.value); setError(null); }}>
          {sources.map(s => <option key={s.id} value={s.id} disabled={s.kind === 'wallet' && !s.available}>
            {s.label} · {formatAnts(s.amount, 4)} ANTS{s.kind === 'wallet' && !s.available ? ' (transfers restricted)' : ''}
          </option>)}
        </Select>
      </Field>
      {rewardsError ? <p className="error-text">Rewards could not be loaded: {rewardsError}</p> : !rewards ? <p className="hint">Loading unclaimed rewards…</p> : null}
      {!isWallet ? <p className="hint">Stake rewards directly without claiming to your wallet. Wallet transfer restrictions do not block this route.</p> : null}
      {rewards && sources.every(s => s.kind === 'wallet') ? <p className="hint">No eligible unclaimed rewards to stake. Legacy and locked seller rewards can only be claimed from the Rewards page.</p> : null}
      {source.agentId !== undefined ? <p className="hint">These rewards stake into their source pool. You can move the allocation afterward, subject to position rules.</p> : null}
      <div className="form-row">
        <Field label="Pool" width="lg">
          <Select value={String(selectedAgentId || '')} onChange={(e) => setAgentId(e.target.value)} disabled={busy || noPools || source.agentId !== undefined}>
            {source.agentId !== undefined && !pool ? <option value={source.agentId}>Agent {source.agentId}</option> : null}
            {noPools ? <option value="">No stakeable pools</option> : null}
            {pools.map((p) => (
              <option key={p.agentId} value={p.agentId}>
                {poolLabel(p)}
              </option>
            ))}
          </Select>
        </Field>
        <Input
          label={isWallet ? 'Amount (ANTS)' : 'Rewards to stake (ANTS)'}
          hint={
            isWallet && balance !== undefined ? (
              <>
                Balance <span className="mono">{formatAnts(balance, 4)}</span> ·{' '}
                <button type="button" className="link-button" onClick={fillMax} disabled={busy}>
                  Max
                </button>
              </>
            ) : undefined
          }
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.0"
          disabled={busy || noPools || !isWallet}
        />
        <div className="stake-lock-settings">
          <LockSlider value={epochs} min={minEpochs} max={maxEpochs} startEpoch={activationEpoch} onChange={setEpochs} disabled={busy || !config || noPools} />
        </div>
      </div>
      {config ? <p className="hint">Longer locks increase staking power. Withdrawing early burns {formatBps(config.minEarlyExitSlashBps)}–{formatBps(config.maxSlashBps)} of principal; review the withdrawal estimate before proceeding.<EarlyExitHelp /></p> : null}
      <p className="hint">{isWallet ? 'Approves ANTS for the pool contract if needed, then stakes.' : 'Stakes all eligible rewards from this source. Usage rewards may require an approval per epoch; the final amount is checked on chain.'} Dates assume confirmation in the current epoch.</p>
      {error ? <div className="error-text" role="alert">{error}</div> : null}
      <div className="stake-form-actions">
        <button type="submit" className="btn btn--primary btn--md" disabled={blocked || busy}>{busy ? 'Sending…' : isWallet ? 'Stake' : 'Stake rewards'}</button>
        {onClose ? (
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
        ) : null}
      </div>
    </form>
  );
}
