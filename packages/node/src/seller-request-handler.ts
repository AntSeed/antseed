import type { PeerAnnouncer } from './discovery/announcer.js';
import type {
  Provider,
  ProviderStreamCallbacks,
} from './interfaces/seller-provider.js';
import type { SellerSessionTracker } from './metering/seller-session-tracker.js';
import type { PaymentMux } from './p2p/payment-mux.js';
import type { ChannelsClient } from './payments/evm/channels-client.js';
import type { SellerPaymentManager } from './payments/seller-payment-manager.js';
import { ProxyMux } from './proxy/proxy-mux.js';
import type { PeerConnection } from './p2p/connection-manager.js';
import type {
  SerializedHttpRequest,
  SerializedHttpResponse,
} from './types/http.js';
import { parseResponseUsage } from './utils/response-usage.js';
import { computeCostUsdc } from './payments/pricing.js';
import { debugLog, debugWarn } from './utils/debug.js';

export interface SellerRequestHandlerDeps {
  providers: Provider[];
  sellerPaymentManager: SellerPaymentManager | null;
  sessionTracker: SellerSessionTracker | null;
  channelsClient: ChannelsClient | null;
  announcer: PeerAnnouncer | null;
  emit: (event: string, ...args: unknown[]) => boolean;
}

/** Debounce interval for metadata refresh after load changes. */
const METADATA_REFRESH_DEBOUNCE_MS = 200;
/**
 * Handles all seller-side request processing: provider matching, execution,
 * cost tracking, payment auth checks, and load management.
 *
 * Extracted from AntseedNode to isolate seller request handling from core
 * node orchestration.
 */
