import type { PeerEndpoint, MetadataResolver } from './metadata-resolver.js';
import type { PeerMetadata } from './peer-metadata.js';
import { debugWarn } from '../utils/debug.js';

export interface HttpMetadataResolverConfig {
  /** Timeout in ms for each metadata fetch. Default: 2000 */
  timeoutMs?: number;
  /** Port offset from the signaling port to the metadata HTTP port. Default: 0 (same port) */
  metadataPortOffset?: number;
  /** Cooldown in ms before retrying an endpoint that recently failed. Default: 30000 */
  failureCooldownMs?: number;
}

export class HttpMetadataResolver implements MetadataResolver {
  private readonly timeoutMs: number;
  private readonly metadataPortOffset: number;
  private readonly failureCooldownMs: number;
  private readonly failedEndpoints: Map<string, number>;
  /** Host-level failure cache: any port failure marks the whole host as failed.
   *  Prevents wasting time on multiple bad-port DHT entries for the same peer. */
  private readonly failedHosts: Map<string, number>;

  constructor(config?: HttpMetadataResolverConfig) {
    this.timeoutMs = config?.timeoutMs ?? 2000;
    this.metadataPortOffset = config?.metadataPortOffset ?? 0;
    this.failureCooldownMs = Math.max(0, config?.failureCooldownMs ?? 30_000);
    this.failedEndpoints = new Map();
    this.failedHosts = new Map();
  }

  async resolve(peer: PeerEndpoint): Promise<PeerMetadata | null> {
    const metadataPort = peer.port + this.metadataPortOffset;
    const host = peer.host.toLowerCase();
    const endpointKey = this.getEndpointKey(host, metadataPort);
    const now = Date.now();

    // Check host-level cooldown first (covers all ports for this peer)
    const hostFailedUntil = this.failedHosts.get(host);
    if (hostFailedUntil !== undefined) {
      if (hostFailedUntil > now) {
        return null;
      }
      this.failedHosts.delete(host);
    }

    const failedUntil = this.failedEndpoints.get(endpointKey);
    if (failedUntil !== undefined) {
      if (failedUntil > now) {
        return null;
      }
      this.failedEndpoints.delete(endpointKey);
    }

    const url = `http://${peer.host}:${metadataPort}/metadata`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        this.markEndpointFailure(endpointKey, host);
        return null;
      }

      const metadata = (await response.json()) as PeerMetadata;
      this.failedEndpoints.delete(endpointKey);
      this.failedHosts.delete(host);
      return metadata;
    } catch (err) {
      this.markEndpointFailure(endpointKey, host);
      const reason = err instanceof DOMException && err.name === 'AbortError'
        ? 'timeout'
        : err instanceof SyntaxError
          ? 'invalid JSON'
          : 'network error';
      debugWarn(`[MetadataResolver] Failed to resolve ${url}: ${reason}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private markEndpointFailure(endpointKey: string, host: string): void {
    if (this.failureCooldownMs <= 0) {
      return;
    }
    const failedUntil = Date.now() + this.failureCooldownMs;
    this.failedEndpoints.set(endpointKey, failedUntil);
    this.failedHosts.set(host, failedUntil);
  }

  private getEndpointKey(host: string, port: number): string {
    return `${host}:${port}`;
  }
}
