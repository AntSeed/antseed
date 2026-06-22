function normalizeDebugValue(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function isDebugEnabled(): boolean {
  const fromAntseed = normalizeDebugValue(process.env['ANTSEED_DEBUG']);
  if (
    fromAntseed === '1' ||
    fromAntseed === 'true' ||
    fromAntseed === 'yes' ||
    fromAntseed === 'on'
  ) {
    return true;
  }

  const fromDebug = normalizeDebugValue(process.env['DEBUG']);
  return fromDebug === '*' || fromDebug.includes('antseed');
}

export function debugLog(...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.log(...args);
  }
}

export function debugWarn(...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.warn(...args);
  }
}
