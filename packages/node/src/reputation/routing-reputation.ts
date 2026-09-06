import type { PeerInfo } from '../types/peer.js';
import { computeRawOnChainScore, scoreFromTrust } from './on-chain-reputation.js';
import { DEFAULT_EXTERNAL_HISTORY_POLICY, scoreExternalHistory } from './external-history.js';

export function routingReputationBreakdown(peer: PeerInfo, nowMs = Date.now(), policy = DEFAULT_EXTERNAL_HISTORY_POLICY) {
  const rawChainScore = computeRawOnChainScore(peer, nowMs);
  const finite = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const cachedScore = finite(peer.onChainReputationScore);
  const cachedTrust = finite(peer.onChainTrustScore);
  const legacyChainScore = rawChainScore === null ? cachedScore ?? (cachedTrust === null ? null : scoreFromTrust(cachedTrust)) : null;
  const external = scoreExternalHistory(peer, nowMs, policy);
  const nonNegative = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  const ghosts = nonNegative(peer.onChainGhostCount);
  const channels = nonNegative(peer.onChainChannelCount);
  const risk = Math.min(1, nonNegative(peer.onChainSybilRisk));
  const failureGate = (1 - risk) * (channels + 1) / (channels + 1 + 2.5 * ghosts);
  const externalScore = external.points * failureGate;
  return { version: 1, rawChainScore, legacyChainScore, external, failureGate, externalScore,
    effectiveReputationScore: Math.min(100, Math.max(rawChainScore ?? (legacyChainScore ?? 0) * failureGate, externalScore)) };
}

export function computeRoutingReputationScore(peer: PeerInfo, nowMs = Date.now(), policy = DEFAULT_EXTERNAL_HISTORY_POLICY): number {
  return routingReputationBreakdown(peer, nowMs, policy).effectiveReputationScore;
}
