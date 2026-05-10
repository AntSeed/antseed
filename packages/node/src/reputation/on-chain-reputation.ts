import type { PeerInfo } from '../types/peer.js';

export const ON_CHAIN_REPUTATION_CHANNEL_LOG_TARGET = 120;
export const ON_CHAIN_REPUTATION_VOLUME_LOG_TARGET_USDC = 1000;
export const ON_CHAIN_REPUTATION_VOLUME_EXPONENT = 1.25;
export const ON_CHAIN_REPUTATION_AVG_CHANNEL_TARGET_USDC = 2;
export const ON_CHAIN_REPUTATION_RECENCY_DECAY_DAYS = 30;
export const ON_CHAIN_REPUTATION_RECENCY_FLOOR = 0.25;
export const ON_CHAIN_REPUTATION_GHOST_PENALTY_MULTIPLIER = 3;
export const ON_CHAIN_REPUTATION_QUALITY_FLOOR = 0.60;
export const ON_CHAIN_REPUTATION_CHANNEL_WEIGHT = 0.15;
export const ON_CHAIN_REPUTATION_AVG_CHANNEL_WEIGHT = 0.15;
export const ON_CHAIN_REPUTATION_RECENCY_WEIGHT = 0.05;
export const ON_CHAIN_REPUTATION_STAKE_AGE_TARGET_DAYS = 30;
export const ON_CHAIN_REPUTATION_STAKE_AGE_WEIGHT = 0.05;

export type OnChainReputationBreakdown = {
  score: number;
  channelFactor: number;
  volumeFactor: number;
  avgChannelFactor: number;
  recencyFactor: number;
  stakeAgeFactor: number;
  ghostPenalty: number;
  channels: number;
  ghosts: number;
  volumeUsdc: number;
  avgChannelUsdc: number;
  daysSinceLastSettled: number | null;
  daysSinceStaked: number | null;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function nonNegativeFinite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function logFactor(value: number, target: number): number {
  if (value <= 0 || target <= 0) return 0;
  return clamp01(Math.log1p(value) / Math.log1p(target));
}

/**
 * Computes an explainable 0-100 on-chain reputation score from AntseedChannels stats.
 *
 * The score is multi-factor: settled USDC volume carries the largest weight,
 * using an exponent-shaped logarithmic curve so low-volume sellers do not rank
 * highly just because they have many small channels. Channel count, average
 * channel value, recent settlement activity, and staking age all contribute,
 * while a high ghost-channel ratio penalizes the result.
 */
export function computeOnChainReputationBreakdown(
  peer: Pick<PeerInfo,
    | 'onChainChannelCount'
    | 'onChainGhostCount'
    | 'onChainTotalVolumeUsdcMicros'
    | 'onChainLastSettledAtSec'
    | 'onChainStakedAtSec'
  >,
  nowMs: number = Date.now(),
): OnChainReputationBreakdown | null {
  const channels = nonNegativeFinite(peer.onChainChannelCount);
  const volumeMicros = nonNegativeFinite(peer.onChainTotalVolumeUsdcMicros);

  if (channels == null && volumeMicros == null) {
    return null;
  }

  const safeChannels = channels ?? 0;
  const ghosts = nonNegativeFinite(peer.onChainGhostCount) ?? 0;
  const volumeUsdc = (volumeMicros ?? 0) / 1_000_000;
  const avgChannelUsdc = safeChannels > 0 ? volumeUsdc / safeChannels : 0;
  const lastSettledAtSec = nonNegativeFinite(peer.onChainLastSettledAtSec);
  const daysSinceLastSettled = lastSettledAtSec && lastSettledAtSec > 0
    ? Math.max(0, (nowMs - lastSettledAtSec * 1000) / 86_400_000)
    : null;
  const stakedAtSec = nonNegativeFinite(peer.onChainStakedAtSec);
  const daysSinceStaked = stakedAtSec && stakedAtSec > 0
    ? Math.max(0, (nowMs - stakedAtSec * 1000) / 86_400_000)
    : null;

  const channelFactor = logFactor(safeChannels, ON_CHAIN_REPUTATION_CHANNEL_LOG_TARGET);
  const volumeFactor = Math.pow(
    logFactor(volumeUsdc, ON_CHAIN_REPUTATION_VOLUME_LOG_TARGET_USDC),
    ON_CHAIN_REPUTATION_VOLUME_EXPONENT,
  );
  const avgChannelFactor = clamp01(avgChannelUsdc / ON_CHAIN_REPUTATION_AVG_CHANNEL_TARGET_USDC);
  const recencyFactor = daysSinceLastSettled == null
    ? ON_CHAIN_REPUTATION_RECENCY_FLOOR
    : Math.max(
      ON_CHAIN_REPUTATION_RECENCY_FLOOR,
      Math.exp(-daysSinceLastSettled / ON_CHAIN_REPUTATION_RECENCY_DECAY_DAYS),
    );
  const stakeAgeFactor = daysSinceStaked == null
    ? 1
    : clamp01(daysSinceStaked / ON_CHAIN_REPUTATION_STAKE_AGE_TARGET_DAYS);
  const ghostRate = (safeChannels + ghosts) > 0 ? ghosts / (safeChannels + ghosts) : 0;
  const ghostPenalty = clamp01(1 - ON_CHAIN_REPUTATION_GHOST_PENALTY_MULTIPLIER * ghostRate);

  const qualityMultiplier = ON_CHAIN_REPUTATION_QUALITY_FLOOR
    + ON_CHAIN_REPUTATION_CHANNEL_WEIGHT * channelFactor
    + ON_CHAIN_REPUTATION_AVG_CHANNEL_WEIGHT * avgChannelFactor
    + ON_CHAIN_REPUTATION_RECENCY_WEIGHT * recencyFactor
    + ON_CHAIN_REPUTATION_STAKE_AGE_WEIGHT * stakeAgeFactor;
  const volumeActivityScore = volumeUsdc > 0 ? 100 * volumeFactor * qualityMultiplier : 0;
  const score = Math.min(100, volumeActivityScore * ghostPenalty);

  return {
    score,
    channelFactor,
    volumeFactor,
    avgChannelFactor,
    recencyFactor,
    stakeAgeFactor,
    ghostPenalty,
    channels: safeChannels,
    ghosts,
    volumeUsdc,
    avgChannelUsdc,
    daysSinceLastSettled,
    daysSinceStaked,
  };
}

export function computeOnChainReputationScore(
  peer: Parameters<typeof computeOnChainReputationBreakdown>[0],
  nowMs: number = Date.now(),
): number | null {
  return computeOnChainReputationBreakdown(peer, nowMs)?.score ?? null;
}
