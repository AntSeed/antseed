import {
  applicationRoutePolicyFor,
  defaultApplicationRoutePolicy,
  parseApplicationRoutePolicies,
  type ApplicationRoutePolicies,
  type ApplicationRoutePolicy,
} from '../../shared/application-routes.js';

type LegacyToolRoute = { peerId: string; model: string };

export type BuyerApplicationRoutePolicy = ApplicationRoutePolicy & { toolSlugs: string[] };
export type BuyerApplicationRoutePolicies = Record<string, BuyerApplicationRoutePolicy>;

function readLegacyToolRoutes(value: unknown): Record<string, LegacyToolRoute> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const routes: Record<string, LegacyToolRoute> = {};
  for (const [profileName, rawRoute] of Object.entries(value as Record<string, unknown>)) {
    if (!rawRoute || typeof rawRoute !== 'object' || Array.isArray(rawRoute)) continue;
    const route = rawRoute as Record<string, unknown>;
    const peerId = typeof route['peerId'] === 'string' ? route['peerId'].trim() : '';
    const model = typeof route['model'] === 'string' ? route['model'].trim() : '';
    if (peerId && model) routes[profileName] = { peerId, model };
  }
  return routes;
}

export function migrateApplicationRoutePolicies(
  metadata: Record<string, unknown>,
  providersForPeer: (peerId: string) => readonly string[] = () => [],
): ApplicationRoutePolicies {
  if (Object.prototype.hasOwnProperty.call(metadata, 'applicationRoutes')) {
    try {
      return parseApplicationRoutePolicies(metadata['applicationRoutes']);
    } catch {
      return {};
    }
  }

  const globalPeerId = typeof metadata['peerId'] === 'string' ? metadata['peerId'].trim().toLowerCase() : '';
  const globalModel = typeof metadata['defaultModel'] === 'string' ? metadata['defaultModel'].trim() : '';
  const migrated: ApplicationRoutePolicies = {};
  for (const [profileName, route] of Object.entries(readLegacyToolRoutes(metadata['toolRoutes']))) {
    if (route.peerId.toLowerCase() === globalPeerId && route.model === globalModel) {
      migrated[profileName] = { mode: 'follow-global' };
      continue;
    }
    const provider = providersForPeer(route.peerId)[0]?.trim().toLowerCase() ?? '';
    migrated[profileName] = provider
      ? { mode: 'model', provider, service: route.model }
      : defaultApplicationRoutePolicy(profileName);
  }
  return migrated;
}

export function buildActiveBuyerApplicationRoutes(
  profileNames: string[],
  routes: ApplicationRoutePolicies,
  toolSlugsForProfile: (profileName: string) => string[],
): BuyerApplicationRoutePolicies {
  return Object.fromEntries(profileNames.map((profileName) => [profileName, {
    ...applicationRoutePolicyFor(routes, profileName),
    toolSlugs: toolSlugsForProfile(profileName),
  }]));
}

export function applicationRouteChangeRequiresRestart(
  profileName: string,
  previousRoutes: ApplicationRoutePolicies,
  nextRoutes: ApplicationRoutePolicies,
): boolean {
  if (profileName !== 'codex') return false;
  return (applicationRoutePolicyFor(previousRoutes, profileName).mode === 'client-model')
    !== (applicationRoutePolicyFor(nextRoutes, profileName).mode === 'client-model');
}
