import { verifySignature, hexToBytes } from "../p2p/identity.js";
import type { DHTNode } from "./dht-node.js";
import {
  ANTSEED_WILDCARD_TOPIC,
  capabilityTopic,
  peerTopic,
  subnetTopic,
  SUBNET_COUNT,
  topicToInfoHash,
} from "./dht-node.js";
import type { PeerMetadata } from "./peer-metadata.js";
import { encodeMetadataForSigning } from "./metadata-codec.js";
import type { MetadataResolver, PeerEndpoint } from "./metadata-resolver.js";
import { debugLog } from "../utils/debug.js";

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface LookupConfig {
  dht: DHTNode;
  metadataResolver: MetadataResolver;
  requireValidSignature: boolean;
  allowStaleMetadata: boolean;
  maxAnnouncementAgeMs: number;
  maxResults: number;
  /**
   * Optional foreground DHT budget for findAll(). Each individual lookup still
   * gets the DHT's full operation timeout; the budget only controls how many
   * subnet shards we attempt before returning the peers already found.
   */
  maxFindAllDhtDurationMs?: number;
}

export const DEFAULT_LOOKUP_CONFIG: Omit<LookupConfig, "dht" | "metadataResolver"> = {
  requireValidSignature: true,
  allowStaleMetadata: false,
  maxAnnouncementAgeMs: 30 * 60 * 1000,
  // Old cap was 50, then 200; with subnet fan-out and larger live networks,
  // keep browse/discovery truncation comfortably above current scale while
  // still bounding downstream enrichment/rendering work.
  maxResults: 1000,
  // Do not make buyer startup wait for every empty shard in the foreground.
  // A shard we do run still gets the full DHT operation timeout, but the
  // sweep can resume from the next shard on the next refresh.
  maxFindAllDhtDurationMs: 20_000,
};

export interface LookupResult {
  metadata: PeerMetadata;
  host: string;
  port: number;
}

export interface LookupPartialContext {
  mode: "foreground" | "background";
  phase: "wildcard" | "subnet";
  subnet?: number;
  endpointCount: number;
}

export type LookupPartialCallback = (
  results: LookupResult[],
  context: LookupPartialContext,
) => void | Promise<void>;

export class PeerLookup {
  private readonly config: LookupConfig;
  private nextSubnetStart = 0;

  constructor(config: LookupConfig) {
    this.config = config;
  }

  /**
   * Enumerate every peer on the network.
   *
   * The lookup runs in two stages, sequentially:
   *
   *   1. Wildcard topic, alone. Its broad reach pulls many peers and warms
   *      the local DHT routing table with nodes that already know about
   *      AntSeed traffic.
   *   2. Each subnet topic, one at a time, against that hot routing table.
   *      Each subnet only holds ~total/SUBNET_COUNT announcers, which keeps
   *      us well under the K-closest saturation limit that made the single
   *      wildcard topic return inconsistent subsets at scale.
   *
   * Why sequential: firing all shard lookups together through one UDP socket
   * gave us lower wall-clock but worse completeness. Buyers need to give a
   * shard lookup enough time to converge and drain its peer events, so every
   * shard we do run gets a full lookup slot.
   *
   * Startup still should not block on all 16 shards when most of them are
   * empty. If `maxFindAllDhtDurationMs` is configured, `findAll()` walks
   * shards in a rotating order and stops after the foreground budget is
   * exhausted; the next refresh resumes from the next shard. This preserves
   * per-shard quality without forcing every buyer startup to pay the full
   * network-wide sweep cost.
   *
   * `resolveLookupResults` deduplicates by `host:port` before resolving
   * metadata, so the union still only incurs one metadata fetch per endpoint.
   */
  async findAll(): Promise<LookupResult[]> {
    return this.findAllWithDhtBudget(this.config.maxFindAllDhtDurationMs, "foreground");
  }

