import type { PeerEndpoint, MetadataResolver } from './metadata-resolver.js';
import type { PeerMetadata } from './peer-metadata.js';
import { debugWarn } from '../utils/debug.js';

export interface HttpMetadataResolverConfig {
  /** Timeout in ms for each metadata fetch. Default: 5000 */
  timeoutMs?: number;
  /** Port offset from the signaling port to the metadata HTTP port. Default: 0 (same port) */
  metadataPortOffset?: number;
}

export class HttpMetadataResolver implements MetadataResolver {
  private readonly timeoutMs: number;
  private readonly metadataPortOffset: number;

  constructor(config?: HttpMetadataResolverConfig) {
    this.timeoutMs = config?.timeoutMs ?? 5000;
    this.metadataPortOffset = config?.metadataPortOffset ?? 0;
  }

  async resolve(peer: PeerEndpoint): Promise<PeerMetadata | null> {
    const metadataPort = peer.port + this.metadataPortOffset;
    const url = `http://${peer.host}:${metadataPort}/metadata`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        return null;
      }

      return (await response.json()) as PeerMetadata;
    } catch (err) {
      const reason = err instanceof DOMException && err.name === 'AbortError'
        ? 'timeout'
        : err instanceof SyntaxError
          ? 'invalid JSON'
          : 'network error';
      debugWarn(`[MetadataResolver] Failed to resolve ${url}: ${reason}`);
      return null;
    }
  }
}
