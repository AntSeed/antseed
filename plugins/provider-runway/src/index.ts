import type {
  AntseedProviderPlugin,
  Provider,
  ProviderVideoArtifact,
  ProviderVideoCancelResult,
  ProviderVideoJob,
  ProviderVideoStatus,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ServiceCapabilities,
  ServiceUnitBillingModelsV1,
  VideoAdapterContext,
  VideoCapabilities,
  VideoGenerationRequest,
  VideoProviderAdapter,
} from '@antseed/node';

const DEFAULT_BASE_URL = 'https://api.dev.runwayml.com';
const API_VERSION = '2024-11-06';

const MODEL_PRESETS: Record<string, VideoCapabilities> = {
  'gen4.5': {
    generationModes: ['text_to_video', 'image_to_video'],
    minDurationSeconds: 2,
    maxDurationSeconds: 10,
    resolutions: ['720p'],
    aspectRatios: ['16:9', '9:16'],
    generateAudio: false,
    outputFormats: ['mp4'],
    maxFirstFrameBytes: 3_900_000,
  },
  gen4_turbo: {
    generationModes: ['image_to_video'],
    minDurationSeconds: 2,
    maxDurationSeconds: 10,
    resolutions: ['720p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    generateAudio: false,
    outputFormats: ['mp4'],
    maxFirstFrameBytes: 3_900_000,
  },
};

const RUNWAY_RATIOS: Record<string, string> = {
  '16:9': '1280:720',
  '9:16': '720:1280',
  '1:1': '960:960',
  '4:3': '1104:832',
  '3:4': '832:1104',
  '21:9': '1584:672',
};

const RESERVED_EXTENSION_KEYS = new Set([
  'model',
  'promptText',
  'promptImage',
  'duration',
  'ratio',
  'seed',
  'outputFormat',
]);

class RunwayVideoAdapter implements VideoProviderAdapter {
  readonly provider = 'runway';
  readonly supportedModels: readonly string[];

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    models: string[],
    private readonly upfrontBps: number,
  ) {
    this.supportedModels = models;
  }

  getCapabilities(model: string): VideoCapabilities | undefined {
    const preset = MODEL_PRESETS[model];
    return preset ? { ...preset, upfrontBps: this.upfrontBps } : undefined;
  }

  validateRequest(request: VideoGenerationRequest): string[] {
    return reservedExtensionErrors(request.extensions?.runway, RESERVED_EXTENSION_KEYS, 'runway');
  }

  async create(request: VideoGenerationRequest, context: VideoAdapterContext): Promise<ProviderVideoJob> {
    const promptImage = context.firstFrame
      ? `data:${context.firstFrameMimeType ?? 'image/jpeg'};base64,${Buffer.from(context.firstFrame).toString('base64')}`
      : undefined;
    const endpoint = promptImage ? '/v1/image_to_video' : '/v1/text_to_video';
    const payload: Record<string, unknown> = {
      model: request.model,
      promptText: request.prompt,
      duration: request.duration_seconds,
      ratio: RUNWAY_RATIOS[request.aspect_ratio ?? '16:9'] ?? request.aspect_ratio,
      ...(promptImage ? { promptImage } : {}),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      outputFormat: request.output_format ?? 'mp4',
      ...safeExtensions(request.extensions?.runway, RESERVED_EXTENSION_KEYS),
    };
    const response = await this.request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': context.idempotencyKey },
      body: JSON.stringify(payload),
    }, false, [request.prompt]);
    const body = await responseJson(response);
    const id = stringField(body, 'id');
    if (!id) throw providerError('runway_create_invalid', 'Runway did not return a task ID');
    return { id, status: 'queued', nativeStatus: 'PENDING', retryAfterMs: retryAfterMs(response) };
  }

  async getStatus(jobId: string): Promise<ProviderVideoStatus> {
    const response = await this.request(`/v1/tasks/${encodeURIComponent(jobId)}`);
    const body = await responseJson(response);
    const nativeStatus = stringField(body, 'status')?.toUpperCase() ?? 'UNKNOWN';
    const status = mapRunwayStatus(nativeStatus);
    const outputs = Array.isArray(body['output']) ? body['output'] : [];
    const artifacts: ProviderVideoArtifact[] = outputs
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map((locator, index) => {
        assertSafeArtifactUrl(locator, this.baseUrl, false);
        return { providerArtifactId: `${jobId}:${index}`, locator, mimeType: 'video/mp4' };
      });
    const progressValue = typeof body['progress'] === 'number' ? body['progress'] : undefined;
    return {
      id: jobId,
      status,
      nativeStatus,
      ...(progressValue === undefined ? {} : { progress: Math.round(progressValue <= 1 ? progressValue * 100 : progressValue) }),
      ...(artifacts.length > 0 ? { artifacts } : {}),
      ...(status === 'failed' ? { error: normalizedProviderError(body, 'runway_failed', [this.apiKey]) } : {}),
      retryAfterMs: retryAfterMs(response),
    };
  }

  async cancel(jobId: string): Promise<ProviderVideoCancelResult> {
    const response = await this.request(`/v1/tasks/${encodeURIComponent(jobId)}`, { method: 'DELETE' }, true);
    return { accepted: response.ok || response.status === 404, status: response.ok || response.status === 404 ? 'canceled' : 'in_progress' };
  }

  async openArtifact(artifact: ProviderVideoArtifact): Promise<ReadableStream<Uint8Array>> {
    assertSafeArtifactUrl(artifact.locator, this.baseUrl, false);
    const response = await fetchArtifact(artifact.locator, this.baseUrl);
    if (!response.ok || !response.body) throw providerError('runway_artifact_failed', `Runway artifact download failed (${response.status})`);
    return response.body;
  }

  private async request(path: string, init: RequestInit = {}, allowError = false, sensitiveValues: string[] = []): Promise<Response> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'x-runway-version': API_VERSION,
        ...headersObject(init.headers),
      },
      signal: init.signal ?? AbortSignal.timeout(60_000),
    });
    if (!allowError && !response.ok) {
      const body = await safeJson(response);
      throw providerError(`runway_http_${response.status}`, redactedMessage(body, `Runway request failed (${response.status})`, [this.apiKey, ...sensitiveValues]));
    }
    return response;
  }
}

