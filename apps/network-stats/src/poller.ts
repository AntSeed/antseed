/**
 * NetworkPoller
 *
 * Connects to the AntSeed network as an anonymous buyer, discovers peers,
 * and extracts peer count + available model list. Results are cached in memory
 * and optionally persisted to a JSON file.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  DHTNode,
  DEFAULT_DHT_CONFIG,
  topicToInfoHash,
  providerTopic,
  HttpMetadataResolver,
  mergeBootstrapNodes,
  OFFICIAL_BOOTSTRAP_NODES,
  toBootstrapConfig,
} from '@antseed/node/discovery';
import { toPeerId } from '@antseed/node';
import type { PeerMetadata } from '@antseed/node';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface NetworkSnapshot {
  peers: number;
  models: string[];
  updatedAt: string; // ISO 8601
}

const DEFAULT_CACHE_PATH = join(__dirname, '..', 'cache', 'network.json');

const DISCOVERY_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'claude-code',
  'claude-oauth',
  'local-llm',
];

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DHT_WARMUP_MS = 15_000;            // wait for routing table to populate

export class NetworkPoller {
  private snapshot: NetworkSnapshot = { peers: 0, models: [], updatedAt: new Date(0).toISOString() };
  private cachePath: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(cachePath = DEFAULT_CACHE_PATH) {
    this.cachePath = cachePath;
  }

  /** Return the latest cached snapshot. */
  getSnapshot(): NetworkSnapshot {
    return this.snapshot;
  }

  /** Start polling. Loads cache from disk on first run, then polls immediately. */
  async start(): Promise<void> {
    await this.loadCache();
    // First poll after DHT warmup
    setTimeout(() => {
      this.poll().catch((err: unknown) => console.error('[network-stats] poll error:', err));
    }, DHT_WARMUP_MS);
    // Subsequent periodic polls
    this.timer = setInterval(() => {
      this.poll().catch((err: unknown) => console.error('[network-stats] poll error:', err));
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Perform one discovery cycle. */
  async poll(): Promise<void> {
    console.log('[network-stats] starting poll...');
    const peerId = toPeerId(randomBytes(32).toString('hex'));
    const dht = new DHTNode({
      ...DEFAULT_DHT_CONFIG,
      port: 0, // OS-assigned, ephemeral
      bootstrapNodes: toBootstrapConfig(mergeBootstrapNodes(OFFICIAL_BOOTSTRAP_NODES, [])),
      peerId,
    });

    try {
      await dht.start();

      const metadataResolver = new HttpMetadataResolver();
      const discoveredPeers = new Map<string, { models: string[] }>();

      // Look up each provider topic on the DHT
      await Promise.allSettled(
        DISCOVERY_PROVIDERS.map(async (provider) => {
          try {
            const infoHash = topicToInfoHash(providerTopic(provider));
            const peers = await dht.lookup(infoHash);
            await Promise.allSettled(
              peers.map(async (ep: { host: string; port: number }) => {
                try {
                  const metadata: PeerMetadata | null = await metadataResolver.resolve(ep);
                  if (!metadata?.peerId) return;
                  const models: string[] = [];
                  for (const pa of metadata.providers ?? []) {
                    for (const model of pa.models ?? []) {
                      if (!models.includes(model)) models.push(model);
                    }
                  }
                  const existing = discoveredPeers.get(metadata.peerId);
                  if (existing) {
                    for (const m of models) {
                      if (!existing.models.includes(m)) existing.models.push(m);
                    }
                  } else {
                    discoveredPeers.set(metadata.peerId, { models });
                  }
                } catch {
                  // unreachable peer — skip
                }
              }),
            );
          } catch {
            // topic lookup failed — skip
          }
        }),
      );

      // Aggregate all unique models across peers
      const allModels = new Set<string>();
      for (const { models } of discoveredPeers.values()) {
        for (const m of models) allModels.add(m);
      }

      this.snapshot = {
        peers: discoveredPeers.size,
        models: [...allModels].sort(),
        updatedAt: new Date().toISOString(),
      };

      console.log(`[network-stats] poll complete — ${this.snapshot.peers} peers, ${this.snapshot.models.length} models`);
      await this.saveCache();
    } finally {
      await dht.stop().catch(() => {});
    }
  }

  private async loadCache(): Promise<void> {
    try {
      if (existsSync(this.cachePath)) {
        const raw = await readFile(this.cachePath, 'utf8');
        this.snapshot = JSON.parse(raw) as NetworkSnapshot;
        console.log('[network-stats] loaded cache from disk');
      }
    } catch {
      // stale or missing cache — start fresh
    }
  }

  private async saveCache(): Promise<void> {
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(this.cachePath, JSON.stringify(this.snapshot, null, 2), 'utf8');
    } catch (err) {
      console.error('[network-stats] failed to save cache:', err);
    }
  }
}
