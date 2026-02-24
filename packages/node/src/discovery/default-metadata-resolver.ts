import type { PeerEndpoint, MetadataResolver } from "./metadata-resolver.js";
import type { PeerMetadata } from "./peer-metadata.js";

/**
 * Default fail-closed metadata resolver.
 *
 * Always returns `null`, meaning no peer metadata can be resolved.
 * This is intentional: without a real transport-specific resolver wired in,
 * no peers will pass the metadata resolution step and `findSellers()` will
 * return an empty list. Callers must supply a concrete `MetadataResolver`
 * implementation (e.g. one that fetches metadata over HTTP or a P2P channel)
 * to discover real peers.
 */
export class DefaultMetadataResolver implements MetadataResolver {
  async resolve(_peer: PeerEndpoint): Promise<PeerMetadata | null> {
    return null;
  }
}
