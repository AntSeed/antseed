import {
  withServiceMetadata,
  ZERO_METADATA,
  type ServiceMetadataDelta,
  type SpendingAuthMetadata,
} from './evm/signatures.js';

const DEFAULT_REQUEST_TRACKER_LIMIT = 512;

function trimOldestMapEntry<K, V>(map: Map<K, V>, limit: number): void {
  if (map.size < limit) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

function trimOldestSetEntry<T>(set: Set<T>, limit: number): void {
  if (set.size < limit) return;
  const oldest = set.values().next().value;
  if (oldest !== undefined) set.delete(oldest);
}

export class RequestServiceTracker {
  private readonly _services = new Map<string, string>();

  constructor(private readonly _limit = DEFAULT_REQUEST_TRACKER_LIMIT) {}

  track(requestId: string, service: string): void {
    trimOldestMapEntry(this._services, this._limit);
    this._services.set(requestId, service);
  }

  get(requestId: string | undefined): string | undefined {
    if (!requestId) return undefined;
    return this._services.get(requestId);
  }

  take(requestId: string | undefined): string | undefined {
    if (!requestId) return undefined;
    const service = this._services.get(requestId);
    this._services.delete(requestId);
    return service;
  }
}

export class CountedRequestTracker {
  private readonly _requestIds = new Set<string>();

  constructor(private readonly _limit = DEFAULT_REQUEST_TRACKER_LIMIT) {}

  has(requestId: string | undefined): boolean {
    return requestId != null && this._requestIds.has(requestId);
  }

  mark(requestId: string | undefined): void {
    if (!requestId) return;
    trimOldestSetEntry(this._requestIds, this._limit);
    this._requestIds.add(requestId);
  }
}

export function advanceUsageMetadata(
  previous: SpendingAuthMetadata | undefined,
  service: string | undefined,
  delta: ServiceMetadataDelta,
): SpendingAuthMetadata {
  const prev = previous ?? ZERO_METADATA;
  const totals: SpendingAuthMetadata = {
    cumulativeInputTokens: prev.cumulativeInputTokens + delta.inputTokens,
    cumulativeOutputTokens: prev.cumulativeOutputTokens + delta.outputTokens,
    cumulativeRequestCount: prev.cumulativeRequestCount + delta.requests,
    services: prev.services ?? [],
  };
  return withServiceMetadata(totals, service, delta);
}
