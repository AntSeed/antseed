import chalk from 'chalk';

/** Format USDC base units (6 decimals) to human-readable string, e.g. 1500000n → "1.5" */
export function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const frac = baseUnits % 1_000_000n;
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '') || '0';
  return `${whole}.${fracStr}`;
}

/**
 * Format a USD earnings string with a dollar sign and green color.
 * @param amountUSD - Amount as string (e.g., "1.234567")
 * @returns Formatted string like "$1.23"
 */
export function formatEarnings(amountUSD: string): string {
  const num = parseFloat(amountUSD);
  return chalk.green(`$${num.toFixed(2)}`);
}

/**
 * Format a token count with K/M suffix.
 * @param tokens - Number of tokens
 * @returns Formatted string like "1.5K" or "2.3M"
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return String(tokens);
}

/**
 * Format a capacity usage percentage with color coding.
 * Green < 50%, Yellow 50-80%, Red > 80%
 */
export function formatCapacity(percent: number): string {
  const label = `${percent.toFixed(0)}%`;
  if (percent < 50) return chalk.green(label);
  if (percent < 80) return chalk.yellow(label);
  return chalk.red(label);
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * @param ms - Duration in milliseconds
 * @returns String like "2h 15m" or "45s" or "3d 1h"
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Format a reputation score (0-1) with color coding.
 * Green >= 0.8, Yellow >= 0.5, Red < 0.5
 */
export function formatReputation(score: number): string {
  const label = `${(score * 100).toFixed(0)}%`;
  if (score >= 0.8) return chalk.green(label);
  if (score >= 0.5) return chalk.yellow(label);
  return chalk.red(label);
}
