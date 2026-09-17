import { describe, expect, it, vi } from 'vitest';
import type { RouteSelectionContext, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';
import plugin, { parseClassificationResponse } from './index.js';

const candidates: NonNullable<RouteSelectionContext['candidates']> = [
  { peerId: 'a'.repeat(40), serviceId: 'small-model', inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0 },
  { peerId: 'b'.repeat(40), serviceId: 'small-model', inputUsdPerMillion: 3, outputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.5 },
  { peerId: 'c'.repeat(40), serviceId: 'large-model', inputUsdPerMillion: 5, outputUsdPerMillion: 6, cachedInputUsdPerMillion: null },
];

function recommendation(index: number) {
  return { serviceId: candidates[index]!.serviceId };
}

function response(content: unknown = recommendation(0)): SerializedHttpResponse {
  return {
    requestId: 'classifier-response', statusCode: 200, headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] })),
  };
}

function request(model = 'unused-client-model'): SerializedHttpRequest {
  return {
    requestId: 'client-request', method: 'POST', path: '/v1/chat/completions',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ model, messages: [{ role: 'user', content: 'Explain this code' }] })),
  };
}

function context(overrides: Partial<RouteSelectionContext> = {}): RouteSelectionContext {
  return {
    mode: 'router', candidates: structuredClone(candidates), signal: new AbortController().signal, deadlineMs: Date.now() + 10_000,
    invokeService: vi.fn(async (_messages, parseResponse) => {
      const result = response();
      expect(parseResponse?.(result)).toEqual([recommendation(0)]);
      return result;
    }),
    ...overrides,
  };
}

async function select(selectionContext: RouteSelectionContext, incoming = request()) {
  const router = await plugin.createRouter({});
  return router.selectRoute!(incoming, [], null, null, null, selectionContext);
}

describe('generic classifier reference router', () => {
  it('passes every model/seller price to the classifier, without client credentials', async () => {
    const selectionContext = context({ settings: { instructions: 'Prefer low output prices for long answers' } });
    expect(await select(selectionContext)).toEqual([recommendation(0)]);
    const messages = vi.mocked(selectionContext.invokeService!).mock.calls[0]![0];
    const payload = JSON.parse(messages[1]!.content);
    expect(payload.candidates).toEqual(candidates);
    expect(payload.instructions).toBe('Prefer low output prices for long answers');
    expect(payload.request.body.messages[0].content).toBe('Explain this code');
    expect(JSON.stringify(messages)).not.toContain('client-secret');
  });

  it('leaves seller selection to the host even when several sellers offer the model', async () => {
    expect(await select(context())).toEqual([{ serviceId: 'small-model' }]);
  });

  it('can choose a different model without a built-in model catalog', async () => {
    expect(await select(context({ invokeService: async () => response(recommendation(2)) })))
      .toEqual([recommendation(2)]);
  });

  it('reuses an eligible continuation without buying another classification', async () => {
    const selectionContext = context({ routing: { trigger: 'continuation', shouldRoute: false,
      previousRoute: recommendation(1) } });
    expect(await select(selectionContext)).toEqual([recommendation(1)]);
    expect(selectionContext.invokeService).not.toHaveBeenCalled();
  });

  it('reclassifies when the prior route is no longer in the eligible snapshot', async () => {
    const selectionContext = context({ routing: { trigger: 'continuation', shouldRoute: false,
      previousRoute: { serviceId: 'unavailable-model' } } });
    expect(await select(selectionContext)).toEqual([recommendation(0)]);
    expect(selectionContext.invokeService).toHaveBeenCalledOnce();
  });

  it('does not silently convert a prior exact-seller selection into automatic seller selection', async () => {
    const selectionContext = context({ routing: { trigger: 'continuation', shouldRoute: false,
      previousRoute: { serviceId: 'small-model', peerId: candidates[0]!.peerId } } });
    expect(await select(selectionContext)).toEqual([recommendation(0)]);
    expect(selectionContext.invokeService).toHaveBeenCalledOnce();
  });

  it('reconsiders a new turn even when the old route remains eligible', async () => {
    const selectionContext = context({ routing: { trigger: 'new-turn', shouldRoute: true,
      previousRoute: recommendation(1) } });
    expect(await select(selectionContext)).toEqual([recommendation(0)]);
    expect(selectionContext.invokeService).toHaveBeenCalledOnce();
  });

  it('bypasses classification for an explicit model and preserves local-router hooks', async () => {
    const selectionContext = context();
    expect(await select({ ...selectionContext, mode: 'model' }, request('small-model'))).toBeNull();
    expect(selectionContext.invokeService).not.toHaveBeenCalled();
    const router = await plugin.createRouter({});
    expect(typeof (router as unknown as Record<string, unknown>).allowsPeerForPolicy).toBe('function');
  });

  it('does not spend on classification when there are no eligible offers', async () => {
    const selectionContext = context({ candidates: [] });
    expect(await select(selectionContext)).toEqual([]);
    expect(selectionContext.invokeService).not.toHaveBeenCalled();
  });

  it('requires a host-authorized service rather than making its own HTTP request', async () => {
    await expect(select(context({ invokeService: undefined }))).rejects.toThrow('authorized routing service');
  });

  it('does not invoke after cancellation or accept a late response', async () => {
    const controller = new AbortController();
    const selectionContext = context({ signal: controller.signal });
    controller.abort();
    await expect(select(selectionContext)).rejects.toThrow();
    expect(selectionContext.invokeService).not.toHaveBeenCalled();
    const lateController = new AbortController();
    await expect(select(context({ signal: lateController.signal, invokeService: async () => {
      lateController.abort();
      return response();
    } }))).rejects.toThrow();
  });

  it.each([
    null, {}, [], { serviceId: null }, { serviceId: 42 }, { serviceId: '' },
    { serviceId: 'unadvertised-model' },
    { serviceId: 'small-model', peerId: candidates[0]!.peerId },
    { serviceId: 'small-model', routes: [] },
    { routes: [recommendation(0)] },
  ])('rejects invalid recommendations before fixed-fee authorization: %j', (content) => {
    expect(() => parseClassificationResponse(response(content), candidates)).toThrow();
  });

  it('rejects malformed envelopes, non-JSON content, and HTTP errors', () => {
    for (const body of ['not-json', '{}', '{"choices":[]}', '{"choices":[{"message":{"content":"not-json"}}]}']) {
      expect(() => parseClassificationResponse({ ...response(), body: new TextEncoder().encode(body) }, candidates)).toThrow();
    }
    expect(() => parseClassificationResponse({ ...response(), statusCode: 503 }, candidates)).toThrow();
  });
});
