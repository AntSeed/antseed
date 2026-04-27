import type {
  AntseedProviderPlugin,
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ServiceApiProtocol,
} from '@antseed/node';
import {
  buildServiceApiProtocols,
  parseCsv,
  parseNonNegativeNumber,
  parseServiceAliasMap,
  parseServicePricingJson,
} from '@antseed/provider-core';

type StudioIntent = 'image-edit' | 'image-generate' | 'video-generate';

type StudioRunReference = {
  base64?: string;
  mimeType?: string;
  name?: string;
  url?: string;
};

type StudioRunRequestBody = {
  model?: unknown;
  service?: unknown;
  intent?: unknown;
  prompt?: unknown;
  references?: unknown;
  options?: unknown;
};

type StudioRunOutput = {
  url: string;
  kind: 'image' | 'video';
};

type StudioRunResponse = {
  id: string;
  status: string;
  outputs: StudioRunOutput[];
  meta?: Record<string, unknown>;
};

type MuPredictionResponse = {
  id?: unknown;
  request_id?: unknown;
  prediction_id?: unknown;
  status?: unknown;
  outputs?: unknown;
  url?: unknown;
  output?: unknown;
};

const DEFAULT_BASE_URL = 'https://api.muapi.ai';
const DEFAULT_INPUT_PRICE = 10;
const DEFAULT_OUTPUT_PRICE = 10;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_IMAGE_POLL_ATTEMPTS = 60;
const DEFAULT_VIDEO_POLL_ATTEMPTS = 900;

const STUDIO_ENDPOINT_PATH = '/v1/studio/run';
const URL_REGEX = /https?:\/\/[^\s<>"'`]+/g;

function parsePositiveInteger(raw: string | undefined, key: string, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeIntent(value: unknown): StudioIntent | null {
  const normalized = stringOrNull(value)?.toLowerCase();
  if (normalized === 'image-edit' || normalized === 'image-generate' || normalized === 'video-generate') {
    return normalized;
  }
  return null;
}

function normalizeServiceId(value: unknown): string | null {
  return stringOrNull(value);
}

function parseRequestJson(request: SerializedHttpRequest): StudioRunRequestBody {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(request.body)) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      throw new Error('Request body must be a JSON object');
    }
    return record;
  } catch (error) {
    throw new StudioProviderError(
      400,
      'invalid_json',
      'invalid_request_body',
      `Request body must be valid JSON: ${(error as Error).message}`,
    );
  }
}

function parseReferences(raw: unknown): StudioRunReference[] {
  if (!Array.isArray(raw)) return [];
  const references: StudioRunReference[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const base64 = entry.trim();
      if (base64.length > 0) {
        references.push({ base64 });
      }
      continue;
    }
    const record = asRecord(entry);
    if (!record) continue;
    const base64 = stringOrNull(record.base64);
    const mimeType = stringOrNull(record.mimeType) ?? undefined;
    const name = stringOrNull(record.name) ?? undefined;
    const url = stringOrNull(record.url) ?? undefined;
    if (base64 || url) {
      references.push({ ...(base64 ? { base64 } : {}), ...(mimeType ? { mimeType } : {}), ...(name ? { name } : {}), ...(url ? { url } : {}) });
    }
  }
  return references;
}

function normalizeOptions(raw: unknown): Record<string, unknown> {
  const record = asRecord(raw);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => (
      value !== undefined
      && typeof value !== 'function'
      && typeof value !== 'symbol'
    )),
  );
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function extensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('bmp')) return 'bmp';
  if (normalized.includes('svg')) return 'svg';
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('quicktime') || normalized.includes('mov')) return 'mov';
  return 'bin';
}

