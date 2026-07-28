import { ANTSEED_MODEL_CONTEXT_WINDOW, ANTSEED_MODEL_MAX_OUTPUT_TOKENS } from '@antseed/node/types';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Model alias resolved by the buyer proxy at request time to the route
 * currently selected in the desktop (floating pill / VPR). Must match
 * ROUTED_MODEL_ALIAS in apps/cli/src/proxy/request-utils.ts.
 */
export const ROUTED_MODEL_ALIAS = 'antseed';
const ROUTED_MODEL_ALIAS_LABEL = 'AntSeed Auto';

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
  readonly modelFormat: 'peer-routed';
};

export type CodexConfigPatchDef = {
  readonly format: 'codex';
  readonly configPath: string;
  readonly providerKey: string;
  readonly providerName: string;
  readonly baseURL: string;
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
};

export type CrushConfigPatchDef = {
  readonly format: 'crush';
  readonly configPath: string;
  readonly providerKey: string;
  readonly providerName: string;
  readonly baseURL: string;
};

export type GooseConfigPatchDef = {
  readonly format: 'goose';
  /** goose config.yaml (flat env-style keys). */
  readonly configPath: string;
  /** goose provider engine ('openai' for openai-compatible hosts). */
  readonly providerKey: string;
  /** Host root without /v1 — goose appends the chat-completions path itself. */
  readonly baseURL: string;
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
    };
  }
  if (format === 'crush') {
    return {
      format: 'crush',
      configPath,
      providerKey,
      providerName: readRequiredString(raw, 'providerName', profileName),
      baseURL,
    };
  }
  if (format === 'goose') {
    return { format: 'goose', configPath, providerKey, baseURL };
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
    modelFormat: 'peer-routed',
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

function buildConfigPatchModels(
  patch: OpencodeConfigPatchDef,
  peerId: string,
  model: string,
  servedModels: string[],
): JsonObject {
  const models: JsonObject = {};
  const cleanServedModels = servedModels.map((svc) => svc.trim()).filter(Boolean);
  if (patch.modelFormat === 'peer-routed') {
    for (const svc of cleanServedModels) {
      const key = peerId ? `${peerId}@${svc}` : svc;
      models[key] = {
        name: svc,
        limit: { context: ANTSEED_MODEL_CONTEXT_WINDOW, output: ANTSEED_MODEL_MAX_OUTPUT_TOKENS },
      };
    }
    if (model) {
      const key = peerId ? `${peerId}@${model}` : model;
      if (!models[key]) {
        models[key] = {
          name: model,
          limit: { context: ANTSEED_MODEL_CONTEXT_WINDOW, output: ANTSEED_MODEL_MAX_OUTPUT_TOKENS },
        };
      }
    }
  }
  return models;
}

function routedModelKey(peerId: string, model: string): string {
  return peerId ? `${peerId}@${model}` : model;
}

function resolveConfigPatchModel(model: string, servedModels: string[]): string {
  const requested = model.trim();
  if (requested) return requested;
  const fallback = servedModels.map((svc) => svc.trim()).find(Boolean);
  if (fallback) return fallback;
  throw new Error('Config-based routing requires a model. Select a peer with advertised models or choose a model before enabling this tool.');
}

/**
 * Point the tool's config at the buyer proxy. With `useAlias`, the selected
 * model is written as the ROUTED_MODEL_ALIAS instead of a concrete
 * `<peerId>@<service>` key — the buyer resolves the alias to the current VPR
 * route per request, so route changes reach running tool sessions without a
 * config rewrite. Concrete keys are still written for per-app overrides.
 */
export function applyConfigPatch(patch: ConfigPatchDef, peerId: string, model: string, buyerPort: number, servedModels: string[], useAlias = false): void {
  if (!isBuyerProxyRoutablePeerId(peerId)) {
    throw new Error('Config-based routing requires a 40-character hex peer ID. Select a chain-backed peer before enabling this tool.');
  }
  const selectedService = resolveConfigPatchModel(model, servedModels);
  if (patch.format === 'codex') {
    applyCodexConfigPatch(patch, peerId, selectedService, buyerPort, useAlias);
    return;
  }
  if (patch.format === 'pi') {
    applyPiConfigPatch(patch, peerId, selectedService, buyerPort, servedModels, useAlias);
    return;
  }
  if (patch.format === 'crush') {
    applyCrushConfigPatch(patch, peerId, selectedService, buyerPort, servedModels, useAlias);
    return;
  }
  if (patch.format === 'goose') {
    applyGooseConfigPatch(patch, peerId, selectedService, buyerPort, useAlias);
    return;
  }
  if (patch.format === 'zed') {
    applyZedConfigPatch(patch, peerId, selectedService, buyerPort, servedModels, useAlias);
    return;
  }
  if (patch.format === 't3code') {
    applyT3CodeConfigPatch(patch, peerId, selectedService, buyerPort, servedModels, useAlias);
    return;
  }
  const filePath = expandTilde(patch.configPath);
  backupConfigFile(filePath);
  const selectedModel = useAlias ? ROUTED_MODEL_ALIAS : routedModelKey(peerId, selectedService);
  const config = readConfigPatchFile(filePath);

  const providers = (config['provider'] && typeof config['provider'] === 'object' && !Array.isArray(config['provider']))
    ? config['provider'] as JsonObject
    : {};
  providers[patch.providerKey] = {
    name: patch.providerName,
    npm: patch.npm,
    options: {
      baseURL: patch.baseURL.replace('{buyerPort}', String(buyerPort)),
      apiKey: 'antseed',
    },
    models: {
      [ROUTED_MODEL_ALIAS]: {
        name: ROUTED_MODEL_ALIAS_LABEL,
        limit: { context: ANTSEED_MODEL_CONTEXT_WINDOW, output: ANTSEED_MODEL_MAX_OUTPUT_TOKENS },
      },
      ...buildConfigPatchModels(patch, peerId, selectedService, servedModels),
    },
  };
  config['provider'] = providers;
  config['model'] = `${patch.providerKey}/${selectedModel}`;
  removeFromStringArray(config, 'disabled_providers', patch.providerKey);

  writeJsonFile(filePath, config);
}

export function removeConfigPatch(patch: ConfigPatchDef): boolean {
  if (patch.format === 'codex') {
    return removeCodexConfigPatch(patch);
  }
  if (patch.format === 'pi') {
    return removePiConfigPatch(patch);
  }
  if (patch.format === 'crush') {
    return removeCrushConfigPatch(patch);
  }
  if (patch.format === 'goose') {
    return removeGooseConfigPatch(patch);
  }
  if (patch.format === 'zed') {
    return removeZedConfigPatch(patch);
  }
  if (patch.format === 't3code') {
    return removeT3CodeConfigPatch(patch);
  }
  const filePath = expandTilde(patch.configPath);
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

function routedModelEntries(peerId: string, model: string, servedModels: string[]): Array<{ id: string; name: string }> {
  const entries: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const svc of [...servedModels, model]) {
    const name = svc.trim();
    if (!name) continue;
    const id = routedModelKey(peerId, name);
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, name });
  }
  return entries;
}

function writeTextFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, content, 'utf8');
}

// --- Codex CLI (`~/.codex/config.toml`) ---
//
// Codex config is TOML, edited structurally instead of parsed: the managed
// `[model_providers.<key>]` table is replaced wholesale and the top-level
// `model_provider` / `model` keys are set in the region before the first
// table header (TOML requires top-level keys there). Everything the user
// wrote is left untouched.

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
  const match = lines[index]!.match(/=\s*"((?:[^"\\]|\\.)*)"\s*(#.*)?$/);
  return match ? match[1]!.replace(/\\(.)/g, '$1') : undefined;
}

function removeTomlTopLevelKey(lines: readonly string[], key: string): string[] {
  const index = tomlTopLevelKeyIndex(lines, key);
  if (index === -1) return [...lines];
  return [...lines.slice(0, index), ...lines.slice(index + 1)];
}

function applyCodexConfigPatch(patch: CodexConfigPatchDef, peerId: string, service: string, buyerPort: number, useAlias: boolean): void {
  const filePath = expandTilde(patch.configPath);
  backupConfigFile(filePath);
  const raw = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  let lines = raw.length > 0 ? raw.split('\n') : [];
  lines = removeCodexProviderTable(lines, patch.providerKey).lines;
  lines = setTomlTopLevelString(lines, 'model_provider', patch.providerKey);
  lines = setTomlTopLevelString(lines, 'model', useAlias ? ROUTED_MODEL_ALIAS : routedModelKey(peerId, service));
  lines = setTomlTopLevelValue(lines, 'model_context_window', String(ANTSEED_MODEL_CONTEXT_WINDOW));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  lines.push(
    '',
    `[model_providers.${patch.providerKey}]`,
    `name = ${tomlBasicString(patch.providerName)}`,
    `base_url = ${tomlBasicString(patch.baseURL.replace('{buyerPort}', String(buyerPort)))}`,
    // The only wire API Codex still supports; no env_key means Codex sends no
    // Authorization header, which the keyless buyer proxy expects.
    'wire_api = "responses"',
  );
  writeTextFile(filePath, `${lines.join('\n')}\n`);
}

