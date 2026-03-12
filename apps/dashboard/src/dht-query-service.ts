import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { DashboardConfig } from './types.js';
import { DHTNode, DEFAULT_DHT_CONFIG, topicToInfoHash, providerTopic } from '@antseed/node/discovery';
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
  providers: string[];
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
const DEFAULT_DISCOVERY_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'claude-code',
  'claude-oauth',
  'local-llm',
];
const PROVIDER_ALIAS_MAP: Record<string, string> = {
  '@antseed/provider-anthropic': 'anthropic',
  'antseed-provider-anthropic': 'anthropic',
  '@antseed/provider-claude-code': 'claude-code',
  'antseed-provider-claude-code': 'claude-code',
  '@antseed/provider-claude-oauth': 'claude-oauth',
  'antseed-provider-claude-oauth': 'claude-oauth',
  '@antseed/provider-openai': 'openai',
  'antseed-provider-openai': 'openai',
  '@antseed/provider-local-llm': 'local-llm',
  'antseed-provider-local-llm': 'local-llm',
};

function normalizeProviderTopicName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const raw = value.trim().toLowerCase();
  if (!raw) {
    return null;
  }

  const alias = PROVIDER_ALIAS_MAP[raw];
  if (alias) {
    return alias;
  }

  if (raw.startsWith('@antseed/provider-')) {
    return raw.slice('@antseed/provider-'.length);
  }
  if (raw.startsWith('antseed-provider-')) {
    return raw.slice('antseed-provider-'.length);
  }

  return raw;
}

export function resolveDiscoveryProviders(
  config: Pick<DashboardConfig, 'seller' | 'buyer'>,
): string[] {
  const topics = new Set<string>();

  for (const candidate of config.seller.enabledProviders) {
    const normalized = normalizeProviderTopicName(candidate);
    if (normalized) {
      topics.add(normalized);
    }
  }

  for (const candidate of config.buyer.preferredProviders) {
    const normalized = normalizeProviderTopicName(candidate);
    if (normalized) {
      topics.add(normalized);
    }
  }

  for (const candidate of DEFAULT_DISCOVERY_PROVIDERS) {
    topics.add(candidate);
  }

  return Array.from(topics);
}

function providerNamesFromMetadata(
  metadata: Pick<PeerMetadata, 'providers'> | null | undefined,
): string[] {
  if (!metadata?.providers || metadata.providers.length === 0) {
    return [];
  }

  const providers = new Set<string>();
  for (const entry of metadata.providers) {
    const normalized = normalizeProviderTopicName(entry.provider);
    if (normalized) {
      providers.add(normalized);
    }
  }
  return Array.from(providers);
}

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

export function resolveNetworkPeerProviders(
  metadata: Pick<PeerMetadata, 'providers'> | null | undefined,
  existingProviders: string[] | undefined,
  discoveredTopic: string,
): string[] {
  // Prefer explicit provider list from peer metadata when available.
  const fromMetadata = providerNamesFromMetadata(metadata);
  if (fromMetadata.length > 0) {
    return fromMetadata;
  }

  // Otherwise accumulate prior inferred topics and current lookup topic.
  const providers = new Set<string>();
  for (const provider of existingProviders ?? []) {
    const normalized = normalizeProviderTopicName(provider);
    if (normalized) {
      providers.add(normalized);
    }
  }
  const normalizedTopic = normalizeProviderTopicName(discoveredTopic);
  if (normalizedTopic) {
    providers.add(normalizedTopic);
  }
  return Array.from(providers);
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
  preferredProviders: string[] = [],
): { inputUsdPerMillion: number; outputUsdPerMillion: number } {
  if (!metadata?.providers || metadata.providers.length === 0) {
    return { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  }

  const selectedProvider = preferredProviders.length > 0
    ? metadata.providers.find((provider) => preferredProviders.includes(provider.provider)) ?? metadata.providers[0]
    : metadata.providers[0];

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
    return resolveMetadataSummaryPricing(metadata, this.config.buyer?.preferredProviders ?? []);
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

    const topics = resolveDiscoveryProviders(this.config);

    // Run all DHT topic lookups in parallel — previously sequential, which meant
    // 6 topics × up to 30s each = 3+ minute scans before any peers were visible.
    const topicResults = await Promise.all(
      topics.map(async (name) => {
        const topic = providerTopic(name);
        const infoHash = topicToInfoHash(topic);
        const startTime = Date.now();
        try {
          const endpoints = await this.dhtNode!.lookup(infoHash);
          this.healthMonitor!.recordLookup(endpoints.length > 0, Date.now() - startTime);
          return { name, endpoints };
        } catch {
          this.healthMonitor!.recordLookup(false, Date.now() - startTime);
          return { name, endpoints: [] };
        }
      }),
    );

    // Resolve metadata for all discovered endpoints in parallel.
    const discoveredPeers = new Map<string, NetworkPeer>();

    await Promise.all(
      topicResults.flatMap(({ name, endpoints }) =>
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
          const providers = resolveNetworkPeerProviders(metadata, existing?.providers, name);
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
            providers,
            services,
            inputUsdPerMillion: existing?.inputUsdPerMillion ?? summaryPricing.inputUsdPerMillion,
            outputUsdPerMillion: existing?.outputUsdPerMillion ?? summaryPricing.outputUsdPerMillion,
            capacityMsgPerHour: existing?.capacityMsgPerHour ?? capacityMsgPerHour,
            reputation: metadata ? 100 : 50,
            lastSeen: Date.now(),
            source: 'dht',
          });
        }),
      ),
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
