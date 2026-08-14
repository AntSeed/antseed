import type { RendererUiState } from '../../core/state';
import { subscribe } from '../../core/store';
import type { DesktopBridge } from '../../types/bridge';
import type { ConnectedAppModelCatalogSnapshot } from '../../../shared/connected-app-model-catalog';
import { loadFavoriteModels, VPR_FAVORITES_CHANGED_EVENT } from './favorites';
import {
  catalogEntryKey,
  selectFavoriteVprCatalog,
  selectRecommendedVprCatalog,
} from './recommended';
import { routesForSelectedModel } from './view-models';
import { vprModelPinFor } from '../routing/model-pins';
import { chooseBestVprRoute } from '../routing/select';

const PUSH_DEBOUNCE_MS = 600;

export function connectedAppModelCatalog(uiState: RendererUiState): ConnectedAppModelCatalogSnapshot {
  const favorites = loadFavoriteModels();
  const favoriteEntries = selectFavoriteVprCatalog(uiState.vprModelCatalog, favorites);
  const recommended = selectRecommendedVprCatalog(uiState.vprModelCatalog)
    .filter((entry) => !favorites.has(catalogEntryKey(entry)));
  const models = [...favoriteEntries, ...recommended].flatMap((entry) => {
    if (entry.serviceId.trim().toLowerCase() === 'antseed') return [];
    const routes = routesForSelectedModel(uiState.vprRoutableRows, entry);
    const activePeerId = uiState.vprRouteSelection.model
      && uiState.vprRouteSelection.model.provider === entry.provider
      && uiState.vprRouteSelection.model.serviceId === entry.serviceId
      && uiState.vprRouteSelection.mode === 'pinned-peer'
      ? uiState.vprRouteSelection.peerId
      : null;
    const pinnedPeerId = activePeerId
      ?? vprModelPinFor(uiState.vprModelPins, entry.provider, entry.serviceId);
    const route = (pinnedPeerId
      ? routes.find((candidate) => candidate.peerId === pinnedPeerId)
      : null)
      ?? chooseBestVprRoute(routes, uiState.vprRoutingPreferences);
    return route
      ? [{ provider: route.provider, id: route.serviceId, name: entry.label, peerId: route.peerId }]
      : [];
  });
  return { models };
}

export function initConnectedAppModelCatalogSync({ bridge, uiState }: {
  bridge: DesktopBridge | undefined;
  uiState: RendererUiState;
}): void {
  if (!bridge?.systemProxySyncModelCatalog) return;
  let lastPushedJson = '';
  let timer: number | null = null;

  const push = (): void => {
    const snapshot = connectedAppModelCatalog(uiState);
    const json = JSON.stringify(snapshot);
    if (json === lastPushedJson) return;
    lastPushedJson = json;
    void bridge.systemProxySyncModelCatalog?.(snapshot).then((result) => {
      if (!result.ok) lastPushedJson = '';
    }).catch(() => { lastPushedJson = ''; });
  };

  const schedulePush = (): void => {
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      push();
    }, PUSH_DEBOUNCE_MS);
  };

  subscribe(schedulePush);
  window.addEventListener(VPR_FAVORITES_CHANGED_EVENT, schedulePush);
  schedulePush();
}
