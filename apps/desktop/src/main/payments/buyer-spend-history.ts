const ANTSCAN_GRAPHQL_URL = 'https://antscan.co/graphql';
const BASE_MAINNET_CHAIN_ID = 8453;
const HISTORY_DAYS = 90;
const HISTORY_CACHE_TTL_MS = 60_000;
const HISTORY_FETCH_TIMEOUT_MS = 5_000;
const HISTORY_PAGE_SIZE = 1000;
const HISTORY_MAX_PAGES = 25;

export type DesktopBuyerSpendDay = {
  day: string;
  dayStart: number;
  spentUsdc: string;
  inputTokens: string;
  outputTokens: string;
};

export type DesktopBuyerSpendHistory = {
  available: boolean;
  source: 'antscan';
  unavailableReason: 'no-wallet' | 'unsupported-network' | null;
  days: DesktopBuyerSpendDay[];
};

type CachedHistory = {
  address: string;
  expiresAt: number;
  data: DesktopBuyerSpendHistory;
};

type BuyerSpendHistoryOptions = {
  address: string | null;
  chainId: number;
  fetchImpl?: typeof fetch;
  nowMs?: number;
};

let cachedHistory: CachedHistory | null = null;

function unavailableHistory(reason: DesktopBuyerSpendHistory['unavailableReason']): DesktopBuyerSpendHistory {
  return {
    available: false,
    source: 'antscan',
    unavailableReason: reason,
    days: [],
  };
}

function utcDayStartSeconds(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000) * 86_400;
}

function normalizeSpendDays(items: unknown[], cutoffSeconds: number): DesktopBuyerSpendDay[] {
  const byDayStart = new Map<number, DesktopBuyerSpendDay>();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const day = typeof row['day'] === 'string' ? row['day'] : '';
    const dayStart = typeof row['dayStart'] === 'number' ? row['dayStart'] : Number.NaN;
    const spentUsdc = typeof row['deltaUsdc'] === 'string' ? row['deltaUsdc'] : '';
    const inputTokens = typeof row['inputTokens'] === 'string' ? row['inputTokens'] : '';
    const outputTokens = typeof row['outputTokens'] === 'string' ? row['outputTokens'] : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!Number.isInteger(dayStart) || dayStart < cutoffSeconds) continue;
    if (![spentUsdc, inputTokens, outputTokens].every((value) => /^\d+$/.test(value))) continue;
    const previous = byDayStart.get(dayStart);
    byDayStart.set(dayStart, {
      day,
      dayStart,
      spentUsdc: (BigInt(previous?.spentUsdc ?? '0') + BigInt(spentUsdc)).toString(),
      inputTokens: (BigInt(previous?.inputTokens ?? '0') + BigInt(inputTokens)).toString(),
      outputTokens: (BigInt(previous?.outputTokens ?? '0') + BigInt(outputTokens)).toString(),
    });
  }
  return [...byDayStart.values()].sort((left, right) => left.dayStart - right.dayStart);
}

export async function fetchBuyerSpendHistory({
  address,
  chainId,
  fetchImpl = fetch,
  nowMs = Date.now(),
}: BuyerSpendHistoryOptions): Promise<DesktopBuyerSpendHistory> {
  if (!address) return unavailableHistory('no-wallet');
  if (chainId !== BASE_MAINNET_CHAIN_ID) return unavailableHistory('unsupported-network');

  const normalizedAddress = address.toLowerCase();
  if (cachedHistory && cachedHistory.address === normalizedAddress && cachedHistory.expiresAt > nowMs) {
    return cachedHistory.data;
  }

  const cutoffSeconds = utcDayStartSeconds(nowMs) - ((HISTORY_DAYS - 1) * 86_400);
  const items: unknown[] = [];
  let after: string | null = null;
  let complete = false;
  for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
    const response = await fetchImpl(ANTSCAN_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(HISTORY_FETCH_TIMEOUT_MS),
      body: JSON.stringify({
        query: `query BuyerSettlementVolumes($address: String!, $cutoff: Int!, $after: String) {
          settlementVolumes(
            where: { buyer: $address, timestamp_gte: $cutoff }
            orderBy: "timestamp"
            orderDirection: "asc"
            after: $after
            limit: ${HISTORY_PAGE_SIZE}
          ) {
            items { day dayStart deltaUsdc inputTokens outputTokens }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        variables: { address: normalizedAddress, cutoff: cutoffSeconds, after },
      }),
    });
    if (!response.ok) throw new Error(`Antscan returned HTTP ${response.status}`);

    const body = await response.json() as Record<string, unknown>;
    if (Array.isArray(body['errors']) && body['errors'].length > 0) {
      throw new Error('Antscan returned a GraphQL error');
    }
    const data = body['data'];
    const settlementVolumes = data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)['settlementVolumes']
      : null;
    if (!settlementVolumes || typeof settlementVolumes !== 'object' || Array.isArray(settlementVolumes)) {
      throw new Error('Antscan returned an invalid settlement response');
    }
    const pageItems = (settlementVolumes as Record<string, unknown>)['items'];
    if (Array.isArray(pageItems)) items.push(...pageItems);
    const pageInfo = (settlementVolumes as Record<string, unknown>)['pageInfo'];
    const pageInfoRecord = pageInfo && typeof pageInfo === 'object' && !Array.isArray(pageInfo)
      ? pageInfo as Record<string, unknown>
      : null;
    if (pageInfoRecord?.['hasNextPage'] !== true) {
      complete = true;
      break;
    }
    const nextCursor = typeof pageInfoRecord['endCursor'] === 'string' ? pageInfoRecord['endCursor'] : '';
    if (!nextCursor || nextCursor === after) throw new Error('Antscan returned an invalid pagination cursor');
    after = nextCursor;
  }
  if (!complete) throw new Error('Antscan spending history exceeded the pagination limit');

  const history: DesktopBuyerSpendHistory = {
    available: true,
    source: 'antscan',
    unavailableReason: null,
    days: normalizeSpendDays(items, cutoffSeconds),
  };
  cachedHistory = {
    address: normalizedAddress,
    expiresAt: nowMs + HISTORY_CACHE_TTL_MS,
    data: history,
  };
  return history;
}

export function resetBuyerSpendHistoryCacheForTests(): void {
  cachedHistory = null;
}
