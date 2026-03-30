import type { PeerMetadata } from "./peer-metadata.js";
import type { StatsClient } from "../payments/evm/stats-client.js";
import type { StakingClient } from "../payments/evm/staking-client.js";
import { peerIdToAddress } from "../types/peer.js";

export interface StatsVerification {
  /** Whether the claimed stats match on-chain data. */
  valid: boolean;
  /** The actual on-chain reputation score (channel count). */
  actualReputation: number;
  /** The actual on-chain channel count. */
  actualChannelCount: number;
  /** The actual on-chain ghost/dispute count. */
  actualDisputeCount: number;
  /** The claimed on-chain reputation score from metadata. */
  claimedReputation?: number;
  /** The claimed on-chain channel count from metadata. */
  claimedChannelCount?: number;
  /** The claimed on-chain dispute count from metadata. */
  claimedDisputeCount?: number;
}

/**
 * Verify a peer's claimed on-chain stats against the AntseedStats contract.
 * Uses the staking client to look up the agentId from the peer's EVM address
 * (derived from peerId), then fetches stats from the StatsClient and compares
 * claimed vs actual.
 */
export async function verifyStats(
  statsClient: StatsClient,
  stakingClient: StakingClient,
  metadata: PeerMetadata,
): Promise<StatsVerification> {
  const evmAddress = peerIdToAddress(metadata.peerId);
  const agentId = await stakingClient.getAgentId(evmAddress);
  const stats = await statsClient.getStats(agentId);

  // Map AgentStats fields to the verification format:
  // - channelCount is the total completed channels
  // - ghostCount maps to dispute count (channels where provider went silent)
  // - Use channelCount as the reputation metric (higher = more trusted)
  const actualReputation = stats.channelCount;
  const actualChannelCount = stats.channelCount;
  const actualDisputeCount = stats.ghostCount;

  // Always compare against on-chain data.
  // If peer omits stats fields, treat as unverified — prevents bypass
  // by simply not claiming any values.
  const valid =
    metadata.onChainReputation !== undefined &&
    metadata.onChainChannelCount !== undefined &&
    metadata.onChainDisputeCount !== undefined &&
    metadata.onChainReputation === actualReputation &&
    metadata.onChainChannelCount === actualChannelCount &&
    metadata.onChainDisputeCount === actualDisputeCount;

  return {
    valid,
    actualReputation,
    actualChannelCount,
    actualDisputeCount,
    claimedReputation: metadata.onChainReputation,
    claimedChannelCount: metadata.onChainChannelCount,
    claimedDisputeCount: metadata.onChainDisputeCount,
  };
}
