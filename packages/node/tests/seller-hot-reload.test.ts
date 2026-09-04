import { describe, expect, it, vi } from 'vitest';
import { SellerRequestHandler } from '../src/seller-request-handler.js';
import { AntseedNode } from '../src/node.js';
import type { Provider, ProviderStreamCallbacks } from '../src/interfaces/seller-provider.js';
import { encodeHttpRequest } from '../src/proxy/request-codec.js';
import { MessageType } from '../src/types/protocol.js';

function harness() {
  let finish!: () => void;
  let callbacks!: ProviderStreamCallbacks;
  const body = new TextEncoder().encode(JSON.stringify({ usage: { prompt_tokens: 2, completion_tokens: 3 } }));
  const provider: Provider = {
    name: 'openai', services: ['model'], maxConcurrency: 10,
    pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
    getCapacity: () => ({ current: 0, max: 10 }),
    handleRequest: vi.fn(),
    handleRequestStream: vi.fn(async (request, streamCallbacks) => {
      callbacks = streamCallbacks;
      callbacks.onResponseStart({ requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: new Uint8Array() });
      await new Promise<void>((resolve) => { finish = resolve; });
      callbacks.onResponseChunk({ requestId: request.requestId, data: body, done: true });
      return { requestId: request.requestId, statusCode: 200, headers: {}, body };
    }),
  };
  const frames: Uint8Array[] = [];
  const recordSpend = vi.fn();
  const sendNeedAuth = vi.fn();
  const payments = {
    hasSession: () => true, getChannelByPeer: () => ({ sessionId: 'channel', authMax: '1000000' }),
    getAcceptedCumulative: () => 0n, getCumulativeSpend: () => 0n, getEffectiveReserveMax: () => 1_000_000n,
    waitForPendingAuths: async () => {}, isChannelBlocked: () => false, hasClosingChannel: () => false,
    beginBillableRequest: vi.fn(), endBillableRequest: vi.fn(), recordSpend,
  };
  const handler = new SellerRequestHandler({
    identity: { peerId: 'a'.repeat(40) } as any, providers: [provider],
    sellerPaymentManager: payments as any, channelsClient: {} as any, sessionTracker: null, announcer: null, emit: () => false,
  });
  const { mux } = handler.handleConnection({ send: (frame: Uint8Array) => frames.push(frame), hasRemoteCapability: () => false } as any,
    'b'.repeat(40), { sendNeedAuth } as any, {} as any);
  const send = (requestId: string) => mux.handleFrame({
    type: MessageType.HttpRequest, messageId: 1,
    payload: encodeHttpRequest({ requestId, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ model: 'model', stream: true })) }),
  });
  return { provider, handler, send, frames, recordSpend, sendNeedAuth, finish: () => finish(), started: () => Boolean(finish) };
}

describe('seller hot price reload', () => {
  it('finishes an in-flight stream at its original price after a reload', async () => {
    const state = harness();
    state.send('running');
    await vi.waitFor(() => expect(state.started()).toBe(true));
    state.provider.pricing.defaults.inputUsdPerMillion = 100;
    state.provider.pricing.defaults.outputUsdPerMillion = 200;
    state.finish();
    await vi.waitFor(() => expect(state.recordSpend).toHaveBeenCalledWith('channel', 8n));
    expect(state.sendNeedAuth).toHaveBeenCalledOnce();
    expect(state.provider.handleRequestStream).toHaveBeenCalledOnce();
    expect(state.frames).toHaveLength(2);
  });

  it('updates pricing atomically and supports getter-only agent wrappers', async () => {
    const state = harness();
    const node = new AntseedNode({ role: 'seller' });
    const wrapper = { ...state.provider, get pricing() { return state.provider.pricing; } };
    node.registerProvider(wrapper);
    await node.updateSellerPricing(new Map([[wrapper, { defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 6, cachedInputUsdPerMillion: 1 } }]]));
    expect(state.provider.pricing.defaults.inputUsdPerMillion).toBe(3);
    await expect(node.updateSellerPricing(new Map([[wrapper, { defaults: { inputUsdPerMillion: -1, outputUsdPerMillion: 0 } }]]))).rejects.toThrow();
    expect(state.provider.pricing.defaults.inputUsdPerMillion).toBe(3);
    await expect(node.updateSellerPricing(new Map([[state.provider, state.provider.pricing]]))).rejects.toThrow('Unknown provider');
  });

  it('does not mix pricing for two instances of the same provider plugin', async () => {
    const first = harness().provider;
    const second = harness().provider;
    second.services = ['second-model'];
    const node = new AntseedNode({ role: 'seller' });
    node.registerProvider(first);
    node.registerProvider(second);
    await node.updateSellerPricing(new Map([
      [first, { defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 6 } }],
      [second, { defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 20 } }],
    ]));
    expect(first.pricing.defaults.inputUsdPerMillion).toBe(3);
    expect(second.pricing.defaults.inputUsdPerMillion).toBe(10);
    await expect(node.updateSellerPricing(new Map([
      [first, { defaults: { inputUsdPerMillion: 50, outputUsdPerMillion: 60 } }],
      [second, { defaults: { inputUsdPerMillion: -1, outputUsdPerMillion: 20 } }],
    ]))).rejects.toThrow();
    expect(first.pricing.defaults.inputUsdPerMillion).toBe(3);
  });

});
