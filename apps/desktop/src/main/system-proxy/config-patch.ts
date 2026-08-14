import { ANTSEED_MODEL_CONTEXT_WINDOW, ANTSEED_MODEL_MAX_OUTPUT_TOKENS } from '@antseed/node/types';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ConnectedAppModelCatalogEntry } from '../../shared/connected-app-model-catalog.js';
import {
  WSL_TOOL_PROBES,
  clearWslTargetsForTool,
  discoverWslToolTargets,
  readWslTargetsForTool,
  saveWslTargetsForTool,
  type WslConfigTarget,
  type WslTool,
} from './wsl.js';

/**
 * Model alias resolved by the buyer proxy at request time to the route
 * currently selected in the desktop (floating pill / VPR). Must match
 * ROUTED_MODEL_ALIAS in apps/cli/src/proxy/request-utils.ts.
 */
export const ROUTED_MODEL_ALIAS = 'antseed';
const ROUTED_MODEL_ALIAS_LABEL = 'AntSeed VPR';

/**
 * Config patches point a tool's own configuration at the buyer proxy. Each
 * supported tool has its own on-disk format:
 *  - `opencode` (default): JSONC `provider` map (OpenCode's opencode.jsonc)
 *  - `codex`: TOML `[model_providers.*]` table (Codex CLI's config.toml)
 *  - `pi`: JSON providers map plus a settings file (pi's models.json/settings.json)
 *  - `crush`: JSON `providers` map with an openai-compat entry (Crush's crush.json)
 *  - `goose`: flat env-style YAML keys (goose's config.yaml)
 *  - `zed`: JSONC settings with `language_models.openai_compatible` (Zed's settings.json)
 */
export type OpencodeConfigPatchDef = {
  readonly format?: 'opencode';
  readonly configPath: string;
  readonly providerKey: string;
  readonly npm: string;
  readonly providerName: string;
  readonly baseURL: string;
  /** When set, the patcher targets actual installations of the named tool —
      native only if install signals exist, plus every WSL distro carrying it
      (Windows) — and throws when the tool is found nowhere, instead of
      blindly creating a config for a program that isn't there. Unset keeps
      the write-the-one-path behavior for generic/external profiles.
      See applyWithInstallProbe. */
  readonly installProbe?: 'opencode';
};

export type CodexConfigPatchDef = {
  readonly format: 'codex';
  readonly configPath: string;
  readonly providerKey: string;
  readonly providerName: string;
  readonly baseURL: string;
  readonly installProbe?: 'codex';
};

export type PiConfigPatchDef = {
  readonly format: 'pi';
  /** pi models.json (custom providers). */
  readonly configPath: string;
  /** pi settings.json (default provider/model selection). */
  readonly settingsPath: string;
  readonly providerKey: string;
  readonly baseURL: string;
  readonly api: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  readonly installProbe?: 'pi';
};

export type CrushConfigPatchDef = {
  readonly format: 'crush';
  readonly configPath: string;
  /** POSIX config path for WSL installs — `configPath` is resolved to a
      Windows known folder at definition time, which is meaningless inside a
      distro. */
  readonly wslConfigPath?: string;
  readonly providerKey: string;
  readonly providerName: string;
  readonly baseURL: string;
  readonly installProbe?: 'crush';
};

export type GooseConfigPatchDef = {
  readonly format: 'goose';
  /** goose config.yaml (flat env-style keys). */
  readonly configPath: string;
  /** POSIX config path for WSL installs — see CrushConfigPatchDef. */
  readonly wslConfigPath?: string;
  /** goose provider engine ('openai' for openai-compatible hosts). */
  readonly providerKey: string;
  /** Host root without /v1 — goose appends the chat-completions path itself. */
  readonly baseURL: string;
  readonly installProbe?: 'goose';
};

export type ZedConfigPatchDef = {
  readonly format: 'zed';
  readonly configPath: string;
  readonly providerKey: string;
  /** Key under language_models.openai_compatible; also the agent provider id. */
  readonly providerName: string;
  readonly baseURL: string;
};

export type T3CodeConfigPatchDef = {
  readonly format: 't3code';
  readonly configPath: string;
  readonly providerKey: string;
  readonly providerName: string;
  readonly baseURL: string;
};

export type ConfigPatchDef =
  | OpencodeConfigPatchDef
  | CodexConfigPatchDef
  | PiConfigPatchDef
  | CrushConfigPatchDef
  | GooseConfigPatchDef
  | ZedConfigPatchDef
  | T3CodeConfigPatchDef;

export function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function readRequiredString(raw: Record<string, unknown>, key: string, context: string | number): string {
  const value = readString(raw, key);
  if (!value) throw new Error(`System Proxy profile ${context} requires ${key}`);
  return value;
}

/** Parses a profile's configPatch blob into a ConfigPatchDef. Every format in
 *  the union needs its own branch here — an unmatched format falls through to
 *  opencode, whose `npm` requirement then throws at profile load (i.e. app
 *  startup). Lives in this electron-free module so tests can feed every
 *  default profile through it. */
