/**
 * Resolves per-service usage hashes back to human service (model) names.
 *
 * The buyer daemon attributes usage per service as keccak256(serviceName)
 * (see getServiceMetadataId in @antseed/node) — the hash is what goes into
 * SpendingAuth metadata. To show per-model usage (and price it against a
 * retail baseline) we need the name back. Hashing is one-way, so we build a
 * reverse map from every service name the buyer has ever seen advertised in
 * buyer.state.json. Names that no longer appear in the peer cache resolve to
 * null and are simply excluded from savings math.
 */
import { readFile } from 'node:fs/promises';
import { getServiceMetadataId } from '@antseed/node';
import { DEFAULT_BUYER_STATE_PATH } from '../constants.js';

/** hash → service name. Grows monotonically within a desktop session so a
    briefly-offline peer doesn't unresolve models we already attributed. */
const hashToName = new Map<string, string>();
/** Names already hashed (avoid re-hashing on every refresh). */
const hashedNames = new Set<string>();

function addName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed || hashedNames.has(trimmed)) return;
  hashedNames.add(trimmed);
  try {
    hashToName.set(getServiceMetadataId(trimmed).toLowerCase(), trimmed);
  } catch {
    // Hashing never throws for plain strings — belt and braces.
  }
}

async function refreshFromBuyerState(): Promise<void> {
  try {
    const raw = await readFile(DEFAULT_BUYER_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const peers = Array.isArray(parsed.discoveredPeers) ? parsed.discoveredPeers : [];
    for (const peer of peers) {
      if (!peer || typeof peer !== 'object') continue;
      const services = (peer as Record<string, unknown>).services;
      if (!Array.isArray(services)) continue;
      for (const service of services) {
        if (typeof service === 'string') addName(service);
      }
    }
  } catch {
    // No buyer state yet — resolve from whatever we've accumulated.
  }
}

/**
 * Resolve service-id hashes to names. Refreshes the reverse map from
 * buyer.state.json only when an unknown hash is present.
 */
export async function resolveServiceIdHashes(hashes: string[]): Promise<Map<string, string>> {
  const wanted = hashes.map((h) => h.toLowerCase());
  if (wanted.some((h) => !hashToName.has(h))) {
    await refreshFromBuyerState();
  }
  const resolved = new Map<string, string>();
  for (const hash of wanted) {
    const name = hashToName.get(hash);
    if (name) resolved.set(hash, name);
  }
  return resolved;
}
