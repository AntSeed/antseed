import type {
  ConversationIdentity,
  ModelRoutingPreferences,
  PeerInfo,
  RouteAuthHeaders,
  RouteCandidate,
  RouteSelectionContext,
  SerializedHttpRequest,
} from '@antseed/node';
import { ConversationState, pinnedToRouteCandidate, type PinnedDecision } from './conversation-state.js';
import { RoutingLedger, type RoutingDecisionRow } from './ledger.js';
import { buildDigest, periodKey } from './digest.js';
import { RoutingContextTracker } from '@antseed/node';

export interface LevantoRouterConfig {
  /**
   * Base URL of the routing peer's HTTP surface, e.g. http://127.0.0.1:8787.
   * Optional: an explicit value here always wins (a real static override,
   * e.g. for local devnet, where DHT discovery is deliberately disabled),
   * but with none given, `selectRoute` discovers it
   * lazily from `sellerPeerId` via `resolveRoutingPeerHost` instead of
   * requiring host code to know and inject a specific URL up front.
   */
  routingPeerUrl?: string;
  /**
   * The routing peer's own peerId -- who the daily SpendingAuth is signed
   * against, and what `resolveRoutingPeerHost` below looks up when
   * `routingPeerUrl` isn't explicitly configured. Defaults to this plugin's
   * own real mainnet routing peer if omitted (see `DEFAULT_SELLER_PEER_ID`)
   * -- host code only needs to override this for a non-default deployment
   * (devnet, a different routing peer entirely), not for the common case.
   */
  sellerPeerId?: string;
  /**
   * Resolves a peerId to its current network host (no port, no scheme) via
   * a real P2P/DHT lookup -- host-provided (`AntseedNode.findPeer`), wired
   * in via `configureRoutingPeerHostResolution` once the node has actually
   * started (this plugin's own `createRouter` runs before that, so it can't
   * do this lookup itself at construction time). Generic on purpose: this
   * capability isn't Levanto-specific, any router plugin needing to find a
   * peer by id could use the same shape. This plugin supplies its own
   * well-known HTTP port (`DEFAULT_ROUTING_PEER_HTTP_PORT`) to turn the
   * resolved host into a full URL -- the port is this plugin's own
   * operational detail, not something host code should need to know either.
   * `null` means "not found this attempt," not an error -- selectRoute
   * falls through to a clear "no routing peer URL available" failure rather
   * than guessing.
   */
  resolveRoutingPeerHost?: (peerId: string) => Promise<string | null>;
  /**
   * This buyer's own peerId, sent as `x-antseed-buyer-peer-id` on every
   * `/_antseed/route`/`/_antseed/route/digest` call. `routingPeerUrl` is a
   * bare, unauthenticated HTTP endpoint -- there is no wire mechanism for
   * the routing peer to otherwise learn who's asking -- so without this
   * the day pass gate has no buyerPeerId to check `hasSession`/
   * `getChannelByPeer` against at all. A client-supplied, unverified header
   * is not a real authentication mechanism -- anyone who can reach
   * `routingPeerUrl` could claim to be any buyer. Genuinely open: how this
   * channel gets authenticated for real (a routing-peer-side P2P bridge, a
   * signed header, TLS client certs, or something else) is unresolved.
   * Omitted -- the routing peer gets no buyerPeerId, so the
   * day pass gate always rejects.
   */
  buyerPeerId?: string;
  /**
   * Proves `buyerPeerId` is genuine -- set via `configureRouteAuthSigning`.
   * Deliberately narrow, same reasoning as `signDailyIfNeeded` below: this
   * plugin never holds a signing key directly. Omitted -- requests carry no
   * auth headers; a verifying routing peer treats that as unauthenticated,
   * not as a hard failure -- a deliberate rollout choice, since an old
   * client or a signing hiccup must still be able to route.
   */
  signRouteAuth?: (routingPeerId: string) => Promise<RouteAuthHeaders>;
  /**
   * Postpaid day-pass signing: called strictly on demand, never on a
   * schedule -- either reacting to a 402 (a genuinely new buyer, or one who
   * was already flagged for a renewal and didn't pay before their next
   * request) or fire-and-forget right after a successful response flags
   * `renewalDue`. Deliberately narrow -- this plugin never holds a
   * BuyerPaymentManager or PaymentMux reference directly -- handing a
   * signing key to plugin code, including third-party ones, would let it
   * sign arbitrary messages. The host implements this by calling the real
   * BuyerPaymentManager.signCumulativeAuth and sending the result over
   * PaymentMux -- see apps/cli/src/proxy/day-pass-signing.ts,
   * wired in via configureDailySigning at apps/cli/src/cli/commands/buyer/start.ts.
   */
  signDailyIfNeeded?: (sellerPeerId: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  /**
   * Bounds a hung connection, not just a refused one -- plain fetch() has no
   * default timeout, so an unresponsive (not just unreachable) routing peer
   * would otherwise hang selectRoute indefinitely. Default chosen to sit
   * comfortably under typical chat-completion client timeouts.
   */
  routeTimeoutMs?: number;
  /**
   * Buyer data directory for persisting the routing_decisions ledger --
   * mirrors the `join(dataDir, 'payments')`/
   * `join(dataDir, 'conversations.json')` convention `ChannelStore`/
   * `ConversationStore` already use (apps/cli/src/cli/commands/metrics.ts,
   * apps/cli/src/proxy/conversation-store.ts). Omitted -- the ledger stays
   * in-memory only; not a regression, just no durability without a
   * directory to write to.
   */
  dataDir?: string;
  /**
   * This buyer's configured chain (`payments.crypto.chainId`), e.g.
   * `base-local`/`base-sepolia`/`base-mainnet` -- generic host-injected
   * config every router plugin receives the same way (via `ANTSEED_CHAIN_ID`
   * in `index.ts`'s configSchema), same idea as `buyerPeerId` above. Used
   * only to pick this plugin's own devnet-vs-mainnet defaults below --
   * this plugin's own local devnet routing-peer identity is its own
   * operational knowledge, not something host code should hardcode.
   * Omitted or any real chain -- behaves exactly as if devnet didn't exist.
   */
  chainId?: string;
}

const DEFAULT_ROUTE_TIMEOUT_MS = 3000;

/**
 * This plugin's own real mainnet routing peer -- Levanto's own operational
 * identity, not something a generic host should need to hardcode/inject.
 * Host code only needs to override `sellerPeerId` for a non-default
 * deployment (devnet, a different routing peer entirely).
 */
const DEFAULT_SELLER_PEER_ID = '4c63288576d1befdbdd5f4734b4c9d4c3d8791be';

/**
 * This plugin's own local devnet test-harness routing peer -- the mock
 * seller `local-peer-daemon.ts` runs as, on the same well-known port as the
 * real mainnet peer. Which peer identity a given chain resolves to is this
 * plugin's own operational knowledge, not something host code should
 * hardcode. Applies only when `chainId` is `base-local` and neither
 * `sellerPeerId` nor `routingPeerUrl` is explicitly overridden.
 */
const DEFAULT_DEVNET_SELLER_PEER_ID = 'c199453fd6b1c6823634ef9b3702eb5aeca71265';
const DEFAULT_DEVNET_ROUTING_PEER_URL = 'http://127.0.0.1:8787';

/**
 * The port this plugin's own `/_antseed/route` HTTP listener runs on --
 * stable across environments (see levanto-routing-server's local-peer-daemon.ts),
 * so a discovered host (via `resolveRoutingPeerHost`) only needs combining
 * with this one known constant to become a full URL. Not announced over the
 * wire anywhere (the DHT/P2P signaling address uses a different port
 * entirely) -- this is this plugin's own convention, so it's the plugin's
 * job to know it, not the host's.
 */
const DEFAULT_ROUTING_PEER_HTTP_PORT = 8787;

function calendarDayKey(now = new Date()): string {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

// Wire schema for the routing peer's HTTP contract. Kept local to this
// plugin -- it's the public contract, not proprietary, but there's no
// shared package for it yet.
interface RouteRequestBody {
  v: 1;
  cqt: number;
  inputMessage: string;
  promptTokens: number;
  expectedCachedTokens: Array<{ model: string; peer: string; tokens: number }>;
  constraints: {
    maxInputUsdPerMillion?: number;
    minTrustScore?: number;
    allowedPeerIds?: string[];
    blockedPeerIds?: string[];
  };
}

interface RouteResponseBody {
  v: 1;
  ranked: Array<{
    model: string;
    peer: string;
    estimate: { costUsd: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
    price: { inUsdPerM: number; outUsdPerM: number; cachedInUsdPerM: number };
  }>;
  router: string;
  /**
   * Postpaid day-pass renewal: the seller flags this on an otherwise-normal
   * 200 instead of withholding the
   * response -- true the first time the buyer's rolling 24h window has
   * lapsed since it was last renewed. `selectRoute` reacts by signing
   * fire-and-forget, AFTER already returning this response to its own
   * caller. Absent (older seller, or this specific request didn't cross the
   * window) means no action needed. If the buyer ignores it, the seller
   * blocks the buyer's NEXT request with a 402 until they pay -- same
   * reactive sign-then-retry the buyer already does for a brand-new
   * session, see the 402 handling below.
   */
  renewalDue?: boolean;
}

/**
 * Default pre-selected comparison model for a future savings-page dropdown
 * -- not a limit on which models get a price snapshot
 * (computeBaselinePrices below covers every model actually ranked), just
 * which one a comparison UI opens on before the user picks a different
 * one. `claude-opus-5` matches `recommended.ts`
 * (apps/desktop/src/renderer/modules/catalog/recommended.ts)'s own
 * flagship-tier slot -- the most expensive, most capable flagship, the top
 * GPT or Claude model.
 */
export const DEFAULT_BASELINE_MODELS: readonly string[] = ['claude-opus-5', 'gpt-5.6-sol'];

/**
 * This plugin's auto-routing sentinel -- the one canonical declaration.
 * `selectRoute` below checks the requested model against this exact value,
 * `index.ts`'s plugin manifest declares it as `autoRouteServiceId` from
 * here, and this file's own tests import it too, so nothing re-types the
 * same string literal independently.
 */
export const LEVANTO_AUTO_SERVICE_ID = 'levanto-auto';

/**
 * Matches the serviceId the routing peer itself advertises
 * (levanto-routing-server's DayPassPriceAdProvider) -- attributes this
 * plugin's flat-fee day pass in SpendingAuthMetadata.services[] (v4) instead
 * of leaving it unattributed. Declared here (`index.ts`'s manifest exposes it
 * as `AntseedRouterPlugin.dailyPassServiceId`) so host code (apps/cli's
 * buyer start command) reads it generically instead of hardcoding a
 * router-levanto-specific string.
 */
export const LEVANTO_DAILY_PASS_SERVICE_ID = 'levanto-router-day-pass';

type BaselinePrices = Record<string, { inUsdPerM: number; outUsdPerM: number; cachedInUsdPerM: number | null }>;
type ConsideredCandidates = Array<{ model: string; peer: string; inUsdPerM: number; outUsdPerM: number; cachedInUsdPerM: number | null }>;

/**
 * One entry per DISTINCT model actually present in this decision's ranked
 * response -- every candidate the routing peer offered, not just a curated
 * subset -- collapsed across peers to the best available offer (decisions
 * doc SS2.5) -- "best" here means lowest inUsdPerM, the simplest defensible
 * single-axis choice absent a fixed token mix to combine input and output
 * into one true total cost. Covering every ranked model (not just
 * DEFAULT_BASELINE_MODELS) is deliberate: a future comparison dropdown needs
 * real price data for whatever model the user picks, not just the two
 * pre-selected ones.
 */
function computeBaselinePrices(ranked: RouteResponseBody['ranked']): BaselinePrices {
  const out: BaselinePrices = {};
  const models = new Set(ranked.map((entry) => entry.model));
  for (const model of models) {
    let best: RouteResponseBody['ranked'][number] | null = null;
    for (const entry of ranked) {
      if (entry.model !== model) continue;
      if (!best || entry.price.inUsdPerM < best.price.inUsdPerM) best = entry;
    }
    if (best) {
      out[model] = {
        inUsdPerM: best.price.inUsdPerM,
        outUsdPerM: best.price.outUsdPerM,
        cachedInUsdPerM: best.price.cachedInUsdPerM > 0 ? best.price.cachedInUsdPerM : null,
      };
    }
  }
  return out;
}

/** Bounds how many candidates a ledger row retains -- generous for a "top few options" drill-down, small enough the on-disk ledger doesn't balloon per row. */
const MAX_CONSIDERED_CANDIDATES = 10;

/**
 * The routing peer's own top candidates, in its own ranked order (not
 * re-sorted here) -- so a host UI can show "what else was considered" for
 * a historical decision. Capped, not the full response: `ranked` can be
 * arbitrarily long, and nothing downstream needs more than a handful.
 */
function topConsideredCandidates(ranked: RouteResponseBody['ranked']): ConsideredCandidates {
  return ranked.slice(0, MAX_CONSIDERED_CANDIDATES).map((entry) => ({
    model: entry.model,
    peer: entry.peer,
    inUsdPerM: entry.price.inUsdPerM,
    outUsdPerM: entry.price.outUsdPerM,
    cachedInUsdPerM: entry.price.cachedInUsdPerM > 0 ? entry.price.cachedInUsdPerM : null,
  }));
}

/** Head+tail trim, matching the "trimmed last user turn" shape inputMessage expects. */
const INPUT_MESSAGE_HEAD_TAIL_CHARS = 4096;

function trimForInputMessage(text: string): string {
  if (text.length <= INPUT_MESSAGE_HEAD_TAIL_CHARS * 2) return text;
  return `${text.slice(0, INPUT_MESSAGE_HEAD_TAIL_CHARS)}…${text.slice(-INPUT_MESSAGE_HEAD_TAIL_CHARS)}`;
}

function parseChatBody(req: SerializedHttpRequest): { model: string | undefined; lastUserText: string } {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(Buffer.from(req.body).toString('utf-8'));
  } catch {
    return { model: undefined, lastUserText: '' };
  }
  const model = typeof parsed['model'] === 'string' ? (parsed['model'] as string) : undefined;
  const messages = Array.isArray(parsed['messages']) ? (parsed['messages'] as Array<Record<string, unknown>>) : [];
  const lastUser = [...messages].reverse().find((m) => m['role'] === 'user');
  const content = lastUser?.['content'];
  const lastUserText = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : '')).join(' ')
      : '';
  return { model, lastUserText };
}

