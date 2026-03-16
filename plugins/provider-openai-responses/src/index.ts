import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type {
  AntseedProviderPlugin,
  Provider,
  ProviderStreamCallbacks,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ServiceApiProtocol,
} from '@antseed/node';
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  buildServiceApiProtocols,
  parseCsv,
  parseNonNegativeNumber,
  parseServiceAliasMap,
  parseServicePricingJson,
  stripRelayRequestHeaders,
  stripRelayResponseHeaders,
  validateRequestService,
} from '@antseed/provider-core';

const DEFAULT_AUTH_FILE = '~/.codex/auth.json';
const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_INPUT_PRICE = 10;
const DEFAULT_OUTPUT_PRICE = 10;
const DEFAULT_MAX_CONCURRENCY = 5;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const FETCH_TIMEOUT_MS = DEFAULT_HTTP_TIMEOUT_MS;
const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RESPONSE_PATH_PREFIX = '/v1/responses';
const UPSTREAM_RESPONSES_PATH = '/codex/responses';
const MODELS_PATH = '/v1/models';
const AUTH_CLAIM_PATH = 'https://api.openai.com/auth';

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

interface AuthFileShape {
  OPENAI_API_KEY?: unknown;
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
    account_id?: unknown;
  };
  last_refresh?: unknown;
}

interface AuthContext {
  accessToken: string;
  refreshToken?: string;
  accountId: string;
  expiresAt?: number;
  idToken?: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (!payload) return null;

  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readAuthContext(authFilePath: string): AuthContext {
  const raw = readFileSync(authFilePath, 'utf8');
  const parsed = JSON.parse(raw) as AuthFileShape;
  const accessToken = typeof parsed.tokens?.access_token === 'string'
    ? parsed.tokens.access_token.trim()
    : '';

  if (!accessToken) {
    throw new Error(`Codex auth file at ${authFilePath} is missing tokens.access_token`);
  }

  const payload = decodeJwtPayload(accessToken);
  const jwtAccountId = payload
    && payload[AUTH_CLAIM_PATH]
    && typeof payload[AUTH_CLAIM_PATH] === 'object'
    && !Array.isArray(payload[AUTH_CLAIM_PATH])
    && typeof (payload[AUTH_CLAIM_PATH] as Record<string, unknown>)['chatgpt_account_id'] === 'string'
    ? ((payload[AUTH_CLAIM_PATH] as Record<string, unknown>)['chatgpt_account_id'] as string).trim()
    : '';
  const authFileAccountId = typeof parsed.tokens?.account_id === 'string'
    ? parsed.tokens.account_id.trim()
    : '';
  const accountId = jwtAccountId || authFileAccountId;

  if (!accountId) {
    throw new Error(
      `Codex auth file at ${authFilePath} is missing tokens.account_id and the JWT lacks ${AUTH_CLAIM_PATH}.chatgpt_account_id`,
    );
  }

  const refreshToken = typeof parsed.tokens?.refresh_token === 'string'
    ? parsed.tokens.refresh_token.trim()
    : undefined;
  const idToken = typeof parsed.tokens?.id_token === 'string'
    ? parsed.tokens.id_token.trim()
    : undefined;
  const expiresAt = getJwtExpiration(accessToken);

  return { accessToken, refreshToken, accountId, expiresAt, idToken };
}

function getJwtExpiration(token: string): number | undefined {
  const payload = decodeJwtPayload(token);
  const exp = payload?.['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) {
    return undefined;
  }
  return exp * 1000;
}

function isAuthExpiringSoon(auth: AuthContext): boolean {
  return auth.expiresAt !== undefined && Date.now() >= auth.expiresAt - REFRESH_BUFFER_MS;
}

function writeAuthContext(authFilePath: string, auth: AuthContext): void {
  const existing = JSON.parse(readFileSync(authFilePath, 'utf8')) as AuthFileShape;
  const next: AuthFileShape = {
    ...existing,
    tokens: {
      ...existing.tokens,
      access_token: auth.accessToken,
      ...(auth.refreshToken ? { refresh_token: auth.refreshToken } : {}),
      ...(auth.idToken ? { id_token: auth.idToken } : {}),
      account_id: auth.accountId,
    },
    last_refresh: new Date().toISOString(),
  };

  const tempPath = `${authFilePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tempPath, authFilePath);
}

async function refreshAuthContext(authFilePath: string): Promise<AuthContext> {
  const current = readAuthContext(authFilePath);
  if (!current.refreshToken) {
    throw new Error(`Codex auth file at ${authFilePath} is missing tokens.refresh_token`);
  }

  const response = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
      client_id: OPENAI_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI Codex token refresh failed (${response.status}): ${text}`);
  }

  const json = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    id_token?: unknown;
  };

  const accessToken = typeof json.access_token === 'string' ? json.access_token.trim() : '';
  const refreshToken = typeof json.refresh_token === 'string'
    ? json.refresh_token.trim()
    : current.refreshToken;
  const idToken = typeof json.id_token === 'string' ? json.id_token.trim() : current.idToken;

  if (!accessToken) {
    throw new Error('OpenAI Codex token refresh response missing access_token');
  }

  const refreshed: AuthContext = {
    accessToken,
    refreshToken,
    accountId: extractAccountIdFromTokens(accessToken, idToken, current.accountId),
    expiresAt: getExpiresAtFromRefreshResponse(accessToken, json.expires_in),
    ...(idToken ? { idToken } : {}),
  };

  writeAuthContext(authFilePath, refreshed);
  return refreshed;
}

