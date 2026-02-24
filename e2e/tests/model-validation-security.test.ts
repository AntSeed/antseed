import { describe, it, expect } from 'vitest';
import { KnownProvider, type SerializedHttpRequest, type ProviderConfig } from '@antseed/node';
import { validateRequest } from '../../provider-anthropic/src/relay/auth-swap.js';

function makeConfig(allowedModels: string[]): ProviderConfig {
  return {
    provider: KnownProvider.Anthropic,
    baseUrl: 'https://api.anthropic.com',
    authHeaderName: 'x-api-key',
    authHeaderValue: 'sk-test',
    allowedModels,
    maxConcurrency: 10,
  };
}

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
    const config = makeConfig(['claude-sonnet-4-5-20250929']);
    const request = makeRequest(
      '{"model":"claude-sonnet-4-5-20250929","model":"claude-opus-4-0-20250514"}',
    );

    const error = validateRequest(request, config);
    expect(error).toContain('not in the allowed list');
  });

  it('rejects invalid JSON payloads when allow-list enforcement is enabled', () => {
    const config = makeConfig(['claude-sonnet-4-5-20250929']);
    const request = makeRequest('{not-valid-json');
    expect(validateRequest(request, config)).toContain('Invalid JSON');
  });

  it('allows valid payloads with allowed models', () => {
    const config = makeConfig(['claude-sonnet-4-5-20250929']);
    const request = makeRequest('{"model":"claude-sonnet-4-5-20250929","messages":[]}');
    expect(validateRequest(request, config)).toBeNull();
  });
});
