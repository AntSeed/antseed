import { describe, expect, it } from 'vitest';
import { getServiceMetadataId, ZERO_METADATA } from '@antseed/protocol/signatures';
import { advanceUsageMetadata, normalizeRequestUsageDelta } from './channel-usage-accounting.js';

describe('normalizeRequestUsageDelta', () => {
  const delta = {
    amount: 25_000n,
    inputTokens: 11n,
    cachedInputTokens: 3n,
    outputTokens: 7n,
    requests: 1n,
  };

  it('removes duplicate amount and usage for an already-counted response', () => {
    expect(normalizeRequestUsageDelta(delta, {
      deliveredResponse: true,
      alreadyCounted: true,
    })).toEqual({
      amount: 0n,
      inputTokens: 0n,
      cachedInputTokens: 0n,
      outputTokens: 0n,
      requests: 0n,
    });
  });

  it('preserves the first delivered response accounting delta unchanged', () => {
    expect(normalizeRequestUsageDelta(delta, {
      deliveredResponse: true,
      alreadyCounted: false,
    })).toBe(delta);
  });

  it('does not count a budget/headroom authorization as a response', () => {
    expect(normalizeRequestUsageDelta(delta, {
      deliveredResponse: false,
      alreadyCounted: false,
    })).toEqual({
      amount: 0n,
      inputTokens: 0n,
      cachedInputTokens: 0n,
      outputTokens: 0n,
      requests: 0n,
    });
  });
});

describe('NeedAuth and post-response metadata accounting', () => {
  it('attributes an image charge exactly once when both paths report it', () => {
    const service = 'qwen-image-3-pro';
    const afterNeedAuth = advanceUsageMetadata(ZERO_METADATA, service, {
      amount: 25_000n,
      inputTokens: 0n,
      cachedInputTokens: 0n,
      outputTokens: 0n,
      requests: 1n,
    });
    const afterPostResponse = advanceUsageMetadata(
      afterNeedAuth,
      service,
      normalizeRequestUsageDelta({
        amount: 25_000n,
        inputTokens: 0n,
        cachedInputTokens: 0n,
        outputTokens: 0n,
        requests: 1n,
      }, { deliveredResponse: true, alreadyCounted: true }),
    );

    expect(afterPostResponse).toEqual({
      cumulativeInputTokens: 0n,
      cumulativeOutputTokens: 0n,
      cumulativeRequestCount: 1n,
      services: [{
        serviceId: getServiceMetadataId(service),
        cumulativeAmount: 25_000n,
        cumulativeInputTokens: 0n,
        cumulativeCachedInputTokens: 0n,
        cumulativeOutputTokens: 0n,
        cumulativeRequestCount: 1n,
      }],
    });
  });
});
