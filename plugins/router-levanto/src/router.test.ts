import { describe, expect, it, vi } from 'vitest';
import { COMPLETED_REQUESTS_CAPABILITY, serviceBillingOffering, type PeerInfo, type RouteRecommendation, type RouteSelectionContext, type SerializedHttpRequest } from '@antseed/node';
import { LevantoRoutingAdapter, routerPlugin, levantoRoutingMetadata } from './router.js';

const sellerId = 'a'.repeat(40);
const inferenceId = 'b'.repeat(40);
const offer = { provider: 'levanto', service: 'levanto-route', contract: 'levanto-routing-v1', priceMicroUsdc: '1000' };
const peer = { peerId: sellerId, metadata: { peerId: sellerId, capabilities: [COMPLETED_REQUESTS_CAPABILITY], offerings: [serviceBillingOffering(offer)] } } as PeerInfo;
const recommendation: RouteRecommendation = { serviceId: 'model-a', peerId: inferenceId };
const result = {
  v: 1, router: 'levanto', ranked: [{ model: 'model-a', peer: inferenceId,
    estimate: { costUsd: 0.1, inputTokens: 4, cachedInputTokens: 0, outputTokens: 10 },
    price: { inUsdPerM: 1, outUsdPerM: 2, cachedInUsdPerM: 0 } }],
};

function request(text = 'Help me', model = 'levanto-auto'): SerializedHttpRequest {
  return { requestId: 'inference', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ model, messages: [{ role: 'user', content: text }], stream: true })) };
}

function setup() {
  const accepted = vi.fn(() => true);
  const sendRequest = vi.fn<RouteSelectionContext['sendRequest']>(async (_peer, request, options) => {
    const response = { requestId: request.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(result)) };
    if (!options.acceptResponse?.(response)) throw new Error('Not accepted');
    return response;
  });
  const context: RouteSelectionContext = {
    routingService: { peerId: sellerId, provider: 'levanto', serviceId: 'levanto-route' },
    signal: new AbortController().signal, conversationKey: 'chat-1',
    candidates: [{ ...recommendation, peerId: inferenceId, provider: 'openai', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }],
    acceptRecommendations: accepted, sendRequest,
  };
  return { adapter: new LevantoRoutingAdapter('1000'), context, accepted, sendRequest };
}

