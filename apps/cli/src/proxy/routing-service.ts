import { createHash, randomUUID } from 'node:crypto'
import { validateRoutingServiceMetadata, resolveRoutingPreferences, validateRoutingRequest, canonicalRoutingJson, type RoutingSelection, buildNetworkServiceOffers, perCallPriceMicroUsdc, isFreeUnitBillingModel, isRouteRecommendationEligible, isModelRouteEligible, validateUnitBillingModelV1, type AntseedNode, type ModelRoutingPreferences, type PeerInfo, type RouteSelectionContext, type SerializedHttpResponse } from '@antseed/node'
import type { HierarchicalPricingConfig, RoutingServiceConfig } from '../config/types.js'
import { normalizedModelReputationScore } from './network-models.js'

type RoutingInput = Parameters<NonNullable<RouteSelectionContext['invokeService']>>[0]
type ResponseParser = NonNullable<Parameters<NonNullable<RouteSelectionContext['invokeService']>>[1]>
type Operation = { fingerprint: string; result: Promise<SerializedHttpResponse> }

export class RoutingConfigurationError extends Error {}

export class RoutingServiceExecutor {
  private readonly operations = new WeakMap<AbortSignal, Map<string, Operation>>()
  private readonly active = new Map<AbortController, string>()
  private readonly schemas = new Map<string, string>()

  constructor(private readonly host: {
    node: Pick<AntseedNode, 'sendRequest' | 'buyerPaymentManager'>
    getPolicy: () => { maxPricing?: HierarchicalPricingConfig; minPeerReputation?: number; preferences?: ModelRoutingPreferences | null }
    getPeers: () => Promise<PeerInfo[]>
    record: (event: Record<string, unknown>) => void
  }) {}

  cancel(): void {
    for (const controller of this.active.keys()) controller.abort()
  }

  updateMetadata(peers: PeerInfo[]): void {
    for (const [key, hash] of this.schemas) {
      const target = JSON.parse(key) as RoutingServiceConfig;
      const peer = peers.find((entry) => entry.peerId.toLowerCase() === target.peerId.toLowerCase().replace(/^0x/, ''));
      const next = peer?.providerServiceRouting?.[target.provider]?.services[target.serviceId]?.preferencesSchemaHash;
      if (next !== hash) {
        for (const [controller, activeKey] of this.active) if (activeKey === key) controller.abort();
        this.schemas.delete(key);
      }
    }
  }

  private async metadata(selection: RoutingSelection) {
    if (selection.kind !== 'router' || !selection.service) throw new RoutingConfigurationError('Select a network routing service first')
    const target = selection.service
    const peers = await this.host.getPeers()
    this.updateMetadata(peers)
    const peer = peers.find((entry) => entry.peerId.toLowerCase() === target.peerId.toLowerCase().replace(/^0x/, ''))
    const offer = peer && buildNetworkServiceOffers([peer]).find((entry) => entry.provider === target.provider && entry.serviceId === target.serviceId && entry.protocols.includes('antseed-routing'))
    if (!offer?.routing || offer.capabilities?.routing !== true) throw new RoutingConfigurationError('Routing service requires signed structured routing metadata; update the service instead of using the old classifier protocol')
    try { validateRoutingServiceMetadata(offer.routing) } catch (error) { throw new RoutingConfigurationError(String(error)) }
    this.schemas.set(canonicalRoutingJson(target), offer.routing.preferencesSchemaHash)
    return { serviceId: target.serviceId, target: structuredClone(target), metadata: structuredClone(offer.routing) }
  }

  async describe(selection: RoutingSelection) {
    const description = await this.metadata(selection)
    try {
      const preferences = resolveRoutingPreferences(description.metadata.preferencesSchema, selection.kind === 'router' ? selection.preferences ?? {} : {})
      return { ...description, preferences }
    } catch (error) { throw new RoutingConfigurationError(error instanceof Error ? error.message : String(error)) }
  }

  async inspect(selection: RoutingSelection) {
    const description = await this.metadata(selection)
    const configuredPreferences = selection.kind === 'router' ? selection.preferences ?? {} : {}
    try {
      return { ...description, configuredPreferences, preferences: resolveRoutingPreferences(description.metadata.preferencesSchema, configuredPreferences) }
    } catch (error) {
      return { ...description, configuredPreferences, preferencesError: error instanceof Error ? error.message : String(error) }
    }
  }

  invoke(parentRequestId: string, context: RouteSelectionContext, request: RoutingInput, parseResponse?: ResponseParser, target?: RoutingServiceConfig): Promise<SerializedHttpResponse> {
    context.signal.throwIfAborted()
    if (!target) return Promise.reject(new Error('Select a network routing service before invoking it'))
    const input = JSON.stringify(request)
    const fingerprint = createHash('sha256').update(JSON.stringify(target)).update(input).digest('hex')
    const operations = this.operations.get(context.signal) ?? new Map<string, Operation>()
    this.operations.set(context.signal, operations)
    const previous = operations.get(parentRequestId)
    if (previous) return previous.fingerprint === fingerprint ? previous.result : Promise.reject(new Error('Only one routing service operation is allowed per request'))
    const result = this.execute(parentRequestId, { ...context, candidates: structuredClone(context.candidates) }, input, structuredClone(target), parseResponse)
    operations.set(parentRequestId, { fingerprint, result })
    return result
  }

