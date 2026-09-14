import { createHash, randomUUID } from 'node:crypto'
import { buildNetworkServiceOffers, type AntseedNode, type PeerInfo, type RouteSelectionContext, type SerializedHttpResponse } from '@antseed/node'
import type { RoutingServiceConfig } from '../config/types.js'

type Messages = Parameters<NonNullable<RouteSelectionContext['invokeService']>>[0]
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

  invoke(parentRequestId: string, context: RouteSelectionContext, messages: Messages): Promise<SerializedHttpResponse> {
    context.signal.throwIfAborted()
    const config = this.host.getConfig()
    if (!config || config.routerKey !== this.host.routerKey || config.allowPromptSharing !== true) {
      return Promise.reject(new Error('Routing service not authorized for this router instance'))
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
    const result = this.execute(parentRequestId, context, input, structuredClone(config))
    this.operations.set(parentRequestId, { atMs: now, input: fingerprint, result })
    return result
  }

  private async execute(parentRequestId: string, context: RouteSelectionContext, input: string, config: RoutingServiceConfig): Promise<SerializedHttpResponse> {
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
      if (!peer || !offer || offer.inputUsdPerMillion == null || offer.outputUsdPerMillion == null) throw new Error('Routing service unavailable')
      if ([offer.inputUsdPerMillion, offer.outputUsdPerMillion, offer.cachedInputUsdPerMillion ?? offer.inputUsdPerMillion]
        .some((rate) => !Number.isFinite(rate) || rate < 0)) throw new Error('Routing service has invalid prices')
      if (offer.inputUsdPerMillion > config.maxInputUsdPerMillion || offer.outputUsdPerMillion > config.maxOutputUsdPerMillion
        || (offer.cachedInputUsdPerMillion ?? offer.inputUsdPerMillion) > config.maxCachedInputUsdPerMillion) throw new Error('Routing service exceeds authorized prices')
      const free = offer.inputUsdPerMillion === 0 && offer.outputUsdPerMillion === 0
      if (!free && BigInt(config.maxAdditionalAuthorizationUsdc) === 0n) throw new Error('Token-priced routing has no spending authorization')
      const response = await this.host.node.sendRequest(peer, {
        requestId, method: 'POST', path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'x-antseed-provider': config.provider },
        body: Buffer.from(JSON.stringify({ model: config.serviceId, messages: JSON.parse(input), stream: false, max_tokens: config.maxOutputTokens })),
      }, {
        signal,
        routingAuthorization: { parentRequestId, maxAdditionalAuthorizationUsdc: free ? '0' : config.maxAdditionalAuthorizationUsdc },
      })
      signal.throwIfAborted()
      statusCode = response.statusCode
      if (response.statusCode >= 400) throw new Error('Routing service rejected the operation')
      outcome = 'succeeded'
      return response
    } finally {
      this.active.delete(controller)
      await this.host.record({ purpose: 'routing', requestId, parentRequestId, routerKey: this.host.routerKey,
        peerId: config.peerId, serviceId: config.serviceId, startedAt, latencyMs: Date.now() - startedAt,
        outcome: signal.aborted ? 'cancelled' : outcome, statusCode })
    }
  }
}