function getExpiresAtFromRefreshResponse(accessToken: string, expiresIn: unknown): number | undefined {
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    return Date.now() + expiresIn * 1000;
  }
  return getJwtExpiration(accessToken);
}

function extractAccountIdFromTokens(accessToken: string, idToken: string | undefined, fallbackAccountId: string): string {
  const accessPayload = decodeJwtPayload(accessToken);
  const accessAccountId = accessPayload
    && accessPayload[AUTH_CLAIM_PATH]
    && typeof accessPayload[AUTH_CLAIM_PATH] === 'object'
    && !Array.isArray(accessPayload[AUTH_CLAIM_PATH])
    && typeof (accessPayload[AUTH_CLAIM_PATH] as Record<string, unknown>)['chatgpt_account_id'] === 'string'
    ? ((accessPayload[AUTH_CLAIM_PATH] as Record<string, unknown>)['chatgpt_account_id'] as string).trim()
    : '';

  if (accessAccountId) return accessAccountId;

  if (idToken) {
    const idPayload = decodeJwtPayload(idToken);
    const idAccountId = idPayload
      && idPayload[AUTH_CLAIM_PATH]
      && typeof idPayload[AUTH_CLAIM_PATH] === 'object'
      && !Array.isArray(idPayload[AUTH_CLAIM_PATH])
      && typeof (idPayload[AUTH_CLAIM_PATH] as Record<string, unknown>)['chatgpt_account_id'] === 'string'
      ? ((idPayload[AUTH_CLAIM_PATH] as Record<string, unknown>)['chatgpt_account_id'] as string).trim()
      : '';
    if (idAccountId) return idAccountId;
  }

  return fallbackAccountId;
}

function replaceRequestedService(
  request: SerializedHttpRequest,
  serviceRewriteMap: Record<string, string> | undefined,
): SerializedHttpRequest {
  if (!serviceRewriteMap || request.method === 'GET' || request.method === 'HEAD') {
    return request;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
    const requestedService = parsed.model ?? parsed.service;
    if (typeof requestedService !== 'string' || requestedService.trim().length === 0) {
      return request;
    }

    const rewrittenService = serviceRewriteMap[requestedService.trim().toLowerCase()];
    if (!rewrittenService || rewrittenService.trim().length === 0) {
      return request;
    }

    return {
      ...request,
      body: new TextEncoder().encode(JSON.stringify({
        ...parsed,
        model: rewrittenService.trim(),
      })),
    };
  } catch {
    return request;
  }
}

