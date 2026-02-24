import { describe, it, expect } from 'vitest';
import {
  detectProviderFromHeaders,
  detectProviderFromPath,
  resolveProvider,
  ANTSEED_PROVIDER_HEADER,
} from '../src/proxy/provider-detection.js';

describe('detectProviderFromHeaders', () => {
  it('should detect anthropic from header', () => {
    expect(detectProviderFromHeaders({ [ANTSEED_PROVIDER_HEADER]: 'anthropic' })).toBe('anthropic');
  });

  it('should detect openai from header', () => {
    expect(detectProviderFromHeaders({ [ANTSEED_PROVIDER_HEADER]: 'openai' })).toBe('openai');
  });

  it('should detect google from header', () => {
    expect(detectProviderFromHeaders({ [ANTSEED_PROVIDER_HEADER]: 'google' })).toBe('google');
  });

  it('should detect moonshot from header', () => {
    expect(detectProviderFromHeaders({ [ANTSEED_PROVIDER_HEADER]: 'moonshot' })).toBe('moonshot');
  });

  it('should be case-insensitive for header name', () => {
    expect(detectProviderFromHeaders({ 'X-ANTSEED-PROVIDER': 'anthropic' })).toBe('anthropic');
  });

  it('should trim and lowercase the header value', () => {
    expect(detectProviderFromHeaders({ [ANTSEED_PROVIDER_HEADER]: '  OPENAI  ' })).toBe('openai');
  });

  it('should return null for unknown provider', () => {
    expect(detectProviderFromHeaders({ [ANTSEED_PROVIDER_HEADER]: 'unknown' })).toBeNull();
  });

  it('should return null when header is missing', () => {
    expect(detectProviderFromHeaders({ 'content-type': 'application/json' })).toBeNull();
  });
});

describe('detectProviderFromPath', () => {
  it('should detect anthropic from /v1/messages', () => {
    expect(detectProviderFromPath('/v1/messages')).toBe('anthropic');
  });

  it('should detect anthropic from /v1/complete', () => {
    expect(detectProviderFromPath('/v1/complete')).toBe('anthropic');
  });

  it('should detect openai from /v1/chat/completions', () => {
    expect(detectProviderFromPath('/v1/chat/completions')).toBe('openai');
  });

  it('should detect openai from /v1/completions', () => {
    expect(detectProviderFromPath('/v1/completions')).toBe('openai');
  });

  it('should detect openai from /v1/embeddings', () => {
    expect(detectProviderFromPath('/v1/embeddings')).toBe('openai');
  });

  it('should detect google from /v1beta/ paths', () => {
    expect(detectProviderFromPath('/v1beta/models/gemini-pro:generateContent')).toBe('google');
  });

  it('should detect google from /v1/models/gemini paths', () => {
    expect(detectProviderFromPath('/v1/models/gemini-pro:generateContent')).toBe('google');
  });

  it('should detect moonshot from paths containing moonshot', () => {
    expect(detectProviderFromPath('/v1/moonshot/chat/completions')).toBe('moonshot');
  });

  it('should prioritize moonshot over openai for ambiguous paths', () => {
    // moonshot check happens before openai
    expect(detectProviderFromPath('/v1/chat/moonshot/completions')).toBe('moonshot');
  });

  it('should return null for unrecognized paths', () => {
    expect(detectProviderFromPath('/api/v2/infer')).toBeNull();
  });

  it('should be case-insensitive', () => {
    expect(detectProviderFromPath('/V1/Messages')).toBe('anthropic');
  });
});

describe('resolveProvider', () => {
  it('should prefer header over path', () => {
    const result = resolveProvider('/v1/chat/completions', {
      [ANTSEED_PROVIDER_HEADER]: 'anthropic',
    }, 'openai');
    expect(result).toBe('anthropic');
  });

  it('should fall back to path when header is absent', () => {
    const result = resolveProvider('/v1/messages', {}, 'openai');
    expect(result).toBe('anthropic');
  });

  it('should fall back to default when neither header nor path matches', () => {
    const result = resolveProvider('/unknown', {}, 'openai');
    expect(result).toBe('openai');
  });
});
