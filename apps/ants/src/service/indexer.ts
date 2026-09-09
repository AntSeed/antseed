/**
 * Read side for everything that is a list or a history: pools and their
 * per-epoch figures, a wallet's position history, per-epoch usage. It is
 * served by the Antscan indexer (`payments.crypto.explorerApiUrl`), never
 * reconstructed from RPC log scans. Every method returns plain JSON-shaped
 * data; amounts stay as decimal strings.
 */

const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 15_000;

export interface IndexedStakingEpoch {
  epoch: number;
  totalPowerWeight: string;
  totalActiveStake: string;
  totalSellerPoints: string;
  totalWeightedPoolPoints: string;
  totalBuyerPoints: string;
  volumeUsdc: string;
  requests: string;
  stakerBudget: string;
}

export interface IndexedPool {
  agentId: number;
  seller: string | null;
  sellerName: string | null;
  registered: boolean;
  openPositions: number;
  totalPositions: number;
  securityShareBps: string;
  activeStake: string;
  pendingStake: string;
  weight: string;
  powerShareBps: number;
  lastWeight: string;
  usagePoints: string;
  weightedUsagePoints: string;
  lastUsagePoints: string;
  volumeUsdc: string;
  lastVolumeUsdc: string;
  lastEmission: string;
  lastEmissionSettled: boolean;
  lastRewardPer1kPower: string | null;
  projectedEmission: string;
  projectedRewardPer1kPower: string | null;
}

export interface IndexedPools {
  currentEpoch: number;
  network: { current: IndexedStakingEpoch | null; last: IndexedStakingEpoch | null };
  pools: IndexedPool[];
}

export interface IndexedPoolEpoch {
  epoch: number;
  weight: string;
  activeStake: string;
  usagePoints: string;
  weightedUsagePoints: string;
  volumeUsdc: string;
  requests: string;
  settledEmission: string;
  settled: boolean;
}

export interface IndexedPoolDetail {
  pool: (IndexedPool & { firstStakeAt: number | null }) | null;
  epochs: IndexedPoolEpoch[];
  openPositions: number;
  stakers: number;
}

export interface IndexedPosition {
  id: number;
  owner: string;
  agentId: number;
  amount: string;
  weightAmount: string;
  stakeStartEpoch: number;
  stakeEndEpoch: number;
  closedAtEpoch: number;
  closedBy: 'split' | 'merge' | 'move' | 'withdraw' | null;
  replacementIds: number[];
  sourceId: number | null;
  restaked: boolean;
  maxLocked: boolean;
  withdrawn: boolean;
  returnedAmount: string;
  slashedAmount: string;
  createdAt: number;
  closedAt: number | null;
}

export interface IndexedSellerEpoch { seller: string; epoch: number; agentId: number | null; volumeUsdc: string; points: string; weightedPoints: string; requests: string; }
export interface IndexedBuyerEpoch { buyer: string; epoch: number; volumeUsdc: string; points: string; weightedPoints: string; requests: string; }
export interface IndexedParticipant { address: string; currentEpoch: number; seller: IndexedSellerEpoch[]; buyer: IndexedBuyerEpoch[]; }
/** Network settlement volume per epoch from the explorer's epoch metrics (covers legacy epochs too). */
export interface IndexedEpochMetric { epoch: number; volumeUsdc: string; requests: string; }

export interface Indexer {
  readonly baseUrl: string;
  pools(): Promise<IndexedPools>;
  pool(agentId: number, epochs?: number): Promise<IndexedPoolDetail>;
  positions(owner: string, includeClosed?: boolean): Promise<IndexedPosition[]>;
  stakingEpochs(limit?: number): Promise<IndexedStakingEpoch[]>;
  /** Settled volume per seller (lowercase address) for the last `epochs` epochs, newest first. */
  sellerEpochs(epochs?: number): Promise<Map<string, IndexedSellerEpoch[]>>;
  participant(address: string, epochs?: number): Promise<IndexedParticipant>;
  epochMetrics(): Promise<IndexedEpochMetric[]>;
}

export class IndexerError extends Error {
  constructor(message: string, readonly url: string) {
    super(message);
    this.name = 'IndexerError';
  }
}