function removeCodexConfigPatch(patch: CodexConfigPatchDef): boolean {
  const filePath = expandTilde(patch.configPath);
  if (!existsSync(filePath)) return false;
  const raw = readFileSync(filePath, 'utf8');
  const removal = removeCodexProviderTable(raw.split('\n'), patch.providerKey);
  let lines = removal.lines;
  let changed = removal.changed;
  if (readTomlTopLevelString(lines, 'model_provider') === patch.providerKey) {
    lines = removeTomlTopLevelKey(lines, 'model_provider');
    lines = removeTomlTopLevelKey(lines, 'model');
    lines = removeTomlTopLevelKey(lines, 'model_context_window');
    changed = true;
  }
  if (!changed) return false;
  backupConfigFile(filePath);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  writeTextFile(filePath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  return true;
}

// --- pi (`~/.pi/agent/models.json` + `~/.pi/agent/settings.json`) ---
//
// pi discovers custom providers from models.json and picks the default
// provider/model from settings.json. The apiKey is a placeholder — the buyer
// proxy is keyless, but pi hides models that have no credential at all.

function applyPiConfigPatch(patch: PiConfigPatchDef, peerId: string, service: string, buyerPort: number, servedModels: string[], useAlias: boolean): void {
  const modelsPath = expandTilde(patch.configPath);
  backupConfigFile(modelsPath);
  const config = readConfigPatchFile(modelsPath);
  const providers = (config['providers'] && typeof config['providers'] === 'object' && !Array.isArray(config['providers']))
    ? config['providers'] as JsonObject
    : {};
  providers[patch.providerKey] = {
    baseUrl: patch.baseURL.replace('{buyerPort}', String(buyerPort)),
    api: patch.api,
    apiKey: 'antseed',
    models: [
      {
        id: ROUTED_MODEL_ALIAS,
        name: ROUTED_MODEL_ALIAS_LABEL,
        contextWindow: ANTSEED_MODEL_CONTEXT_WINDOW,
        maxTokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS,
      },
      ...routedModelEntries(peerId, service, servedModels).map(({ id, name }) => ({
        id,
        name,
        contextWindow: ANTSEED_MODEL_CONTEXT_WINDOW,
        maxTokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS,
      })),
    ],
  };
  config['providers'] = providers;
  writeJsonFile(modelsPath, config);

  const settingsPath = expandTilde(patch.settingsPath);
  backupConfigFile(settingsPath);
  const settings = readConfigPatchFile(settingsPath);
  settings['defaultProvider'] = patch.providerKey;
  settings['defaultModel'] = useAlias ? ROUTED_MODEL_ALIAS : routedModelKey(peerId, service);
  writeJsonFile(settingsPath, settings);
}

function removePiConfigPatch(patch: PiConfigPatchDef): boolean {
  let changed = false;
  const modelsPath = expandTilde(patch.configPath);
  const config = tryReadConfigPatchFile(modelsPath);
  const providers = config?.['providers'];
  if (config && providers && typeof providers === 'object' && !Array.isArray(providers) && (patch.providerKey in (providers as JsonObject))) {
    backupConfigFile(modelsPath);
    delete (providers as JsonObject)[patch.providerKey];
    writeJsonFile(modelsPath, config);
    changed = true;
  }
  const settingsPath = expandTilde(patch.settingsPath);
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

function applyCrushConfigPatch(patch: CrushConfigPatchDef, peerId: string, service: string, buyerPort: number, servedModels: string[], useAlias: boolean): void {
  const filePath = expandTilde(patch.configPath);
  backupConfigFile(filePath);
  const config = readConfigPatchFile(filePath);
  const providers = asObject(config['providers']);
  providers[patch.providerKey] = {
    type: 'openai-compat',
    name: patch.providerName,
    base_url: patch.baseURL.replace('{buyerPort}', String(buyerPort)),
    api_key: 'antseed',
    models: [
      { id: ROUTED_MODEL_ALIAS, name: ROUTED_MODEL_ALIAS_LABEL, context_window: ANTSEED_MODEL_CONTEXT_WINDOW, default_max_tokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS },
      ...routedModelEntries(peerId, service, servedModels).map(({ id, name }) => (
        { id, name, context_window: ANTSEED_MODEL_CONTEXT_WINDOW, default_max_tokens: ANTSEED_MODEL_MAX_OUTPUT_TOKENS }
      )),
    ],
  };
  config['providers'] = providers;
  const models = asObject(config['models']);
  const selection = { provider: patch.providerKey, model: useAlias ? ROUTED_MODEL_ALIAS : routedModelKey(peerId, service) };
  models['large'] = { ...selection };
  models['small'] = { ...selection };
  config['models'] = models;
  writeJsonFile(filePath, config);
}

function removeCrushConfigPatch(patch: CrushConfigPatchDef): boolean {
  const filePath = expandTilde(patch.configPath);
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

/** True for host values only this patch would have written (loopback root). */
function isLoopbackHost(value: string | undefined): boolean {
  return !!value && /^https?:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(value);
}

function applyGooseConfigPatch(patch: GooseConfigPatchDef, peerId: string, service: string, buyerPort: number, useAlias: boolean): void {
  const filePath = expandTilde(patch.configPath);
  backupConfigFile(filePath);
  const raw = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  let lines = raw.length > 0 ? raw.split('\n') : [];
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  lines = setYamlTopLevelString(lines, 'GOOSE_PROVIDER', patch.providerKey);
  lines = setYamlTopLevelString(lines, 'GOOSE_MODEL', useAlias ? ROUTED_MODEL_ALIAS : routedModelKey(peerId, service));
  lines = setYamlTopLevelString(lines, 'OPENAI_HOST', patch.baseURL.replace('{buyerPort}', String(buyerPort)));
  lines = setYamlTopLevelString(lines, 'OPENAI_API_KEY', 'antseed');
  writeTextFile(filePath, `${lines.join('\n')}\n`);
}

function removeGooseConfigPatch(patch: GooseConfigPatchDef): boolean {
  const filePath = expandTilde(patch.configPath);
  if (!existsSync(filePath)) return false;
  let lines = readFileSync(filePath, 'utf8').split('\n');
  let changed = false;
  if (isLoopbackHost(readYamlTopLevelString(lines, 'OPENAI_HOST'))) {
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

function applyZedConfigPatch(patch: ZedConfigPatchDef, peerId: string, service: string, buyerPort: number, servedModels: string[], useAlias: boolean): void {
  const filePath = expandTilde(patch.configPath);
  backupConfigFile(filePath);
  const config = readConfigPatchFile(filePath);
  const languageModels = asObject(config['language_models']);
  const compatible = asObject(languageModels['openai_compatible']);
  compatible[patch.providerName] = {
    api_url: patch.baseURL.replace('{buyerPort}', String(buyerPort)),
    available_models: [
      { name: ROUTED_MODEL_ALIAS, display_name: ROUTED_MODEL_ALIAS_LABEL, max_tokens: ANTSEED_MODEL_CONTEXT_WINDOW },
      ...routedModelEntries(peerId, service, servedModels).map(({ id, name }) => (
        { name: id, display_name: name, max_tokens: ANTSEED_MODEL_CONTEXT_WINDOW }
      )),
    ],
  };
  languageModels['openai_compatible'] = compatible;
  config['language_models'] = languageModels;
  const agent = asObject(config['agent']);
  agent['default_model'] = {
    provider: patch.providerName,
    model: useAlias ? ROUTED_MODEL_ALIAS : routedModelKey(peerId, service),
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

function applyT3CodeConfigPatch(patch: T3CodeConfigPatchDef, peerId: string, service: string, buyerPort: number, servedModels: string[], useAlias: boolean): void {
  const filePath = expandTilde(patch.configPath);
  backupConfigFile(filePath);
  const config = readConfigPatchFile(filePath);
  const providerInstances = asObject(config['providerInstances']);
  const routedModels = routedModelEntries(peerId, service, servedModels).map(({ id }) => id);
  const customModels = [...new Set([
    ...(useAlias ? [ROUTED_MODEL_ALIAS] : []),
    ...routedModels,
  ])];
  providerInstances[patch.providerKey] = {
    driver: 'claudeAgent',
    displayName: patch.providerName,
    environment: [
      { name: 'ANTHROPIC_BASE_URL', value: patch.baseURL.replace('{buyerPort}', String(buyerPort)), sensitive: false },
      { name: 'ANTHROPIC_API_KEY', value: 'antseed', sensitive: false },
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
