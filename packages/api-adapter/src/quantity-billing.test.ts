import { describe, expect, it } from 'vitest';
import { getQuantityBillingAdapter, validateQuantityBillingConditions } from './quantity-billing.js';

const encode = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));
const request = (body: unknown) => ({ method: 'POST', path: '/v1/images/generations', headers: { 'content-type': 'application/json' }, body: encode(body) });

describe('quantity billing adapters', () => {
  it('defines adapter-specific supported attributes', () => {
    expect(getQuantityBillingAdapter('openai-images')?.pricingAttributes).toEqual(['model', 'size', 'quality', 'resolution']);
    expect(getQuantityBillingAdapter('anthropic-messages')).toBeUndefined();
    expect(validateQuantityBillingConditions('openai-images', { components: [{ match: { quality: 'hd' } }] })).toEqual([]);
    expect(validateQuantityBillingConditions('openai-images', { components: [{ match: { arbitrary: 'hd' } }] })).toHaveLength(1);
    expect(validateQuantityBillingConditions('antseed-routing', { components: [{ match: { quality: 'hd' } }] })).toHaveLength(1);
    expect(validateQuantityBillingConditions('openai-chat-completions', { components: [{ match: { model: 'chat' } }] })).toHaveLength(1);
  });
  it('normalizes request attributes without inferring upstream auto choices', () => {
    const adapter = getQuantityBillingAdapter('openai-images')!;
    expect(adapter.captureRequest(request({ service: ' public-alias ', n: 2, resolution: ' 2k ' }))).toMatchObject({
      attributes: { model: 'public-alias', size: 'auto', quality: 'auto', resolution: '2k' }, maxQuantity: 2,
    });
    expect(adapter.captureRequest(request({ model: 'model', quality: ' hd ', size: ' 1024x1024 ' })).attributes)
      .toEqual({ model: 'model', quality: 'hd', size: '1024x1024' });
  });
  it('captures identical JSON and multipart attributes', () => {
    const fields = { model: 'alias', quality: 'hd', size: '1536x1024', resolution: '2k', n: '3' };
    const boundary = 'billing-test';
    const body = Object.entries(fields).map(([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join('') + `--${boundary}--\r\n`;
    const adapter = getQuantityBillingAdapter('openai-images')!;
    const multipart = adapter.captureRequest({ method: 'POST', path: '/v1/images/edits', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: new TextEncoder().encode(body) });
    expect(multipart).toEqual(adapter.captureRequest(request(fields)));
  });
  it('rejects streaming quantity-priced chat before execution', () => {
    expect(() => getQuantityBillingAdapter('openai-chat-completions')!.captureRequest(request({ stream: true }))).toThrow('streaming');
  });
  it('measures only fulfilled responses', () => {
    const adapter = getQuantityBillingAdapter('openai-images')!;
    expect(adapter.measureResponse({ statusCode: 200, body: encode({ data: [{ b64_json: 'image' }, { url: 'image-url' }, {}] }) })).toBe(2);
    expect(adapter.measureResponse({ statusCode: 500, body: encode({ data: [{ b64_json: 'image' }] }) })).toBe(0);
    expect(adapter.measureResponse({ statusCode: 200, body: encode({ error: 'failed', data: [{ b64_json: 'image' }] }) })).toBe(0);
  });
});
