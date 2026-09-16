import type { PeerInfo } from '../types/peer.js';
import { scoreIdentityHistory } from './identity-history.js';

/**
 * Buyer-side trust score, 0-100.
 *
 *   trust = washFlagged ? 0 : min(100, max(usage, identity) + stake)
 *
 * - usage:    recognized-usage points (USDC settled and accounted through
 *             `AntseedUsageAccounting`) in the best of the current and previous
 *             weekly epoch. Points already pass through the on-chain points
 *             policies, so usage from a proven wash trader is already zero.
 * - identity: bootstrap credit for a verified public identity (GitHub
 *             portfolio up to 70, domain registration age up to 12) so an
 *             established operator can be routed to before it has usage.
 * - stake:    up to 15 points for the seller pool's share of network staking
 *             power (lock-weighted ANTS), scaled by square root so small pools
 *             still register.
 * - wash:     a seller flagged by `AntseedWashTradingRegistry` scores 0.
 *
 * Nothing else feeds the number. Failure streaks, cooldowns, price limits and
 * allow/block lists stay separate router rules.
 */

/** Recognized usage per epoch (USDC) at which the usage part reaches 100. */
export const TRUST_USAGE_FULL_SCORE_USDC = 1_000;
/** Maximum points from pool staking power share. */
export const TRUST_STAKE_MAX_POINTS = 15;

export interface TrustBreakdown {
  /** Final trust score, 0-100. */
  score: number;
  /** Recognized-usage part; `null` when usage accounting data is unavailable. */
  usage: { score: number; usdc: number; epoch: number } | null;
  /** Verified-identity part; `null` when no verified identity has usable history. */
  identity: { score: number; kind: 'github' | 'domain'; claim: string } | null;
  /** Pool staking-power part; `null` when pool data is unavailable. */
  stake: { score: number; powerShareBps: number } | null;
  /** Wash-trading registry verdict; `null` when the registry is unavailable. */
  washFlagged: boolean | null;
}

function finite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 0 at $0, 100 at `TRUST_USAGE_FULL_SCORE_USDC`, logarithmic in between. */
export function usageScoreFromUsdc(usdc: number): number {
  if (!Number.isFinite(usdc) || usdc <= 0) return 0;
  return Math.min(100, 100 * Math.log10(1 + usdc) / Math.log10(1 + TRUST_USAGE_FULL_SCORE_USDC));
}

/** `TRUST_STAKE_MAX_POINTS * sqrt(share)`; share is the pool's fraction of network power. */
export function stakeScoreFromPowerShareBps(shareBps: number): number {
  if (!Number.isFinite(shareBps) || shareBps <= 0) return 0;
  return TRUST_STAKE_MAX_POINTS * Math.sqrt(Math.min(1, shareBps / 10_000));
}

/**
 * Compute the trust breakdown, or `null` when nothing about the peer is known
 * (no recognized-usage read, no verified identity history, no registry read).
 */
export function computeTrustScore(peer: PeerInfo, nowMs = Date.now()): TrustBreakdown | null {
  const current = finite(peer.onChainUsageCurrentEpochUsdcMicros);
  const last = finite(peer.onChainUsageLastEpochUsdcMicros);
  const epoch = finite(peer.onChainUsageEpoch);
  const usage = current !== null && last !== null && epoch !== null
    ? (() => { const usdc = Math.max(current, last) / 1_000_000; return { score: usageScoreFromUsdc(usdc), usdc, epoch }; })()
    : null;

  const identityHistory = scoreIdentityHistory(peer, nowMs);
  const identity = identityHistory ? { score: identityHistory.points, kind: identityHistory.kind, claim: identityHistory.claim } : null;

  const shareBps = finite(peer.onChainPoolPowerShareBps);
  const stake = shareBps !== null ? { score: stakeScoreFromPowerShareBps(shareBps), powerShareBps: shareBps } : null;

  const washFlagged = typeof peer.onChainWashFlagged === 'boolean' ? peer.onChainWashFlagged : null;

  if (usage === null && identity === null && washFlagged === null) return null;

  const score = washFlagged
    ? 0
    : Math.min(100, Math.max(usage?.score ?? 0, identity?.score ?? 0) + (stake?.score ?? 0));
  return { score, usage, identity, stake, washFlagged };
}

/** Trust score alone, or `null` when the peer is unscored. */
export function trustScore(peer: PeerInfo, nowMs = Date.now()): number | null {
  return computeTrustScore(peer, nowMs)?.score ?? null;
}
