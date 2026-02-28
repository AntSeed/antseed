import type { SerializedHttpRequest, SerializedHttpResponse, SerializedHttpResponseChunk } from '../types/http.js';
import type { ModelApiProtocol } from '../types/model-api.js';

export interface ProviderTokenPricingUsdPerMillion {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface ProviderPricing {
  defaults: ProviderTokenPricingUsdPerMillion;
  models?: Record<string, ProviderTokenPricingUsdPerMillion>;
}

/**
 * Interface that seller nodes implement to provide inference.
 *
 * Each provider represents one upstream LLM service (e.g., Anthropic, OpenAI, local LLM).
 * The SDK handles P2P connections, discovery, metering, and payments.
 * You just handle the HTTP request → response conversion.
 */
export interface Provider {
  /** Unique name for this provider (e.g., 'anthropic', 'openai', 'my-local-llm') */
  name: string;

  /** Model IDs this provider supports (e.g., ['claude-sonnet-4-5-20250929', 'claude-opus-4-0-20250514']) */
  models: string[];

  /** Seller pricing in USD per 1M tokens (defaults + optional per-model overrides). */
  pricing: ProviderPricing;

  /** Optional model category tags used for discovery metadata. */
  modelCategories?: Record<string, string[]>;

  /** Optional per-model API protocol support advertised via discovery metadata. */
  modelApiProtocols?: Record<string, ModelApiProtocol[]>;

  /** Maximum concurrent requests this provider can handle */
  maxConcurrency: number;

  /**
   * Handle an incoming inference request and return the response.
   */
  handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse>;

  /**
   * Optional streaming request handler. Implementations should call
   * `callbacks.onResponseStart` once, then `callbacks.onResponseChunk`
   * zero or more times (including a final `done=true` chunk).
   *
   * Must resolve with the complete reconstructed response body.
   */
  handleRequestStream?(
    req: SerializedHttpRequest,
    callbacks: ProviderStreamCallbacks,
  ): Promise<SerializedHttpResponse>;

  /** Optional startup hook — validate credentials, warm caches, etc. */
  init?(): Promise<void>;

  /** Return current and maximum concurrent request counts */
  getCapacity(): { current: number; max: number };
}

export interface ProviderStreamCallbacks {
  onResponseStart: (response: SerializedHttpResponse) => void;
  onResponseChunk: (chunk: SerializedHttpResponseChunk) => void;
}
