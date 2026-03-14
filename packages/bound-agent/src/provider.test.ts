import { describe, it, expect } from 'vitest';
import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ProviderStreamCallbacks,
} from '@antseed/node';
import { BoundAgentProvider } from './provider.js';
import type { BoundAgentDefinition } from './loader.js';

// ─── Helpers ─────────────────────────────────────────────────────

function makeBody(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function parseBody(body: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
}

function makeReq(body: Record<string, unknown>, path = '/v1/messages'): SerializedHttpRequest {
  return { requestId: 'req-1', method: 'POST', path, headers: {}, body: makeBody(body) };
}

function makeAnthropicTextResponse(text: string): Uint8Array {
  return makeBody({ content: [{ type: 'text', text }] });
}

function makeOpenAITextResponse(text: string): Uint8Array {
  return makeBody({
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  });
}

// ─── Mock provider ──────────────────────────────────────────────

interface MockProviderOptions {
  responses: Uint8Array[];
}

function mockProvider(opts: MockProviderOptions): Provider & {
  requestBodies: () => Record<string, unknown>[];
  callCount: () => number;
  allRequests: () => SerializedHttpRequest[];
} {
  const _requestBodies: Record<string, unknown>[] = [];
  const _rawRequests: SerializedHttpRequest[] = [];
  let _callIndex = 0;

  return {
    name: 'mock',
    services: ['claude-sonnet-4-5-20250929'],
    pricing: { defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
    maxConcurrency: 10,
    serviceCategories: undefined,
    serviceApiProtocols: undefined,
    getCapacity: () => ({ current: 0, max: 10 }),

    handleRequest: async (req: SerializedHttpRequest): Promise<SerializedHttpResponse> => {
      _rawRequests.push(req);
      _requestBodies.push(parseBody(req.body));
      const responseBody = opts.responses[_callIndex] ?? makeAnthropicTextResponse('fallback');
      _callIndex++;
      return {
        requestId: req.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: responseBody,
      };
    },

    handleRequestStream: async (
      req: SerializedHttpRequest,
      callbacks: ProviderStreamCallbacks,
    ): Promise<SerializedHttpResponse> => {
      _rawRequests.push(req);
      _requestBodies.push(parseBody(req.body));
      const responseBody = opts.responses[_callIndex] ?? makeAnthropicTextResponse('fallback');
      _callIndex++;
      const response: SerializedHttpResponse = {
        requestId: req.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: responseBody,
      };
      callbacks.onResponseStart(response);
      callbacks.onResponseChunk({ requestId: req.requestId, data: responseBody, done: true });
      return response;
    },

    requestBodies: () => _requestBodies,
    callCount: () => _callIndex,
    allRequests: () => _rawRequests,
  };
}

// ─── Test agents ─────────────────────────────────────────────────

function personaOnlyAgent(): BoundAgentDefinition {
  return {
    name: 'test-agent',
    persona: 'You are a helpful social media advisor.',
    guardrails: ['Never write posts without explicit request'],
    knowledge: [],
  };
}

function agentWithKnowledge(): BoundAgentDefinition {
  return {
    name: 'social-media-advisor',
    persona: 'You are a social media expert.',
    guardrails: ['Always disclose AI when asked'],
    knowledge: [
      {
        name: 'linkedin-posting',
        description: 'Creating and optimizing LinkedIn posts',
        content: '# LinkedIn Posting\nBest practices for LinkedIn...',
      },
      {
        name: 'x-threads',
        description: 'Writing effective X/Twitter threads',
        content: '# X Threads\nHow to write engaging threads...',
      },
      {
        name: 'content-strategy',
        description: 'Content calendars and strategy frameworks',
        content: '# Content Strategy\nPlanning your content...',
      },
    ],
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('BoundAgentProvider — persona only (no knowledge)', () => {
  it('injects persona + guardrails into system prompt', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('hello')] });
    const agent = new BoundAgentProvider(inner, personaOnlyAgent());

    const req = makeReq({ messages: [{ role: 'user', content: 'hi' }] });
    await agent.handleRequest(req);

    expect(inner.callCount()).toBe(1);
    const body = inner.requestBodies()[0]!;
    const system = body.system as string;
    expect(system).toContain('You are a helpful social media advisor.');
    expect(system).toContain('Never write posts without explicit request');
    expect(system).toContain('confidential');
  });

  it('makes only one LLM call (no selection pass)', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('done')] });
    const agent = new BoundAgentProvider(inner, personaOnlyAgent());

    await agent.handleRequest(makeReq({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(inner.callCount()).toBe(1);
  });

  it('preserves buyer system prompt (Anthropic string)', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('ok')] });
    const agent = new BoundAgentProvider(inner, personaOnlyAgent());

    await agent.handleRequest(makeReq({
      system: 'Buyer system prompt',
      messages: [{ role: 'user', content: 'hi' }],
    }));

    const body = inner.requestBodies()[0]!;
    const system = body.system as string;
    expect(system).toContain('You are a helpful social media advisor.');
    expect(system).toContain('Buyer system prompt');
  });

  it('preserves buyer system prompt array (prompt caching)', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('ok')] });
    const agent = new BoundAgentProvider(inner, personaOnlyAgent());

    const buyerSystem = [
      { type: 'text', text: 'Cached content', cache_control: { type: 'ephemeral' } },
    ];
    await agent.handleRequest(makeReq({
      system: buyerSystem,
      messages: [{ role: 'user', content: 'hi' }],
    }));

    const body = inner.requestBodies()[0]!;
    const system = body.system as { type: string; text: string; cache_control?: unknown }[];
    expect(Array.isArray(system)).toBe(true);
    // Agent's system prompt prepended as first block
    expect(system[0]!.text).toContain('You are a helpful social media advisor.');
    // Buyer's cached block preserved
    expect(system[1]!.text).toBe('Cached content');
    expect(system[1]!.cache_control).toBeDefined();
  });

  it('no tools are injected into the request', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('ok')] });
    const agent = new BoundAgentProvider(inner, personaOnlyAgent());

    await agent.handleRequest(makeReq({ messages: [{ role: 'user', content: 'hi' }] }));

    const body = inner.requestBodies()[0]!;
    expect(body.tools).toBeUndefined();
  });
});

