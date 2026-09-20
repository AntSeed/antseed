import { createHash } from 'node:crypto';
import { Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import { signUtf8 } from '@antseed/protocol/signing';
import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/protocol/http';
import type { VideoPaymentQuoteV1 } from '@antseed/protocol/video';
import type { BuyerPeerView } from './interfaces.js';
import { validateVideoQuoteResponse } from './buyer-request-handler.js';

const wallet = new Wallet(`0x${'44'.repeat(32)}`);
const peerId = wallet.address.slice(2).toLowerCase();

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fixture(options: {
  duration?: number;
  total?: bigint;
  expiresAt?: number;
  requestHash?: string;
  policy?: { autoApprove?: boolean; maxTotalUsdc?: string; maxDurationSeconds?: number };
} = {}) {
  const body = { model: 'gen4.5', prompt: 'test', duration_seconds: options.duration ?? 4 };
  const request: SerializedHttpRequest = {
    requestId: 'req-1', method: 'POST', path: '/v1/video/generations',
    headers: { 'content-type': 'application/json', 'x-antseed-provider': 'runway' },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
  const total = options.total ?? 1_000_000n;
  const unsigned = {
    version: 1 as const,
    quote_id: 'vq_test',
    request_hash: options.requestHash ?? createHash('sha256').update(stableJson(body)).digest('hex'),
    seller_peer_id: peerId,
    total_amount: total.toString(),
    payment_trigger: 'upstream_accepted' as const,
    expires_at: options.expiresAt ?? Math.floor(Date.now() / 1000) + 300,
  };
  const quote: VideoPaymentQuoteV1 = { ...unsigned, signature: signUtf8(wallet, JSON.stringify(unsigned)) };
  const response: SerializedHttpResponse = {
    requestId: request.requestId, statusCode: 402, headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ video_quote: quote })),
  };
  const peer: BuyerPeerView = {
    peerId: peerId as BuyerPeerView['peerId'], providers: ['runway'],
    providerServiceApiProtocols: { runway: { services: { 'gen4.5': ['antseed-video-jobs-v1'] } } },
    providerServiceUnitBillingModels: { runway: { services: {
      'gen4.5': { 'antseed-video-jobs-v1': { version: 1, components: [{ unit: 'output_videos', priceUsd: 1 }] } },
    } } },
  };
  return { request, response, peer, policy: options.policy };
}

describe('video quote buyer policy', () => {
  it.each([{}, { video_quote: null }, { video_quote: [] }, { video_quote: {} }])('rejects missing or malformed quotes: %j', async (body) => {
    const value = fixture();
    value.response.body = new TextEncoder().encode(JSON.stringify(body));
    expect((await validateVideoQuoteResponse(value.response, value.request, value.peer, value.policy))?.statusCode).toBe(422);
  });

  it('rejects legacy split quotes rather than increasing the authorized amount', async () => {
    const value = fixture();
    const body = JSON.parse(new TextDecoder().decode(value.response.body));
    delete body.video_quote.payment_trigger;
    Object.assign(body.video_quote, { upfront_amount: '500000', delivery_amount: '500000', upfront_bps: 5000 });
    value.response.body = new TextEncoder().encode(JSON.stringify(body));
    expect((await validateVideoQuoteResponse(value.response, value.request, value.peer, value.policy))?.statusCode).toBe(422);
  });

  it('rejects legacy split-cap headers', async () => {
    const value = fixture();
    value.request.headers['x-antseed-video-max-upfront-bps'] = '5000';
    expect((await validateVideoQuoteResponse(value.response, value.request, value.peer, value.policy))?.statusCode).toBe(422);
  });

  it('still honors tighter per-request total caps', async () => {
    const value = fixture();
    value.request.headers['x-antseed-video-max-total-usdc'] = '500000';
    expect((await validateVideoQuoteResponse(value.response, value.request, value.peer, value.policy))?.statusCode).toBe(422);
  });

  it.each(['GET', 'POST'])('never negotiates additional payment for a video follow-up (%s)', async (method) => {
    const value = fixture();
    value.request.method = method;
    value.request.path = '/v1/video/generations/vg_test/artifacts/va_test/content';
    expect((await validateVideoQuoteResponse(value.response, value.request, value.peer, value.policy))?.statusCode).toBe(422);
  });

  it('does not change non-video payment negotiation', async () => {
    const value = fixture();
    value.request.path = '/v1/chat/completions';
    value.response.body = new TextEncoder().encode('{}');
    expect(await validateVideoQuoteResponse(value.response, value.request, value.peer, value.policy)).toBeNull();
  });

  it('accepts a valid signed quote matching advertised pricing and defaults', async () => {
    const value = fixture();
    expect(await validateVideoQuoteResponse(value.response, value.request, value.peer, value.policy)).toBeNull();
  });

  it.each([
    ['total cap', fixture({ policy: { maxTotalUsdc: '500000' } }), 'exceeds buyer limit'],
    ['duration cap', fixture({ duration: 12, policy: { maxDurationSeconds: 10 } }), 'duration 12 exceeds buyer limit'],
    ['advertised price', fixture({ total: 2_000_000n }), 'does not match advertised price'],
    ['request hash', fixture({ requestHash: '0'.repeat(64) }), 'request hash does not match'],
    ['expiry', fixture({ expiresAt: Math.floor(Date.now() / 1000) - 1 }), 'has expired'],
    ['manual approval', fixture({ policy: { autoApprove: false } }), 'requires manual approval'],
  ])('rejects %s violations before payment negotiation', async (_name, value, message) => {
    const rejected = await validateVideoQuoteResponse(value.response, value.request, value.peer, value.policy);
    expect(rejected?.statusCode).toBe(422);
    expect(new TextDecoder().decode(rejected?.body)).toContain(message);
  });
});