  /**
   * Complete a full sequential wildcard+subnet sweep. Intended for background
   * catch-up after a fast foreground discovery has already populated the UI.
   *
   * When `onPartial` is provided, each non-empty DHT batch is metadata-resolved
   * and emitted immediately instead of making callers wait for every shard to
   * finish. This keeps the buyer catalog moving while the exhaustive sweep is
   * still walking later shards.
   */
  async findAllExhaustive(onPartial?: LookupPartialCallback): Promise<LookupResult[]> {
    return this.findAllWithDhtBudget(undefined, "background", onPartial);
  }

  private async findAllWithDhtBudget(
    maxDhtDurationMs: number | undefined,
    mode: "foreground" | "background",
    onPartial?: LookupPartialCallback,
  ): Promise<LookupResult[]> {
    const merged: PeerEndpoint[] = [];
    const partialResults: LookupResult[] = [];
    const sweepStartedAt = Date.now();

    // Stage 1: wildcard, on its own. Warm the routing table.
    const wildcardStartedAt = Date.now();
    debugLog(`[PeerLookup] ${mode}: wildcard lookup starting`);
    const wildcardEndpoints = await this.config.dht.lookup(
      topicToInfoHash(ANTSEED_WILDCARD_TOPIC),
    );
    debugLog(
      `[PeerLookup] ${mode}: wildcard lookup returned ${wildcardEndpoints.length} endpoint(s) `
      + `in ${Date.now() - wildcardStartedAt}ms`,
    );
    merged.push(...wildcardEndpoints);
    if (onPartial && wildcardEndpoints.length > 0) {
      const resolved = await this.resolveLookupResults(shuffle(wildcardEndpoints));
      partialResults.push(...resolved);
      await onPartial(resolved, {
        mode,
        phase: "wildcard",
        endpointCount: wildcardEndpoints.length,
      });
    }

    // Stage 2: per-subnet, sequential. Each lookup gets the full operation
    // timeout and exclusive use of the UDP socket. Rotate the start shard so
    // budgeted foreground scans eventually cover the whole shard ring.
    const startedAt = Date.now();
    const start = this.nextSubnetStart;
    let nextStart = start;
    for (let offset = 0; offset < SUBNET_COUNT; offset++) {
      if (
        offset > 0
        && maxDhtDurationMs !== undefined
        && Date.now() - startedAt >= maxDhtDurationMs
      ) {
        break;
      }

      const subnet = (start + offset) % SUBNET_COUNT;
      const subnetStartedAt = Date.now();
      debugLog(`[PeerLookup] ${mode}: subnet ${subnet}/${SUBNET_COUNT - 1} lookup starting`);
      const subnetEndpoints = await this.config.dht.lookup(
        topicToInfoHash(subnetTopic(subnet)),
      );
      debugLog(
        `[PeerLookup] ${mode}: subnet ${subnet}/${SUBNET_COUNT - 1} returned `
        + `${subnetEndpoints.length} endpoint(s) in ${Date.now() - subnetStartedAt}ms`,
      );
      merged.push(...subnetEndpoints);
      if (onPartial && subnetEndpoints.length > 0) {
        const partialStartedAt = Date.now();
        const resolved = await this.resolveLookupResults(shuffle(subnetEndpoints));
        partialResults.push(...resolved);
        debugLog(
          `[PeerLookup] ${mode}: subnet ${subnet}/${SUBNET_COUNT - 1} partial metadata resolved `
          + `${resolved.length}/${subnetEndpoints.length} in ${Date.now() - partialStartedAt}ms`,
        );
        await onPartial(resolved, {
          mode,
          phase: "subnet",
          subnet,
          endpointCount: subnetEndpoints.length,
        });
      }
      nextStart = (subnet + 1) % SUBNET_COUNT;
    }
    this.nextSubnetStart = nextStart;

    if (onPartial) {
      const deduped = this.deduplicateResultsByPeerId(partialResults);
      debugLog(
        `[PeerLookup] ${mode}: emitted ${deduped.length} incremental metadata result(s) from `
        + `${merged.length} DHT endpoint(s) (total ${Date.now() - sweepStartedAt}ms)`,
      );
      return deduped;
    }

    const metadataStartedAt = Date.now();
    const resolved = await this.resolveLookupResults(shuffle(merged));
    debugLog(
      `[PeerLookup] ${mode}: resolved ${resolved.length} metadata result(s) from `
      + `${merged.length} DHT endpoint(s) in ${Date.now() - metadataStartedAt}ms `
      + `(total ${Date.now() - sweepStartedAt}ms)`,
    );
    return resolved;
  }

