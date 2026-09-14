import type { PeerInfo } from '../types/peer.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../types/http.js';
import type { ConversationIdentity } from '../routing/conversation-identity.js';
import type { ModelRoutingPreferences } from '../routing/model-route-ranking.js';

/**
 * A candidate returned by `Router.selectRoute` — one seller offering one
 * model, already scored and ordered by the router's own objective.
 *
 * Same shape buyer-proxy already builds internally for the existing
 * fixed-model pipeline (buyer-proxy.ts:2392-2429) — `selectRoute` produces
 * the cross-model equivalent.
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

/**
 * Proves who is actually sending a `/_antseed/route` (or `/_antseed/route/digest`)
 * request -- a `RouteRequestAuth` EIP-712 signature (`@antseed/protocol`'s
 * `signRouteRequestAuth`/`recoverRouteRequestAuthSigner`) plus the plain
 * fields needed to reconstruct and verify it. `buyer` is the signing
 * address, which is also the buyer's `PeerId` (`peerIdToAddress`) -- a
 * verifying routing peer checks the recovered signer against
 * `'0x' + x-antseed-buyer-peer-id`, not just that a signature is present.
 */
export type RouteAuthHeaders = {
  buyer: string;
  /** Unix seconds. */
  issuedAt: number;
  /** 0x-prefixed 32-byte hex. */
  nonce: string;
  signature: string;
};

/**
 * One resolved routing decision, predicted vs. actual -- the shape a
 * `selectRoute`-implementing router's local ledger is expected to produce,
 * so a host UI (e.g. VPR's savings dashboard) can read it generically
 * without depending on any one router package. Not a billing record: real
 * settlement is governed by the signed SpendingAuth, not by anything this
 * row displays.
 */
export type RoutingDecisionRow = {
  atMs: number;
  actualModel: string;
  actualPeer: string;
  actualPromptTokens: number;
  actualCachedTokens: number;
  actualCompletionTokens: number;
  actualUsdcPaid: number;
  predictedCostUsd: number | null;
  predictedInputTokens: number | null;
  predictedCachedInputTokens: number | null;
  predictedOutputTokens: number | null;
  cqt: number;
  routingLatencyMs: number | null;
  /**
   * A price snapshot for each fixed, curated baseline/dropdown model that
   * was actually present in this decision's ranked response -- collapsed
   * across peers to the best available offer per model, keyed by model
   * name. Absent entirely for a baseline model that wasn't offered at the
   * moment of this decision. Lets a savings dashboard compare "actual paid"
   * against one fixed reference model's real AntSeed price at the time of
   * THIS decision, without needing to hold a live price table or re-fetch
   * anything.
   */
  baselinePrices: Record<string, { inUsdPerM: number; outUsdPerM: number; cachedInUsdPerM: number | null }>;
  /**
   * The `ConversationIdentity.sessionKey` in scope when this decision was
   * made, or `null` when no identity was available (e.g. a CLI-only caller
   * with no per-chat headers). Lets a host UI filter this router's ledger
   * down to one conversation's history (a per-session drill-down alongside
   * the aggregate savings dashboard) without any router-specific plumbing --
   * same "generic, read via `getRoutingDecisions`" reasoning as the rest of
   * this type. Deliberately the bare `sessionKey`, not a tool-qualified
   * `${tool}:${sessionKey}` key: the desktop app's own conversation id is
   * exactly this value for VPR chats (`x-vpr-session-id`'s header value,
   * apps/desktop/src/main/chat/proxy-service.ts), so a host can compare
   * directly against its own conversation id with no reconstruction.
   * `null` on rows persisted before this field existed.
   */
  conversationKey: string | null;
  /**
   * The top few candidates the routing peer actually offered for this
   * decision, in the peer's own ranked order (not re-sorted) -- lets a host
   * UI show "what else was considered" for a historical turn, not just the
   * winner. Capped to a small number by the router before this is recorded
   * (not this type's concern how many); empty for a reused/pinned dispatch
   * that never made a fresh routing call, and for rows persisted before
   * this field existed.
   */
  consideredCandidates: Array<{
    model: string;
    peer: string;
    inUsdPerM: number;
    outUsdPerM: number;
    cachedInUsdPerM: number | null;
  }>;
  /**
   * The same trimmed excerpt of the last user turn already sent to the
   * routing peer as `RouteRequestBody.inputMessage` -- recording it locally
   * is not a new exposure (it already left the machine over the wire), just
   * new local retention, so a host UI can show what prompt a historical
   * decision was actually made for. `null` when unavailable (no
   * conversation content to trim) or for rows persisted before this field
   * existed.
   */
  inputMessagePreview: string | null;
};

/**
 * Interface that buyer nodes implement for peer selection.
 *
 * The SDK discovers available sellers via DHT. Your router decides
 * which seller to send each request to based on price, latency,
 * reputation, capacity, or any custom logic.
 *
 * If you don't provide a router, the SDK uses a default that selects
 * the cheapest peer with reputation above a minimum threshold.
 */