/** Very rough token estimate (chars/4) -- a real tokenizer is a further refinement, not this pass's scope. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Not parentSessionKey-preferred. */
function conversationKey(conversation: ConversationIdentity): string {
  return `${conversation.tool}:${conversation.sessionKey}`;
}

/**
 * Thrown by `selectRoute` when it can't produce a real routing decision for
 * an Auto request. Returning `null` here falls through to the existing
 * fixed-model peer-selection pipeline, which can't resolve
 * `"levanto-auto"` as a real model and fails a moment later with a
 * confusing, generic "no candidates for this model" error instead of a
 * clear one. `null` is still returned, unmodified, for the one case where
 * declining is actually correct: the request's model isn't the Auto
 * sentinel at all (the very first check in `selectRoute`).
 *
 * Covers both `kind`s that are meant to reject cleanly rather than fall
 * through: `'unreachable'` (the routing peer couldn't be reached, or didn't
 * respond within `routeTimeoutMs`) and `'rejected'` (the routing peer
 * responded but declined the request, e.g. 402 "no active session" or
 * "renewal required").
 */
export class RoutingPeerError extends Error {
  constructor(
    public readonly kind: 'unreachable' | 'rejected',
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'RoutingPeerError';
  }
}

export class LevantoRouter {
  private readonly conversations = new ConversationState();
  private readonly ledger: RoutingLedger;
  private signingInFlight: Promise<void> | null = null;
  private lastDigestSentDayKey: string | null = null;
  /**
   * Most recently seen `routingPreferences` -- kept fresh from two paths:
   * the host's `updateRoutingPreferences` push (fires on config-file change,
   * including once at startup) and every `selectRoute` call that receives a
   * non-null `routingPreferences` parameter. Needed because `signDayPassOnDemand`
   * (called from inside `selectRoute`, but taking no parameters of its own)
   * reads this cache rather than a passed-in value -- a `selectRoute` call for
   * a concretely-chosen model, or any other call site with nothing fresh to
   * hand over, passes `null` and relies on whatever was cached last.
   */
  private cachedRoutingPreferences: ModelRoutingPreferences | null = null;
  /**
   * Cached result of `resolveRoutingPeerHost`, so a real DHT lookup happens
   * at most once per lapse, not on every single routing call -- routing
   * fires on every prompt, unlike day-pass signing's own once-roughly-daily
   * cadence. Cleared on an 'unreachable' failure (the seller may have moved
   * or restarted with a new address) so the NEXT call re-discovers instead
   * of retrying the same stale host forever; never cleared just because time
   * passed, since a seller's address is normally stable.
   */
  private discoveredRoutingPeerHost: string | null = null;
  private routingPeerHostResolutionInFlight: Promise<string | null> | null = null;

