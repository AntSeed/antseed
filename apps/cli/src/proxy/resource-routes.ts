import type { NativeVideoProtocol } from '@antseed/api-adapter'

export interface ResourceRoute {
  protocol: NativeVideoProtocol
  resourceId: string
  sellerPeerId: string
  provider: string
  service: string
  lastAccessAt: number
}

export class ResourceRoutes {
  private routes: ResourceRoute[] = []
  private reservations = 0

  constructor(private readonly now: () => number = Date.now, private readonly limit = 10_000) {}

  hydrate(value: unknown): void {
    if (!Array.isArray(value)) return
    this.routes = value.filter((entry): entry is ResourceRoute => Boolean(entry
      && ['runway-video', 'veo-video'].includes(entry.protocol)
      && typeof entry.resourceId === 'string' && entry.resourceId.length > 0 && entry.resourceId.length <= 512
      && /^[0-9a-f]{40}$/.test(entry.sellerPeerId)
      && typeof entry.provider === 'string' && entry.provider && typeof entry.service === 'string' && entry.service
      && Number.isFinite(entry.lastAccessAt) && entry.lastAccessAt <= this.now()))
      .slice(0, this.limit)
    this.prune()
  }

  private prune(): void {
    this.routes = this.routes.filter(route => this.now() - route.lastAccessAt < 30 * 24 * 60 * 60_000)
  }

  snapshot(): ResourceRoute[] {
    this.prune()
    return this.routes.map(route => ({ ...route }))
  }

  reserve(): () => void {
    this.prune()
    if (this.routes.length + this.reservations >= this.limit) throw new Error('Video route capacity exhausted')
    this.reservations += 1
    let released = false
    return () => {
      if (!released) this.reservations -= 1
      released = true
    }
  }

  record(route: Omit<ResourceRoute, 'lastAccessAt'>): void {
    this.routes = this.routes.filter(existing => !(existing.protocol === route.protocol
      && existing.resourceId === route.resourceId && existing.sellerPeerId === route.sellerPeerId))
    this.routes.push({ ...route, lastAccessAt: this.now() })
  }

  resolve(protocol: NativeVideoProtocol, resourceId: string, pinnedPeer?: string): ResourceRoute | null {
    this.prune()
    const candidates = this.routes.filter(route => route.protocol === protocol && route.resourceId === resourceId)
    const matching = pinnedPeer ? candidates.filter(route => route.sellerPeerId === pinnedPeer) : candidates
    if (candidates.length && !matching.length) throw new Error('Seller pin conflicts with the recorded job route')
    if (matching.length > 1) throw new Error('Ambiguous resource ID; specify x-antseed-pin-peer')
    const route = matching[0]
    if (!route) return null
    route.lastAccessAt = this.now()
    return { ...route }
  }
}
