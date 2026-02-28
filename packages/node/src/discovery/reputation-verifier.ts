import type { BaseEscrowClient } from "../payments/evm/escrow-client.js";
import type { PeerMetadata } from "./peer-metadata.js";

export interface ReputationVerification {
  /** Whether the claimed reputation matches on-chain data. */
  valid: boolean;
  /** The actual on-chain reputation score (weighted average). */
  actualReputation: number;
  /** The actual on-chain session count. */
  actualSessionCount: number;
  /** The claimed on-chain reputation score from metadata. */
  claimedReputation?: number;
  /** The claimed on-chain session count from metadata. */
  claimedSessionCount?: number;
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

  const actualReputation    = reputation.avgRating;
  const actualSessionCount  = reputation.totalTransactions;

  const valid =
    metadata.onChainReputation === actualReputation &&
    metadata.onChainSessionCount === actualSessionCount;

  return {
    valid,
    actualReputation,
    actualSessionCount,
    claimedReputation:   metadata.onChainReputation,
    claimedSessionCount: metadata.onChainSessionCount,
  };
}
