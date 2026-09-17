import { createHash, randomUUID } from 'node:crypto'
import { buildNetworkServiceOffers, createPerCallBillingModel, perCallPriceMicroUsdc, isFreeUnitBillingModel, isRouteRecommendationEligible, validateUnitBillingModelV1, type AntseedNode, type PeerInfo, type RouteSelectionContext, type SerializedHttpResponse } from '@antseed/node'
import type { RoutingServiceConfig } from '../config/types.js'

type Messages = Parameters<NonNullable<RouteSelectionContext['invokeService']>>[0]
type ResponseParser = NonNullable<Parameters<NonNullable<RouteSelectionContext['invokeService']>>[1]>
type Operation = { atMs: number; input: string; result: Promise<SerializedHttpResponse> }

export class RoutingServiceExecutor {
  private readonly operations = new Map<string, Operation>()
  private readonly requests: number[] = []
  private readonly active = new Set<AbortController>()

  constructor(private readonly host: {
    node: Pick<AntseedNode, 'sendRequest'>
    routerKey: string
    getConfig: () => RoutingServiceConfig | undefined
    getPeers: () => Promise<PeerInfo[]>
    record: (event: Record<string, unknown>) => Promise<void>
  }) {}

  cancel(): void {
    for (const controller of this.active) controller.abort()
  }

