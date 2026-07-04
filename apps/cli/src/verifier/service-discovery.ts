import type { PeerInfo } from '@antseed/node'

/**
 * Enumerate the model/service catalog advertised by discovered peers, so
 * `antseed verifier start` can run with zero service configuration: one
 * wildcard discovery per round, then audit every service the network is
 * actually claiming to serve.
 *
 * A service id is a model id announced in the peer's signed metadata
 * (`metadata.providers[].services`) or priced in `providerPricing[*].services`.
 * Provider plugin names (e.g. "anthropic") are NOT services — audits target
 * model claims, not plugin names.
 */
export interface DiscoveredService {
  /** Normalized (trimmed, lowercased) service/model id. */
  service: string
  /** Every discovered peer that advertises this service. */
  peers: PeerInfo[]
}

function advertisedServices(peer: PeerInfo): Set<string> {
  const services = new Set<string>()
  for (const announcement of peer.metadata?.providers ?? []) {
    for (const service of announcement.services ?? []) {
      const normalized = service.trim().toLowerCase()
      if (normalized.length > 0) services.add(normalized)
    }
  }
  for (const entry of Object.values(peer.providerPricing ?? {})) {
    for (const service of Object.keys(entry.services ?? {})) {
      const normalized = service.trim().toLowerCase()
      if (normalized.length > 0) services.add(normalized)
    }
  }
  return services
}

/**
 * Group peers by advertised service, most-advertised first. Ties break
 * alphabetically so round ordering is stable across runs.
 */
export function discoverServices(peers: readonly PeerInfo[]): DiscoveredService[] {
  const byService = new Map<string, PeerInfo[]>()
  for (const peer of peers) {
    for (const service of advertisedServices(peer)) {
      const group = byService.get(service)
      if (group) group.push(peer)
      else byService.set(service, [peer])
    }
  }
  return [...byService.entries()]
    .map(([service, servicePeers]) => ({ service, peers: servicePeers }))
    .sort((a, b) => b.peers.length - a.peers.length || a.service.localeCompare(b.service))
}
