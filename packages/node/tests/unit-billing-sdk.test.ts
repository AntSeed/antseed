import { describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';
import { serviceBillingOffering, COMPLETED_REQUESTS_CAPABILITY } from '@antseed/protocol/service-billing';
import type { PeerInfo } from '../src/types/peer.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { completedRequestOffer, inferenceServiceFields, legacyUnitBillingModels } from '../src/billing/service.js';

describe('unit billing through normal SDK requests', () => {
  const offer = { provider: 'summarizer', service: 'summary', contract: 'summary-v1', priceMicroUsdc: '1000' };
  function setup() {
    const peer = { peerId: 'a'.repeat(40), metadata: { peerId: 'a'.repeat(40), capabilities: [COMPLETED_REQUESTS_CAPABILITY], offerings: [serviceBillingOffering(offer)] } } as PeerInfo;
    const verifyMetadataSignature = vi.fn(async () => true);
    const sendRequest = vi.fn(async () => ({ statusCode: 200 }));
    const node = { _peerLookup: { verifyMetadataSignature }, _buyerHandler: { sendRequest } } as unknown as AntseedNode;
    const send = (maxFeeMicroUsdc = '1000') => AntseedNode.prototype.sendRequest.call(node, peer, {
      requestId: 'summary-1', method: 'POST', path: '/summary', headers: {}, body: new TextEncoder().encode('{}'),
    }, { unitBilling: offer, maxFeeMicroUsdc, acceptResponse: () => true });
    return { peer, send, verifyMetadataSignature, sendRequest };
  }
  it('verifies the signed offer and forwards its exact fee and contract', async () => {
    const harness = setup();
    await harness.send();
    expect(harness.verifyMetadataSignature).toHaveBeenCalledWith(harness.peer.metadata);
    expect(harness.sendRequest).toHaveBeenCalledWith(harness.peer, expect.objectContaining({
      path: '/summary', method: 'POST',
    }), undefined, expect.objectContaining({ unitBilling: offer }));
  });
  it('rejects missing capability, invalid signature, identity mismatch, and excessive fee before dispatch', async () => {
    const expensive = setup();
    await expect(expensive.send('999')).rejects.toThrow('buyer limit');
    expect(expensive.sendRequest).not.toHaveBeenCalled();
    const unsigned = setup();
    unsigned.verifyMetadataSignature.mockResolvedValue(false);
    await expect(unsigned.send()).rejects.toThrow('Verified');
    expect(unsigned.sendRequest).not.toHaveBeenCalled();
    const legacy = setup();
    legacy.peer.metadata!.capabilities = [];
    await expect(legacy.send()).rejects.toThrow('Verified');
    expect(legacy.sendRequest).not.toHaveBeenCalled();
    const mismatched = setup();
    mismatched.peer.metadata!.peerId = 'b'.repeat(40);
    await expect(mismatched.send()).rejects.toThrow('Verified');
    expect(mismatched.sendRequest).not.toHaveBeenCalled();
  });
});

describe('independent service execution and pricing', () => {
  function provider(): Provider {
    return {
      name: 'mixed', services: ['route', 'image'], maxConcurrency: 4,
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      serviceExecution: { route: { kind: 'routing', contract: 'route-v1', path: '/route', acceptResponse: () => true } },
      serviceApiProtocols: { route: ['levanto-routing'], image: ['openai-images'] },
      serviceUnitBillingModels: {
        route: { 'levanto-routing': { version: 2, components: [{ unit: 'completed_requests', priceMicroUsdc: '1000' }] } },
        image: { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] } },
      },
      handleRequest: vi.fn(),
    };
  }
  function register(candidate: Provider): void {
    AntseedNode.prototype.registerProvider.call({ _providers: [] } as unknown as AntseedNode, candidate);
  }
  it('keeps completed requests out of legacy image metadata', () => {
    const candidate = provider();
    register(candidate);
    expect(completedRequestOffer(candidate, 'route')).toEqual({ provider: 'mixed', service: 'route', contract: 'route-v1', priceMicroUsdc: '1000' });
    expect(legacyUnitBillingModels(candidate)).toEqual({ image: candidate.serviceUnitBillingModels!.image });
    expect(inferenceServiceFields(candidate, candidate.serviceApiProtocols!)).toEqual({ image: ['openai-images'] });
  });
  it('allows routing execution without forcing completed-request pricing', () => {
    const candidate = provider();
    delete candidate.serviceUnitBillingModels!.route;
    expect(() => register(candidate)).not.toThrow();
    expect(completedRequestOffer(candidate, 'route')).toBeUndefined();
    expect(candidate.serviceExecution!.route!.kind).toBe('routing');
  });
  it('allows the same completed-request price on a TypeSafe API', () => {
    const candidate = provider();
    const model = candidate.serviceUnitBillingModels!.route!['levanto-routing']!;
    candidate.serviceApiProtocols!.route = ['typesafe-systemone'];
    candidate.serviceUnitBillingModels!.route = { 'typesafe-systemone': model };
    candidate.serviceExecution!.route!.kind = 'custom';
    candidate.serviceExecution!.route!.path = '/v1/systemone';
    expect(() => register(candidate)).not.toThrow();
    expect(completedRequestOffer(candidate, 'route')?.priceMicroUsdc).toBe('1000');
  });
  it('rejects ambiguous service pricing or an unadvertised API protocol', () => {
    const candidate = provider();
    candidate.serviceApiProtocols!.route = ['levanto-routing', 'typesafe-systemone'];
    candidate.serviceUnitBillingModels!.route!['typesafe-systemone'] = { version: 2, components: [{ unit: 'completed_requests', priceMicroUsdc: '2000' }] };
    expect(() => register(candidate)).toThrow('same unit price');
    const unadvertised = provider();
    unadvertised.serviceApiProtocols!.route = [];
    expect(() => register(unadvertised)).toThrow('advertised API protocol');
  });
  it('requires an execution contract and rejects unmeasured token surcharges', () => {
    const missing = provider();
    delete missing.serviceExecution;
    expect(() => register(missing)).toThrow('execution contract');
    const surcharge = provider();
    surcharge.pricing.defaults.inputUsdPerMillion = 1;
    expect(() => register(surcharge)).toThrow('unmeasured token charges');
  });
  it('supports zero-priced completions but not leaking v2 through legacy protocols', () => {
    const free = provider();
    free.serviceUnitBillingModels!.route = { 'levanto-routing': { version: 2, components: [{ unit: 'completed_requests', priceMicroUsdc: '0' }] } };
    expect(() => register(free)).not.toThrow();
    const invalid = provider();
    invalid.serviceUnitBillingModels!.image = { 'openai-images': { version: 2, components: [{ unit: 'completed_requests', priceMicroUsdc: '1000' }] } };
    expect(() => register(invalid)).toThrow('execution contract');
    expect(() => legacyUnitBillingModels(invalid)).toThrow('legacy inference metadata');
  });
});
