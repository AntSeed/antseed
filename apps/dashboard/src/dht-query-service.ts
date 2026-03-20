import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
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
const PEER_TTL_MS = 5 * 60_000;

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

export interface DHTQueryServiceOptions {
  /**
   * Path to buyer.state.json. When set, peers are read from this file
   * instead of running a standalone DHT node. Use this when the dashboard
   * is embedded in the desktop app alongside a running buyer runtime.
   */
  buyerStateFile?: string;
}

export class DHTQueryService {
  private readonly config: DashboardConfig;
  private readonly buyerStateFile: string | null;
  private dhtNode: DHTNode | null = null;
  private healthMonitor: DHTHealthMonitor | null = null;
  private readonly metadataResolver = new HttpMetadataResolver({ timeoutMs: 5000 });
  private readonly peers = new Map<string, NetworkPeer>();
  private readonly events = new EventEmitter();
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  private lastScanAt: number | null = null;
  private running = false;

  constructor(config: DashboardConfig, options?: DHTQueryServiceOptions) {
    this.config = config;
    this.buyerStateFile = options?.buyerStateFile ?? null;
  }

  private resolveSummaryPricing(metadata: PeerMetadata | null): {
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
  } {
    return resolveMetadataSummaryPricing(metadata);
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (this.buyerStateFile) {
      // File-based mode: read peers from buyer.state.json written by the CLI runtime.
      // No standalone DHT node needed.
      this.running = true;
      this.loadPeersFromFile().catch(() => {});
      this.scanTimer = setInterval(() => {
        this.loadPeersFromFile().catch(() => {});
      }, SCAN_INTERVAL_MS);
      return;
    }

    // Standalone mode: run our own read-only DHT node for discovery.
    const randomId = randomBytes(32).toString('hex');
    const peerId = toPeerId(randomId);

    const userBootstrap = this.config.network?.bootstrapNodes?.length
      ? parseBootstrapList(this.config.network.bootstrapNodes)
      : [];
    const allBootstrap = toBootstrapConfig(mergeBootstrapNodes(OFFICIAL_BOOTSTRAP_NODES, userBootstrap));

    this.dhtNode = new DHTNode({
      peerId,
      ...DEFAULT_DHT_CONFIG,
      port: 0,
      bootstrapNodes: allBootstrap,
      allowPrivateIPs: true,
    });

    await this.dhtNode.start();

    this.healthMonitor = new DHTHealthMonitor(() => this.dhtNode?.getNodeCount() ?? 0, {
      ...DEFAULT_HEALTH_THRESHOLDS,
      minNodeCount: 1,
      minLookupSuccessRate: 0.2,
      maxAvgLookupLatencyMs: 30_000,
    });
    this.running = true;

    this.scanNow().catch(() => {});

    this.scanTimer = setInterval(() => {
      this.scanNow().catch(() => {});
    }, SCAN_INTERVAL_MS);
  }

  /**
   * Load peers from buyer.state.json (file-based mode).
   * The buyer runtime writes discoveredPeers to this file on each cache refresh.
   */
  private async loadPeersFromFile(): Promise<void> {
    if (!this.buyerStateFile) return;

    try {
      const raw = await readFile(this.buyerStateFile, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const rawPeers = Array.isArray(parsed.discoveredPeers) ? parsed.discoveredPeers : [];

      const now = Date.now();
      for (const p of rawPeers) {
        if (!p || typeof p !== 'object' || typeof (p as Record<string, unknown>).peerId !== 'string') continue;
        const peerRaw = p as Record<string, unknown>;
        const peerId = String(peerRaw.peerId);
        const existing = this.peers.get(peerId);

        // Parse host:port from publicAddress, handling IPv6 brackets.
        let host = existing?.host ?? '';
        let port = existing?.port ?? 0;
        if (typeof peerRaw.publicAddress === 'string') {
          const addr = peerRaw.publicAddress as string;
          const lastColon = addr.lastIndexOf(':');
          host = lastColon > -1 ? addr.slice(0, lastColon) : addr;
          port = lastColon > -1 ? Number(addr.slice(lastColon + 1)) || 0 : 0;
        }

        // Extract service names from providers (array of objects with services sub-array).
        const services = resolveNetworkPeerServices(
          Array.isArray(peerRaw.providers) ? { providers: peerRaw.providers } as Pick<PeerMetadata, 'providers'> : null,
          existing?.services,
        );

        this.peers.set(peerId, {
          peerId,
          displayName: typeof peerRaw.displayName === 'string' ? peerRaw.displayName : (existing?.displayName ?? null),
          host,
          port,
          services,
          inputUsdPerMillion: Number(peerRaw.defaultInputUsdPerMillion) || (existing?.inputUsdPerMillion ?? 0),
          outputUsdPerMillion: Number(peerRaw.defaultOutputUsdPerMillion) || (existing?.outputUsdPerMillion ?? 0),
          capacityMsgPerHour: (Number(peerRaw.maxConcurrency) || 0) * 60 || (existing?.capacityMsgPerHour ?? 0),
          reputation: existing?.reputation ?? 100,
          lastSeen: Number(peerRaw.lastSeen) || now,
          source: 'dht',
        });
      }

      // Evict stale peers.
      for (const [id, peer] of this.peers) {
        if (now - peer.lastSeen > PEER_TTL_MS) {
          this.peers.delete(id);
        }
      }

      this.lastScanAt = now;
      this.events.emit('peers_updated', this.getNetworkPeers());
    } catch {
      // File doesn't exist yet or is unreadable — buyer runtime may not be running.
    }
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

    // Update cache
    this.peers.clear();
    for (const [id, peer] of discoveredPeers) {
      this.peers.set(id, peer);
    }

    this.lastScanAt = Date.now();
    this.events.emit('peers_updated', this.getNetworkPeers());
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
