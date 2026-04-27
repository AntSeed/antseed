import type { ChatServiceOptionEntry } from '../core/state';
import type { StudioIntent, StudioRunReference, StudioRunRequest, StudioRunResponse } from '../types/bridge';

export type StudioProxyTransportResult = {
  ok: boolean;
  status: number;
  body: string;
  error: string | null;
};

export type StudioProxyBuildResult = {
  path: string;
  method: 'POST';
  headers: Record<string, string>;
  bodyText: string;
};

export type StudioProxyParseResult =
  | { ok: true; data: StudioRunResponse }
  | { ok: false; status: number; message: string; code?: string };

type StudioCategory = 'image' | 'video' | 'edit' | 'multimodal';

const CATEGORY_ALIAS: Record<string, StudioCategory | null> = {
  image: 'image',
  'image-generate': 'image',
  'image-generation': 'image',
  'text-to-image': 'image',
  diffusion: 'image',
  sdxl: 'image',
  'gpt-image': 'image',

  video: 'video',
  'video-generate': 'video',
  'video-generation': 'video',
  'text-to-video': 'video',
  'image-to-video': 'video',
  i2v: 'video',
  animation: 'video',
  motion: 'video',
  cinema: 'video',

  edit: 'edit',
  'image-edit': 'edit',
  'image-editing': 'edit',
  inpaint: 'edit',
  img2img: 'edit',

  multimodal: 'multimodal',
};

const CATEGORY_INTENT_MAP: Record<StudioIntent, StudioCategory[]> = {
  'image-edit': ['edit', 'image', 'multimodal'],
  'image-generate': ['image', 'multimodal'],
  'video-generate': ['video'],
};

function normalizeCategory(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function toStudioCategory(value: string): StudioCategory | null {
  const normalized = normalizeCategory(value);
  return CATEGORY_ALIAS[normalized] ?? null;
}

function getServiceCategories(entry: Pick<ChatServiceOptionEntry, 'categories'>): Set<StudioCategory> {
  return new Set(
    entry.categories
      .map((category) => toStudioCategory(category))
      .filter((category): category is StudioCategory => category !== null),
  );
}

export function isStudioServiceCandidate(entry: Pick<ChatServiceOptionEntry, 'categories'>): boolean {
  const categories = getServiceCategories(entry);
  return categories.size > 0;
}

export function supportsStudioIntent(entry: Pick<ChatServiceOptionEntry, 'categories'>, intent: StudioIntent): boolean {
  const categories = getServiceCategories(entry);
  return CATEGORY_INTENT_MAP[intent].some((required) => categories.has(required));
}

export function buildStudioRunRequest(
  model: string,
  intent: StudioIntent,
  prompt: string,
  references: StudioRunReference[],
  options?: Record<string, unknown>,
): StudioRunRequest {
  return {
    model,
    intent,
    prompt,
    references,
    ...(options && Object.keys(options).length > 0 ? { options } : {}),
  };
}

export function buildStudioProxyRequest(
  selectedService: Pick<ChatServiceOptionEntry, 'provider' | 'peerId'>,
  request: StudioRunRequest,
): StudioProxyBuildResult {
  return {
    path: '/v1/studio/run',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-antseed-provider': selectedService.provider,
      'x-antseed-pin-peer': selectedService.peerId,
    },
    bodyText: JSON.stringify(request),
  };
}

function parseErrorLike(parsed: unknown): { message: string; code?: string } | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const topLevel = parsed as Record<string, unknown>;
  const nested = topLevel.error && typeof topLevel.error === 'object'
    ? (topLevel.error as Record<string, unknown>)
    : null;
  const source = nested ?? topLevel;
  const message = typeof source.message === 'string'
    ? source.message
    : typeof source.error === 'string'
      ? source.error
      : null;
  if (!message) return null;
  const code = typeof source.code === 'string' ? source.code : undefined;
  return { message, ...(code ? { code } : {}) };
}

function parseStudioRunResponse(parsed: unknown): StudioRunResponse | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.status !== 'string' || !Array.isArray(value.outputs)) {
    return null;
  }
  const outputs = value.outputs
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.url !== 'string') return null;
      const kind = record.kind === 'video' ? 'video' : 'image';
      return { url: record.url, kind } as const;
    })
    .filter((entry): entry is { url: string; kind: 'image' | 'video' } => entry !== null);
  if (outputs.length === 0) return null;
  return {
    id: value.id,
    status: value.status,
    outputs,
    ...(value.meta && typeof value.meta === 'object' ? { meta: value.meta as Record<string, unknown> } : {}),
  };
}

export function parseStudioProxyTransportResult(
  result: StudioProxyTransportResult,
  serviceLabel: string,
): StudioProxyParseResult {
  if (!result.ok) {
    return {
      ok: false,
      status: 0,
      message: result.error || 'Buyer proxy request failed before reaching a provider.',
      code: 'proxy_transport_failure',
    };
  }

  let parsed: unknown = null;
  if (result.body && result.body.trim().length > 0) {
    try {
      parsed = JSON.parse(result.body) as unknown;
    } catch {
      parsed = null;
    }
  }

  if (result.status >= 400) {
    const maybeError = parseErrorLike(parsed);
    if (result.status === 404 || result.status === 405) {
      return {
        ok: false,
        status: result.status,
        message: `${serviceLabel} does not expose /v1/studio/run. This provider is not Studio-capable yet.`,
        code: maybeError?.code ?? 'studio_endpoint_missing',
      };
    }
    return {
      ok: false,
      status: result.status,
      message: maybeError?.message ?? `Studio run failed with HTTP ${String(result.status)}.`,
      ...(maybeError?.code ? { code: maybeError.code } : {}),
    };
  }

  const studioResponse = parseStudioRunResponse(parsed);
  if (!studioResponse) {
    return {
      ok: false,
      status: result.status,
      message: 'Provider response did not include a valid Studio output payload.',
      code: 'invalid_studio_response',
    };
  }

  return { ok: true, data: studioResponse };
}