function decodeReferenceBase64(reference: StudioRunReference): { buffer: Buffer; mimeType: string; fileName: string } {
  const base64Raw = reference.base64?.trim();
  if (!base64Raw) {
    throw new StudioProviderError(400, 'invalid_reference', 'reference_missing_base64', 'Reference is missing base64 payload');
  }

  const dataUriMatch = base64Raw.match(/^data:([^;]+);base64,(.+)$/i);
  let mimeType = reference.mimeType?.trim() || 'application/octet-stream';
  let base64Data = base64Raw;
  if (dataUriMatch) {
    mimeType = dataUriMatch[1]?.trim() || mimeType;
    base64Data = dataUriMatch[2] ?? '';
  }

  if (!base64Data) {
    throw new StudioProviderError(400, 'invalid_reference', 'reference_invalid_base64', 'Reference base64 payload is empty');
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64Data, 'base64');
  } catch {
    throw new StudioProviderError(400, 'invalid_reference', 'reference_invalid_base64', 'Reference base64 payload could not be decoded');
  }

  if (buffer.length === 0) {
    throw new StudioProviderError(400, 'invalid_reference', 'reference_empty_file', 'Reference payload decoded to an empty file');
  }

  const ext = extensionFromMimeType(mimeType);
  const fallbackName = `reference.${ext}`;
  const fileName = reference.name?.trim() || fallbackName;
  return { buffer, mimeType, fileName };
}

function classifyOutputKind(url: string): 'image' | 'video' {
  const clean = url.split('?')[0]?.toLowerCase() || url.toLowerCase();
  if (/\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(clean) || /(video|movie|motion|animation)/i.test(clean)) {
    return 'video';
  }
  return 'image';
}

function extractUrlsFromUnknown(value: unknown): string[] {
  if (typeof value === 'string') {
    return (value.match(URL_REGEX) ?? []).map((entry) => entry.replace(/[),.;]+$/, ''));
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractUrlsFromUnknown(entry));
  }
  const record = asRecord(value);
  if (!record) return [];
  return Object.values(record).flatMap((entry) => extractUrlsFromUnknown(entry));
}

function uniqueUrls(urls: string[]): string[] {
  const deduped = new Set<string>();
  for (const url of urls) {
    if (!isHttpUrl(url)) continue;
    deduped.add(url);
  }
  return [...deduped];
}

function buildStudioOutputResponse(result: MuPredictionResponse, endpoint: string): StudioRunResponse {
  const id = stringOrNull(result.request_id) ?? stringOrNull(result.id) ?? stringOrNull(result.prediction_id) ?? `run-${Date.now()}`;
  const status = stringOrNull(result.status) ?? 'completed';
  const outputCandidates = uniqueUrls([
    ...extractUrlsFromUnknown(result.outputs),
    ...extractUrlsFromUnknown(result.url),
    ...extractUrlsFromUnknown(result.output),
  ]);

  if (outputCandidates.length === 0) {
    throw new StudioProviderError(
      502,
      'missing_outputs',
      'studio_missing_outputs',
      'Upstream run finished without any media output URLs',
    );
  }

  return {
    id,
    status,
    outputs: outputCandidates.map((url) => ({ url, kind: classifyOutputKind(url) })),
    meta: { endpoint },
  };
}

function toJsonBody(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function makeErrorResponse(
  requestId: string,
  statusCode: number,
  type: string,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): SerializedHttpResponse {
  return {
    requestId,
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: toJsonBody({
      error: {
        type,
        code,
        message,
        ...(details ? { details } : {}),
      },
    }),
  };
}

function makeSuccessResponse(requestId: string, payload: StudioRunResponse): SerializedHttpResponse {
  return {
    requestId,
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: toJsonBody(payload),
  };
}

class StudioProviderError extends Error {
  readonly statusCode: number;
  readonly type: string;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    type: string,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StudioProviderError';
    this.statusCode = statusCode;
    this.type = type;
    this.code = code;
    this.details = details;
  }
}

