/**
 * NetworkPoller
 *
 * Connects to the AntSeed network as an anonymous buyer, discovers peers,
 * and returns raw PeerMetadata for each discovered peer.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  DHTNode,
  DEFAULT_DHT_CONFIG,
  topicToInfoHash,
  ANTSEED_WILDCARD_TOPIC,
  HttpMetadataResolver,
  OFFICIAL_BOOTSTRAP_NODES,
  toBootstrapConfig,
} from '@antseed/node/discovery';
import { toPeerId } from '@antseed/node';
import type { PeerMetadata } from '@antseed/node';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface NetworkSnapshot {
  peers: PeerMetadata[];
  updatedAt: string; // ISO 8601
}

const DEFAULT_CACHE_PATH = join(__dirname, '..', 'cache', 'network.json');

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DHT_WARMUP_MS = 15_000;            // wait for routing table to populate

export class NetworkPoller {
  private snapshot: NetworkSnapshot = { peers: [], updatedAt: new Date(0).toISOString() };
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
      bootstrapNodes: toBootstrapConfig(OFFICIAL_BOOTSTRAP_NODES),
      peerId,
    });

    try {
      await dht.start();

      const metadataResolver = new HttpMetadataResolver();
      const discoveredPeers = new Map<string, PeerMetadata>();

      const infoHash = topicToInfoHash(ANTSEED_WILDCARD_TOPIC);
      const endpoints = await dht.lookup(infoHash);

      await Promise.allSettled(
        endpoints.map(async (ep: { host: string; port: number }) => {
          try {
            const metadata: PeerMetadata | null = await metadataResolver.resolve(ep);
            if (!metadata?.peerId) return;
            discoveredPeers.set(metadata.peerId, metadata);
          } catch {
            // unreachable peer — skip
          }
        }),
      );

      this.snapshot = {
        peers: [...discoveredPeers.values()],
        updatedAt: new Date().toISOString(),
      };

      console.log(`[network-stats] poll complete — ${this.snapshot.peers.length} peers`);
      await this.saveCache();
    } finally {
      await dht.stop().catch(() => {});
    }
  }

  private async loadCache(): Promise<void> {
    try {
      const raw = await readFile(this.cachePath, 'utf8');
      this.snapshot = JSON.parse(raw) as NetworkSnapshot;
      console.log('[network-stats] loaded cache from disk');
    } catch {
      // file missing or stale — start fresh
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
