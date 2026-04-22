import type { PeerInfo } from '@antseed/node';

/**
 * Parse a comma-separated `--tag` argument into a lowercased set. Empty or
 * whitespace-only entries are dropped; returns an empty set for undefined
 * input so callers can treat "no filter" and "empty filter" uniformly.
 */
export function parseTagFilter(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const piece of raw.split(',')) {
    const normalized = piece.trim().toLowerCase();
    if (normalized.length > 0) out.add(normalized);
  }
  return out;
}

/**
 * Collect every service category tag announced by the peer, flattened across
 * all providers and services and lowercased so comparison is case-insensitive.
 */
export function collectPeerTags(peer: PeerInfo): Set<string> {
  const tags = new Set<string>();
  const categories = peer.providerServiceCategories;
  if (categories) {
    for (const providerEntry of Object.values(categories)) {
      for (const serviceTags of Object.values(providerEntry.services)) {
        for (const raw of serviceTags) {
          const normalized = raw.trim().toLowerCase();
          if (normalized.length > 0) tags.add(normalized);
        }
      }
    }
  }
  return tags;
}

/**
 * Collect the tags announced for a specific (provider, service) pair.
 * Returned sorted for stable rendering.
 */
export function collectServiceTags(
  peer: PeerInfo,
  providerName: string,
  serviceName: string,
): string[] {
  const raw = peer.providerServiceCategories?.[providerName]?.services?.[serviceName] ?? [];
  return Array.from(new Set(raw.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))).sort();
}

/**
 * A peer matches the tag filter when *any* of its announced service tags
 * matches *any* of the requested tags (OR semantics across both sides).
 * An empty requested set matches every peer.
 */
export function peerMatchesTagFilter(peer: PeerInfo, requestedTags: Set<string>): boolean {
  if (requestedTags.size === 0) return true;
  const peerTags = collectPeerTags(peer);
  for (const tag of requestedTags) {
    if (peerTags.has(tag)) return true;
  }
  return false;
}

/**
 * Does this specific (provider, service) pair match the tag filter?
 * Used by the peer detail command to hide services that don't match while
 * keeping providers that still have at least one matching service.
 */
export function serviceMatchesTagFilter(
  peer: PeerInfo,
  providerName: string,
  serviceName: string,
  requestedTags: Set<string>,
): boolean {
  if (requestedTags.size === 0) return true;
  const serviceTags = new Set(collectServiceTags(peer, providerName, serviceName));
  for (const tag of requestedTags) {
    if (serviceTags.has(tag)) return true;
  }
  return false;
}
