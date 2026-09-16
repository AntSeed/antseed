import { describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler, type RequestExecutionOptions } from '../src/buyer-request-handler.js';
import { createPerCallBillingModel } from '../src/types/billing.js';
import { ConnectionState } from '../src/types/connection.js';
import type { PeerInfo } from '../src/types/peer.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';

function setup(statuses = [200]) {
  const events: string[] = [];
  const controller = new AbortController();
  const peer: PeerInfo = {
    peerId: 'a'.repeat(40) as PeerInfo['peerId'], lastSeen: Date.now(), providers: ['openai'],
    providerPricing: { openai: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, services: {} } },
    providerServiceApiProtocols: { openai: { services: { classifier: ['openai-chat-completions'] } } },
    providerServiceUnitBillingModels: { openai: { services: { classifier: { 'openai-chat-completions': createPerCallBillingModel('5000') } } } },
  };
  const request: SerializedHttpRequest = { requestId: 'classification', method: 'POST', path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'x-antseed-provider': 'openai' },
    body: new TextEncoder().encode(JSON.stringify({ model: 'classifier', messages: [] })) };
  const negotiator = {
    getOrCreatePaymentMux: vi.fn(() => ({})), trackRequestBillingContext: vi.fn(),
    handle402: vi.fn(async () => ({ action: 'retry' })),
    estimateCostFromResponse: vi.fn(() => { events.push('observe'); }),
    sendPostResponseAuth: vi.fn(async () => { events.push('authorize'); }),
  };
  const mux = {
    cancelProxyRequest: vi.fn(),
    sendProxyRequest: vi.fn((req: SerializedHttpRequest, onResponse: (response: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void) => {
      onResponse({ requestId: req.requestId, statusCode: statuses.shift() ?? 200, headers: {},
        body: new TextEncoder().encode('{"model":"eligible"}') }, { streamingStart: false });
    }),
  };
  const getConnection = vi.fn(async () => ({ state: ConnectionState.Open }));
  const handler = new BuyerRequestHandler({}, {
    localPeerId: 'b'.repeat(40), negotiator: negotiator as any,
    verificationStorage: null, verificationSampler: null,
    getConnection: getConnection as any, getMux: () => mux as any,
    getVerificationMux: () => ({} as any), registerPaymentMux: vi.fn(),
  });
  const options: RequestExecutionOptions = { signal: controller.signal, routingAuthorization: {
    parentRequestId: 'inference', maxAdditionalAuthorizationUsdc: '5000',
    billing: { kind: 'per_call', amountMicroUsdc: '5000' },
    validateResponse: () => { events.push('validate'); return true; },
  } };
  return { handler, peer, request, options, events, negotiator, mux, controller, getConnection };
}

describe('per-call classification acceptance before payment', () => {
  it.each([[200], [402, 200]])('validates before observing usage or signing, including after negotiation: %j', async (...statuses) => {
    const state = setup(statuses);
    await state.handler.sendRequest(state.peer, state.request, undefined, state.options);
    expect(state.events).toEqual(['validate', 'observe', 'authorize']);
  });

  it.each([[200], [402, 200]])('never observes or authorizes an invalid classification: %j', async (...statuses) => {
    const state = setup(statuses);
    state.options.routingAuthorization!.validateResponse = () => false;
    await expect(state.handler.sendRequest(state.peer, state.request, undefined, state.options)).rejects.toThrow('invalid classification');
    expect(state.events).toEqual([]);
    expect(state.negotiator.estimateCostFromResponse).not.toHaveBeenCalled();
    expect(state.negotiator.sendPostResponseAuth).not.toHaveBeenCalled();
  });

  it('requires a validator before opening a connection', async () => {
    const state = setup();
    delete state.options.routingAuthorization!.validateResponse;
    await expect(state.handler.sendRequest(state.peer, state.request, undefined, state.options)).rejects.toThrow('requires response validation');
    expect(state.getConnection).not.toHaveBeenCalled();
  });

  it('redacts parser errors and never authorizes payment after a parser throws', async () => {
    const state = setup();
    state.options.routingAuthorization!.validateResponse = () => { throw new Error('private classifier payload'); };
    await expect(state.handler.sendRequest(state.peer, state.request, undefined, state.options)).rejects.toThrow('Routing service returned an invalid classification');
    expect(state.events).toEqual([]);
  });

  it('requires synchronous explicit acceptance instead of accepting a promise', async () => {
    const state = setup();
    state.options.routingAuthorization!.validateResponse = (async () => true) as any;
    await expect(state.handler.sendRequest(state.peer, state.request, undefined, state.options)).rejects.toThrow('invalid classification');
    expect(state.events).toEqual([]);
  });

  it('does not authorize payment when cancellation happens during validation', async () => {
    const state = setup();
    state.options.routingAuthorization!.validateResponse = () => { state.controller.abort(); return true; };
    await expect(state.handler.sendRequest(state.peer, state.request, undefined, state.options)).rejects.toThrow();
    expect(state.events).toEqual([]);
  });

  it('does not let the parser mutate the response used for metering', async () => {
    const state = setup();
    state.options.routingAuthorization!.validateResponse = (response) => { response.statusCode = 500; response.body.fill(0); return true; };
    const response = await state.handler.sendRequest(state.peer, state.request, undefined, state.options);
    expect(response.statusCode).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe('{"model":"eligible"}');
  });

  it('does not accept or sign for an HTTP error', async () => {
    const state = setup([503]);
    await state.handler.sendRequest(state.peer, state.request, undefined, state.options);
    expect(state.events).toEqual(['observe']);
    expect(state.negotiator.sendPostResponseAuth).not.toHaveBeenCalled();
  });

  it('leaves token-priced routing unchanged', async () => {
    const state = setup();
    delete state.peer.providerServiceUnitBillingModels;
    state.peer.providerPricing!.openai!.defaults = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
    delete state.options.routingAuthorization!.billing;
    delete state.options.routingAuthorization!.validateResponse;
    await state.handler.sendRequest(state.peer, state.request, undefined, state.options);
    expect(state.events).toEqual(['observe', 'authorize']);
  });
});
