// AntseedEmissions epoch math. The emissions contract advances epochs on a
// 1-week wall-clock schedule from a fixed genesis; the DIEM staking proxy's
// reward epochs track the emission epochs and can be synced/funded lazily
// after finalization. The frontend uses the wall-clock cadence for its
// countdown tile — it's what users care about: "when does the next
// distribution happen".

/** AntseedEmissions: 7-day epochs. */
export const EPOCH_DURATION_SECS = 7 * 24 * 60 * 60;

/** AntseedEmissions genesis on Base (2026-04-09T09:54:21Z). */
export const EMISSIONS_GENESIS_UNIX = 1_775_728_461;

/** Epochs per year for APR annualization. */
export const EPOCHS_PER_YEAR = 52;

export interface EpochClock {
  /** Current emission epoch index (0-based; floor of elapsed / EPOCH_DURATION). */
  epoch: number;
  /** Seconds remaining until the next epoch boundary. */
  remainingSecs: number;
  /** Unix timestamp of the current epoch's end. */
  epochEndUnix: number;
}

export function computeEpochClock(nowUnixSecs: number): EpochClock {
  const elapsed = nowUnixSecs - EMISSIONS_GENESIS_UNIX;
  const epoch = Math.max(0, Math.floor(elapsed / EPOCH_DURATION_SECS));
  const epochEndUnix = EMISSIONS_GENESIS_UNIX + (epoch + 1) * EPOCH_DURATION_SECS;
  const remainingSecs = Math.max(0, epochEndUnix - nowUnixSecs);
  return { epoch, remainingSecs, epochEndUnix };
}
