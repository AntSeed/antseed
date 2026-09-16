import type { PeerInfo } from '../types/peer.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../types/http.js';
import type { ConversationIdentity } from '../routing/conversation-identity.js';
import type { ModelRoutingPreferences } from '../routing/model-route-ranking.js';

/**
 * A candidate returned by `Router.selectRoute` — one seller offering one
 * model, already scored and ordered by the router's own objective.
 *
 * The host reconstructs all fields except peerId and serviceId from its
 * own discovery snapshot; plugin-supplied requests and prices are ignored.
 */
export type RouteCandidate = {
  peer: PeerInfo;
  peerId: string;
  /** The model this candidate serves. */
  serviceId: string;
  /** Already model-substituted for this candidate. */
  request: SerializedHttpRequest;
  reputation: number;
  hasCachedInputPricing: boolean;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  minImageUsdPerImage: number | null;
};

export type RouteSelectionContext = {
  routing?: import('../routing/routing-context.js').RoutingRequestContext;
  settings?: Record<string, string>;
  signal: AbortSignal;
  deadlineMs: number;
  candidates?: Array<Pick<RouteCandidate, 'peerId' | 'serviceId' | 'inputUsdPerMillion' | 'outputUsdPerMillion'>>;
  invokeService?: (
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    parseResponse?: (response: SerializedHttpResponse) => Array<Pick<RouteCandidate, 'peerId' | 'serviceId'>>,
  ) => Promise<SerializedHttpResponse>;
};

export interface Router {
  selectPeer(req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null;
  onResult(peer: PeerInfo, result: {
    success: boolean;
    latencyMs: number;
    tokens: number;
    /**
     * Optional, additive token/cost split -- computeResponseTelemetry
     * already computes this at both onResult call sites (buyer-proxy.ts);
     * forwarded here so a router can build a real per-decision ledger
     * without re-deriving it. Absent from older callers; a router that
     * doesn't need it can ignore it entirely.
     */
    freshInputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number | null;
    /**
     * The originating client request's id (`SerializedHttpRequest.requestId`,
     * stable across a peer walk for one client request). `selectRoute`
     * receives the same id via its own `req` param, so a router that keys
     * its pending-decision bookkeeping by requestId instead of peerId alone
     * can correctly pair this result with the decision that produced it,
     * even when two different conversations are concurrently routed to the
     * same peer. Optional/additive -- older callers or routers that don't
     * implement `selectRoute` can ignore it.
     */
    requestId?: string;
  }): void;

  /**
   * Optional, additive: pick both model and seller together, ahead of the
   * usual fixed-model peer narrowing. Called for the initial model of an
   * explicitly router-selected conversation; returning `null` (or not
   * implementing it) falls through to the unmodified `selectPeer` pipeline.
   * An empty array means the router claimed the request but has no route;
   * it must not be treated as a decline. Throw for execution failures.
   * Hosts enforce the context deadline even if a plugin ignores its signal.
   *
   * `req` is the same raw, unmodified request `selectPeer` gets, before any
   * model substitution — a router implementing this parses `req.body` itself
   * to read the model field.
   */
  selectRoute?(
    req: SerializedHttpRequest,
    peers: PeerInfo[],
    conversation: ConversationIdentity | null,
    routingPreferences: ModelRoutingPreferences | null,
    /**
     * The pre-existing "antseed" alias's currently-resolved target
     * (`buyer.state.json`'s `defaultRoutedModel`, `apps/cli/src/proxy/request-utils.ts`'s
     * `ROUTED_MODEL_ALIAS`) -- host-owned state, passed in the same way
     * `conversation` is, so a router never needs a direct dependency on
     * `apps/cli`'s state file to read it. `null` when no default route is
     * set, or for a host that doesn't have this concept at all. Optional
     * param -- existing callers/implementers that don't pass or read a 5th
     * argument are unaffected.
     */
    defaultRoutedModel?: string | null,
    context?: RouteSelectionContext,
  ): Promise<Array<Pick<RouteCandidate, 'peerId' | 'serviceId'> & Partial<RouteCandidate>> | null>;

}

// Duck-typed, not formally part of `Router`, but probed for by buyer-proxy
// when present (existing, unrelated to selectRoute):
//   allowsPeerForPolicy?(req: SerializedHttpRequest, peer: PeerInfo): boolean;
//   allowsPeerForPricing?(req: SerializedHttpRequest, peer: PeerInfo): boolean;