describe('BoundAgentProvider — knowledge selection (Anthropic)', () => {
  it('runs selection pass then response pass (2 calls)', async () => {
    const inner = mockProvider({
      responses: [
        // Selection response: pick linkedin-posting
        makeAnthropicTextResponse('linkedin-posting'),
        // Response with knowledge loaded
        makeAnthropicTextResponse('Here is how to post on LinkedIn.'),
      ],
    });
    const agent = new BoundAgentProvider(inner, agentWithKnowledge());

    const req = makeReq({ messages: [{ role: 'user', content: 'How do I post on LinkedIn?' }] });
    const res = await agent.handleRequest(req);

    expect(inner.callCount()).toBe(2);

    // First call = selection (has knowledge catalog in system prompt)
    const selectionBody = inner.requestBodies()[0]!;
    const selSystem = selectionBody.system as string;
    expect(selSystem).toContain('knowledge router');
    expect(selSystem).toContain('linkedin-posting');
    expect(selSystem).toContain('x-threads');
    expect(selectionBody.max_tokens).toBe(256);
    expect(selectionBody.stream).toBe(false);

    // Second call = response (has persona + selected knowledge)
    const responseBody = inner.requestBodies()[1]!;
    const resSystem = responseBody.system as string;
    expect(resSystem).toContain('You are a social media expert.');
    expect(resSystem).toContain('LinkedIn Posting');
    expect(resSystem).not.toContain('X Threads'); // not selected

    // Response content
    const result = parseBody(res.body);
    const content = result.content as { type: string; text: string }[];
    expect(content[0]!.text).toBe('Here is how to post on LinkedIn.');
  });

  it('injects no knowledge when selection returns NONE', async () => {
    const inner = mockProvider({
      responses: [
        makeAnthropicTextResponse('NONE'),
        makeAnthropicTextResponse('Generic answer.'),
      ],
    });
    const agent = new BoundAgentProvider(inner, agentWithKnowledge());

    await agent.handleRequest(makeReq({ messages: [{ role: 'user', content: 'What time is it?' }] }));

    expect(inner.callCount()).toBe(2);

    // Response call should have base system prompt only (no knowledge)
    const responseBody = inner.requestBodies()[1]!;
    const system = responseBody.system as string;
    expect(system).toContain('You are a social media expert.');
    expect(system).not.toContain('LinkedIn Posting');
    expect(system).not.toContain('X Threads');
  });

  it('selects multiple knowledge modules', async () => {
    const inner = mockProvider({
      responses: [
        makeAnthropicTextResponse('linkedin-posting\ncontent-strategy'),
        makeAnthropicTextResponse('Combined answer.'),
      ],
    });
    const agent = new BoundAgentProvider(inner, agentWithKnowledge());

    await agent.handleRequest(makeReq({
      messages: [{ role: 'user', content: 'Plan my LinkedIn content' }],
    }));

    const responseBody = inner.requestBodies()[1]!;
    const system = responseBody.system as string;
    expect(system).toContain('LinkedIn Posting');
    expect(system).toContain('Content Strategy');
    expect(system).not.toContain('X Threads');
  });

  it('handles bullet-formatted selection response', async () => {
    const inner = mockProvider({
      responses: [
        makeAnthropicTextResponse('- linkedin-posting\n- content-strategy'),
        makeAnthropicTextResponse('done'),
      ],
    });
    const agent = new BoundAgentProvider(inner, agentWithKnowledge());

    await agent.handleRequest(makeReq({
      messages: [{ role: 'user', content: 'Help with LinkedIn' }],
    }));

    const responseBody = inner.requestBodies()[1]!;
    const system = responseBody.system as string;
    expect(system).toContain('LinkedIn Posting');
    expect(system).toContain('Content Strategy');
  });

  it('falls back to all modules when selection response is unparseable', async () => {
    const inner = mockProvider({
      responses: [
        makeAnthropicTextResponse('I think you should use linkedin and content modules for this.'),
        makeAnthropicTextResponse('done'),
      ],
    });
    const agent = new BoundAgentProvider(inner, agentWithKnowledge());

    await agent.handleRequest(makeReq({
      messages: [{ role: 'user', content: 'Help me' }],
    }));

    // Unparseable → falls back to all modules
    const responseBody = inner.requestBodies()[1]!;
    const system = responseBody.system as string;
    expect(system).toContain('LinkedIn Posting');
    expect(system).toContain('X Threads');
    expect(system).toContain('Content Strategy');
  });

  it('preserves service/model in selection request', async () => {
    const inner = mockProvider({
      responses: [
        makeAnthropicTextResponse('NONE'),
        makeAnthropicTextResponse('ok'),
      ],
    });
    const agent = new BoundAgentProvider(inner, agentWithKnowledge());

    await agent.handleRequest(makeReq({
      model: 'claude-sonnet-4-5-20250929',
      messages: [{ role: 'user', content: 'hi' }],
    }));

    const selectionBody = inner.requestBodies()[0]!;
    expect(selectionBody.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('selection request uses unique requestId', async () => {
    const inner = mockProvider({
      responses: [
        makeAnthropicTextResponse('NONE'),
        makeAnthropicTextResponse('ok'),
      ],
    });
    const agent = new BoundAgentProvider(inner, agentWithKnowledge());

    await agent.handleRequest(makeReq({ messages: [{ role: 'user', content: 'hi' }] }));

    const selectionReqId = inner.allRequests()[0]!.requestId;
    const responseReqId = inner.allRequests()[1]!.requestId;
    expect(selectionReqId).not.toBe(responseReqId);
    expect(selectionReqId).toMatch(/^sel-/);
  });

  it('guardrails and confidentiality present in response system prompt', async () => {
    const inner = mockProvider({
      responses: [
        makeAnthropicTextResponse('linkedin-posting'),
        makeAnthropicTextResponse('done'),
      ],
    });
    const agent = new BoundAgentProvider(inner, agentWithKnowledge());

    await agent.handleRequest(makeReq({ messages: [{ role: 'user', content: 'hi' }] }));

    const responseBody = inner.requestBodies()[1]!;
    const system = responseBody.system as string;
    expect(system).toContain('Always disclose AI when asked');
    expect(system).toContain('confidential');
  });
});

describe('BoundAgentProvider — knowledge selection (OpenAI)', () => {
  it('runs selection and response in OpenAI format', async () => {
    const inner = mockProvider({
      responses: [
        makeOpenAITextResponse('linkedin-posting'),
        makeOpenAITextResponse('LinkedIn tips here.'),
      ],
    });
    const agent = new BoundAgentProvider(inner, agentWithKnowledge());

    const req = makeReq(
      { messages: [{ role: 'user', content: 'LinkedIn help' }] },
      '/v1/chat/completions',
    );
    const res = await agent.handleRequest(req);

    expect(inner.callCount()).toBe(2);

    // Selection: system message with catalog
    const selBody = inner.requestBodies()[0]!;
    const selMessages = selBody.messages as { role: string; content: string }[];
    expect(selMessages[0]!.role).toBe('system');
    expect(selMessages[0]!.content).toContain('knowledge router');
    expect(selBody.stream).toBe(false);

    // Response: system message with persona + knowledge
    const resBody = inner.requestBodies()[1]!;
    const resMessages = resBody.messages as { role: string; content: string }[];
    const systemMsg = resMessages.find(m => m.role === 'system');
    expect(systemMsg!.content).toContain('You are a social media expert.');
    expect(systemMsg!.content).toContain('LinkedIn Posting');
    expect(systemMsg!.content).not.toContain('X Threads');

    // Response content
    const result = parseBody(res.body);
    const choices = result.choices as { message: { content: string } }[];
    expect(choices[0]!.message.content).toBe('LinkedIn tips here.');
  });
});

describe('BoundAgentProvider — streaming', () => {
  it('streams the response call (selection is always buffered)', async () => {
    const inner = mockProvider({
      responses: [
        makeAnthropicTextResponse('linkedin-posting'),
        makeAnthropicTextResponse('Streamed response.'),
      ],
    });
    const agent = new BoundAgentProvider(inner, agentWithKnowledge());

    let streamStarted = false;
    const chunks: Uint8Array[] = [];

    const req = makeReq({ messages: [{ role: 'user', content: 'LinkedIn tips' }] });
    const res = await agent.handleRequestStream!(req, {
      onResponseStart: () => { streamStarted = true; },
      onResponseChunk: (chunk) => { chunks.push(chunk.data); },
    });

    expect(streamStarted).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(inner.callCount()).toBe(2);

    // Selection was buffered (handleRequest), response was streamed (handleRequestStream)
    // The mock provider tracks all requests in allRequests(), but we can verify
    // the selection call used handleRequest by checking its requestId
    const selReq = inner.allRequests()[0]!;
    expect(selReq.requestId).toMatch(/^sel-/);
  });

  it('streams directly with persona only (no selection)', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('direct')] });
    const agent = new BoundAgentProvider(inner, personaOnlyAgent());

    let streamStarted = false;
    const req = makeReq({ messages: [{ role: 'user', content: 'hi' }] });
    await agent.handleRequestStream!(req, {
      onResponseStart: () => { streamStarted = true; },
      onResponseChunk: () => {},
    });

    expect(streamStarted).toBe(true);
    expect(inner.callCount()).toBe(1);
  });

  it('no tools in the streamed response', async () => {
    const inner = mockProvider({
      responses: [
        makeAnthropicTextResponse('linkedin-posting'),
        makeAnthropicTextResponse('Clean response.'),
      ],
    });
    const agent = new BoundAgentProvider(inner, agentWithKnowledge());

    const req = makeReq({ messages: [{ role: 'user', content: 'help' }] });
    await agent.handleRequestStream!(req, {
      onResponseStart: () => {},
      onResponseChunk: () => {},
    });

    // Response call should have no tools
    const responseBody = inner.requestBodies()[1]!;
    expect(responseBody.tools).toBeUndefined();
  });
});

