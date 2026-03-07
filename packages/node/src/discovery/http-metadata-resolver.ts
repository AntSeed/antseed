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
  /** Upper bound for failure cooldown backoff. Default: 1800000 (30 minutes) */
  maxFailureCooldownMs?: number;
}

type FailedEndpointState = {
  nextRetryAt: number;
  consecutiveFailures: number;
}

export class HttpMetadataResolver implements MetadataResolver {
  private readonly timeoutMs: number;
  private readonly metadataPortOffset: number;
  private readonly failureCooldownMs: number;
  private readonly maxFailureCooldownMs: number;
  private readonly failedEndpoints: Map<string, FailedEndpointState>;

  constructor(config?: HttpMetadataResolverConfig) {
    this.timeoutMs = config?.timeoutMs ?? 2000;
    this.metadataPortOffset = config?.metadataPortOffset ?? 0;
    this.failureCooldownMs = Math.max(0, config?.failureCooldownMs ?? 30_000);
    this.maxFailureCooldownMs = Math.max(
      this.failureCooldownMs,
      config?.maxFailureCooldownMs ?? 30 * 60_000,
    );
    this.failedEndpoints = new Map<string, FailedEndpointState>();
  }

  async resolve(peer: PeerEndpoint): Promise<PeerMetadata | null> {
    const metadataPort = peer.port + this.metadataPortOffset;
    const host = peer.host.toLowerCase();
    const endpointKey = this.getEndpointKey(host, metadataPort);
    const now = Date.now();

    const failedState = this.failedEndpoints.get(endpointKey);
    if (failedState !== undefined) {
      if (failedState.nextRetryAt > now) {
        return null;
      }
    }

    const url = `http://${peer.host}:${metadataPort}/metadata`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        this.markEndpointFailure(endpointKey);
        return null;
      }

      const metadata = (await response.json()) as PeerMetadata;
      this.failedEndpoints.delete(endpointKey);
      return metadata;
    } catch (err) {
      this.markEndpointFailure(endpointKey);
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

  private markEndpointFailure(endpointKey: string): void {
    if (this.failureCooldownMs <= 0) {
      return;
    }
    const previous = this.failedEndpoints.get(endpointKey);
    const consecutiveFailures = Math.max(1, (previous?.consecutiveFailures ?? 0) + 1);
    const multiplier = 2 ** Math.max(0, consecutiveFailures - 1);
    const backoffMs = Math.min(this.maxFailureCooldownMs, this.failureCooldownMs * multiplier);
    this.failedEndpoints.set(endpointKey, {
      nextRetryAt: Date.now() + backoffMs,
      consecutiveFailures,
    });
  }

  private getEndpointKey(host: string, port: number): string {
    return `${host}:${port}`;
  }
}
