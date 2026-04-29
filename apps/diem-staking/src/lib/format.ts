import { formatUnits } from 'viem';

const USDC_DECIMALS = 6;
const DIEM_DECIMALS = 18;
const ANTS_DECIMALS = 18;

export function toDisplayNumber(value: bigint, decimals: number): number {
  return Number(formatUnits(value, decimals));
}

export function toDiemNumber(value: bigint | null | undefined): number {
  return value == null ? 0 : toDisplayNumber(value, DIEM_DECIMALS);
}

export function toUsdcNumber(value: bigint | null | undefined): number {
  return value == null ? 0 : toDisplayNumber(value, USDC_DECIMALS);
}

export function toAntsNumber(value: bigint | null | undefined): number {
  return value == null ? 0 : toDisplayNumber(value, ANTS_DECIMALS);
}

export function fmtUSD(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 10000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtNum(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function fmtDiem(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export function fmtDiemPrecise(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function fmtPrice(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return '—';
  if (p >= 100) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return p.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export function fmtPct(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return '—';
  return p >= 100 ? Math.round(p) + '%' : p.toFixed(1) + '%';
}

export function fmtDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0s';
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
