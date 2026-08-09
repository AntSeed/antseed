import {
  ANTSEED_STREAMING_RESPONSE_HEADER,
  ANTSEED_SPENDING_AUTH_HEADER,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
  type SerializedHttpResponseChunk,
} from "./types/http.js";
import type { PeerInfo, PeerId } from "./types/peer.js";
import type { PeerConnection } from "./p2p/connection-manager.js";
import type { ProxyMux } from "./proxy/proxy-mux.js";
import { PaymentMux } from "./p2p/payment-mux.js";
import { ConnectionState } from "./types/connection.js";
import type { BuyerPaymentNegotiator, SelectedBillingRoute } from "./payments/buyer-payment-negotiator.js";
import { debugLog, debugWarn } from "./utils/debug.js";
import type { VerificationMux } from "./verification/verification-mux.js";
import type { VerificationStorage } from "./verification/storage.js";
import type { VerificationSampler } from "./verification/samples.js";
import type { BuyerFreeUsageManager } from "./payments/buyer-free-usage-manager.js";
import { verifyResponseAuth } from "./verification/response-auth.js";
import { isFreeUnitBillingModel } from "./billing/unit.js";
import type { ServiceApiProtocol } from "./types/service-api.js";
import {
  detectRequestServiceApiProtocol,
  extractRequestBodyFields,
  selectTargetProtocolForRequest,
} from "@antseed/api-adapter";
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1 } from "./types/protocol.js";

export interface RequestStreamResponseMetadata {
  streaming: boolean;
}

export interface RequestStreamCallbacks {
  onResponseStart?: (
    response: SerializedHttpResponse,
    metadata: RequestStreamResponseMetadata,
  ) => void;
  onResponseChunk?: (chunk: SerializedHttpResponseChunk) => void;
}

export interface RequestExecutionOptions {
  signal?: AbortSignal;
  /** Skip payment/free-usage machinery for internal control-plane requests. */
  controlPlane?: boolean;
}

export interface BuyerRequestHandlerConfig {
  requestTimeoutMs?: number;
  maxStreamBufferBytes?: number;
  maxStreamDurationMs?: number;
  responseAuthTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_RESPONSE_AUTH_GRACE_MS = 30_000;

export interface BuyerRequestHandlerDeps {
  localPeerId: PeerId;
  negotiator: BuyerPaymentNegotiator | null;
  freeUsageManager?: BuyerFreeUsageManager | null;
  verificationStorage: VerificationStorage | null;
  verificationSampler: VerificationSampler | null;
  getConnection: (peer: PeerInfo) => Promise<PeerConnection>;
  getMux: (peerId: PeerId, conn: PeerConnection) => ProxyMux;
  getVerificationMux: (peerId: PeerId, conn: PeerConnection) => VerificationMux;
  registerPaymentMux: (peerId: PeerId, mux: PaymentMux) => void;
}

/**
 * Handles buyer-side outbound request execution: connection setup, streaming,
 * timeouts, abort signals, 402 payment negotiation, and cost tracking.
 *
 * Extracted from AntseedNode._sendRequestInternal to separate buyer request
 * orchestration from core node lifecycle.
 */
export class BuyerRequestHandler {
  private readonly _config: BuyerRequestHandlerConfig;
  private readonly _deps: BuyerRequestHandlerDeps;

  constructor(config: BuyerRequestHandlerConfig, deps: BuyerRequestHandlerDeps) {
    this._config = config;
    this._deps = deps;
  }