describe('BoundAgentProvider — error handling', () => {
  it('falls back to all modules when selection call fails', async () => {
    const _callIndex = { value: 0 };
    const inner: Provider & { requestBodies: () => Record<string, unknown>[] } = {
      name: 'mock',
      services: ['test'],
      pricing: { defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
      maxConcurrency: 10,
      serviceCategories: undefined,
      serviceApiProtocols: undefined,
      getCapacity: () => ({ current: 0, max: 10 }),
      handleRequest: async (req: SerializedHttpRequest): Promise<SerializedHttpResponse> => {
        _callIndex.value++;
        if (_callIndex.value === 1) {
          // Selection call fails
          throw new Error('upstream error');
        }
        (inner as unknown as { _bodies: Record<string, unknown>[] })._bodies.push(
          parseBody(req.body),
        );
        return {
          requestId: req.requestId,
          statusCode: 200,
          headers: {},
          body: makeAnthropicTextResponse('recovered'),
        };
      },
      requestBodies: () => (inner as unknown as { _bodies: Record<string, unknown>[] })._bodies,
    } as unknown as Provider & { requestBodies: () => Record<string, unknown>[] };
    (inner as unknown as { _bodies: Record<string, unknown>[] })._bodies = [];

    const agent = new BoundAgentProvider(inner, agentWithKnowledge());
    const res = await agent.handleRequest(makeReq({
      messages: [{ role: 'user', content: 'help' }],
    }));

    expect(res.statusCode).toBe(200);
    // Should have fallen back to all modules
    const body = (inner as unknown as { _bodies: Record<string, unknown>[] })._bodies[0]!;
    const system = body.system as string;
    expect(system).toContain('LinkedIn Posting');
    expect(system).toContain('X Threads');
    expect(system).toContain('Content Strategy');
  });

  it('passes through non-JSON requests unchanged', async () => {
    const inner = mockProvider({ responses: [] });
    const agent = new BoundAgentProvider(inner, personaOnlyAgent());

    const req: SerializedHttpRequest = {
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/messages',
      headers: {},
      body: new TextEncoder().encode('not json'),
    };

    // The inner provider will be called with the original request
    const originalHandler = inner.handleRequest;
    let receivedReq: SerializedHttpRequest | null = null;
    (inner as { handleRequest: typeof originalHandler }).handleRequest = async (r) => {
      receivedReq = r;
      return { requestId: r.requestId, statusCode: 200, headers: {}, body: makeAnthropicTextResponse('ok') };
    };

    await agent.handleRequest(req);
    expect(receivedReq).toBe(req); // Same reference — passed through unchanged
  });
});

describe('BoundAgentProvider — custom confidentiality prompt', () => {
  it('uses custom confidentiality prompt when provided', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('ok')] });
    const agent = new BoundAgentProvider(inner, {
      ...personaOnlyAgent(),
      confidentialityPrompt: 'Custom: keep everything secret.',
    });

    await agent.handleRequest(makeReq({ messages: [{ role: 'user', content: 'hi' }] }));

    const body = inner.requestBodies()[0]!;
    const system = body.system as string;
    expect(system).toContain('Custom: keep everything secret.');
    expect(system).not.toContain('private and confidential');
  });
});

describe('BoundAgentProvider — Provider interface delegation', () => {
  it('delegates name, services, pricing, maxConcurrency', () => {
    const inner = mockProvider({ responses: [] });
    const agent = new BoundAgentProvider(inner, personaOnlyAgent());

    expect(agent.name).toBe('mock');
    expect(agent.services).toEqual(['claude-sonnet-4-5-20250929']);
    expect(agent.pricing).toEqual({ defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } });
    expect(agent.maxConcurrency).toBe(10);
    expect(agent.getCapacity()).toEqual({ current: 0, max: 10 });
  });
});