function isTransientError(statusCode: number): boolean {
  return TRANSIENT_STATUS_CODES.has(statusCode);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function requestPathToUpstream(path: string): string | null {
  const normalized = path.split('?')[0] ?? path;
  if (normalized === MODELS_PATH) return null;
  if (normalized.startsWith(RESPONSE_PATH_PREFIX)) return UPSTREAM_RESPONSES_PATH;
  return null;
}

function buildModelsResponse(requestId: string, services: string[]): SerializedHttpResponse {
  const now = Math.floor(Date.now() / 1000);
  return {
    requestId,
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
    },
    body: new TextEncoder().encode(JSON.stringify({
      object: 'list',
      data: services.map((id) => ({
        id,
        object: 'model',
        created: now,
        owned_by: 'antseed-openai-responses',
      })),
    })),
  };
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

interface RequestResult {
  response: SerializedHttpResponse;
  streamStart?: SerializedHttpResponse;
  streamChunks?: Array<{
    requestId: string;
    data: Uint8Array;
    done: boolean;
  }>;
}

class CodexResponsesProvider implements Provider {
  readonly name: string;
  readonly services: string[];
  readonly pricing: Provider['pricing'];
  readonly serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
  readonly maxConcurrency: number;

  private readonly authFilePath: string;
  private readonly baseUrl: string;
  private readonly serviceRewriteMap?: Record<string, string>;
  private readonly validationServices: ReadonlySet<string>;
  private authRefreshPromise: Promise<AuthContext> | null = null;
  private activeCount = 0;

  constructor(config: {
    name: string;
    services: string[];
    pricing: Provider['pricing'];
    serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
    maxConcurrency: number;
    authFilePath: string;
    baseUrl: string;
    serviceRewriteMap?: Record<string, string>;
  }) {
    this.name = config.name;
    this.services = config.services;
    this.pricing = config.pricing;
    this.serviceApiProtocols = config.serviceApiProtocols;
    this.maxConcurrency = config.maxConcurrency;
    this.authFilePath = config.authFilePath;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.serviceRewriteMap = config.serviceRewriteMap;

    const rewriteValues = Object.values(config.serviceRewriteMap ?? {});
    this.validationServices = new Set([
      ...config.services.map((service) => service.trim().toLowerCase()),
      ...rewriteValues.map((service) => service.trim().toLowerCase()),
    ]);
  }

  async init(): Promise<void> {
    await this.getAuthContext();
  }

  getCapacity(): { current: number; max: number } {
    return {
      current: this.activeCount,
      max: this.maxConcurrency,
    };
  }

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    return (await this.executeRequest(req)).response;
  }

  async handleRequestStream(
    req: SerializedHttpRequest,
    callbacks: ProviderStreamCallbacks,
  ): Promise<SerializedHttpResponse> {
    return (await this.executeRequest(req, callbacks)).response;
  }

  private buildError(requestId: string, statusCode: number, error: string): RequestResult {
    return {
      response: {
        requestId,
        statusCode,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ error })),
      },
    };
  }

  private async executeRequest(
    req: SerializedHttpRequest,
    callbacks?: ProviderStreamCallbacks,
  ): Promise<RequestResult> {
    if (this.activeCount >= this.maxConcurrency) {
      return this.buildError(req.requestId, 429, 'Max concurrency reached');
    }

    const normalizedPath = req.path.split('?')[0] ?? req.path;
    if (normalizedPath === MODELS_PATH) {
      return { response: buildModelsResponse(req.requestId, this.services) };
    }

    const validationError = validateRequestService(req, this.validationServices);
    if (validationError) {
      return this.buildError(req.requestId, 403, validationError);
    }

    const upstreamPath = requestPathToUpstream(req.path);
    if (!upstreamPath) {
      return this.buildError(req.requestId, 404, `Unsupported path: ${normalizedPath}`);
    }

    this.activeCount++;
    try {
      return await this.fetchWithRetry(replaceRequestedService(req, this.serviceRewriteMap), upstreamPath, callbacks);
    } finally {
      this.activeCount--;
    }
  }

  private async fetchWithRetry(
    req: SerializedHttpRequest,
    upstreamPath: string,
    callbacks?: ProviderStreamCallbacks,
  ): Promise<RequestResult> {
    let lastError: Error | null = null;
    let auth = await this.getAuthContext();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await this.fetchOnce(req, upstreamPath, auth);
        if (result.response.statusCode === 401) {
          auth = await this.forceRefreshAuthContext();
          return this.finalizeResult(await this.fetchOnce(req, upstreamPath, auth), callbacks);
        }
        if (!isTransientError(result.response.statusCode) || attempt === MAX_RETRIES) {
          return this.finalizeResult(result, callbacks);
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === MAX_RETRIES) {
          break;
        }
      }

      await sleep(BASE_DELAY_MS * 2 ** attempt);
    }

    return this.buildError(
      req.requestId,
      502,
      lastError?.message ?? 'OpenAI Responses upstream request failed after retries',
    );
  }

  private async getAuthContext(): Promise<AuthContext> {
    const auth = readAuthContext(this.authFilePath);
    if (!isAuthExpiringSoon(auth)) {
      return auth;
    }
    return this.forceRefreshAuthContext();
  }

  private async forceRefreshAuthContext(): Promise<AuthContext> {
    if (!this.authRefreshPromise) {
      this.authRefreshPromise = refreshAuthContext(this.authFilePath)
        .finally(() => {
          this.authRefreshPromise = null;
        });
    }
    return this.authRefreshPromise;
  }

  private async fetchOnce(
    req: SerializedHttpRequest,
    upstreamPath: string,
    auth: AuthContext,
  ): Promise<RequestResult> {
    const fetchHeaders = stripRelayRequestHeaders(req.headers, {
      stripHeaderNames: ['authorization', 'chatgpt-account-id', 'openai-beta'],
    });
    fetchHeaders['authorization'] = `Bearer ${auth.accessToken}`;
    fetchHeaders['chatgpt-account-id'] = auth.accountId;
    fetchHeaders['openai-beta'] = 'responses=experimental';
    if (!Object.keys(fetchHeaders).some((key) => key.toLowerCase() === 'content-type') && req.method !== 'GET' && req.method !== 'HEAD') {
      fetchHeaders['content-type'] = 'application/json';
    }

    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${upstreamPath}`, {
        method: req.method,
        headers: fetchHeaders,
        body: req.method !== 'GET' && req.method !== 'HEAD'
          ? Buffer.from(req.body)
          : undefined,
        signal: timeoutSignal,
      });
    } catch (error) {
      if (timeoutSignal.aborted) {
        throw new Error(`OpenAI Responses upstream request timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
      throw error;
    }

    const responseHeaders = stripRelayResponseHeaders(response);
    const contentType = response.headers.get('content-type') ?? '';
    const isSse = contentType.includes('text/event-stream');

    if (isSse && response.body) {
      const responseStart: SerializedHttpResponse = {
        requestId: req.requestId,
        statusCode: response.status,
        headers: responseHeaders,
        body: new Uint8Array(0),
      };

      const reader = response.body.getReader();
      const streamChunks: Uint8Array[] = [];
      const serializedChunks: NonNullable<RequestResult['streamChunks']> = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        streamChunks.push(value);
        serializedChunks.push({
          requestId: req.requestId,
          data: value,
          done: false,
        });
      }

      serializedChunks.push({
        requestId: req.requestId,
        data: new Uint8Array(0),
        done: true,
      });

      return {
        response: {
          ...responseStart,
          body: concatChunks(streamChunks),
        },
        streamStart: responseStart,
        streamChunks: serializedChunks,
      };
    }

    return {
      response: {
        requestId: req.requestId,
        statusCode: response.status,
        headers: responseHeaders,
        body: new Uint8Array(await response.arrayBuffer()),
      },
    };
  }

  private finalizeResult(
    result: RequestResult,
    callbacks?: ProviderStreamCallbacks,
  ): RequestResult {
    if (!callbacks || !result.streamStart || !result.streamChunks) {
      return result;
    }

    callbacks.onResponseStart(result.streamStart);
    for (const chunk of result.streamChunks) {
      callbacks.onResponseChunk(chunk);
    }

    return result;
  }
}

