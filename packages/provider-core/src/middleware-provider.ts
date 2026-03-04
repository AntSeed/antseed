import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ProviderStreamCallbacks,
} from '@antseed/node';
import { type ProviderMiddleware, applyMiddleware } from './middleware.js';

/**
 * Rough token estimate: ~4 characters per token for English text.
 * Used to subtract middleware contribution from response usage so
 * buyers cannot infer injected system-prompt size.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Minimum phrase length to match against response text. */
const MIN_PHRASE_LENGTH = 24;

/**
 * Extract matchable phrases from middleware content.
 * Splits on newlines/sentences, lowercases, trims, and keeps only
 * phrases longer than MIN_PHRASE_LENGTH to avoid false positives.
 */
function extractPhrases(content: string): string[] {
  const lines = content.split(/\n+/).map(l => l.replace(/^[-*>#\d.]+\s*/, '').trim());
  const phrases: string[] = [];
  for (const line of lines) {
    if (line.length >= MIN_PHRASE_LENGTH) {
      phrases.push(line.toLowerCase());
    }
  }
  return phrases;
}

/**
 * Redact any middleware phrases found in text.
 * Uses case-insensitive matching to catch paraphrased quoting.
 */
function redactText(text: string, phrases: string[]): string {
  if (!phrases.length) return text;
  let result = text;
  for (const phrase of phrases) {
    const idx = result.toLowerCase().indexOf(phrase);
    if (idx !== -1) {
      result = result.slice(0, idx) + '[content redacted]' + result.slice(idx + phrase.length);
    }
  }
  return result;
}

/**
 * Wraps any Provider to inject middleware (MD files) into each request before
 * forwarding to the upstream LLM. Response content is scanned for leaked
 * middleware text and redacted. Usage input_tokens is adjusted to hide the
 * middleware's token contribution from the buyer.
 */
export class MiddlewareProvider implements Provider {
  /** Estimated token count of all middleware content combined. */
  private readonly _middlewareTokenEstimate: number;
  /** Phrases extracted from middleware for response redaction. */
  private readonly _phrases: string[];

  constructor(
    private readonly _inner: Provider,
    private readonly _middleware: ProviderMiddleware[],
  ) {
    this._middlewareTokenEstimate = _middleware.reduce(
      (sum, mw) => sum + estimateTokens(mw.content),
      0,
    );
    this._phrases = _middleware.flatMap(mw => extractPhrases(mw.content));
  }

  get name() { return this._inner.name; }
  get models() { return this._inner.models; }
  get pricing(): Provider['pricing'] { return this._inner.pricing; }
  get maxConcurrency() { return this._inner.maxConcurrency; }

  get modelCategories() { return this._inner.modelCategories; }
  set modelCategories(v: Record<string, string[]> | undefined) { this._inner.modelCategories = v; }

  get modelApiProtocols() { return this._inner.modelApiProtocols; }

  getCapacity() { return this._inner.getCapacity(); }

  async init() { return this._inner.init?.(); }

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    const resp = await this._inner.handleRequest(this._augment(req));
    return this._stripResponse(resp);
  }

  get handleRequestStream():
    | ((req: SerializedHttpRequest, callbacks: ProviderStreamCallbacks) => Promise<SerializedHttpResponse>)
    | undefined {
    if (!this._inner.handleRequestStream) return undefined;
    return async (req: SerializedHttpRequest, callbacks: ProviderStreamCallbacks) => {
      const resp = await this._inner.handleRequestStream!(this._augment(req), callbacks);
      return this._stripResponse(resp);
    };
  }

  private _augment(req: SerializedHttpRequest): SerializedHttpRequest {
    if (!this._middleware.length) return req;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(new TextDecoder().decode(req.body)) as Record<string, unknown>;
    } catch {
      return req; // not JSON — leave unchanged
    }
    const format = req.path?.includes('/chat/completions') ? 'openai' : 'anthropic';
    const augmented = applyMiddleware(body, this._middleware, format);
    return { ...req, body: new TextEncoder().encode(JSON.stringify(augmented)) };
  }

  /**
   * Redact leaked middleware content from response text and adjust
   * usage.input_tokens so the buyer cannot infer injected prompt size.
   */
  private _stripResponse(resp: SerializedHttpResponse): SerializedHttpResponse {
    if (!resp.body) return resp;
    try {
      const body = JSON.parse(new TextDecoder().decode(resp.body)) as Record<string, unknown>;
      let changed = false;

      // --- Redact middleware text from response content ---
      if (this._phrases.length > 0) {
        // Anthropic format: content[] array with text blocks
        if (Array.isArray(body['content'])) {
          for (const block of body['content'] as Record<string, unknown>[]) {
            if (block['type'] === 'text' && typeof block['text'] === 'string') {
              const redacted = redactText(block['text'] as string, this._phrases);
              if (redacted !== block['text']) {
                block['text'] = redacted;
                changed = true;
              }
            }
          }
        }
        // OpenAI format: choices[].message.content
        if (Array.isArray(body['choices'])) {
          for (const choice of body['choices'] as Record<string, unknown>[]) {
            const msg = choice['message'] as Record<string, unknown> | undefined;
            if (msg && typeof msg['content'] === 'string') {
              const redacted = redactText(msg['content'] as string, this._phrases);
              if (redacted !== msg['content']) {
                msg['content'] = redacted;
                changed = true;
              }
            }
          }
        }
      }

      // --- Adjust usage token counts ---
      if (this._middlewareTokenEstimate > 0) {
        const usage = body['usage'];
        if (usage && typeof usage === 'object') {
          const u = usage as Record<string, unknown>;
          if (typeof u['input_tokens'] === 'number') {
            u['input_tokens'] = Math.max(0, u['input_tokens'] - this._middlewareTokenEstimate);
            changed = true;
          }
          if (typeof u['cache_creation_input_tokens'] === 'number') {
            u['cache_creation_input_tokens'] = Math.max(0, u['cache_creation_input_tokens'] - this._middlewareTokenEstimate);
            changed = true;
          }
          if (typeof u['prompt_tokens'] === 'number') {
            u['prompt_tokens'] = Math.max(0, u['prompt_tokens'] - this._middlewareTokenEstimate);
            changed = true;
          }
        }
      }

      if (!changed) return resp;
      return { ...resp, body: new TextEncoder().encode(JSON.stringify(body)) };
    } catch {
      return resp;
    }
  }
}
