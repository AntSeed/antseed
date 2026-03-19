import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { DashboardConfig } from './types.js';
import { DHTNode, DEFAULT_DHT_CONFIG, topicToInfoHash, ANTSEED_WILDCARD_TOPIC } from '@antseed/node/discovery';
import { DHTHealthMonitor } from '@antseed/node/discovery';
import { DEFAULT_HEALTH_THRESHOLDS } from '@antseed/node/discovery';
import { HttpMetadataResolver } from '@antseed/node/discovery';
import { mergeBootstrapNodes, OFFICIAL_BOOTSTRAP_NODES, toBootstrapConfig, parseBootstrapList } from '@antseed/node/discovery';
import { toPeerId } from '@antseed/node';
import type { PeerMetadata } from '@antseed/node';

export interface NetworkPeer {
  peerId: string;
  displayName: string | null;
  host: string;
  port: number;
  services: string[];
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  capacityMsgPerHour: number;
  reputation: number;
  lastSeen: number;
  source: 'dht' | 'daemon';
}

export interface NetworkStats {
  totalPeers: number;
  dhtNodeCount: number;
  dhtHealthy: boolean;
  lastScanAt: number | null;
  totalLookups: number;
  successfulLookups: number;
  lookupSuccessRate: number;
  averageLookupLatencyMs: number;
  healthReason: string;
}

const SCAN_INTERVAL_MS = 30_000;
/** Peers not seen for this long are evicted from the cache. */
export const PEER_TTL_MS = 5 * 60_000;

function serviceNamesFromMetadata(
  metadata: Pick<PeerMetadata, 'providers'> | null | undefined,
): string[] {
  if (!metadata?.providers || metadata.providers.length === 0) {
    return [];
  }

  const services = new Set<string>();
  for (const provider of metadata.providers) {
    for (const service of provider.services ?? []) {
      if (typeof service !== 'string') {
        continue;
      }
      const normalized = service.trim();
      if (normalized.length > 0) {
        services.add(normalized);
      }
    }
  }
  return Array.from(services);
}

export function resolveNetworkPeerServices(
  metadata: Pick<PeerMetadata, 'providers'> | null | undefined,
  existingServices: string[] | undefined,
): string[] {
  // Prefer metadata services whenever available.
  const fromMetadata = serviceNamesFromMetadata(metadata);
  if (fromMetadata.length > 0) {
    return fromMetadata;
  }

  const services = new Set<string>();
  for (const service of existingServices ?? []) {
    if (typeof service !== 'string') {
      continue;
    }
    const normalized = service.trim();
    if (normalized.length > 0) {
      services.add(normalized);
    }
  }
  return Array.from(services);
}

