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

function allowSet(...models: string[]): ReadonlySet<string> {
  return new Set(models.map((m) => m.trim().toLowerCase()));
}

describe('Security: allowed-model validation', () => {
  it('rejects duplicate model keys that end with a forbidden model', () => {
    const request = makeRequest(
      '{"model":"claude-sonnet-4-5-20250929","model":"claude-opus-4-0-20250514"}',
    );

    const error = validateRequestModel(request, allowSet('claude-sonnet-4-5-20250929'));
    expect(error).toContain('not in the allowed list');
  });

  it('allows invalid JSON payloads through (upstream will reject them)', () => {
    const request = makeRequest('{not-valid-json');
    expect(validateRequestModel(request, allowSet('claude-sonnet-4-5-20250929'))).toBeNull();
  });

  it('allows valid payloads with allowed models', () => {
    const request = makeRequest('{"model":"claude-sonnet-4-5-20250929","messages":[]}');
    expect(validateRequestModel(request, allowSet('claude-sonnet-4-5-20250929'))).toBeNull();
  });
});
