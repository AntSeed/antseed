import { describe, expect, it } from 'vitest';
import { detectRequestServiceApiProtocol, selectTargetProtocolForRequest } from './detect.js';
import { extractUsage } from './utils.js';

describe('structured routing protocol', () => {
  it('meters fresh and cached routing input separately', () => {
    expect(extractUsage({ version: 1, recommendations: [{ serviceId: 'model' }], usage: { input_tokens: 5, cached_input_tokens: 20, output_tokens: 2 } })).toMatchObject({ inputTokens: 25, freshInputTokens: 5, cachedInputTokens: 20, outputTokens: 2 });
  });
  it('detects only the routing endpoint and does not adapt it to chat', () => {
    expect(detectRequestServiceApiProtocol({ path: '/v1/route', headers: {} })).toBe('antseed-routing');
    expect(detectRequestServiceApiProtocol({ path: '/v1/route-other', headers: {} })).toBeNull();
    expect(selectTargetProtocolForRequest('antseed-routing', ['openai-chat-completions'])).toBeNull();
    expect(selectTargetProtocolForRequest('openai-chat-completions', ['antseed-routing'])).toBeNull();
    expect(selectTargetProtocolForRequest('antseed-routing', ['antseed-routing'])).toEqual({ targetProtocol: 'antseed-routing', requiresTransform: false });
  });
});
