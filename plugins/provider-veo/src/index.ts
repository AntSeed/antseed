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

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

const MODEL_PRESETS: Record<string, VideoCapabilities> = {
  'veo-3.1-generate-preview': veoCapabilities(),
  'veo-3.1-fast-generate-preview': veoCapabilities(),
};

function veoCapabilities(): VideoCapabilities {
  return {
    generationModes: ['text_to_video', 'image_to_video'],
    minDurationSeconds: 4,
    maxDurationSeconds: 8,
    allowedDurationsSeconds: [4, 6, 8],
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16'],
    generateAudio: true,
    outputFormats: ['mp4'],
    maxFirstFrameBytes: 20 * 1024 * 1024,
  };
}

const RESERVED_EXTENSION_KEYS = new Set([
  'durationSeconds',
  'aspectRatio',
  'resolution',
  'sampleCount',
  'generateAudio',
]);

class VeoVideoAdapter implements VideoProviderAdapter {
  readonly provider = 'veo';
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
    const errors: string[] = [];
    if (request.seed !== undefined) errors.push('seed is not supported by Veo through the Gemini Developer API');
    if (request.generate_audio === false) errors.push('Veo 3.1 always returns video with audio through the Gemini Developer API');
    errors.push(...reservedExtensionErrors(request.extensions?.veo, RESERVED_EXTENSION_KEYS, 'veo'));
    return errors;
  }

  async create(request: VideoGenerationRequest, context: VideoAdapterContext): Promise<ProviderVideoJob> {
    const instance: Record<string, unknown> = { prompt: request.prompt };
    if (context.firstFrame) {
      instance['image'] = {
        bytesBase64Encoded: Buffer.from(context.firstFrame).toString('base64'),
        mimeType: context.firstFrameMimeType ?? 'image/jpeg',
      };
    }
    const parameters: Record<string, unknown> = {
      durationSeconds: request.duration_seconds,
      aspectRatio: request.aspect_ratio ?? '16:9',
      resolution: request.resolution ?? '720p',
      ...safeExtensions(request.extensions?.veo, RESERVED_EXTENSION_KEYS),
    };
    const response = await this.request(
      `/v1beta/models/${encodeURIComponent(request.model)}:predictLongRunning`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instances: [instance], parameters }) },
      false,
      [request.prompt],
    );
    const body = await responseJson(response);
    const name = stringField(body, 'name');
    if (!name) throw providerError('veo_create_invalid', 'Gemini did not return an operation name');
    return { id: name, status: 'queued', nativeStatus: 'OPERATION_PENDING', retryAfterMs: retryAfterMs(response) };
  }

  async getStatus(jobId: string): Promise<ProviderVideoStatus> {
    const response = await this.request(operationPath(jobId));
    const body = await responseJson(response);
    if (body['done'] !== true) {
      return { id: jobId, status: 'in_progress', nativeStatus: 'OPERATION_RUNNING', retryAfterMs: retryAfterMs(response) };
    }
    const apiError = recordField(body, 'error');
    if (apiError) {
      return {
        id: jobId,
        status: 'failed',
        nativeStatus: 'OPERATION_FAILED',
        error: {
          code: typeof apiError['status'] === 'string' ? apiError['status'] : 'veo_failed',
          message: redactedMessage(apiError, 'Veo generation failed', [this.apiKey]),
          retryable: false,
        },
      };
    }
    const responseBody = recordField(body, 'response') ?? {};
    const artifacts = extractVideoArtifacts(responseBody);
    for (const artifact of artifacts) this.artifactUrl(artifact.locator);
    if (artifacts.length === 0) {
      return {
        id: jobId,
        status: 'failed',
        nativeStatus: 'OPERATION_DONE_NO_VIDEO',
        error: { code: 'veo_missing_artifact', message: 'Veo completed without a generated video', retryable: false },
      };
    }
    return { id: jobId, status: 'succeeded', nativeStatus: 'OPERATION_SUCCEEDED', progress: 100, artifacts };
  }

  async cancel(jobId: string): Promise<ProviderVideoCancelResult> {
    const response = await this.request(`${operationPath(jobId)}:cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, true);
    return { accepted: response.ok || response.status === 404, status: response.ok || response.status === 404 ? 'canceled' : 'in_progress' };
  }

  async openArtifact(artifact: ProviderVideoArtifact): Promise<ReadableStream<Uint8Array>> {
    const response = await fetchArtifact(this.artifactUrl(artifact.locator), this.baseUrl);
    if (!response.ok || !response.body) throw providerError('veo_artifact_failed', `Gemini video download failed (${response.status})`);
    return response.body;
  }

  private url(path: string): string {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set('key', this.apiKey);
    return url.toString();
  }

  private artifactUrl(locator: string): string {
    const base = new URL(this.baseUrl);
    if (/^https?:/i.test(locator)) {
      const url = new URL(locator);
      if (url.origin !== base.origin) throw providerError('veo_artifact_invalid', 'Gemini returned an artifact URL from an unexpected origin');
      assertSafeArtifactUrl(url.toString(), this.baseUrl);
      url.searchParams.set('alt', 'media');
      url.searchParams.set('key', this.apiKey);
      return url.toString();
    }
    const normalized = locator.replace(/^\/+/, '').replace(/^v1beta\//, '');
    const match = /^files\/([^/?#:]+)(?::download)?$/.exec(normalized);
    if (!match) throw providerError('veo_artifact_invalid', 'Gemini returned an invalid Files API artifact name');
    const url = new URL(`/v1beta/files/${match[1]}:download`, this.baseUrl);
    url.searchParams.set('alt', 'media');
    url.searchParams.set('key', this.apiKey);
    return url.toString();
  }

  private async request(path: string, init: RequestInit = {}, allowError = false, sensitiveValues: string[] = []): Promise<Response> {
    const response = await fetch(this.url(path), { ...init, signal: init.signal ?? AbortSignal.timeout(60_000) });
    if (!allowError && !response.ok) {
      const body = await safeJson(response);
      const nested = body ? recordField(body, 'error') : null;
      throw providerError(`veo_http_${response.status}`, redactedMessage(nested ?? body, `Gemini request failed (${response.status})`, [this.apiKey, ...sensitiveValues]));
    }
    return response;
  }
}

const plugin: AntseedProviderPlugin = {
  name: 'veo',
  displayName: 'Google Veo',
  version: '0.1.0-beta.0',
  type: 'provider',
  description: 'Provide Veo 3.1 video generation through the Gemini Developer API',
  configSchema: [
    { key: 'GEMINI_API_KEY', label: 'Gemini API Key', type: 'secret', required: true },
    { key: 'GEMINI_BASE_URL', label: 'Gemini Base URL', type: 'string', default: DEFAULT_BASE_URL },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Models', type: 'string[]', required: true },
    { key: 'ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON', label: 'Video Pricing JSON', type: 'string', required: true },
    { key: 'ANTSEED_VIDEO_UPFRONT_BPS', label: 'Upfront Basis Points', type: 'number', default: 5000 },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', default: 2 },
  ],
  createProvider(config): Provider {
    const apiKey = required(config, 'GEMINI_API_KEY');
    const services = parseModels(config['ANTSEED_ALLOWED_SERVICES'], Object.keys(MODEL_PRESETS));
    for (const model of services) if (!MODEL_PRESETS[model]) throw new Error(`Veo model "${model}" is not covered by a tested Veo 3.1 preset`);
    const upfrontBps = parseBps(config['ANTSEED_VIDEO_UPFRONT_BPS']);
    const maxConcurrency = parsePositiveInteger(config['ANTSEED_MAX_CONCURRENCY'], 2);
    const serviceUnitBillingModels = parseBilling(config['ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON'], services);
    const adapter = new VeoVideoAdapter(apiKey, config['GEMINI_BASE_URL'] || DEFAULT_BASE_URL, services, upfrontBps);
    const serviceCapabilities = Object.fromEntries(services.map((model) => [model, videoServiceCapabilities(adapter.getCapabilities(model)!)]));
    return videoProvider(services, maxConcurrency, serviceUnitBillingModels, serviceCapabilities, adapter);
  },
};

export default plugin;
export { VeoVideoAdapter, MODEL_PRESETS as VEO_MODEL_PRESETS };

function videoProvider(
  services: string[],
  maxConcurrency: number,
  serviceUnitBillingModels: ServiceUnitBillingModelsV1,
  serviceCapabilities: Record<string, ServiceCapabilities>,
  videoAdapter: VideoProviderAdapter,
): Provider {
  return {
    name: 'veo',
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
    inputs: ['text', 'image'],
    outputs: ['video'],
    supportedParameters: ['duration_seconds', 'aspect_ratio', 'resolution', 'generate_audio', 'output_format', 'seed'],
    video,
  };
}

function extractVideoArtifacts(value: Record<string, unknown>): ProviderVideoArtifact[] {
  const candidates = [
    ...arrayField(recordField(value, 'generateVideoResponse') ?? {}, 'generatedSamples'),
    ...arrayField(value, 'generatedVideos'),
    ...arrayField(value, 'videos'),
  ];
  const artifacts: ProviderVideoArtifact[] = [];
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const video = recordField(record, 'video') ?? record;
    const locator = stringField(video, 'uri') ?? stringField(video, 'name');
    if (locator) artifacts.push({
      providerArtifactId: stringField(video, 'name') ?? `video:${index}`,
      locator,
      mimeType: stringField(video, 'mimeType') ?? stringField(video, 'encoding') ?? 'video/mp4',
      hasAudio: true,
    });
  }
  return artifacts;
}

function operationPath(jobId: string): string {
  const normalized = jobId.replace(/^\/+/, '');
  return normalized.startsWith('v1beta/') ? `/${normalized}` : `/v1beta/${normalized}`;
}

function parseBilling(value: string | undefined, services: string[]): ServiceUnitBillingModelsV1 {
  if (!value) throw new Error('ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON is required');
  const parsed = JSON.parse(value) as ServiceUnitBillingModelsV1;
  for (const service of services) {
    const model = parsed[service]?.['antseed-video-jobs-v1'];
    if (!model || model.version !== 1 || !Array.isArray(model.components)) throw new Error(`Missing antseed-video-jobs-v1 billing model for ${service}`);
  }
  return parsed;
}

function parseModels(value: string | undefined, fallback: string[]): string[] {
  return [...new Set(value?.split(',').map((item) => item.trim()).filter(Boolean) ?? fallback)];
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

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const child = value[key];
  return child && typeof child === 'object' && !Array.isArray(child) ? child as Record<string, unknown> : null;
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  const child = value[key];
  return Array.isArray(child) ? child : [];
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' && value[key] ? value[key] : undefined;
}

function redactedMessage(value: Record<string, unknown> | null, fallback: string, sensitiveValues: string[] = []): string {
  if (!value) return fallback;
  for (const key of ['message', 'status', 'detail']) {
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

function assertSafeArtifactUrl(locator: string, baseUrl: string): void {
  let url: URL;
  let base: URL;
  try {
    url = new URL(locator);
    base = new URL(baseUrl);
  } catch {
    throw providerError('veo_artifact_invalid', 'Gemini returned an invalid artifact URL');
  }
  const sameOrigin = url.origin === base.origin;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && base.protocol === 'http:' && sameOrigin)) {
    throw providerError('veo_artifact_invalid', 'Gemini returned an insecure artifact URL');
  }
}

async function fetchArtifact(locator: string, baseUrl: string): Promise<Response> {
  let url = locator;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    assertSafeArtifactUrl(url, baseUrl);
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    url = new URL(location, url).toString();
  }
  throw providerError('veo_artifact_redirects', 'Gemini artifact download exceeded the redirect limit');
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

function providerError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}
