import { validateRoutingCatalog, type ModelRouterAdapter, type PeerInfo, type Router, type RoutingCatalogV1, type RoutingServiceTarget } from '@antseed/node'

export type RoutingCatalogResult = { catalog?: RoutingCatalogV1; expiresAt: number }

type Entry = { expiresAt: number; result: Promise<RoutingCatalogResult> }

const CATALOG_TIMEOUT_MS = 5_000
const ERROR_TTL_MS = 5_000

/** Short-lived cache for plugin-provided router catalogs, keyed by exact routing service. */
export class RoutingCatalogCache {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly ttlMs = 60_000, private readonly now: () => number = Date.now) {}

  async get(adapter: Pick<ModelRouterAdapter, 'getCatalog'> | Router, target: RoutingServiceTarget | undefined, peers: PeerInfo[], signal?: AbortSignal): Promise<RoutingCatalogResult> {
    const getCatalog = adapter.getCatalog
    if (!target || !getCatalog) return { expiresAt: Number.POSITIVE_INFINITY }
    const key = JSON.stringify([target.peerId, target.provider, target.serviceId])
    const cached = this.entries.get(key)
    if (cached && cached.expiresAt > this.now()) return waitFor(cached.result, signal)
    const entry: Entry = { expiresAt: this.now() + this.ttlMs, result: Promise.resolve({ expiresAt: 0 }) }
    entry.result = (async () => {
      const catalog = await getCatalog.call(adapter, structuredClone(target), structuredClone(peers), AbortSignal.timeout(CATALOG_TIMEOUT_MS))
      if (catalog === undefined) return { expiresAt: entry.expiresAt }
      validateRoutingCatalog(catalog)
      return { catalog: structuredClone(catalog), expiresAt: entry.expiresAt }
    })()
    entry.result.catch(() => {
      if (this.entries.get(key) === entry) entry.expiresAt = Math.min(entry.expiresAt, this.now() + ERROR_TTL_MS)
    })
    this.entries.set(key, entry)
    if (this.entries.size > 256) this.entries.delete(this.entries.keys().next().value!)
    return waitFor(entry.result, signal)
  }

  invalidate(target: RoutingServiceTarget): void {
    this.entries.delete(JSON.stringify([target.peerId, target.provider, target.serviceId]))
  }
}

async function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return structuredClone(await promise)
  signal.throwIfAborted()
  let onAbort = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return structuredClone(await Promise.race([promise, aborted]))
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
