import { describe, expect, it } from 'vitest';
import { LEVANTO_ROUTING_CONTRACT, validateFixedFeeRequest, validateFixedFeeResponse } from './contract.js';

const request = { v: 1, cqt: 5, inputMessage: 'Help with a function', promptTokens: 5, expectedCachedTokens: [], constraints: {} };
const recommendation = { model: 'model-a', peer: 'a'.repeat(40), estimate: { costUsd: 0.01, inputTokens: 5, cachedInputTokens: 0, outputTokens: 20 }, price: { inUsdPerM: 1, outUsdPerM: 3, cachedInUsdPerM: 0 } };
const response = { v: 1, router: 'levanto', ranked: [recommendation] };

describe('Levanto fulfillment contract', () => {
  it('accepts the existing Levanto request and ranked response', () => {
    expect(() => validateFixedFeeRequest(LEVANTO_ROUTING_CONTRACT, request)).not.toThrow();
    expect(() => validateFixedFeeResponse(LEVANTO_ROUTING_CONTRACT, response, request)).not.toThrow();
  });
  it.each([{ stream: true }, { promptTokens: -1 }, { cqt: 0 }, { inputMessage: '' }])('rejects invalid request fields %j', fields => {
    expect(() => validateFixedFeeRequest(LEVANTO_ROUTING_CONTRACT, { ...request, ...fields })).toThrow();
  });
  it.each([{ ranked: [] }, { v: 2 }, { renewalDue: true }, { error: 'failed' }, { ranked: [{}] }])('does not bill invalid responses %j', fields => {
    expect(() => validateFixedFeeResponse(LEVANTO_ROUTING_CONTRACT, { ...response, ...fields }, request)).toThrow();
  });
  it('checks buyer peer and price constraints', () => {
    for (const constraints of [{ allowedPeerIds: ['b'.repeat(40)] }, { blockedPeerIds: ['a'.repeat(40)] }, { maxInputUsdPerMillion: 0 }]) {
      expect(() => validateFixedFeeResponse(LEVANTO_ROUTING_CONTRACT, response, { ...request, constraints })).toThrow('constraints');
    }
    expect(() => validateFixedFeeResponse(LEVANTO_ROUTING_CONTRACT, response, { ...request, constraints: { allowedPeerIds: [] } })).not.toThrow();
  });
  it('does not silently discard router-added inference overrides', () => {
    expect(() => validateFixedFeeResponse(LEVANTO_ROUTING_CONTRACT, {
      ...response, ranked: [{ ...recommendation, inference: { reasoningEffort: 'high' } }],
    }, request)).toThrow('Malformed');
  });
});
