import type {
  VprApplicationRoutes,
  VprApplicationRouteSelection,
} from '../../core/state';
import type {
  ApplicationRoutePolicies,
  ApplicationRoutePolicy,
} from '../../../shared/application-routes';

export function defaultVprApplicationRouteSelection(profileName: string): VprApplicationRouteSelection {
  return ['codex', 'opencode'].includes(profileName.trim().toLowerCase())
    ? { mode: 'client-model' }
    : { mode: 'follow-global' };
}

export function vprApplicationRouteSelectionFor(
  routes: VprApplicationRoutes,
  profileName: string,
): VprApplicationRouteSelection {
  return routes[profileName] ?? defaultVprApplicationRouteSelection(profileName);
}

export function setVprApplicationRouteSelection(
  routes: VprApplicationRoutes,
  profileName: string,
  selection: VprApplicationRouteSelection,
): VprApplicationRoutes {
  return { ...routes, [profileName]: selection };
}

export function toApplicationRoutePolicy(selection: VprApplicationRouteSelection): ApplicationRoutePolicy {
  if (selection.mode !== 'model') return { mode: selection.mode };
  return {
    mode: 'model',
    provider: selection.model.provider,
    service: selection.model.serviceId,
  };
}

export function toApplicationRoutePolicies(routes: VprApplicationRoutes): ApplicationRoutePolicies {
  return Object.fromEntries(
    Object.entries(routes).map(([profileName, selection]) => [
      profileName,
      toApplicationRoutePolicy(selection),
    ]),
  );
}
