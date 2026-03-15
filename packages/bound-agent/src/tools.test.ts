import { describe, it, expect } from 'vitest';
import type { KnowledgeModule } from './loader.js';
import {
  buildKnowledgeToolAnthropic,
  buildKnowledgeToolOpenAI,
  injectTools,
  inspectResponse,
  executeTools,
  appendToolLoop,
  stripInternalToolCalls,
  TOOL_PREFIX,
} from './tools.js';

const testModules: KnowledgeModule[] = [
  { name: 'pricing', description: 'Pricing info', content: 'Price is $10/mo' },
  { name: 'faq', description: 'Frequently asked questions', content: 'Q: What? A: That.' },
];

describe('buildKnowledgeToolAnthropic', () => {
  it('embeds catalog in description', () => {
    const tool = buildKnowledgeToolAnthropic(testModules) as Record<string, unknown>;
    expect(tool.name).toBe('antseed_load_knowledge');
    const desc = tool.description as string;
    expect(desc).toContain('- pricing: Pricing info');
    expect(desc).toContain('- faq: Frequently asked questions');
  });

  it('uses antseed_load_knowledge as tool name', () => {
    const tool = buildKnowledgeToolAnthropic(testModules);
    expect(tool.name).toBe(`${TOOL_PREFIX}load_knowledge`);
  });
});

describe('buildKnowledgeToolOpenAI', () => {
  it('embeds catalog in description', () => {
    const tool = buildKnowledgeToolOpenAI(testModules) as Record<string, unknown>;
    expect(tool.type).toBe('function');
    const fn = tool.function as Record<string, unknown>;
    expect(fn.name).toBe('antseed_load_knowledge');
    const desc = fn.description as string;
    expect(desc).toContain('- pricing: Pricing info');
    expect(desc).toContain('- faq: Frequently asked questions');
  });

  it('uses antseed_load_knowledge as tool name', () => {
    const tool = buildKnowledgeToolOpenAI(testModules);
    const fn = (tool as Record<string, unknown>).function as Record<string, unknown>;
    expect(fn.name).toBe(`${TOOL_PREFIX}load_knowledge`);
  });
});

describe('injectTools', () => {
  it('appends internal tool to existing buyer tools', () => {
    const body = { tools: [{ name: 'buyer_tool' }], messages: [] };
    const result = injectTools(body, testModules, 'anthropic');
    const tools = result.tools as unknown[];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({ name: 'buyer_tool' });
    expect((tools[1] as Record<string, unknown>).name).toBe('antseed_load_knowledge');
  });

  it('returns body unchanged when no modules', () => {
    const body = { tools: [{ name: 'buyer_tool' }], messages: [] };
    const result = injectTools(body, [], 'anthropic');
    expect(result).toBe(body); // same reference
  });

  it('skips injection when tool_choice forces specific function (Anthropic)', () => {
    const body = {
      tools: [{ name: 'buyer_tool' }],
      tool_choice: { type: 'tool', name: 'buyer_tool' },
      messages: [],
    };
    const result = injectTools(body, testModules, 'anthropic');
    expect(result).toBe(body);
  });

  it('skips injection when tool_choice forces specific function (OpenAI)', () => {
    const body = {
      tools: [{ type: 'function', function: { name: 'buyer_tool' } }],
      tool_choice: { type: 'function', function: { name: 'buyer_tool' } },
      messages: [],
    };
    const result = injectTools(body, testModules, 'openai');
    expect(result).toBe(body);
  });

  it('creates tools array when body has no tools', () => {
    const body = { messages: [] };
    const result = injectTools(body, testModules, 'anthropic');
    const tools = result.tools as unknown[];
    expect(tools).toHaveLength(1);
    expect((tools[0] as Record<string, unknown>).name).toBe('antseed_load_knowledge');
  });
});

