import type { PeerMetadata } from "./peer-metadata.js";

export interface ReputationVerification {
  /** Whether the claimed reputation matches on-chain data. */
  valid: boolean;
  /** The actual on-chain reputation score (weighted average). */
  actualReputation: number;
  /** The actual on-chain session count. */
  actualSessionCount: number;
  /** The actual on-chain dispute count. */
  actualDisputeCount: number;
  /** The claimed on-chain reputation score from metadata. */
  claimedReputation?: number;
  /** The claimed on-chain session count from metadata. */
  claimedSessionCount?: number;
  /** The claimed on-chain dispute count from metadata. */
  claimedDisputeCount?: number;
}

/**
 * Verify a peer's claimed on-chain reputation against the Base contract.
 * Queries the identity contract using the peer's tokenId and compares
 * claimed vs actual reputation values.
 *
 * TODO: Reimplement using IdentityClient.getReputation(tokenId) once
 * IdentityClient is wired into the discovery layer. The old implementation
 * used BaseEscrowClient.getReputation(address) which has been removed.
 */
export async function verifyReputation(
  _metadata: PeerMetadata,
): Promise<ReputationVerification> {
  // TODO: Wire IdentityClient to restore on-chain reputation verification.
  // IdentityClient.getReputation takes a tokenId (not address) and returns
  // ProvenReputation { firstSignCount, qualifiedProvenSignCount, ... }.
  throw new Error("verifyReputation is not yet implemented with IdentityClient");
}
