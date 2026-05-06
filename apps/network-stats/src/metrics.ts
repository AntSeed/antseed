/**
 * Metrics derived from the latest DHT snapshot. Pure function — the
 * server recomputes per /stats request from the in-memory peer list.
 */

import type { PeerMetadata } from '@antseed/node';

import { asc, bump, collectPeerSets, pct } from './utils.js';

export interface NetworkMetrics {
  peerCount: number;
  serviceCounts: Record<string, number>;          // peer-deduped
  serviceCategoryCounts: Record<string, number>;  // peer-deduped (coding, tee, ...)
  stake: {
    totalUsdc: number;
    medianUsdc: number;
    p95Usdc: number;
    peersWithStake: number;
  } | null;
  freshness: {
    medianAgeSeconds: number;
    p95AgeSeconds: number;
    oldestAgeSeconds: number;
    newestAgeSeconds: number;
  } | null;
  peersWithSellerContract: number;
  peersWithDisplayName: number;
}

export function computeNetworkMetrics(
  peers: readonly PeerMetadata[],
  nowMs: number = Date.now(),
): NetworkMetrics {
  const services: Record<string, number> = {};
  const categories: Record<string, number> = {};
  const stakes: number[] = [];
  const ages: number[] = [];
  let peersWithSellerContract = 0;
  let peersWithDisplayName = 0;

  for (const peer of peers) {
    // A peer that exposes the same service through two provider entries
    // should still increment the bucket once — collectPeerSets dedups per peer.
    const sets = collectPeerSets(peer);
    for (const svc of sets.services) bump(services, svc);
    for (const cat of sets.categories) bump(categories, cat);

    if (peer.stakeAmountUSDC) stakes.push(peer.stakeAmountUSDC);
    if (peer.timestamp) {
      // Clamp negative ages so a provider whose clock is ahead of ours
      // doesn't show up as a future-dated peer.
      ages.push(Math.max(0, Math.floor((nowMs - peer.timestamp) / 1000)));
    }
    if (peer.sellerContract) peersWithSellerContract++;
    if (peer.displayName) peersWithDisplayName++;
  }

  // Sort once per metric — percentiles and extremes all read off the
  // sorted view. Replaces the older `Math.max(...arr)` spread, which
  // also has a stack-arg ceiling at large input sizes.
  const sortedStakes = [...stakes].sort(asc);
  const sortedAges = [...ages].sort(asc);

  return {
    peerCount: peers.length,
    serviceCounts: services,
    serviceCategoryCounts: categories,
    stake: stakes.length === 0 ? null : {
      totalUsdc: stakes.reduce((sum, x) => sum + x, 0),
      medianUsdc: pct(sortedStakes, 0.5),
      p95Usdc: pct(sortedStakes, 0.95),
      peersWithStake: stakes.length,
    },
    freshness: ages.length === 0 ? null : {
      medianAgeSeconds: pct(sortedAges, 0.5),
      p95AgeSeconds: pct(sortedAges, 0.95),
      oldestAgeSeconds: sortedAges[sortedAges.length - 1]!,
      newestAgeSeconds: sortedAges[0]!,
    },
    peersWithSellerContract,
    peersWithDisplayName,
  };
}