const plugin: AntseedProviderPlugin = {
  name: 'openai-responses',
  displayName: 'OpenAI Responses',
  version: '0.1.0',
  type: 'provider',
  description: 'OpenAI Responses provider using Codex backend auth (testing only)',
  configSchema: [
    { key: 'OPENAI_RESPONSES_AUTH_FILE', label: 'Auth File', type: 'string', required: false, default: DEFAULT_AUTH_FILE, description: 'Path to ~/.codex/auth.json' },
    { key: 'OPENAI_RESPONSES_BASE_URL', label: 'Base URL', type: 'string', required: false, default: DEFAULT_BASE_URL, description: 'Codex backend base URL' },
    { key: 'ANTSEED_INPUT_USD_PER_MILLION', label: 'Input Price', type: 'number', required: false, default: DEFAULT_INPUT_PRICE, description: 'Input price in USD per 1M tokens' },
    { key: 'ANTSEED_OUTPUT_USD_PER_MILLION', label: 'Output Price', type: 'number', required: false, default: DEFAULT_OUTPUT_PRICE, description: 'Output price in USD per 1M tokens' },
    { key: 'ANTSEED_SERVICE_PRICING_JSON', label: 'Service Pricing JSON', type: 'string', required: false, description: 'Per-service pricing JSON' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: DEFAULT_MAX_CONCURRENCY, description: 'Max concurrent requests' },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Allowed Services', type: 'string[]', required: false, description: 'Service allow-list' },
    { key: 'ANTSEED_SERVICE_ALIAS_MAP_JSON', label: 'Service Alias Map', type: 'string', required: false, description: 'JSON map of announced service -> upstream model name' },
  ],

  createProvider(config: Record<string, string>): Provider {
    const servicePricing = parseServicePricingJson(config['ANTSEED_SERVICE_PRICING_JSON']);
    const pricing: Provider['pricing'] = {
      defaults: {
        inputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_INPUT_USD_PER_MILLION'], 'ANTSEED_INPUT_USD_PER_MILLION', DEFAULT_INPUT_PRICE),
        outputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_OUTPUT_USD_PER_MILLION'], 'ANTSEED_OUTPUT_USD_PER_MILLION', DEFAULT_OUTPUT_PRICE),
      },
      ...(servicePricing ? { services: servicePricing } : {}),
    };

    const maxConcurrency = parseInt(config['ANTSEED_MAX_CONCURRENCY'] ?? String(DEFAULT_MAX_CONCURRENCY), 10);
    if (Number.isNaN(maxConcurrency) || maxConcurrency <= 0) {
      throw new Error('ANTSEED_MAX_CONCURRENCY must be a positive number');
    }

    const allowedServices = parseCsv(config['ANTSEED_ALLOWED_SERVICES']);
    const authFilePath = expandHome(config['OPENAI_RESPONSES_AUTH_FILE']?.trim() || DEFAULT_AUTH_FILE);
    const baseUrl = config['OPENAI_RESPONSES_BASE_URL']?.trim() || DEFAULT_BASE_URL;
    const serviceRewriteMap = parseServiceAliasMap(config['ANTSEED_SERVICE_ALIAS_MAP_JSON']);
    const serviceApiProtocols = buildServiceApiProtocols(allowedServices, 'openai-responses');

    return new CodexResponsesProvider({
      name: 'openai-responses',
      services: allowedServices,
      pricing,
      ...(serviceApiProtocols ? { serviceApiProtocols } : {}),
      maxConcurrency,
      authFilePath,
      baseUrl,
      ...(serviceRewriteMap ? { serviceRewriteMap } : {}),
    });
  },
};

export default plugin;

export type { AuthContext };
export {
  buildModelsResponse,
  decodeJwtPayload,
  expandHome,
  getJwtExpiration,
  isAuthExpiringSoon,
  readAuthContext,
  refreshAuthContext,
  writeAuthContext,
};
