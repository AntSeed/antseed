import { describe, expect, it } from 'vitest';
import { createUnitBillingModel, type UnitBillingContext } from '@antseed/protocol/billing';
import { captureUnitBillingContext, computeFinalUnitBilling } from './unit-billing.js';

const context: UnitBillingContext = { sellerPeerId: 'a'.repeat(40), provider: 'example', service: 'image', serviceApiProtocol: 'openai-images', maxQuantity: 4 };
const response = (body: unknown, statusCode = 200) => ({ requestId: 'request', statusCode, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) });
const imageModel = createUnitBillingModel('40000');

describe('adapter-defined quantity billing', () => {
  it('captures immutable request facts before upstream rewriting and prices partial delivery', () => {
    const model = { version: 2 as const, components: [{ priceMicroUsdc: '40000', match: { model: 'public-alias', quality: 'hd' } }, { priceMicroUsdc: '20000', match: { size: '1536x1024' } }] };
    const request = { requestId: 'request', method: 'POST', path: '/v1/images/generations', headers: {}, body: new TextEncoder().encode(JSON.stringify({ model: 'public-alias', quality: 'hd', size: '1536x1024', n: 3 })) };
    const buyer = captureUnitBillingContext({ ...context, service: 'public-alias', unitModel: model, request });
    const seller = captureUnitBillingContext({ ...context, service: 'public-alias', unitModel: model, request });
    request.body = new TextEncoder().encode(JSON.stringify({ model: 'upstream-model', quality: 'standard' }));
    expect(buyer).toEqual(seller);
    expect(computeFinalUnitBilling(model, buyer.context, response({ data: [{ b64_json: 'one' }, { b64_json: 'two' }] })).costUsdc).toBe(120000n);
  });
  it('rejects unmatched and unsupported conditions before sending a request', () => {
    const request = { requestId: 'request', method: 'POST', path: '/v1/images/generations', headers: {}, body: new TextEncoder().encode(JSON.stringify({ quality: 'standard' })) };
    expect(() => captureUnitBillingContext({ ...context, request, unitModel: { version: 2, components: [{ priceMicroUsdc: '0', match: { quality: 'hd' } }] } })).toThrow('No billing component matched');
    expect(() => captureUnitBillingContext({ ...context, request, unitModel: { version: 2, components: [{ priceMicroUsdc: '1', match: { arbitrary: 'standard' } }] } })).toThrow('unsupported');
  });
  it('captures image request limits and adapter attributes without billing unit names', () => {
    const captured = captureUnitBillingContext({ ...context, request: { requestId: 'request', method: 'POST', path: '/v1/images/generations', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ n: 4, prompt: 'hello', quality: 'high' })) } });
    expect(captured.context.maxQuantity).toBe(4);
    expect(captured.requestUsage).toEqual({ quantity: 4 });
    expect(captured.context).not.toHaveProperty('unitLimits');
    expect(captured.context.attributes).toEqual({ quality: 'high', size: 'auto' });
  });
  it.each([0, -1, 0.5, 'invalid', Number.MAX_SAFE_INTEGER + 1, null, true, [4], { count: 4 }])('rejects invalid requested quantities %j', quantity => {
    expect(() => captureUnitBillingContext({ ...context, request: { requestId: 'request', method: 'POST', path: '/v1/images/generations', headers: {}, body: new TextEncoder().encode(JSON.stringify({ n: quantity })) } })).toThrow();
  });
  it('charges for accepted images, including partial fulfillment', () => {
    const result = computeFinalUnitBilling(imageModel, context, response({ data: [{ b64_json: 'image-one' }, { url: 'https://example.com/image.png' }, {}] }));
    expect(result.usage).toEqual({ quantity: 2 });
    expect(result.costUsdc).toBe(80000n);
    expect(result.billingUsage).toEqual({ version: 2, quantity: '2' });
  });
  it('rejects more delivered images than requested', () => {
    expect(() => computeFinalUnitBilling(imageModel, { ...context, maxQuantity: 1 }, response({ data: [{ b64_json: 'one' }, { b64_json: 'two' }] }))).toThrow('limit');
  });
  it.each([{}, { data: [] }, { data: [{}] }, { error: 'failed', data: [{ b64_json: 'image' }] }])('does not charge for unfulfilled images %j', body => {
    expect(computeFinalUnitBilling(imageModel, context, response(body)).costUsdc).toBe(0n);
  });
  it.each([302, 400, 500])('does not charge for HTTP %s', status => {
    expect(computeFinalUnitBilling(imageModel, context, response({ data: [{ b64_json: 'image' }] }, status)).costUsdc).toBe(0n);
  });
  it('counts one accepted chat result, not its token count', () => {
    const result = computeFinalUnitBilling(createUnitBillingModel('5000'), { ...context, serviceApiProtocol: 'openai-chat-completions', maxQuantity: 1 }, response({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 99, completion_tokens: 10 } }));
    expect(result.usage).toEqual({ quantity: 1 });
    expect(result.costUsdc).toBe(5000n);
  });
  it('does not treat an empty 2xx response as fulfilled', () => {
    for (const serviceApiProtocol of ['openai-chat-completions', 'antseed-routing'] as const) expect(computeFinalUnitBilling(createUnitBillingModel('5000'), { ...context, serviceApiProtocol }, response({})).costUsdc).toBe(0n);
  });
  it('counts a routing response as one result', () => {
    expect(computeFinalUnitBilling(createUnitBillingModel('5000'), { ...context, serviceApiProtocol: 'antseed-routing' }, response({ version: 1, recommendations: [{ serviceId: 'model' }] })).usage).toEqual({ quantity: 1 });
  });
});
