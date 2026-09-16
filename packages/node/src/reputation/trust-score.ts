import type { PeerInfo } from '../types/peer.js';
import { scoreIdentityHistory } from './identity-history.js';

/**
 * Buyer-side trust score, 0-100.
 *
 *   trust = washFlagged ? 0 : max((usage + power) / 2, identity)
 *
 * - usage:    the seller pool's share of all pools' recognized-usage points in
 *             the last complete weekly epoch (`AntseedUsageAccounting`). Points
 *             only accrue for sellers with a pool and already pass the on-chain
 *             points policies, so a proven wash trader's share is already zero.
 * - power:    the pool's share of all pools' lock-weighted staking power in the
 *             current epoch (`AntseedSellerPools`). This is what decides what a
 *             buyer's spend with this seller earns this week.
 * - identity: bootstrap credit for a verified public identity (GitHub
 *             portfolio up to 70, domain registration age up to 12) so an
 *             established operator can be routed to before it has a pool record.
 * - wash:     a seller flagged by `AntseedWashTradingRegistry` scores 0.
 *
 * Shares are unitless and self-normalizing: they do not drift as the network
 * grows or as more ANTS is staked. Each share is mapped through
 * `shareScore`, a log curve with a 1000x range (100% → 100, 10% → 67,
 * 3.5% → 60, 1% → 35), so ten equal pools all clear the default 60 gate.
 *
 * Nothing else feeds the number. Failure streaks, cooldowns, price limits and
 * allow/block lists stay separate router rules.
 */

/** Dynamic range of the share curve: a share of 1/SHARE_SCORE_RANGE scores ~0. */
export const SHARE_SCORE_RANGE = 1_000;

export interface TrustBreakdown {
  /** Final trust score, 0-100. */
  score: number;
  /** Last epoch's usage-points share; `null` when usage accounting data is unavailable. */
  usage: { score: number; shareBps: number; epoch: number } | null;
  /** Current epoch's staking-power share; `null` when pool data is unavailable. */
  power: { score: number; shareBps: number; epoch: number } | null;
  /** Verified-identity part; `null` when no verified identity has usable history. */
  identity: { score: number; kind: 'github' | 'domain'; claim: string } | null;
  /** Wash-trading registry verdict; `null` when the registry is unavailable. */
  washFlagged: boolean | null;
}

function finite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** `100 · log10(1 + (SHARE_SCORE_RANGE - 1) · share) / log10(SHARE_SCORE_RANGE)`, share in basis points. */
export function shareScore(shareBps: number): number {
  if (!Number.isFinite(shareBps) || shareBps <= 0) return 0;
  const share = Math.min(1, shareBps / 10_000);
  return 100 * Math.log10(1 + (SHARE_SCORE_RANGE - 1) * share) / Math.log10(SHARE_SCORE_RANGE);
}

/**
 * Compute the trust breakdown, or `null` when nothing about the peer is known
 * (no pool/usage read, no verified identity history, no registry read).
 */
export function computeTrustScore(peer: PeerInfo, nowMs = Date.now()): TrustBreakdown | null {
  const epoch = finite(peer.onChainUsageEpoch);
  const usageShare = finite(peer.onChainUsageShareBps);
  const usage = epoch !== null && usageShare !== null && epoch > 0
    ? { score: shareScore(usageShare), shareBps: usageShare, epoch: epoch - 1 }
    : null;

  const powerShare = finite(peer.onChainPoolPowerShareBps);
  const power = epoch !== null && powerShare !== null
    ? { score: shareScore(powerShare), shareBps: powerShare, epoch }
    : null;

  const identityHistory = scoreIdentityHistory(peer, nowMs);
  const identity = identityHistory ? { score: identityHistory.points, kind: identityHistory.kind, claim: identityHistory.claim } : null;

  const washFlagged = typeof peer.onChainWashFlagged === 'boolean' ? peer.onChainWashFlagged : null;

  if (usage === null && power === null && identity === null && washFlagged === null) return null;

  const onChain = usage || power ? ((usage?.score ?? 0) + (power?.score ?? 0)) / 2 : 0;
  const score = washFlagged ? 0 : Math.min(100, Math.max(onChain, identity?.score ?? 0));
  return { score, usage, power, identity, washFlagged };
}

/** Trust score alone, or `null` when the peer is unscored. */
export function trustScore(peer: PeerInfo, nowMs = Date.now()): number | null {
  return computeTrustScore(peer, nowMs)?.score ?? null;
}