export function resolveMetadataSummaryPricing(
  metadata: Pick<PeerMetadata, 'providers'> | null | undefined,
): { inputUsdPerMillion: number; outputUsdPerMillion: number } {
  const selectedProvider = metadata?.providers?.[0];
  if (!selectedProvider) {
    return { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  }
  return {
    inputUsdPerMillion: selectedProvider.defaultPricing.inputUsdPerMillion,
    outputUsdPerMillion: selectedProvider.defaultPricing.outputUsdPerMillion,
  };
}

export class DHTQueryService {
  private readonly config: DashboardConfig;
  private dhtNode: DHTNode | null = null;
  private healthMonitor: DHTHealthMonitor | null = null;
  private readonly metadataResolver = new HttpMetadataResolver({ timeoutMs: 5000 });
  private readonly peers = new Map<string, NetworkPeer>();
  private readonly events = new EventEmitter();
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  private lastScanAt: number | null = null;
  private running = false;

  constructor(config: DashboardConfig) {
    this.config = config;
  }

  private resolveSummaryPricing(metadata: PeerMetadata | null): {
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
  } {
    return resolveMetadataSummaryPricing(metadata);
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Generate a random peerId for the read-only DHT node
    const randomId = randomBytes(32).toString('hex');
    const peerId = toPeerId(randomId);

    const userBootstrap = this.config.network?.bootstrapNodes?.length
      ? parseBootstrapList(this.config.network.bootstrapNodes)
      : [];
    const allBootstrap = toBootstrapConfig(mergeBootstrapNodes(OFFICIAL_BOOTSTRAP_NODES, userBootstrap));

    this.dhtNode = new DHTNode({
      peerId,
      ...DEFAULT_DHT_CONFIG,
      port: 0, // OS-assigned port — read-only, no announce
      bootstrapNodes: allBootstrap,
      allowPrivateIPs: true, // Allow local/private peers for development
    });

    await this.dhtNode.start();

    // Dashboard DHT visibility is read-only and often runs in small local networks.
    // Use a less strict health threshold than the full node runtime monitor.
    this.healthMonitor = new DHTHealthMonitor(() => this.dhtNode?.getNodeCount() ?? 0, {
      ...DEFAULT_HEALTH_THRESHOLDS,
      minNodeCount: 1,
      minLookupSuccessRate: 0.2,
      maxAvgLookupLatencyMs: 30_000,
    });
    this.running = true;

    // Initial scan
    this.scanNow().catch(() => {});

    // Periodic scans
    this.scanTimer = setInterval(() => {
      this.scanNow().catch(() => {});
    }, SCAN_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }

    if (this.dhtNode) {
      await this.dhtNode.stop();
      this.dhtNode = null;
    }

    this.healthMonitor = null;
    this.peers.clear();
  }

  async scanNow(): Promise<void> {
    if (!this.dhtNode || !this.healthMonitor) return;

    const infoHash = topicToInfoHash(ANTSEED_WILDCARD_TOPIC);
    const startTime = Date.now();
    let endpoints: Awaited<ReturnType<DHTNode['lookup']>> = [];
    try {
      endpoints = await this.dhtNode.lookup(infoHash);
      this.healthMonitor.recordLookup(endpoints.length > 0, Date.now() - startTime);
    } catch {
      this.healthMonitor.recordLookup(false, Date.now() - startTime);
    }

    // Resolve metadata for all discovered endpoints in parallel.
    const discoveredPeers = new Map<string, NetworkPeer>();

    await Promise.all(
      endpoints.map(async (ep) => {
        let metadata: PeerMetadata | null = null;
        try {
          metadata = await this.metadataResolver.resolve(ep);
        } catch {
          // Metadata resolution failed — use basic info
        }

        const peerId = metadata?.peerId ?? `${ep.host}:${ep.port}`;

        const summaryPricing = this.resolveSummaryPricing(metadata);
        let capacityMsgPerHour = 0;
        if (metadata?.providers) {
          for (const pa of metadata.providers) {
            capacityMsgPerHour += pa.maxConcurrency * 60;
          }
        }

        // Re-read existing after the metadata await so concurrent coroutines
        // for the same peerId always merge against the latest committed value.
        const existing = discoveredPeers.get(peerId);
        const services = resolveNetworkPeerServices(metadata, existing?.services);
        const displayName =
          typeof metadata?.displayName === 'string' && metadata.displayName.trim().length > 0
            ? metadata.displayName.trim()
            : (existing?.displayName ?? `${ep.host}:${ep.port}`);

        discoveredPeers.set(peerId, {
          peerId,
          displayName,
          host: ep.host,
          port: ep.port,
          services,
          inputUsdPerMillion: existing?.inputUsdPerMillion ?? summaryPricing.inputUsdPerMillion,
          outputUsdPerMillion: existing?.outputUsdPerMillion ?? summaryPricing.outputUsdPerMillion,
          capacityMsgPerHour: existing?.capacityMsgPerHour ?? capacityMsgPerHour,
          reputation: metadata ? 100 : 50,
          lastSeen: Date.now(),
          source: 'dht',
        });
      }),
    );

    // Merge discovered peers into cache (update existing, add new).
    for (const [id, peer] of discoveredPeers) {
      this.peers.set(id, peer);
    }

    // Evict peers not seen within the TTL window.
    const now = Date.now();
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > PEER_TTL_MS) {
        this.peers.delete(id);
      }
    }

    this.lastScanAt = now;
    this.events.emit('peers_updated', this.getNetworkPeers());
  }

  /**
   * Mark a peer as recently active (e.g. after communicating with it).
   * Prevents TTL eviction for peers we know are alive.
   */
  touchPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.lastSeen = Date.now();
    }
  }

  /** Return a cached peer by ID, or null if not in the cache. */
  getPeer(peerId: string): NetworkPeer | null {
    return this.peers.get(peerId) ?? null;
  }

  /**
   * Look up a specific peer via DHT. If the peer is already cached and fresh,
   * returns it immediately. Otherwise performs a targeted DHT lookup and
   * resolves metadata. The result is merged into the cache.
   */
  async lookupPeer(peerId: string): Promise<NetworkPeer | null> {
    // Return cached if fresh (seen within last scan interval).
    const cached = this.peers.get(peerId);
    if (cached && Date.now() - cached.lastSeen < SCAN_INTERVAL_MS) {
      return cached;
    }

    if (!this.dhtNode) return cached ?? null;

    // Perform a full wildcard lookup and search for the specific peer.
    const infoHash = topicToInfoHash(ANTSEED_WILDCARD_TOPIC);
    let endpoints: Awaited<ReturnType<DHTNode['lookup']>> = [];
    try {
      endpoints = await this.dhtNode.lookup(infoHash);
    } catch {
      return cached ?? null;
    }

    for (const ep of endpoints) {
      let metadata: PeerMetadata | null = null;
      try {
        metadata = await this.metadataResolver.resolve(ep);
      } catch {
        continue;
      }

      const resolvedId = metadata?.peerId ?? `${ep.host}:${ep.port}`;
      if (resolvedId !== peerId) continue;

      const summaryPricing = this.resolveSummaryPricing(metadata);
      let capacityMsgPerHour = 0;
      if (metadata?.providers) {
        for (const pa of metadata.providers) {
          capacityMsgPerHour += pa.maxConcurrency * 60;
        }
      }

      const existing = this.peers.get(peerId);
      const services = resolveNetworkPeerServices(metadata, existing?.services);
      const displayName =
        typeof metadata?.displayName === 'string' && metadata.displayName.trim().length > 0
          ? metadata.displayName.trim()
          : (existing?.displayName ?? `${ep.host}:${ep.port}`);

      const peer: NetworkPeer = {
        peerId,
        displayName,
        host: ep.host,
        port: ep.port,
        services,
        inputUsdPerMillion: summaryPricing.inputUsdPerMillion || (existing?.inputUsdPerMillion ?? 0),
        outputUsdPerMillion: summaryPricing.outputUsdPerMillion || (existing?.outputUsdPerMillion ?? 0),
        capacityMsgPerHour: capacityMsgPerHour || (existing?.capacityMsgPerHour ?? 0),
        reputation: metadata ? 100 : 50,
        lastSeen: Date.now(),
        source: 'dht',
      };

      this.peers.set(peerId, peer);
      return peer;
    }

    return cached ?? null;
  }

  getNetworkPeers(): NetworkPeer[] {
    return Array.from(this.peers.values());
  }

  getNetworkStats(): NetworkStats {
    const snapshot = this.healthMonitor?.getSnapshot();
    const totalLookups = snapshot?.totalLookups ?? 0;
    const successfulLookups = snapshot?.successfulLookups ?? 0;
    const successRate = totalLookups > 0 ? successfulLookups / totalLookups : 0;
    const nodeCount = snapshot?.nodeCount ?? 0;
    const discoveredPeers = this.peers.size;

    // If peers are actively discovered, consider DHT usable even if strict thresholds fail.
    const dhtHealthy = Boolean(snapshot?.isHealthy) || discoveredPeers > 0 || nodeCount > 0;
    const healthReason = dhtHealthy
      ? `ok (nodes=${nodeCount}, peers=${discoveredPeers}, successRate=${(successRate * 100).toFixed(0)}%)`
      : `insufficient activity (nodes=${nodeCount}, peers=${discoveredPeers}, lookups=${totalLookups})`;

    return {
      totalPeers: discoveredPeers,
      dhtNodeCount: nodeCount,
      dhtHealthy,
      lastScanAt: this.lastScanAt,
      totalLookups,
      successfulLookups,
      lookupSuccessRate: successRate,
      averageLookupLatencyMs: snapshot?.averageLookupLatencyMs ?? 0,
      healthReason,
    };
  }

  onPeersUpdated(callback: (peers: NetworkPeer[]) => void): void {
    this.events.on('peers_updated', callback);
  }

  offPeersUpdated(callback: (peers: NetworkPeer[]) => void): void {
    this.events.off('peers_updated', callback);
  }
}