class OpenGenerativeAiProvider implements Provider {
  readonly name = 'open-generative-ai';
  readonly services: string[];
  readonly pricing: Provider['pricing'];
  readonly serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
  readonly maxConcurrency: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly serviceRewriteMap?: Record<string, string>;
  private readonly pollIntervalMs: number;
  private readonly imagePollAttempts: number;
  private readonly videoPollAttempts: number;
  private activeCount = 0;

  constructor(config: {
    apiKey: string;
    baseUrl: string;
    services: string[];
    pricing: Provider['pricing'];
    serviceApiProtocols?: Record<string, ServiceApiProtocol[]>;
    serviceRewriteMap?: Record<string, string>;
    maxConcurrency: number;
    pollIntervalMs: number;
    imagePollAttempts: number;
    videoPollAttempts: number;
  }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.services = config.services;
    this.pricing = config.pricing;
    this.serviceApiProtocols = config.serviceApiProtocols;
    this.serviceRewriteMap = config.serviceRewriteMap;
    this.maxConcurrency = config.maxConcurrency;
    this.pollIntervalMs = config.pollIntervalMs;
    this.imagePollAttempts = config.imagePollAttempts;
    this.videoPollAttempts = config.videoPollAttempts;
  }

  getCapacity(): { current: number; max: number } {
    return { current: this.activeCount, max: this.maxConcurrency };
  }

  async handleRequest(request: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    if (request.path !== STUDIO_ENDPOINT_PATH) {
      return makeErrorResponse(
        request.requestId,
        404,
        'not_found',
        'studio_endpoint_not_supported',
        `Unsupported path "${request.path}". This provider only supports ${STUDIO_ENDPOINT_PATH}.`,
      );
    }
    if (request.method !== 'POST') {
      return makeErrorResponse(
        request.requestId,
        405,
        'invalid_method',
        'method_not_allowed',
        `Method ${request.method} is not supported for ${STUDIO_ENDPOINT_PATH}. Use POST.`,
      );
    }
    if (this.activeCount >= this.maxConcurrency) {
      return makeErrorResponse(
        request.requestId,
        429,
        'rate_limit',
        'max_concurrency_reached',
        `Max concurrency reached (${String(this.maxConcurrency)}).`,
      );
    }

    this.activeCount += 1;
    try {
      const payload = await this.runStudioRequest(request);
      return makeSuccessResponse(request.requestId, payload);
    } catch (error) {
      if (error instanceof StudioProviderError) {
        return makeErrorResponse(
          request.requestId,
          error.statusCode,
          error.type,
          error.code,
          error.message,
          error.details,
        );
      }
      return makeErrorResponse(
        request.requestId,
        502,
        'upstream_error',
        'studio_upstream_failure',
        (error as Error)?.message || 'Unexpected Studio upstream error',
      );
    } finally {
      this.activeCount -= 1;
    }
  }

  private isAllowedService(serviceId: string): boolean {
    const normalized = serviceId.trim().toLowerCase();
    return this.services.some((service) => service.trim().toLowerCase() === normalized);
  }

  private resolveEndpoint(serviceId: string): string {
    const rewritten = this.serviceRewriteMap?.[serviceId.trim().toLowerCase()];
    return (rewritten || serviceId).trim().replace(/^\/+/, '');
  }

