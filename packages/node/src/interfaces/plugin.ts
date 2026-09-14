import type { Provider } from './seller-provider.js'
import type { Router } from './buyer-router.js'

export interface ConfigField {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'secret' | 'string[]'
  required?: boolean
  default?: unknown
  description?: string
}

/** @deprecated Use ConfigField instead */
export type PluginConfigKey = ConfigField

export interface AntseedPluginBase {
  name: string
  displayName: string
  version: string
  description: string
  configSchema?: ConfigField[]
  /** @deprecated Use configSchema instead */
  configKeys?: ConfigField[]
}

export interface AntseedProviderPlugin extends AntseedPluginBase {
  type: 'provider'
  createProvider(config: Record<string, string>): Provider | Promise<Provider>
}

export interface AntseedRouterPlugin extends AntseedPluginBase {
  type: 'router'
  routingSettingsSchema?: import('../routing/router-settings.js').RouterSettingField[]
  createRouter(config: Record<string, string>): Router | Promise<Router>
  /**
   * The `serviceId` this router's "auto" model-picker entry responds to --
   * what a host UI shows as a synthetic catalog entry, and what
   * `Router.selectRoute` checks the requested model against to decide
   * whether to take over routing at all. Omit if this plugin has no
   * dedicated auto-routing sentinel model.
   */
  autoRouteServiceId?: string
  /** Display copy for a generic "what does auto-routing do" info dialog. */
  autoRouteInfo?: { title: string; body: string }
  /**
   * A short, one-line summary of what this router does, for the Preferences
   * page's compact router-description text -- distinct from
   * `autoRouteInfo.body`, which is the longer explanation a one-time
   * confirmation dialog shows. Falls back to `autoRouteInfo.body`, then
   * `description`, when omitted.
   */
  preferencesSummary?: string
  /**
   * A flagship model id this router's ranked candidates commonly quote a
   * real price for, suitable as a host UI's default "what would this have
   * cost at retail" comparison when no more specific one is picked. Omit if
   * this plugin doesn't have an opinion.
   */
  savingsBaselineModel?: string
  /**
   * The serviceId this router's recurring flat-fee/day-pass charge (if any)
   * should be attributed to in SpendingAuthMetadata.services[] (v4) -- host
   * code building that signing closure (`createSignDailyIfNeeded`) reads
   * this instead of hardcoding a specific plugin's own attribution string.
   * Omit if this plugin has no flat-fee charge to attribute, or doesn't care
   * about attribution.
   */
  dailyPassServiceId?: string
}

export interface ClaimResult {
  /** Namespaced claim id, e.g. 'antseed-tee/dcap:hardware-genuine'. */
  claim: string
  ok: boolean
  detail?: string
}

export interface VerifyResult {
  /** Overall pass/fail. The buyer applies its own policy (optional vs required). */
  ok: boolean
  claims: ClaimResult[]
}

/** A request the verifier issues to the seller over the existing buyer<->seller comms. */
export interface SellerRequest {
  method: string
  path: string
  headers?: Record<string, string>
  body?: Uint8Array
}

export interface SellerResponse {
  statusCode: number
  headers: Record<string, string>
  body: Uint8Array
}

export interface VerifyContext {
  peerId: string
  /** Verifier id selected by the buyer; must match the SDK name. */
  verifierId: string
  /** Seller prover path for this verifier. */
  attestPath: string
  fetchFromSeller(req: SellerRequest): Promise<SellerResponse>
  signal?: AbortSignal
}

export interface AntseedVerifierPlugin extends AntseedPluginBase {
  type: 'verifier'
  verify(ctx: VerifyContext): VerifyResult | Promise<VerifyResult>
}

export const ANTSEED_ATTEST_PATH = '/_antseed/attest'

export interface Prover extends AntseedPluginBase {
  type: 'prover'
  prove(req: SellerRequest): SellerResponse | Promise<SellerResponse>
}

export const ANTSEED_ROUTE_PATH = '/_antseed/route'

/**
 * Digest submissions get their own suffix path under the reserved routing
 * path -- the caller states its intent explicitly via the URL, no
 * shape-based body-sniffing to distinguish a digest from a routing request.
 * Both paths delegate to the same `RoutingServerHandler.handleRoute` --
 * `req.path` is already part of `SellerRequest`, so the handler
 * implementation can distinguish them itself; no new interface method or
 * dispatch contract.
 */
export const ANTSEED_ROUTE_DIGEST_PATH = '/_antseed/route/digest'

/**
 * A seller-side handler for the reserved model-routing-decision path
 * (single instance per node, unlike Prover which is looked up by name --
 * there's only one routing peer identity per seller). Registered the same
 * way a Prover is: the actual implementation (day-pass gating, calling
 * out to a ranking sidecar, computing the response) is entirely the host's
 * business -- this interface is just the generic dispatch contract
 * seller-request-handler.ts calls into, so that logic never has to live in
 * this package.
 */
export interface RoutingServerHandler {
  handleRoute(buyerPeerId: string, req: SellerRequest): SellerResponse | Promise<SellerResponse>
}

export type AntseedPlugin = AntseedProviderPlugin | AntseedRouterPlugin | AntseedVerifierPlugin | Prover
