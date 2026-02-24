import type { PeerId } from './peer.js';
import type { ProviderCapability } from './capability.js';

/**
 * Alias for profile capabilities — uses the canonical ProviderCapability type.
 */
export type ProfileCapability = ProviderCapability;

/**
 * Full peer profile — richer than PeerMetadata (which is DHT wire format).
 * This is the profile that peers create and publish.
 */
export interface PeerProfile {
  peerId: PeerId;
  displayName: string;
  description: string;
  tags: string[];
  capabilities: ProfileCapability[];
  region: string;
  languages: string[];
  website?: string;
  avatar?: string;
  createdAt: number;
  updatedAt: number;
}
