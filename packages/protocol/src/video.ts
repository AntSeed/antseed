export const VIDEO_JOB_PROTOCOL = 'antseed-video-jobs-v1' as const;

export const VIDEO_GENERATION_STATUSES = [
  'queued',
  'in_progress',
  'succeeded',
  'failed',
  'canceled',
  'expired',
] as const;

export type VideoGenerationStatus = (typeof VIDEO_GENERATION_STATUSES)[number];
export type VideoGenerationMode = 'text_to_video' | 'image_to_video';

export interface VideoInputAsset {
  type: 'image';
  role: 'first_frame';
  asset_id: string;
}

export interface VideoGenerationRequest {
  model: string;
  prompt: string;
  input_assets?: VideoInputAsset[];
  duration_seconds: number;
  aspect_ratio?: string;
  resolution?: string;
  generate_audio?: boolean;
  output_format?: 'mp4';
  seed?: number;
  metadata?: Record<string, string>;
  extensions?: {
    runway?: Record<string, unknown>;
    veo?: Record<string, unknown>;
  };
}

export interface VideoArtifactManifest {
  id: string;
  type: 'video';
  mime_type: string;
  bytes: number;
  sha256: string;
  duration_seconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  has_audio?: boolean;
  expires_at: number;
  links: { content: string };
}

export interface VideoGenerationError {
  code: string;
  message: string;
  retryable: boolean;
}

export type VideoPaymentMilestoneStatus = 'pending' | 'authorized' | 'earned';

export interface VideoPaymentMilestone {
  id: 'execution' | 'delivery';
  trigger: 'submission_authorized' | 'artifact_received';
  amount: string;
  status: VideoPaymentMilestoneStatus;
}

export interface VideoPaymentSummary {
  currency: 'USDC';
  total_amount: string;
  upfront_bps: number;
  milestones: VideoPaymentMilestone[];
}

export interface VideoGenerationResource {
  id: string;
  object: 'video.generation';
  created_at: number;
  updated_at: number;
  model: string;
  status: VideoGenerationStatus;
  progress: number | null;
  artifacts: VideoArtifactManifest[];
  error: VideoGenerationError | null;
  payment: VideoPaymentSummary;
  links: {
    self: string;
    cancel: string;
  };
}

export interface VideoPaymentQuoteV1 {
  version: 1;
  quote_id: string;
  request_hash: string;
  seller_peer_id: string;
  total_amount: string;
  upfront_amount: string;
  delivery_amount: string;
  upfront_bps: number;
  expires_at: number;
  signature: string;
}

export interface VideoDeliveryReceiptV1 {
  version: 1;
  generation_id: string;
  artifact_id: string;
  sha256: string;
  bytes: number;
  received_at: number;
  buyer_peer_id: string;
  signature: string;
}

export interface VideoCancellationResponse {
  id: string;
  status: VideoGenerationStatus;
  cancellation_requested: boolean;
}

export interface VideoCapabilities {
  generationModes: VideoGenerationMode[];
  minDurationSeconds: number;
  maxDurationSeconds: number;
  allowedDurationsSeconds?: number[];
  resolutions: string[];
  aspectRatios: string[];
  generateAudio: boolean;
  outputFormats: string[];
  maxFirstFrameBytes?: number;
  upfrontBps?: number;
}

export interface VideoRequestValidationOptions {
  supportedModels?: readonly string[];
  capabilities?: VideoCapabilities;
  providerErrors?: readonly string[];
}

const VIDEO_REQUEST_KEYS = new Set([
  'model',
  'prompt',
  'input_assets',
  'duration_seconds',
  'aspect_ratio',
  'resolution',
  'generate_audio',
  'output_format',
  'seed',
  'metadata',
  'extensions',
]);

