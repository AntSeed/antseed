export type ApplicationRoutePolicy =
  | { mode: 'client-model' }
  | { mode: 'follow-global' }
  | { mode: 'model'; provider: string; service: string };

export type ApplicationRoutePolicies = Record<string, ApplicationRoutePolicy>;

const MAX_APPLICATION_ROUTES = 64;
const MAX_NAME_LENGTH = 128;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must not be empty`);
  if (trimmed.length > MAX_NAME_LENGTH) throw new Error(`${field} is too long`);
  return trimmed;
}

export function defaultApplicationRoutePolicy(profileName: string): ApplicationRoutePolicy {
  return ['codex', 'opencode'].includes(profileName.trim().toLowerCase())
    ? { mode: 'client-model' }
    : { mode: 'follow-global' };
}

export function applicationRoutePolicyFor(
  routes: ApplicationRoutePolicies,
  profileName: string,
): ApplicationRoutePolicy {
  return routes[profileName] ?? defaultApplicationRoutePolicy(profileName);
}

export function parseApplicationRoutePolicies(value: unknown): ApplicationRoutePolicies {
  if (!isObject(value)) throw new Error('routes must be an object');
  const entries = Object.entries(value);
  if (entries.length > MAX_APPLICATION_ROUTES) throw new Error('routes has too many entries');

  const routes: ApplicationRoutePolicies = {};
  for (const [rawProfileName, rawPolicy] of entries) {
    const profileName = readRequiredString(rawProfileName, 'profile name');
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(profileName)) {
      throw new Error(`Invalid profile name: ${profileName}`);
    }
    if (!isObject(rawPolicy)) throw new Error(`routes.${profileName} must be an object`);
    const mode = rawPolicy.mode;
    if (mode === 'client-model' || mode === 'follow-global') {
      routes[profileName] = { mode };
      continue;
    }
    if (mode === 'model') {
      routes[profileName] = {
        mode,
        provider: readRequiredString(rawPolicy.provider, `routes.${profileName}.provider`).toLowerCase(),
        service: readRequiredString(rawPolicy.service, `routes.${profileName}.service`),
      };
      continue;
    }
    throw new Error(`routes.${profileName}.mode is invalid`);
  }
  return routes;
}
