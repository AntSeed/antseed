import { homedir } from 'node:os';
import path from 'node:path';

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
 * catalog; user-added custom apps (custom.ts) merge in separately.
 */

/**
 * Per-platform config path for tools that follow Windows conventions instead
 * of `~/.config`. `~/`-style paths expand against homedir() everywhere, which
 * is right for home-rooted tools (codex `~/.codex`, pi `~/.pi`, opencode
 * `~/.config/opencode` — verified home-based even on Windows) but wrong for
 * tools whose Windows builds read from the known folders. Resolved here, at
 * definition time, so the patcher keeps a single path string per profile.
 */
export function platformConfigPath(
  posixPath: string,
  windowsFolder: { base: 'APPDATA' | 'LOCALAPPDATA'; segments: readonly string[] } | null,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== 'win32' || !windowsFolder) return posixPath;
  const fallback = windowsFolder.base === 'APPDATA' ? ['AppData', 'Roaming'] : ['AppData', 'Local'];
  const root = env[windowsFolder.base] || path.join(homedir(), ...fallback);
  return path.join(root, ...windowsFolder.segments);
}

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
    name: 't3code',
    displayName: 'T3 Code',
    kind: 'config-patch',
    method: 'Config patch',
    toolSlugs: ['claude-code', 'claude-cli'],
    domains: [],
    pathPrefixes: [],
    configPatch: {
      format: 't3code',
      configPath: '~/.t3/userdata/settings.json',
      providerKey: 'antseed',
      providerName: 'AntSeed',
      baseURL: 'http://localhost:{buyerPort}',
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
      // Pi's OpenAI Responses transport includes prompt_cache_key with the
      // Pi session id. The buyer proxy uses that as the conversation key so
      // Pi chats show up in AntStation/VPR Recent Chats.
      api: 'openai-responses',
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
      // Windows: crush (charm) resolves its global config under LOCALAPPDATA.
      configPath: platformConfigPath('~/.config/crush/crush.json', {
        base: 'LOCALAPPDATA',
        segments: ['crush', 'crush.json'],
      }),
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
      // Windows: goose reads %APPDATA%\Block\goose\config\config.yaml.
      configPath: platformConfigPath('~/.config/goose/config.yaml', {
        base: 'APPDATA',
        segments: ['Block', 'goose', 'config', 'config.yaml'],
      }),
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
      // Windows: Zed reads %APPDATA%\Zed\settings.json.
      configPath: platformConfigPath('~/.config/zed/settings.json', {
        base: 'APPDATA',
        segments: ['Zed', 'settings.json'],
      }),
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