  constructor(private readonly config: LevantoRouterConfig) {
    this.ledger = new RoutingLedger(config.dataDir);
  }
  private readonly routingContext = new RoutingContextTracker();

  /** `chainId === 'base-local'` -- this plugin's own local devnet test harness, see DEFAULT_DEVNET_SELLER_PEER_ID's doc comment. */
  private get isDevnet(): boolean {
    return this.config.chainId === 'base-local';
  }

  /** This plugin's own default if host code doesn't override it -- see DEFAULT_SELLER_PEER_ID's own doc comment. */
  private get effectiveSellerPeerId(): string {
    return this.config.sellerPeerId ?? (this.isDevnet ? DEFAULT_DEVNET_SELLER_PEER_ID : DEFAULT_SELLER_PEER_ID);
  }

  /**
   * `Router.configureRoutingPeerHostResolution` -- the generic hook the host
   * calls once, after the node has actually started (this plugin's own
   * `createRouter` runs before that, so it can't do a live P2P lookup at
   * construction time). Same mutate-in-place pattern as
   * `configureDailySigning`/`configureRouteAuthSigning` for the same reason.
   */
  configureRoutingPeerHostResolution(resolveRoutingPeerHost: (peerId: string) => Promise<string | null>): void {
    this.config.resolveRoutingPeerHost = resolveRoutingPeerHost;
  }

