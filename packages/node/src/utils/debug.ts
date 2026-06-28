function normalizeDebugValue(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

let cachedDebugFilters: string[] | null = null;

export function getDebugFilters(): readonly string[] {
  if (cachedDebugFilters) {
    return cachedDebugFilters;
  }

  const raw = process.env['ANTSEED_LOG_FILTER'] ?? process.env['ANTSEED_DEBUG_FILTER'] ?? '';
  cachedDebugFilters = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  return cachedDebugFilters;
}

function getDebugSource(line: string): string | null {
  const match = /^\s*\[([^\]]{1,48})\]/.exec(line);
  return match?.[1]?.trim().toLowerCase() ?? null;
}

export function shouldEmitDebugLine(line: string): boolean {
  const filters = getDebugFilters();
  if (filters.length === 0) {
    return true;
  }

  const normalizedLine = line.toLowerCase();
  const source = getDebugSource(line);
  return filters.some((filter) => source === filter || normalizedLine.includes(filter));
}

function shouldEmitDebug(args: unknown[]): boolean {
  return shouldEmitDebugLine(args.map((arg) => typeof arg === 'string' ? arg : String(arg)).join(' '));
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
  if (isDebugEnabled() && shouldEmitDebug(args)) {
    console.log(...args);
  }
}

export function debugWarn(...args: unknown[]): void {
  if (isDebugEnabled() && shouldEmitDebug(args)) {
    console.warn(...args);
  }
}
