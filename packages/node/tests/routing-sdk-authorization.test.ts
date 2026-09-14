import { describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';
import { createPerCallBillingModel } from '../src/types/billing.js';

function setup() {
  const response = { requestId: 'classify', statusCode: 200, headers: {}, body: new Uint8Array() };
  const sendRequest = vi.fn(async () => response);
  const finish = vi.fn();
  const beginRoutingRequest = vi.fn(() => finish);
  const node = Object.assign(Object.create(AntseedNode.prototype), {
    _buyerHandler: { sendRequest }, _buyerPaymentManager: { beginRoutingRequest },
  }) as AntseedNode;
  const peer = { peerId: 'a'.repeat(40) as any, lastSeen: Date.now(), providers: ['openai'],
    providerPricing: { openai: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, services: {} } },
    providerServiceUnitBillingModels: { openai: { services: { classifier: { 'openai-chat-completions': createPerCallBillingModel('5000') } } } },
  };
  const request = { requestId: 'classify', method: 'POST', path: '/v1/chat/completions',
    headers: { 'x-antseed-provider': 'openai' }, body: new TextEncoder().encode('{"model":"classifier"}') };
  const options = { routingAuthorization: { parentRequestId: 'inference', maxAdditionalAuthorizationUsdc: '5000',
    billing: { kind: 'per_call' as const, amountMicroUsdc: '5000' }, validateResponse: () => true } };
  return { node, peer, request, options, sendRequest, beginRoutingRequest, finish };
}

describe('native SDK per-call routing authorization', () => {
  it('passes validation through to the handler with exactly one fee and closes the grant', async () => {
    const state = setup();
    await state.node.sendRequest(state.peer, state.request, state.options);
    expect(state.beginRoutingRequest).toHaveBeenCalledWith(expect.objectContaining({ perCallAmountUsdc: 5000n, maxAdditionalAuthorizationUsdc: 5000n }));
    expect(state.sendRequest).toHaveBeenCalledWith(state.peer, state.request, undefined, state.options);
    expect(state.sendRequest.mock.calls[0]![0]).not.toBe(state.peer);
    expect(state.finish).toHaveBeenCalledOnce();
  });

  it.each(['validator', 'advertised-fee', 'cap', 'token-fee', 'payment-manager', 'billing-mode'])('rejects invalid %s before dispatch', async (invalid) => {
    const state = setup();
    if (invalid === 'validator') delete (state.options.routingAuthorization as any).validateResponse;
    if (invalid === 'advertised-fee') state.options.routingAuthorization.billing.amountMicroUsdc = '4000';
    if (invalid === 'cap') state.options.routingAuthorization.maxAdditionalAuthorizationUsdc = '10000';
    if (invalid === 'token-fee') state.peer.providerPricing.openai.defaults.inputUsdPerMillion = 1;
    if (invalid === 'payment-manager') (state.node as any)._buyerPaymentManager = null;
    if (invalid === 'billing-mode') delete (state.options.routingAuthorization as any).billing;
    await expect(state.node.sendRequest(state.peer, state.request, state.options)).rejects.toThrow();
    expect(state.sendRequest).not.toHaveBeenCalled();
    expect(state.beginRoutingRequest).not.toHaveBeenCalled();
  });
});
