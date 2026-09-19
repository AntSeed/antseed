import { describe, expect, it } from 'vitest';
import { withReasoningEffort } from './reasoning.js';
import { transformRequest } from './request-transform.js';
import type { SerializedHttpRequest, ServiceApiProtocol } from './types.js';

function request(body: Record<string, unknown>): SerializedHttpRequest {
  return { requestId: 'test', method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Length': '999' },
    body: new TextEncoder().encode(JSON.stringify({ model: 'model', messages: [{ role: 'user', content: 'task' }], ...body })) };
}
const decode = (value: SerializedHttpRequest) => JSON.parse(new TextDecoder().decode(value.body));

describe('router reasoning overrides', () => {
  it.each(['openai-chat-completions', 'openai-responses', 'anthropic-messages'] as ServiceApiProtocol[])('overrides client controls in %s without altering output limits', (protocol) => {
    const original = request({ reasoning_effort: 'low', reasoning: { effort: 'low' }, thinking: { type: 'enabled', budget_tokens: 9000 },
      output_config: { effort: 'low', format: { type: 'json_schema' } }, max_tokens: 500 });
    const result = withReasoningEffort(original, protocol, 'high');
    const body = decode(result);
    expect(body.max_tokens).toBe(500);
    expect(body.output_config.format).toEqual({ type: 'json_schema' });
    expect(result.headers).not.toHaveProperty('Content-Length');
    if (protocol === 'anthropic-messages') {
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config.effort).toBe('high');
    } else {
      expect(body.thinking).toBeUndefined();
      expect(protocol === 'openai-responses' ? body.reasoning.effort : body.reasoning_effort).toBe('high');
    }
    expect(decode(original).thinking.budget_tokens).toBe(9000);
  });
  it('disables rather than restoring client thinking and strips controls for non-reasoning services', () => {
    const original = request({ thinking: { type: 'enabled', budget_tokens: 5000 }, output_config: { effort: 'high' }, reasoning_effort: 'high' });
    expect(decode(withReasoningEffort(original, 'anthropic-messages', 'none')).thinking).toEqual({ type: 'disabled' });
    expect(decode(withReasoningEffort(original, 'openai-responses', 'none')).reasoning).toEqual({ effort: 'none' });
    expect(decode(withReasoningEffort(original, 'openai-chat-completions', 'none')).reasoning_effort).toBe('none');
    const cleared = decode(withReasoningEffort(original, 'anthropic-messages', null));
    for (const field of ['thinking', 'reasoning_effort', 'reasoning', 'output_config']) expect(cleared).not.toHaveProperty(field);
  });
  it('preserves compatible client effort during protocol conversion', () => {
    const result = transformRequest(request({ reasoning_effort: 'high' }), { from: 'openai-chat-completions', to: 'anthropic-messages' });
    expect(decode(result!.request)).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    const converted = transformRequest(result!.request, { from: 'anthropic-messages', to: 'openai-responses' });
    expect(decode(converted!.request).reasoning).toEqual({ effort: 'high' });
  });
  it('preserves same-protocol client settings when no router override is applied', () => {
    const original = request({ thinking: { type: 'enabled', budget_tokens: 6000 }, output_config: { effort: 'low' } });
    expect(transformRequest(original, { from: 'anthropic-messages', to: 'anthropic-messages' })!.request).toEqual(original);
  });
  it('rejects impossible mappings instead of dropping the choice', () => {
    expect(() => withReasoningEffort(request({}), 'antseed-routing', 'high')).toThrow();
    expect(() => withReasoningEffort(request({}), 'anthropic-messages', 'minimal')).toThrow();
    expect(() => transformRequest(request({ reasoning_effort: 'minimal' }), { from: 'openai-chat-completions', to: 'anthropic-messages' })).toThrow();
  });
});
