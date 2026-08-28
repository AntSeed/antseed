import type { PeerInfo } from '../types/peer.js';

export const ON_CHAIN_TRUST_TICKET_TARGET_USDC = 2.0;
export const ON_CHAIN_TRUST_TICKET_MIN = 0.5;
export const ON_CHAIN_TRUST_TICKET_MAX = 1.5;

export const ON_CHAIN_TRUST_RECENCY_FRESH_DAYS = 14;
export const ON_CHAIN_TRUST_RECENCY_STALE_DAYS = 60;
export const ON_CHAIN_TRUST_RECENCY_DORMANT_FACTOR = 0.25;

export const ON_CHAIN_TRUST_STAKE_THRESHOLD_USDC = 1.0;
export const ON_CHAIN_TRUST_NO_STAKE_FACTOR = 0.5;

export const ON_CHAIN_TRUST_INITIAL_CREDIT_USDC = 25;
export const ON_CHAIN_TRUST_DAILY_CREDIT_USDC = 125;
export const ON_CHAIN_TRUST_MATURITY_DAYS = 30;
export const ON_CHAIN_TRUST_CHANNEL_CONFIDENCE_CAP = 1_000;
export const ON_CHAIN_TRUST_GHOST_PENALTY_WEIGHT = 2.5;
export const ON_CHAIN_TRUST_MIN_GHOST_FACTOR = 0.25;
export const ON_CHAIN_TRUST_LOW_TICKET_USDC = 0.25;
export const ON_CHAIN_TRUST_LOW_TICKET_MIN_CHANNELS = 50;
export const ON_CHAIN_TRUST_LOW_TICKET_FACTOR = 0.65;
export const ON_CHAIN_TRUST_HIGH_TICKET_USDC = 50;
export const ON_CHAIN_TRUST_HIGH_TICKET_MAX_CHANNELS = 20;
export const ON_CHAIN_TRUST_HIGH_TICKET_FACTOR = 0.75;

export const ON_CHAIN_SCORE_LOG_CAP_USDC = 10_000;
export const ON_CHAIN_SCORE_LOG_CAP_EXPONENT = Math.log10(1 + ON_CHAIN_SCORE_LOG_CAP_USDC);
export const ON_CHAIN_VERIFICATION_DOMAIN_POINTS = 5;
export const ON_CHAIN_VERIFICATION_GITHUB_POINTS = 3;
export const ON_CHAIN_VERIFICATION_MAX_POINTS = 8;

export const SYBIL_WEIGHT_SUBFLOOR_TICKET = 0.30;
export const SYBIL_WEIGHT_BURN_RATE       = 0.25;
export const SYBIL_WEIGHT_NARROW_CUSTOM   = 0.25;
export const SYBIL_WEIGHT_YOUNG_HIGH_VOL  = 0.20;

export const SYBIL_SUBFLOOR_TICKET_USDC = 1.0;
export const SYBIL_SUBFLOOR_MIN_CHANNELS = 50;

export const SYBIL_BURN_RATE_THRESHOLD = 30;
export const SYBIL_BURN_RATE_SATURATION = 80;

export const SYBIL_YOUNG_MAX_DAYS = 14;
export const SYBIL_YOUNG_CHANNEL_FLOOR = 100;
export const SYBIL_YOUNG_CHANNEL_SATURATION = 400;

export const SYBIL_ADVERTISED_CHEAP_INPUT_USD_PER_MILLION = 0.10;

export type SybilFlag =
  | 'subfloor_ticket'
  | 'burn_rate'
  | 'narrow_custom'
  | 'young_high_vol';

export interface SybilRiskResult {
  risk: number;
  flags: SybilFlag[];
  signals: Record<SybilFlag, number>;
}

export interface SybilContext {
  serviceCounts: Map<string, number>;
}

export interface OnChainTrustBreakdown {
  trust: number;
  volumeUsdc: number;
  creditedVolumeUsdc: number;
  volumeCreditCapUsdc: number;
  channels: number;
  avgChannelUsdc: number;
  ticketBonus: number;
  ticketGate: number;
  recencyGate: number;
  stakeGate: number;
  ageGate: number;
  channelConfidence: number;
  ghostGate: number;
  scoreMultiplier: number;
  verificationBonusPoints: number;
  daysSinceLastSettled: number | null;
  daysSinceStaked: number | null;
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  if (value <= lo) return lo;
  if (value >= hi) return hi;
  return value;
}

function nonNegativeFinite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function logConfidence(value: number, cap: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return clamp(Math.log10(1 + value) / Math.log10(1 + cap), 0, 1);
}