  private async runStudioRequest(request: SerializedHttpRequest): Promise<StudioRunResponse> {
    const body = parseRequestJson(request);
    const serviceId = normalizeServiceId(body.model) ?? normalizeServiceId(body.service);
    if (!serviceId) {
      throw new StudioProviderError(400, 'invalid_request', 'missing_model', 'Studio request must include a non-empty "model" field');
    }
    if (!this.isAllowedService(serviceId)) {
      throw new StudioProviderError(
        403,
        'forbidden',
        'service_not_allowed',
        `Service "${serviceId}" is not allowed by this provider`,
      );
    }

    const intent = normalizeIntent(body.intent);
    if (!intent) {
      throw new StudioProviderError(
        400,
        'invalid_request',
        'invalid_intent',
        'Studio request intent must be one of: image-edit, image-generate, video-generate',
      );
    }

    const prompt = stringOrNull(body.prompt) ?? '';
    const references = parseReferences(body.references);
    if (intent === 'image-edit' && references.length === 0) {
      throw new StudioProviderError(
        400,
        'invalid_request',
        'missing_references',
        'image-edit intent requires at least one reference image',
      );
    }

    const uploadedReferenceUrls = await this.uploadReferences(references);
    const endpoint = this.resolveEndpoint(serviceId);
    const upstreamPayload = this.buildUpstreamPayload(intent, prompt, uploadedReferenceUrls, normalizeOptions(body.options));
    const rawResult = await this.submitAndPoll(endpoint, upstreamPayload, intent);
    return buildStudioOutputResponse(rawResult, endpoint);
  }

