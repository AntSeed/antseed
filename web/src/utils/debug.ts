function normalize(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

export function isDebugEnabled(): boolean {
  const raw = normalize(import.meta.env.VITE_ANTSEED_DEBUG);
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function debugError(...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.error(...args);
  }
}