  private deduplicateResultsByPeerId(results: LookupResult[]): LookupResult[] {
    const seen = new Set<string>();
    const deduped: LookupResult[] = [];
    for (const result of results) {
      const peerId = result.metadata.peerId.toLowerCase();
      if (seen.has(peerId)) continue;
      seen.add(peerId);
      deduped.push(result);
    }
    return deduped;
  }

  async findByCapability(capability: string, name?: string): Promise<LookupResult[]> {
    const topic = capabilityTopic(capability, name);
    const infoHash = topicToInfoHash(topic);
    const peers = await this.config.dht.lookup(infoHash);
    return this.resolveLookupResults(shuffle(peers));
  }

  /**
   * Look up a single peer by its peerId via the per-peer DHT topic
   * (`antseed:peer:<peerId>`). Returns every endpoint whose served metadata
   * actually matches the requested peerId — a remote endpoint announcing
   * the topic but serving a different peer's metadata is filtered out, so
   * a hostile peer cannot squat another peer's identity.
   *
   * The peerId is normalized to lowercase hex; passing an empty / invalid
   * id returns an empty list.
   */
  async findByPeerId(peerId: string): Promise<LookupResult[]> {
    const normalized = peerId.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{40}$/.test(normalized)) return [];
    const infoHash = topicToInfoHash(peerTopic(normalized));
    const peers = await this.config.dht.lookup(infoHash);
    return this.resolveLookupResults(shuffle(peers), { metadataPeerId: normalized });
  }

  private async resolveLookupResults(
    peers: PeerEndpoint[],
    options?: { metadataPeerId?: string; maxResults?: number },
  ): Promise<LookupResult[]> {
    const maxResults = options?.maxResults ?? this.config.maxResults;
    const metadataPeerId = options?.metadataPeerId;

    // Deduplicate endpoints before firing parallel requests
    const seenEndpoints = new Set<string>();
    const uniquePeers: PeerEndpoint[] = [];
    for (const peer of peers) {
      const key = `${peer.host.toLowerCase()}:${peer.port}`;
      if (!seenEndpoints.has(key)) {
        seenEndpoints.add(key);
        uniquePeers.push(peer);
      }
    }

    // Resolve all peers in parallel — bad-port timeouts no longer block good peers
    const settled = await Promise.allSettled(
      uniquePeers.map((peer) => this._resolveSinglePeer(peer)),
    );

    const results: LookupResult[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value !== null) {
        if (metadataPeerId && r.value.metadata.peerId.toLowerCase() !== metadataPeerId) {
          continue;
        }
        results.push(r.value);
        if (results.length >= maxResults) break;
      }
    }
    return results;
  }

  private async _resolveSinglePeer(peer: PeerEndpoint): Promise<LookupResult | null> {
    const metadata = await this.config.metadataResolver.resolve(peer);
    if (metadata === null) {
      return null;
    }

    if (this.config.requireValidSignature) {
      const valid = await this.verifyMetadataSignature(metadata);
      if (!valid) {
        return null;
      }
    }

    if (!this.config.allowStaleMetadata && this.isStale(metadata)) {
      return null;
    }

    return { metadata, host: peer.host, port: peer.port };
  }

  async verifyMetadataSignature(metadata: PeerMetadata): Promise<boolean> {
    const dataToVerify = encodeMetadataForSigning(metadata);
    const signature = hexToBytes(metadata.signature);
    return verifySignature(metadata.peerId, signature, dataToVerify);
  }

  isStale(metadata: PeerMetadata): boolean {
    const age = Date.now() - metadata.timestamp;
    return age > this.config.maxAnnouncementAgeMs;
  }
}
