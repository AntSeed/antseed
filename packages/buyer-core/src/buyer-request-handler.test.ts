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
  upfrontBps?: number;
  expiresAt?: number;
  requestHash?: string;
  policy?: { autoApprove?: boolean; maxTotalUsdc?: string; maxUpfrontBps?: number; maxDurationSeconds?: number };
} = {}) {
  const body = { model: 'gen4.5', prompt: 'test', duration_seconds: options.duration ?? 4 };
  const request: SerializedHttpRequest = {
    requestId: 'req-1', method: 'POST', path: '/v1/video/generations',
    headers: { 'content-type': 'application/json', 'x-antseed-provider': 'runway' },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
  const total = options.total ?? 1_000_000n;
  const upfrontBps = options.upfrontBps ?? 5_000;
  const upfront = total * BigInt(upfrontBps) / 10_000n;
  const unsigned = {
    version: 1 as const,
    quote_id: 'vq_test',
    request_hash: options.requestHash ?? createHash('sha256').update(stableJson(body)).digest('hex'),
    seller_peer_id: peerId,
    total_amount: total.toString(),
    upfront_amount: upfront.toString(),
    delivery_amount: (total - upfront).toString(),
    upfront_bps: upfrontBps,
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
  it('accepts a valid signed quote matching advertised pricing and defaults', async () => {
    const value = fixture();
    expect(await validateVideoQuoteResponse(value.response, value.request, value.peer, value.policy)).toBeNull();
  });

  it.each([
    ['total cap', fixture({ policy: { maxTotalUsdc: '500000' } }), 'exceeds buyer limit'],
    ['upfront cap', fixture({ upfrontBps: 7_000, policy: { maxUpfrontBps: 5_000 } }), 'upfront 7000 bps exceeds buyer limit'],
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