const num = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const str = (value: unknown): string => (value === null || value === undefined ? '0' : String(value));
const lower = (value: unknown): string | null => (typeof value === 'string' && value ? value.toLowerCase() : null);
/** `convert(value)`, or null when the field is absent. */
const optional = <T>(value: unknown, convert: (value: unknown) => T): T | null => (value === null || value === undefined ? null : convert(value));
const CLOSE_REASONS = ['split', 'merge', 'move', 'withdraw'] as const;

function toStakingEpoch(row: Record<string, unknown> | null): IndexedStakingEpoch | null {
  if (!row) return null;
  return {
    epoch: num(row['epoch']),
    totalPowerWeight: str(row['totalPowerWeight']),
    totalActiveStake: str(row['totalActiveStake']),
    totalSellerPoints: str(row['totalSellerPoints']),
    totalWeightedPoolPoints: str(row['totalWeightedPoolPoints']),
    totalBuyerPoints: str(row['totalBuyerPoints']),
    volumeUsdc: str(row['volumeUsdc']),
    requests: str(row['requests']),
    stakerBudget: str(row['stakerBudget']),
  };
}

function toPool(row: Record<string, unknown>): IndexedPool & { firstStakeAt: number | null } {
  return {
    agentId: num(row['agentId']),
    seller: lower(row['seller']),
    sellerName: typeof row['sellerName'] === 'string' ? row['sellerName'] : null,
    registered: row['registered'] === true,
    openPositions: num(row['openPositions']),
    totalPositions: num(row['totalPositions']),
    securityShareBps: str(row['securityShareBps']),
    activeStake: str(row['activeStake']),
    pendingStake: str(row['pendingStake']),
    weight: str(row['weight']),
    powerShareBps: num(row['powerShareBps']),
    lastWeight: str(row['lastWeight']),
    usagePoints: str(row['usagePoints']),
    weightedUsagePoints: str(row['weightedUsagePoints']),
    lastUsagePoints: str(row['lastUsagePoints']),
    volumeUsdc: str(row['volumeUsdc']),
    lastVolumeUsdc: str(row['lastVolumeUsdc']),
    lastEmission: str(row['lastEmission']),
    lastEmissionSettled: row['lastEmissionSettled'] === true,
    lastRewardPer1kPower: optional(row['lastRewardPer1kPower'], str),
    projectedEmission: str(row['projectedEmission']),
    projectedRewardPer1kPower: optional(row['projectedRewardPer1kPower'], str),
    firstStakeAt: optional(row['firstStakeAt'], num),
  };
}

function toPosition(row: Record<string, unknown>): IndexedPosition {
  const closedBy = CLOSE_REASONS.find((reason) => reason === row['closedBy']) ?? null;
  return {
    id: num(row['id']),
    owner: lower(row['owner']) ?? '',
    agentId: num(row['agentId']),
    amount: str(row['amount']),
    weightAmount: str(row['weightAmount']),
    stakeStartEpoch: num(row['stakeStartEpoch']),
    stakeEndEpoch: num(row['stakeEndEpoch']),
    closedAtEpoch: num(row['closedAtEpoch']),
    closedBy,
    replacementIds: Array.isArray(row['replacementIds']) ? (row['replacementIds'] as unknown[]).map(num) : [],
    sourceId: optional(row['sourceId'], num),
    restaked: row['restaked'] === true,
    maxLocked: row['maxLocked'] === true,
    withdrawn: row['withdrawn'] === true,
    returnedAmount: str(row['returnedAmount']),
    slashedAmount: str(row['slashedAmount']),
    createdAt: num(row['createdAt']),
    closedAt: optional(row['closedAt'], num),
  };
}

const toSellerEpoch = (row: Record<string, unknown>): IndexedSellerEpoch => ({
  seller: lower(row['seller']) ?? '',
  epoch: num(row['epoch']),
  agentId: optional(row['agentId'], num),
  volumeUsdc: str(row['volumeUsdc']),
  points: str(row['points']),
  weightedPoints: str(row['weightedPoints']),
  requests: str(row['requests']),
});
const toBuyerEpoch = (row: Record<string, unknown>): IndexedBuyerEpoch => ({
  buyer: lower(row['buyer']) ?? '',
  epoch: num(row['epoch']),
  volumeUsdc: str(row['volumeUsdc']),
  points: str(row['points']),
  weightedPoints: str(row['weightedPoints']),
  requests: str(row['requests']),
});

