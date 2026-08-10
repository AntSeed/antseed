// Browser-safe env access: `process` only exists under Node/bundler shims.
function readEnv(name: string): string | undefined {
  return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}

function normalizeDebugValue(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

let cachedDebugFilters: string[] | null = null;

export function getDebugFilters(): readonly string[] {
  if (cachedDebugFilters) {
    return cachedDebugFilters;
  }

  const raw = readEnv('ANTSEED_LOG_FILTER') ?? readEnv('ANTSEED_DEBUG_FILTER') ?? '';
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
  const fromAntseed = normalizeDebugValue(readEnv('ANTSEED_DEBUG'));
  if (
    fromAntseed === '1' ||
    fromAntseed === 'true' ||
    fromAntseed === 'yes' ||
    fromAntseed === 'on'
  ) {
    return true;
  }

  const fromDebug = normalizeDebugValue(readEnv('DEBUG'));
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
