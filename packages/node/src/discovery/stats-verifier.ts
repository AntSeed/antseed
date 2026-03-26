import type { PeerMetadata } from "./peer-metadata.js";
import type { StatsClient } from "../payments/evm/stats-client.js";
import type { StakingClient } from "../payments/evm/staking-client.js";

export interface StatsVerification {
  /** Whether the claimed stats match on-chain data. */
  valid: boolean;
  /** The actual on-chain reputation score (session count). */
  actualReputation: number;
  /** The actual on-chain session count. */
  actualSessionCount: number;
  /** The actual on-chain ghost/dispute count. */
  actualDisputeCount: number;
  /** The claimed on-chain reputation score from metadata. */
  claimedReputation?: number;
  /** The claimed on-chain session count from metadata. */
  claimedSessionCount?: number;
  /** The claimed on-chain dispute count from metadata. */
  claimedDisputeCount?: number;
}

/**
 * Verify a peer's claimed on-chain stats against the AntseedStats contract.
 * Uses the staking client to look up the agentId from the peer's EVM address,
 * then fetches stats from the StatsClient and compares claimed vs actual.
 *
 * Returns valid=true with zeroed actuals if the peer has no evmAddress
 * (cannot verify without an address).
 */
export async function verifyStats(
  statsClient: StatsClient,
  stakingClient: StakingClient,
  metadata: PeerMetadata,
): Promise<StatsVerification> {
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

  const agentId = await stakingClient.getAgentId(metadata.evmAddress);
  const stats = await statsClient.getStats(agentId);

  // Map AgentStats fields to the verification format:
  // - sessionCount is the total completed sessions
  // - ghostCount maps to dispute count (sessions where provider went silent)
  // - Use sessionCount as the reputation metric (higher = more trusted)
  const actualReputation = stats.sessionCount;
  const actualSessionCount = stats.sessionCount;
  const actualDisputeCount = stats.ghostCount;

  // Always compare against on-chain data when evmAddress is present.
  // If peer omits stats fields, treat as unverified — prevents bypass
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
