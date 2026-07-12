import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type ConfigPatchDef = {
  readonly configPath: string;
  readonly providerKey: string;
  readonly npm: string;
  readonly providerName: string;
  readonly baseURL: string;
  readonly modelFormat: 'peer-routed';
};

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
  patch: ConfigPatchDef,
  peerId: string,
  model: string,
  servedModels: string[],
): JsonObject {
  const models: JsonObject = {};
  const cleanServedModels = servedModels.map((svc) => svc.trim()).filter(Boolean);
  if (patch.modelFormat === 'peer-routed') {
    for (const svc of cleanServedModels) {
      const key = peerId ? `${peerId}@${svc}` : svc;
      models[key] = { name: svc };
    }
    if (model) {
      const key = peerId ? `${peerId}@${model}` : model;
      if (!models[key]) models[key] = { name: model };
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

export function applyConfigPatch(patch: ConfigPatchDef, peerId: string, model: string, buyerPort: number, servedModels: string[]): void {
  if (!isBuyerProxyRoutablePeerId(peerId)) {
    throw new Error('Config-based routing requires a 40-character hex peer ID. Select a chain-backed peer before enabling this tool.');
  }
  const selectedService = resolveConfigPatchModel(model, servedModels);
  const filePath = expandTilde(patch.configPath);
  backupConfigFile(filePath);
  const selectedModel = routedModelKey(peerId, selectedService);
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
    models: buildConfigPatchModels(patch, peerId, selectedService, servedModels),
  };
  config['provider'] = providers;
  config['model'] = `${patch.providerKey}/${selectedModel}`;
  removeFromStringArray(config, 'disabled_providers', patch.providerKey);

  writeJsonFile(filePath, config);
}

export function removeConfigPatch(patch: ConfigPatchDef): boolean {
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
