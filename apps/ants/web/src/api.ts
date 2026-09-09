import type {
  EmissionsView,
  JobView,
  OverviewView,
  PoolView,
  PoolsView,
  PositionsView,
  ProofStatusView,
  RewardsView,
  SellerView,
  UsageView,
  VerificationView,
} from '../../src/api-types';

const TOKEN_KEY = 'ants.dashboard.token';

export interface DashboardConfig {
  address: string;
  chainId: string;
  evmChainId: number;
  readOnly: boolean;
  dataDir: string;
}

export interface WithdrawPreview {
  positions: Array<{ id: number; amount: string; slashBps: number; slashedAmount: string; returnedAmount: string }>;
  totalSlashed: string;
  totalReturned: string;
  earlyExit: boolean;
}

export type PoolDetail = PoolView & { currentEpoch: number };

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** The CLI opens `#token=<hex>`; move it to sessionStorage and strip it from the URL. */
export function captureToken(): void {
  const match = /(?:^#|[#&?])token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  const token = match?.[1];
  if (!token) return;
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable: the app will show the auth gate */
  }
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/overview`);
}

export function getToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

const unauthorizedListeners = new Set<() => void>();

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${getToken() ?? ''}` };
  let body: string | undefined;
  if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  let response: Response;
  try {
    response = await fetch(path, { method: init?.method ?? 'GET', headers, body });
  } catch (error) {
    throw new ApiError(`Network error: ${error instanceof Error ? error.message : String(error)}`, 0);
  }
  if (response.status === 401) {
    for (const listener of unauthorizedListeners) listener();
    throw new ApiError('Unauthorized', 401);
  }
  let envelope: Envelope<T> | null = null;
  try {
    envelope = (await response.json()) as Envelope<T>;
  } catch {
    envelope = null;
  }
  if (!envelope || typeof envelope !== 'object') {
    throw new ApiError(`HTTP ${response.status}`, response.status);
  }
  if (!envelope.ok) throw new ApiError(envelope.error || `HTTP ${response.status}`, response.status);
  return envelope.data;
}

export function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body });
}

export const api = {
  config: () => get<DashboardConfig>('/api/config'),
  overview: () => get<OverviewView>('/api/overview'),
  positions: () => get<PositionsView>('/api/positions'),
  rewards: () => get<RewardsView>('/api/rewards'),
  pools: () => get<PoolsView>('/api/pools'),
  pool: (agentId: number) => get<PoolDetail>(`/api/pools/${agentId}`),
  usage: (epochs: number) => get<UsageView>(`/api/usage?epochs=${epochs}`),
  emissions: () => get<EmissionsView>('/api/emissions'),
  verification: (seller?: string) =>
    get<VerificationView>(`/api/verification${seller ? `?seller=${encodeURIComponent(seller)}` : ''}`),
  proofStatus: (proofId: string) => get<ProofStatusView>(`/api/verification/proofs/${encodeURIComponent(proofId)}`),
  seller: () => get<SellerView>('/api/seller'),
  jobs: () => get<JobView[]>('/api/jobs'),
  job: (id: string) => get<JobView>(`/api/jobs/${encodeURIComponent(id)}`),
  withdrawPreview: (positionIds: number[]) => post<WithdrawPreview>('/api/positions/withdraw/preview', { positionIds }),
  startJob: (path: string, body: unknown) => post<JobView>(path, body),
};
