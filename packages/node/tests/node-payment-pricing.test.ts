import { describe, expect, it } from 'vitest';
import { AntseedNode, type NodeConfig } from '../src/node.js';
import type { SerializedHttpRequest } from '../src/types/http.js';
import type { Provider } from '../src/interfaces/seller-provider.js';

function createNode(config: Partial<NodeConfig> = {}): AntseedNode {
  const node = new AntseedNode({
    role: 'seller',
    ...config,
  });

  (node as any)._identity = {
    peerId: 'a'.repeat(40),
    privateKey: new Uint8Array(32),
    publicKey: new Uint8Array(32),
  };

  return node;
}

function makeProvider(inputUsdPerMillion: number, outputUsdPerMillion: number, opts: {
  name: string;
  services: string[];
  servicePricing?: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }>;
}): Provider {
  return {
    name: opts.name,
    services: opts.services,
    pricing: {
      defaults: { inputUsdPerMillion, outputUsdPerMillion },
      ...(opts.servicePricing ? { services: opts.servicePricing } : {}),
    },
    maxConcurrency: 1,
    async handleRequest(_req) {
      return {
        requestId: 'test',
        statusCode: 200,
        headers: {},
        body: new Uint8Array(0),
      };
    },
    getCapacity() {
      return { current: 0, max: 1 };
    },
  };
}

describe('AntseedNode payment pricing selection', () => {
  it('matches the requested provider and service pricing instead of using the first provider defaults', () => {
    const node = createNode();
    const request: SerializedHttpRequest = {
      requestId: 'req-pricing',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        'x-antseed-provider': 'openai',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'local-test',
      })),
    };

    const anthropic = makeProvider(3, 15, {
      name: 'anthropic',
      services: ['claude-sonnet'],
    });
    const openai = makeProvider(3, 15, {
      name: 'openai',
      services: ['local-test'],
      servicePricing: {
        'local-test': {
          inputUsdPerMillion: 0.05,
          outputUsdPerMillion: 0.1,
        },
      },
    });

    (node as any)._providers = [anthropic, openai];

    const matched = (node as any)._matchProviderForRequest(request) as Provider | undefined;
    const pricing = matched
      ? (node as any)._resolveProviderPricing(matched, request)
      : undefined;

    expect(matched?.name).toBe('openai');
    expect(pricing).toEqual({
      inputUsdPerMillion: 0.05,
      outputUsdPerMillion: 0.1,
    });
  });
});
