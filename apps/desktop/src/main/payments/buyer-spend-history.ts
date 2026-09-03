import type { DesktopPaymentChannelSummary } from './buyer-channels.js';

const HISTORY_DAYS = 90;

export type DesktopBuyerSpendDay = {
  day: string;
  dayStart: number;
  spentUsdc: string;
  inputTokens: string;
  outputTokens: string;
};

export type DesktopBuyerSpendHistory = {
  available: boolean;
  source: 'local';
  unavailableReason: 'buyer-unreachable' | null;
  days: DesktopBuyerSpendDay[];
};

function utcDayStartSeconds(timestampMs: number): number {
  return Math.floor(timestampMs / 86_400_000) * 86_400;
}

function dayLabel(dayStart: number): string {
  return new Date(dayStart * 1000).toISOString().slice(0, 10);
}

function safeBigInt(value: string): bigint | null {
  try {
    const parsed = BigInt(value || '0');
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Build device-local committed-spend history from cumulative channel snapshots.
 * A channel contributes its latest signed amount and token totals on its last
 * local update day. This is immediate and includes unsettled usage, but cannot
 * split a multi-day channel into its original request days.
 */
export function buildLocalBuyerSpendHistory(
  channels: readonly DesktopPaymentChannelSummary[],
  nowMs = Date.now(),
): DesktopBuyerSpendHistory {
  const cutoffSeconds = utcDayStartSeconds(nowMs) - ((HISTORY_DAYS - 1) * 86_400);
  const byDayStart = new Map<number, DesktopBuyerSpendDay>();

  for (const channel of channels) {
    const timestampMs = channel.updatedAt || channel.reservedAt;
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) continue;
    const dayStart = utcDayStartSeconds(timestampMs);
    if (dayStart < cutoffSeconds) continue;

    const signed = safeBigInt(channel.cumulativeSigned);
    const settled = safeBigInt(channel.onChainSettled);
    const input = safeBigInt(channel.inputTokens);
    const output = safeBigInt(channel.outputTokens);
    if (signed === null || settled === null || input === null || output === null) continue;
    const spent = settled > signed ? settled : signed;
    if (spent === 0n && input === 0n && output === 0n && channel.requestCount === 0) continue;

    const previous = byDayStart.get(dayStart);
    byDayStart.set(dayStart, {
      day: dayLabel(dayStart),
      dayStart,
      spentUsdc: (BigInt(previous?.spentUsdc ?? '0') + spent).toString(),
      inputTokens: (BigInt(previous?.inputTokens ?? '0') + input).toString(),
      outputTokens: (BigInt(previous?.outputTokens ?? '0') + output).toString(),
    });
  }

  return {
    available: true,
    source: 'local',
    unavailableReason: null,
    days: [...byDayStart.values()].sort((left, right) => left.dayStart - right.dayStart),
  };
}

export function unavailableLocalBuyerSpendHistory(): DesktopBuyerSpendHistory {
  return {
    available: false,
    source: 'local',
    unavailableReason: 'buyer-unreachable',
    days: [],
  };
}