export function computeVerificationScoreBonus(
  peer: Pick<PeerInfo, 'verificationResults'>,
): number {
  const results = peer.verificationResults;
  if (!results) return 0;
  const verifiedDomains = results.domains.filter((result) => result.verified).length;
  const verifiedGithub = results.github.filter((result) => result.verified).length;
  return clamp(
    verifiedDomains * ON_CHAIN_VERIFICATION_DOMAIN_POINTS
      + verifiedGithub * ON_CHAIN_VERIFICATION_GITHUB_POINTS,
    0,
    ON_CHAIN_VERIFICATION_MAX_POINTS,
  );
}

function collectPeerServices(peer: PeerInfo): string[] {
  const out = new Set<string>();
  const pricing = peer.providerPricing;
  if (!pricing) return [];
  for (const entry of Object.values(pricing)) {
    if (entry.services) {
      for (const name of Object.keys(entry.services)) {
        const trimmed = name.trim();
        if (trimmed.length > 0) out.add(trimmed);
      }
    }
  }
  return Array.from(out);
}

function minAdvertisedInputUsdPerMillion(peer: PeerInfo): number | null {
  let best: number | null = null;
  const consider = (value: number | undefined) => {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      if (best === null || value < best) best = value;
    }
  };
  const pricing = peer.providerPricing;
  if (pricing) {
    for (const entry of Object.values(pricing)) {
      consider(entry.defaults?.inputUsdPerMillion);
      if (entry.services) {
        for (const s of Object.values(entry.services)) {
          consider(s.inputUsdPerMillion);
        }
      }
    }
  }
  consider(peer.defaultInputUsdPerMillion);
  return best;
}

/**
 * Compute raw on-chain trust, or `null` when chain stats are unavailable.
 *
 * Trust is anchored to settled USDC, but volume credit vests with seller age.
 * Channel count, ghost rate, last-settled recency, stake, and ticket shape gate
 * the displayed score instead of multiplying settled volume directly.
 */
