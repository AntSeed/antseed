import type { VprPeerListing, VprRoutingPreferences } from '../core/state';
import { peerListingOf } from './vpr-preferences';
import type { VprPeerOption } from './vpr-tools';

/**
 * What actually happens to a seller under the current rules.
 *
 * `allowed`/`blocked` are explicit choices the user made. The other two are
 * consequences of the allowlist as a whole: with no allowlist every unlisted
 * seller is `eligible`, but the moment one seller is allowed, every other
 * unlisted seller silently becomes `excluded`. Surfacing that difference is
 * the whole point of this type — the rules are not per-row independent.
 */
export type PeerAccessStatus = 'allowed' | 'blocked' | 'eligible' | 'excluded';

export type PeerAccessRow = {
  peerId: string;
  label: string;
  online: boolean;
  listing: VprPeerListing;
  status: PeerAccessStatus;
};

export function peerAccessStatus(
  peerId: string,
  preferences: VprRoutingPreferences,
): PeerAccessStatus {
  const listing = peerListingOf(preferences, peerId);
  if (listing !== 'none') return listing;
  return preferences.allowedPeerIds.length > 0 ? 'excluded' : 'eligible';
}

export const PEER_ACCESS_STATUS_LABEL: Record<PeerAccessStatus, string> = {
  allowed: 'Allowed',
  blocked: 'Blocked',
  eligible: 'Can be used',
  excluded: 'Not on allowlist',
};

/**
 * Every seller the user could rule on, in a stable order — discovery order
 * first, then any listed peer that discovery no longer returns, so a rule on a
 * peer that went offline stays visible and removable.
 */
export function buildPeerAccessRows(
  peerOptions: VprPeerOption[],
  preferences: VprRoutingPreferences,
): PeerAccessRow[] {
  const rows: PeerAccessRow[] = peerOptions.map((peer) => ({
    peerId: peer.peerId,
    label: peer.label,
    online: peer.online,
    listing: peerListingOf(preferences, peer.peerId),
    status: peerAccessStatus(peer.peerId, preferences),
  }));

  const known = new Set(peerOptions.map((peer) => peer.peerId));
  for (const peerId of [...preferences.allowedPeerIds, ...preferences.blockedPeerIds]) {
    if (known.has(peerId)) continue;
    known.add(peerId);
    rows.push({
      peerId,
      label: peerId,
      online: false,
      listing: peerListingOf(preferences, peerId),
      status: peerAccessStatus(peerId, preferences),
    });
  }

  return rows;
}

export function filterPeerAccessRows(rows: PeerAccessRow[], search: string): PeerAccessRow[] {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return rows;
  return rows.filter((row) => (
    row.label.toLowerCase().includes(needle) || row.peerId.toLowerCase().includes(needle)
  ));
}

/** One sentence stating which rule is in force, for the modal banner. */
export function peerAccessModeLabel(preferences: VprRoutingPreferences): string {
  const allowed = preferences.allowedPeerIds.length;
  const blocked = preferences.blockedPeerIds.length;

  if (allowed > 0) {
    return `Allowlist is on: only the ${allowed} allowed ${allowed === 1 ? 'seller' : 'sellers'} can be used. `
      + 'Every other seller is excluded, blocked or not.';
  }
  if (blocked > 0) {
    return `Every seller can be used except the ${blocked} you blocked.`;
  }
  return 'Every seller can be used. Block the ones you never want, or allow a few to use only those.';
}

/** "No restrictions" / "2 allowed · 1 blocked" summary for the Preferences row. */
export function peerAccessSummaryLabel(allowedCount: number, blockedCount: number): string {
  if (allowedCount === 0 && blockedCount === 0) return 'No restrictions';
  const parts: string[] = [];
  if (allowedCount > 0) parts.push(`${allowedCount} allowed`);
  if (blockedCount > 0) parts.push(`${blockedCount} blocked`);
  return parts.join(' · ');
}