describe('inspectResponse', () => {
  it('returns done for text-only response (Anthropic)', () => {
    const response = { content: [{ type: 'text', text: 'hi' }] };
    const action = inspectResponse(response, 'anthropic');
    expect(action.type).toBe('done');
  });

  it('returns done for text-only response (OpenAI)', () => {
    const response = {
      choices: [{ message: { content: 'hi' } }],
    };
    const action = inspectResponse(response, 'openai');
    expect(action.type).toBe('done');
  });

  it('returns done for buyer-only tool calls (Anthropic)', () => {
    const response = {
      content: [
        { type: 'tool_use', id: 'tc1', name: 'buyer_search', input: { q: 'test' } },
      ],
    };
    const action = inspectResponse(response, 'anthropic');
    expect(action.type).toBe('done');
  });

  it('returns done for buyer-only tool calls (OpenAI)', () => {
    const response = {
      choices: [{
        message: {
          tool_calls: [{
            id: 'tc1',
            function: { name: 'buyer_search', arguments: '{"q":"test"}' },
          }],
        },
      }],
    };
    const action = inspectResponse(response, 'openai');
    expect(action.type).toBe('done');
  });

  it('returns continue with internal calls for antseed_* calls (Anthropic)', () => {
    const response = {
      content: [
        { type: 'tool_use', id: 'tc1', name: 'antseed_load_knowledge', input: { name: 'pricing' } },
      ],
    };
    const action = inspectResponse(response, 'anthropic');
    expect(action.type).toBe('continue');
    if (action.type === 'continue') {
      expect(action.internalCalls).toHaveLength(1);
      expect(action.internalCalls[0].name).toBe('antseed_load_knowledge');
    }
  });

  it('returns continue with internal calls for antseed_* calls (OpenAI)', () => {
    const response = {
      choices: [{
        message: {
          tool_calls: [{
            id: 'tc1',
            function: { name: 'antseed_load_knowledge', arguments: '{"name":"pricing"}' },
          }],
        },
      }],
    };
    const action = inspectResponse(response, 'openai');
    expect(action.type).toBe('continue');
    if (action.type === 'continue') {
      expect(action.internalCalls).toHaveLength(1);
      expect(action.internalCalls[0].name).toBe('antseed_load_knowledge');
    }
  });

  it('returns continue when mixed — only internal calls in result (Anthropic)', () => {
    const response = {
      content: [
        { type: 'tool_use', id: 'tc1', name: 'buyer_search', input: { q: 'test' } },
        { type: 'tool_use', id: 'tc2', name: 'antseed_load_knowledge', input: { name: 'faq' } },
      ],
    };
    const action = inspectResponse(response, 'anthropic');
    expect(action.type).toBe('continue');
    if (action.type === 'continue') {
      expect(action.internalCalls).toHaveLength(1);
      expect(action.internalCalls[0].id).toBe('tc2');
    }
  });

  it('returns continue when mixed — only internal calls in result (OpenAI)', () => {
    const response = {
      choices: [{
        message: {
          tool_calls: [
            { id: 'tc1', function: { name: 'buyer_search', arguments: '{"q":"test"}' } },
            { id: 'tc2', function: { name: 'antseed_load_knowledge', arguments: '{"name":"faq"}' } },
          ],
        },
      }],
    };
    const action = inspectResponse(response, 'openai');
    expect(action.type).toBe('continue');
    if (action.type === 'continue') {
      expect(action.internalCalls).toHaveLength(1);
      expect(action.internalCalls[0].id).toBe('tc2');
    }
  });
});

describe('executeTools', () => {
  it('returns module content for valid knowledge load', () => {
    const calls = [{ id: 'tc1', name: 'antseed_load_knowledge', arguments: { name: 'pricing' } }];
    const results = executeTools(calls, testModules);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Price is $10/mo');
    expect(results[0].isError).toBe(false);
  });

  it('returns error for unknown module', () => {
    const calls = [{ id: 'tc1', name: 'antseed_load_knowledge', arguments: { name: 'nonexistent' } }];
    const results = executeTools(calls, testModules);
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].content).toContain('not found');
  });

  it('returns error for unknown tool name', () => {
    const calls = [{ id: 'tc1', name: 'antseed_unknown', arguments: {} }];
    const results = executeTools(calls, testModules);
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].content).toContain('Unknown tool');
  });
});

