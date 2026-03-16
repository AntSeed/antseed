import type { TokenProvider } from '@antseed/node';
import type { SerializedHttpRequest, SerializedHttpResponse, SerializedHttpResponseChunk } from '@antseed/node';
import { ANTSEED_STREAMING_RESPONSE_HEADER } from '@antseed/node';
import { swapAuthHeader, validateRequestService } from './auth-swap.js';

/** Hop-by-hop headers that must not be forwarded. */
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

/** Internal headers used only within Antseed routing. */
const INTERNAL_HEADERS = new Set([
  'x-antseed-provider',
]);

export interface RelayConfig {
  baseUrl: string;
  authHeaderName: string;
  authHeaderValue: string;
  tokenProvider?: TokenProvider;
  extraHeaders?: Record<string, string>;
  maxConcurrency: number;
  allowedServices: string[];
  timeoutMs?: number;
  /** Lowercase header-name prefixes to strip before forwarding upstream. */
  stripHeaderPrefixes?: string[];
  /** Optional lowercase map: announced service -> upstream service. */
  serviceRewriteMap?: Record<string, string>;
  /** Fields to deep-merge into the JSON request body before forwarding upstream. */
  injectJsonFields?: Record<string, unknown>;
  /** If true, retry once with a force-refreshed token on 401. Only meaningful for providers with a refreshable tokenProvider (e.g. OAuth). */
  retryOn401?: boolean;
  /** Retry on 500/502/503/504 with exponential backoff. Default: 0 (no retries). */
  retryOn5xx?: number;
  /** Base delay in ms for 5xx retries. Default: 1000. */
  retryBaseDelayMs?: number;
}

export interface RelayCallbacks {
  onResponse: (response: SerializedHttpResponse) => void;
  onResponseChunk?: (chunk: SerializedHttpResponseChunk) => void;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const out = { ...target };
  for (const [key, val] of Object.entries(source)) {
    if (val && typeof val === 'object' && !Array.isArray(val) && typeof out[key] === 'object' && out[key] !== null && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      out[key] = val;
    }
  }
  return out;
}

export class HttpRelay {
  private readonly _config: RelayConfig;
  private readonly _callbacks: RelayCallbacks;
  private readonly _validationServices: ReadonlySet<string>;
  private _activeCount = 0;

  constructor(config: RelayConfig, callbacks: RelayCallbacks) {
    this._config = config;
    this._callbacks = callbacks;
    const rewriteValues = Object.values(config.serviceRewriteMap ?? {});
    this._validationServices = new Set([
      ...config.allowedServices.map((m) => m.trim().toLowerCase()),
      ...rewriteValues.map((m) => m.trim().toLowerCase()),
    ]);
  }

  getActiveCount(): number {
    return this._activeCount;
  }

