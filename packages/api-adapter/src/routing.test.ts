import { describe, expect, it } from 'vitest';
import { detectRequestServiceApiProtocol, selectTargetProtocolForRequest } from './detect.js';

describe('structured routing protocol', () => {
  it('detects only the routing endpoint and does not adapt it to chat', () => {
    expect(detectRequestServiceApiProtocol({ path: '/v1/route', headers: {} })).toBe('antseed-routing');
    expect(detectRequestServiceApiProtocol({ path: '/v1/route-other', headers: {} })).toBeNull();
    expect(selectTargetProtocolForRequest('antseed-routing', ['openai-chat-completions'])).toBeNull();
    expect(selectTargetProtocolForRequest('openai-chat-completions', ['antseed-routing'])).toBeNull();
    expect(selectTargetProtocolForRequest('antseed-routing', ['antseed-routing'])).toEqual({ targetProtocol: 'antseed-routing', requiresTransform: false });
  });
});
