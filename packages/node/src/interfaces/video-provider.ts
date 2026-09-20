import type {
  VideoCapabilities,
  VideoGenerationRequest,
  VideoGenerationStatus,
} from '@antseed/protocol/video';

export interface ProviderVideoArtifact {
  providerArtifactId?: string;
  locator: string;
  mimeType?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
}

export interface VideoAdapterContext {
  idempotencyKey: string;
  generationId: string;
  firstFrame?: Uint8Array;
  firstFrameMimeType?: string;
}

export interface ProviderVideoJob {
  id: string;
  status: VideoGenerationStatus;
  nativeStatus?: string;
  progress?: number;
  retryAfterMs?: number;
}

export interface ProviderVideoStatus extends ProviderVideoJob {
  artifacts?: ProviderVideoArtifact[];
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface ProviderVideoCancelResult {
  accepted: boolean;
  status: VideoGenerationStatus;
}

export interface VideoProviderAdapter {
  readonly provider: string;
  readonly supportedModels: readonly string[];
  getCapabilities(model: string): VideoCapabilities | undefined;
  validateRequest?(request: VideoGenerationRequest): string[];
  create(request: VideoGenerationRequest, context: VideoAdapterContext): Promise<ProviderVideoJob>;
  getStatus(jobId: string): Promise<ProviderVideoStatus>;
  cancel(jobId: string): Promise<ProviderVideoCancelResult>;
  openArtifact(artifact: ProviderVideoArtifact): Promise<ReadableStream<Uint8Array>>;
}