describe('appendToolLoop', () => {
  it('appends correctly in Anthropic format', () => {
    const body = { messages: [{ role: 'user', content: 'hello' }], model: 'claude' };
    const assistantResponse = {
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'tc1', name: 'antseed_load_knowledge', input: { name: 'pricing' } },
      ],
    };
    const results = [{ id: 'tc1', content: 'Price is $10/mo', isError: false }];

    const updated = appendToolLoop(body, assistantResponse, results, 'anthropic');
    const msgs = updated.messages as Record<string, unknown>[];
    expect(msgs).toHaveLength(3); // original + assistant + user tool_result
    expect(msgs[1]).toEqual({ role: 'assistant', content: assistantResponse.content });
    expect((msgs[2] as Record<string, unknown>).role).toBe('user');
    const resultBlocks = (msgs[2] as Record<string, unknown>).content as Record<string, unknown>[];
    expect(resultBlocks[0].type).toBe('tool_result');
    expect(resultBlocks[0].tool_use_id).toBe('tc1');
    expect(resultBlocks[0].content).toBe('Price is $10/mo');
  });

  it('appends correctly in OpenAI format', () => {
    const body = { messages: [{ role: 'user', content: 'hello' }], model: 'gpt-4' };
    const assistantResponse = {
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'tc1',
            function: { name: 'antseed_load_knowledge', arguments: '{"name":"pricing"}' },
          }],
        },
      }],
    };
    const results = [{ id: 'tc1', content: 'Price is $10/mo', isError: false }];

    const updated = appendToolLoop(body, assistantResponse, results, 'openai');
    const msgs = updated.messages as Record<string, unknown>[];
    expect(msgs).toHaveLength(3); // original + assistant msg + tool msg
    expect(msgs[1]).toEqual(assistantResponse.choices[0].message);
    expect(msgs[2]).toEqual({ role: 'tool', tool_call_id: 'tc1', content: 'Price is $10/mo' });
  });
});

describe('stripInternalToolCalls', () => {
  it('strips antseed_* calls, keeps buyer calls (Anthropic)', () => {
    const response = {
      content: [
        { type: 'text', text: 'Here you go' },
        { type: 'tool_use', id: 'tc1', name: 'buyer_search', input: {} },
        { type: 'tool_use', id: 'tc2', name: 'antseed_load_knowledge', input: { name: 'faq' } },
      ],
    };
    const stripped = stripInternalToolCalls(response, 'anthropic');
    const content = stripped.content as Record<string, unknown>[];
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'Here you go' });
    expect((content[1] as Record<string, unknown>).name).toBe('buyer_search');
  });

  it('strips antseed_* calls, keeps buyer calls (OpenAI)', () => {
    const response = {
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [
            { id: 'tc1', function: { name: 'buyer_search', arguments: '{}' } },
            { id: 'tc2', function: { name: 'antseed_load_knowledge', arguments: '{"name":"faq"}' } },
          ],
        },
      }],
    };
    const stripped = stripInternalToolCalls(response, 'openai');
    const choices = stripped.choices as { message: Record<string, unknown> }[];
    const toolCalls = choices[0].message.tool_calls as Record<string, unknown>[];
    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as { function: { name: string } }).function.name).toBe('buyer_search');
  });

  it('handles response with no tool calls — no-op (Anthropic)', () => {
    const response = { content: [{ type: 'text', text: 'hello' }] };
    const stripped = stripInternalToolCalls(response, 'anthropic');
    const content = stripped.content as Record<string, unknown>[];
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('handles response with no tool calls — no-op (OpenAI)', () => {
    const response = {
      choices: [{ message: { role: 'assistant', content: 'hello' } }],
    };
    const stripped = stripInternalToolCalls(response, 'openai');
    expect(stripped).toEqual(response);
  });

  it('removes tool_calls key when all are internal (OpenAI)', () => {
    const response = {
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [
            { id: 'tc1', function: { name: 'antseed_load_knowledge', arguments: '{}' } },
          ],
        },
      }],
    };
    const stripped = stripInternalToolCalls(response, 'openai');
    const choices = stripped.choices as { message: Record<string, unknown> }[];
    expect(choices[0].message.tool_calls).toBeUndefined();
  });
});
