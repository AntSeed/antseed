import type { PeerMetadata } from "./peer-metadata.js";

export type PeerEndpoint = { host: string; port: number };

export interface MetadataResolver {
  resolve(peer: PeerEndpoint): Promise<PeerMetadata | null>;
}