const plugin: AntseedProviderPlugin = {
  name: 'runway',
  displayName: 'Runway',
  version: '0.1.0-beta.0',
  type: 'provider',
  description: 'Provide Runway Gen-4-family video generation using an API key',
  configSchema: [
    { key: 'RUNWAY_API_KEY', label: 'Runway API Key', type: 'secret', required: true },
    { key: 'RUNWAY_BASE_URL', label: 'Runway Base URL', type: 'string', default: DEFAULT_BASE_URL },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Models', type: 'string[]', required: true },
    { key: 'ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON', label: 'Video Pricing JSON', type: 'string', required: true },
    { key: 'ANTSEED_VIDEO_UPFRONT_BPS', label: 'Upfront Basis Points', type: 'number', default: 5000 },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', default: 2 },
  ],
  createProvider(config): Provider {
    const apiKey = required(config, 'RUNWAY_API_KEY');
    const services = parseModels(config['ANTSEED_ALLOWED_SERVICES'], Object.keys(MODEL_PRESETS));
    validateModels(services, MODEL_PRESETS, 'Runway');
    const upfrontBps = parseBps(config['ANTSEED_VIDEO_UPFRONT_BPS']);
    const maxConcurrency = parsePositiveInteger(config['ANTSEED_MAX_CONCURRENCY'], 2);
    const serviceUnitBillingModels = parseBilling(config['ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON'], services);
    const adapter = new RunwayVideoAdapter(apiKey, config['RUNWAY_BASE_URL'] || DEFAULT_BASE_URL, services, upfrontBps);
    const serviceCapabilities = Object.fromEntries(services.map((model) => [model, videoServiceCapabilities(adapter.getCapabilities(model)!)]));
    return videoProvider('runway', services, maxConcurrency, serviceUnitBillingModels, serviceCapabilities, adapter);
  },
};

export default plugin;
export { RunwayVideoAdapter, MODEL_PRESETS as RUNWAY_MODEL_PRESETS };

function videoProvider(
  name: string,
  services: string[],
  maxConcurrency: number,
  serviceUnitBillingModels: ServiceUnitBillingModelsV1,
  serviceCapabilities: Record<string, ServiceCapabilities>,
  videoAdapter: VideoProviderAdapter,
): Provider {
  return {
    name,
    services,
    pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    serviceApiProtocols: Object.fromEntries(services.map((service) => [service, ['antseed-video-jobs-v1'] as const])),
    serviceUnitBillingModels,
    serviceCapabilities,
    maxConcurrency,
    videoAdapter,
    async handleRequest(_request: SerializedHttpRequest): Promise<SerializedHttpResponse> {
      throw new Error('Video requests must be handled by VideoGenerationController');
    },
    getCapacity: () => ({ current: 0, max: maxConcurrency }),
  };
}

function videoServiceCapabilities(video: VideoCapabilities): ServiceCapabilities {
  return {
    inputs: video.generationModes.includes('image_to_video') ? ['text', 'image'] : ['text'],
    outputs: ['video'],
    supportedParameters: ['duration_seconds', 'aspect_ratio', 'resolution', 'generate_audio', 'output_format', 'seed'],
    video,
  };
}