  private _sendError(requestId: string, statusCode: number, error: string): void {
    this._callbacks.onResponse({
      requestId,
      statusCode,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ error })),
    });
  }

  async handleRequest(request: SerializedHttpRequest): Promise<void> {
    // Validate service against pre-computed set (normalized at construction time).
    const validationError = validateRequestService(request, this._validationServices);
    if (validationError) {
      this._sendError(request.requestId, 403, validationError);
      return;
    }

    // Check concurrency
    if (this._activeCount >= this._config.maxConcurrency) {
      this._sendError(request.requestId, 429, 'Max concurrency reached');
      return;
    }

    // Increment active count
    this._activeCount++;

    try {
      // Resolve dynamic auth token if provider uses OAuth / keychain
      let effectiveConfig: { authHeaderName: string; authHeaderValue: string; extraHeaders?: Record<string, string> } = {
        authHeaderName: this._config.authHeaderName,
        authHeaderValue: this._config.authHeaderValue,
        extraHeaders: this._config.extraHeaders,
      };
      if (this._config.tokenProvider) {
        const freshToken = await this._config.tokenProvider.getToken();
        // Preserve Bearer prefix for OAuth providers that use Authorization header
        const isBearer = this._config.authHeaderName === 'authorization';
        const headerValue = isBearer ? `Bearer ${freshToken}` : freshToken;
        effectiveConfig = { ...effectiveConfig, authHeaderValue: headerValue };
      }

      // Swap auth headers
      let swappedRequest = swapAuthHeader(request, effectiveConfig);

      // Always process JSON bodies to normalize "service" → "model" for upstream APIs,
      // apply service rewrites, and inject extra fields.
      if (swappedRequest.method !== 'GET' && swappedRequest.method !== 'HEAD') {
        try {
          const decoded = JSON.parse(new TextDecoder().decode(swappedRequest.body)) as Record<string, unknown>;
          const transformed: Record<string, unknown> = { ...decoded };

          // Read from both "model" (upstream API compat) and "service" (native) fields
          const requestedService = (transformed.service ?? transformed.model) as string | undefined;

          if (this._config.serviceRewriteMap && typeof requestedService === 'string' && requestedService.trim().length > 0) {
            const rewrittenService = this._config.serviceRewriteMap[requestedService.trim().toLowerCase()];
            if (typeof rewrittenService === 'string' && rewrittenService.trim().length > 0) {
              transformed.model = rewrittenService.trim();
            }
          }

          // Normalize: if client sent "service" without "model", copy to "model" for upstream API compat.
          if (transformed.service !== undefined && transformed.model === undefined) {
            transformed.model = transformed.service;
          }
          // Remove the "service" field — upstream APIs don't understand it.
          delete transformed.service;

          const merged = this._config.injectJsonFields
            ? deepMerge(transformed, this._config.injectJsonFields)
            : transformed;

          swappedRequest = { ...swappedRequest, body: new TextEncoder().encode(JSON.stringify(merged)) };
        } catch {
          // Not JSON — leave body unchanged
        }
      }

      // Build upstream URL
      const base = this._config.baseUrl.replace(/\/+$/, '');
      const path = request.path.startsWith('/') ? request.path : `/${request.path}`;
      const url = `${base}${path}`;

      // Build fetch headers, stripping hop-by-hop and provider-specific prefixes
      const stripPrefixes = this._config.stripHeaderPrefixes ?? [];
      const fetchHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(swappedRequest.headers)) {
        const lower = key.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lower) || INTERNAL_HEADERS.has(lower) || lower === 'host' || lower === 'content-length' || lower === 'accept-encoding') {
          continue;
        }
        if (stripPrefixes.length > 0 && stripPrefixes.some((p) => lower.startsWith(p))) {
          continue;
        }
        fetchHeaders[key] = value;
      }

      const timeoutMs = this._config.timeoutMs ?? 120_000;

      const doFetch = async (headers: Record<string, string>): Promise<Response> => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await fetch(url, {
            method: swappedRequest.method,
            headers,
            body: swappedRequest.method !== 'GET' && swappedRequest.method !== 'HEAD'
              ? Buffer.from(swappedRequest.body)
              : undefined,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
      };

      let fetchResponse = await doFetch(fetchHeaders);

      if (fetchResponse.status === 401 && this._config.retryOn401 && this._config.tokenProvider?.forceRefresh) {
        const refreshedToken = await this._config.tokenProvider.forceRefresh();
        const isBearer = this._config.authHeaderName === 'authorization';
        const newHeaderValue = isBearer ? `Bearer ${refreshedToken}` : refreshedToken;
        const retryHeaders = { ...fetchHeaders };
        retryHeaders[this._config.authHeaderName] = newHeaderValue;
        fetchResponse = await doFetch(retryHeaders);
      }

      // Retry on 5xx with exponential backoff
      const maxRetries = this._config.retryOn5xx ?? 0;
      const baseDelay = this._config.retryBaseDelayMs ?? 1000;
      if (maxRetries > 0 && fetchResponse.status >= 500) {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          const delay = baseDelay * (2 ** attempt);
          await new Promise(r => setTimeout(r, delay));
          fetchResponse = await doFetch(fetchHeaders);
          if (fetchResponse.status < 500) break;
        }
      }

      const contentType = fetchResponse.headers.get('content-type') ?? '';
      const isSSE = contentType.includes('text/event-stream');

      // Build response headers, stripping hop-by-hop and encoding headers.
      // Node.js fetch auto-decompresses gzip/br responses, so we must strip
      // content-encoding to prevent the client from double-decompressing.
      const responseHeaders: Record<string, string> = {};
      fetchResponse.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (!HOP_BY_HOP_HEADERS.has(lower) && lower !== 'content-encoding' && lower !== 'content-length') {
          responseHeaders[lower] = value;
        }
      });

      if (isSSE && fetchResponse.body) {
        responseHeaders[ANTSEED_STREAMING_RESPONSE_HEADER] = '1';
        this._callbacks.onResponse({
          requestId: request.requestId,
          statusCode: fetchResponse.status,
          headers: responseHeaders,
          body: new Uint8Array(0),
        });

        const reader = fetchResponse.body.getReader();
        let totalStreamBytes = 0;
        const debugChunks: Uint8Array[] = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalStreamBytes += value.byteLength;
            if (totalStreamBytes <= 500) debugChunks.push(value);
            this._callbacks.onResponseChunk?.({
              requestId: request.requestId,
              data: value,
              done: false,
            });
          }
        } catch (err) {
          this._callbacks.onResponseChunk?.({
            requestId: request.requestId,
            data: new TextEncoder().encode(
              `event: error\ndata: ${err instanceof Error ? err.message : 'stream error'}\n\n`
            ),
            done: false,
          });
        }
        if (totalStreamBytes < 300) {
          const body = new TextDecoder().decode(
            debugChunks.reduce((a, b) => { const r = new Uint8Array(a.byteLength + b.byteLength); r.set(a); r.set(b, a.byteLength); return r; }, new Uint8Array(0))
          );
          console.warn(`[http-relay] Short stream (${totalStreamBytes}b): ${JSON.stringify(body)}`);
        }

        this._callbacks.onResponseChunk?.({
          requestId: request.requestId,
          data: new Uint8Array(0),
          done: true,
        });
      } else {
        // Complete response
        const body = new Uint8Array(await fetchResponse.arrayBuffer());
        this._callbacks.onResponse({
          requestId: request.requestId,
          statusCode: fetchResponse.status,
          headers: responseHeaders,
          body,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const sanitized = errMsg.replace(/sk-ant-[a-zA-Z0-9_-]+/g, 'sk-***');
      this._sendError(request.requestId, 502, `Upstream error: ${sanitized}`);
    } finally {
      this._activeCount--;
    }
  }
}