export function validateVideoGenerationRequest(
  value: unknown,
  options: VideoRequestValidationOptions = {},
): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['request body must be an object'];
  }
  const request = value as Record<string, unknown>;
  const errors: string[] = [...(options.providerErrors ?? [])];
  for (const key of Object.keys(request)) {
    if (!VIDEO_REQUEST_KEYS.has(key)) errors.push(`unknown parameter "${key}"`);
  }
  const model = typeof request.model === 'string' ? request.model.trim() : '';
  const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
  if (!model) errors.push('model is required');
  if (!prompt) errors.push('prompt is required');
  if (options.supportedModels && model && !options.supportedModels.includes(model)) {
    errors.push(`model "${model}" is not supported`);
  }
  const duration = request.duration_seconds;
  if (!Number.isSafeInteger(duration) || Number(duration) <= 0) {
    errors.push('duration_seconds must be a positive integer');
  } else if (options.capabilities) {
    if (Number(duration) < options.capabilities.minDurationSeconds || Number(duration) > options.capabilities.maxDurationSeconds) {
      errors.push(`duration_seconds must be between ${options.capabilities.minDurationSeconds} and ${options.capabilities.maxDurationSeconds}`);
    }
    if (options.capabilities.allowedDurationsSeconds && !options.capabilities.allowedDurationsSeconds.includes(Number(duration))) {
      errors.push('duration_seconds is not supported by this model');
    }
  }
  if (request.output_format !== undefined && request.output_format !== 'mp4') {
    errors.push('output_format must be "mp4"');
  } else if (
    typeof request.output_format === 'string'
    && options.capabilities
    && !options.capabilities.outputFormats.includes(request.output_format)
  ) {
    errors.push('output_format is not supported by this model');
  }
  if (request.seed !== undefined && (!Number.isSafeInteger(request.seed) || Number(request.seed) < 0)) {
    errors.push('seed must be a non-negative integer');
  }
  if (request.input_assets !== undefined) {
    if (!Array.isArray(request.input_assets) || request.input_assets.length > 1) {
      errors.push('input_assets must contain at most one first-frame image');
    } else {
      for (const asset of request.input_assets) {
        if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
          errors.push('input_assets entries must be objects');
          continue;
        }
        const input = asset as Record<string, unknown>;
        if (input.type !== 'image' || input.role !== 'first_frame') {
          errors.push('only image assets with role "first_frame" are supported');
        }
        if (typeof input.asset_id !== 'string' || !input.asset_id.trim()) {
          errors.push('input asset_id is required');
        }
      }
    }
  }
  const hasFirstFrame = Array.isArray(request.input_assets) && request.input_assets.length === 1;
  if (options.capabilities) {
    const requiredMode: VideoGenerationMode = hasFirstFrame ? 'image_to_video' : 'text_to_video';
    if (!options.capabilities.generationModes.includes(requiredMode)) {
      errors.push(`${requiredMode} is not supported by this model`);
    }
  }
  for (const [key, allowed] of [
    ['resolution', options.capabilities?.resolutions],
    ['aspect_ratio', options.capabilities?.aspectRatios],
  ] as const) {
    const field = request[key];
    if (field !== undefined && typeof field !== 'string') errors.push(`${key} must be a string`);
    if (typeof field === 'string' && allowed && !allowed.includes(field)) errors.push(`${key} is not supported by this model`);
  }
  if (request.generate_audio === true && options.capabilities && !options.capabilities.generateAudio) {
    errors.push('generate_audio is not supported by this model');
  }
  if (request.generate_audio !== undefined && typeof request.generate_audio !== 'boolean') {
    errors.push('generate_audio must be a boolean');
  }
  if (request.metadata !== undefined) {
    if (!isPlainObject(request.metadata)) {
      errors.push('metadata must be an object containing string values');
    } else {
      const entries = Object.entries(request.metadata);
      if (entries.length > 64) errors.push('metadata must contain at most 64 entries');
      if (entries.some(([key, child]) => !key || key.length > 128 || typeof child !== 'string' || child.length > 2_048)) {
        errors.push('metadata keys and string values exceed the supported limits');
      }
    }
  }
  if (request.extensions !== undefined) {
    if (!isPlainObject(request.extensions)) {
      errors.push('extensions must be an object');
    } else {
      for (const [namespace, extension] of Object.entries(request.extensions)) {
        if (namespace !== 'runway' && namespace !== 'veo') errors.push(`unsupported extension namespace "${namespace}"`);
        else if (!isPlainObject(extension)) errors.push(`extensions.${namespace} must be an object`);
      }
    }
  }
  return errors;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