describe('Levanto buyer adapter', () => {
  it('translates Levanto rankings and requires host acceptance before payment', async () => {
    const state = setup();
    expect(await state.adapter.selectRoute(request(), [peer], state.context)).toEqual([recommendation]);
    expect(state.accepted).toHaveBeenCalledWith([recommendation]);
    const [, serviceRequest, options] = state.sendRequest.mock.calls[0]!;
    expect(serviceRequest.path).toBe('/_antseed/levanto-route');
    expect(serviceRequest.requestId).not.toBe('inference');
    expect(options.unitBilling).toEqual(offer);
    expect(options.maxFeeMicroUsdc).toBe('1000');
    expect(JSON.parse(new TextDecoder().decode(serviceRequest.body))).toMatchObject({
      v: 1, cqt: 5, inputMessage: 'Help me', service: 'levanto-route', constraints: { allowedPeerIds: [inferenceId] },
    });
  });

  it('declines concrete models and rejects missing user text before a paid request', async () => {
    const state = setup();
    expect(await state.adapter.selectRoute(request('Help', 'model-a'), [peer], state.context)).toBeNull();
    await expect(state.adapter.selectRoute(request(''), [peer], state.context)).rejects.toThrow('user text');
    expect(state.sendRequest).not.toHaveBeenCalled();
  });

  it('reuses unchanged text, reroutes changed text, and does not cache unidentified conversations', async () => {
    const state = setup();
    await state.adapter.selectRoute(request(), [peer], state.context);
    await state.adapter.selectRoute(request(), [peer], state.context);
    expect(state.sendRequest).toHaveBeenCalledTimes(1);
    await state.adapter.selectRoute(request('New turn'), [peer], state.context);
    expect(state.sendRequest).toHaveBeenCalledTimes(2);
    state.context.conversationKey = null;
    await state.adapter.selectRoute(request(), [peer], state.context);
    await state.adapter.selectRoute(request(), [peer], state.context);
    expect(state.sendRequest).toHaveBeenCalledTimes(4);
  });

  it('revalidates cached routes and rejects ineligible paid recommendations', async () => {
    const state = setup();
    await state.adapter.selectRoute(request(), [peer], state.context);
    state.accepted.mockReturnValue(false);
    await expect(state.adapter.selectRoute(request(), [peer], state.context)).rejects.toThrow('Not accepted');
    expect(state.sendRequest).toHaveBeenCalledTimes(2);
  });

  it('requires an opted-in seller within the buyer fee cap', async () => {
    const state = setup();
    await expect(new LevantoRoutingAdapter('999').selectRoute(request(), [peer], state.context)).rejects.toThrow('fee limit');
    await expect(state.adapter.selectRoute(request(), [{ ...peer, metadata: undefined }], state.context)).rejects.toThrow('compatible');
    state.context.signal = AbortSignal.abort();
    await expect(state.adapter.selectRoute(request(), [peer], state.context)).rejects.toThrow();
    expect(state.sendRequest).not.toHaveBeenCalled();
  });

  it('loads the buyer role without seller URL or API key', async () => {
    const router = await routerPlugin.createRouter({ ANTSEED_MAX_ROUTING_FEE_MICRO_USDC: '1000' });
    expect(router.autoRouteServiceId).toBe('levanto-auto');
    expect(router.selectRoute).toBeTypeOf('function');
    expect(router.selectPeer).toBeTypeOf('function');
    expect(router.routingMetadata).toEqual(levantoRoutingMetadata);
    expect(router.recordUsage).toBeTypeOf('function');
    expect(routerPlugin.configSchema?.some(field => field.key === 'LEVANTO_BASE_URL' || field.key === 'LEVANTO_API_KEY')).toBe(false);
  });

  it('uses live enum preferences and invalidates an unchanged-turn decision', async () => {
    const state = setup();
    await state.adapter.selectRoute(request(), [peer], state.context);
    state.context.preferences = { cqt: '9' };
    await state.adapter.selectRoute(request(), [peer], state.context);
    expect(state.sendRequest).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(new TextDecoder().decode(state.sendRequest.mock.calls[1]![1].body));
    expect(payload.cqt).toBe(9);
    state.context.preferences = { cqt: '2' };
    await expect(state.adapter.selectRoute(request(), [peer], state.context)).rejects.toThrow('enum');
    expect(state.sendRequest).toHaveBeenCalledTimes(2);
  });

  it('fails closed on a changed schema before any routing call', async () => {
    const state = setup();
    state.context.preferencesSchemaHash = 'old';
    await expect(state.adapter.selectRoute(request(), [peer], state.context)).rejects.toThrow('schema changed');
    expect(state.sendRequest).not.toHaveBeenCalled();
  });

  it('does not replace the selected routing peer with a cheaper peer', async () => {
    const state = setup();
    const cheaper = { ...peer, peerId: 'c'.repeat(40), metadata: { ...peer.metadata!, offerings: [serviceBillingOffering({ ...offer, priceMicroUsdc: '0' })] } } as PeerInfo;
    await state.adapter.selectRoute(request(), [cheaper, peer], state.context);
    expect(state.sendRequest.mock.calls[0]![0].peerId).toBe(sellerId);
    state.adapter.reset();
    await expect(state.adapter.selectRoute(request(), [cheaper], state.context)).rejects.toThrow('compatible');
    state.context.routingService = undefined;
    await expect(state.adapter.selectRoute(request(), [peer], state.context)).rejects.toThrow('Select a Levanto');
  });

  it('filters mixed rankings by exact eligible model/peer without changing their order', async () => {
    const state = setup();
    state.context.candidates = [...state.context.candidates, { ...state.context.candidates[0]!, serviceId: 'model-b' }];
    state.sendRequest.mockImplementation(async (_peer, serviceRequest, options) => {
      const entry = result.ranked[0]!;
      const body = { ...result, ranked: [
        { ...entry, peer: 'c'.repeat(40) }, { ...entry, model: 'too-expensive' },
        { ...entry, model: 'model-b' }, { ...entry, inference: { reasoningEffort: 'unsupported' } }, entry,
      ] };
      const response = { requestId: serviceRequest.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
      if (!options.acceptResponse?.(response)) throw new Error('Not accepted');
      return response;
    });
    expect(await state.adapter.selectRoute(request(), [peer], state.context)).toEqual([
      { serviceId: 'model-b', peerId: inferenceId }, recommendation,
    ]);
  });

  it('sends observed cache estimates on a fresh decision, not another call for a tool continuation', async () => {
    const state = setup();
    await state.adapter.selectRoute(request(), [peer], state.context);
    state.adapter.observations.record({ conversationKey: 'chat-1', requestId: 'completed', peerId: inferenceId, provider: 'openai', serviceId: 'model-a', inputTokens: 100, cachedInputTokens: 80 });
    await state.adapter.selectRoute(request(), [peer], state.context);
    expect(state.sendRequest).toHaveBeenCalledTimes(1);
    await state.adapter.selectRoute(request('More details please'), [peer], state.context);
    const payload = JSON.parse(new TextDecoder().decode(state.sendRequest.mock.calls[1]![1].body));
    expect(payload.expectedCachedTokens).toEqual([{ model: 'model-a', peer: inferenceId, tokens: payload.promptTokens }]);
  });
});
