import type { PeerMetadata } from "./peer-metadata.js";

export type PeerEndpoint = { host: string; port: number };
export type MetadataVersion = 10 | 11;

export interface MetadataResolver {
  resolve(peer: PeerEndpoint, version?: MetadataVersion): Promise<PeerMetadata | null>;
}
