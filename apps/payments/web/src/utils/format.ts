export function formatNumber(value: string | number): string {
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US');
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
