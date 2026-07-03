import type {
  ChatServiceOptionEntry,
  DiscoverRow,
  VprRouteSelection,
  VprRoutingPreferences,
} from '../core/state';
import { chooseBestVprRoute } from './vpr-routing.js';
import { routesForSelectedModel } from './vpr-view-models.js';

export function findChatOptionForVprSelection(
  options: ChatServiceOptionEntry[],
  selection: VprRouteSelection,
): ChatServiceOptionEntry | null {
  if (!selection.model) return null;
  return options.find((option) => (
    option.provider === selection.model?.provider &&
    option.id === selection.model.serviceId &&
    (
      selection.mode !== 'pinned-peer' ||
      !selection.peerId ||
      option.peerId === selection.peerId
    )
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

  const bestRoute = chooseBestVprRoute(routesForSelectedModel(rows, selection.model), preferences);
  if (bestRoute) {
    const bestOption = options.find((option) => (
      option.provider === selection.model?.provider &&
      option.id === selection.model.serviceId &&
      option.peerId === bestRoute.peerId
    ));
    if (bestOption) return bestOption;
  }

  return findChatOptionForVprSelection(options, selection);
}
