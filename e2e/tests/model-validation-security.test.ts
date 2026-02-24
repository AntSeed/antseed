import { describe, it, expect } from 'vitest';
import type { SerializedHttpRequest } from '@antseed/node';
import { validateRequestModel } from '@antseed/provider-core';

function makeRequest(body: string): SerializedHttpRequest {
  return {
    requestId: 'req-1',
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(body),
  };
}

describe('Security: allowed-model validation', () => {
  it('rejects duplicate model keys that end with a forbidden model', () => {
    const allowedModels = ['claude-sonnet-4-5-20250929'];
    const request = makeRequest(
      '{"model":"claude-sonnet-4-5-20250929","model":"claude-opus-4-0-20250514"}',
    );

    const error = validateRequestModel(request, allowedModels);
    expect(error).toContain('not in the allowed list');
  });

  it('rejects invalid JSON payloads when allow-list enforcement is enabled', () => {
    const allowedModels = ['claude-sonnet-4-5-20250929'];
    const request = makeRequest('{not-valid-json');
    expect(validateRequestModel(request, allowedModels)).toContain('Invalid JSON');
  });

  it('allows valid payloads with allowed models', () => {
    const allowedModels = ['claude-sonnet-4-5-20250929'];
    const request = makeRequest('{"model":"claude-sonnet-4-5-20250929","messages":[]}');
    expect(validateRequestModel(request, allowedModels)).toBeNull();
  });
});
