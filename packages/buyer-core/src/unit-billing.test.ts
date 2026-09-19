import { describe, expect, it } from 'vitest';
import { createPerCallBillingModel, type UnitBillingContext, type UnitBillingModelV1 } from '@antseed/protocol/billing';
import type { SerializedHttpResponse } from '@antseed/protocol/http';
import { captureUnitBillingContext, computeFinalUnitBilling, extractUnitResponseUsage } from './unit-billing.js';

const context: UnitBillingContext = {
  sellerPeerId: 'a'.repeat(40), provider: 'openai', service: 'example', serviceApiProtocol: 'openai-images',
  attributes: { size: '1024x1024' }, unitLimits: { output_images: 1, successful_requests: 1 },
};
const imageModel: UnitBillingModelV1 = {
  version: 1, components: [{ unit: 'output_images', priceUsd: 0.04, match: { size: '1024x1024' } }],
};
const response: SerializedHttpResponse = {
  requestId: 'request', statusCode: 200, headers: { 'content-type': 'application/json' },
  body: new TextEncoder().encode(JSON.stringify({
    data: [{ b64_json: 'image' }, { url: 'https://example.test/image.png' }, {}, { b64_json: ' ' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } },
  })),
};
const tokenUsage = { inputTokens: 100, cachedInputTokens: 30, freshInputTokens: 70, outputTokens: 20 };

describe('normalized unit billing', () => {
  it('captures a classifier request without an image-specific billing entry', () => {
    const captured = captureUnitBillingContext({
      ...context, serviceApiProtocol: 'openai-chat-completions',
      request: { requestId: 'request', method: 'POST', path: '/v1/chat/completions', headers: response.headers,
        body: new TextEncoder().encode(JSON.stringify({ model: 'classifier', messages: [{ role: 'user', content: 'hello' }] })) },
    });
    expect(captured).toEqual({
      context: { ...context, serviceApiProtocol: 'openai-chat-completions', attributes: { model: 'classifier' },
        unitLimits: { successful_requests: 1 } },
      requestUsage: { units: { successful_requests: 1 } },
    });
  });

  it('normalizes image facts into generic attributes, limits, and a separate prompt estimate', () => {
    const captured = captureUnitBillingContext({
      ...context,
      request: { requestId: 'request', method: 'POST', path: '/v1/images/generations', headers: response.headers,
        body: new TextEncoder().encode(JSON.stringify({ model: 'image-model', n: 2, size: '1024x1024', prompt: 'hello' })) },
    });
    expect(captured.context.attributes).toEqual({ model: 'image-model', size: '1024x1024', quality: 'auto' });
    expect(captured.context.unitLimits).toEqual({ successful_requests: 1, output_images: 2 });
    expect(captured.requestUsage).toEqual({ units: { successful_requests: 1, output_images: 2 } });
    expect(captured.estimatedPromptTokens).toBe(1);
    expect(captured).not.toHaveProperty('requestFacts');
    captured.requestUsage.units.output_images = 99;
    expect(captured.context.unitLimits?.output_images).toBe(2);
  });

  it.each([
    { limit: undefined, count: 2 },
    { limit: 0, count: 0 },
    { limit: 1, count: 1 },
    { limit: 4, count: 2 },
  ])('uses only context limits to price delivered images: $limit', ({ limit, count }) => {
    const result = computeFinalUnitBilling(imageModel, {
      ...context, unitLimits: limit === undefined ? undefined : { output_images: limit },
    }, response);
    expect(result.usage).toEqual({ units: { output_images: count } });
    expect(result.costUsdc).toBe(BigInt(count) * 40_000n);
    expect(result.billingUsage).toEqual({ version: 1, units: { output_images: String(count) } });
    expect(result.tokenUsage).toEqual(tokenUsage);
  });

  it.each([200, 201, 204, 302, 400, 503])('measures one or zero calls without image charges for HTTP %s', (statusCode) => {
    const result = computeFinalUnitBilling(createPerCallBillingModel('5000'), context, { ...response, statusCode });
    const count = statusCode >= 200 && statusCode < 300 ? 1 : 0;
    expect(result.usage).toEqual({ units: { successful_requests: count } });
    expect(result.costUsdc).toBe(BigInt(count) * 5000n);
    expect(result.billingUsage).toEqual({ version: 1, units: { successful_requests: String(count) } });
    expect(result.tokenUsage).toEqual(tokenUsage);
  });

  it('selects observed units explicitly without a per-call boolean or post-measurement deletion', () => {
    expect(extractUnitResponseUsage(response, context.unitLimits).usage).toEqual({ units: { output_images: 1 } });
    expect(extractUnitResponseUsage(response, context.unitLimits, ['successful_requests']).usage)
      .toEqual({ units: { successful_requests: 1 } });
    expect(extractUnitResponseUsage(response, context.unitLimits, []).usage).toEqual({ units: {} });
  });

  it('retains observed image quantities for a free model without charging for them', () => {
    expect(computeFinalUnitBilling({ version: 1, components: [] }, context, response)).toMatchObject({
      usage: { units: { output_images: 1 } }, costUsdc: 0n, tokenUsage,
    });
  });
});
