import { formatUnits } from 'viem';

export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

const ANTS_DECIMALS = 18;

export function formatNumber(value: string | number): string {
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US');
}

export function truncateAddr(addr: string | null | undefined): string {
  if (!addr) return '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function safeBigint(value: string | bigint | null | undefined): bigint {
  if (typeof value === 'bigint') return value;
  if (value == null) return 0n;
  try { return BigInt(value); } catch { return 0n; }
}

/** Format an ANTS (18-decimal) wei amount for display. Accepts string or bigint. */
export function formatAnts(amountWei: string | bigint): string {
  const wei = safeBigint(amountWei);
  try {
    const n = parseFloat(formatUnits(wei, ANTS_DECIMALS));
    if (n === 0) return '0';
    if (n < 0.0001) return '< 0.0001';
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  } catch {
    return '0';
  }
}

export function formatUsd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatAmountInput(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  return n.toFixed(6).replace(/\.?(0+)$/, '');
}

export function formatCompact(value: string | number | bigint): string {
  const num =
    typeof value === 'bigint' ? Number(value)
    : typeof value === 'string' ? Number(value)
    : value;
  if (!Number.isFinite(num)) return '0';
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 10_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toLocaleString('en-US');
}

export function bigintFromString(s: string | undefined): bigint {
  if (!s) return 0n;
  try { return BigInt(s); } catch { return 0n; }
}

/** Coerce an unknown value (e.g. a wagmi multicall result) to a number. */
export function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/** Coerce an unknown value (e.g. a wagmi multicall result) to a bigint. */
export function asBigint(value: unknown): bigint {
  return typeof value === 'bigint' ? value : 0n;
}

/**
 * Estimate a single side's $ANTS reward for an epoch:
 *   emission * sharePct% * userPts / totalPts
 * sharePct is expressed in whole percent (e.g. 45 for 45%); values with up to
 * two decimal places are preserved by scaling by 100 before rounding.
 */
export function estimateEmissionReward(
  emission: string | bigint,
  sharePct: number,
  userPts: string | bigint,
  totalPts: string | bigint,
): bigint {
  const total = safeBigint(totalPts);
  if (total === 0n) return 0n;
  const em = safeBigint(emission);
  const user = safeBigint(userPts);
  return em * BigInt(Math.round(sharePct * 100)) * user / (10000n * total);
}

/**
 * Human-readable duration: "Xd Yh" / "Xh Ym" / "Zm", or "ending now" at or
 * below zero. For pre-computed remaining seconds.
 */
export function formatDurationHuman(seconds: number): string {
  if (seconds <= 0) return 'ending now';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Countdown timer formatted as `M:SS`. Negative input clamps to `0:00`. */
export function formatCountdownMSS(secondsRemaining: number): string {
  if (secondsRemaining <= 0) return '0:00';
  const mins = Math.floor(secondsRemaining / 60);
  const secs = secondsRemaining % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
