import type { DesktopBuyerSpendDay } from '../../../types/bridge';

const DAY_SECONDS = 86_400;

export type SpendingRangeDays = 7 | 30 | 90;

export type SpendingBucket = {
  key: string;
  startDay: number;
  endDay: number;
  axisLabel: string;
  tooltipLabel: string;
  spentUsdc: string;
  inputTokens: string;
  outputTokens: string;
};

export type SpendingChartModel = {
  buckets: SpendingBucket[];
  totalSpentUsdc: string;
  totalInputTokens: string;
  totalOutputTokens: string;
};

function parseBaseUnits(value: string): bigint {
  try {
    const parsed = BigInt(value || '0');
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

function utcDayStartSeconds(nowMs: number): number {
  return Math.floor(nowMs / (DAY_SECONDS * 1000)) * DAY_SECONDS;
}

function utcDate(dayStart: number): Date {
  return new Date(dayStart * 1000);
}

function shortDate(dayStart: number): string {
  return utcDate(dayStart).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function fullDate(dayStart: number): string {
  return utcDate(dayStart).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function dateRange(startDay: number, endDay: number): string {
  const start = shortDate(startDay);
  const end = utcDate(endDay).toLocaleDateString('en-US', {
    month: startDay === endDay || utcDate(startDay).getUTCMonth() !== utcDate(endDay).getUTCMonth() ? 'short' : undefined,
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${start}–${end}`;
}

function dailyAxisLabel(dayStart: number, index: number, range: SpendingRangeDays): string {
  if (range === 7) {
    return utcDate(dayStart).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  }
  if (index === 0 || index === range - 1 || index % 7 === 0) return shortDate(dayStart);
  return '';
}

export function buildSpendingChartModel(
  days: DesktopBuyerSpendDay[],
  range: SpendingRangeDays,
  nowMs = Date.now(),
): SpendingChartModel {
  const today = utcDayStartSeconds(nowMs);
  const firstDay = today - ((range - 1) * DAY_SECONDS);
  const totalsByDay = new Map<number, { spent: bigint; input: bigint; output: bigint }>();
  for (const row of days) {
    if (!Number.isInteger(row.dayStart) || row.dayStart < firstDay || row.dayStart > today) continue;
    const previous = totalsByDay.get(row.dayStart) ?? { spent: 0n, input: 0n, output: 0n };
    totalsByDay.set(row.dayStart, {
      spent: previous.spent + parseBaseUnits(row.spentUsdc),
      input: previous.input + parseBaseUnits(row.inputTokens),
      output: previous.output + parseBaseUnits(row.outputTokens),
    });
  }

  const buckets: SpendingBucket[] = [];
  if (range === 90) {
    for (let startDay = firstDay, index = 0; startDay <= today; startDay += 7 * DAY_SECONDS, index += 1) {
      const endDay = Math.min(startDay + (6 * DAY_SECONDS), today);
      let spent = 0n;
      let input = 0n;
      let output = 0n;
      for (let dayStart = startDay; dayStart <= endDay; dayStart += DAY_SECONDS) {
        const totals = totalsByDay.get(dayStart);
        spent += totals?.spent ?? 0n;
        input += totals?.input ?? 0n;
        output += totals?.output ?? 0n;
      }
      const showAxisLabel = index === 0 || index === 12 || index % 3 === 0;
      buckets.push({
        key: String(startDay),
        startDay,
        endDay,
        axisLabel: showAxisLabel ? shortDate(startDay) : '',
        tooltipLabel: dateRange(startDay, endDay),
        spentUsdc: spent.toString(),
        inputTokens: input.toString(),
        outputTokens: output.toString(),
      });
    }
  } else {
    for (let index = 0; index < range; index += 1) {
      const dayStart = firstDay + (index * DAY_SECONDS);
      const totals = totalsByDay.get(dayStart);
      buckets.push({
        key: String(dayStart),
        startDay: dayStart,
        endDay: dayStart,
        axisLabel: dailyAxisLabel(dayStart, index, range),
        tooltipLabel: fullDate(dayStart),
        spentUsdc: (totals?.spent ?? 0n).toString(),
        inputTokens: (totals?.input ?? 0n).toString(),
        outputTokens: (totals?.output ?? 0n).toString(),
      });
    }
  }

  const totals = buckets.reduce((sum, bucket) => ({
    spent: sum.spent + parseBaseUnits(bucket.spentUsdc),
    input: sum.input + parseBaseUnits(bucket.inputTokens),
    output: sum.output + parseBaseUnits(bucket.outputTokens),
  }), { spent: 0n, input: 0n, output: 0n });
  return {
    buckets,
    totalSpentUsdc: totals.spent.toString(),
    totalInputTokens: totals.input.toString(),
    totalOutputTokens: totals.output.toString(),
  };
}

export function spendingBarHeight(spentUsdc: string, maximumUsdc: string): number {
  const value = parseBaseUnits(spentUsdc);
  const maximum = parseBaseUnits(maximumUsdc);
  if (value === 0n || maximum === 0n) return 0;
  const ratio = Number((value * 1000n) / maximum) / 10;
  return Math.max(4, Math.min(100, ratio));
}

export function formatSpendUsd(spentUsdc: string, exact = false): string {
  const amount = parseBaseUnits(spentUsdc);
  if (amount === 0n) return '$0.00';
  if (!exact && amount < 10_000n) return '<$0.01';

  if (exact) {
    const whole = amount / 1_000_000n;
    const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return `$${whole.toLocaleString('en-US')}${fraction ? `.${fraction}` : '.00'}`;
  }

  const roundedCents = (amount + 5_000n) / 10_000n;
  const whole = roundedCents / 100n;
  const fraction = (roundedCents % 100n).toString().padStart(2, '0');
  return `$${whole.toLocaleString('en-US')}.${fraction}`;
}
