export const ANTSCAN_BASE_URL = 'https://antscan.co'
export const ANTSCAN_TRAFFIC_SHARE_SOURCE = 'antscan-ponder-settlement-services-v1'
const PAGE_SIZE = 1_000

export interface TrafficShareEpochWindow {
  epoch: bigint
  startedAt: number
  endsAt: number
}

export interface TrafficShareSnapshot {
  source: string
  epoch: bigint
  windowStartedAt: number
  windowEndedAt: number
  indexedBlock: number
  sellerAddress: string
  serviceHash: string
  serviceVolumeUsdc: bigint
  sellerVolumeUsdc: bigint
  modelShareBps: number
}

export interface ResolveTrafficShareInput {
  sellerAddress: string
  serviceHash: string
  epochWindow: TrafficShareEpochWindow
}

export interface AntscanTrafficShareOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  pageSize?: number
}

interface AntscanOverview {
  sync?: {
    status?: unknown
    indexedBlock?: unknown
  }
}

interface SettlementServiceRow {
  id?: unknown
  seller?: unknown
  serviceId?: unknown
  deltaAmountUsdc?: unknown
  blockNumber?: unknown
  timestamp?: unknown
}

interface SettlementServicePage {
  data?: {
    settlementServices?: {
      items?: unknown
      totalCount?: unknown
      pageInfo?: {
        hasNextPage?: unknown
        endCursor?: unknown
      }
    }
  }
  errors?: unknown
}

