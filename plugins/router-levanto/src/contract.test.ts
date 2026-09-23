import { describe, expect, it } from 'vitest';
import { LEVANTO_ROUTING_CONTRACT, validateRoutingRequest, validateRoutingResponse } from './contract.js';

const request = { v: 1, cqt: 5, inputMessage: 'Help with a function', promptTokens: 5, expectedCachedTokens: [], constraints: {} };
const recommendation = { model: 'model-a', peer: 'a'.repeat(40), estimate: { costUsd: 0.01, inputTokens: 5, cachedInputTokens: 0, outputTokens: 20 }, price: { inUsdPerM: 1, outUsdPerM: 3, cachedInUsdPerM: 0 } };
const response = { v: 1, router: 'levanto', ranked: [recommendation] };

describe('Levanto fulfillment contract', () => {
  it('accepts the existing Levanto request and ranked response', () => {
    expect(() => validateRoutingRequest(LEVANTO_ROUTING_CONTRACT, request)).not.toThrow();
    expect(() => validateRoutingResponse(LEVANTO_ROUTING_CONTRACT, response, request)).not.toThrow();
  });
  it.each([{ stream: true }, { promptTokens: -1 }, { cqt: 0 }, { inputMessage: '' }])('rejects invalid request fields %j', fields => {
    expect(() => validateRoutingRequest(LEVANTO_ROUTING_CONTRACT, { ...request, ...fields })).toThrow();
  });
  it.each([{ ranked: [] }, { v: 2 }, { renewalDue: true }, { error: 'failed' }, { ranked: [{}] }])('does not bill invalid responses %j', fields => {
    expect(() => validateRoutingResponse(LEVANTO_ROUTING_CONTRACT, { ...response, ...fields }, request)).toThrow();
  });
  it('checks buyer peer and price constraints', () => {
    for (const constraints of [{ allowedPeerIds: ['b'.repeat(40)] }, { blockedPeerIds: ['a'.repeat(40)] }, { maxInputUsdPerMillion: 0 }]) {
      expect(() => validateRoutingResponse(LEVANTO_ROUTING_CONTRACT, response, { ...request, constraints })).toThrow('constraints');
    }
    expect(() => validateRoutingResponse(LEVANTO_ROUTING_CONTRACT, response, { ...request, constraints: { allowedPeerIds: [] } })).not.toThrow();
  });
  it('does not silently discard router-added inference overrides', () => {
    expect(() => validateRoutingResponse(LEVANTO_ROUTING_CONTRACT, {
      ...response, ranked: [{ ...recommendation, inference: { reasoningEffort: 'high' } }],
    }, request)).toThrow('No valid');
  });
  it('retains valid recommendations when other entries are malformed or outside the allowlist', () => {
    const ranked = [{ ...recommendation, peer: 'b'.repeat(40) }, {}, recommendation];
    expect(validateRoutingResponse(LEVANTO_ROUTING_CONTRACT, { ...response, ranked }, {
      ...request, constraints: { allowedPeerIds: ['a'.repeat(40)] },
    })).toEqual([{ model: 'model-a', peer: 'a'.repeat(40) }]);
  });
});