  private async execute(parentRequestId: string, context: RouteSelectionContext, input: string, target: RoutingServiceConfig, parseResponse?: ResponseParser): Promise<SerializedHttpResponse> {
    const controller = new AbortController()
    const signal = AbortSignal.any([context.signal, controller.signal])
    const requestId = randomUUID()
    const startedAt = Date.now()
    let statusCode: number | undefined
    let outcome = 'failed'
    this.active.set(controller, canonicalRoutingJson(target))
    const deadline = setTimeout(() => controller.abort(), Math.max(0, context.deadlineMs - startedAt))
    try {
      signal.throwIfAborted()
      if (context.deadlineMs <= startedAt) throw new Error('Routing deadline exceeded')
      const peers = await this.host.getPeers()
      signal.throwIfAborted()
      const peer = peers.find((candidate) => candidate.peerId.toLowerCase() === target.peerId.toLowerCase().replace(/^0x/, ''))
      const offer = peer ? buildNetworkServiceOffers([peer]).find((entry) => entry.serviceId === target.serviceId
        && entry.provider === target.provider && entry.protocols.includes('antseed-routing')) : null
      if (!peer || !offer || offer.capabilities?.routing !== true || offer.inputUsdPerMillion == null || offer.outputUsdPerMillion == null) throw new Error('Routing service unavailable or missing routing capability')
      if (!offer.routing) throw new Error('Routing descriptor unavailable')
      const request: unknown = JSON.parse(input)
      try { validateRoutingRequest(request, offer.routing) } catch (error) { throw new RoutingConfigurationError(String(error)) }
      if (request.service !== target.serviceId) throw new Error('Routing request targets a different service')
      if (canonicalRoutingJson(request.candidates) !== canonicalRoutingJson(context.candidates ?? [])) throw new Error('Routing candidates do not match buyer policy')
      const rates = [offer.inputUsdPerMillion, offer.outputUsdPerMillion, offer.cachedInputUsdPerMillion ?? offer.inputUsdPerMillion]
      if (rates.some((rate) => !Number.isFinite(rate) || rate < 0)) throw new Error('Routing service has invalid prices')
      const policy = this.host.getPolicy()
      const reputation = normalizedModelReputationScore(peer, Date.now())
      if ((reputation ?? 0) < (policy.minPeerReputation ?? 0) || (policy.preferences && !isModelRouteEligible({
        peerId: peer.peerId, reputationScore: reputation, inputUsdPerMillion: rates[0], outputUsdPerMillion: rates[1],
      }, policy.preferences))) throw new Error('Routing service violates buyer policy')
      const limits = policy.maxPricing?.defaults
      if (limits && (rates[0]! > limits.inputUsdPerMillion || rates[1]! > limits.outputUsdPerMillion
        || rates[2]! > (limits.cachedInputUsdPerMillion ?? limits.inputUsdPerMillion))) throw new Error('Routing service exceeds buyer prices')
      const unitModel = peer.providerServiceUnitBillingModels?.[target.provider]?.services[target.serviceId]?.['antseed-routing']
      if (unitModel && validateUnitBillingModelV1(unitModel).length > 0) throw new Error('Routing service has invalid billing')
      const perCallAmount = perCallPriceMicroUsdc(unitModel)
      if (perCallAmount !== null) {
        if (rates.some((rate) => rate !== 0)) throw new Error('Per-call routing cannot include token charges')
        if (!parseResponse) throw new Error('Per-call routing requires a recommendation validator')
        const paymentLimit = this.host.node.buyerPaymentManager?.maxPerRequestUsdc ?? 0n
        if (perCallAmount > paymentLimit) throw new Error('Routing fee exceeds buyer payment policy')
      } else if (unitModel && !isFreeUnitBillingModel(unitModel)) throw new Error('Unsupported routing billing model')
      const response = await this.host.node.sendRequest(peer, {
        requestId, method: 'POST', path: '/v1/route',
        headers: { 'content-type': 'application/json', 'x-antseed-provider': target.provider },
        body: Buffer.from(input),
      }, {
        signal,
        attribution: { purpose: 'routing', parentRequestId },
        ...(perCallAmount !== null ? {
          acceptResponse: (response: SerializedHttpResponse) => {
            statusCode = response.statusCode
            const routes = parseResponse!(response)
            return Array.isArray(routes) && routes.length === 1
              && routes.every((route) => isRouteRecommendationEligible(route, context.candidates ?? []))
          },
        } : {}),
      })
      signal.throwIfAborted()
      statusCode = response.statusCode
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error('Routing service rejected the operation')
      outcome = 'succeeded'
      return response
    } finally {
      clearTimeout(deadline)
      this.active.delete(controller)
      this.host.record({ purpose: 'routing', requestId, parentRequestId, peerId: target.peerId, serviceId: target.serviceId,
        startedAt, latencyMs: Date.now() - startedAt, outcome: signal.aborted ? 'cancelled' : outcome, statusCode })
    }
  }
}