const SETTLEMENT_SERVICES_QUERY = `
  query SellerEpochServices(
    $seller: String!
    $startedAt: Int!
    $endsAt: Int!
    $indexedBlock: Int!
    $limit: Int!
    $after: String
  ) {
    settlementServices(
      where: {
        seller: $seller
        timestamp_gte: $startedAt
        timestamp_lt: $endsAt
        blockNumber_lte: $indexedBlock
      }
      orderBy: "blockNumber"
      orderDirection: "asc"
      limit: $limit
      after: $after
    ) {
      items {
        id
        seller
        serviceId
        deltaAmountUsdc
        blockNumber
        timestamp
      }
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

export function calculateTrafficShareBps(serviceVolumeUsdc: bigint, sellerVolumeUsdc: bigint): number {
  if (serviceVolumeUsdc < 0n || sellerVolumeUsdc < 0n) throw new Error('traffic volume cannot be negative')
  if (serviceVolumeUsdc > sellerVolumeUsdc) throw new Error('service traffic exceeds seller traffic')
  if (sellerVolumeUsdc === 0n || serviceVolumeUsdc === 0n) return 0
  return Number((serviceVolumeUsdc * 10_000n + sellerVolumeUsdc - 1n) / sellerVolumeUsdc)
}

export async function resolveAntscanTrafficShare(
  input: ResolveTrafficShareInput,
  options: AntscanTrafficShareOptions = {},
): Promise<TrafficShareSnapshot> {
  const baseUrl = (options.baseUrl ?? ANTSCAN_BASE_URL).replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const pageSize = options.pageSize ?? PAGE_SIZE
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('Antscan page size must be positive')
  const sellerAddress = normalizeAddress(input.sellerAddress)
  const serviceHash = normalizeBytes32(input.serviceHash, 'service hash')
  const { epoch, startedAt, endsAt } = input.epochWindow
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(endsAt) || endsAt <= startedAt) {
    throw new Error('invalid traffic-share epoch window')
  }

  const overviewResponse = await fetchImpl(`${baseUrl}/api/overview`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!overviewResponse.ok) throw new Error(`Antscan overview request failed: ${overviewResponse.status}`)
  const overview = await parseJson<AntscanOverview>(overviewResponse, 'Antscan overview')
  if (overview.sync?.status !== 'synced') throw new Error('Antscan indexer is not synced')
  const indexedBlock = parseNonNegativeInteger(overview.sync.indexedBlock, 'Antscan indexed block')

  let after: string | null = null
  let expectedCount: number | null = null
  let fetchedCount = 0
  let sellerVolumeUsdc = 0n
  let serviceVolumeUsdc = 0n
  const seenIds = new Set<string>()
  const seenCursors = new Set<string>()

  while (true) {
    const response = await fetchImpl(`${baseUrl}/graphql`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        query: SETTLEMENT_SERVICES_QUERY,
        variables: {
          seller: sellerAddress,
          startedAt,
          endsAt,
          indexedBlock,
          limit: pageSize,
          after,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Antscan GraphQL request failed: ${response.status}`)
    const payload = await parseJson<SettlementServicePage>(response, 'Antscan GraphQL response')
    if (Array.isArray(payload.errors) && payload.errors.length > 0) throw new Error('Antscan GraphQL returned errors')
    const page = payload.data?.settlementServices
    if (!page || !Array.isArray(page.items) || !page.pageInfo) throw new Error('malformed Antscan settlement-services page')
    const totalCount = parseNonNegativeInteger(page.totalCount, 'Antscan settlement-services total count')
    if (expectedCount === null) expectedCount = totalCount
    else if (totalCount !== expectedCount) throw new Error('Antscan settlement-services changed during pagination')

    for (const item of page.items as SettlementServiceRow[]) {
      const row = parseSettlementServiceRow(item)
      if (seenIds.has(row.id)) throw new Error('Antscan settlement-services returned a duplicate row')
      seenIds.add(row.id)
      if (row.seller !== sellerAddress) throw new Error('Antscan settlement-services returned a different seller')
      if (row.blockNumber > indexedBlock || row.timestamp < startedAt || row.timestamp >= endsAt) {
        throw new Error('Antscan settlement-services returned a row outside the requested snapshot')
      }
      fetchedCount += 1
      sellerVolumeUsdc += row.deltaAmountUsdc
      if (row.serviceId === serviceHash) serviceVolumeUsdc += row.deltaAmountUsdc
    }

    if (page.pageInfo.hasNextPage === false) break
    if (page.pageInfo.hasNextPage !== true) throw new Error('malformed Antscan pagination state')
    if (typeof page.pageInfo.endCursor !== 'string' || page.pageInfo.endCursor.length === 0) {
      throw new Error('Antscan pagination cursor is missing')
    }
    if (seenCursors.has(page.pageInfo.endCursor)) throw new Error('Antscan pagination cursor repeated')
    seenCursors.add(page.pageInfo.endCursor)
    after = page.pageInfo.endCursor
  }

  if (expectedCount === null || fetchedCount !== expectedCount) {
    throw new Error(`incomplete Antscan pagination: expected ${expectedCount ?? 0}, received ${fetchedCount}`)
  }

  return {
    source: ANTSCAN_TRAFFIC_SHARE_SOURCE,
    epoch,
    windowStartedAt: startedAt,
    windowEndedAt: endsAt,
    indexedBlock,
    sellerAddress,
    serviceHash,
    serviceVolumeUsdc,
    sellerVolumeUsdc,
    modelShareBps: calculateTrafficShareBps(serviceVolumeUsdc, sellerVolumeUsdc),
  }
}

async function parseJson<T>(response: Response, label: string): Promise<T> {
  try {
    return await response.json() as T
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

function parseSettlementServiceRow(input: SettlementServiceRow): {
  id: string
  seller: string
  serviceId: string
  deltaAmountUsdc: bigint
  blockNumber: number
  timestamp: number
} {
  if (typeof input.id !== 'string' || input.id.length === 0) throw new Error('invalid Antscan settlement row id')
  const deltaAmountUsdc = parseBigInt(input.deltaAmountUsdc, 'Antscan settlement USDC delta')
  if (deltaAmountUsdc < 0n) throw new Error('Antscan settlement USDC delta cannot be negative')
  return {
    id: input.id,
    seller: normalizeAddress(input.seller),
    serviceId: normalizeBytes32(input.serviceId, 'Antscan service id'),
    deltaAmountUsdc,
    blockNumber: parseNonNegativeInteger(input.blockNumber, 'Antscan settlement block'),
    timestamp: parseNonNegativeInteger(input.timestamp, 'Antscan settlement timestamp'),
  }
}

function parseBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`${label} is invalid`)
  return BigInt(value)
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`)
  return value
}

function normalizeAddress(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('invalid seller address')
  return value.toLowerCase()
}

function normalizeBytes32(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`invalid ${label}`)
  return value.toLowerCase()
}