export class AntscanIndexer implements Indexer {
  readonly baseUrl: string;
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(baseUrl: string, private readonly fetchImpl: typeof fetch = fetch, private readonly ttlMs = CACHE_TTL_MS) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private get<T>(path: string): Promise<T> {
    const hit = this.cache.get(path);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const url = `${this.baseUrl}${path}`;
    const value = (async () => {
      let response: Response;
      try {
        response = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
      } catch (error) {
        throw new IndexerError(`Explorer unreachable: ${(error as Error).message}`, url);
      }
      if (!response.ok) throw new IndexerError(`Explorer responded with HTTP ${response.status}`, url);
      return await response.json() as T;
    })();
    this.cache.set(path, { at: Date.now(), value });
    value.catch(() => { if (this.cache.get(path)?.value === value) this.cache.delete(path); });
    return value;
  }

  async pools(): Promise<IndexedPools> {
    const raw = await this.get<{ currentEpoch: unknown; network: { current: Record<string, unknown> | null; last: Record<string, unknown> | null }; pools: Record<string, unknown>[] }>('/api/staking/pools');
    return {
      currentEpoch: num(raw.currentEpoch),
      network: { current: toStakingEpoch(raw.network?.current ?? null), last: toStakingEpoch(raw.network?.last ?? null) },
      pools: (raw.pools ?? []).map(toPool),
    };
  }

  async pool(agentId: number, epochs = 8): Promise<IndexedPoolDetail> {
    const raw = await this.get<{ pool: Record<string, unknown> | null; epochs: Record<string, unknown>[]; openPositions: unknown; stakers: unknown }>(`/api/staking/pools/${agentId}?epochs=${epochs}`);
    return {
      pool: raw.pool ? toPool(raw.pool) : null,
      epochs: (raw.epochs ?? []).map((row) => ({
        epoch: num(row['epoch']), weight: str(row['weight']), activeStake: str(row['activeStake']), usagePoints: str(row['usagePoints']), weightedUsagePoints: str(row['weightedUsagePoints']),
        volumeUsdc: str(row['volumeUsdc']), requests: str(row['requests']), settledEmission: str(row['settledEmission']), settled: row['settled'] === true,
      })),
      openPositions: num(raw.openPositions),
      stakers: num(raw.stakers),
    };
  }

  async positions(owner: string, includeClosed = true): Promise<IndexedPosition[]> {
    const raw = await this.get<{ positions: Record<string, unknown>[] }>(`/api/staking/positions?owner=${owner.toLowerCase()}${includeClosed ? '&includeClosed=1' : ''}`);
    return (raw.positions ?? []).map(toPosition);
  }

  async stakingEpochs(limit = 8): Promise<IndexedStakingEpoch[]> {
    const raw = await this.get<Record<string, unknown>[]>(`/api/staking/epochs?limit=${limit}`);
    return (raw ?? []).map((row) => toStakingEpoch(row)!);
  }

  async sellerEpochs(epochs = 3): Promise<Map<string, IndexedSellerEpoch[]>> {
    const raw = await this.get<{ rows: Record<string, unknown>[] }>(`/api/staking/seller-epochs?epochs=${epochs}`);
    const bySeller = new Map<string, IndexedSellerEpoch[]>();
    for (const row of (raw.rows ?? []).map(toSellerEpoch)) bySeller.set(row.seller, [...(bySeller.get(row.seller) ?? []), row]);
    return bySeller;
  }

  async participant(address: string, epochs = 8): Promise<IndexedParticipant> {
    const raw = await this.get<{ address: unknown; currentEpoch: unknown; seller: Record<string, unknown>[]; buyer: Record<string, unknown>[] }>(`/api/staking/participants/${address.toLowerCase()}?epochs=${epochs}`);
    return { address: address.toLowerCase(), currentEpoch: num(raw.currentEpoch), seller: (raw.seller ?? []).map(toSellerEpoch), buyer: (raw.buyer ?? []).map(toBuyerEpoch) };
  }

  async epochMetrics(): Promise<IndexedEpochMetric[]> {
    const raw = await this.get<Record<string, unknown>[]>('/api/epochs');
    return (raw ?? []).map((row) => ({ epoch: num(row['epoch']), volumeUsdc: str(row['volumeUsdc']), requests: str(row['requests']) }));
  }
}

/** The indexer for a chain config; null when no explorer is configured (`explorerApiUrl: ''`). */
export function createIndexer(baseUrl: string | undefined, fetchImpl: typeof fetch = fetch): Indexer | null {
  return baseUrl ? new AntscanIndexer(baseUrl, fetchImpl) : null;
}
