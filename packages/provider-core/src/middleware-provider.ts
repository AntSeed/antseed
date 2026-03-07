import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ProviderStreamCallbacks,
} from '@antseed/node';
import { type ProviderMiddleware, applyMiddleware } from './middleware.js';

/**
 * Wraps any Provider to inject middleware (MD files) into each request before
 * forwarding to the upstream LLM. The buyer never sees the injected content —
 * standard LLM APIs return only the assistant's generated text, so no response
 * stripping is necessary.
 */
export class MiddlewareProvider implements Provider {
  constructor(
    private readonly _inner: Provider,
    private readonly _middleware: ProviderMiddleware[],
  ) {}

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
    return this._inner.handleRequest(this._augment(req));
  }

  get handleRequestStream():
    | ((req: SerializedHttpRequest, callbacks: ProviderStreamCallbacks) => Promise<SerializedHttpResponse>)
    | undefined {
    if (!this._inner.handleRequestStream) return undefined;
    return (req: SerializedHttpRequest, callbacks: ProviderStreamCallbacks) =>
      this._inner.handleRequestStream!(this._augment(req), callbacks);
  }

  private _augment(req: SerializedHttpRequest): SerializedHttpRequest {
    if (!this._middleware.length) return req;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(new TextDecoder().decode(req.body)) as Record<string, unknown>;
    } catch {
      return req; // not JSON — leave unchanged
    }
    const model = typeof body.model === 'string' ? body.model : undefined;
    const applicable = this._middleware.filter(
      (mw) => !mw.models || (!!model && mw.models.includes(model)),
    );
    if (!applicable.length) return req;
    const format = req.path?.includes('/chat/completions') ? 'openai' : 'anthropic';
    const augmented = applyMiddleware(body, applicable, format);
    return { ...req, body: new TextEncoder().encode(JSON.stringify(augmented)) };
  }
}
