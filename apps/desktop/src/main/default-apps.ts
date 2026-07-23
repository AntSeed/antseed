/**
 * Built-in "Connected apps" catalog for the VPR Connected apps screen.
 *
 * These are open-source tools with natively configurable API endpoints, so
 * they can ship publicly with the app and show by default — no MITM proxy or
 * private profile list required. Entries use the same raw profile JSON shape
 * as the packaged/env profile list (see apps/cli/src/system-proxy/profiles.ts).
 *
 * Merge rules: an entry in the packaged/env profile list with the same `name`
 * replaces the default here, so releases can still tweak or extend the
 * catalog; user-added custom apps (custom-apps.ts) merge in separately.
 */
export const DEFAULT_APP_PROFILES: readonly Record<string, unknown>[] = [
  {
    name: 'opencode',
    displayName: 'OpenCode',
    kind: 'config-patch',
    method: 'Config patch',
    // Client names this tool stamps on its requests (User-Agent product /
    // session-header slug) — how conversations are attributed to the app.
    toolSlugs: ['opencode'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 'opencode',
      configPath: '~/.config/opencode/opencode.jsonc',
      providerKey: 'antseed',
      npm: '@ai-sdk/openai-compatible',
      providerName: 'AntSeed',
      baseURL: 'http://localhost:{buyerPort}/v1',
      modelFormat: 'peer-routed',
    },
  },
  {
    name: 'codex',
    displayName: 'Codex',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['codex'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 'codex',
      configPath: '~/.codex/config.toml',
      providerKey: 'antseed',
      providerName: 'AntSeed',
      baseURL: 'http://localhost:{buyerPort}/v1',
    },
  },
  {
    name: 'pi',
    displayName: 'pi',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['pi'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 'pi',
      configPath: '~/.pi/agent/models.json',
      settingsPath: '~/.pi/agent/settings.json',
      providerKey: 'antseed',
      baseURL: 'http://localhost:{buyerPort}/v1',
      api: 'openai-completions',
    },
  },
  {
    name: 'crush',
    displayName: 'Crush',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['crush'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 'crush',
      configPath: '~/.config/crush/crush.json',
      providerKey: 'antseed',
      providerName: 'AntSeed',
      baseURL: 'http://localhost:{buyerPort}/v1',
    },
  },
  {
    name: 'goose',
    displayName: 'Goose',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['goose'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 'goose',
      configPath: '~/.config/goose/config.yaml',
      // goose provider engine; the host root is patched to the buyer proxy.
      providerKey: 'openai',
      baseURL: 'http://localhost:{buyerPort}',
    },
  },
  {
    name: 'zed',
    displayName: 'Zed',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['zed'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 'zed',
      configPath: '~/.config/zed/settings.json',
      providerKey: 'antseed',
      providerName: 'AntSeed',
      baseURL: 'http://localhost:{buyerPort}/v1',
    },
  },
];

/**
 * Combine the packaged/env profile list with the built-in defaults: external
 * entries keep their order and override same-name defaults; the remaining
 * defaults follow.
 */
export function mergeWithDefaultAppProfiles(external: readonly unknown[]): unknown[] {
  const externalNames = new Set(
    external
      .map((profile) => (profile && typeof profile === 'object' && !Array.isArray(profile))
        ? (profile as Record<string, unknown>)['name']
        : undefined)
      .filter((name): name is string => typeof name === 'string'),
  );
  return [
    ...external,
    ...DEFAULT_APP_PROFILES.filter((profile) => !externalNames.has(profile['name'] as string)),
  ];
}
