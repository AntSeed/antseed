import type {
  ChatServiceOptionEntry,
  DiscoverRow,
  VprRouteSelection,
  VprRoutingPreferences,
} from '../../core/state';
import { sameCanonicalModel } from '../catalog/model-identity.js';
import { chooseBestVprRoute } from '../routing/select.js';
import { routesForSelectedModel } from '../catalog/view-models.js';

export function findChatOptionForVprSelection(
  options: ChatServiceOptionEntry[],
  selection: VprRouteSelection,
): ChatServiceOptionEntry | null {
  const model = selection.model;
  if (!model) return null;
  const peerMatches = (option: ChatServiceOptionEntry): boolean => (
    selection.mode !== 'pinned-peer' ||
    !selection.peerId ||
    option.peerId === selection.peerId
  );
  // Exact provider+serviceId first; then any canonical variant of the model
  // (entries aggregate near-identical serviceIds across providers). The
  // matched option carries its own advertised serviceId, which is what
  // dispatch must send to its peer.
  return options.find((option) => (
    option.provider === model.provider && option.id === model.serviceId && peerMatches(option)
  )) ?? options.find((option) => (
    sameCanonicalModel(option.id, model.serviceId) && peerMatches(option)
  )) ?? null;
}

/**
 * Resolve the chat option a VPR selection should dispatch to. Pinned mode
 * requires the exact peer (a missing pin returns null so callers can fall
 * back to the user's explicit chat selection). Auto mode picks the peer via
 * the routing-preferences scorer instead of whichever option sorts first, so
 * preferences apply to real dispatch — not just the "best route" labels.
 */
export function resolveVprChatOption(
  options: ChatServiceOptionEntry[],
  rows: DiscoverRow[],
  selection: VprRouteSelection,
  preferences: VprRoutingPreferences,
): ChatServiceOptionEntry | null {
  if (!selection.model) return null;
  if (selection.mode === 'pinned-peer' && selection.peerId) {
    return findChatOptionForVprSelection(options, selection);
  }

  // The option is looked up by the chosen ROW's provider/serviceId (not the
  // selection's): the entry may aggregate serviceId variants, and the request
  // must carry the id the routed peer actually advertises.
  const bestRoute = chooseBestVprRoute(routesForSelectedModel(rows, selection.model), preferences);
  if (bestRoute) {
    const bestOption = options.find((option) => (
      option.provider === bestRoute.provider &&
      option.id === bestRoute.serviceId &&
      option.peerId === bestRoute.peerId
    )) ?? options.find((option) => (
      option.id === bestRoute.serviceId &&
      option.peerId === bestRoute.peerId
    ));
    if (bestOption) return bestOption;
  }

  return findChatOptionForVprSelection(options, selection);
}
