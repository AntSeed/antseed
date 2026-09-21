import { randomUUID } from 'node:crypto';
import type { AntseedRouterPlugin, PeerInfo, RouteRecommendation, RouteSelectionContext, SerializedHttpRequest } from '@antseed/node';
import { FIXED_FEE_CAPABILITY, FIXED_FEE_CONTRACT_HEADER, FIXED_FEE_PRICE_HEADER, parseMicroUsdc, resolveFixedFeeOffer } from '@antseed/node';
import localPlugin from '@antseed/router-local';
import { LEVANTO_ROUTING_CONTRACT, LEVANTO_ROUTING_PATH, validateFixedFeeRequest, validateFixedFeeResponse } from './contract.js';

type CachedRoute = { text: string; routes: RouteRecommendation[] };

export class LevantoRoutingAdapter {
  private readonly conversations = new Map<string, CachedRoute>();

  constructor(private readonly maxFeeMicroUsdc: string, private readonly sellerPeerId?: string, private readonly cqt = 5) {
    parseMicroUsdc(maxFeeMicroUsdc);
    if (sellerPeerId && !/^[0-9a-f]{40}$/.test(sellerPeerId)) throw new Error('Invalid LEVANTO_SELLER_PEER_ID');
    if (![1, 3, 5, 7, 9].includes(cqt)) throw new Error('LEVANTO_CQT must be 1, 3, 5, 7, or 9');
  }

  async selectRoute(request: SerializedHttpRequest, peers: PeerInfo[], context: RouteSelectionContext): Promise<RouteRecommendation[] | null> {
    const body = JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
    if (body.model !== 'levanto-auto' && body.model !== 'antseed') return null;
    context.signal.throwIfAborted();
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const latestUser = [...messages].reverse().find(message => message && message.role === 'user');
    const content: unknown = latestUser?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.map(block => typeof block?.text === 'string' ? block.text : '').join('\n') : '';
    if (!text.trim()) throw new Error('Levanto routing requires a messages request with user text');
    if (!context.candidates.length) throw new Error('No eligible inference candidates');
    const cached = context.conversationKey ? this.conversations.get(context.conversationKey) : undefined;
    if (cached?.text === text && context.acceptRecommendations(cached.routes)) return structuredClone(cached.routes);
    if (context.conversationKey) this.conversations.delete(context.conversationKey);

    const candidates = peers.flatMap(peer => {
      if (this.sellerPeerId && peer.peerId !== this.sellerPeerId) return [];
      if (!peer.metadata?.capabilities?.includes(FIXED_FEE_CAPABILITY)) return [];
      try {
        const offer = resolveFixedFeeOffer(peer.metadata.offerings, 'levanto', 'levanto-route');
        return offer.contract === LEVANTO_ROUTING_CONTRACT && parseMicroUsdc(offer.priceMicroUsdc) <= parseMicroUsdc(this.maxFeeMicroUsdc)
          ? [{ peer, offer }] : [];
      } catch { return []; }
    });
    candidates.sort((first, second) => {
      const priceDifference = parseMicroUsdc(first.offer.priceMicroUsdc) - parseMicroUsdc(second.offer.priceMicroUsdc);
      return priceDifference < 0n ? -1 : priceDifference > 0n ? 1 : first.peer.peerId.localeCompare(second.peer.peerId);
    });
    const selected = candidates[0];
    if (!selected) throw new Error('No compatible Levanto response-fee service within the fee limit');
    const inputMessage = text.length > 8192 ? text.slice(0, 4096) + text.slice(-4096) : text;
    const payload = {
      v: 1, cqt: this.cqt, inputMessage, promptTokens: Math.ceil(text.length / 4), expectedCachedTokens: [],
      constraints: { allowedPeerIds: [...new Set(context.candidates.map(candidate => candidate.peerId))] },
    };
    validateFixedFeeRequest(LEVANTO_ROUTING_CONTRACT, payload);
    let recommendations: RouteRecommendation[] | undefined;
    const response = await context.sendRequest(selected.peer, {
      requestId: randomUUID(), method: 'POST', path: LEVANTO_ROUTING_PATH,
      headers: {
        'content-type': 'application/json', 'x-antseed-provider': selected.offer.provider,
        [FIXED_FEE_CONTRACT_HEADER]: selected.offer.contract, [FIXED_FEE_PRICE_HEADER]: selected.offer.priceMicroUsdc,
      },
      body: new TextEncoder().encode(JSON.stringify({ ...payload, service: selected.offer.service })),
    }, {
      signal: context.signal, fixedFee: selected.offer, maxFeeMicroUsdc: this.maxFeeMicroUsdc,
      acceptResponse: response => {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(response.body));
        validateFixedFeeResponse(LEVANTO_ROUTING_CONTRACT, parsed, payload);
        const ranked = (parsed as { ranked: Array<{ model: string; peer: string }> }).ranked;
        const routes = ranked.map(entry => ({ serviceId: entry.model, peerId: entry.peer }));
        if (!context.acceptRecommendations(routes)) return false;
        recommendations = routes;
        return true;
      },
    });
    context.signal.throwIfAborted();
    if (response.statusCode < 200 || response.statusCode >= 300 || !recommendations) throw new Error(`Levanto routing failed (${response.statusCode})`);
    if (context.conversationKey) {
      this.conversations.set(context.conversationKey, { text, routes: structuredClone(recommendations) });
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
    { key: 'LEVANTO_CQT', label: 'Cost/quality preference', type: 'number', default: 5 },
  ],
  async createRouter(config) {
    const maxFee = config.ANTSEED_MAX_ROUTING_FEE_MICRO_USDC;
    if (maxFee === undefined) throw new Error('ANTSEED_MAX_ROUTING_FEE_MICRO_USDC is required');
    const adapter = new LevantoRoutingAdapter(maxFee, config.LEVANTO_SELLER_PEER_ID, Number(config.LEVANTO_CQT ?? 5));
    const router = await localPlugin.createRouter(config);
    router.autoRouteServiceId = 'levanto-auto';
    router.selectRoute = adapter.selectRoute.bind(adapter);
    return router;
  },
};
