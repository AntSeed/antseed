import type { PeerMetadata } from "./peer-metadata.js";
import type { IdentityClient } from "../payments/evm/identity-client.js";

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
 * Queries the identity contract using the peer's EVM address to look up
 * the tokenId, then fetches ProvenReputation and compares claimed vs actual.
 *
 * Returns valid=true with zeroed actuals if the peer has no evmAddress
 * (cannot verify without an address).
 */
export async function verifyReputation(
  identityClient: IdentityClient,
  metadata: PeerMetadata,
): Promise<ReputationVerification> {
  if (!metadata.evmAddress) {
    return {
      valid: true,
      actualReputation: 0,
      actualSessionCount: 0,
      actualDisputeCount: 0,
      claimedReputation: metadata.onChainReputation,
      claimedSessionCount: metadata.onChainSessionCount,
      claimedDisputeCount: metadata.onChainDisputeCount,
    };
  }

  const tokenId = await identityClient.getTokenId(metadata.evmAddress);
  const reputation = await identityClient.getReputation(tokenId);

  // Map ProvenReputation fields to the verification format:
  // - qualifiedProvenSignCount is the primary reputation metric
  // - firstSignCount + qualifiedProvenSignCount + unqualifiedProvenSignCount = total sessions
  // - ghostCount maps to dispute count (sessions where provider went silent)
  const actualReputation = reputation.qualifiedProvenSignCount;
  const actualSessionCount =
    reputation.firstSignCount +
    reputation.qualifiedProvenSignCount +
    reputation.unqualifiedProvenSignCount;
  const actualDisputeCount = reputation.ghostCount;

  // Always compare against on-chain data when evmAddress is present.
  // If peer omits reputation fields, treat as unverified — prevents bypass
  // by simply not claiming any values.
  const valid =
    metadata.onChainReputation !== undefined &&
    metadata.onChainSessionCount !== undefined &&
    metadata.onChainDisputeCount !== undefined &&
    metadata.onChainReputation === actualReputation &&
    metadata.onChainSessionCount === actualSessionCount &&
    metadata.onChainDisputeCount === actualDisputeCount;

  return {
    valid,
    actualReputation,
    actualSessionCount,
    actualDisputeCount,
    claimedReputation: metadata.onChainReputation,
    claimedSessionCount: metadata.onChainSessionCount,
    claimedDisputeCount: metadata.onChainDisputeCount,
  };
}
