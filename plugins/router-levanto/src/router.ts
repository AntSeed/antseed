import { randomUUID } from 'node:crypto';
import type { AntseedRouterPlugin, PeerInfo, RouteRecommendation, RouteSelectionContext, SerializedHttpRequest } from '@antseed/node';
import { COMPLETED_REQUESTS_CAPABILITY, parseMicroUsdc, resolveServiceBillingOffer, canonicalRoutingJson, createRoutingServiceMetadata, resolveRoutingPreferences } from '@antseed/node';
import localPlugin from '@antseed/router-local';
import { LEVANTO_ROUTING_PATH, validateRoutingRequest, validateRoutingResponse } from './validation.js';
import { CacheObservations } from './cache-observations.js';

type CachedRoute = { text: string; fingerprint: string; routes: RouteRecommendation[] };

export const levantoRoutingMetadata = createRoutingServiceMetadata({
  type: 'object', additionalProperties: false,
  properties: { cqt: { type: 'string', enum: ['1', '3', '5', '7', '9'], default: '5', description: 'Cost/quality preference' } },
});

export class LevantoRoutingAdapter {
  private readonly conversations = new Map<string, CachedRoute>();
  readonly observations = new CacheObservations();
  private generation = 0;

  reset(): void {
    this.generation++;
    this.conversations.clear();
  }

  constructor(private readonly maxFeeMicroUsdc: string, private readonly sellerPeerId?: string) {
    parseMicroUsdc(maxFeeMicroUsdc);
    if (sellerPeerId && !/^[0-9a-f]{40}$/.test(sellerPeerId)) throw new Error('Invalid LEVANTO_SELLER_PEER_ID');
  }

  async selectRoute(request: SerializedHttpRequest, peers: PeerInfo[], context: RouteSelectionContext): Promise<RouteRecommendation[] | null> {
    const body = JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
    if (body.model !== 'levanto-auto' && body.model !== 'antseed') return null;
    context.signal.throwIfAborted();
    const generation = this.generation;
    const preferences = resolveRoutingPreferences(levantoRoutingMetadata.preferencesSchema, context.preferences ?? {});
    if (context.preferencesSchemaHash !== undefined && context.preferencesSchemaHash !== levantoRoutingMetadata.preferencesSchemaHash) throw new Error('Routing preferences schema changed');
    const target = context.routingService ?? (this.sellerPeerId ? { peerId: this.sellerPeerId, provider: 'levanto', serviceId: 'levanto-route' } : undefined);
    if (!target) throw new Error('Select a Levanto routing-service peer');
    if (target.provider !== 'levanto' || target.serviceId !== 'levanto-route') throw new Error('Unsupported Levanto routing service');
    const fingerprint = canonicalRoutingJson({ target, preferences, schema: levantoRoutingMetadata.preferencesSchemaHash });
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const latestUser = [...messages].reverse().find(message => message && message.role === 'user');
    const content: unknown = latestUser?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.map(block => typeof block?.text === 'string' ? block.text : '').join('\n') : '';
    if (!text.trim()) throw new Error('Levanto routing requires a messages request with user text');
    if (!context.candidates.length) throw new Error('No eligible inference candidates');
    const cached = context.conversationKey ? this.conversations.get(context.conversationKey) : undefined;
    if (cached?.text === text && cached.fingerprint === fingerprint && context.acceptRecommendations(cached.routes)) return structuredClone(cached.routes);
    if (context.conversationKey) this.conversations.delete(context.conversationKey);

    const candidates = peers.flatMap(peer => {
      if (peer.peerId !== target.peerId) return [];
      if (!peer.metadata?.capabilities?.includes(COMPLETED_REQUESTS_CAPABILITY)) return [];
      try {
        const offer = resolveServiceBillingOffer(peer.metadata.offerings, 'levanto', 'levanto-route');
        return offer.serviceApiProtocol === 'levanto-routing' && parseMicroUsdc(offer.priceMicroUsdc) <= parseMicroUsdc(this.maxFeeMicroUsdc)
          ? [{ peer, offer }] : [];
      } catch { return []; }
    });
    const selected = candidates[0];
    if (!selected) throw new Error('No compatible Levanto completed-request service within the fee limit');
    const inputMessage = text.length > 8192 ? text.slice(0, 4096) + text.slice(-4096) : text;
    const promptTokens = Math.ceil(text.length / 4);
    const payload = {
      v: 1, cqt: Number(preferences.cqt), inputMessage, promptTokens,
      expectedCachedTokens: this.observations.estimates(context.conversationKey, context.candidates, promptTokens),
      constraints: { allowedPeerIds: [...new Set(context.candidates.map(candidate => candidate.peerId))] },
    };
    validateRoutingRequest(payload);
    let recommendations: RouteRecommendation[] | undefined;
    const response = await context.sendRequest(selected.peer, {
      requestId: randomUUID(), method: 'POST', path: LEVANTO_ROUTING_PATH,
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({ ...payload, service: selected.offer.service })),
    }, {
      signal: context.signal, unitBilling: selected.offer, maxFeeMicroUsdc: this.maxFeeMicroUsdc,
      acceptResponse: response => {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(response.body));
        const ranked = validateRoutingResponse(parsed, payload);
        const routes = ranked.filter(entry => context.candidates.some(candidate => candidate.peerId === entry.peer && candidate.serviceId === entry.model))
          .map(entry => ({ serviceId: entry.model, peerId: entry.peer }));
        if (!routes.length) return false;
        if (!context.acceptRecommendations(routes)) return false;
        recommendations = routes;
        return true;
      },
    });
    context.signal.throwIfAborted();
    if (response.statusCode < 200 || response.statusCode >= 300 || !recommendations) throw new Error(`Levanto routing failed (${response.statusCode})`);
    if (context.conversationKey && generation === this.generation) {
      this.conversations.set(context.conversationKey, { text, fingerprint, routes: structuredClone(recommendations) });
      if (this.conversations.size > 500) this.conversations.delete(this.conversations.keys().next().value!);
    }
    return recommendations;
  }
}

export const routerPlugin: AntseedRouterPlugin = {
  name: 'levanto-router', displayName: 'Levanto Router', version: '0.1.0', type: 'router',
  description: 'Buy Levanto recommendations and execute them using normal AntSeed inference',
  configSchema: [
    ...(localPlugin.configSchema ?? []),
    { key: 'ANTSEED_MAX_ROUTING_FEE_MICRO_USDC', label: 'Maximum routing fee (micro-USDC)', type: 'string', required: true },
    { key: 'LEVANTO_SELLER_PEER_ID', label: 'Levanto seller peer ID', type: 'string' },
  ],
  async createRouter(config) {
    const maxFee = config.ANTSEED_MAX_ROUTING_FEE_MICRO_USDC;
    if (maxFee === undefined) throw new Error('ANTSEED_MAX_ROUTING_FEE_MICRO_USDC is required');
    const adapter = new LevantoRoutingAdapter(maxFee, config.LEVANTO_SELLER_PEER_ID);
    const router = await localPlugin.createRouter(config);
    router.autoRouteServiceId = 'levanto-auto';
    router.routingMetadata = structuredClone(levantoRoutingMetadata);
    if (config.LEVANTO_SELLER_PEER_ID) router.defaultRoutingService = { peerId: config.LEVANTO_SELLER_PEER_ID, provider: 'levanto', serviceId: 'levanto-route' };
    router.recordUsage = observation => adapter.observations.record(observation);
    router.resetRouting = () => adapter.reset();
    router.selectRoute = adapter.selectRoute.bind(adapter);
    return router;
  },
};