export function readConfigPatch(value: unknown, profileName: string): ConfigPatchDef | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`configPatch for ${profileName} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const configPath = readRequiredString(raw, 'configPath', profileName);
  const providerKey = readRequiredString(raw, 'providerKey', profileName);
  const baseURL = readRequiredString(raw, 'baseURL', profileName);
  const format = readString(raw, 'format');
  if (format === 'codex') {
    return {
      format: 'codex',
      configPath,
      providerKey,
      providerName: readRequiredString(raw, 'providerName', profileName),
      baseURL,
      ...(raw['installProbe'] === 'codex' ? { installProbe: 'codex' as const } : {}),
    };
  }
  if (format === 'pi') {
    const api = raw['api'];
    return {
      format: 'pi',
      configPath,
      settingsPath: readRequiredString(raw, 'settingsPath', profileName),
      providerKey,
      baseURL,
      api: api === 'openai-responses' || api === 'anthropic-messages' ? api : 'openai-completions',
      ...(raw['installProbe'] === 'pi' ? { installProbe: 'pi' as const } : {}),
    };
  }
  if (format === 'crush') {
    const wslConfigPath = readString(raw, 'wslConfigPath');
    return {
      format: 'crush',
      configPath,
      ...(wslConfigPath ? { wslConfigPath } : {}),
      providerKey,
      providerName: readRequiredString(raw, 'providerName', profileName),
      baseURL,
      ...(raw['installProbe'] === 'crush' ? { installProbe: 'crush' as const } : {}),
    };
  }
  if (format === 'goose') {
    const wslConfigPath = readString(raw, 'wslConfigPath');
    return {
      format: 'goose',
      configPath,
      ...(wslConfigPath ? { wslConfigPath } : {}),
      providerKey,
      baseURL,
      ...(raw['installProbe'] === 'goose' ? { installProbe: 'goose' as const } : {}),
    };
  }
  if (format === 'zed') {
    return {
      format: 'zed',
      configPath,
      providerKey,
      providerName: readRequiredString(raw, 'providerName', profileName),
      baseURL,
    };
  }
  if (format === 't3code') {
    return {
      format: 't3code',
      configPath,
      providerKey,
      providerName: readRequiredString(raw, 'providerName', profileName),
      baseURL,
    };
  }
  return {
    format: 'opencode',
    configPath,
    providerKey,
    npm: readRequiredString(raw, 'npm', profileName),
    providerName: readRequiredString(raw, 'providerName', profileName),
    baseURL,
    ...(raw['installProbe'] === 'opencode' ? { installProbe: 'opencode' as const } : {}),
  };
}

type JsonObject = Record<string, unknown>;

function expandTilde(p: string): string {
  return p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p;
}

function isBuyerProxyRoutablePeerId(peerId: string): boolean {
  const normalized = peerId.trim().toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{40}$/.test(normalized);
}

export function stripJsoncComments(raw: string): string {
  let result = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      result += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      if (i < raw.length) result += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) {
        result += raw[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i++;
      continue;
    }
    result += ch;
  }
  return result;
}

export function stripJsoncTrailingCommas(raw: string): string {
  let result = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      result += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j]!)) j++;
      if (raw[j] === '}' || raw[j] === ']') {
        continue;
      }
    }
    result += ch;
  }
  return result;
}

export function parseJsoncObject(raw: string, filePath: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsoncTrailingCommas(stripJsoncComments(raw)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to parse JSONC config at ${filePath}: ${message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`JSONC config at ${filePath} must be an object`);
  }
  return parsed as JsonObject;
}

function readJsoncFile(filePath: string): JsonObject | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    return parseJsoncObject(raw, filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function readConfigPatchFile(filePath: string): JsonObject {
  if (!existsSync(filePath)) {
    return {};
  }
  return readJsoncFile(filePath) ?? {};
}

function tryReadConfigPatchFile(filePath: string): JsonObject | null {
  if (!existsSync(filePath)) {
    return null;
  }
  return readJsoncFile(filePath);
}

function writeJsonFile(filePath: string, data: JsonObject): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function backupConfigFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const backupPath = `${filePath}.antseed.bak`;
  if (existsSync(backupPath)) return;
  copyFileSync(filePath, backupPath);
}

function removeFromStringArray(config: JsonObject, key: string, value: string): void {
  const arr = config[key];
  if (!Array.isArray(arr)) return;
  const filtered = arr.filter((item) => item !== value);
  if (filtered.length === 0) delete config[key];
  else config[key] = filtered;
}

/**
 * Point the tool's config at the buyer proxy. The config exposes a single
 * model — the ROUTED_MODEL_ALIAS — which the buyer resolves per request to
 * the route currently selected in the desktop (floating pill / VPR). Concrete
 * `<peerId>@<service>` entries are no longer written: the only place to pick
 * a model is the desktop route selector, so route changes reach running tool
 * sessions without a config rewrite.
 */
export function applyConfigPatch(
  patch: ConfigPatchDef,
  peerId: string,
  buyerPort: number,
  options: {
    useRoutedModelAlias?: boolean;
    openCodeModels?: readonly ConnectedAppModelCatalogEntry[];
    openCodeInAppSelection?: boolean;
    codexModels?: readonly ConnectedAppModelCatalogEntry[];
    wslTargetsFile?: string;
  } = {},
): void {
  if (!isBuyerProxyRoutablePeerId(peerId)) {
    throw new Error('Config-based routing requires a 40-character hex peer ID. Select a chain-backed peer before enabling this tool.');
  }
  if (patch.format === 'codex') {
    applyCodexConfigPatch(
      patch,
      buyerPort,
      options.codexModels ?? [],
      options.useRoutedModelAlias === true,
      options.wslTargetsFile,
    );
    return;
  }
  if (patch.format === 'pi') {
    applyPiConfigPatch(patch, buyerPort, options.wslTargetsFile);
    return;
  }
  if (patch.format === 'crush') {
    applyCrushConfigPatch(patch, buyerPort, options.wslTargetsFile);
    return;
  }
  if (patch.format === 'goose') {
    applyGooseConfigPatch(patch, buyerPort, options.wslTargetsFile);
    return;
  }
  if (patch.format === 'zed') {
    applyZedConfigPatch(patch, buyerPort);
    return;
  }
  if (patch.format === 't3code') {
    applyT3CodeConfigPatch(patch, buyerPort);
    return;
  }
  applyOpenCodeConfigPatch(
    patch,
    buyerPort,
    options.openCodeModels ?? [],
    options.openCodeInAppSelection === true,
    true,
    options.wslTargetsFile,
  );
}

/** Replace the host of a base URL, leaving scheme, port, and path untouched.
    Regex rather than URL because the string may still carry the `{buyerPort}`
    placeholder, which URL refuses to parse. */
export function substituteBaseUrlHost(baseURL: string, host: string): string {
  return baseURL.replace(/^(https?:\/\/)[^/:]+/, `$1${host}`);
}

/** Signals that a tool actually exists natively: its config dir, its
    home-relative install/state locations (shared with the WSL probe), or the
    binary on PATH. Any one suffices — a GUI process sees a reduced PATH, and
    some tools only create the config dir once configured. */
function nativeToolInstalled(tool: WslTool, configFilePath: string): boolean {
  if (existsSync(path.dirname(configFilePath))) return true;
  const probe = WSL_TOOL_PROBES[tool];
  if (probe.signals.some((signal) => existsSync(path.join(homedir(), ...signal.split('/'))))) return true;
  try {
    if (process.platform === 'win32') {
      execFileSync('where.exe', [probe.binary], { stdio: 'ignore', windowsHide: true });
    } else {
      execFileSync('/bin/sh', ['-c', `command -v ${probe.binary}`], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

type PatchFilePaths = { configPath: string; settingsPath?: string };

/**
 * Shared install-probe patching: write the config to the native install only
 * when install signals exist, write it into every WSL distro carrying the
 * tool (with a base URL host that distro can reach), remember the WSL
 * targets for removal, and throw when the tool is found nowhere.
 */
function applyWithInstallProbe(opts: {
  tool: WslTool;
  native: PatchFilePaths;
  /** `~/`-rooted config locations, for mapping into WSL distros. */
  posix: PatchFilePaths;
  baseURL: string;
  wslTargetsFile?: string;
  write: (paths: PatchFilePaths, baseURL: string) => void;
}): void {
  const nativeInstalled = nativeToolInstalled(opts.tool, opts.native.configPath);
  const wslTargets = discoverWslToolTargets(opts.tool, opts.posix);
  if (!nativeInstalled && wslTargets.length === 0) {
    throw new Error(
      `${opts.tool} was not found on this machine`
      + (process.platform === 'win32' ? ' or in any WSL distro' : '')
      + ` — nothing to connect. Looked for ${path.dirname(opts.native.configPath)}, `
      + `its home install locations, and a ${WSL_TOOL_PROBES[opts.tool].binary} binary on PATH. `
      + `Install ${opts.tool} (or run it once), then reconnect.`,
    );
  }
  if (nativeInstalled) opts.write(opts.native, opts.baseURL);
  for (const target of wslTargets) {
    // Inside WSL, `localhost` is the distro's own VM under NAT networking —
    // the config must carry the host the distro can actually reach the
    // Windows-side buyer proxy on.
    opts.write(
      { configPath: target.configPath, ...(target.settingsPath ? { settingsPath: target.settingsPath } : {}) },
      substituteBaseUrlHost(opts.baseURL, target.host),
    );
  }
  if (opts.wslTargetsFile) saveWslTargetsForTool(opts.wslTargetsFile, opts.tool, wslTargets);
}

/** Unpatch the WSL targets remembered for `tool` and forget them. */
function removeWslInstalls(
  tool: WslTool,
  wslTargetsFile: string | undefined,
  removeFrom: (target: WslConfigTarget) => boolean,
): boolean {
  if (!wslTargetsFile) return false;
  let changed = false;
  for (const target of readWslTargetsForTool(wslTargetsFile, tool)) {
    try {
      if (removeFrom(target)) changed = true;
    } catch {
      // Distro stopped or the UNC share is unavailable. The stale provider
      // entry is inert (it points at a dead host/port) and the next connect
      // rewrites it.
    }
  }
  clearWslTargetsForTool(wslTargetsFile, tool);
  return changed;
}

function openCodeModelDefinition(name: string): JsonObject {
  return {
    name,
    attachment: true,
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: ANTSEED_MODEL_CONTEXT_WINDOW, output: ANTSEED_MODEL_MAX_OUTPUT_TOKENS },
  };
}

function applyOpenCodeConfigPatch(
  patch: OpencodeConfigPatchDef,
  buyerPort: number,
  models: readonly ConnectedAppModelCatalogEntry[],
  inAppSelection: boolean,
  selectDefault: boolean,
  wslTargetsFile?: string,
): boolean {
  const filePath = expandTilde(patch.configPath);
  const baseURL = patch.baseURL.replace('{buyerPort}', String(buyerPort));
  if (patch.installProbe !== 'opencode') {
    return applyOpencodeProviderToFile(filePath, patch, baseURL, models, inAppSelection, selectDefault);
  }
  let changed = false;
  applyWithInstallProbe({
    tool: 'opencode',
    native: { configPath: filePath },
    posix: { configPath: patch.configPath },
    baseURL,
    wslTargetsFile,
    write: (paths, url) => {
      changed = applyOpencodeProviderToFile(paths.configPath, patch, url, models, inAppSelection, selectDefault) || changed;
    },
  });
  return changed;
}

function applyOpencodeProviderToFile(
  filePath: string,
  patch: OpencodeConfigPatchDef,
  baseURL: string,
  models: readonly ConnectedAppModelCatalogEntry[],
  inAppSelection: boolean,
  selectDefault: boolean,
): boolean {
  backupConfigFile(filePath);
  const config = readConfigPatchFile(filePath);
  const providers = (config['provider'] && typeof config['provider'] === 'object' && !Array.isArray(config['provider']))
    ? config['provider'] as JsonObject
    : {};
  const modelDefinitions: JsonObject = inAppSelection
    ? Object.fromEntries(models.map((model) => [model.id, openCodeModelDefinition(model.name)]))
    : { [ROUTED_MODEL_ALIAS]: openCodeModelDefinition(ROUTED_MODEL_ALIAS_LABEL) };
  const provider = {
    name: patch.providerName,
    npm: patch.npm,
    options: {
      baseURL,
      apiKey: 'antseed',
    },
    models: modelDefinitions,
  };
  const before = JSON.stringify({ provider: providers[patch.providerKey], model: config['model'] });
  providers[patch.providerKey] = provider;
  config['provider'] = providers;
  const selectedModel = typeof config['model'] === 'string' ? config['model'] : '';
  const selectedId = selectedModel.startsWith(`${patch.providerKey}/`)
    ? selectedModel.slice(patch.providerKey.length + 1)
    : '';
  if (inAppSelection) {
    if (models.length === 0) {
      delete config['model'];
    } else if (selectDefault || !Object.prototype.hasOwnProperty.call(modelDefinitions, selectedId)) {
      config['model'] = `${patch.providerKey}/${models[0]!.id}`;
    }
  } else if (selectDefault || selectedId !== ROUTED_MODEL_ALIAS) {
    config['model'] = `${patch.providerKey}/${ROUTED_MODEL_ALIAS}`;
  }
  removeFromStringArray(config, 'disabled_providers', patch.providerKey);
  const changed = before !== JSON.stringify({ provider, model: config['model'] });
  if (changed) writeJsonFile(filePath, config);
  return changed;
}

export function refreshOpenCodeModelCatalog(
  patch: OpencodeConfigPatchDef,
  buyerPort: number,
  models: readonly ConnectedAppModelCatalogEntry[],
  inAppSelection: boolean,
): boolean {
  return applyOpenCodeConfigPatch(patch, buyerPort, models, inAppSelection, false);
}

export function refreshCodexModelCatalog(
  patch: CodexConfigPatchDef,
  buyerPort: number,
  models: readonly ConnectedAppModelCatalogEntry[],
  inAppSelection: boolean,
): boolean {
  const filePath = expandTilde(patch.configPath);
  const beforeConfig = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const catalogPath = path.join(path.dirname(filePath), CODEX_CATALOG_FILE_NAME);
  const beforeCatalog = existsSync(catalogPath) ? readFileSync(catalogPath, 'utf8') : '';
  applyCodexConfigPatch(patch, buyerPort, models, !inAppSelection);
  return beforeConfig !== readFileSync(filePath, 'utf8')
    || beforeCatalog !== readFileSync(catalogPath, 'utf8');
}

export function removeConfigPatch(patch: ConfigPatchDef, wslTargetsFile?: string): boolean {
  if (patch.format === 'codex') {
    return removeCodexConfigPatch(patch, wslTargetsFile);
  }
  if (patch.format === 'pi') {
    return removePiConfigPatch(patch, wslTargetsFile);
  }
  if (patch.format === 'crush') {
    return removeCrushConfigPatch(patch, wslTargetsFile);
  }
  if (patch.format === 'goose') {
    return removeGooseConfigPatch(patch, wslTargetsFile);
  }
  if (patch.format === 'zed') {
    return removeZedConfigPatch(patch);
  }
  if (patch.format === 't3code') {
    return removeT3CodeConfigPatch(patch);
  }
  let changed = removeOpencodeProviderFromFile(expandTilde(patch.configPath), patch);
  if (patch.installProbe === 'opencode') {
    changed = removeWslInstalls('opencode', wslTargetsFile, (target) => removeOpencodeProviderFromFile(target.configPath, patch)) || changed;
  }
  return changed;
}

function removeOpencodeProviderFromFile(filePath: string, patch: OpencodeConfigPatchDef): boolean {
  const config = tryReadConfigPatchFile(filePath);
  if (!config) return false;
  backupConfigFile(filePath);

  let changed = false;
  const providers = config['provider'];
  if (providers && typeof providers === 'object' && !Array.isArray(providers) && (patch.providerKey in (providers as JsonObject))) {
    delete (providers as JsonObject)[patch.providerKey];
    changed = true;
  }
  if (typeof config['model'] === 'string' && config['model'].startsWith(`${patch.providerKey}/`)) {
    delete config['model'];
    changed = true;
  }
  if (!changed) return false;
  writeJsonFile(filePath, config);
  return true;
}

function writeTextFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, content, 'utf8');
}

// --- Codex CLI (`~/.codex/config.toml`) ---

type CodexPatchState = {
  model: string | null;
  modelProvider: string | null;
  openaiBaseUrl: string | null;
  modelCatalogJson: string | null;
  webSearch: string | null;
  requestCompression: boolean | null;
  featuresTableExisted: boolean;
  managedBaseURL: string;
  managedCatalogPath: string;
  lastClientModel: string | null;
  managedModel: string | null;
};

const CODEX_CATALOG_FILE_NAME = 'antseed-models.json';
const CODEX_ROUTED_MODEL_PREFIX = 'antseed/';

export function codexRoutedModelSlug(model: ConnectedAppModelCatalogEntry): string {
  const service = model.peerId ? `${model.peerId}@${model.id}` : model.id;
  return `${CODEX_ROUTED_MODEL_PREFIX}${model.provider}/${service}`;
}

function codexCatalogTemplate(filePath: string): JsonObject {
  const fallback = {
    slug: 'gpt-5',
    display_name: 'GPT-5',
    description: '',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    ],
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    input_modalities: ['text', 'image'],
    supports_parallel_tool_calls: true,
    apply_patch_tool_type: 'freeform',
    multi_agent_version: 'v1',
  };
  try {
    const parsed = JSON.parse(readFileSync(path.join(path.dirname(filePath), 'models_cache.json'), 'utf8')) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return fallback;
    const models = parsed.models.filter((model): model is JsonObject => Boolean(model) && typeof model === 'object' && !Array.isArray(model));
    return models.find((model) => model['visibility'] === 'list') ?? models[0] ?? fallback;
  } catch {
    return fallback;
  }
}

function codexCatalogModel(template: JsonObject, slug: string, name: string, priority: number): JsonObject {
  const {
    web_search_tool_type: _webSearchToolType,
    tool_mode: _toolMode,
    ...compatibleTemplate
  } = template;
  return {
    ...compatibleTemplate,
    slug,
    display_name: name,
    description: `${name} routed through AntSeed VPR.`,
    visibility: 'list',
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    context_window: ANTSEED_MODEL_CONTEXT_WINDOW,
    max_context_window: ANTSEED_MODEL_CONTEXT_WINDOW,
    effective_context_window_percent: 95,
    supports_search_tool: false,
    apply_patch_tool_type: 'freeform',
    use_responses_lite: false,
  };
}

function codexCatalogModels(
  filePath: string,
  models: readonly ConnectedAppModelCatalogEntry[],
  useRoutedModelAlias: boolean,
): JsonObject[] {
  const template = codexCatalogTemplate(filePath);
  if (useRoutedModelAlias) {
    return [codexCatalogModel(template, ROUTED_MODEL_ALIAS, ROUTED_MODEL_ALIAS_LABEL, 1)];
  }
  return models.map((model, index) => codexCatalogModel(
    template,
    codexRoutedModelSlug(model),
    model.name,
    index + 1,
  ));
}

function writeJsonFileAtomic(filePath: string, data: JsonObject): boolean {
  const content = `${JSON.stringify(data, null, 2)}\n`;
  if (existsSync(filePath) && readFileSync(filePath, 'utf8') === content) return false;
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temporaryPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryPath, filePath);
  return true;
}

function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function firstTomlTableIndex(lines: readonly string[]): number {
  const index = lines.findIndex((line) => /^\s*\[/.test(line));
  return index === -1 ? lines.length : index;
}

function isCodexProviderTableHeader(line: string, providerKey: string): boolean {
  const match = line.match(/^\s*\[\s*model_providers\s*\.\s*("?)([^\]"]+)\1\s*\]\s*(#.*)?$/);
  return match?.[2]?.trim() === providerKey;
}

function removeCodexProviderTable(lines: readonly string[], providerKey: string): { lines: string[]; changed: boolean } {
  const start = lines.findIndex((line) => isCodexProviderTableHeader(line, providerKey));
  if (start === -1) return { lines: [...lines], changed: false };
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  return { lines: [...lines.slice(0, start), ...lines.slice(end)], changed: true };
}

function appendCodexProviderTable(lines: readonly string[], patch: CodexConfigPatchDef, baseURL: string): string[] {
  const next = [...lines];
  while (next.length > 0 && next[next.length - 1]!.trim() === '') next.pop();
  return [
    ...next,
    '',
    `[model_providers.${patch.providerKey}]`,
    `name = ${tomlBasicString(patch.providerName)}`,
    `base_url = ${tomlBasicString(baseURL)}`,
    'wire_api = "responses"',
    'supports_websockets = false',
  ];
}

function tomlTopLevelKeyIndex(lines: readonly string[], key: string): number {
  const limit = firstTomlTableIndex(lines);
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = 0; i < limit; i++) {
    if (pattern.test(lines[i]!)) return i;
  }
  return -1;
}

function setTomlTopLevelValue(lines: readonly string[], key: string, value: string): string[] {
  const assignment = `${key} = ${value}`;
  const index = tomlTopLevelKeyIndex(lines, key);
  if (index !== -1) {
    const next = [...lines];
    next[index] = assignment;
    return next;
  }
  const limit = firstTomlTableIndex(lines);
  return [...lines.slice(0, limit), assignment, ...lines.slice(limit)];
}

function setTomlTopLevelString(lines: readonly string[], key: string, value: string): string[] {
  return setTomlTopLevelValue(lines, key, tomlBasicString(value));
}

function readTomlTopLevelString(lines: readonly string[], key: string): string | undefined {
  const index = tomlTopLevelKeyIndex(lines, key);
  if (index === -1) return undefined;
  const match = lines[index]!.match(/=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(#.*)?$/);
  if (!match) return undefined;
  return match[1] === undefined ? match[2] : match[1]!.replace(/\\(.)/g, '$1');
}

function removeTomlTopLevelKey(lines: readonly string[], key: string): string[] {
  const index = tomlTopLevelKeyIndex(lines, key);
  if (index === -1) return [...lines];
  return [...lines.slice(0, index), ...lines.slice(index + 1)];
}

function tomlTableKeyIndex(lines: readonly string[], table: string, key: string): number {
  const start = lines.findIndex((line) => new RegExp(`^\\s*\\[\\s*${table}\\s*\\]\\s*(#.*)?$`).test(line));
  if (start === -1) return -1;
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = start + 1; i < lines.length && !/^\s*\[/.test(lines[i]!); i++) {
    if (pattern.test(lines[i]!)) return i;
  }
  return -1;
}

