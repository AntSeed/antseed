import { describe, it, expect } from 'vitest';
import {
  encodeSpendingAuth,
  decodeSpendingAuth,
  encodeNeedAuth,
  decodeNeedAuth,
  encodePaymentRequired,
  decodePaymentRequired,
  encodeAuthAck,
  decodeAuthAck,
} from './payment-codec.js';

describe('payment payload codec', () => {
  it('round-trips a SpendingAuth with reserve fields', () => {
    const payload = {
      channelId: '0x' + 'aa'.repeat(32),
      cumulativeAmount: '0',
      metadataHash: '0x' + 'bb'.repeat(32),
      metadata: '0x' + 'cc'.repeat(64),
      spendingAuthSig: '0x' + 'dd'.repeat(65),
      reserveSalt: '0x' + 'ee'.repeat(32),
      reserveMaxAmount: '500000',
      reserveDeadline: 1900000000,
    };
    expect(decodeSpendingAuth(encodeSpendingAuth(payload))).toEqual(payload);
  });

  it('round-trips NeedAuth with token accounting fields', () => {
    const payload = {
      channelId: '0x' + 'aa'.repeat(32),
      requiredCumulativeAmount: '1200',
      currentAcceptedCumulative: '0',
      deposit: '500000',
      requestId: 'req-1',
      lastRequestCost: '1200',
      inputTokens: '300000',
      cachedInputTokens: '50000',
      freshInputTokens: '250000',
      outputTokens: '20000',
      service: 'test-model',
    };
    expect(decodeNeedAuth(encodeNeedAuth(payload))).toEqual(payload);
  });

  it('round-trips PaymentRequired and AuthAck', () => {
    const required = {
      minBudgetPerRequest: '1000',
      suggestedAmount: '500000',
      requestId: 'req-2',
      inputUsdPerMillion: 3000,
      outputUsdPerMillion: 15000,
    };
    expect(decodePaymentRequired(encodePaymentRequired(required))).toMatchObject(required);
    const ack = { channelId: '0x' + 'ab'.repeat(32) };
    expect(decodeAuthAck(encodeAuthAck(ack))).toEqual(ack);
  });

  it('round-trips completed-request usage separately from image v1', () => {
    const payload = { channelId: 'channel', requestId: 'route-1', requiredCumulativeAmount: '1000', currentAcceptedCumulative: '0', deposit: '10000', lastRequestCost: '1000' };
    expect(decodeNeedAuth(encodeNeedAuth({ ...payload, billingUsage: { version: 2, units: { completed_requests: '1' } } })).billingUsage).toEqual({ version: 2, units: { completed_requests: '1' } });
    expect(decodeNeedAuth(encodeNeedAuth({ ...payload, billingUsage: { version: 1, units: { output_images: '2' } } })).billingUsage).toEqual({ version: 1, units: { output_images: '2' } });
    for (const billingUsage of [{ version: 1, units: { completed_requests: '1' } }, { version: 2, units: { completed_requests: '2' } }, { version: 2, units: { output_images: '1' } }]) {
      expect(() => decodeNeedAuth(new TextEncoder().encode(JSON.stringify({ ...payload, billingUsage })))).toThrow();
    }
  });

  it('rejects payloads missing required fields', () => {
    expect(() => decodeNeedAuth(new TextEncoder().encode('{"channelId":"x"}'))).toThrow();
    expect(() => decodeSpendingAuth(new TextEncoder().encode('not json'))).toThrow();
  });
});