export function computeOnChainTrustBreakdown(
  peer: Pick<PeerInfo,
    | 'onChainChannelCount'
    | 'onChainGhostCount'
    | 'onChainTotalVolumeUsdcMicros'
    | 'onChainLastSettledAtSec'
    | 'onChainStakedAtSec'
    | 'onChainStakeUsdcMicros'
    | 'verificationResults'
  >,
  nowMs: number = Date.now(),
): OnChainTrustBreakdown | null {
  const channels = nonNegativeFinite(peer.onChainChannelCount);
  const volumeMicros = nonNegativeFinite(peer.onChainTotalVolumeUsdcMicros);
  if (channels == null || volumeMicros == null) return null;

  const volumeUsdc = volumeMicros / 1_000_000;
  const avgChannelUsdc = channels > 0 ? volumeUsdc / channels : 0;

  const lastSettledAtSec = nonNegativeFinite(peer.onChainLastSettledAtSec);
  const daysSinceLastSettled = lastSettledAtSec && lastSettledAtSec > 0
    ? Math.max(0, (nowMs - lastSettledAtSec * 1000) / 86_400_000)
    : null;
  let recencyGate: number;
  if (daysSinceLastSettled === null) {
    recencyGate = 0;
  } else if (daysSinceLastSettled < ON_CHAIN_TRUST_RECENCY_FRESH_DAYS) {
    recencyGate = 1;
  } else if (daysSinceLastSettled < ON_CHAIN_TRUST_RECENCY_STALE_DAYS) {
    recencyGate = ON_CHAIN_TRUST_RECENCY_DORMANT_FACTOR;
  } else {
    recencyGate = 0;
  }

  const stakeUsdc = (nonNegativeFinite(peer.onChainStakeUsdcMicros) ?? 0) / 1_000_000;
  const stakeGate = stakeUsdc >= ON_CHAIN_TRUST_STAKE_THRESHOLD_USDC
    ? 1
    : ON_CHAIN_TRUST_NO_STAKE_FACTOR;

  const ticketBonus = clamp(
    avgChannelUsdc / ON_CHAIN_TRUST_TICKET_TARGET_USDC,
    ON_CHAIN_TRUST_TICKET_MIN,
    ON_CHAIN_TRUST_TICKET_MAX,
  );

  const stakedAtSec = nonNegativeFinite(peer.onChainStakedAtSec);
  const daysSinceStaked = stakedAtSec && stakedAtSec > 0
    ? Math.max(0, (nowMs - stakedAtSec * 1000) / 86_400_000)
    : null;

  // Some migrated/facade accounts have no usable staking timestamp. Only
  // infer maturity once verified activity reaches the channel-confidence
  // cap; ordinary accounts with an unknown age retain the $25 new-seller
  // volume cap.
  const inferredMatureAccount = daysSinceStaked === null
    && stakeUsdc >= ON_CHAIN_TRUST_STAKE_THRESHOLD_USDC
    && channels >= ON_CHAIN_TRUST_CHANNEL_CONFIDENCE_CAP;
  const maturityDays = daysSinceStaked
    ?? (inferredMatureAccount ? ON_CHAIN_TRUST_MATURITY_DAYS : 0);
  const volumeCreditCapUsdc = ON_CHAIN_TRUST_INITIAL_CREDIT_USDC
    + maturityDays * ON_CHAIN_TRUST_DAILY_CREDIT_USDC;
  const creditedVolumeUsdc = Math.min(volumeUsdc, volumeCreditCapUsdc);

  const ageGate = clamp(maturityDays / ON_CHAIN_TRUST_MATURITY_DAYS, 0.20, 1);
  const channelConfidence = 0.35
    + 0.65 * logConfidence(channels, ON_CHAIN_TRUST_CHANNEL_CONFIDENCE_CAP);

  const ghosts = nonNegativeFinite(peer.onChainGhostCount) ?? 0;
  const ghostRate = channels + ghosts > 0 ? ghosts / (channels + ghosts) : 0;
  const ghostGate = clamp(
    1 - ghostRate * ON_CHAIN_TRUST_GHOST_PENALTY_WEIGHT,
    ON_CHAIN_TRUST_MIN_GHOST_FACTOR,
    1,
  );

  let ticketGate = 1;
  if (channels >= ON_CHAIN_TRUST_LOW_TICKET_MIN_CHANNELS && avgChannelUsdc < ON_CHAIN_TRUST_LOW_TICKET_USDC) {
    ticketGate = ON_CHAIN_TRUST_LOW_TICKET_FACTOR;
  } else if (channels > 0 && channels < ON_CHAIN_TRUST_HIGH_TICKET_MAX_CHANNELS && avgChannelUsdc > ON_CHAIN_TRUST_HIGH_TICKET_USDC) {
    ticketGate = ON_CHAIN_TRUST_HIGH_TICKET_FACTOR;
  }

  const scoreMultiplier = channelConfidence
    * ageGate
    * ghostGate
    * recencyGate
    * stakeGate
    * ticketGate;
  const verificationBonusPoints = computeVerificationScoreBonus(peer);

  const trust = creditedVolumeUsdc;

  return {
    trust,
    volumeUsdc,
    creditedVolumeUsdc,
    volumeCreditCapUsdc,
    channels,
    avgChannelUsdc,
    ticketBonus,
    ticketGate,
    recencyGate,
    stakeGate,
    ageGate,
    channelConfidence,
    ghostGate,
    scoreMultiplier,
    verificationBonusPoints,
    daysSinceLastSettled,
    daysSinceStaked,
  };
}

export function computeOnChainTrust(
  peer: Parameters<typeof computeOnChainTrustBreakdown>[0],
  nowMs: number = Date.now(),
): number | null {
  return computeOnChainTrustBreakdown(peer, nowMs)?.trust ?? null;
}

export function buildSybilContext(peers: ReadonlyArray<PeerInfo>): SybilContext {
  const serviceCounts = new Map<string, number>();
  for (const peer of peers) {
    for (const name of collectPeerServices(peer)) {
      serviceCounts.set(name, (serviceCounts.get(name) ?? 0) + 1);
    }
  }
  return { serviceCounts };
}