function readTomlTableBoolean(lines: readonly string[], table: string, key: string): boolean | undefined {
  const index = tomlTableKeyIndex(lines, table, key);
  if (index === -1) return undefined;
  const match = lines[index]!.match(/=\s*(true|false)\s*(#.*)?$/);
  return match ? match[1] === 'true' : undefined;
}

function setTomlTableBoolean(lines: readonly string[], table: string, key: string, value: boolean): string[] {
  const assignment = `${key} = ${String(value)}`;
  const index = tomlTableKeyIndex(lines, table, key);
  if (index !== -1) {
    const next = [...lines];
    next[index] = assignment;
    return next;
  }
  const start = lines.findIndex((line) => new RegExp(`^\\s*\\[\\s*${table}\\s*\\]\\s*(#.*)?$`).test(line));
  if (start !== -1) return [...lines.slice(0, start + 1), assignment, ...lines.slice(start + 1)];
  const next = [...lines];
  while (next.length > 0 && next[next.length - 1]!.trim() === '') next.pop();
  return [...next, '', `[${table}]`, assignment];
}

function restoreTomlTableBoolean(
  lines: readonly string[],
  table: string,
  key: string,
  baseline: boolean | null,
  tableExisted: boolean,
): string[] {
  if (baseline !== null) return setTomlTableBoolean(lines, table, key, baseline);
  const index = tomlTableKeyIndex(lines, table, key);
  let next = index === -1 ? [...lines] : [...lines.slice(0, index), ...lines.slice(index + 1)];
  if (!tableExisted) {
    const tableIndex = next.findIndex((line) => new RegExp(`^\\s*\\[\\s*${table}\\s*\\]\\s*(#.*)?$`).test(line));
    if (tableIndex !== -1) next = [...next.slice(0, tableIndex), ...next.slice(tableIndex + 1)];
  }
  return next;
}

function codexPatchStatePath(filePath: string): string {
  return `${filePath}.antseed.state.json`;
}

function readCodexPatchState(filePath: string): CodexPatchState | null {
  try {
    const value = JSON.parse(readFileSync(codexPatchStatePath(filePath), 'utf8')) as Partial<CodexPatchState>;
    if ((typeof value.model === 'string' || value.model === null || value.model === undefined)
      && (typeof value.modelProvider === 'string' || value.modelProvider === null)
      && (typeof value.openaiBaseUrl === 'string' || value.openaiBaseUrl === null)
      && (typeof value.modelCatalogJson === 'string' || value.modelCatalogJson === null || value.modelCatalogJson === undefined)
      && (typeof value.webSearch === 'string' || value.webSearch === null || value.webSearch === undefined)
      && (typeof value.requestCompression === 'boolean' || value.requestCompression === null || value.requestCompression === undefined)
      && (typeof value.featuresTableExisted === 'boolean' || value.featuresTableExisted === undefined)
      && typeof value.managedBaseURL === 'string'
      && (typeof value.managedCatalogPath === 'string' || value.managedCatalogPath === undefined)
      && (typeof value.lastClientModel === 'string' || value.lastClientModel === null || value.lastClientModel === undefined)
      && (typeof value.managedModel === 'string' || value.managedModel === null || value.managedModel === undefined)) {
      return {
        ...value,
        model: value.model ?? null,
        modelCatalogJson: value.modelCatalogJson ?? null,
        webSearch: value.webSearch ?? null,
        requestCompression: value.requestCompression ?? null,
        featuresTableExisted: value.featuresTableExisted ?? true,
        managedCatalogPath: value.managedCatalogPath ?? '',
        lastClientModel: value.lastClientModel ?? null,
        managedModel: value.managedModel ?? ROUTED_MODEL_ALIAS,
      } as CodexPatchState;
    }
  } catch {
    return null;
  }
  return null;
}

function applyCodexConfigPatch(
  patch: CodexConfigPatchDef,
  buyerPort: number,
  models: readonly ConnectedAppModelCatalogEntry[],
  useRoutedModelAlias: boolean,
  wslTargetsFile?: string,
): void {
  const filePath = expandTilde(patch.configPath);
  const baseURL = patch.baseURL.replace('{buyerPort}', String(buyerPort));
  if (patch.installProbe !== 'codex') {
    applyCodexProviderToFile(filePath, patch, baseURL, models, useRoutedModelAlias);
    return;
  }
  applyWithInstallProbe({
    tool: 'codex',
    native: { configPath: filePath },
    posix: { configPath: patch.configPath },
    baseURL,
    wslTargetsFile,
    write: (paths, url) => applyCodexProviderToFile(paths.configPath, patch, url, models, useRoutedModelAlias),
  });
}

function applyCodexProviderToFile(
  filePath: string,
  patch: CodexConfigPatchDef,
  baseURL: string,
  models: readonly ConnectedAppModelCatalogEntry[],
  useRoutedModelAlias: boolean,
): void {
  backupConfigFile(filePath);
  const raw = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  let lines = raw.length > 0 ? raw.split('\n') : [];
  const managedBaseURL = baseURL;
  const managedCatalogPath = path.join(path.dirname(filePath), CODEX_CATALOG_FILE_NAME);
  const previousState = readCodexPatchState(filePath);
  const currentModel = readTomlTopLevelString(lines, 'model') ?? null;
  const currentClientModel = currentModel?.startsWith(CODEX_ROUTED_MODEL_PREFIX) ? currentModel : null;
  const availableClientModels = new Set(models.map(codexRoutedModelSlug));
  const state: CodexPatchState = {
    model: previousState
      ? previousState.model ?? (currentModel === ROUTED_MODEL_ALIAS || currentClientModel ? null : currentModel)
      : currentModel,
    modelProvider: previousState ? previousState.modelProvider : readTomlTopLevelString(lines, 'model_provider') ?? null,
    openaiBaseUrl: previousState ? previousState.openaiBaseUrl : readTomlTopLevelString(lines, 'openai_base_url') ?? null,
    modelCatalogJson: previousState ? previousState.modelCatalogJson : readTomlTopLevelString(lines, 'model_catalog_json') ?? null,
    webSearch: previousState ? previousState.webSearch : readTomlTopLevelString(lines, 'web_search') ?? null,
    requestCompression: previousState
      ? previousState.requestCompression
      : readTomlTableBoolean(lines, 'features', 'enable_request_compression') ?? null,
    featuresTableExisted: previousState
      ? previousState.featuresTableExisted
      : lines.some((line) => /^\s*\[\s*features\s*\]\s*(#.*)?$/.test(line)),
    managedBaseURL,
    managedCatalogPath,
    lastClientModel: currentClientModel ?? previousState?.lastClientModel ?? null,
    managedModel: previousState?.managedModel ?? null,
  };
  writeJsonFileAtomic(managedCatalogPath, {
    models: codexCatalogModels(filePath, models, useRoutedModelAlias),
  });
  lines = removeCodexProviderTable(lines, patch.providerKey).lines;
  // Older AntSeed patches redirected the built-in OpenAI provider. Restore its
  // baseline while migrating to the isolated, HTTP-only AntSeed provider.
  if (previousState && readTomlTopLevelString(lines, 'openai_base_url') === previousState.managedBaseURL) {
    lines = restoreCodexTopLevelString(lines, 'openai_base_url', previousState.openaiBaseUrl);
  }
  lines = setTomlTopLevelString(lines, 'model_provider', patch.providerKey);
  lines = setTomlTopLevelString(lines, 'model_catalog_json', managedCatalogPath);
  lines = setTomlTopLevelString(lines, 'web_search', 'disabled');
  lines = setTomlTableBoolean(lines, 'features', 'enable_request_compression', false);
  if (useRoutedModelAlias) {
    lines = setTomlTopLevelString(lines, 'model', ROUTED_MODEL_ALIAS);
    state.managedModel = ROUTED_MODEL_ALIAS;
  } else if (models.length > 0) {
    const selectedModel = state.lastClientModel && availableClientModels.has(state.lastClientModel)
      ? state.lastClientModel
      : codexRoutedModelSlug(models[0]!);
    lines = setTomlTopLevelString(lines, 'model', selectedModel);
    state.lastClientModel = selectedModel;
    state.managedModel = selectedModel;
  } else {
    lines = restoreCodexTopLevelString(lines, 'model', state.model);
    state.managedModel = state.model;
  }
  lines = appendCodexProviderTable(lines, patch, managedBaseURL);
  writeTextFile(filePath, `${lines.join('\n').replace(/\n+$/, '')}\n`);
  writeJsonFile(codexPatchStatePath(filePath), state);
}

function restoreCodexTopLevelString(lines: readonly string[], key: string, baseline: string | null): string[] {
  return baseline === null ? removeTomlTopLevelKey(lines, key) : setTomlTopLevelString(lines, key, baseline);
}

function removeCodexConfigPatch(patch: CodexConfigPatchDef, wslTargetsFile?: string): boolean {
  let changed = removeCodexProviderFromFile(expandTilde(patch.configPath), patch);
  if (patch.installProbe === 'codex') {
    changed = removeWslInstalls('codex', wslTargetsFile, (target) => removeCodexProviderFromFile(target.configPath, patch)) || changed;
  }
  return changed;
}

function removeCodexProviderFromFile(filePath: string, patch: CodexConfigPatchDef): boolean {
  const state = readCodexPatchState(filePath);
  if (!existsSync(filePath)) return false;
  let lines = readFileSync(filePath, 'utf8').split('\n');
  const removal = removeCodexProviderTable(lines, patch.providerKey);
  lines = removal.lines;
  let changed = removal.changed;
  const managedBaseURL = state?.managedBaseURL;
  if (readTomlTopLevelString(lines, 'model_provider') === patch.providerKey) {
    lines = restoreCodexTopLevelString(lines, 'model_provider', state?.modelProvider ?? null);
    changed = true;
  } else if (managedBaseURL
    && readTomlTopLevelString(lines, 'model_provider') === 'openai'
    && readTomlTopLevelString(lines, 'openai_base_url') === managedBaseURL) {
    // Remove patches written by older AntSeed versions.
    lines = restoreCodexTopLevelString(lines, 'model_provider', state?.modelProvider ?? null);
    changed = true;
  }
  if (state && readTomlTopLevelString(lines, 'model') === state.managedModel) {
    lines = restoreCodexTopLevelString(lines, 'model', state.model);
    changed = true;
  }
  if (state && readTomlTopLevelString(lines, 'openai_base_url') === state.managedBaseURL) {
    lines = restoreCodexTopLevelString(lines, 'openai_base_url', state.openaiBaseUrl);
    changed = true;
  }
  if (state && readTomlTopLevelString(lines, 'model_catalog_json') === state.managedCatalogPath) {
    lines = restoreCodexTopLevelString(lines, 'model_catalog_json', state.modelCatalogJson);
    changed = true;
  }
  if (state && readTomlTopLevelString(lines, 'web_search') === 'disabled') {
    lines = restoreCodexTopLevelString(lines, 'web_search', state.webSearch);
    changed = true;
  }
  if (state && readTomlTableBoolean(lines, 'features', 'enable_request_compression') === false) {
    lines = restoreTomlTableBoolean(
      lines,
      'features',
      'enable_request_compression',
      state.requestCompression,
      state.featuresTableExisted,
    );
    changed = true;
  }
  if (changed) {
    backupConfigFile(filePath);
    writeTextFile(filePath, lines.length > 1 ? `${lines.join('\n').replace(/\n+$/, '')}\n` : '');
  }
  if (state) unlinkSync(codexPatchStatePath(filePath));
  return changed;
}

// --- pi (`~/.pi/agent/models.json` + `~/.pi/agent/settings.json`) ---
//
// pi discovers custom providers from models.json and picks the default
// provider/model from settings.json. The apiKey is a placeholder — the buyer
// proxy is keyless, but pi hides models that have no credential at all.

function applyPiConfigPatch(patch: PiConfigPatchDef, buyerPort: number, wslTargetsFile?: string): void {
  const baseURL = patch.baseURL.replace('{buyerPort}', String(buyerPort));
  const native = { configPath: expandTilde(patch.configPath), settingsPath: expandTilde(patch.settingsPath) };
  if (patch.installProbe !== 'pi') {
    applyPiProviderToFiles(native.configPath, native.settingsPath, patch, baseURL);
    return;
  }
  applyWithInstallProbe({
    tool: 'pi',
    native,
    posix: { configPath: patch.configPath, settingsPath: patch.settingsPath },
    baseURL,
    wslTargetsFile,
    write: (paths, url) => applyPiProviderToFiles(paths.configPath, paths.settingsPath ?? native.settingsPath, patch, url),
  });
}

function applyPiProviderToFiles(modelsPath: string, settingsPath: string, patch: PiConfigPatchDef, baseURL: string): void {
  backupConfigFile(modelsPath);
  const config = readConfigPatchFile(modelsPath);
  const providers = (config['providers'] && typeof config['providers'] === 'object' && !Array.isArray(config['providers']))
    ? config['providers'] as JsonObject
    : {};
  providers[patch.providerKey] = {
    baseUrl: baseURL,
    api: patch.api,
    apiKey: 'antseed',
    models: [
      {
        id: ROUTED_MODEL_ALIAS,
        name: ROUTED_MODEL_ALIAS_LABEL,
        contextWindow: ANTSEED_MODEL_CONTEXT_WINDOW,
        maxTokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS,
      },
    ],
  };
  config['providers'] = providers;
  writeJsonFile(modelsPath, config);

  backupConfigFile(settingsPath);
  const settings = readConfigPatchFile(settingsPath);
  settings['defaultProvider'] = patch.providerKey;
  settings['defaultModel'] = ROUTED_MODEL_ALIAS;
  writeJsonFile(settingsPath, settings);
}

function removePiConfigPatch(patch: PiConfigPatchDef, wslTargetsFile?: string): boolean {
  let changed = removePiProviderFromFiles(expandTilde(patch.configPath), expandTilde(patch.settingsPath), patch);
  if (patch.installProbe === 'pi') {
    changed = removeWslInstalls('pi', wslTargetsFile, (target) =>
      removePiProviderFromFiles(target.configPath, target.settingsPath ?? '', patch)) || changed;
  }
  return changed;
}

function removePiProviderFromFiles(modelsPath: string, settingsPath: string, patch: PiConfigPatchDef): boolean {
  let changed = false;
  const config = tryReadConfigPatchFile(modelsPath);
  const providers = config?.['providers'];
  if (config && providers && typeof providers === 'object' && !Array.isArray(providers) && (patch.providerKey in (providers as JsonObject))) {
    backupConfigFile(modelsPath);
    delete (providers as JsonObject)[patch.providerKey];
    writeJsonFile(modelsPath, config);
    changed = true;
  }
  const settings = tryReadConfigPatchFile(settingsPath);
  if (settings && settings['defaultProvider'] === patch.providerKey) {
    backupConfigFile(settingsPath);
    delete settings['defaultProvider'];
    delete settings['defaultModel'];
    writeJsonFile(settingsPath, settings);
    changed = true;
  }
  return changed;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

// --- Crush (`~/.config/crush/crush.json`) ---
//
// Crush takes custom endpoints as a `providers` map entry with
// `type: "openai-compat"`; the default model selection lives under
// `models.large` / `models.small` as `{ provider, model }`.

function applyCrushConfigPatch(patch: CrushConfigPatchDef, buyerPort: number, wslTargetsFile?: string): void {
  const filePath = expandTilde(patch.configPath);
  const baseURL = patch.baseURL.replace('{buyerPort}', String(buyerPort));
  if (patch.installProbe !== 'crush') {
    applyCrushProviderToFile(filePath, patch, baseURL);
    return;
  }
  applyWithInstallProbe({
    tool: 'crush',
    native: { configPath: filePath },
    posix: { configPath: patch.wslConfigPath ?? patch.configPath },
    baseURL,
    wslTargetsFile,
    write: (paths, url) => applyCrushProviderToFile(paths.configPath, patch, url),
  });
}

function applyCrushProviderToFile(filePath: string, patch: CrushConfigPatchDef, baseURL: string): void {
  backupConfigFile(filePath);
  const config = readConfigPatchFile(filePath);
  const providers = asObject(config['providers']);
  providers[patch.providerKey] = {
    type: 'openai-compat',
    name: patch.providerName,
    base_url: baseURL,
    api_key: 'antseed',
    models: [
      { id: ROUTED_MODEL_ALIAS, name: ROUTED_MODEL_ALIAS_LABEL, context_window: ANTSEED_MODEL_CONTEXT_WINDOW, default_max_tokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS },
    ],
  };
  config['providers'] = providers;
  const models = asObject(config['models']);
  const selection = { provider: patch.providerKey, model: ROUTED_MODEL_ALIAS };
  models['large'] = { ...selection };
  models['small'] = { ...selection };
  config['models'] = models;
  writeJsonFile(filePath, config);
}

function removeCrushConfigPatch(patch: CrushConfigPatchDef, wslTargetsFile?: string): boolean {
  let changed = removeCrushProviderFromFile(expandTilde(patch.configPath), patch);
  if (patch.installProbe === 'crush') {
    changed = removeWslInstalls('crush', wslTargetsFile, (target) => removeCrushProviderFromFile(target.configPath, patch)) || changed;
  }
  return changed;
}

function removeCrushProviderFromFile(filePath: string, patch: CrushConfigPatchDef): boolean {
  const config = tryReadConfigPatchFile(filePath);
  if (!config) return false;
  let changed = false;
  const providers = config['providers'];
  if (providers && typeof providers === 'object' && !Array.isArray(providers) && (patch.providerKey in (providers as JsonObject))) {
    delete (providers as JsonObject)[patch.providerKey];
    changed = true;
  }
  const models = config['models'];
  if (models && typeof models === 'object' && !Array.isArray(models)) {
    for (const size of ['large', 'small']) {
      const entry = (models as JsonObject)[size];
      if (entry && typeof entry === 'object' && (entry as JsonObject)['provider'] === patch.providerKey) {
        delete (models as JsonObject)[size];
        changed = true;
      }
    }
    if (Object.keys(models as JsonObject).length === 0) delete config['models'];
  }
  if (!changed) return false;
  backupConfigFile(filePath);
  writeJsonFile(filePath, config);
  return true;
}

// --- goose (`~/.config/goose/config.yaml`) ---
//
// goose config is flat env-style YAML keys (GOOSE_PROVIDER, GOOSE_MODEL,
// OPENAI_HOST, ...), edited line-based so user keys and comments survive.
// OPENAI_HOST is the host root — goose appends the /v1 chat path itself.
// The api key normally lives in the OS keyring; the config-file value covers
// keyring-less setups, and the buyer proxy ignores the credential anyway.

function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function yamlTopLevelKeyIndex(lines: readonly string[], key: string): number {
  const pattern = new RegExp(`^${key}\\s*:`);
  return lines.findIndex((line) => pattern.test(line));
}

function setYamlTopLevelString(lines: readonly string[], key: string, value: string): string[] {
  const assignment = `${key}: ${yamlScalar(value)}`;
  const index = yamlTopLevelKeyIndex(lines, key);
  if (index !== -1) {
    const next = [...lines];
    next[index] = assignment;
    return next;
  }
  return [...lines, assignment];
}

function readYamlTopLevelString(lines: readonly string[], key: string): string | undefined {
  const index = yamlTopLevelKeyIndex(lines, key);
  if (index === -1) return undefined;
  const raw = lines[index]!.slice(lines[index]!.indexOf(':') + 1).trim();
  const quoted = raw.match(/^"((?:[^"\\]|\\.)*)"/) ?? raw.match(/^'([^']*)'/);
  if (quoted) return quoted[1]!.replace(/\\(.)/g, '$1');
  return raw.split('#')[0]!.trim();
}

function removeYamlTopLevelKey(lines: readonly string[], key: string): string[] {
  const index = yamlTopLevelKeyIndex(lines, key);
  if (index === -1) return [...lines];
  return [...lines.slice(0, index), ...lines.slice(index + 1)];
}

/** True for host values only this patch would have written: a loopback root,
    or one of the WSL-reachable hosts a recorded target carries. */
function isLoopbackHost(value: string | undefined, extraHosts: readonly string[] = []): boolean {
  if (!value) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(value)) return true;
  return extraHosts.some((host) =>
    new RegExp(`^https?://${host.replace(/[.$]/g, '\\$&')}:\\d+/?$`).test(value));
}

function applyGooseConfigPatch(patch: GooseConfigPatchDef, buyerPort: number, wslTargetsFile?: string): void {
  const filePath = expandTilde(patch.configPath);
  const baseURL = patch.baseURL.replace('{buyerPort}', String(buyerPort));
  if (patch.installProbe !== 'goose') {
    applyGooseProviderToFile(filePath, patch, baseURL);
    return;
  }
  applyWithInstallProbe({
    tool: 'goose',
    native: { configPath: filePath },
    posix: { configPath: patch.wslConfigPath ?? patch.configPath },
    baseURL,
    wslTargetsFile,
    write: (paths, url) => applyGooseProviderToFile(paths.configPath, patch, url),
  });
}

function applyGooseProviderToFile(filePath: string, patch: GooseConfigPatchDef, baseURL: string): void {
  backupConfigFile(filePath);
  const raw = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  let lines = raw.length > 0 ? raw.split('\n') : [];
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  lines = setYamlTopLevelString(lines, 'GOOSE_PROVIDER', patch.providerKey);
  lines = setYamlTopLevelString(lines, 'GOOSE_MODEL', ROUTED_MODEL_ALIAS);
  lines = setYamlTopLevelString(lines, 'OPENAI_HOST', baseURL);
  lines = setYamlTopLevelString(lines, 'OPENAI_API_KEY', 'antseed');
  writeTextFile(filePath, `${lines.join('\n')}\n`);
}

function removeGooseConfigPatch(patch: GooseConfigPatchDef, wslTargetsFile?: string): boolean {
  let changed = removeGooseProviderFromFile(expandTilde(patch.configPath), patch, []);
  if (patch.installProbe === 'goose') {
    // The WSL config carries the gateway address rather than a loopback
    // host, so the recorded host joins the ownership check.
    changed = removeWslInstalls('goose', wslTargetsFile, (target) => removeGooseProviderFromFile(target.configPath, patch, [target.host])) || changed;
  }
  return changed;
}

function removeGooseProviderFromFile(filePath: string, patch: GooseConfigPatchDef, extraHosts: readonly string[]): boolean {
  if (!existsSync(filePath)) return false;
  let lines = readFileSync(filePath, 'utf8').split('\n');
  let changed = false;
  if (isLoopbackHost(readYamlTopLevelString(lines, 'OPENAI_HOST'), extraHosts)) {
    lines = removeYamlTopLevelKey(lines, 'OPENAI_HOST');
    changed = true;
  }
  if (readYamlTopLevelString(lines, 'OPENAI_API_KEY') === 'antseed') {
    lines = removeYamlTopLevelKey(lines, 'OPENAI_API_KEY');
    changed = true;
  }
  const model = readYamlTopLevelString(lines, 'GOOSE_MODEL');
  const ownsModel = model === ROUTED_MODEL_ALIAS || (model?.includes('@') ?? false);
  if (readYamlTopLevelString(lines, 'GOOSE_PROVIDER') === patch.providerKey && ownsModel) {
    lines = removeYamlTopLevelKey(lines, 'GOOSE_PROVIDER');
    lines = removeYamlTopLevelKey(lines, 'GOOSE_MODEL');
    changed = true;
  }
  if (!changed) return false;
  backupConfigFile(filePath);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  writeTextFile(filePath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  return true;
}

// --- Zed (`~/.config/zed/settings.json`) ---
//
// Zed takes custom endpoints under `language_models.openai_compatible`,
// keyed by provider name; the agent's default model references that name.
// Zed asks for the provider's API key once in its UI — any value satisfies
// the keyless buyer proxy.

function applyZedConfigPatch(patch: ZedConfigPatchDef, buyerPort: number): void {
  const filePath = expandTilde(patch.configPath);
  backupConfigFile(filePath);
  const config = readConfigPatchFile(filePath);
  const languageModels = asObject(config['language_models']);
  const compatible = asObject(languageModels['openai_compatible']);
  compatible[patch.providerName] = {
    api_url: patch.baseURL.replace('{buyerPort}', String(buyerPort)),
    available_models: [
      { name: ROUTED_MODEL_ALIAS, display_name: ROUTED_MODEL_ALIAS_LABEL, max_tokens: ANTSEED_MODEL_CONTEXT_WINDOW },
    ],
  };
  languageModels['openai_compatible'] = compatible;
  config['language_models'] = languageModels;
  const agent = asObject(config['agent']);
  agent['default_model'] = {
    provider: patch.providerName,
    model: ROUTED_MODEL_ALIAS,
  };
  config['agent'] = agent;
  writeJsonFile(filePath, config);
}

function removeZedConfigPatch(patch: ZedConfigPatchDef): boolean {
  const filePath = expandTilde(patch.configPath);
  const config = tryReadConfigPatchFile(filePath);
  if (!config) return false;
  let changed = false;
  const languageModels = config['language_models'];
  const compatible = languageModels && typeof languageModels === 'object' && !Array.isArray(languageModels)
    ? (languageModels as JsonObject)['openai_compatible']
    : undefined;
  if (compatible && typeof compatible === 'object' && !Array.isArray(compatible) && (patch.providerName in (compatible as JsonObject))) {
    delete (compatible as JsonObject)[patch.providerName];
    if (Object.keys(compatible as JsonObject).length === 0) {
      delete (languageModels as JsonObject)['openai_compatible'];
      if (Object.keys(languageModels as JsonObject).length === 0) delete config['language_models'];
    }
    changed = true;
  }
  const agent = config['agent'];
  if (agent && typeof agent === 'object' && !Array.isArray(agent)) {
    const defaultModel = (agent as JsonObject)['default_model'];
    if (defaultModel && typeof defaultModel === 'object' && (defaultModel as JsonObject)['provider'] === patch.providerName) {
      delete (agent as JsonObject)['default_model'];
      if (Object.keys(agent as JsonObject).length === 0) delete config['agent'];
      changed = true;
    }
  }
  if (!changed) return false;
  backupConfigFile(filePath);
  writeJsonFile(filePath, config);
  return true;
}

function applyT3CodeConfigPatch(patch: T3CodeConfigPatchDef, buyerPort: number): void {
  const filePath = expandTilde(patch.configPath);
  backupConfigFile(filePath);
  const config = readConfigPatchFile(filePath);
  const providerInstances = asObject(config['providerInstances']);
  const customModels = [ROUTED_MODEL_ALIAS];
  providerInstances[patch.providerKey] = {
    driver: 'claudeAgent',
    displayName: patch.providerName,
    environment: [
      { name: 'ANTHROPIC_BASE_URL', value: patch.baseURL.replace('{buyerPort}', String(buyerPort)), sensitive: false },
      { name: 'ANTHROPIC_API_KEY', value: 'antseed', sensitive: false },
      { name: 'HTTP_PROXY', value: '', sensitive: false },
      { name: 'HTTPS_PROXY', value: '', sensitive: false },
      { name: 'http_proxy', value: '', sensitive: false },
      { name: 'https_proxy', value: '', sensitive: false },
      { name: 'NO_PROXY', value: 'localhost,127.0.0.1,::1', sensitive: false },
      { name: 'no_proxy', value: 'localhost,127.0.0.1,::1', sensitive: false },
      { name: 'NODE_OPTIONS', value: '', sensitive: false },
    ],
    enabled: true,
    config: { customModels },
  };
  config['providerInstances'] = providerInstances;
  writeJsonFile(filePath, config);
}

function removeT3CodeConfigPatch(patch: T3CodeConfigPatchDef): boolean {
  const filePath = expandTilde(patch.configPath);
  const config = tryReadConfigPatchFile(filePath);
  if (!config) return false;
  const providerInstances = config['providerInstances'];
  if (!providerInstances || typeof providerInstances !== 'object' || Array.isArray(providerInstances)) return false;
  const instance = (providerInstances as JsonObject)[patch.providerKey];
  if (!instance || typeof instance !== 'object' || Array.isArray(instance)) return false;
  const environment = (instance as JsonObject)['environment'];
  const ownsInstance = Array.isArray(environment) && environment.some((variable) => {
    if (!variable || typeof variable !== 'object' || Array.isArray(variable)) return false;
    const value = (variable as JsonObject)['value'];
    return (variable as JsonObject)['name'] === 'ANTHROPIC_BASE_URL'
      && isLoopbackHost(typeof value === 'string' ? value : undefined);
  });
  if (!ownsInstance) return false;
  delete (providerInstances as JsonObject)[patch.providerKey];
  if (Object.keys(providerInstances as JsonObject).length === 0) delete config['providerInstances'];
  backupConfigFile(filePath);
  writeJsonFile(filePath, config);
  return true;
}