  /**
   * The URL `selectRoute` actually calls, in priority order: an explicit
   * `routingPeerUrl` always wins (a real static override, e.g. devnet, where
   * DHT discovery is deliberately disabled); otherwise a host already
   * discovered and cached this run; otherwise a fresh discovery via
   * `resolveRoutingPeerHost(effectiveSellerPeerId)`, combined with this
   * plugin's own known HTTP port. Concurrent callers collapse onto one
   * in-flight discovery, same dedup shape `signDayPassOnDemand` already
   * uses for signing. Throws a clear, actionable error rather than silently
   * routing nowhere if none of the above produces a URL.
   */
  private async resolveEffectiveRoutingPeerUrl(): Promise<string> {
    if (this.config.routingPeerUrl) return this.config.routingPeerUrl;
    // Devnet's mock routing peer isn't reachable via real DHT discovery --
    // go straight to its known local address, same as the real default did
    // before P2P discovery existed.
    if (this.isDevnet) return DEFAULT_DEVNET_ROUTING_PEER_URL;
    if (this.discoveredRoutingPeerHost) {
      return `http://${this.discoveredRoutingPeerHost}:${DEFAULT_ROUTING_PEER_HTTP_PORT}`;
    }
    if (!this.config.resolveRoutingPeerHost) {
      throw new RoutingPeerError(
        'unreachable',
        'No routingPeerUrl configured and no resolveRoutingPeerHost capability wired in -- nothing to route through.',
      );
    }
    if (!this.routingPeerHostResolutionInFlight) {
      const resolveRoutingPeerHost = this.config.resolveRoutingPeerHost;
      const sellerPeerId = this.effectiveSellerPeerId;
      this.routingPeerHostResolutionInFlight = resolveRoutingPeerHost(sellerPeerId)
        .catch((err: unknown) => {
          console.warn(`[LevantoRouter] routing peer host discovery failed: ${err instanceof Error ? err.message : err}`);
          return null;
        })
        .finally(() => {
          this.routingPeerHostResolutionInFlight = null;
        });
    }
    const host = await this.routingPeerHostResolutionInFlight;
    if (!host) {
      throw new RoutingPeerError(
        'unreachable',
        `Could not discover a routing peer address for seller ${this.effectiveSellerPeerId.slice(0, 12)}... -- no routingPeerUrl configured and discovery found nothing.`,
      );
    }
    this.discoveredRoutingPeerHost = host;
    return `http://${host}:${DEFAULT_ROUTING_PEER_HTTP_PORT}`;
  }

  /** routing_decisions ledger -- for the savings dashboard (task #10). */
  getLedgerRows(): readonly RoutingDecisionRow[] {
    return this.ledger.all();
  }

  /**
   * `Router.getRoutingDecisions` (packages/node/src/interfaces/buyer-router.ts)
   * -- the generic hook buyer-proxy's `/_antseed/routing-decisions` local
   * admin endpoint calls to read this router's ledger, so VPR's savings
   * dashboard doesn't need router-levanto-specific plumbing to reach it.
   * Returns a copy: the interface's return type is mutable, this router's
   * own storage isn't.
   */
  getRoutingDecisions(): RoutingDecisionRow[] {
    return [...this.ledger.all()];
  }

  /**
   * `Router.configureDailySigning` (packages/node/src/interfaces/buyer-router.ts)
   * -- the generic hook the host calls once, after loading, to hand this
   * router a real signing closure. Mutates `config.signDailyIfNeeded` in
   * place rather than requiring it at construction time, since the host
   * builds the closure from a real,
   * *started* `AntseedNode` (it needs `node.buyerPaymentManager`, which
   * only exists once payments are configured) -- constructing the router
   * itself happens earlier, before the node has started.
   */
  configureDailySigning(signDailyIfNeeded: (sellerPeerId: string) => Promise<void>): void {
    this.config.signDailyIfNeeded = signDailyIfNeeded;
  }

  /**
   * `Router.configureRouteAuthSigning` (packages/node/src/interfaces/buyer-router.ts)
   * -- same generic, additive, mutate-in-place pattern as
   * `configureDailySigning` above, for the same reason (this plugin never
   * holds a signing key directly).
   */
  configureRouteAuthSigning(signRouteAuth: (routingPeerId: string) => Promise<RouteAuthHeaders>): void {
    this.config.signRouteAuth = signRouteAuth;
  }

  /**
   * `Router.updateRoutingPreferences` (packages/node/src/interfaces/buyer-router.ts)
   * -- keeps `cachedRoutingPreferences` fresh outside of a `selectRoute`
   * call that happens to pass one, e.g. right after a config-file reload,
   * so `signDayPassOnDemand` (called only from inside a live
   * `selectRoute`, as part of fully-reactive billing) still sees a current
   * day-pass-enable toggle on a `selectRoute` call that itself passes
   * `null`.
   */
  updateRoutingPreferences(preferences: ModelRoutingPreferences): void {
    this.cachedRoutingPreferences = preferences;
  }

