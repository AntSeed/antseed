import type { RendererUiState } from '../../core/state';
import type { DesktopBridge, RuntimeProcessState } from '../../types/bridge';
import { chooseBestVprRoute } from './select';
import { routesForSelectedModel } from '../catalog/view-models';
import { activeProfilesFromRuntimeState, buildVprPeerOptions } from './tools';
import { toApplicationRoutePolicies } from './application-routes';

declare const __ANTSEED_SYSTEM_PROXY_PORT__: number;

const SYSTEM_PROXY_PORT = __ANTSEED_SYSTEM_PROXY_PORT__;

type VprRouteTarget = {
  peerId: string;
  model: string;
  servedModels: string[];
};

/** Resolve the current VPR selection to a concrete peer + model target. */
function resolveRouteTarget(uiState: RendererUiState): VprRouteTarget | null {
  const selection = uiState.vprRouteSelection;
  if (!selection.model) return null;
  const routes = routesForSelectedModel(uiState.vprRoutableRows, selection.model);
  const route = selection.mode === 'pinned-peer' && selection.peerId
    ? routes.find((candidate) => candidate.peerId === selection.peerId) ?? null
    : chooseBestVprRoute(routes, uiState.vprRoutingPreferences);
  const peerId = (selection.mode === 'pinned-peer' && selection.peerId) || route?.peerId || null;
  if (!peerId) return null;

  // Routes aggregate serviceId variants of the model — send the id the
  // chosen peer actually advertises, not the selection's representative.
  const model = route?.serviceId ?? selection.model.serviceId;
  const peerOptions = buildVprPeerOptions(uiState.lastPeers, uiState.vprRoutableRows);
  const services = peerOptions.find((peer) => peer.peerId === peerId)?.services ?? [];
  // The resolved model must always be in the served list — main's route
  // computation drops the default model when the list doesn't contain it.
  const servedModels = services.includes(model) ? services : [...services, model];
  return { peerId, model, servedModels };
}

async function activeProfileNames(bridge: DesktopBridge): Promise<string[]> {
  try {
    const state = (await bridge.systemProxyGetState?.()) ?? null;
    return [...(activeProfilesFromRuntimeState(state) ?? [])];
  } catch {
    return [];
  }
}

async function startProfilesOnRoute(
  bridge: DesktopBridge,
  target: VprRouteTarget,
  profileNames: string[],
  profileSwitch: boolean,
  uiState: RendererUiState,
): Promise<{ ok: boolean; state?: RuntimeProcessState | null; error?: string }> {
  if (!bridge.systemProxyStart) return { ok: false, error: 'System proxy is unavailable in this build' };
  try {
    const result = await bridge.systemProxyStart({
      peerId: target.peerId,
      port: SYSTEM_PROXY_PORT,
      profiles: profileNames,
      defaultModel: target.model,
      servedModels: target.servedModels,
      applicationRoutes: toApplicationRoutePolicies(uiState.vprApplicationRoutes),
      profileSwitch,
    });
    return { ok: result.ok, state: result.state ?? null, ...(result.error ? { error: result.error } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function syncBuyerApplicationRoutes(
  bridge: DesktopBridge | undefined,
  uiState: RendererUiState,
): Promise<{ ok: boolean; error?: string }> {
  if (!bridge?.systemProxySetApplicationRoutes) return { ok: true };
  try {
    return await bridge.systemProxySetApplicationRoutes(
      toApplicationRoutePolicies(uiState.vprApplicationRoutes),
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Push the current VPR selection to the buyer proxy's default route
 * (`POST /_antseed/route`), keeping the proxy the single routing authority:
 * the `antseed` model alias and headless frontends (the Telegram bridge)
 * resolve their peer from this route instead of re-deriving it. Best-effort —
 * main dedupes repeat values and the buyer proxy may not be running yet, so
 * this is safe to call from polling refreshes.
 */
export async function syncBuyerDefaultRoute(
  bridge: DesktopBridge | undefined,
  uiState: RendererUiState,
): Promise<void> {
  if (!bridge?.chatSetBuyerDefaultRoute) return;
  const target = resolveRouteTarget(uiState);
  if (!target) return;
  await bridge.chatSetBuyerDefaultRoute({ peerId: target.peerId, service: target.model }).catch(() => undefined);
}

/**
 * Push route changes to the buyer without touching app configs or restarting
 * connected applications. Follow-global policies resolve the new default at
 * request time; explicit application models and Codex Auto stay unchanged.
 */
export async function applyVprRouteToConnectedProxy(
  bridge: DesktopBridge | undefined,
  uiState: RendererUiState,
): Promise<void> {
  if (!bridge) return;
  await Promise.all([
    syncBuyerDefaultRoute(bridge, uiState),
    syncBuyerApplicationRoutes(bridge, uiState),
  ]);
}

/**
 * Connect a single app profile on the current VPR route (joining any
 * profiles already connected). Used by the Home screen's one-click app
 * buttons.
 */
export async function connectVprProfile(
  bridge: DesktopBridge | undefined,
  uiState: RendererUiState,
  profileName: string,
): Promise<{ ok: boolean; state?: RuntimeProcessState | null; error?: string }> {
  if (!bridge) return { ok: false, error: 'Desktop bridge unavailable' };
  const target = resolveRouteTarget(uiState);
  if (!target) return { ok: false, error: 'No model route available yet' };
  const existing = await activeProfileNames(bridge);
  const profileNames = Array.from(new Set([...existing, profileName]));
  return startProfilesOnRoute(bridge, target, profileNames, existing.length > 0, uiState);
}
