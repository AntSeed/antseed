import type { PeerInfo } from '../types/peer.js';
import { computeRawOnChainScore, scoreFromTrust } from './on-chain-reputation.js';
import { DEFAULT_EXTERNAL_HISTORY_POLICY, scoreExternalHistory, type ThirdPartyRankingConfig } from './external-history.js';

export function routingReputationBreakdown(peer: PeerInfo, nowMs = Date.now(), policy = DEFAULT_EXTERNAL_HISTORY_POLICY, ranking: ThirdPartyRankingConfig = {}) {
  const rawChainScore = computeRawOnChainScore(peer, nowMs);
  const finite = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const cachedScore = finite(peer.onChainReputationScore);
  const cachedTrust = finite(peer.onChainTrustScore);
  const legacyChainScore = rawChainScore === null ? cachedScore ?? (cachedTrust === null ? null : scoreFromTrust(cachedTrust)) : null;
  const external = scoreExternalHistory(peer, nowMs, policy, ranking);
  const nonNegative = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  const ghosts = nonNegative(peer.onChainGhostCount);
  const channels = nonNegative(peer.onChainChannelCount);
  const risk = Math.min(1, nonNegative(peer.onChainSybilRisk));
  const failureGate = (1 - risk) * (channels + 1) / (channels + 1 + 2.5 * ghosts);
  const externalScore = external.points * failureGate;
  const externalFollowerScore = external.followerPoints * failureGate;
  const strongestProvider = external.breakdown.reduce<number>((best, entry) => {
    const points = typeof entry.providerPoints === 'number' && Number.isFinite(entry.providerPoints) ? entry.providerPoints : 0;
    return Math.max(best, points);
  }, 0);
  const externalProviderScore = strongestProvider * failureGate;
  return { version: 1, rawChainScore, legacyChainScore, external, failureGate, externalScore,
    externalFollowerScore, externalProviderScore,
    effectiveReputationScore: Math.min(100, Math.max(rawChainScore ?? (legacyChainScore ?? 0) * failureGate, externalScore)) };
}

export function computeRoutingReputationScore(peer: PeerInfo, nowMs = Date.now(), policy = DEFAULT_EXTERNAL_HISTORY_POLICY, ranking: ThirdPartyRankingConfig = {}): number {
  return routingReputationBreakdown(peer, nowMs, policy, ranking).effectiveReputationScore;
}