export type RouteSelectionContext = {
  settings?: Record<string, string>;
  signal: AbortSignal;
  deadlineMs: number;
  candidates?: Array<Pick<RouteCandidate, 'peerId' | 'serviceId' | 'inputUsdPerMillion' | 'outputUsdPerMillion'>>;
  invokeService?: (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => Promise<SerializedHttpResponse>;
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
   * usual fixed-model peer narrowing. Called unconditionally by buyer-proxy
   * whenever the registered router implements it; returning `null` (or not
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
  ): Promise<RouteCandidate[] | null>;

  /**
   * Optional, additive: the router's local `routing_decisions` ledger, if
   * it keeps one -- read by the host (buyer-proxy's
   * `/_antseed/routing-decisions` local admin endpoint) so a UI's savings
   * dashboard can render it without any router-specific plumbing. A router
   * that doesn't implement `selectRoute` has no reason to implement this
   * either.
   */
  getRoutingDecisions?(): RoutingDecisionRow[];

  /**
   * Optional, additive: a router that needs daily/periodic payment-signing
   * capability (e.g. a day-pass-priced routing peer) implements this to
   * receive a host-provided signing function, called once by the host after
   * loading and after payments are configured. Generic across any router
   * that needs this, not specific to any one router package -- the router
   * never holds a BuyerPaymentManager or PaymentMux reference directly
   * (that would let plugin code, including third-party routers, sign
   * arbitrary messages); the host builds and owns the actual signing
   * closure.
   */
  configureDailySigning?(signDailyIfNeeded: (sellerPeerId: string) => Promise<void>): void;

  /**
   * Optional, additive: pushed by the host whenever live `buyer.routingPreferences`
   * changes (buyer-proxy's config-file watcher), including once at startup if
   * preferences were supplied at construction. `selectRoute` already receives
   * a fresh `routingPreferences` on every call, but not every `selectRoute`
   * call passes one (e.g. a concretely-chosen model) -- a router that needs
   * live preference state to still be current on such a call (e.g. gating
   * postpaid daily signing on an explicit day-pass-enable toggle) implements
   * this to receive preference changes independent of any one `selectRoute`
   * call. A router that only ever needs `routingPreferences` inside
   * `selectRoute` has no reason to implement this.
   */
  updateRoutingPreferences?(preferences: ModelRoutingPreferences): void;

  /**
   * Optional, additive: a router that talks to a routing peer over a bare,
   * unauthenticated HTTP endpoint implements this to receive a
   * host-provided signing function, called once by the host after loading.
   * Same key-custody rule as `configureDailySigning` -- the router never
   * holds a real signing key directly, so the host signs and hands back
   * only the resulting auth fields. `signRouteAuth` takes the routing
   * peer's own PeerId (which the router already knows) since only the
   * router knows which peer it's about to call; the returned signature is
   * bound to that specific peer and cannot be replayed against another.
   */
  configureRouteAuthSigning?(signRouteAuth: (routingPeerId: string) => Promise<RouteAuthHeaders>): void;

  /**
   * Optional, additive: a router that talks to its own routing peer over a
   * separately-configured HTTP endpoint can implement this to receive a
   * host-provided P2P peer lookup, called once by the host after the node
   * has actually started (the router's own construction, via `createRouter`,
   * happens before that -- no live lookup capability exists yet at that
   * point). Generic across any router that needs to resolve a peerId to a
   * network host -- this capability isn't specific to any one router
   * package, unlike whatever the router itself does with the resolved host
   * (e.g. combining it with its own well-known port to build a full URL).
   * `null` means "not found this attempt," not an error.
   */
  configureRoutingPeerHostResolution?(resolveHost: (peerId: string) => Promise<string | null>): void;

  /**
   * Optional, additive: cache "warmth" observation feed. `onResult`'s
   * shared shape carries `cachedInputTokens` but not `conversation`/the
   * resolved model, so a router that estimates per-conversation cache hits
   * (to predict a candidate's real cost before dispatch) needs this
   * separate call instead -- called by the host after a successful
   * response, alongside `onResult`, with the concrete resolved model (not a
   * router-specific sentinel) and the peer actually dispatched to. A router
   * with no cache-warmth estimator has no reason to implement this.
   */
  recordObservedCache?(
    conversation: ConversationIdentity,
    model: string,
    peerId: string,
    promptTokens: number,
    cachedInputTokens: number,
  ): void;
}

// Duck-typed, not formally part of `Router`, but probed for by buyer-proxy
// when present (existing, unrelated to selectRoute):
//   allowsPeerForPolicy?(req: SerializedHttpRequest, peer: PeerInfo): boolean;
//   allowsPeerForPricing?(req: SerializedHttpRequest, peer: PeerInfo): boolean;