function parseBilling(value: string | undefined, services: string[]): ServiceUnitBillingModelsV1 {
  if (!value) throw new Error('ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON is required');
  const parsed = JSON.parse(value) as ServiceUnitBillingModelsV1;
  for (const service of services) {
    const model = parsed[service]?.['antseed-video-jobs-v1'];
    if (!model || model.version !== 1 || !Array.isArray(model.components)) {
      throw new Error(`Missing antseed-video-jobs-v1 billing model for ${service}`);
    }
  }
  return parsed;
}

function parseModels(value: string | undefined, fallback: string[]): string[] {
  const models = value?.split(',').map((item) => item.trim()).filter(Boolean) ?? fallback;
  return [...new Set(models)];
}

function validateModels(models: string[], presets: Record<string, VideoCapabilities>, provider: string): void {
  for (const model of models) if (!presets[model]) throw new Error(`${provider} model "${model}" is not covered by a tested preset`);
}

function parseBps(value: string | undefined): number {
  const parsed = Number(value ?? '5000');
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) throw new Error('ANTSEED_VIDEO_UPFRONT_BPS must be an integer from 0 through 10000');
  return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('ANTSEED_MAX_CONCURRENCY must be a positive integer');
  return parsed;
}

function required(config: Record<string, string>, key: string): string {
  const value = config[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function mapRunwayStatus(status: string): ProviderVideoStatus['status'] {
  if (status === 'PENDING' || status === 'THROTTLED') return 'queued';
  if (status === 'RUNNING') return 'in_progress';
  if (status === 'SUCCEEDED') return 'succeeded';
  if (status === 'CANCELLED' || status === 'CANCELED') return 'canceled';
  if (status === 'FAILED') return 'failed';
  return 'in_progress';
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await safeJson(response) ?? {};
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = await response.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' && value[key] ? value[key] : undefined;
}

function normalizedProviderError(value: Record<string, unknown>, code: string, sensitiveValues: string[] = []): { code: string; message: string; retryable: boolean } {
  return {
    code: stringField(value, 'failureCode') ?? code,
    message: redactedMessage(value, 'Runway generation failed', sensitiveValues),
    retryable: false,
  };
}

function redactedMessage(value: Record<string, unknown> | null, fallback: string, sensitiveValues: string[] = []): string {
  if (!value) return fallback;
  for (const key of ['failure', 'error', 'message', 'detail']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.length > 0) return redactSensitiveText(candidate, sensitiveValues);
  }
  return fallback;
}

function reservedExtensionErrors(
  extensions: Record<string, unknown> | undefined,
  reservedKeys: ReadonlySet<string>,
  namespace: string,
): string[] {
  if (!extensions) return [];
  return Object.keys(extensions)
    .filter((key) => reservedKeys.has(key))
    .map((key) => `extensions.${namespace}.${key} cannot override a canonical video field`);
}

function safeExtensions(
  extensions: Record<string, unknown> | undefined,
  reservedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(extensions ?? {}).filter(([key]) => !reservedKeys.has(key)));
}

function assertSafeArtifactUrl(locator: string, baseUrl: string, sameOriginOnly: boolean): void {
  let url: URL;
  let base: URL;
  try {
    url = new URL(locator);
    base = new URL(baseUrl);
  } catch {
    throw providerError('runway_artifact_invalid', 'Runway returned an invalid artifact URL');
  }
  const sameOrigin = url.origin === base.origin;
  if (sameOriginOnly && !sameOrigin) throw providerError('runway_artifact_invalid', 'Runway returned an artifact URL from an unexpected origin');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && base.protocol === 'http:' && sameOrigin)) {
    throw providerError('runway_artifact_invalid', 'Runway returned an insecure artifact URL');
  }
}

async function fetchArtifact(locator: string, baseUrl: string): Promise<Response> {
  let url = locator;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    assertSafeArtifactUrl(url, baseUrl, false);
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    url = new URL(location, url).toString();
  }
  throw providerError('runway_artifact_redirects', 'Runway artifact download exceeded the redirect limit');
}

function redactSensitiveText(value: string, sensitiveValues: string[]): string {
  let redacted = value.replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]');
  redacted = redacted.replace(/\b(api[_-]?key|token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) redacted = redacted.split(sensitiveValue).join('[redacted]');
  }
  return redacted.slice(0, 500);
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(30_000, seconds * 1000) : undefined;
}

function headersObject(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (headers) new Headers(headers).forEach((value, key) => { result[key] = value; });
  return result;
}

function providerError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}