  async sendRequest(
    peer: PeerInfo,
    req: SerializedHttpRequest,
    callbacks?: RequestStreamCallbacks,
    options?: RequestExecutionOptions,
  ): Promise<SerializedHttpResponse> {
    if (!req.requestId || typeof req.requestId !== "string") {
      throw new Error("requestId must be a non-empty string");
    }

    const opName = callbacks ? "sendRequestStream" : "sendRequest";
    debugLog(`[BuyerRequest] ${opName} ${req.method} ${req.path} → peer ${peer.peerId.slice(0, 12)}... (reqId=${req.requestId.slice(0, 8)})`);

    const conn = await this._deps.getConnection(peer);
    debugLog(`[BuyerRequest] Connection to ${peer.peerId.slice(0, 12)}... state=${conn.state}`);
    const mux = this._deps.getMux(peer.peerId, conn);
    const verificationMux = this._deps.getVerificationMux(peer.peerId, conn);
    const negotiator = options?.controlPlane ? null : this._deps.negotiator;
    if (negotiator) {
      this._deps.registerPaymentMux(peer.peerId, negotiator.getOrCreatePaymentMux(peer.peerId, conn));
    }

    // Extract and strip x-antseed-spending-auth header if present (external auth compatibility)
    const externalSpendingAuth = req.headers[ANTSEED_SPENDING_AUTH_HEADER] ?? null;
    if (externalSpendingAuth) {
      const { [ANTSEED_SPENDING_AUTH_HEADER]: _, ...cleanHeaders } = req.headers;
      req = { ...req, headers: cleanHeaders };
    }

    if (externalSpendingAuth && negotiator) {
      debugLog(`[BuyerRequest] Applying external spending auth for ${peer.peerId.slice(0, 12)}...`);
      await negotiator.applyExternalSpendingAuth(peer, conn, externalSpendingAuth);
    }

    // Track which service the buyer requested so auth validation uses buyer's own pricing.
    const requestedService = options?.controlPlane ? undefined : extractServiceFromBody(req);
    const billingRoute = requestedService ? selectBillingRoute(peer, req, requestedService) : null;
    // Decide free vs paid from the resolved route (provider + protocol), mirroring
    // the seller's per-request gate so both sides classify the request the same way.
    const isFreeService = requestedService
      ? (billingRoute ? isBillingRouteFree(billingRoute) : isPeerServiceFree(peer, requestedService))
      : false;
    if (negotiator && requestedService) {
      if (isFreeService) {
        negotiator.trackFreeUsageRequestService(req.requestId, requestedService);
        try {
          await negotiator.prepareFreeUsageOpen(peer, conn);
        } catch (err) {
          debugWarn(`[BuyerRequest] Failed to prepare free usage channel for ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        const requestProtocol = detectRequestServiceApiProtocol(req);
        if (
          requestProtocol === "openai-images"
          && (
            !billingRoute
            || billingRoute.serviceApiProtocol !== "openai-images"
            || (!billingRoute.unitModel && !isZeroTokenPricing(billingRoute.tokenPricing))
          )
        ) {
          throw new Error(
            `Cannot send paid openai-images request for service "${requestedService}" without service unit billing metadata`,
          );
        }
        negotiator.trackRequestBillingContext(req, requestedService, billingRoute);
      }
    } else if (requestedService && isFreeService && this._deps.freeUsageManager) {
      this._deps.freeUsageManager.trackRequestService(req.requestId, requestedService);
      try {
        this._prepareDirectFreeUsageOpen(peer, conn);
      } catch (err) {
        debugWarn(`[BuyerRequest] Failed to prepare free usage channel for ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
      }
    }

    let startTime = Date.now();

    const executeRequest = (): Promise<SerializedHttpResponse> => new Promise<SerializedHttpResponse>((resolve, reject) => {
      const timeoutMs = this._config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const maxStreamBufferBytes = Math.max(1, this._config.maxStreamBufferBytes ?? 16 * 1024 * 1024);
      const maxStreamDurationMs = Math.max(1, this._config.maxStreamDurationMs ?? 5 * 60_000);
      const streamInitialResponseTimeoutMs = callbacks ? Math.max(timeoutMs, 90_000) : timeoutMs;
      const streamIdleTimeoutMs = Math.max(timeoutMs, 60_000);
      let settled = false;
      let streamStarted = false;
      let streamStartedAtMs = 0;
      let streamBufferedBytes = 0;
      let streamStartResponse: SerializedHttpResponse | null = null;
      const streamChunks: Uint8Array[] = [];
      let activeTimeout: ReturnType<typeof setTimeout> | null = null;
      let activeTimeoutMs = streamInitialResponseTimeoutMs;
      const abortSignal = options?.signal;
      let abortListenerAttached = false;
      let connectionStateListenerAttached = false;
      const hasConnectionStateEvents =
        typeof (conn as { on?: unknown }).on === "function"
        && typeof (conn as { off?: unknown }).off === "function";

      const cleanupAbortListener = (): void => {
        if (abortSignal && abortListenerAttached) {
          abortSignal.removeEventListener("abort", onAbort);
          abortListenerAttached = false;
        }
      };
      const cleanupConnectionListener = (): void => {
        if (!connectionStateListenerAttached) return;
        conn.off("stateChange", onConnectionStateChange);
        connectionStateListenerAttached = false;
      };
      const onConnectionStateChange = (state: ConnectionState): void => {
        if (settled) return;
        if (state !== ConnectionState.Closed && state !== ConnectionState.Failed) {
          return;
        }
        settled = true;
        if (activeTimeout) clearTimeout(activeTimeout);
        cleanupAbortListener();
        cleanupConnectionListener();
        mux.cancelProxyRequest(req.requestId);
        reject(new Error(`Connection to ${peer.peerId} ${state.toLowerCase()} during request ${req.requestId}`));
      };

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        if (activeTimeout) clearTimeout(activeTimeout);
        cleanupAbortListener();
        cleanupConnectionListener();
        debugWarn(`[BuyerRequest] Request ${req.requestId.slice(0, 8)} aborted by caller`);
        mux.cancelProxyRequest(req.requestId);
        reject(new Error(`Request ${req.requestId} aborted`));
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          onAbort();
          return;
        }
        abortSignal.addEventListener("abort", onAbort, { once: true });
        abortListenerAttached = true;
      }
      if (hasConnectionStateEvents) {
        conn.on("stateChange", onConnectionStateChange);
        connectionStateListenerAttached = true;
      }

      const resetTimeout = (ms: number): void => {
        if (activeTimeout) clearTimeout(activeTimeout);
        activeTimeoutMs = ms;
        activeTimeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanupAbortListener();
          cleanupConnectionListener();
          debugWarn(
            `[BuyerRequest] Request ${req.requestId.slice(0, 8)} timed out after ${Date.now() - startTime}ms `
            + `(timeout=${activeTimeoutMs}ms, stream=${callbacks ? "true" : "false"}, streamStarted=${streamStarted ? "true" : "false"}, buffered=${streamBufferedBytes}b)`,
          );
          mux.cancelProxyRequest(req.requestId);
          reject(new Error(`Request ${req.requestId} timed out`));
        }, ms);
      };

      resetTimeout(streamInitialResponseTimeoutMs);

      const finish = (response: SerializedHttpResponse): void => {
        if (settled) return;
        settled = true;
        if (activeTimeout) clearTimeout(activeTimeout);
        cleanupAbortListener();
        cleanupConnectionListener();
        const cleaned = stripStreamingHeader(response);
        debugLog(`[BuyerRequest] Response for ${req.requestId.slice(0, 8)}: status=${cleaned.statusCode} (${Date.now() - startTime}ms, ${cleaned.body.length}b)`);
        resolve(cleaned);
      };

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (activeTimeout) clearTimeout(activeTimeout);
        cleanupAbortListener();
        cleanupConnectionListener();
        reject(error);
      };

