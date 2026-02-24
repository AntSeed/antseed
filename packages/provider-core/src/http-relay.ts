import type { TokenProvider } from '@antseed/node';
import type { SerializedHttpRequest, SerializedHttpResponse, SerializedHttpResponseChunk } from '@antseed/node';
import { ANTSEED_STREAMING_RESPONSE_HEADER } from '@antseed/node';
import { swapAuthHeader, validateRequestModel } from './auth-swap.js';

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
  allowedModels: string[];
  timeoutMs?: number;
}

export interface RelayCallbacks {
  onResponse: (response: SerializedHttpResponse) => void;
  onResponseChunk?: (chunk: SerializedHttpResponseChunk) => void;
}

export class HttpRelay {
  private readonly _config: RelayConfig;
  private readonly _callbacks: RelayCallbacks;
  private _activeCount = 0;

  constructor(config: RelayConfig, callbacks: RelayCallbacks) {
    this._config = config;
    this._callbacks = callbacks;
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
    // Validate model against allowedModels
    const validationError = validateRequestModel(request, this._config.allowedModels);
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
      const swappedRequest = swapAuthHeader(request, effectiveConfig);

      // Build upstream URL
      const base = this._config.baseUrl.replace(/\/+$/, '');
      const path = request.path.startsWith('/') ? request.path : `/${request.path}`;
      const url = `${base}${path}`;

      // Build fetch headers, stripping hop-by-hop
      const fetchHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(swappedRequest.headers)) {
        const lower = key.toLowerCase();
        if (!HOP_BY_HOP_HEADERS.has(lower) && !INTERNAL_HEADERS.has(lower) && lower !== 'host' && lower !== 'content-length' && lower !== 'accept-encoding') {
          fetchHeaders[key] = value;
        }
      }

      const timeoutMs = this._config.timeoutMs ?? 120_000;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let fetchResponse: Response;
      try {
        fetchResponse = await fetch(url, {
          method: swappedRequest.method,
          headers: fetchHeaders,
          body: swappedRequest.method !== 'GET' && swappedRequest.method !== 'HEAD'
            ? Buffer.from(swappedRequest.body)
            : undefined,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
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
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
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