  /**
   * Signs a day-pass SpendingAuth strictly on demand -- never on a
   * schedule, a timer, or any elapsed-time bookkeeping this client keeps
   * itself. Called from two places in `selectRoute`, both reacting to the seller rather than deciding
   * anything locally:
   *  - a 402 from `attemptRoute` (a genuinely brand-new buyer with no
   *    channel yet, which this opens, or a returning buyer who already saw
   *    `renewalDue` once and didn't pay before their next request) --
   *    awaited, then the caller retries the route once.
   *  - `renewalDue: true` on an otherwise-successful response -- called
   *    fire-and-forget, after that response is already on its way back to
   *    its own caller, never blocking or delaying it.
   *
   * `signDailyIfNeeded` already handles both bootstrap and renewal
   * idempotently -- opens a channel if none exists, or signs one more day
   * if one does -- so this has no branch of its own for which case it is.
   *
   * Gated on `routingPreferences.dayPassOnDemandEnabled` -- real money moves
   * here (a signed SpendingAuth is a genuine payment authorization), so an
   * explicit, current "yes" is required. "Unknown" (no preferences ever
   * pushed -- `configureDailySigning`
   * wired but `updateRoutingPreferences` never called, or a CLI-only caller
   * with no preferences UI at all) is treated the same as "no": this must
   * never default to signing.
   *
   * ALSO gated on `autoRouting !== false` -- distinct from, and checked
   * alongside, dayPassOnDemandEnabled: a buyer could reasonably reach for
   * the standing "Auto select seller" switch instead of the separate
   * control that actually owns dayPassOnDemandEnabled. `autoRouting`
   * defaults to `undefined`/absent meaning "on" (unlike
   * dayPassOnDemandEnabled's opt-in default), so only an EXPLICIT `false`
   * stops signing here -- a caller that never sends this field at all is
   * unaffected.
   *
   * Concurrent callers collapse onto one in-flight signature via
   * `signingInFlight`, rather than each firing their own -- the only
   * "limiting" this does; it never decides on its own that a sign is due.
   */
  private async signDayPassOnDemand(): Promise<void> {
    if (this.cachedRoutingPreferences?.routerEnabled === false) return;
    if (!this.cachedRoutingPreferences?.dayPassOnDemandEnabled) return;
    if (this.cachedRoutingPreferences.autoRouting === false) return;
    if (!this.config.signDailyIfNeeded) return;
    if (!this.signingInFlight) {
      const signDailyIfNeeded = this.config.signDailyIfNeeded;
      const sellerPeerId = this.effectiveSellerPeerId;
      this.signingInFlight = signDailyIfNeeded(sellerPeerId)
        .catch((err: unknown) => {
          // Swallowed on purpose (a failed sign must not turn a successful
          // retry attempt below into a thrown error before it even tries),
          // but silent-and-discarded is its own risk: the routing peer's own
          // error -- "no current day pass, or today's signature is not yet
          // on file" -- gives no hint that a chain-RPC outage upstream could
          // be the actual cause. Logging what failed costs nothing and turns
          // any occurrence into a one-line diagnosis instead of a mystery.
          // The retry right after this in selectRoute will simply 402 again
          // and surface as a normal RoutingPeerError.
          const code = (err as { code?: unknown } | null)?.code;
          console.warn(`[LevantoRouter] day-pass signing skipped: ${code ?? (err instanceof Error ? err.message : err)}`);
        })
        .finally(() => {
          this.signingInFlight = null;
        });
    }
    await this.signingInFlight;
  }

  /**
   * Headers proving `buyerPeerId` is genuine, for both `/_antseed/route`
   * and `/_antseed/route/digest`. `{}` (not a thrown error) whenever
   * signing isn't configured, has no seller to bind to, or itself fails --
   * lenient by design: an old client or a signing hiccup must still be
   * able to route, not be hard-blocked by it. A verifying routing peer
   * treats a request with no auth headers as unauthenticated, not as
   * malformed.
   */
  private async buildRouteAuthHeaders(): Promise<Record<string, string>> {
    if (!this.config.signRouteAuth) return {};
    try {
      const auth = await this.config.signRouteAuth(this.effectiveSellerPeerId);
      return {
        'x-antseed-route-auth-buyer': auth.buyer,
        'x-antseed-route-auth-issued-at': String(auth.issuedAt),
        'x-antseed-route-auth-nonce': auth.nonce,
        'x-antseed-route-auth-signature': auth.signature,
      };
    } catch {
      return {};
    }
  }

