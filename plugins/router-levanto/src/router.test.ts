import { describe, expect, it, vi } from 'vitest';
import type { PeerInfo, RouteRecommendation, RouteSelectionContext, SerializedHttpRequest } from '@antseed/node';
import { LevantoRoutingAdapter } from './router.js';

const sellerId = 'a'.repeat(40);
const inferenceId = 'b'.repeat(40);
const offer = { provider: 'levanto', service: 'levanto-route', serviceApiProtocol: 'levanto-routing' as const, priceMicroUsdc: '1000' };
function providers(priceMicroUsdc = offer.priceMicroUsdc): NonNullable<PeerInfo['metadata']>['providers'] {
  return [{ provider: offer.provider, services: [offer.service], defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, maxConcurrency: 1, currentLoad: 0,
    serviceApiProtocols: { [offer.service]: [offer.serviceApiProtocol] },
    serviceUnitBillingModels: { [offer.service]: { [offer.serviceApiProtocol]: { version: 1, components: [{ unit: 'completed_requests', priceUsd: Number(priceMicroUsdc) / 1_000_000 }] } } },
  }];
}
const peer = { peerId: sellerId, metadata: { version: 12, peerId: sellerId, providers: providers() } } as PeerInfo;
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
  return { adapter: new LevantoRoutingAdapter(), context, accepted, sendRequest };
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

  it('rejects malformed successful responses before accepting recommendations', async () => {
    const state = setup();
    state.sendRequest.mockImplementation(async (_peer, serviceRequest, options) => {
      const response = { requestId: serviceRequest.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode('{}') };
      options.acceptResponse!(response);
      return response;
    });
    await expect(state.adapter.selectRoute(request(), [peer], state.context)).rejects.toThrow('Invalid Levanto routing response');
    expect(state.accepted).not.toHaveBeenCalled();
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

  it('requires an advertised billing offer and respects cancellation', async () => {
    const state = setup();
    await expect(state.adapter.selectRoute(request(), [{ ...peer, metadata: undefined }], state.context)).rejects.toThrow('compatible');
    state.context.signal = AbortSignal.abort();
    await expect(state.adapter.selectRoute(request(), [peer], state.context)).rejects.toThrow();
    expect(state.sendRequest).not.toHaveBeenCalled();
  });

  it('uses the selected advertised price without a separate fee setting', async () => {
    const state = setup();
    expect(await state.adapter.selectRoute(request('Hello', 'model-a'), [peer], state.context)).toBeNull();
    expect(state.sendRequest).not.toHaveBeenCalled();
    for (const price of ['0', '2500']) {
      const pricedState = setup();
      const pricedPeer = { ...peer, metadata: { ...peer.metadata!, providers: providers(price) } };
      await pricedState.adapter.selectRoute(request(), [pricedPeer], pricedState.context);
      const options = pricedState.sendRequest.mock.calls.at(-1)![2];
      expect(options.unitBilling?.priceMicroUsdc).toBe(price);
      expect(options.maxFeeMicroUsdc).toBe(price);
    }
  });

  it('resolves the exact provider and service using the advertised protocol', async () => {
    const state = setup();
    const provider = { ...providers()[0]!, provider: 'custom-provider', services: ['custom-route'],
      serviceApiProtocols: { 'custom-route': ['levanto-routing' as const] },
      serviceUnitBillingModels: { 'custom-route': providers()[0]!.serviceUnitBillingModels!['levanto-route']! },
    };
    const customPeer = { ...peer, metadata: { ...peer.metadata!, providers: [provider] } };
    state.context.routingService = { peerId: sellerId, provider: provider.provider, serviceId: 'custom-route' };
    await state.adapter.selectRoute(request(), [customPeer], state.context);
    expect(state.sendRequest.mock.calls[0]![2].unitBilling).toMatchObject({ provider: provider.provider, service: 'custom-route' });
    expect(JSON.parse(new TextDecoder().decode(state.sendRequest.mock.calls[0]![1].body)).service).toBe('custom-route');
    state.context.routingService.serviceId = 'missing-route';
    await expect(state.adapter.selectRoute(request(), [customPeer], state.context)).rejects.toThrow('compatible');
    expect(state.sendRequest).toHaveBeenCalledTimes(1);
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
    const cheaper = { ...peer, peerId: 'c'.repeat(40), metadata: { ...peer.metadata!, providers: providers('0') } } as PeerInfo;
    await state.adapter.selectRoute(request(), [cheaper, peer], state.context);
    expect(state.sendRequest.mock.calls[0]![0].peerId).toBe(sellerId);
    await expect(state.adapter.selectRoute(request('Next turn'), [cheaper], state.context)).rejects.toThrow('compatible');
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
