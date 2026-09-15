import { useEpochInfo } from '../app-context';
import { epochStartAt, formatUtcDate } from '../format';

interface Props {
  value: number;
  min?: number;
  max: number;
  onChange: (epochs: number) => void;
  label?: string;
  disabled?: boolean;
}

/** Range slider for a lock length in epochs; the readout shows the length and the approximate unlock date. */
export function LockSlider({ value, min = 1, max, onChange, label = 'Lock', disabled }: Props) {
  const info = useEpochInfo();
  const clamped = Math.min(Math.max(value, min), max);
  const unlockEpoch = info ? info.current + clamped : null;
  const unlockDate = info && unlockEpoch !== null ? formatUtcDate(epochStartAt(unlockEpoch, info.genesis, info.epochDuration)) : null;
  return (
    <label className="field lock-slider">
      <span className="field__label">{label}</span>
      <input
        type="range"
        className="range"
        min={min}
        max={max}
        step={1}
        value={clamped}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={clamped}
        aria-valuetext={`${clamped} epochs`}
      />
      <span className="lock-slider-readout">
        <span className="mono">{clamped}</span> {clamped === 1 ? 'epoch' : 'epochs'}
        {unlockDate ? (
          <span className="muted">
            {' '}
            · unlocks <span className="mono">{unlockDate}</span>
          </span>
        ) : null}
        {clamped === max ? <span className="dim"> · max</span> : null}
      </span>
    </label>
  );
}