/** Heuristic wash-trading risk in [0, 1]. */
export function computeOnChainSybilRisk(
  peer: PeerInfo,
  ctx: SybilContext,
  nowMs: number = Date.now(),
): SybilRiskResult {
  const channels = nonNegativeFinite(peer.onChainChannelCount) ?? 0;
  const volumeUsdc = (nonNegativeFinite(peer.onChainTotalVolumeUsdcMicros) ?? 0) / 1_000_000;
  const avgChannelUsdc = channels > 0 ? volumeUsdc / channels : 0;

  const stakedAtSec = nonNegativeFinite(peer.onChainStakedAtSec);
  const daysSinceStaked: number | null = stakedAtSec && stakedAtSec > 0
    ? Math.max(0, (nowMs - stakedAtSec * 1000) / 86_400_000)
    : null;
  const channelsPerDay: number | null = daysSinceStaked !== null && daysSinceStaked > 0
    ? channels / daysSinceStaked
    : null;

  const services = collectPeerServices(peer);
  const advertisedInput = minAdvertisedInputUsdPerMillion(peer);

  let narrowCustom = 0;
  if (services.length > 0 && services.length <= 2) {
    const allExclusive = services.every((s) => (ctx.serviceCounts.get(s) ?? 0) <= 1);
    if (allExclusive) narrowCustom = services.length === 1 ? 1.0 : 0.5;
  }

  let burnRate = 0;
  if (narrowCustom > 0 && channelsPerDay !== null) {
    burnRate = clamp(
      (channelsPerDay - SYBIL_BURN_RATE_THRESHOLD)
        / (SYBIL_BURN_RATE_SATURATION - SYBIL_BURN_RATE_THRESHOLD),
      0, 1,
    );
  }

  let subfloorTicket = 0;
  const advertisedCheap = advertisedInput != null
    && advertisedInput <= SYBIL_ADVERTISED_CHEAP_INPUT_USD_PER_MILLION;
  if (!advertisedCheap && channels >= SYBIL_SUBFLOOR_MIN_CHANNELS && avgChannelUsdc < SYBIL_SUBFLOOR_TICKET_USDC) {
    subfloorTicket = clamp(
      (SYBIL_SUBFLOOR_TICKET_USDC - avgChannelUsdc) / SYBIL_SUBFLOOR_TICKET_USDC,
      0, 1,
    );
  }

  let youngHighVol = 0;
  if (
    daysSinceStaked !== null
    && daysSinceStaked < SYBIL_YOUNG_MAX_DAYS
    && channels > SYBIL_YOUNG_CHANNEL_FLOOR
  ) {
    const ageComponent = clamp(
      (SYBIL_YOUNG_MAX_DAYS - daysSinceStaked) / SYBIL_YOUNG_MAX_DAYS, 0, 1,
    );
    const volComponent = clamp(
      (channels - SYBIL_YOUNG_CHANNEL_FLOOR)
        / (SYBIL_YOUNG_CHANNEL_SATURATION - SYBIL_YOUNG_CHANNEL_FLOOR),
      0, 0.5,
    );
    youngHighVol = Math.min(1, ageComponent + volComponent);
  }

  const signals: Record<SybilFlag, number> = {
    subfloor_ticket: subfloorTicket,
    burn_rate: burnRate,
    narrow_custom: narrowCustom,
    young_high_vol: youngHighVol,
  };

  const risk = Math.min(1,
    SYBIL_WEIGHT_SUBFLOOR_TICKET * subfloorTicket
    + SYBIL_WEIGHT_BURN_RATE       * burnRate
    + SYBIL_WEIGHT_NARROW_CUSTOM   * narrowCustom
    + SYBIL_WEIGHT_YOUNG_HIGH_VOL  * youngHighVol,
  );

  const flags = (Object.keys(signals) as SybilFlag[])
    .filter((k) => signals[k] > 0.05)
    .sort((a, b) => signals[b] - signals[a]);

  return { risk, flags, signals };
}

export function scoreFromTrust(trust: number): number {
  if (!Number.isFinite(trust) || trust <= 0) return 0;
  return Math.min(100, (100 / ON_CHAIN_SCORE_LOG_CAP_EXPONENT) * Math.log10(1 + trust));
}

function scoreFromBreakdown(breakdown: OnChainTrustBreakdown, risk: number): number {
  const baseScore = scoreFromTrust(breakdown.trust);
  const chainScore = baseScore * breakdown.scoreMultiplier * (1 - clamp(risk, 0, 1));
  if (chainScore <= 0) return chainScore;
  return Math.min(100, chainScore + breakdown.verificationBonusPoints);
}

export function computeOnChainScoreWithRisk(
  peer: PeerInfo,
  risk: number,
  nowMs: number = Date.now(),
): number | null {
  const breakdown = computeOnChainTrustBreakdown(peer, nowMs);
  if (breakdown === null) return null;
  return scoreFromBreakdown(breakdown, risk);
}

export function computeOnChainScore(
  peer: PeerInfo,
  ctx?: SybilContext,
  nowMs: number = Date.now(),
): number | null {
  const breakdown = computeOnChainTrustBreakdown(peer, nowMs);
  if (breakdown === null) return null;
  const risk = ctx ? computeOnChainSybilRisk(peer, ctx, nowMs).risk : 0;
  return scoreFromBreakdown(breakdown, risk);
}

export function computeOnChainReputationScore(
  peer: PeerInfo,
  nowMs: number = Date.now(),
): number | null {
  return computeOnChainScore(peer, undefined, nowMs);
}
