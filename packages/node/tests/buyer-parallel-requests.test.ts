import { describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';
import { createUnitBillingModel } from '../src/types/billing.js';

describe('parallel requests to one seller', () => {
  it.each(['classification', 'inference stream'])('finishes classification while another %s is still open', async (first) => {
    const held = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const sendRequest = vi.fn(async (_peer, request) => {
      if (request.requestId === 'held') {
        started.resolve();
        await held.promise;
      }
      return { requestId: request.requestId, statusCode: 200, headers: {}, body: new Uint8Array() };
    });
    const node = Object.assign(Object.create(AntseedNode.prototype), {
      _buyerHandler: { sendRequest },
    }) as AntseedNode;
    const peer = { peerId: 'a'.repeat(40) as any, lastSeen: Date.now(), providers: ['openai'],
      providerPricing: { openai: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, services: {} } },
      providerServiceUnitBillingModels: { openai: { services: { classifier: { 'openai-chat-completions': createUnitBillingModel('5000') } } } },
    };
    const request = { requestId: 'held', method: 'POST', path: '/v1/chat/completions',
      headers: { 'x-antseed-provider': 'openai' }, body: new TextEncoder().encode('{"model":"classifier"}') };
    const options = { attribution: { purpose: 'routing' as const, parentRequestId: 'parent' }, acceptResponse: () => true };
    const pending = first === 'classification' ? node.sendRequest(peer, request, options)
      : node.sendRequestStream(peer, request, { onResponseStart: vi.fn(), onResponseChunk: vi.fn() });
    await started.promise;
    const completed = vi.fn();
    const second = node.sendRequest(peer, { ...request, requestId: 'second' }, options).then(completed);
    try {
      await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce(), { timeout: 200 });
      expect(sendRequest).toHaveBeenCalledTimes(2);
    } finally {
      held.resolve();
      await Promise.all([pending, second]);
    }
  });
});