  private buildUpstreamPayload(
    intent: StudioIntent,
    prompt: string,
    referenceUrls: string[],
    options: Record<string, unknown>,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    if (prompt.length > 0) {
      payload.prompt = prompt;
    }
    if (referenceUrls.length === 1) {
      payload.image_url = referenceUrls[0];
    } else if (referenceUrls.length > 1) {
      payload.images_list = referenceUrls;
      payload.image_url = referenceUrls[0];
    }

    // Keep this field explicit for upstreams that support intent-style tuning.
    payload.intent = intent;

    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) continue;
      payload[key] = value;
    }
    return payload;
  }

  private async uploadReferences(references: StudioRunReference[]): Promise<string[]> {
    const urls: string[] = [];
    for (const [index, reference] of references.entries()) {
      if (reference.url && isHttpUrl(reference.url)) {
        urls.push(reference.url);
        continue;
      }
      const { buffer, mimeType, fileName } = decodeReferenceBase64(reference);
      const formData = new FormData();
      formData.append('file', new Blob([buffer], { type: mimeType }), fileName || `reference-${String(index + 1)}`);
      const response = await fetch(`${this.baseUrl}/api/v1/upload_file`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
        },
        body: formData,
      });
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new StudioProviderError(
          502,
          'upstream_error',
          'reference_upload_failed',
          `Reference upload failed (${response.status}): ${bodyText.slice(0, 180)}`,
        );
      }
      const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
      const url = stringOrNull(parsed.url)
        ?? stringOrNull(parsed.file_url)
        ?? stringOrNull(asRecord(parsed.data)?.url);
      if (!url || !isHttpUrl(url)) {
        throw new StudioProviderError(
          502,
          'upstream_error',
          'reference_upload_missing_url',
          'Reference upload succeeded but no output URL was returned',
        );
      }
      urls.push(url);
    }
    return urls;
  }

  private async submitAndPoll(
    endpoint: string,
    payload: Record<string, unknown>,
    intent: StudioIntent,
  ): Promise<MuPredictionResponse> {
    const submitResponse = await fetch(`${this.baseUrl}/api/v1/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(payload),
    });
    if (!submitResponse.ok) {
      const text = await submitResponse.text().catch(() => '');
      throw new StudioProviderError(
        502,
        'upstream_error',
        'studio_submit_failed',
        `Studio submit failed (${submitResponse.status}): ${text.slice(0, 180)}`,
      );
    }

    const submitData = await submitResponse.json().catch(() => ({})) as MuPredictionResponse;
    const requestId = stringOrNull(submitData.request_id) ?? stringOrNull(submitData.id) ?? stringOrNull(submitData.prediction_id);
    if (!requestId) {
      return submitData;
    }

    const maxAttempts = intent === 'video-generate' ? this.videoPollAttempts : this.imagePollAttempts;
    const pollUrl = `${this.baseUrl}/api/v1/predictions/${requestId}/result`;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      const pollResponse = await fetch(pollUrl, {
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
        },
      });

      if (!pollResponse.ok) {
        if (pollResponse.status >= 500 && attempt < maxAttempts) {
          continue;
        }
        const text = await pollResponse.text().catch(() => '');
        throw new StudioProviderError(
          502,
          'upstream_error',
          'studio_poll_failed',
          `Studio polling failed (${pollResponse.status}): ${text.slice(0, 180)}`,
        );
      }

      const pollData = await pollResponse.json().catch(() => ({})) as MuPredictionResponse;
      const status = stringOrNull(pollData.status)?.toLowerCase();
      if (!status || status === 'queued' || status === 'running' || status === 'processing' || status === 'pending') {
        continue;
      }
      if (status === 'completed' || status === 'succeeded' || status === 'success') {
        return pollData;
      }
      if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
        throw new StudioProviderError(
          502,
          'upstream_error',
          'studio_prediction_failed',
          `Studio prediction failed with status "${status}"`,
          { upstream: asRecord(pollData) ?? {} },
        );
      }
    }

    throw new StudioProviderError(
      504,
      'timeout',
      'studio_prediction_timeout',
      `Studio prediction timed out after ${String(maxAttempts)} polling attempts`,
    );
  }
}

const plugin: AntseedProviderPlugin = {
  name: 'open-generative-ai',
  displayName: 'Open Generative AI',
  version: '0.1.0',
  type: 'provider',
  description: 'Studio media provider adapter for Open-Generative-AI / MuAPI-style async generation APIs',
  configSchema: [
    { key: 'OPENAI_API_KEY', label: 'API Key', type: 'secret', required: false, description: 'Upstream API key (fallback key name)' },
    { key: 'OPEN_GENERATIVE_AI_API_KEY', label: 'Open Generative AI API Key', type: 'secret', required: false, description: 'Upstream API key (preferred key name)' },
    { key: 'OPENAI_BASE_URL', label: 'Base URL', type: 'string', required: false, default: DEFAULT_BASE_URL, description: 'Upstream API base URL (fallback key name)' },
    { key: 'OPEN_GENERATIVE_AI_BASE_URL', label: 'Open Generative AI Base URL', type: 'string', required: false, default: DEFAULT_BASE_URL, description: 'Upstream API base URL (preferred key name)' },
    { key: 'OPEN_GENERATIVE_AI_POLL_INTERVAL_MS', label: 'Poll Interval (ms)', type: 'number', required: false, default: DEFAULT_POLL_INTERVAL_MS, description: 'Polling interval for prediction results' },
    { key: 'OPEN_GENERATIVE_AI_MAX_POLL_ATTEMPTS_IMAGE', label: 'Max Image Poll Attempts', type: 'number', required: false, default: DEFAULT_IMAGE_POLL_ATTEMPTS, description: 'Max polling attempts for image intents' },
    { key: 'OPEN_GENERATIVE_AI_MAX_POLL_ATTEMPTS_VIDEO', label: 'Max Video Poll Attempts', type: 'number', required: false, default: DEFAULT_VIDEO_POLL_ATTEMPTS, description: 'Max polling attempts for video intents' },
    { key: 'ANTSEED_INPUT_USD_PER_MILLION', label: 'Input Price', type: 'number', required: false, default: DEFAULT_INPUT_PRICE, description: 'Input price in USD per 1M tokens' },
    { key: 'ANTSEED_OUTPUT_USD_PER_MILLION', label: 'Output Price', type: 'number', required: false, default: DEFAULT_OUTPUT_PRICE, description: 'Output price in USD per 1M tokens' },
    { key: 'ANTSEED_CACHED_INPUT_USD_PER_MILLION', label: 'Cached Input Price', type: 'number', required: false, description: 'Cached input price in USD per 1M tokens (defaults to input price)' },
    { key: 'ANTSEED_SERVICE_PRICING_JSON', label: 'Service Pricing JSON', type: 'string', required: false, description: 'Per-service pricing JSON' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: DEFAULT_MAX_CONCURRENCY, description: 'Max concurrent Studio runs' },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Allowed Services', type: 'string[]', required: false, description: 'Service allow-list' },
    { key: 'ANTSEED_SERVICE_ALIAS_MAP_JSON', label: 'Service Alias Map', type: 'string', required: false, description: 'JSON map of announced service -> upstream endpoint/model key' },
  ],
  createProvider(config: Record<string, string>): Provider {
    const apiKey = stringOrNull(config.OPEN_GENERATIVE_AI_API_KEY) ?? stringOrNull(config.OPENAI_API_KEY);
    if (!apiKey) {
      throw new Error('OPEN_GENERATIVE_AI_API_KEY or OPENAI_API_KEY is required');
    }

    const services = parseCsv(config.ANTSEED_ALLOWED_SERVICES);
    if (services.length === 0) {
      throw new Error('ANTSEED_ALLOWED_SERVICES is required');
    }

    const servicePricing = parseServicePricingJson(config.ANTSEED_SERVICE_PRICING_JSON);
    const pricing: Provider['pricing'] = {
      defaults: {
        inputUsdPerMillion: parseNonNegativeNumber(config.ANTSEED_INPUT_USD_PER_MILLION, 'ANTSEED_INPUT_USD_PER_MILLION', DEFAULT_INPUT_PRICE),
        outputUsdPerMillion: parseNonNegativeNumber(config.ANTSEED_OUTPUT_USD_PER_MILLION, 'ANTSEED_OUTPUT_USD_PER_MILLION', DEFAULT_OUTPUT_PRICE),
        ...(config.ANTSEED_CACHED_INPUT_USD_PER_MILLION
          ? { cachedInputUsdPerMillion: parseNonNegativeNumber(config.ANTSEED_CACHED_INPUT_USD_PER_MILLION, 'ANTSEED_CACHED_INPUT_USD_PER_MILLION', 0) }
          : {}),
      },
      ...(servicePricing ? { services: servicePricing } : {}),
    };

    const serviceApiProtocols = buildServiceApiProtocols(services, 'openai-chat-completions');
    const serviceRewriteMap = parseServiceAliasMap(config.ANTSEED_SERVICE_ALIAS_MAP_JSON);
    const maxConcurrency = parsePositiveInteger(config.ANTSEED_MAX_CONCURRENCY, 'ANTSEED_MAX_CONCURRENCY', DEFAULT_MAX_CONCURRENCY);
    const pollIntervalMs = parsePositiveInteger(config.OPEN_GENERATIVE_AI_POLL_INTERVAL_MS, 'OPEN_GENERATIVE_AI_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS);
    const imagePollAttempts = parsePositiveInteger(
      config.OPEN_GENERATIVE_AI_MAX_POLL_ATTEMPTS_IMAGE,
      'OPEN_GENERATIVE_AI_MAX_POLL_ATTEMPTS_IMAGE',
      DEFAULT_IMAGE_POLL_ATTEMPTS,
    );
    const videoPollAttempts = parsePositiveInteger(
      config.OPEN_GENERATIVE_AI_MAX_POLL_ATTEMPTS_VIDEO,
      'OPEN_GENERATIVE_AI_MAX_POLL_ATTEMPTS_VIDEO',
      DEFAULT_VIDEO_POLL_ATTEMPTS,
    );
    const baseUrl = (stringOrNull(config.OPEN_GENERATIVE_AI_BASE_URL) ?? stringOrNull(config.OPENAI_BASE_URL) ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

    return new OpenGenerativeAiProvider({
      apiKey,
      baseUrl,
      services,
      pricing,
      serviceApiProtocols,
      serviceRewriteMap,
      maxConcurrency,
      pollIntervalMs,
      imagePollAttempts,
      videoPollAttempts,
    });
  },
};

export default plugin;