      mux.sendProxyRequest(
        req,
        (response: SerializedHttpResponse, metadata) => {
          if (settled) return;
          if (metadata.streamingStart) {
            streamStarted = true;
            streamStartedAtMs = Date.now();
            streamBufferedBytes = 0;
            streamStartResponse = stripStreamingHeader(response);
            debugLog(`[BuyerRequest] Stream started for ${req.requestId.slice(0, 8)}; idle-timeout=${streamIdleTimeoutMs}ms`);
            resetTimeout(streamIdleTimeoutMs);
            callbacks?.onResponseStart?.(streamStartResponse, { streaming: true });
            return;
          }

          callbacks?.onResponseStart?.(stripStreamingHeader(response), { streaming: false });
          finish(response);
        },
        (chunk) => {
          if (settled) return;
          if (!streamStarted) return;

          resetTimeout(streamIdleTimeoutMs);

          if (Date.now() - streamStartedAtMs > maxStreamDurationMs) {
            mux.cancelProxyRequest(req.requestId);
            fail(new Error(`Stream ${req.requestId} exceeded max duration (${maxStreamDurationMs}ms)`));
            return;
          }

          callbacks?.onResponseChunk?.(chunk);

          if (chunk.data.length > 0) {
            if (callbacks?.onResponseChunk) {
              streamBufferedBytes += chunk.data.length;
              streamChunks.push(chunk.data);
            } else {
              const nextBufferedBytes = streamBufferedBytes + chunk.data.length;
              if (nextBufferedBytes > maxStreamBufferBytes) {
                mux.cancelProxyRequest(req.requestId);
                fail(new Error(`Stream ${req.requestId} exceeded max buffered size (${maxStreamBufferBytes} bytes)`));
                return;
              }
              streamBufferedBytes = nextBufferedBytes;
              streamChunks.push(chunk.data);
            }
          }

          if (!chunk.done) return;

          if (!streamStartResponse) {
            fail(new Error(`Stream ${req.requestId} ended before response start`));
            return;
          }

          finish({
            ...streamStartResponse,
            body: concatChunks(streamChunks),
          });
        },
      );
    });

    const response = await executeRequest();

    if (response.statusCode === 402 && negotiator && !externalSpendingAuth) {
      const result = await negotiator.handle402(response, peer, conn, req);
      if (result.action === 'return') return result.response;
      startTime = Date.now();
      const retriedResponse = await executeRequest();
      if (!isFreeService) {
        negotiator.estimateCostFromResponse(peer, retriedResponse, requestedService, req.requestId);
      }
      this._recordResponseAuth(peer, req, retriedResponse, requestedService, verificationMux);
      return retriedResponse;
    }

    if (negotiator && !isFreeService) {
      negotiator.estimateCostFromResponse(peer, response, requestedService, req.requestId);
    }

    this._recordResponseAuth(peer, req, response, requestedService, verificationMux);
    return response;
  }

  private _prepareDirectFreeUsageOpen(peer: PeerInfo, conn: PeerConnection): void {
    const freeUsage = this._deps.freeUsageManager;
    if (!freeUsage) return;

    const pmux = new PaymentMux(conn);
    pmux.onFreeUsageAck((payload) => {
      freeUsage.handleAck(peer.peerId, payload);
    });
    pmux.onNeedFreeUsageAuth((payload) => {
      const p = freeUsage.handleNeedAuth(peer.peerId, payload, pmux);
      p.catch((err) => {
        debugWarn(`[BuyerRequest] Failed to handle free usage auth request from ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
      });
    });
    this._deps.registerPaymentMux(peer.peerId, pmux);
    void freeUsage.prepareOpen(peer, pmux)
      .then(() => freeUsage.waitForOpenAck(peer.peerId))
      .catch((err) => {
        debugWarn(`[BuyerRequest] Free usage open ack unavailable for ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
      });
  }

  private _recordResponseAuth(
    peer: PeerInfo,
    request: SerializedHttpRequest,
    response: SerializedHttpResponse,
    requestedService: string | undefined,
    verificationMux: VerificationMux,
  ): void {
    if (!shouldExpectResponseAuth(peer, response, requestedService)) {
      return;
    }

    const storage = this._deps.verificationStorage;
    const advertisedService = requestedService ?? 'unknown';
    const expectedChannelId = this._deps.negotiator?.bpm?.getActiveSession(peer.peerId)?.sessionId ?? null;
    const responseAuthPromise = verificationMux.waitForResponseAuth(
      request.requestId,
      this._config.responseAuthTimeoutMs ?? DEFAULT_RESPONSE_AUTH_GRACE_MS,
    );

    void responseAuthPromise
      .then((payload) => {
        const verification = verifyResponseAuth(payload, {
          request,
          response,
          buyerPeerId: this._deps.localPeerId,
          sellerPeerId: peer.peerId,
          advertisedService,
          channelId: expectedChannelId,
        });

        if (!verification.valid) {
          debugWarn(
            `[BuyerRequest] Invalid ResponseAuth for ${request.requestId.slice(0, 8)} from ${peer.peerId.slice(0, 12)}...: ${verification.reason ?? 'unknown'}`,
          );
        }

        storage?.insertResponseAuth({
          ...payload,
          receivedAt: Date.now(),
          verified: verification.valid,
          verificationError: verification.reason ?? null,
        });

        void this._deps.verificationSampler?.maybeStoreResponseAuthSample({
          request,
          response,
          responseAuth: payload,
          verified: verification.valid,
          verificationError: verification.reason ?? null,
        }).catch((err) => {
          debugWarn(`[BuyerRequest] Failed to store ResponseAuth sample for ${request.requestId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
        });
      })
      .catch((err) => {
        debugWarn(`[BuyerRequest] Missing ResponseAuth for ${request.requestId.slice(0, 8)} from ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
      });
  }
}

/** Extract the service/model name from a JSON or multipart request body, or undefined if not found. */
function extractServiceFromBody(request: SerializedHttpRequest): string | undefined {
  const parsed = extractRequestBodyFields(request.headers, request.body);
  const service = parsed?.service ?? parsed?.model;
  if (typeof service === 'string' && service.length > 0) return service;
  return undefined;
}

function selectBillingRoute(
  peer: PeerInfo,
  request: SerializedHttpRequest,
  service: string,
): SelectedBillingRoute | null {
  const provider = selectProviderForService(peer, service, extractRequestedProvider(request));
  if (!provider) return null;
  const serviceApiProtocol = selectProtocolForService(peer, provider, service, request);
  const unitModel = peer.providerServiceUnitBillingModels?.[provider]?.services[service]?.[serviceApiProtocol];
  const tokenPricing = selectTokenPricing(peer, provider, service);
  return {
    sellerPeerId: peer.peerId,
    provider,
    service,
    serviceApiProtocol,
    ...(unitModel ? { unitModel } : {}),
    ...(tokenPricing ? { tokenPricing } : {}),
  };
}

function selectProviderForService(
  peer: PeerInfo,
  service: string,
  requestedProvider: string | null,
): string | null {
  const providers = peer.providers ?? [];
  if (requestedProvider) {
    const provider = providers.find(
      (candidate) => candidate.toLowerCase() === requestedProvider,
    );
    if (provider && providerOffersService(peer, provider, service)) {
      return provider;
    }
    return null;
  }

  const match = providers.find((provider) =>
    providerOffersService(peer, provider, service),
  );
  return match ?? providers[0] ?? null;
}

function providerOffersService(peer: PeerInfo, provider: string, service: string): boolean {
  return Boolean(
    peer.providerPricing?.[provider]?.services?.[service]
    || peer.providerServiceUnitBillingModels?.[provider]?.services[service]
    || peer.providerServiceApiProtocols?.[provider]?.services[service]
    || peer.providerServiceCategories?.[provider]?.services[service],
  );
}

function selectProtocolForService(
  peer: PeerInfo,
  provider: string,
  service: string,
  request: SerializedHttpRequest,
): ServiceApiProtocol {
  const protocols =
    peer.providerServiceApiProtocols?.[provider]?.services[service];
  const billingProtocols = Object.keys(
    peer.providerServiceUnitBillingModels?.[provider]?.services[service] ?? {},
  ) as ServiceApiProtocol[];
  const candidates = protocols ?? billingProtocols;
  const requestProtocol = detectRequestServiceApiProtocol(request);
  const selected = selectTargetProtocolForRequest(requestProtocol, candidates);
  if (selected) return selected.targetProtocol;
  if (protocols?.[0]) return protocols[0];
  return billingProtocols[0] ?? "openai-chat-completions";
}

function selectTokenPricing(
  peer: PeerInfo,
  provider: string,
  service: string,
): SelectedBillingRoute["tokenPricing"] {
  const providerPricing = peer.providerPricing?.[provider];
  const pricing = providerPricing?.services?.[service] ?? providerPricing?.defaults;
  if (pricing) return pricing;
  return peerDefaultPricing(peer);
}

function peerDefaultPricing(peer: PeerInfo): SelectedBillingRoute["tokenPricing"] {
  if (peer.defaultInputUsdPerMillion == null && peer.defaultOutputUsdPerMillion == null) {
    return undefined;
  }
  return {
    inputUsdPerMillion: peer.defaultInputUsdPerMillion ?? 0,
    outputUsdPerMillion: peer.defaultOutputUsdPerMillion ?? 0,
    cachedInputUsdPerMillion: peer.defaultCachedInputUsdPerMillion,
  };
}

function isZeroTokenPricing(pricing: SelectedBillingRoute["tokenPricing"]): boolean {
  return Boolean(
    pricing
    && pricing.inputUsdPerMillion === 0
    && pricing.outputUsdPerMillion === 0
    && (pricing.cachedInputUsdPerMillion == null || pricing.cachedInputUsdPerMillion === 0),
  );
}

function extractRequestedProvider(request: SerializedHttpRequest): string | null {
  const providers = Object.entries(request.headers)
    .filter(([header]) => header.toLowerCase() === "x-antseed-provider")
    .map(([, value]) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);

  return providers[0] ?? null;
}

function stripStreamingHeader(response: SerializedHttpResponse): SerializedHttpResponse {
  if (response.headers[ANTSEED_STREAMING_RESPONSE_HEADER] !== "1") {
    return response;
  }
  const headers = { ...response.headers };
  delete headers[ANTSEED_STREAMING_RESPONSE_HEADER];
  return { ...response, headers };
}

function shouldExpectResponseAuth(
  peer: PeerInfo,
  response: SerializedHttpResponse,
  requestedService: string | undefined,
): boolean {
  if (!requestedService) return false;
  if (response.statusCode === 402) return false;
  return peer.capabilities?.includes(CONNECTION_CAPABILITY_RESPONSE_AUTH_V1) === true;
}

/**
 * Free/paid gate for a resolved billing route. Mirrors the seller's
 * per-request gate (seller-request-handler isFreeService): free iff the
 * resolved token pricing is zero AND the unit model resolved for the selected
 * protocol is absent or free.
 */
function isBillingRouteFree(route: SelectedBillingRoute): boolean {
  return isZeroTokenPricing(route.tokenPricing)
    && (!route.unitModel || isFreeUnitBillingModel(route.unitModel));
}

/** Fallback gate when no billing route could be resolved for the service. */
function isPeerServiceFree(peer: PeerInfo, service: string): boolean {
  // Unit-billed services (e.g. images) can have zero token pricing but still
  // charge per unit — stay conservative when any announced model is paid.
  for (const providerModels of Object.values(peer.providerServiceUnitBillingModels ?? {})) {
    const serviceModels = providerModels.services[service];
    if (!serviceModels) continue;
    for (const model of Object.values(serviceModels)) {
      if (model && !isFreeUnitBillingModel(model)) return false;
    }
  }
  const servicePricing = findPeerServicePricing(peer, service);
  if (!servicePricing) return false;
  return (servicePricing.inputUsdPerMillion ?? 0) === 0
    && (servicePricing.outputUsdPerMillion ?? 0) === 0
    && (servicePricing.cachedInputUsdPerMillion ?? 0) === 0;
}

function findPeerServicePricing(peer: PeerInfo, service: string): {
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cachedInputUsdPerMillion?: number;
} | null {
  for (const providerPricing of Object.values(peer.providerPricing ?? {})) {
    const servicePricing = providerPricing.services?.[service];
    if (servicePricing) return servicePricing;
  }
  if (peer.defaultInputUsdPerMillion != null || peer.defaultOutputUsdPerMillion != null) {
    return {
      inputUsdPerMillion: peer.defaultInputUsdPerMillion ?? 0,
      outputUsdPerMillion: peer.defaultOutputUsdPerMillion ?? 0,
      cachedInputUsdPerMillion: peer.defaultCachedInputUsdPerMillion,
    };
  }
  return null;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
