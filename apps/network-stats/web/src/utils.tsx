import { useEffect, useState } from 'react';

export function formatLargeNumber(value: string | number): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toLocaleString();
}

export function formatUsd(n: number): string {
  return `$${formatLargeNumber(n)}`;
}

export function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r === 0 ? `${m}m` : `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

export function formatRelative(ms: number | null, now: number): string {
  if (!ms) return '—';
  const diff = Math.max(0, Math.floor((now - ms) / 1000));
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  return `${formatSeconds(diff)} ago`;
}

export function parseUpdatedAt(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value * 1000 : new Date(value).getTime();
  if (!Number.isFinite(ms) || ms === 0) return null;
  return ms;
}

export function shortPeerId(id: string): { head: string; tail: string } {
  if (id.length <= 14) return { head: id, tail: '' };
  return { head: id.slice(0, 8), tail: id.slice(-6) };
}

export function useTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export type Theme = 'light' | 'dark';
const THEME_STORAGE_KEY = 'antseed-network-stats:theme';

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'light';
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
    if (stored === 'light' || stored === 'dark') return stored;
    return 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore storage failures (private mode, etc.)
    }
  }, [theme]);

  const toggle = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));
  return [theme, toggle];
}

export function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

export function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function StatCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className={`stat-card${accent ? ' stat-card--accent' : ''}`}>
      <span className="stat-card-label">{label}</span>
      <span className="stat-card-value">{value}</span>
      {hint && <span className="stat-card-hint">{hint}</span>}
    </div>
  );
}

export function SectionHead({
  eyebrow,
  title,
  sub,
}: {
  eyebrow: string;
  title: string;
  sub: string;
}) {
  return (
    <div className="dashboard-section-head">
      <span className="dashboard-section-eyebrow">{eyebrow}</span>
      <h2 className="dashboard-section-title">{title}</h2>
      <p className="dashboard-section-sub">{sub}</p>
    </div>
  );
}