export class SellerRequestHandler {
  private readonly _deps: SellerRequestHandlerDeps;
  private readonly _providerLoadCounts = new Map<string, number>();
  private _metadataRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: SellerRequestHandlerDeps) {
    this._deps = deps;
  }

  /**
   * Wire up the ProxyMux and PaymentMux for a new incoming connection.
   * Registers the onProxyRequest handler that routes requests to providers.
   */
  handleConnection(
    conn: PeerConnection,
    buyerPeerId: string,
    paymentMux: PaymentMux,
  ): { mux: ProxyMux } {
    const mux = new ProxyMux(conn);

    mux.onProxyRequest(async (request: SerializedHttpRequest) => {
      debugLog(`[SellerHandler] Received request: ${request.method} ${request.path} (reqId=${request.requestId.slice(0, 8)})`);

      // Reject with 402 if no active payment session and channels client is configured.
      const spm = this._deps.sellerPaymentManager;
      const spmAuthorized = spm?.hasSession(buyerPeerId) ?? false;
      if (this._deps.channelsClient && !spmAuthorized) {
        const matchedProvider = this.matchProvider(request);
        const providerPricing = matchedProvider
          ? this.resolveProviderPricing(matchedProvider, request)
          : undefined;
        const requirements = spm?.getPaymentRequirements(
          request.requestId, buyerPeerId, providerPricing,
        );
        if (requirements) {
          debugLog(`[SellerHandler] No payment session for ${buyerPeerId.slice(0, 12)}... — sending 402 + PaymentRequired`);
          const paymentBody = JSON.stringify({
            error: 'payment_required',
            minBudgetPerRequest: requirements.minBudgetPerRequest,
            suggestedAmount: requirements.suggestedAmount,
            ...(requirements.inputUsdPerMillion != null ? { inputUsdPerMillion: requirements.inputUsdPerMillion } : {}),
            ...(requirements.outputUsdPerMillion != null ? { outputUsdPerMillion: requirements.outputUsdPerMillion } : {}),
            ...(requirements.cachedInputUsdPerMillion != null ? { cachedInputUsdPerMillion: requirements.cachedInputUsdPerMillion } : {}),
          });
          mux.sendProxyResponse({
            requestId: request.requestId,
            statusCode: 402,
            headers: { "content-type": "application/json" },
            body: new TextEncoder().encode(paymentBody),
          });
          paymentMux.sendPaymentRequired(requirements);
        } else {
          debugWarn(`[SellerHandler] No payment session — returning 402`);
          mux.sendProxyResponse({
            requestId: request.requestId,
            statusCode: 402,
            headers: { "content-type": "application/json" },
            body: new TextEncoder().encode(JSON.stringify({
              error: 'payment_required',
              message: 'Seller not ready, try again later',
            })),
          });
        }
        return;
      }

      // Check budget before routing — reject if buyer hasn't authorized enough
      if (spm) {
        const session = spm.getChannelByPeer(buyerPeerId);
        if (session) {
          const accepted = spm.getAcceptedCumulative(session.sessionId);
          const spent = spm.getCumulativeSpend(session.sessionId);
          if (accepted > 0n && spent >= accepted) {
            const reserveMax = spm.getReserveMax(session.sessionId);
            const matchedProvider = this.matchProvider(request);
            const providerPricing = matchedProvider
              ? this.resolveProviderPricing(matchedProvider, request)
              : undefined;
            const requirements = spm.getPaymentRequirements(
              request.requestId, buyerPeerId, providerPricing,
            );
            if (reserveMax > 0n && accepted >= reserveMax) {
              debugLog(`[SellerHandler] Session fully exhausted for ${buyerPeerId.slice(0, 12)}... (spent=${spent} >= accepted=${accepted} >= reserveMax=${reserveMax}) — settling and returning 402`);
              void spm.settleSession(buyerPeerId).catch((err) => {
                debugWarn(`[SellerHandler] Failed to settle exhausted session: ${err instanceof Error ? err.message : err}`);
              });
            } else {
              debugLog(`[SellerHandler] Budget exhausted for ${buyerPeerId.slice(0, 12)}... (spent=${spent} >= accepted=${accepted}) — returning 402, awaiting NeedAuth response`);
            }
            mux.sendProxyResponse({
              requestId: request.requestId,
              statusCode: 402,
              headers: { "content-type": "application/json" },
              body: new TextEncoder().encode(JSON.stringify({
                error: 'payment_required',
                minBudgetPerRequest: requirements.minBudgetPerRequest,
                suggestedAmount: requirements.suggestedAmount,
                ...(requirements.inputUsdPerMillion != null ? { inputUsdPerMillion: requirements.inputUsdPerMillion } : {}),
                ...(requirements.outputUsdPerMillion != null ? { outputUsdPerMillion: requirements.outputUsdPerMillion } : {}),
              })),
            });
            paymentMux.sendPaymentRequired(requirements);
            return;
          }
        }
      }

      // Handle /v1/models locally — return seller's configured services without
      // upstream call or resetting idle timers (these are metadata queries, not inference).
      if (request.method === 'GET' && (request.path === '/v1/models' || request.path.startsWith('/v1/models/'))) {
        const modelsResponse = this._handleModelsRequest(request);
        mux.sendProxyResponse(modelsResponse);
        return;
      }

      const provider = this.matchProvider(request);

      if (!provider) {
        debugWarn(`[SellerHandler] No matching provider for ${request.path}`);
        mux.sendProxyResponse({
          requestId: request.requestId,
          statusCode: 502,
          headers: { "content-type": "text/plain" },
          body: new TextEncoder().encode("No matching provider"),
        });
        return;
      }

      // Track active seller session at request start
      this._deps.sessionTracker?.getOrCreateSession(buyerPeerId, provider.name);

      request.headers['x-antseed-buyer-peer-id'] = buyerPeerId;

      debugLog(`[SellerHandler] Routing to provider "${provider.name}"`);
      const startTime = Date.now();
      let statusCode = 500;
      let responseBody: Uint8Array = new Uint8Array(0);
      let streamedResponseStarted = false;
      let heldDoneChunkData: Uint8Array | null = null;
      let responseUsage: import('./utils/response-usage.js').ResponseUsage = { inputTokens: 0, outputTokens: 0, freshInputTokens: 0, cachedInputTokens: 0 };
      this.adjustProviderLoad(provider.name, 1);
      try {
        try {
          const response = await this._executeRequest(provider, request, {
            onResponseStart: (streamResponseStart) => {
              streamedResponseStarted = true;
              statusCode = streamResponseStart.statusCode;
              mux.sendProxyResponse(streamResponseStart);
            },
            onResponseChunk: (chunk) => {
              if (!streamedResponseStarted) return;
              // Hold the done chunk — send it after usage is parsed so we can append cost trailer
              if (chunk.done) {
                heldDoneChunkData = chunk.data;
                return;
              }
              mux.sendProxyChunk(chunk);
            },
          });
          statusCode = response.statusCode;
          responseBody = response.body ?? new Uint8Array(0);
          debugLog(`[SellerHandler] Provider responded: status=${statusCode} (${Date.now() - startTime}ms, ${responseBody.length}b) bodyType=${typeof response.body} hasBody=${!!response.body}`);
          responseUsage = parseResponseUsage(responseBody);
          debugLog(`[SellerHandler] Raw provider usage: in=${responseUsage.inputTokens} fresh=${responseUsage.freshInputTokens} cached=${responseUsage.cachedInputTokens} out=${responseUsage.outputTokens}`);
          if (!streamedResponseStarted) {
            mux.sendProxyResponse(response);
          } else if (heldDoneChunkData !== null) {
            // Streaming: send the held done chunk as-is (no trailer).
            // Cost data is sent via NeedAuth on the PaymentMux.
            mux.sendProxyChunk({
              requestId: request.requestId,
              data: heldDoneChunkData,
              done: true,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Internal error";
          debugWarn(`[SellerHandler] Provider error after ${Date.now() - startTime}ms: ${message}`);
          responseBody = new TextEncoder().encode(message);
          if (streamedResponseStarted) {
            mux.sendProxyChunk({
              requestId: request.requestId,
              data: new TextEncoder().encode(`event: error\ndata: ${message}\n\n`),
              done: false,
            });
            mux.sendProxyChunk({
              requestId: request.requestId,
              data: new Uint8Array(0),
              done: true,
            });
          } else {
            statusCode = 500;
            mux.sendProxyResponse({
              requestId: request.requestId,
              statusCode: 500,
              headers: { "content-type": "text/plain" },
              body: responseBody,
            });
          }
        }

        // Record metering
        const latencyMs = Date.now() - startTime;
        const requestPricing = this.resolveProviderPricing(provider, request);
        if (this._deps.sessionTracker) {
          await this._deps.sessionTracker.recordMetering({
            buyerPeerId,
            providerName: provider.name,
            pricing: requestPricing,
            request,
            statusCode,
            latencyMs,
            inputBytes: request.body.length,
            outputBytes: responseBody.length,
            responseBody,
            providerUsage: responseUsage,
          });
        }

        // Record spend and send NeedAuth with cost data after every request.
        // The buyer validates the cost independently and responds with SpendingAuth.
        if (spm?.hasSession(buyerPeerId)) {
          const usage = responseUsage;
          const costUsdc = computeCostUsdc(usage.freshInputTokens, usage.outputTokens, requestPricing, usage.cachedInputTokens);
          const session = spm.getChannelByPeer(buyerPeerId);
          if (session) {
            spm.recordSpend(session.sessionId, costUsdc);
            const cumulativeSpend = spm.getCumulativeSpend(session.sessionId);
            debugLog(`[SellerHandler] Cost recorded: buyer=${buyerPeerId.slice(0, 12)}... cost=${costUsdc} cumulative=${cumulativeSpend} (in=${usage.inputTokens} cached=${usage.cachedInputTokens} out=${usage.outputTokens})`);

            const accepted = spm.getAcceptedCumulative(session.sessionId);
            const requiredAmount = cumulativeSpend + costUsdc;
            debugLog(`[SellerHandler] Sending NeedAuth: cost=${costUsdc} cumulative=${cumulativeSpend} required=${requiredAmount}`);
            paymentMux.sendNeedAuth({
              channelId: session.sessionId,
              requiredCumulativeAmount: requiredAmount.toString(),
              currentAcceptedCumulative: accepted.toString(),
              deposit: session.authMax ?? '0',
              requestId: request.requestId,
              lastRequestCost: costUsdc.toString(),
              inputTokens: String(usage.inputTokens),
              outputTokens: String(usage.outputTokens),
              cachedInputTokens: String(usage.cachedInputTokens),
              service: this._extractRequestedService(request) ?? undefined,
            });
          }
        }
      } finally {
        this.adjustProviderLoad(provider.name, -1);
      }
    });

    return { mux };
  }

  // -- Local /v1/models handler --

  private _handleModelsRequest(request: SerializedHttpRequest): SerializedHttpResponse {
    const allServices = this._deps.providers.flatMap((p) => p.services);
    const now = Math.floor(Date.now() / 1000);

    // GET /v1/models/:id — single model lookup
    const singleModelMatch = request.path.match(/^\/v1\/models\/(.+)$/);
    if (singleModelMatch) {
      const modelId = decodeURIComponent(singleModelMatch[1]!);
      if (allServices.includes(modelId)) {
        return {
          requestId: request.requestId,
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify({
            id: modelId, object: 'model', created: now, owned_by: 'antseed',
          })),
        };
      }
      return {
        requestId: request.requestId,
        statusCode: 404,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({
          error: { message: `Model '${modelId}' not found`, type: 'invalid_request_error', code: 'model_not_found' },
        })),
      };
    }

    // GET /v1/models — list all
    const models = allServices.map((id) => ({
      id, object: 'model' as const, created: now, owned_by: 'antseed',
    }));
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ object: 'list', data: models })),
    };
  }

  // -- Provider matching (public for announcer pricing in _startSeller) --

  matchProvider(request: SerializedHttpRequest): Provider | undefined {
    const requestedService = this._extractRequestedService(request);
    const requestedProvider = this._extractRequestedProvider(request);
    const providers = this._deps.providers;
    const matchesService = (provider: Provider): boolean =>
      provider.services.length === 0
      || (requestedService !== null && provider.services.includes(requestedService))
      || providers.length === 1;

    let provider: Provider | undefined;
    if (requestedProvider) {
      provider = providers.find((candidate) =>
        candidate.name.toLowerCase() === requestedProvider && matchesService(candidate),
      );
    }
    if (!provider) {
      provider = providers.find((candidate) => matchesService(candidate));
    }
    return provider;
  }

  resolveProviderPricing(
    provider: Provider,
    request: SerializedHttpRequest,
  ): import('./interfaces/seller-provider.js').ProviderTokenPricingUsdPerMillion {
    const requestedService = this._extractRequestedService(request);
    if (requestedService) {
      const servicePricing = provider.pricing.services?.[requestedService];
      if (servicePricing) {
        return servicePricing;
      }
    }
    return provider.pricing.defaults;
  }

  // -- Load tracking --

  adjustProviderLoad(providerName: string, delta: number): void {
    const nextLoad = Math.max(0, (this._providerLoadCounts.get(providerName) ?? 0) + delta);
    this._providerLoadCounts.set(providerName, nextLoad);

    const announcer = this._deps.announcer;
    if (!announcer) return;
    announcer.updateLoad(providerName, nextLoad);
    this._scheduleMetadataRefresh();
  }

  // -- Cleanup --

  clearMetadataRefreshTimer(): void {
    if (this._metadataRefreshTimer) {
      clearTimeout(this._metadataRefreshTimer);
      this._metadataRefreshTimer = null;
    }
    this._providerLoadCounts.clear();
  }

  // -- Private helpers --

  private _parseJsonBody(body: Uint8Array): unknown | null {
    try {
      return JSON.parse(new TextDecoder().decode(body)) as unknown;
    } catch {
      return null;
    }
  }

  private _extractRequestedService(request: SerializedHttpRequest): string | null {
    const contentType = request.headers["content-type"] ?? request.headers["Content-Type"] ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return null;
    }
    const parsed = this._parseJsonBody(request.body);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const service = (parsed as Record<string, unknown>)["model"];
    if (typeof service !== "string" || service.trim().length === 0) {
      return null;
    }
    return service.trim();
  }

  private _extractRequestedProvider(request: SerializedHttpRequest): string | null {
    const providers = Object.entries(request.headers)
      .filter(([header]) => header.toLowerCase() === "x-antseed-provider")
      .map(([, value]) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);

    return providers[0] ?? null;
  }

  private async _executeRequest(
    provider: Provider,
    request: SerializedHttpRequest,
    streamCallbacks?: ProviderStreamCallbacks,
  ): Promise<SerializedHttpResponse> {
    if (streamCallbacks && provider.handleRequestStream) {
      return provider.handleRequestStream(request, streamCallbacks);
    }
    return provider.handleRequest(request);
  }

  private _scheduleMetadataRefresh(): void {
    if (!this._deps.announcer || this._metadataRefreshTimer) {
      return;
    }

    const timer = setTimeout(() => {
      this._metadataRefreshTimer = null;
      const announcer = this._deps.announcer;
      if (!announcer) return;
      void announcer.refreshMetadata().catch((err) => {
        debugWarn(`[SellerHandler] Failed to refresh metadata snapshot: ${err instanceof Error ? err.message : err}`);
      });
    }, METADATA_REFRESH_DEBOUNCE_MS);
    this._metadataRefreshTimer = timer;
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  }
}
