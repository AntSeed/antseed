import type { SerializedHttpRequest, SerializedHttpResponse } from './types.js';
import { extractRequestBodyFields, parseJsonObject } from './utils.js';

export type NativeVideoProtocol = 'runway-video' | 'veo-video';

export interface NativeVideoRoute {
  protocol: NativeVideoProtocol;
  provider: 'runway' | 'veo';
  action: 'create' | 'status' | 'cancel';
  resourceId?: string;
  model?: string;
}

const RESOURCE_SEGMENT = '[A-Za-z0-9_-]+';
const VEO_OPERATION = new RegExp(`^(?:models/[A-Za-z0-9._-]+/)?operations/${RESOURCE_SEGMENT}$`);

export function nativeVideoRoute(request: Pick<SerializedHttpRequest, 'path' | 'method'>): NativeVideoRoute | null {
  const path = request.path.split('?')[0] ?? '';
  if (request.method === 'POST' && ['/v1/text_to_video', '/v1/image_to_video'].includes(path)) {
    return { protocol: 'runway-video', provider: 'runway', action: 'create' };
  }
  const runway = new RegExp(`^/v1/tasks/(${RESOURCE_SEGMENT})$`).exec(path);
  if (runway && ['GET', 'DELETE'].includes(request.method)) {
    return { protocol: 'runway-video', provider: 'runway', action: request.method === 'GET' ? 'status' : 'cancel', resourceId: runway[1]! };
  }
  const veo = /^\/v1beta\/models\/([A-Za-z0-9._-]+):predictLongRunning$/.exec(path);
  if (veo && request.method === 'POST') {
    return { protocol: 'veo-video', provider: 'veo', action: 'create', model: veo[1]! };
  }
  const operation = path.replace(/^\/v1beta\//, '');
  if (path.startsWith('/v1beta/') && request.method === 'GET' && VEO_OPERATION.test(operation)) {
    return { protocol: 'veo-video', provider: 'veo', action: 'status', resourceId: operation };
  }
  return null;
}

export function nativeVideoAcceptance(protocol: NativeVideoProtocol, response: SerializedHttpResponse): string | null {
  if (response.statusCode < 200 || response.statusCode >= 300) return null;
  const body = parseJsonObject(response.body);
  if (!body || body.error) return null;
  if (protocol === 'runway-video' && ['FAILED', 'CANCELLED', 'CANCELED'].includes(String(body.status).toUpperCase())) return null;
  const resource = protocol === 'runway-video' ? body.id : body.name;
  if (typeof resource !== 'string') return null;
  if (protocol === 'runway-video') return /^[A-Za-z0-9_-]{1,256}$/.test(resource) ? resource : null;
  return resource.length <= 512 && VEO_OPERATION.test(resource) ? resource : null;
}

export function requestService(request: SerializedHttpRequest): string | undefined {
  const route = nativeVideoRoute(request);
  if (route?.model) return route.model;
  if (route && route.action !== 'create') {
    const header = Object.entries(request.headers).find(([key]) => key.toLowerCase() === 'x-antseed-service')?.[1];
    return header?.trim() || undefined;
  }
  const body = extractRequestBodyFields(request.headers, request.body);
  if (route?.protocol === 'runway-video') {
    return typeof body?.model === 'string' && body.model.length > 0 ? body.model : undefined;
  }
  const service = body?.service ?? body?.model;
  if (typeof service === 'string' && service.trim()) return service.trim();
  return undefined;
}

export interface NativeVideoFacts {
  protocol: NativeVideoProtocol;
  action: NativeVideoRoute['action'];
  count: number;
  duration?: number;
  resolution?: string;
}

export function nativeVideoFacts(request: SerializedHttpRequest): NativeVideoFacts | undefined {
  const route = nativeVideoRoute(request);
  if (!route) return undefined;
  if (route.action !== 'create') return { protocol: route.protocol, action: route.action, count: 0 };
  const body = parseJsonObject(request.body);
  if (!body) throw new Error('Video submission requires a JSON object');
  const parameters = body.parameters && typeof body.parameters === 'object' && !Array.isArray(body.parameters)
    ? body.parameters as Record<string, unknown> : {};
  const count = route.protocol === 'veo-video' ? veoVideoCount(parameters) : 1;
  const rawDuration = route.protocol === 'veo-video' ? parameters.durationSeconds : body.duration;
  const duration = route.protocol === 'runway-video' && rawDuration === 'auto' ? undefined : positiveInteger(rawDuration);
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('Video sample count must be a positive integer');
  if (duration === null) throw new Error('Video duration must be a positive integer');
  if (duration !== undefined && !Number.isSafeInteger(duration * count)) throw new Error('Video quantity exceeds the safe integer limit');
  const resolution = route.protocol === 'veo-video' ? parameters.resolution : body.resolution;
  return {
    protocol: route.protocol, action: route.action, count,
    ...(duration === undefined ? {} : { duration }),
    ...(typeof resolution === 'string' ? { resolution } : {}),
  };
}

/** Positive integer from a number or decimal string; undefined when absent, null when invalid. */
function positiveInteger(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Gemini API uses `numberOfVideos`; Vertex AI uses `sampleCount`. Both must agree when present. */
function veoVideoCount(parameters: Record<string, unknown>): number {
  const numberOfVideos = positiveInteger(parameters.numberOfVideos);
  const sampleCount = positiveInteger(parameters.sampleCount);
  if (numberOfVideos === null || sampleCount === null) return Number.NaN;
  if (numberOfVideos !== undefined && sampleCount !== undefined && numberOfVideos !== sampleCount) {
    throw new Error('Veo numberOfVideos and sampleCount disagree');
  }
  return numberOfVideos ?? sampleCount ?? 1;
}