  /**
   * Daily digest: its own calendar-day cadence, independent of day-pass
   * signing, since signing is purely reactive to the seller's 402s with no
   * calendar-day concept of its own -- the digest still has one, since
   * it's reporting stats, not moving money. Its own request, not bundled
   * into a SpendingAuth (SpendingAuthMetadata is the wrong shape, and
   * PaymentMux's MessageType enum is closed). No signing key is involved --
   * this is plain stats -- so the plugin sends it directly with its own
   * fetchImpl rather than needing a host-mediated method. Best-effort: a
   * failed send must never block or fail routing -- not required for
   * correct routing to work -- so errors are swallowed and retried on the
   * next selectRoute call rather than surfaced.
   *
   * Reports the day that just closed, not the one starting now: "one daily
   * performance digest" per day only makes sense as a finished tally (each
   * day's digest accumulates as a permanent record), and at the moment
   * this fires (the first selectRoute of a new calendar day) today's own
   * ledger rows don't exist yet. Sent one day "late" relative to the
   * toggle -- yesterday's numbers, flushed at the start of today.
   */
  private async sendDailyDigestIfNeeded(): Promise<void> {
    // Deliberately keyed on the raw, EXPLICIT config field, not
    // effectiveSellerPeerId's default -- unlike signing/route-auth/URL
    // discovery, sending an unsolicited digest to Levanto's real seller is
    // not something a host that never configured a seller relationship at
    // all should get for free. A host that wants the default seller
    // identity used for real routing traffic can still explicitly pass
    // sellerPeerId to opt into digest reporting too.
    if (!this.config.sellerPeerId) return; // nowhere to send it yet
    const todayKey = calendarDayKey();
    if (this.lastDigestSentDayKey === todayKey) return;
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const digest = buildDigest(this.ledger.all(), periodKey(yesterday));
    const doFetch = this.config.fetchImpl ?? fetch;
    const timeoutMs = this.config.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;
    const routeAuthHeaders = await this.buildRouteAuthHeaders();
    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
    try {
      // Resolved inside the try -- a discovery failure is exactly as
      // "try again next call" as an unreachable fetch, no separate handling
      // needed.
      const routingPeerUrl = await this.resolveEffectiveRoutingPeerUrl();
      // Explicit suffix path -- states intent via the URL rather than
      // relying on the routing peer to body-sniff for an absent
      // inputMessage field.
      const res = await doFetch(`${routingPeerUrl}/_antseed/route/digest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.buyerPeerId ? { 'x-antseed-buyer-peer-id': this.config.buyerPeerId } : {}),
          ...routeAuthHeaders,
        },
        body: JSON.stringify(digest),
        signal: timeoutController.signal,
      });
      if (res.ok) this.lastDigestSentDayKey = todayKey;
    } catch {
      // Routing peer unreachable or unresponsive -- try again next call, same as a skipped day's stats.
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  // Required Router members -- levanto-auto only participates via selectRoute;
  // a concretely-chosen model falls through to the host's existing pipeline
  // before selectPeer would ever be reached for this router. selectPeer/
  // onResult exist only to satisfy the interface.
  selectPeer(_req: SerializedHttpRequest, peers: PeerInfo[]): PeerInfo | null {
    return peers[0] ?? null;
  }

  /**
   * Feeds the cache "warmth" observation. Router.onResult's shared shape
   * doesn't carry `conversation` or the resolved model (packages/node/src/interfaces/buyer-router.ts's
   * `Router.recordObservedCache`), so buyer-proxy.ts calls this separately,
   * alongside `onResult`, after a successful response.
   */
  recordObservedCache(conversation: ConversationIdentity, model: string, peerId: string, promptTokens: number, cachedInputTokens: number): void {
    this.conversations.recordObservedCache(conversationKey(conversation), model, peerId, promptTokens, cachedInputTokens);
  }

  onResult(peer: PeerInfo, result: {
    success: boolean;
    latencyMs: number;
    tokens: number;
    freshInputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number | null;
    requestId?: string;
  }): void {
    if (!result.success) return; // a failed/retried dispatch isn't a resolved decision
    // Correlates by requestId, not peer -- two different conversations
    // concurrently routed to the same peer never mis-pair predicted vs.
    // actual. Without a requestId (an older or non-conforming caller),
    // there's genuinely nothing to correlate against -- the result is
    // silently dropped from the ledger rather than guessed at.
    if (!result.requestId) return;
    this.ledger.recordResult(result.requestId, peer.peerId, {
      promptTokens: (result.freshInputTokens ?? 0) + (result.cachedInputTokens ?? 0),
      cachedTokens: result.cachedInputTokens ?? 0,
      completionTokens: result.outputTokens ?? 0,
      usdcPaid: result.estimatedCostUsd ?? null,
    });
  }

  async selectRoute(
    req: SerializedHttpRequest,
    peers: PeerInfo[],
    conversation: ConversationIdentity | null,
    routingPreferences: ModelRoutingPreferences | null,
    defaultRoutedModel?: string | null,
    context?: RouteSelectionContext,
  ): Promise<RouteCandidate[] | null> {
    context?.signal.throwIfAborted();
    // Kept fresh regardless of which model this particular call is for --
    // the day-pass-enable toggle is a standing preference, not tied to
    // the model happening to be selected on this one request.
    if (routingPreferences) this.cachedRoutingPreferences = routingPreferences;

    const { model, lastUserText } = parseChatBody(req);
    // levanto-auto sentinel check is host-agnostic: any concrete model name
    // declines immediately -- no sentinel knowledge lives in host code.
    if (model !== LEVANTO_AUTO_SERVICE_ID) return null;
    if (routingPreferences?.routerEnabled === false || routingPreferences?.autoRouting === false) return [];

    const convKey = conversation ? conversationKey(conversation) : null;

    // New-user-message gate: a tool-loop continuation reuses the last
    // decision, no network call. Conversations we can't key (no
    // ConversationIdentity) always route -- a safe default, not a full
    // content-hash fallback.
    const routing = context?.routing ?? this.routingContext.observe(req, conversation, {
      cadence: 'turn', settings: context?.settings ?? routingPreferences?.cqt,
      isRouteAvailable: (route) => peers.some((entry) => entry.peerId === route.peerId),
    });
    if (convKey && !routing.shouldRoute && routing.previousRoute) {
      const previous = this.conversations.getPinned(convKey);
      const actualPeer = peers.find((entry) => entry.peerId === routing.previousRoute!.peerId);
      const pinned = previous && actualPeer ? { ...previous, ...routing.previousRoute, peer: actualPeer } : null;
      if (pinned) {
        // A reused dispatch still costs real money and still resolves via
        // the normal onResult flow -- give it its own ledger row too,
        // associated with THIS request's own requestId, reusing the pinned
        // decision's predicted fields rather than requiring a fresh
        // prediction it has no network call to derive one from.
        // routingLatencyMs is null -- this pinned-decision reuse path never
        // made its own routing call, so there is no latency to record.
        this.ledger.recordPending(req.requestId, {
          model: pinned.serviceId,
          predictedCostUsd: null,
          predictedInputTokens: null,
          predictedCachedInputTokens: null,
          predictedOutputTokens: null,
          cqt: pinned.cqt,
          routingLatencyMs: null,
          atMs: Date.now(),
          baselinePrices: pinned.baselinePrices,
          conversationKey: conversation?.sessionKey ?? null,
          // No fresh routing call on a reused/pinned dispatch, so no ranked
          // response to draw candidates from -- honest empty, not a stale
          // copy of the original decision's list.
          consideredCandidates: [],
          inputMessagePreview: trimForInputMessage(lastUserText) || null,
        });
        return [pinnedToRouteCandidate(pinned, substituteModel(req, pinned.serviceId))];
      }
    }

    // Same daily cadence, its own request -- fire-and-forget, never blocks
    // or fails the routing call itself.
    await this.sendDailyDigestIfNeeded();

    const promptTokens = estimateTokens(lastUserText);
    const expectedCachedTokens = convKey
      ? this.conversations.observedModelPeers(convKey).map(({ model: m, peerId }) => ({
        model: m,
        peer: peerId,
        tokens: Math.round(this.conversations.expectedCachedTokens(convKey, m, peerId, promptTokens)),
      })).filter((entry) => entry.tokens > 0)
      : [];

    // CQT dial: one of the five discrete VPR positions {1,3,5,7,9}; 5
    // ("Balanced") when the host hasn't wired VprRoutingPreferences.cqt
    // through yet, or for a CLI-only caller with no preferences UI at all.
    const cqt = Number(context?.settings?.costQuality ?? routingPreferences?.cqt ?? 5);
    if (![1, 3, 5, 7, 9].includes(cqt)) throw new Error('Invalid Levanto costQuality setting');
    const body: RouteRequestBody = {
      v: 1,
      cqt,
      inputMessage: trimForInputMessage(lastUserText),
      promptTokens,
      expectedCachedTokens,
      constraints: {
        maxInputUsdPerMillion: routingPreferences?.maxInputUsdPerMillion ?? undefined,
        minTrustScore: routingPreferences?.minTrustScore ?? undefined,
        allowedPeerIds: routingPreferences?.allowedPeerIds ?? undefined,
        blockedPeerIds: routingPreferences?.blockedPeerIds ?? undefined,
      },
    };

    const doFetch = this.config.fetchImpl ?? fetch;
    const timeoutMs = this.config.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;
    // A single nonce reused across the no-day-pass self-heal retry below
    // would get burned by the routing peer's replay check
    // (RouteAuthVerifier.verify()) as soon as the FIRST attempt's signature
    // checks out -- independent of, and before, the day-pass gate that
    // attempt then fails. Attempt #1 would burn the nonce and correctly
    // 402; the buyer signs the day pass for real; attempt #2 would reuse
    // that already-burned nonce and get rejected as a replay, even though
    // the day-pass gate would now pass -- permanently blocking a brand-new
    // buyer's very first request. Signing fresh per attempt (a local wallet
    // signature, no network cost) avoids this without needing any change
    // on the routing-peer side.
    const attemptRoute = async (): Promise<Response> => {
      context?.signal.throwIfAborted();
      // Resolved fresh per attempt, not cached in a local above this closure --
      // if a prior attempt just cleared discoveredRoutingPeerHost after an
      // unreachable failure, this re-discovers rather than repeating the
      // same stale host. Propagates as-is if discovery itself fails
      // (already a RoutingPeerError('unreachable', ...), nothing to add).
      const routingPeerUrl = await this.resolveEffectiveRoutingPeerUrl();
      const wasDiscovered = !this.config.routingPeerUrl;
      const routeAuthHeaders = await this.buildRouteAuthHeaders();
      context?.signal.throwIfAborted();
      const timeoutController = new AbortController();
      const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
      try {
        return await doFetch(`${routingPeerUrl}/_antseed/route`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.config.buyerPeerId ? { 'x-antseed-buyer-peer-id': this.config.buyerPeerId } : {}),
            ...routeAuthHeaders,
          },
          body: JSON.stringify(body),
          signal: context ? AbortSignal.any([context.signal, timeoutController.signal]) : timeoutController.signal,
        });
      } catch (err) {
        // Routing peer unreachable OR unresponsive -- the AbortController
        // above fires the same way for both, so both land here. Throws
        // rather than returning null: null would fall through to the
        // fixed-model pipeline, which can't handle the Auto sentinel and
        // fails a moment later with a confusing error instead of a clear
        // one.
        //
        // A discovered (not statically configured) host that just failed
        // might be stale -- the seller moved or restarted with a new
        // address. Clear the cache so the NEXT selectRoute call re-discovers
        // instead of retrying the same dead host forever.
        if (wasDiscovered) this.discoveredRoutingPeerHost = null;
        const reason = err instanceof Error ? err.message : String(err);
        throw new RoutingPeerError('unreachable', `Routing peer at ${routingPeerUrl} is unreachable or timed out: ${reason}`);
      } finally {
        clearTimeout(timeoutHandle);
      }
    };

    // Extracts the seller's error message exactly once per Response -- res.json()
    // (and fetch Response bodies in general) can only be consumed a single time,
    // so this must never be called twice on the same res.
    const parseRejectionMessage = async (response: Response): Promise<string> => {
      let message = `Routing peer rejected the request (status ${response.status}).`;
      try {
        const errBody = (await response.json()) as { error?: { message?: string } };
        if (errBody?.error?.message) message = errBody.error.message;
      } catch {
        // Non-JSON or empty error body -- keep the generic message.
      }
      return message;
    };

    const routingCallStartedAt = Date.now();
    let res = await attemptRoute();
    context?.signal.throwIfAborted();

    // Fully reactive day-pass payment: the client keeps no clock of its own
    // for this -- it signs only because the seller's response just said
    // payment is required, the same shape ordinary per-request metered
    // billing already uses (seller decides a charge is due, buyer signs in
    // response, never the other way around). A 402 here covers two
    // distinct cases, and signDayPassOnDemand doesn't need
    // to know which: a genuinely brand-new buyer (no channel at all yet), or
    // a returning buyer who was already served one response with
    // `renewalDue` set (below) and didn't pay before this next request --
    // the seller blocks THAT one, not the one that revealed the charge. One
    // retry only: a second 402 after it just falls through to the throw
    // below like any other rejection.
    if (res.status === 402 && this.config.signDailyIfNeeded) {
      await this.signDayPassOnDemand();
      context?.signal.throwIfAborted();
      res = await attemptRoute();
    }

    const rejectionMessage = res.ok ? null : await parseRejectionMessage(res);

    const routingLatencyMs = Date.now() - routingCallStartedAt;
    if (!res.ok) {
      // Includes both 402 cases -- "no active session" and "renewal
      // required" (the retry above already had its one chance to clear
      // either). Same reasoning as the unreachable branch above -- throws
      // rather than falling through to a pipeline that can't handle the
      // Auto sentinel.
      throw new RoutingPeerError('rejected', rejectionMessage!, res.status);
    }

    const parsed = (await res.json()) as RouteResponseBody;
    context?.signal.throwIfAborted();
    if (!Array.isArray(parsed?.ranked) || parsed.ranked.some((entry) => !entry?.price || !entry?.estimate)) {
      // Cheap: already resolved and cached by the attemptRoute() call above
      // that produced this very response, just re-read here for the message.
      const routingPeerUrl = await this.resolveEffectiveRoutingPeerUrl();
      throw new RoutingPeerError('rejected', `Routing peer at ${routingPeerUrl} returned a malformed response.`, res.status);
    }
    // Postpaid day-pass renewal: this response is already real and already
    // on its way back to the caller below -- signing here must never delay
    // or gate it. Fire-and-forget, not awaited: signDayPassOnDemand
    // swallows its own errors and dedupes concurrent callers, so a failure
    // just means the seller flags renewalDue again (or blocks) on the
    // buyer's next request.
    if (parsed.renewalDue) void this.signDayPassOnDemand();
    const peerById = new Map(peers.map((p) => [p.peerId, p] as const));
    // One snapshot per response, not per candidate -- duplicated onto every
    // PinnedDecision below the same way cqt already is, since it's a
    // request-level value.
    const baselinePrices = computeBaselinePrices(parsed.ranked);
    const consideredCandidates = topConsideredCandidates(parsed.ranked);

    let ranked: PinnedDecision[] = [];
    for (const entry of parsed.ranked) {
      const peer = peerById.get(entry.peer as PeerInfo['peerId']);
      if (!peer) continue; // stale candidate, not in our current peer set
      ranked.push({
        peer,
        peerId: peer.peerId,
        serviceId: entry.model,
        reputation: 0,
        hasCachedInputPricing: entry.price.cachedInUsdPerM > 0,
        inputUsdPerMillion: entry.price.inUsdPerM,
        outputUsdPerMillion: entry.price.outUsdPerM,
        minImageUsdPerImage: null,
        // For the routing_decisions ledger, and reused as-is by a later
        // pinned/reused dispatch -- carried on the candidate itself rather
        // than looked up separately once the winner is known.
        predictedCostUsd: entry.estimate.costUsd,
        predictedInputTokens: entry.estimate.inputTokens,
        predictedCachedInputTokens: entry.estimate.cachedInputTokens,
        predictedOutputTokens: entry.estimate.outputTokens,
        cqt,
        baselinePrices,
      });
    }

    // allowedPeerIds is a client-side re-filter, not a ranking constraint
    // the peer narrows by -- walk the ranked list as usual, skip anything
    // outside the allowlist. If that empties the list, fall back to the
    // allowed peers directly rather than giving up.
    //
    // The fallback needs a model to pair with those peers -- use whatever
    // the pre-existing "antseed" alias currently resolves to
    // (defaultRoutedModel, host-owned buyer.state.json state passed in by
    // buyer-proxy.ts) -- the buyer's own already-chosen fallback
    // target, which has an actual reason to be one of these allowlisted
    // peers' models. No price data comes with defaultRoutedModel, so the
    // synthesized candidates carry null pricing -- honest "unknown," not a
    // fabricated number.
    const allowedPeerIds = routingPreferences?.allowedPeerIds;
    if (allowedPeerIds && allowedPeerIds.length > 0) {
      const allowedSet = new Set(allowedPeerIds.map((p) => p.toLowerCase()));
      const filtered = ranked.filter((c) => allowedSet.has(c.peerId.toLowerCase()));
      if (filtered.length > 0) {
        ranked = filtered;
      } else if (defaultRoutedModel) {
        ranked = peers
          .filter((peer) => allowedSet.has(peer.peerId.toLowerCase()))
          .map((peer) => ({
            peer,
            peerId: peer.peerId,
            serviceId: defaultRoutedModel,
            reputation: 0,
            hasCachedInputPricing: false,
            inputUsdPerMillion: null,
            outputUsdPerMillion: null,
            minImageUsdPerImage: null,
            // No real Sage prediction for a synthesized fallback candidate --
            // honest "unknown," same reasoning as the null price fields above.
            predictedCostUsd: null,
            predictedInputTokens: null,
            predictedCachedInputTokens: null,
            predictedOutputTokens: null,
            cqt,
            // Still real: baselinePrices comes from the actual ranked
            // response, independent of which candidate the walk ends up on.
            baselinePrices,
          }));
      } else {
        ranked = [];
      }
    }

    if (ranked.length === 0) return [];

    const winner = ranked[0]!;
    if (convKey) {
      this.conversations.recordDecision(convKey, winner);
      this.routingContext.recordRoute(conversation, req.requestId, winner);
    }

    this.ledger.recordPending(req.requestId, {
      model: winner.serviceId,
      predictedCostUsd: winner.predictedCostUsd,
      predictedInputTokens: winner.predictedInputTokens,
      predictedCachedInputTokens: winner.predictedCachedInputTokens,
      predictedOutputTokens: winner.predictedOutputTokens,
      cqt: winner.cqt,
      routingLatencyMs,
      atMs: Date.now(),
      baselinePrices: winner.baselinePrices,
      conversationKey: conversation?.sessionKey ?? null,
      // Independent of allowedPeerIds re-filtering above -- what the peer
      // actually offered, not what survived the client-side filter, so a
      // "what else was considered" view isn't silently missing candidates
      // the buyer's own preferences excluded.
      consideredCandidates,
      inputMessagePreview: trimForInputMessage(lastUserText) || null,
    });

    // Any renewal signing this response needed was already kicked off,
    // fire-and-forget, right after parsing it above -- nothing left to do
    // here but return the real decision.
    return ranked.map((c) => pinnedToRouteCandidate(c, substituteModel(req, c.serviceId)));
  }
}

function substituteModel(req: SerializedHttpRequest, model: string): SerializedHttpRequest {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(Buffer.from(req.body).toString('utf-8'));
  } catch {
    return req;
  }
  // A peer-pinned request (`<peerId>@levanto-auto`) arrives with a `service`
  // field the host's own rewritePeerPinnedServiceInBody already mirrored
  // from `model` (request-utils.ts) -- extractRequestedService prefers
  // `service` over `model`, so leaving it stale here sends the seller the
  // sentinel this function exists to replace: real 400 "Service
  // \"levanto-auto\" is not served by this peer", model correctly "hy3" but
  // ignored. Mirrors overrideRoutedModelInBody's own model/service sync.
  if (typeof parsed['service'] === 'string' && parsed['service'] === parsed['model']) {
    parsed['service'] = model;
  }
  parsed['model'] = model;
  return { ...req, body: new TextEncoder().encode(JSON.stringify(parsed)) };
}
