import type { BaseEscrowClient } from "../payments/evm/escrow-client.js";
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
 * Queries the escrow contract using the peer's evmAddress and compares
 * claimed vs actual reputation values.
 */
export async function verifyReputation(
  escrowClient: BaseEscrowClient,
  metadata: PeerMetadata,
): Promise<ReputationVerification> {
  if (!metadata.evmAddress) {
    throw new Error("Metadata does not contain an evmAddress");
  }

  const reputation = await escrowClient.getReputation(metadata.evmAddress);

  const actualReputation = reputation.weightedAverage;
  const actualSessionCount = reputation.sessionCount;
  const actualDisputeCount = reputation.disputeCount;

  const valid =
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