  invoke(parentRequestId: string, context: RouteSelectionContext, messages: Messages, parseResponse?: ResponseParser): Promise<SerializedHttpResponse> {
    context.signal.throwIfAborted()
    const config = this.host.getConfig()
    if (!config || config.routerKey !== this.host.routerKey || config.allowPromptSharing !== true) {
      return Promise.reject(new Error('Routing service not authorized for this router instance'))
    }
    if (config.billing?.kind === 'per_call' && typeof parseResponse !== 'function') {
      return Promise.reject(new Error('Per-call routing requires a classification parser'))
    }
    if (!Array.isArray(messages) || messages.length === 0 || messages.some((message) => !message
      || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) {
      return Promise.reject(new Error('Invalid routing service messages'))
    }
    const input = JSON.stringify(messages.map(({ role, content }) => ({ role, content })))
    if (Buffer.byteLength(input) > config.maxInputBytes) return Promise.reject(new Error('Routing input limit exceeded'))
    const now = Date.now()
    for (const [key, operation] of this.operations) {
      if (operation.atMs < now - 600_000) this.operations.delete(key)
    }
    const previous = this.operations.get(parentRequestId)
    const fingerprint = createHash('sha256').update(input).digest('hex')
    if (previous) return previous.input === fingerprint ? previous.result : Promise.reject(new Error('Only one routing service operation is allowed per request'))
    while (this.requests.length && this.requests[0]! <= now - 60_000) this.requests.shift()
    if (this.operations.size >= 1000 || this.requests.length >= config.maxRequestsPerMinute) return Promise.reject(new Error('Routing service rate limit exceeded'))
    this.requests.push(now)
    const result = this.execute(parentRequestId, { ...context, candidates: structuredClone(context.candidates) }, input, structuredClone(config), parseResponse)
    this.operations.set(parentRequestId, { atMs: now, input: fingerprint, result })
    return result
  }

  private async execute(parentRequestId: string, context: RouteSelectionContext, input: string, config: RoutingServiceConfig, parseResponse?: ResponseParser): Promise<SerializedHttpResponse> {
    const requestId = randomUUID()
    const controller = new AbortController()
    this.active.add(controller)
    const signal = AbortSignal.any([context.signal, controller.signal])
    const startedAt = Date.now()
    let statusCode: number | null = null
    let outcome = 'failed'
    try {
      const peers = await this.host.getPeers()
      signal.throwIfAborted()
      const peer = peers.find((candidate) => candidate.peerId.toLowerCase() === config.peerId.toLowerCase().replace(/^0x/, ''))
      const offer = peer ? buildNetworkServiceOffers([peer]).find((entry) => entry.serviceId === config.serviceId
        && entry.provider === config.provider && entry.protocols.includes('openai-chat-completions')) : null
      if (!peer || !offer || offer.capabilities?.routing !== true || offer.inputUsdPerMillion == null || offer.outputUsdPerMillion == null) throw new Error('Routing service unavailable or missing routing capability')
      if ([offer.inputUsdPerMillion, offer.outputUsdPerMillion, offer.cachedInputUsdPerMillion ?? offer.inputUsdPerMillion]
        .some((rate) => !Number.isFinite(rate) || rate < 0)) throw new Error('Routing service has invalid prices')
      const unitModel = peer.providerServiceUnitBillingModels?.[config.provider]?.services[config.serviceId]?.['openai-chat-completions']
      let perCallAmount: bigint | null = null
      if (config.billing?.kind === 'per_call') {
        createPerCallBillingModel(config.billing.maxAmountMicroUsdc)
        perCallAmount = perCallPriceMicroUsdc(unitModel)
        if (perCallAmount === null) throw new Error('Routing service does not advertise valid per-call billing')
        if (offer.inputUsdPerMillion !== 0 || offer.outputUsdPerMillion !== 0 || (offer.cachedInputUsdPerMillion ?? 0) !== 0) {
          throw new Error('Per-call routing cannot include token charges')
        }
        if (perCallAmount > BigInt(config.billing.maxAmountMicroUsdc)
          || perCallAmount > BigInt(config.maxAdditionalAuthorizationUsdc)) throw new Error('Routing service exceeds authorized per-call price')
      } else {
        if (config.billing !== undefined && config.billing.kind !== 'token') throw new Error('Unsupported routing billing mode')
        if (unitModel && (validateUnitBillingModelV1(unitModel).length > 0 || !isFreeUnitBillingModel(unitModel))) throw new Error('Token routing cannot authorize unit charges')
        const limits = [config.maxInputUsdPerMillion, config.maxOutputUsdPerMillion, config.maxCachedInputUsdPerMillion]
        if (limits.some((limit) => typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0)) throw new Error('Invalid routing price limits')
        if (offer.inputUsdPerMillion > config.maxInputUsdPerMillion! || offer.outputUsdPerMillion > config.maxOutputUsdPerMillion!
          || (offer.cachedInputUsdPerMillion ?? offer.inputUsdPerMillion) > config.maxCachedInputUsdPerMillion!) throw new Error('Routing service exceeds authorized prices')
      }
      const free = perCallAmount !== null ? perCallAmount === 0n : offer.inputUsdPerMillion === 0 && offer.outputUsdPerMillion === 0
      if (!free && BigInt(config.maxAdditionalAuthorizationUsdc) === 0n) throw new Error('Token-priced routing has no spending authorization')
      const response = await this.host.node.sendRequest(peer, {
        requestId, method: 'POST', path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'x-antseed-provider': config.provider },
        body: Buffer.from(JSON.stringify({ model: config.serviceId, messages: JSON.parse(input), stream: false, max_tokens: config.maxOutputTokens })),
      }, {
        signal,
        routingAuthorization: { parentRequestId, maxAdditionalAuthorizationUsdc: perCallAmount?.toString() ?? (free ? '0' : config.maxAdditionalAuthorizationUsdc),
          ...(perCallAmount !== null ? {
            billing: { kind: 'per_call', amountMicroUsdc: perCallAmount.toString() },
            validateResponse: (response: SerializedHttpResponse) => {
              statusCode = response.statusCode
              if (response.body.byteLength > 256 * 1024) return false
              const routes = parseResponse!(response)
              return Array.isArray(routes) && routes.length > 0
                && routes.every((route) => isRouteRecommendationEligible(route, context.candidates ?? []))
            },
          } : {}) },
      })
      signal.throwIfAborted()
      statusCode = response.statusCode
      if (response.body.byteLength > 256 * 1024) throw new Error('Routing service response limit exceeded')
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error('Routing service rejected the operation')
      outcome = 'succeeded'
      return response
    } finally {
      this.active.delete(controller)
      await this.host.record({ purpose: 'routing', requestId, parentRequestId, routerKey: this.host.routerKey,
        peerId: config.peerId, serviceId: config.serviceId, startedAt, latencyMs: Date.now() - startedAt,
        outcome: signal.aborted ? 'cancelled' : outcome, statusCode, billingKind: config.billing?.kind ?? 'token' })
    }
  }
}
